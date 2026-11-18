// trade.js - Güncellenmiş STON.fi Simülasyon ve DeDust İşlem Motoru
require('dotenv').config();
const { TonClient, WalletContractV4, internal } = require('@ton/ton');
const { mnemonicToPrivateKey } = require('@ton/crypto');
const { Address } = require('@ton/core');
const { DEX, pTON } = require('@ston-fi/sdk');
const { Asset, Factory, MAINNET_FACTORY_ADDR, Pool, JettonRoot, VaultJetton } = require('@dedust/sdk');
const axios = require('axios');

let cachedCtx = null;

async function getCtx() {
  if (cachedCtx) return cachedCtx;
  const endpoint = process.env.TON_RPC_ENDPOINT || 'https://toncenter.com/api/v2/jsonRPC';
  const apiKey = process.env.TONAPI_KEY; 
  const client = new TonClient({ endpoint, apiKey });
  
  const mnemonicStr = process.env.WALLET_MNEMONIC || "";
  const mnemonic = mnemonicStr.split(" ");
  if (mnemonic.length < 2) throw new Error("WALLET_MNEMONIC eksik veya geçersiz!");

  const keyPair = await mnemonicToPrivateKey(mnemonic);
  const workchain = 0;
  const wallet = WalletContractV4.create({ workchain, publicKey: keyPair.publicKey });
  const walletContract = client.open(wallet);

  cachedCtx = { client, wallet: walletContract, keyPair, workchain };
  return cachedCtx;
}

// === STON.FI SİMÜLASYON YARDIMCISI ===
async function simulateStonSwap(offer, ask, units) {
  try {
    const res = await axios.post('https://api.ston.fi/v1/swap/simulate', null, {
      params: { offer_address: offer, ask_address: ask, units: String(units), slippage_tolerance: '0.01' },
      timeout: 6000
    });
    console.log("STON sim cevabı:", JSON.stringify(res.data).slice(0, 300));
    return res.data;
  } catch (err) {
    console.error("STON simülasyon hatası:", err.message);
    return null;
  }
}

async function getReliableRouter() {
  const { client } = await getCtx();
  return new DEX.v2_1.Router(client);
}

// === STON.FI BUY IMPACT PCT ===
async function buyImpactPct(dexType, poolAddress, tokenAddress, amountTon) {
  try {
    const router = await getReliableRouter();
    const units = Math.floor(amountTon * 1e9).toString();
    const stonPton = new pTON.v2_1();
    const sim = await simulateStonSwap(stonPton.address.toString(), tokenAddress, units);
    if (!sim || !sim.ask_units) return 100;

    const askUnits = Number(sim.ask_units);
    const expectedOut = askUnits; 
    const spotOut = expectedOut; 
    if (spotOut <= 0) return 0;
    const impact = ((spotOut - askUnits) / spotOut) * 100;
    return Math.max(0, impact);
  } catch (err) {
    console.error("buyImpactPct hata:", err.message);
    return 100;
  }
}

// === STON.FI SELL VALUE NANO ===
async function sellValueNano(dexType, poolAddress, tokenAddress, rawBalance) {
  try {
    const stonPton = new pTON.v2_1();
    const sim = await simulateStonSwap(tokenAddress, stonPton.address.toString(), rawBalance);
    if (!sim || !sim.ask_units) return 0n;
    return BigInt(sim.ask_units);
  } catch (err) {
    console.error("sellValueNano hata:", err.message);
    return 0n;
  }
}

// === STON.FI BUY ===
async function buy(tokenAddress, amountTon, dexType, poolAddress) {
  try {
    const { client, wallet, keyPair } = await getCtx();
    const router = await getReliableRouter();
    const stonPton = new pTON.v2_1();
    const units = Math.floor(amountTon * 1e9).toString();

    const sim = await simulateStonSwap(stonPton.address.toString(), tokenAddress, units);
    if (!sim || !sim.ask_units) {
      return { success: false, error: "simülasyon yok" };
    }

    const minUnits = (BigInt(sim.ask_units) * 95n) / 100n; // %5 slippage

    const swapParams = await router.getSwapTonToJettonTxParams({
      userWalletAddress: wallet.address.toString(),
      proxyTonAddress: stonPton.address.toString(),
      toAddress: tokenAddress,
      tonAmount: units,
      minOutputTokens: minUnits.toString()
    });

    const seqno = await wallet.GetSeqno();
    await wallet.send(internal({
      to: Address.parse(swapParams.to),
      value: BigInt(swapParams.value),
      body: swapParams.body,
      bounce: true
    }), keyPair.secretKey);

    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const newSeqno = await wallet.GetSeqno();
      if (newSeqno > seqno) {
        const balance = await getWalletJettonBalance(wallet.address, tokenAddress);
        return { success: true, costTon: amountTon, rawBalance: balance };
      }
    }
    return { success: false, unconfirmed: true, error: "Alım onaylanamadı (timeout)" };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// === STON.FI SELL ===
async function sell(tokenAddress, dexType, poolAddress, rawBalance) {
  try {
    const { client, wallet, keyPair } = await getCtx();
    const router = await getReliableRouter();
    const stonPton = new pTON.v2_1();

    const sim = await simulateStonSwap(tokenAddress, stonPton.address.toString(), rawBalance);
    if (!sim || !sim.ask_units) {
      console.error("Sell simülasyonu başarısız.");
      return false;
    }

    const minTon = (BigInt(sim.ask_units) * 95n) / 100n;

    const swapParams = await router.getSwapJettonToTonTxParams({
      userWalletAddress: wallet.address.toString(),
      offerJettonAddress: tokenAddress,
      offerAmount: rawBalance,
      proxyTonAddress: stonPton.address.toString(),
      minOutputTon: minTon.toString()
    });

    const seqno = await wallet.GetSeqno();
    await wallet.send(internal({
      to: Address.parse(swapParams.to),
      value: BigInt(swapParams.value),
      body: swapParams.body,
      bounce: true
    }), keyPair.secretKey);

    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 3000));
      if ((await wallet.GetSeqno()) > seqno) return true;
    }
    return false;
  } catch (err) {
    console.error("Sell hata:", err.message);
    return false;
  }
}

