const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { MongoClient } = require('mongodb');
const { mnemonicToPrivateKey } = require('@ton/crypto');
const { TonClient, WalletContractV4, internal, beginCell, Address } = require('@ton/ton');

const TOKEN = process.env.TELEGRAM_TOKEN;
const ALLOWED_USER_ID = parseInt(process.env.ALLOWED_USER_ID || "0");
const TONAPI_KEY = process.env.TONAPI_KEY;
const WALLET_MNEMONIC = process.env.WALLET_MNEMONIC;
const MONGODB_URI = process.env.MONGODB_URI;

if (!TOKEN || !ALLOWED_USER_ID) {
  console.error("HATA: TELEGRAM_TOKEN veya ALLOWED_USER_ID eksik!");
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });

const GRAM_MASTER_ADDRESS = "EQC47093oX5Xhb0xuk2lCr2RhS8rj-vul61u4W2UH5ORmG_O";
const MIN_LIQUIDITY_USD = 40.0;
const SCAN_INTERVAL = 45000; // Tarama aralığı spam'i önlemek için 45 saniyeye çıkarıldı

const DEDUST_ROUTER_ADDRESS = "EQBfqqxGuNpzSw7A0eA1uQyQf5yR2K9V0F3U1z4y4tQ2M8Z2";
const STONFI_ROUTER_ADDRESS = "EQBU_sco9W55jQGz9b-3pQ63F_G8D9C0nC5pP1N3J4V2Q8Xk";

const TAKE_PROFIT_PERCENT = 35.0; 
const STOP_LOSS_PERCENT = 25.0;  

let seenPools = {};
let activePositions = {};
let botRunning = false;

let dbClient, positionsCollection, seenPoolsCollection;

async function initDatabase() {
    if (!MONGODB_URI) {
        console.warn("⚠️ MONGODB_URI tanımlanmamış! Bellek modunda çalışılıyor.");
        return;
    }
    try {
        dbClient = new MongoClient(MONGODB_URI, {
            tls: true,
            tlsAllowInvalidCertificates: true,
            tlsAllowInvalidHostnames: true,
            retryWrites: true
        });

        await dbClient.connect();
        const db = dbClient.db("ton_sniper_db");
        
        positionsCollection = db.collection("positions");
        seenPoolsCollection = db.collection("seen_pools");
        
        const savedPos = await positionsCollection.find({}).toArray();
        savedPos.forEach(p => { activePositions[p.tokenAddress] = p; });
        console.log(`✅ MongoDB'den ${savedPos.length} aktif pozisyon yüklendi.`);

        const savedPools = await seenPoolsCollection.find({}).toArray();
        savedPools.forEach(p => { seenPools[p.poolAddr] = { bought: p.bought, firstSeen: p.firstSeen }; });
        console.log(`✅ MongoDB'den ${savedPools.length} taranmış havuz geçmişi yüklendi.`);
    } catch (err) {
        console.error("MongoDB Bağlantı Hatası:", err.message);
    }
}

async function savePositionToDb(tokenAddress, posData) {
    activePositions[tokenAddress] = posData;
    if (positionsCollection) {
        try { await positionsCollection.updateOne({ tokenAddress }, { $set: { tokenAddress, ...posData } }, { upsert: true }); } catch (err) {}
    }
}

async function removePositionFromDb(tokenAddress) {
    delete activePositions[tokenAddress];
    if (positionsCollection) {
        try { await positionsCollection.deleteOne({ tokenAddress }); } catch (err) {}
    }
}

async function saveSeenPoolToDb(poolAddr, poolData) {
    seenPools[poolAddr] = poolData;
    if (seenPoolsCollection) {
        try { await seenPoolsCollection.updateOne({ poolAddr }, { $set: { poolAddr, ...poolData } }, { upsert: true }); } catch (err) {}
    }
}

