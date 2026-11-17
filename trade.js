// trade.js - DeDust ve STON.fi SDK tabanlı alış / satış / değer hesabı + jwCache & buyImpactPct
const { TonClient, WalletContractV4, JettonMaster, JettonWallet, toNano, Address } = require('@ton/ton');
const { mnemonicToPrivateKey } = require('@ton/crypto');
const { Factory, MAINNET_FACTORY_ADDR, Asset, PoolType, VaultJetton, JettonRoot, ReadinessStatus } = require('@dedust/sdk');
const { StonApiClient } = require('@ston-fi/api');
const { dexFactory } = require('@ston-fi/sdk');

const SLIPPAGE_BPS = 500n;          // %5 Slippage
const GAS_RESERVE = toNano('0.3');  
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const jwCache = new Map();

let ctx = null;
async function getCtx() {
  if (ctx) return ctx;
  if (!process.env.WALLET_MNEMONIC) throw new Error('WALLET_MNEMONIC tanımlanmamış');
  
  const client = new TonClient({
    endpoint: 'https://toncenter.com/api/v2/jsonRPC',
    apiKey: process.env.TONCENTER_API_KEY, 
  });
  const keyPair = await mnemonicToPrivateKey(process.env.WALLET_MNEMONIC.trim().split(/\s+/));
  const wallet = client.open(WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey }));
  const sender = wallet.sender(keyPair.secretKey);
  const factory = client.open(Factory.createFromAddress(MAINNET_FACTORY_ADDR));
  const stonApi = new StonApiClient();
  ctx = { client, wallet, sender, factory, stonApi };
  return ctx;
}

function ammOut(rIn, rOut, amountIn, feeBps) {
  const inAfterFee = (amountIn * (10000n - feeBps)) / 10000n;
  return (rOut * inAfterFee) / (rIn + inAfterFee);
}

async function jettonBalance(tokenAddr) {
  const { client, wallet } = await getCtx();
  let jwAddr = jwCache.get(tokenAddr);
  if (!jwAddr) {
    const master = client.open(JettonMaster.create(Address.parse(tokenAddr)));
    jwAddr = await master.getWalletAddress(wallet.address);
    jwCache.set(tokenAddr, jwAddr);
  }
  const st = await client.getContractState(jwAddr);
  if (st.state !== 'active') return 0n;   
  return await client.open(JettonWallet.create(jwAddr)).getBalance(); 
}

async function dedustPool(tokenAddr) {
  const { client, factory } = await getCtx();
  const pool = client.open(
    await factory.getPool(PoolType.VOLATILE, [Asset.native(), Asset.jetton(Address.parse(tokenAddr))])
  );
  if ((await pool.getReadinessStatus()) !== ReadinessStatus.READY) throw new Error('DeDust havuzu hazır değil');
  return pool;
}

async function stonPoolInfo(poolAddr, tokenAddr) {
  const { stonApi } = await getCtx();
  const p = await stonApi.getPool(poolAddr);
  if (!p) throw new Error('STON.fi havuzu bulunamadı');
  const token = Address.parse(tokenAddr);
  const tokenIs0 = Address.parse(p.token0Address).equals(token);
  const r0 = BigInt(p.reserve0), r1 = BigInt(p.reserve1);
  const feeBps = BigInt(p.lpFee || 20) + BigInt(p.protocolFee || 10);
  return {
    pool: p,
    rToken: tokenIs0 ? r0 : r1,
    rTon: tokenIs0 ? r1 : r0,
    feeBps,
  };
}

async function quote(dex, poolAddr, tokenAddr, side, amountIn) {
  if (dex === 'dedust') {
    const pool = await dedustPool(tokenAddr);
    const assetIn = side === 'buy' ? Asset.native() : Asset.jetton(Address.parse(tokenAddr));
    const { amountOut } = await pool.getEstimatedSwapOut({ assetIn, amountIn });
    return amountOut;
  }
  const { rToken, rTon, feeBps } = await stonPoolInfo(poolAddr, tokenAddr);
  return side === 'buy' ? ammOut(rTon, rToken, amountIn, feeBps) : ammOut(rToken, rTon, amountIn, feeBps);
}

async function sellValueNano(dex, poolAddr, tokenAddr, rawBalance) {
  try {
    return await quote(dex, poolAddr, tokenAddr, 'sell', BigInt(rawBalance));
  } catch (e) {
    console.error('sellValue hata:', e.message);
    return 0n;
  }
}

async function buyImpactPct(dex, poolAddr, tokenAddr, amountTon) {
  const amountIn = toNano(String(amountTon));
  const full = await quote(dex, poolAddr, tokenAddr, 'buy', amountIn);
  const small = await quote(dex, poolAddr, tokenAddr, 'buy', amountIn / 100n);
  if (full <= 0n || small <= 0n) return 100;
  return (1 - Number(full) / (Number(small) * 100)) * 100;
}

