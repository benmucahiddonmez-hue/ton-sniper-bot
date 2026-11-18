// trade.js - STON.fi ve DeDust Çift Motorlu Takas Modülü
require('dotenv').config();
const { TonClient, WalletContractV4 } = require('@ton/ton');
const { Address, internal, beginCell } = require('@ton/core');
const { mnemonicToPrivateKey } = require('@ton/crypto');
const { DEX: StonDEX, pTON } = require('@ston-fi/sdk');
const { Asset, Factory, CHAIN_ID, MAINNET_FACTORIES } = require('@dedust/sdk');
const axios = require('axios');

let cachedClient = null;
let cachedWallet = null;
let cachedKeyPair = null;

let isExecutingTransaction = false;

async function getCtx() {
    if (cachedClient && cachedWallet && cachedKeyPair) {
        return { 
            client: cachedClient, 
            wallet: cachedWallet, 
            keyPair: cachedKeyPair 
        };
    }

    const endpoint = process.env.TONCENTER_ENDPOINT || 'https://toncenter.com/api/v2/jsonRPC';
    const apiKey = process.env.TONCENTER_API_KEY;
    
    const clientOpts = { endpoint };
    if (apiKey) clientOpts.apiKey = apiKey;

    cachedClient = new TonClient(clientOpts);

    const mnemonic = (process.env.WALLET_MNEMONIC || "").trim().split(/\s+/);
    if (!mnemonic || mnemonic.length < 12) {
        throw new Error("WALLET_MNEMONIC .env dosyasında eksik veya geçersiz!");
    }

    cachedKeyPair = await mnemonicToPrivateKey(mnemonic);
    cachedWallet = WalletContractV4.create({ workchain: 0, publicKey: cachedKeyPair.publicKey });

    console.log(`📍 Doğrulanmış Aktif Cüzdan Adresi: ${cachedWallet.address.toString({ bounceable: false })}`);

    return { 
        client: cachedClient, 
        wallet: cachedWallet, 
        keyPair: cachedKeyPair 
    };
}

function normalizeAddress(addr) {
    try {
        if (!addr) return "";
        return Address.parse(String(addr)).toRawString().toLowerCase();
    } catch (e) {
        return String(addr).toLowerCase().trim();
    }
}

async function getWalletJettonBalance(walletAddress, tokenAddress) {
    const { client } = await getCtx();
    const owner = Address.isAddress(walletAddress) ? walletAddress : Address.parse(walletAddress.toString());
    const master = Address.parse(tokenAddress);
    const res = await client.runMethod(master, 'get_wallet_address', [
        { type: 'slice', cell: beginCell().storeAddress(owner).endCell() }
    ]);
    const jettonWallet = res.stack.readAddress();
    try {
        const d = await client.runMethod(jettonWallet, 'get_wallet_data');
        return d.stack.readBigNumber();
    } catch (e) {
        if (String(e.message).includes('-13')) return 0n;
        throw e;
    }
}

async function getReliableRouter(poolAddress) {
    try {
        const res = await axios.get(`https://api.ston.fi/v1/pools/${poolAddress}`, { timeout: 5000 });
        if (res.data?.pool?.router_address) return res.data.pool.router_address;
        
        const routersRes = await axios.get('https://api.ston.fi/v1/routers', { timeout: 5000 });
        if (routersRes.data?.routers?.[0]?.address) return routersRes.data.routers[0].address;
        
        return "EQB3ncyBUTjZUA5EnFKRT5_HIBII9OWhHxOqTSbQYlIcCPKs"; // Standart STON.fi Router v1
    } catch (e) {
        return "EQB3ncyBUTjZUA5EnFKRT5_HIBII9OWhHxOqTSbQYlIcCPKs";
    }
}

// ==========================================
// STON.FI MOTORU
// ==========================================

async function buyImpactPct(dex, poolAddress, tokenAddress, amountTon) {
    if (dex !== 'stonfi') return 2.0;
    try {
        const routerAddress = await getReliableRouter(poolAddress);
        const res = await axios.post('https://api.ston.fi/v1/stats/simulate/swap', {
            dex_router_address: routerAddress,
            offer_address: "native",
            ask_address: tokenAddress,
            units: Math.floor(amountTon * 1e9).toString()
        }, { timeout: 6000 });

        const rawImpact = res.data?.price_impact;
        if (rawImpact !== undefined && rawImpact !== null) {
            const impactNum = Number(rawImpact);
            return !isNaN(impactNum) ? (impactNum < 1 ? impactNum * 100 : impactNum) : 1.5;
        }
        return 2.0;
    } catch (e) {
        return 2.0;
    }
}