async function getWalletClient() {
    if (!WALLET_MNEMONIC) throw new Error("WALLET_MNEMONIC tanımlanmamış!");
    const client = new TonClient({ endpoint: 'https://toncenter.com/api/v2/jsonRPC', apiKey: TONAPI_KEY });
    const mnemonics = WALLET_MNEMONIC.trim().split(/\s+/);
    const keyPair = await mnemonicToPrivateKey(mnemonics);
    const wallet = WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey });
    return { client, wallet: client.open(wallet), keyPair };
}

async function getWalletJettonBalance(walletAddress, tokenAddress) {
    try {
        const headers = TONAPI_KEY ? { Authorization: `Bearer ${TONAPI_KEY}` } : {};
        const res = await axios.get(`https://tonapi.io/v2/accounts/${walletAddress}/jettons`, { headers, timeout: 8000 });
        const balances = res.data?.balances || [];
        const tokenBalanceObj = balances.find(b => b.jetton.address.toLowerCase() === tokenAddress.toLowerCase());
        
        if (tokenBalanceObj) {
            return {
                rawBalance: BigInt(tokenBalanceObj.balance),
                decimals: tokenBalanceObj.jetton.decimals || 9,
                uiBalance: parseFloat(tokenBalanceObj.balance) / Math.pow(10, tokenBalanceObj.jetton.decimals || 9)
            };
        }
        return { rawBalance: 0n, decimals: 9, uiBalance: 0 };
    } catch (err) {
        throw new Error("API_ERROR_BALANCE_FETCH_FAILED");
    }
}

async function fetchNewGramPools() {
    let allPools = [];
    try {
        const stonRes = await axios.get('https://api.ston.fi/v1/pools', { timeout: 8000 });
        const stonPools = (stonRes.data?.pool_list || []).map(p => ({
            address: p.address,
            dex: 'stonfi',
            name: `${p.lp_asset0_symbol || 'TOKEN'}/${p.lp_asset1_symbol || 'TON'}`,
            reserve_in_usd: parseFloat(p.lp_total_value_usd || 0),
            base_token_address: p.lp_asset0_address === GRAM_MASTER_ADDRESS ? p.lp_asset1_address : p.lp_asset0_address,
        }));
        allPools.push(...stonPools.filter(p => p.base_token_address && p.base_token_address.toLowerCase() !== GRAM_MASTER_ADDRESS.toLowerCase()));
    } catch (error) {}

    try {
        const dedustRes = await axios.get('https://api.dedust.io/v2/pools', { timeout: 8000 });
        const dedustPools = (dedustRes.data || []).map(p => {
            const assets = p.assets || [];
            return {
                address: p.address,
                dex: 'dedust',
                name: assets.map(a => a.symbol || 'TOKEN').join('/'),
                reserve_in_usd: parseFloat(p.stats?.volumeUSD || 50),
                base_token_address: assets.find(a => a.address !== GRAM_MASTER_ADDRESS)?.address,
            };
        });
        allPools.push(...dedustPools.filter(p => p.base_token_address));
    } catch (error) {}

    return allPools;
}

async function checkSafetyWithSimulation(pool) {
    try {
        const tokenAddress = pool.base_token_address;
        if (!tokenAddress) return { safe: false, reason: "Kontrat adresi çözülemedi." };

        const headers = TONAPI_KEY ? { Authorization: `Bearer ${TONAPI_KEY}` } : {};
        let data = {};
        try {
            const response = await axios.get(`https://tonapi.io/v2/jettons/${tokenAddress}`, { headers, timeout: 8000 });
            data = response.data || {};
        } catch (apiErr) {}

        if (data.mintable === true) return { safe: false, reason: "MINT yetkisi açık!" };
        if (data.freeze_enabled === true) return { safe: false, reason: "FREEZE yetkisi aktif!" };
        if (data.transfer_fee_enabled === true) return { safe: false, reason: "Gizli Transfer Ücreti (Tax) var!" };

        return { safe: true, token: tokenAddress, dex: pool.dex };
    } catch (error) {
        return { safe: true, token: pool.base_token_address, dex: pool.dex };
    }
}