async function buy(tokenAddr, amountTon, dex, poolAddr) {
  try {
    const { client, wallet, sender, factory, stonApi } = await getCtx();
    const amountIn = toNano(String(amountTon));

    const tonBalance = await client.getBalance(wallet.address);
    if (tonBalance < amountIn + GAS_RESERVE) return { success: false, error: 'Yetersiz TON bakiyesi' };

    const expected = await quote(dex, poolAddr, tokenAddr, 'buy', amountIn);
    if (expected <= 0n) return { success: false, error: 'Teklif alınamadı' };
    const minOut = (expected * (10000n - SLIPPAGE_BPS)) / 10000n;

    const before = await jettonBalance(tokenAddr);

    if (dex === 'dedust') {
      const pool = await dedustPool(tokenAddr);
      const tonVault = client.open(await factory.getNativeVault());
      await tonVault.sendSwap(sender, {
        poolAddress: pool.address,
        amount: amountIn,
        limit: minOut,
        gasAmount: toNano('0.2'),
      });
    } else {
      const { pool } = await stonPoolInfo(poolAddr, tokenAddr);
      const routerInfo = await stonApi.getRouter(pool.routerAddress);
      const { Router, pTON } = dexFactory(routerInfo);
      const router = client.open(new Router(routerInfo.address));
      const proxyTon = new pTON(routerInfo.ptonMasterAddress);
      const txParams = await router.getSwapTonToJettonTxParams({
        userWalletAddress: wallet.address.toString(),
        proxyTon,
        offerAmount: amountIn,
        askJettonAddress: tokenAddr,
        minAskAmount: minOut,
        queryId: Date.now(),
      });
      await sender.send(txParams);
    }

    for (let i = 0; i < 15; i++) {
      await sleep(4000);
      const after = await jettonBalance(tokenAddr);
      if (after > before) {
        return { success: true, rawBalance: (after - before).toString(), costTon: amountTon };
      }
    }
    return { success: false, unconfirmed: true, error: 'Onay süresi aşıldı (unconfirmed)' };
  } catch (err) {
    console.error("Alım işlem hatası:", err.message);
    return { success: false, error: err.message };
  }
}

async function sell(tokenAddr, dex, poolAddr, expectedRaw) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { client, wallet, sender, factory, stonApi } = await getCtx();
      const balance = await jettonBalance(tokenAddr);
      const amount = balance > 0n ? balance : 0n;
      if (amount === 0n) return true;

      const expected = await quote(dex, poolAddr, tokenAddr, 'sell', amount);
      if (expected <= 0n) throw new Error('Satış teklifi alınamadı');
      const minOut = (expected * (10000n - SLIPPAGE_BPS)) / 10000n;
      const token = Address.parse(tokenAddr);

      if (dex === 'dedust') {
        const pool = await dedustPool(tokenAddr);
        const jettonVault = client.open(await factory.getJettonVault(token));
        const root = client.open(JettonRoot.createFromAddress(token));
        const jw = client.open(await root.getWallet(wallet.address));
        await jw.sendTransfer(sender, toNano('0.25'), {
          amount,
          destination: jettonVault.address,
          responseAddress: wallet.address,
          forwardAmount: toNano('0.2'),
          forwardPayload: VaultJetton.createSwapPayload({ poolAddress: pool.address, limit: minOut }),
        });
      } else {
        const { pool } = await stonPoolInfo(poolAddr, tokenAddr);
        const routerInfo = await stonApi.getRouter(pool.routerAddress);
        const { Router, pTON } = dexFactory(routerInfo);
        const router = client.open(new Router(routerInfo.address));
        const proxyTon = new pTON(routerInfo.ptonMasterAddress);
        const txParams = await router.getSwapJettonToTonTxParams({
          userWalletAddress: wallet.address.toString(),
          offerJettonAddress: tokenAddr,
          offerAmount: amount,
          minAskAmount: minOut,
          proxyTon,
          queryId: Date.now(),
        });
        await sender.send(txParams);
      }

      for (let i = 0; i < 15; i++) {
        await sleep(4000);
        if ((await jettonBalance(tokenAddr)) < amount) return true;
      }
    } catch (err) {
      console.error(`Satış denemesi ${attempt} hata:`, err.message);
    }
    await sleep(4000);
  }
  return false;
}

let txChain = Promise.resolve();
const withTxLock = (fn) => { 
  const r = txChain.then(fn); 
  txChain = r.catch(() => {}); 
  return r; 
};

module.exports = { 
  buy: (...a) => withTxLock(() => buy(...a)), 
  sell: (...a) => withTxLock(() => sell(...a)), 
  sellValueNano, 
  buyImpactPct,
  getCtx 
};