// === YARDIMCI: CÜZDAN JETTON BAKİYESİ ===
async function getWalletJettonBalance(walletAddress, jettonMasterAddress) {
  try {
    const { client } = await getCtx();
    const jettonMaster = client.open(JettonRoot.createFromAddress(Address.parse(jettonMasterAddress)));
    const jettonWalletAddr = await jettonMaster.getWallet(walletAddress);
    const jettonWallet = client.open(await client.openWallet(jettonWalletAddr)); // Veya standart TonClient contract open
    const data = await jettonWallet.getBalance();
    return data;
  } catch (e) {
    // Alternatif sadeleştirilmiş bakiye kontrolü
    try {
      const { client } = await getCtx();
      const res = await client.runMethod(Address.parse(walletAddress), "get_wallet_data", []);
      // Fallback olarak tonapi veya client tabanlı kontrol
      return 0n;
    } catch (ex) {
      return 0n;
    }
  }
}

// === DEDUST İŞLEMLERİ ===
async function getDedustCtx(poolAddress) {
  const { client, wallet, keyPair } = await getCtx();
  const factory = client.open(Factory.createFromAddress(MAINNET_FACTORY_ADDR));
  const pool = client.open(Pool.createFromAddress(Address.parse(poolAddress)));
  const sender = client.open(wallet).sender(keyPair.secretKey);
  return { client, wallet, factory, pool, sender };
}

async function buyDedust(tokenAddress, amountTon, poolAddress) {
  try {
    const { client, wallet, factory, pool, sender } = await getDedustCtx(poolAddress);
    const amountIn = BigInt(Math.floor(amountTon * 1e9));
    if ((await client.getBalance(wallet.address)) < amountIn + 300000000n)
      return { success: false, error: "DeDust: yetersiz bakiye" };

    const before = await getWalletJettonBalance(wallet.address, tokenAddress);
    const { amountOut } = await pool.getEstimatedSwapOut({ assetIn: Asset.native(), amountIn });
    if (!amountOut || amountOut <= 0n) return { success: false, error: "DeDust tahmini 0" };
    const limit = (amountOut * 95n) / 100n; // %5 slippage

    const vault = client.open(await factory.getNativeVault());
    await vault.sendSwap(sender, { poolAddress: pool.address, amount: amountIn, limit, gasAmount: 250000000n });

    for (let i = 0; i < 6; i++) {
      await new Promise(r => setTimeout(r, 4000));
      try {
        const after = await getWalletJettonBalance(wallet.address, tokenAddress);
        if (after > before) return { success: true, costTon: amountTon, rawBalance: after - before };
      } catch (e) {}
    }
    return { success: false, unconfirmed: true, error: "DeDust alım doğrulanamadı." };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function sellDedust(tokenAddress, rawBalance, poolAddress) {
  try {
    const { client, wallet, factory, pool, sender } = await getDedustCtx(poolAddress);
    const token = Address.parse(tokenAddress);
    const before = await getWalletJettonBalance(wallet.address, tokenAddress);

    const { amountOut } = await pool.getEstimatedSwapOut({ assetIn: Asset.jetton(token), amountIn: BigInt(rawBalance) });
    if (!amountOut || amountOut <= 0n) return false;
    const limit = (amountOut * 95n) / 100n;

    const root = client.open(JettonRoot.createFromAddress(token));
    const jettonWallet = client.open(await root.getWallet(wallet.address));
    const vault = client.open(await factory.getJettonVault(token));

    await jettonWallet.sendTransfer(sender, 300000000n, {
      amount: BigInt(rawBalance),
      destination: vault.address,
      responseAddress: wallet.address,
      forwardAmount: 250000000n,
      forwardPayload: VaultJetton.createSwapPayload({ poolAddress: pool.address, limit })
    });

    for (let i = 0; i < 6; i++) {
      await new Promise(r => setTimeout(r, 4000));
      try { if ((await getWalletJettonBalance(wallet.address, tokenAddress)) < before) return true; } catch (e) {}
    }
    return false;
  } catch (err) {
    console.error("DeDust satış hatası:", err.message);
    return false;
  }
}

async function dedustSellValueNano(poolAddress, tokenAddress, rawBalance) {
  try {
    const { pool } = await getDedustCtx(poolAddress);
    const { amountOut } = await pool.getEstimatedSwapOut({ assetIn: Asset.jetton(Address.parse(tokenAddress)), amountIn: BigInt(rawBalance) });
    return amountOut || 0n;
  } catch (e) {
    console.error("DeDust değer hatası:", e.message);
    return 0n;
  }
}

module.exports = {
  buy,
  sell,
  sellValueNano,
  buyImpactPct,
  getWalletJettonBalance,
  getCtx,
  buyDedust,
  sellDedust,
  dedustSellValueNano
};