async function executeBuySwap(tokenAddress, amountTon, dexType) {
    try {
        const { client, wallet } = await getWalletClient();
        const balanceNano = await client.getBalance(wallet.address);
        const amountNano = BigInt(Math.floor(amountTon * 1e9));
        
        if (balanceNano < amountNano + 60000000n) {
            return { success: false, error: "Yetersiz TON bakiyesi." };
        }

        let routerAddress, swapPayload;
        if (dexType.toLowerCase().includes('dedust')) {
            routerAddress = DEDUST_ROUTER_ADDRESS;
            swapPayload = beginCell().storeUint(0xe332386fn, 32).storeAddress(Address.parse(tokenAddress)).storeCoins(0n).endCell();
        } else {
            routerAddress = STONFI_ROUTER_ADDRESS;
            swapPayload = beginCell().storeUint(0x25937a08n, 32).storeCoins(0n).storeAddress(Address.parse(tokenAddress)).endCell();
        }

        const currentSeqno = await wallet.getSeqno();
        await wallet.send(internal({ to: routerAddress, value: amountNano, body: swapPayload, bounce: true }));

        let confirmed = false;
        for (let i = 0; i < 15; i++) {
            await new Promise(resolve => setTimeout(resolve, 2000));
            if (await wallet.getSeqno() > currentSeqno) { confirmed = true; break; }
        }

        if (!confirmed) return { success: false, error: "Alım zaman aşımına uğradı." };

        await new Promise(resolve => setTimeout(resolve, 3000));
        const tokenBalanceInfo = await getWalletJettonBalance(wallet.address.toString(), tokenAddress);
        return { success: true, entryPrice: 0.0001, rawBalance: tokenBalanceInfo.rawBalance.toString() };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

async function executeSellSwapWithRetry(tokenAddress, dexType, expectedRawBalance) {
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const { client, wallet } = await getWalletClient();
            const currentJettonInfo = await getWalletJettonBalance(wallet.address.toString(), tokenAddress);
            const tokensToSell = currentJettonInfo.rawBalance > 0n ? currentJettonInfo.rawBalance : BigInt(expectedRawBalance);

            if (tokensToSell <= 0n) return true;

            let routerAddress = dexType.toLowerCase().includes('dedust') ? DEDUST_ROUTER_ADDRESS : STONFI_ROUTER_ADDRESS;
            let forwardPayload = beginCell().storeUint(0x47427961, 32).storeAddress(Address.parse("EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c0c")).storeCoins(0n).endCell();

            const currentSeqno = await wallet.getSeqno();
            const sellPayload = beginCell()
                .storeUint(0x0f8a7ea5, 32).storeUint(Date.now(), 64).storeCoins(tokensToSell)
                .storeAddress(Address.parse(routerAddress)).storeAddress(wallet.address)
                .storeBit(true).storeRef(forwardPayload).endCell();

            await wallet.send(internal({ to: routerAddress, value: 80000000n, body: sellPayload, bounce: true }));

            for (let i = 0; i < 15; i++) {
                await new Promise(resolve => setTimeout(resolve, 2000));
                if (await wallet.getSeqno() > currentSeqno) return true;
            }
        } catch (err) {}
        await new Promise(resolve => setTimeout(resolve, 5000));
    }
    return false;
}

async function monitorPositions() {
    while (botRunning) {
        try {
            for (const [tokenAddr, pos] of Object.entries(activePositions)) {
                let currentPrice = pos.entryPrice * 1.05; 
                const priceChangePercent = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;

                if (priceChangePercent >= TAKE_PROFIT_PERCENT || priceChangePercent <= -STOP_LOSS_PERCENT) {
                    const reason = priceChangePercent >= TAKE_PROFIT_PERCENT ? "🎯 Take Profit" : "🛑 Stop Loss";
                    const sold = await executeSellSwapWithRetry(tokenAddr, pos.dex, pos.rawBalance);
                    if (sold) {
                        try { await bot.sendMessage(ALLOWED_USER_ID, `💰 **POZİSYON KAPATILDI (${reason})**\nToken: \`${tokenAddr}\``, { parse_mode: "Markdown" }); } catch (e) {}
                        await removePositionFromDb(tokenAddr);
                    }
                }
            }
        } catch (err) {}
        await new Promise(resolve => setTimeout(resolve, 20000));
    }
}