async function sellValueNano(dex, poolAddress, tokenAddress, rawBalance) {
    if (dex !== 'stonfi') return 0n;
    try {
        const routerAddress = await getReliableRouter(poolAddress);
        const res = await axios.post('https://api.ston.fi/v1/stats/simulate/swap', {
            dex_router_address: routerAddress,
            offer_address: tokenAddress,
            ask_address: "native",
            units: rawBalance.toString()
        }, { timeout: 6000 });
        
        const askUnits = res.data?.ask_units || res.data?.min_ask_units;
        return askUnits ? BigInt(askUnits) : 0n;
    } catch (e) {
        return 0n;
    }
}

async function buy(tokenAddress, amountTon, dex, poolAddress) {
    if (dex !== 'stonfi') return { success: false, error: "Geçersiz DEX motoru." };

    while (isExecutingTransaction) await new Promise(r => setTimeout(r, 500));
    isExecutingTransaction = true;

    try {
        const { client, wallet, keyPair } = await getCtx();
        const balance = await client.getBalance(wallet.address);
        
        const valueNano = BigInt(Math.floor(amountTon * 1e9));
        if (balance < valueNano + 300000000n) {
            return { success: false, error: "Yetersiz yerel GRAM bakiyesi (Fee dahil)" };
        }

        const beforeBalance = await getWalletJettonBalance(wallet.address, tokenAddress);
        const routerAddress = await getReliableRouter(poolAddress);

        const simRes = await axios.post('https://api.ston.fi/v1/stats/simulate/swap', {
            dex_router_address: routerAddress,
            offer_address: "native",
            ask_address: tokenAddress,
            units: valueNano.toString()
        }, { timeout: 6000 }).catch(() => null);

        const askUnits = simRes?.data?.min_ask_units || simRes?.data?.ask_units || "1";
        const minOutputUnits = (BigInt(askUnits) * 98n) / 100n;

        const router = client.open(new StonDEX.Router(Address.parse(routerAddress)));
        const ptonV2 = new pTON.v2();

        const txParams = await router.getSwapTonToJettonTxParams({
            userWalletAddress: wallet.address,
            proxyTonAddress: ptonV2.address,
            offerUnits: valueNano,
            askJettonAddress: Address.parse(tokenAddress),
            minAskUnits: minOutputUnits,
            slippageTolerance: 0.02
        });

        const walletContract = client.open(wallet);
        const seqno = await walletContract.getSeqno();

        const transfer = walletContract.createTransfer({
            secretKey: keyPair.secretKey,
            seqno: seqno,
            messages: [internal({ to: txParams.to, value: txParams.value, bounce: true, body: txParams.body })]
        });

        await client.sendExternalMessage(wallet, transfer);

        for (let i = 0; i < 6; i++) {
            await new Promise(r => setTimeout(r, 4000));
            try {
                const afterBalance = await getWalletJettonBalance(wallet.address, tokenAddress);
                if (afterBalance > beforeBalance) {
                    return { success: true, costTon: amountTon, rawBalance: afterBalance - beforeBalance };
                }
            } catch (err) {}
        }

        return { success: false, unconfirmed: true, error: "İşlem gönderildi ancak bakiye artışı doğrulanamadı." };
    } catch (err) {
        return { success: false, error: err.message };
    } finally {
        isExecutingTransaction = false;
    }
}

async function sell(tokenAddress, dex, poolAddress, rawBalance) {
    if (dex !== 'stonfi') return false;

    while (isExecutingTransaction) await new Promise(r => setTimeout(r, 500));
    isExecutingTransaction = true;

    try {
        const { client, wallet, keyPair } = await getCtx();
        const beforeBalance = await getWalletJettonBalance(wallet.address, tokenAddress);
        const routerAddress = await getReliableRouter(poolAddress);

        const simRes = await axios.post('https://api.ston.fi/v1/stats/simulate/swap', {
            dex_router_address: routerAddress,
            offer_address: tokenAddress,
            ask_address: "native",
            units: rawBalance.toString()
        }, { timeout: 6000 }).catch(() => null);

        const askUnits = simRes?.data?.min_ask_units || simRes?.data?.ask_units || "1";
        const minOutputUnits = (BigInt(askUnits) * 98n) / 100n;

        const router = client.open(new StonDEX.Router(Address.parse(routerAddress)));
        const ptonV2 = new pTON.v2();

        const txParams = await router.getSwapJettonToTonTxParams({
            userWalletAddress: wallet.address,
            proxyTonAddress: ptonV2.address,
            offerJettonAddress: Address.parse(tokenAddress),
            offerUnits: BigInt(rawBalance),
            minAskUnits: minOutputUnits,
            slippageTolerance: 0.02
        });

        const walletContract = client.open(wallet);
        const seqno = await walletContract.getSeqno();

        const transfer = walletContract.createTransfer({
            secretKey: keyPair.secretKey,
            seqno: seqno,
            messages: [internal({ to: txParams.to, value: txParams.value, bounce: true, body: txParams.body })]
        });

        await client.sendExternalMessage(wallet, transfer);

        for (let i = 0; i < 6; i++) {
            await new Promise(r => setTimeout(r, 4000));
            try {
                const afterBalance = await getWalletJettonBalance(wallet.address, tokenAddress);
                if (afterBalance < beforeBalance) return true;
            } catch (err) {}
        }

        return false;
    } catch (err) {
        return false;
    } finally {
        isExecutingTransaction = false;
    }
}

