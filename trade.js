// trade.js - WalletV5 Destekli, Adres Gösteren & RPC Tabanlı Modül
require('dotenv').config();
const { TonClient } = require('@ton/ton');
const { Address, internal } = require('@ton/core');
const { mnemonicToPrivateKey } = require('@ton/crypto');
const { StonApiClient } = require('@ston-fi/api');
const { DEX: StonDEX, pTON } = require('@ston-fi/sdk');
const axios = require('axios');

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
    
    // Güncel cüzdan standartları (Önce WalletV5 dener, desteklenmiyorsa V4'e düşer)
    let wallet;
    try {
        const { WalletContractV5 } = require('@ton/ton');
        wallet = WalletContractV5.create({ workchain: 0, publicKey: cachedKeyPair.publicKey });
    } catch (e) {
        const { WalletContractV4 } = require('@ton/ton');
        wallet = WalletContractV4.create({ workchain: 0, publicKey: cachedKeyPair.publicKey });
    }
    
    cachedWallet = wallet;

    // Cüzdan adresini logla ki hangi adrese baktığını net görebilelim
    console.log(`📍 Aktif Cüzdan Adresi: ${cachedWallet.address.toString({ bounceable: false })}`);

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

// RPC üzerinden jeton bakiyesi okuma
async function getWalletJettonBalance(walletAddress, tokenAddress) {
    try {
        const { client } = await getCtx();
        
        const ownerAddress = Address.isAddress(walletAddress) ? walletAddress : Address.parse(walletAddress.toString());
        const jettonMasterAddress = Address.parse(tokenAddress);

        const res = await client.runMethod(
            jettonMasterAddress,
            'get_wallet_address',
            [{ type: 'slice', cell: (await import('@ton/core')).beginCell().storeAddress(ownerAddress).endCell() }]
        );
        
        const jettonWalletAddress = res.stack.readAddress();
        
        const dataRes = await client.runMethod(
            jettonWalletAddress,
            'get_wallet_data'
        );
        
        const balance = dataRes.stack.readBigNumber();
        return balance;
    } catch (err) {
        console.error("RPC Jetton bakiye okuma hatası:", err.message);
        return 0n;
    }
}

async function getReliableRouter(stonApi, poolAddress) {
    try {
        const poolData = await stonApi.getPool({ address: poolAddress }).catch(() => null);
        if (poolData?.routerAddress) {
            return poolData.routerAddress;
        }
        const routers = await stonApi.getRouters();
        if (routers && routers.length > 0) {
            return routers[0].address;
        }
        return null;
    } catch (e) {
        return null;
    }
}

async function buyImpactPct(dex, poolAddress, tokenAddress, amountTon) {
    if (dex !== 'stonfi') return 2.0;
    const { stonApi } = await getCtx();
    try {
        const simulate = await stonApi.simulateSwap({
            dexRouterAddress: poolAddress,
            offerAddress: "native",
            askAddress: tokenAddress,
            units: BigInt(Math.floor(amountTon * 1e9)).toString()
        });

        const rawImpact = simulate?.priceImpact ?? simulate?.price_impact;
        if (rawImpact !== undefined && rawImpact !== null) {
            const impactNum = Number(rawImpact);
            return !isNaN(impactNum) ? (impactNum < 1 ? impactNum * 100 : impactNum) : 1.5;
        }

        const poolData = await stonApi.getPool({ address: poolAddress }).catch(() => null);
        if (poolData) {
            const isToken0 = normalizeAddress(poolData.token0Address) === normalizeAddress(tokenAddress);
            const tokenRes = BigInt(isToken0 ? (poolData.reserve0 || "1") : (poolData.reserve1 || "1"));
            const tonRes = BigInt(isToken0 ? (poolData.reserve1 || "1") : (poolData.reserve0 || "1"));

            if (tonRes > 0n) {
                const ratioNum = Number((BigInt(Math.floor(amountTon * 1e9)) * 100n) / tonRes);
                return Math.min(Math.max(ratioNum, 0.5), 5.0);
            }
        }
        return 2.0;
    } catch (e) {
        return 2.5;
    }
}

async function sellValueNano(dex, poolAddress, tokenAddress, rawBalance) {
    if (dex !== 'stonfi') return 0n;
    try {
        const { stonApi } = await getCtx();
        const simulate = await stonApi.simulateSwap({
            dexRouterAddress: poolAddress,
            askAddress: "native",
            offerAddress: tokenAddress,
            units: rawBalance.toString()
        });
        
        const askUnits = simulate?.minAskUnits || simulate?.askUnits;
        return askUnits ? BigInt(askUnits) : 0n;
    } catch (e) {
        console.error("Sell Quote simülasyon hatası:", e.message);
        return 0n;
    }
}

async function buy(tokenAddress, amountTon, dex, poolAddress) {
    if (dex !== 'stonfi') {
        return { success: false, error: "Bot şu an yalnızca STON.fi v2 desteklemektedir." };
    }

    while (isExecutingTransaction) {
        await new Promise(r => setTimeout(r, 500));
    }
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
                    return { 
                        success: true, 
                        costTon: amountTon, 
                        rawBalance: afterBalance - beforeBalance 
                    };
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

    while (isExecutingTransaction) {
        await new Promise(r => setTimeout(r, 500));
    }
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
                if (afterBalance < beforeBalance) {
                    return true;
                }
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

module.exports = {
    getCtx,
    getWalletJettonBalance,
    buy,
    sell,
    sellValueNano,
    buyImpactPct
};
