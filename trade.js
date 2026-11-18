// trade.js - STON.fi ve DeDust Çift Motorlu Takas Modülü
require('dotenv').config();
const { TonClient, WalletContractV4 } = require('@ton/ton');
const { Address, internal, beginCell } = require('@ton/core');
const { mnemonicToPrivateKey } = require('@ton/crypto');
const { StonApiClient } = require('@ston-fi/api');
const { DEX: StonDEX, pTON } = require('@ston-fi/sdk');
const { Asset, Factory, CHAIN_ID, MAINNET_FACTORIES } = require('@dedust/sdk');

let cachedClient = null;
let cachedWallet = null;
let cachedKeyPair = null;
let cachedStonApi = null;

let isExecutingTransaction = false;

async function getCtx() {
    if (cachedClient && cachedWallet && cachedKeyPair && cachedStonApi) {
        return { 
            client: cachedClient, 
            wallet: cachedWallet, 
            keyPair: cachedKeyPair, 
            stonApi: cachedStonApi 
        };
    }

    const endpoint = process.env.TONCENTER_ENDPOINT || 'https://toncenter.com/api/v2/jsonRPC';
    const apiKey = process.env.TONCENTER_API_KEY;
    
    const clientOpts = { endpoint };
    if (apiKey) clientOpts.apiKey = apiKey;

    cachedClient = new TonClient(clientOpts);
    cachedStonApi = new StonApiClient();

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
        keyPair: cachedKeyPair, 
        stonApi: cachedStonApi 
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

async function getReliableRouter(stonApi, poolAddress) {
    try {
        const poolData = await stonApi.getPool({ address: poolAddress }).catch(() => null);
        if (poolData?.routerAddress) return poolData.routerAddress;
        const routers = await stonApi.getRouters();
        if (routers && routers.length > 0) return routers[0].address;
        return null;
    } catch (e) {
        return null;
    }
}

// ==========================================
// STON.FI MOTORU
// ==========================================

async function buyImpactPct(dex, poolAddress, tokenAddress, amountTon) {
    if (dex !== 'stonfi') return 2.0;
    const { stonApi } = await getCtx();
    try {
        const routerAddress = await getReliableRouter(stonApi, poolAddress);
        if (!routerAddress) return 100;

        const simulate = await stonApi.simulateSwap({
            dexRouterAddress: routerAddress,
            offerAddress: "native",
            askAddress: tokenAddress,
            units: BigInt(Math.floor(amountTon * 1e9)).toString()
        });

        const rawImpact = simulate?.priceImpact ?? simulate?.price_impact;
        if (rawImpact !== undefined && rawImpact !== null) {
            const impactNum = Number(rawImpact);
            return !isNaN(impactNum) ? (impactNum < 1 ? impactNum * 100 : impactNum) : 1.5;
        }
        return 2.0;
    } catch (e) {
        return 100;
    }
}

async function sellValueNano(dex, poolAddress, tokenAddress, rawBalance) {
    if (dex !== 'stonfi') return 0n;
    try {
        const { stonApi } = await getCtx();
        const routerAddress = await getReliableRouter(stonApi, poolAddress);
        if (!routerAddress) return 0n;

        const simulate = await stonApi.simulateSwap({
            dexRouterAddress: routerAddress,
            askAddress: "native",
            offerAddress: tokenAddress,
            units: rawBalance.toString()
        });
        
        const askUnits = simulate?.askUnits || simulate?.minAskUnits;
        return askUnits ? BigInt(askUnits) : 0n;
    } catch (e) {
        console.error("Sell Quote simülasyon hatası:", e.message);
        return 0n;
    }
}

async function buy(tokenAddress, amountTon, dex, poolAddress) {
    if (dex !== 'stonfi') return { success: false, error: "Geçersiz DEX motoru (STON.fi bekleniyor)." };

    while (isExecutingTransaction) await new Promise(r => setTimeout(r, 500));
    isExecutingTransaction = true;

    try {
        const { client, wallet, keyPair, stonApi } = await getCtx();
        const balance = await client.getBalance(wallet.address);
        
        const valueNano = BigInt(Math.floor(amountTon * 1e9));
        const totalRequiredFee = 300000000n; // 0.3 TON
        if (balance < valueNano + totalRequiredFee) {
            return { success: false, error: "Yetersiz yerel TON bakiyesi (Fee dahil)" };
        }

        const beforeBalance = await getWalletJettonBalance(wallet.address, tokenAddress);
        const routerAddress = await getReliableRouter(stonApi, poolAddress);
        if (!routerAddress) return { success: false, error: "STON.fi Router bulunamadı." };

        const simulate = await stonApi.simulateSwap({
            dexRouterAddress: routerAddress,
            offerAddress: "native",
            askAddress: tokenAddress,
            units: valueNano.toString()
        }).catch(() => null);

        const askUnits = simulate?.minAskUnits || simulate?.askUnits;
        if (!askUnits) return { success: false, error: "STON.fi simülasyonu başarısız." };

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

        return { success: false, unconfirmed: true, error: "İşlem gönderildi ancak bakiye artışı doğrulanamadı (unconfirmed)." };
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
        const { client, wallet, keyPair, stonApi } = await getCtx();
        const beforeBalance = await getWalletJettonBalance(wallet.address, tokenAddress);

        const routerAddress = await getReliableRouter(stonApi, poolAddress);
        if (!routerAddress) return false;

        const simulate = await stonApi.simulateSwap({
            dexRouterAddress: routerAddress,
            offerAddress: tokenAddress,
            askAddress: "native",
            units: rawBalance.toString()
        }).catch(() => null);

        const askUnits = simulate?.minAskUnits || simulate?.askUnits;
        if (!askUnits) return false;
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
        console.error("Satış hatası:", err.message);
        return false;
    } finally {
        isExecutingTransaction = false;
    }
}

// ==========================================
// DEDUST MOTORU (Yeni Eklendi)
// ==========================================

async function buyDedust(tokenAddress, amountTon, poolAddress) {
    while (isExecutingTransaction) await new Promise(r => setTimeout(r, 500));
    isExecutingTransaction = true;

    try {
        const { client, wallet, keyPair } = await getCtx();
        const balance = await client.getBalance(wallet.address);
        const valueNano = BigInt(Math.floor(amountTon * 1e9));
        
        if (balance < valueNano + 300000000n) {
            return { success: false, error: "DeDust: Yetersiz yerel TON bakiyesi (Fee dahil)" };
        }

        const beforeBalance = await getWalletJettonBalance(wallet.address, tokenAddress);

        // DeDust Factory ve Router entegrasyonu
        const factory = client.open(Factory.create(MAINNET_FACTORIES[CHAIN_ID.MAINNET]));
        const router = client.open(await factory.getRouter());

        const assetIn = Asset.native();
        const assetOut = Asset.jetton(Address.parse(tokenAddress));

        // DeDust swap işlem parametreleri
        const txParams = await router.getSwapTonTxParams({
            amount: valueNano,
            kind: 'out-given',
            assetIn,
            assetOut,
            minOutput: 1n, // Slippage koruması eklenebilir
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

        return { success: false, unconfirmed: true, error: "DeDust alım işlemi gönderildi ancak bakiye doğrulanamadı." };
    } catch (err) {
        return { success: false, error: "DeDust Buy Error: " + err.message };
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

        // Jeton transferlerinde DeDust vault adresine forward fee (örn: 0.25 TON) gerekebilir
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
        console.error("DeDust Satış hatası:", err.message);
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