// ==========================================
// DEDUST MOTORU
// ==========================================

async function buyDedust(tokenAddress, amountTon, poolAddress) {
    while (isExecutingTransaction) await new Promise(r => setTimeout(r, 500));
    isExecutingTransaction = true;

    try {
        const { client, wallet, keyPair } = await getCtx();
        const balance = await client.getBalance(wallet.address);
        const valueNano = BigInt(Math.floor(amountTon * 1e9));
        
        if (balance < valueNano + 300000000n) {
            return { success: false, error: "DeDust: Yetersiz bakiye" };
        }

        const beforeBalance = await getWalletJettonBalance(wallet.address, tokenAddress);

        const factory = client.open(Factory.create(MAINNET_FACTORIES[CHAIN_ID.MAINNET]));
        const router = client.open(await factory.getRouter());

        const assetIn = Asset.native();
        const assetOut = Asset.jetton(Address.parse(tokenAddress));

        const txParams = await router.getSwapTonTxParams({
            amount: valueNano,
            kind: 'out-given',
            assetIn,
            assetOut,
            minOutput: 1n,
            senderAddress: wallet.address
        });

        const walletContract = client.open(wallet);
        const seqno = await walletContract.getSeqno();

        const transfer = walletContract.createTransfer({
            secretKey: keyPair.secretKey,
            seqno: seqno,
            messages: [internal({ to: txParams.to, value: txParams.value, bounce: true, body: txParams.body })]
        });

        await client.sendExternalMessage(wallet, transfer);

        for (let i = 0; i < 6; i++) {
            await new Promise(r => setTimeout(r, 4000));
            try {
                const afterBalance = await getWalletJettonBalance(wallet.address, tokenAddress);
                if (afterBalance > beforeBalance) {
                    return { success: true, costTon: amountTon, rawBalance: afterBalance - beforeBalance };
                }
            } catch (err) {}
        }

        return { success: false, unconfirmed: true, error: "DeDust alım doğrulanamadı." };
    } catch (err) {
        return { success: false, error: err.message };
    } finally {
        isExecutingTransaction = false;
    }
}

async function sellDedust(tokenAddress, rawBalance) {
    while (isExecutingTransaction) await new Promise(r => setTimeout(r, 500));
    isExecutingTransaction = true;

    try {
        const { client, wallet, keyPair } = await getCtx();
        const beforeBalance = await getWalletJettonBalance(wallet.address, tokenAddress);

        const factory = client.open(Factory.create(MAINNET_FACTORIES[CHAIN_ID.MAINNET]));
        const router = client.open(await factory.getRouter());

        const assetIn = Asset.jetton(Address.parse(tokenAddress));
        const assetOut = Asset.native();

        const txParams = await router.getSwapJettonTxParams({
            amount: BigInt(rawBalance),
            kind: 'out-given',
            assetIn,
            assetOut,
            minOutput: 1n,
            senderAddress: wallet.address
        });

        const walletContract = client.open(wallet);
        const seqno = await walletContract.getSeqno();

        const transfer = walletContract.createTransfer({
            secretKey: keyPair.secretKey,
            seqno: seqno,
            messages: [internal({ to: txParams.to, value: 300000000n, bounce: true, body: txParams.body })]
        });

        await client.sendExternalMessage(wallet, transfer);

        for (let i = 0; i < 6; i++) {
            await new Promise(r => setTimeout(r, 4000));
            try {
                const afterBalance = await getWalletJettonBalance(wallet.address, tokenAddress);
                if (afterBalance < beforeBalance) return true;
            } catch (err) {}
        }

        return false;
    } catch (err) {
        return false;
    } finally {
        isExecutingTransaction = false;
    }
}

module.exports = {
    getCtx,
    getWalletJettonBalance,
    buy,
    sell,
    sellValueNano,
    buyImpactPct,
    buyDedust,
    sellDedust
};