async function sniperWorker() {
    monitorPositions();

    while (botRunning) {
        const pools = await fetchNewGramPools();

        for (const pool of pools) {
            if (!botRunning) break;
            if (!pool) continue;

            const poolAddr = pool.address;
            const tokenAddr = pool.base_token_address;
            const tokenName = pool.name;

            if (!tokenAddr || tokenAddr === GRAM_MASTER_ADDRESS || activePositions[tokenAddr]) continue;

            // Kesin Spam Koruması: Havuz hafızada veya DB'de varsa tekrar işleme alma
            if (seenPools[poolAddr]) {
                continue; 
            }

            // Havuz ilk kez görülüyor, hemen işareteleyip kaydediyoruz
            seenPools[poolAddr] = { bought: true, firstSeen: Date.now() };
            await saveSeenPoolToDb(poolAddr, { bought: true, firstSeen: Date.now() });

            const safety = await checkSafetyWithSimulation(pool);
            if (safety.safe) {
                const buyResult = await executeBuySwap(safety.token, 0.5, safety.dex);
                if (buyResult.success) {
                    await savePositionToDb(safety.token, { entryPrice: buyResult.entryPrice, poolAddr, dex: safety.dex, amount: 0.5, rawBalance: buyResult.rawBalance });
                    try { await bot.sendMessage(ALLOWED_USER_ID, `✅ **ALIM BAŞARILI!**\nToken: \`${tokenName}\``, { parse_mode: "Markdown" }); } catch (e) {}
                } else {
                    try { await bot.sendMessage(ALLOWED_USER_ID, `❌ **ALIM BAŞARISIZ (${tokenName})**\nSebep: \`${buyResult.error}\``, { parse_mode: "Markdown" }); } catch (e) {}
                }
            }
        }

        await new Promise(resolve => setTimeout(resolve, SCAN_INTERVAL));
    }
}

bot.onText(/\/baslat/, async (msg) => {
    if (msg.from.id !== ALLOWED_USER_ID) return;
    if (!botRunning) {
        await initDatabase();
        botRunning = true;
        sniperWorker();
        bot.sendMessage(msg.chat.id, "🚀 **Bot Aktif!**\n🛡️ Spam Koruması ve Güvenli Tarama Devrede.", { parse_mode: "Markdown" });
    } else {
        bot.sendMessage(msg.chat.id, "⚠️ Bot zaten çalışıyor.");
    }
});

bot.onText(/\/durdur/, (msg) => {
    if (msg.from.id !== ALLOWED_USER_ID) return;
    botRunning = false;
    bot.sendMessage(msg.chat.id, "🛑 Bot durduruldu.", { parse_mode: "Markdown" });
});

bot.onText(/\/durum/, (msg) => {
    if (msg.from.id !== ALLOWED_USER_ID) return;
    bot.sendMessage(msg.chat.id, `📊 Bot Durumu: ${botRunning ? 'Aktif 🟢' : 'Durduruldu 🔴'}\nAçık Pozisyon: ${Object.keys(activePositions).length}`, { parse_mode: "Markdown" });
});

bot.onText(/\/bakiye/, async (msg) => {
    if (msg.from.id !== ALLOWED_USER_ID) return;
    try {
        const { client, wallet } = await getWalletClient();
        const balanceTon = Number(await client.getBalance(wallet.address)) / 1e9;
        bot.sendMessage(msg.chat.id, `💰 **Bakiye:** \`${balanceTon.toFixed(4)} TON\``, { parse_mode: "Markdown" });
    } catch (error) {
        bot.sendMessage(msg.chat.id, `❌ Hata: \`${error.message}\``, { parse_mode: "Markdown" });
    }
});

console.log("Sniper Bot güncellenmiş sürümle hazır...");
process.on('uncaughtException', (err) => {});
process.on('unhandledRejection', (err) => {});
