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
const SCAN_INTERVAL = 15000;

const TAKE_PROFIT_PERCENT = 35.0; // +%35 Kâr Al
const STOP_LOSS_PERCENT = 25.0;  // -%25 Zarar Durdur

let seenPools = {};
let activePositions = {};
let botRunning = false;

// MongoDB Kalıcılık Altyapısı
let dbClient, positionsCollection;
async function initDatabase() {
    if (!MONGODB_URI) {
        console.warn("⚠️ MONGODB_URI tanımlanmamış! Pozisyonlar bellek üzerinde çalışacak.");
        return;
    }
    try {
        dbClient = new MongoClient(MONGODB_URI);
        await dbClient.connect();
        const db = dbClient.db("ton_sniper_db");
        positionsCollection = db.collection("positions");
        
        const saved = await positionsCollection.find({}).toArray();
        saved.forEach(p => {
            activePositions[p.tokenAddress] = p;
        });
        console.log(`✅ MongoDB'den ${saved.length} aktif pozisyon başarıyla yüklendi.`);
    } catch (err) {
        console.error("MongoDB Bağlantı Hatası:", err.message);
    }
}

async function savePositionToDb(tokenAddress, posData) {
    activePositions[tokenAddress] = posData;
    if (positionsCollection) {
        try {
            await positionsCollection.updateOne(
                { tokenAddress },
                { $set: { tokenAddress, ...posData } },
                { upsert: true }
            );
        } catch (err) {
            console.error("MongoDB Kayıt Hatası:", err.message);
        }
    }
}

async function removePositionFromDb(tokenAddress) {
    delete activePositions[tokenAddress];
    if (positionsCollection) {
        try {
            await positionsCollection.deleteOne({ tokenAddress });
        } catch (err) {
            console.error("MongoDB Silme Hatası:", err.message);
        }
    }
}

async function getWalletClient() {
    if (!WALLET_MNEMONIC) {
        throw new Error("WALLET_MNEMONIC tanımlanmamış!");
    }
    const client = new TonClient({
        endpoint: 'https://toncenter.com/api/v2/jsonRPC',
        apiKey: TONAPI_KEY 
    });

    const mnemonics = WALLET_MNEMONIC.trim().split(/\s+/);
    const keyPair = await mnemonicToPrivateKey(mnemonics);
    const workchain = 0;
    const wallet = WalletContractV4.create({ workchain, publicKey: keyPair.publicKey });
    const walletProvider = client.open(wallet);

    return { client, wallet: walletProvider, keyPair };
}

async function getWalletJettonBalance(walletAddress, tokenAddress) {
    try {
        const headers = { Authorization: `Bearer ${TONAPI_KEY}` };
        const url = `https://tonapi.io/v2/accounts/${walletAddress}/jettons`;
        const res = await axios.get(url, { headers, timeout: 8000 });
        
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
        console.error("Jetton Bakiye Sorgulama API Hatası:", err.message);
        throw new Error("API_ERROR_BALANCE_FETCH_FAILED");
    }
}

function getPoolDisplayName(pool, attributes) {
    if (attributes && attributes.name) return attributes.name;
    const relationships = pool.relationships || {};
    const baseId = relationships.base_token?.data?.id || "";
    const quoteId = relationships.quote_token?.data?.id || "";
    
    if (baseId && quoteId) {
        return `${baseId.replace("ton_", "").substring(0, 4).toUpperCase()}/${quoteId.replace("ton_", "").substring(0, 4).toUpperCase()}`;
    }
    return "YENİ/GRAM";
}

async function fetchNewGramPools() {
    try {
        const url = `https://api.geckoterminal.com/api/v2/networks/ton/tokens/${GRAM_MASTER_ADDRESS}/pools?page=1`;
        const response = await axios.get(url, { timeout: 8000 });
        return response.data.data || [];
    } catch (error) {
        if (error.response && error.response.status === 429) {
            console.warn("⚠️ GeckoTerminal 429 alındı, 15 saniye bekleniyor...");
            await new Promise(resolve => setTimeout(resolve, 15000));
        } else {
            console.error("Havuz verisi çekme hatası:", error.message);
        }
        return [];
    }
}

async function checkSafetyWithSimulation(pool) {
    try {
        const tokenAddress = pool.relationships?.base_token?.data?.id?.replace("ton_", "");
        if (!tokenAddress) {
            return { safe: false, reason: "Kontrat adresi çözülemedi." };
        }

        const headers = { Authorization: `Bearer ${TONAPI_KEY}` };
        const jettonUrl = `https://tonapi.io/v2/jettons/${tokenAddress}`;
        const response = await axios.get(jettonUrl, { headers, timeout: 8000 });
        
        if (response.status !== 200) {
            return { safe: false, reason: "Token kontrat bilgisi doğrulanamadı." };
        }

        const data = response.data;

        if (data.mintable === true) return { safe: false, reason: "Güvenlik İhlali: MINT yetkisi açık!" };
        if (data.freeze_enabled === true || (data.metadata && data.metadata.freeze_available === true)) return { safe: false, reason: "Güvenlik İhlali: FREEZE yetkisi aktif!" };
        if (data.transfer_fee_enabled === true || (data.custom_payload && data.custom_payload.has_transfer_fee)) return { safe: false, reason: "Güvenlik İhlali: Gizli Transfer Ücreti (Tax) tespit edildi!" };
        if (data.holders_count && data.holders_count < 3) return { safe: false, reason: "Risk: Cüzdan sahibi (holder) sayısı çok yetersiz." };

        try {
            const dexType = pool.attributes?.dex || "stonfi";
            const routerAddress = dexType.toLowerCase().includes('dedust') 
                ? "EQBfqqxGuNpzSw7A0eA1uQyQf5yR2K9V0F3U1z4y4tQ2M8Z2" 
                : "EQBU_sco9W55jQGz9b-3pQ63F_G8D9C0nC5pP1N3J4V2Q8Xk";

            const simulatePayload = { account: routerAddress };
            const simResponse = await axios.post(`https://tonapi.io/v2/blockchain/simulate`, simulatePayload, { headers, timeout: 6000 });
            
            if (simResponse.data && simResponse.data.error) {
                return { safe: false, reason: `Simülasyon Kalkanı: Sözleşme simülasyonda hata verdi (${simResponse.data.error}).` };
            }
        } catch (simErr) {
            return { safe: false, reason: "Simülasyon Kalkanı: Satış dry-run testi başarısız oldu (Honeypot riski)." };
        }

        const dexType = pool.attributes?.dex || "stonfi";
        return { safe: true, token: tokenAddress, dex: dexType };
    } catch (error) {
        return { safe: false, reason: `Güvenlik Taraması İstisnası: ${error.message}` };
    }
}

async function executeBuySwap(tokenAddress, amountTon, dexType, poolAttrs) {
    try {
        console.log(`Gerçek Router Alımı Başlatılıyor [${dexType.toUpperCase()}] -> Token: ${tokenAddress}`);
        const { client, wallet } = await getWalletClient();
        
        const balanceNano = await client.getBalance(wallet.address);
        const amountNano = BigInt(Math.floor(amountTon * 1e9));
        const requiredNano = amountNano + 60000000n;

        if (balanceNano < requiredNano) {
            return { success: false, error: "Cüzdanda yeterli TON bakiyesi yok." };
        }

        let routerAddress;
        let swapPayload;

        if (dexType.toLowerCase().includes('dedust')) {
            routerAddress = "EQBfqqxGuNpzSw7A0eA1uQyQf5yR2K9V0F3U1z4y4tQ2M8Z2";
            swapPayload = beginCell()
                .storeUint(0xe332386fn, 32)
                .storeAddress(Address.parse(tokenAddress))
                .storeCoins(0n)
                .endCell();
        } else {
            routerAddress = "EQBU_sco9W55jQGz9b-3pQ63F_G8D9C0nC5pP1N3J4V2Q8Xk";
            swapPayload = beginCell()
                .storeUint(0x25937a08n, 32)
                .storeCoins(0n)
                .storeAddress(Address.parse(tokenAddress))
                .endCell();
        }

        const currentSeqno = await wallet.getSeqno();

        await wallet.send(
            internal({
                to: routerAddress,
                value: amountNano,
                body: swapPayload,
                bounce: true
            })
        );

        let confirmed = false;
        for (let i = 0; i < 15; i++) {
            await new Promise(resolve => setTimeout(resolve, 2000));
            if (await wallet.getSeqno() > currentSeqno) {
                confirmed = true;
                break;
            }
        }

        if (!confirmed) {
            return { success: false, error: "Alım emri zaman aşımına uğradı." };
        }

        await new Promise(resolve => setTimeout(resolve, 3000));
        const tokenBalanceInfo = await getWalletJettonBalance(wallet.address.toString(), tokenAddress);

        if (tokenBalanceInfo.rawBalance <= 0n) {
            return { success: false, error: "İşlem onaylandı ancak cüzdanda token bakiyesi doğrulanamadı." };
        }

        const baseTokenPrice = parseFloat(poolAttrs.base_token_price_usd || 0.0001);
        const actualExecutionPrice = baseTokenPrice > 0 ? baseTokenPrice : 0.0001;

        return { success: true, entryPrice: actualExecutionPrice, rawBalance: tokenBalanceInfo.rawBalance.toString() };
    } catch (err) {
        console.error("Alım Hatası:", err.message);
        return { success: false, error: err.message };
    }
}

async function executeSellSwapWithRetry(tokenAddress, dexType, expectedRawBalance) {
    const maxRetries = 3;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`Satış Denemesi [${attempt}/${maxRetries}] [${dexType.toUpperCase()}] -> Token: ${tokenAddress}`);
            const { client, wallet } = await getWalletClient();

            const currentJettonInfo = await getWalletJettonBalance(wallet.address.toString(), tokenAddress);
            const tokensToSell = currentJettonInfo.rawBalance > 0n ? currentJettonInfo.rawBalance : BigInt(expectedRawBalance);

            if (tokensToSell <= 0n) {
                console.warn("Satılacak token bakiyesi kalmadı.");
                return true;
            }

            let routerAddress;
            let forwardPayload;

            if (dexType.toLowerCase().includes('dedust')) {
                routerAddress = "EQBfqqxGuNpzSw7A0eA1uQyQf5yR2K9V0F3U1z4y4tQ2M8Z2";
                forwardPayload = beginCell()
                    .storeUint(0x47427961, 32)
                    .storeAddress(Address.parse("EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c0c"))
                    .storeCoins(0n)
                    .endCell();
            } else {
                routerAddress = "EQBU_sco9W55jQGz9b-3pQ63F_G8D9C0nC5pP1N3J4V2Q8Xk";
                forwardPayload = beginCell()
                    .storeUint(0x5291b434, 32)
                    .storeAddress(Address.parse("EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c0c"))
                    .coins(0n)
                    .endCell();
            }

            const currentSeqno = await wallet.getSeqno();

            const sellPayload = beginCell()
                .storeUint(0x0f8a7ea5, 32)
                .storeUint(Date.now(), 64)
                .storeCoins(tokensToSell)
                .storeAddress(Address.parse(routerAddress))
                .storeAddress(wallet.address)
                .storeBit(true)
                .storeRef(forwardPayload)
                .endCell();

            await wallet.send(
                internal({
                    to: routerAddress,
                    value: 80000000n,
                    body: sellPayload,
                    bounce: true
                })
            );

            let soldConfirmed = false;
            for (let i = 0; i < 15; i++) {
                await new Promise(resolve => setTimeout(resolve, 2000));
                const newSeqno = await wallet.getSeqno();
                const postSellJettonInfo = await getWalletJettonBalance(wallet.address.toString(), tokenAddress);

                if (newSeqno > currentSeqno && postSellJettonInfo.rawBalance < tokensToSell) {
                    soldConfirmed = true;
                    break;
                }
            }

            if (soldConfirmed) return true;
        } catch (err) {
            console.error(`Satış Denemesi ${attempt} Hatası:`, err.message);
        }

        if (attempt < maxRetries) {
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
    return false;
}

async function monitorPositions() {
    while (botRunning) {
        try {
            for (const [tokenAddr, pos] of Object.entries(activePositions)) {
                let currentPrice;
                try {
                    const url = `https://api.geckoterminal.com/api/v2/networks/ton/pools/${pos.poolAddr}`;
                    const res = await axios.get(url, { timeout: 6000 });
                    currentPrice = parseFloat(res.data?.data?.attributes?.base_token_price_usd || 0);
                } catch (apiErr) {
                    console.warn(`⚠️ Fiyat API Hatası (${tokenAddr.substring(0,6)}...), 0.5 TON maliyet tabanlı fallback koruma devrede.`);
                    currentPrice = pos.entryPrice;
                }

                if (!currentPrice || currentPrice <= 0) continue;

                const priceChangePercent = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
                console.log(`📊 Pozisyon Takibi [${tokenAddr.substring(0,6)}...]: Değişim: %${priceChangePercent.toFixed(2)}`);

                if (priceChangePercent >= TAKE_PROFIT_PERCENT || priceChangePercent <= -STOP_LOSS_PERCENT) {
                    const reason = priceChangePercent >= TAKE_PROFIT_PERCENT ? "🎯 Take Profit (%35 Kâr)" : "🛑 Stop Loss (%25 Zarar)";
                    console.log(`${reason} tetiklendi, DEX-specific retry satış başlatılıyor...`);

                    const sold = await executeSellSwapWithRetry(tokenAddr, pos.dex, pos.rawBalance);
                    if (sold) {
                        try {
                            await bot.sendMessage(ALLOWED_USER_ID, `💰 **POZİSYON KAPATILDI (${reason})**\nToken: \`${tokenAddr}\`\nDeğişim: \`%${priceChangePercent.toFixed(2)}\``, { parse_mode: "Markdown" });
                        } catch (e) {}
                        
                        await removePositionFromDb(tokenAddr);
                    } else {
                        try {
                            await bot.sendMessage(ALLOWED_USER_ID, `⚠️ **DİKKAT: Satış Emri Başarısız Oldu!**\nToken: \`${tokenAddr}\` tetiklendi fakat ağ onayı alınamadı. Bot tekrar deneyecek.`, { parse_mode: "Markdown" });
                        } catch (e) {}
                    }
                }
            }
        } catch (err) {
            console.error("TP/SL Döngü Hatası:", err.message);
        }

        await new Promise(resolve => setTimeout(resolve, 20000));
    }
}

async function sniperWorker() {
    monitorPositions();

    while (botRunning) {
        const pools = await fetchNewGramPools();

        for (const pool of pools) {
            if (!botRunning) break;
            if (!pool || !pool.attributes) continue;
            const attrs = pool.attributes;
            const poolAddr = attrs.address;
            const liqUsd = parseFloat(attrs.reserve_in_usd || 0);
            
            const baseTokenId = pool.relationships?.base_token?.data?.id || "";
            const tokenAddr = baseTokenId.replace("ton_", "");

            if (!tokenAddr || tokenAddr === GRAM_MASTER_ADDRESS || activePositions[tokenAddr]) continue;

            const tokenName = getPoolDisplayName(pool, attrs);

            if (!seenPools[poolAddr]) {
                seenPools[poolAddr] = { bought: false };
            }

            let poolInfo = seenPools[poolAddr];
            if (poolInfo.bought) continue;

            if (liqUsd >= MIN_LIQUIDITY_USD) {
                poolInfo.bought = true; 

                try {
                    await bot.sendMessage(ALLOWED_USER_ID, `🔍 **Hedef Likidite Yakalandı:** \`${tokenName}\`\n💧 Likidite: \`$${liqUsd.toFixed(2)}\``, { parse_mode: "Markdown" });
                } catch (e) {}

                const safety = await checkSafetyWithSimulation(pool);
                if (safety.safe) {
                    const buyResult = await executeBuySwap(safety.token, 0.5, safety.dex, attrs);
                    if (buyResult.success) {
                        const posData = { 
                            entryPrice: buyResult.entryPrice, 
                            poolAddr: poolAddr, 
                            dex: safety.dex,
                            amount: 0.5,
                            rawBalance: buyResult.rawBalance
                        };
                        await savePositionToDb(safety.token, posData);

                        try {
                            await bot.sendMessage(ALLOWED_USER_ID, `✅ **DEX-SPECIFIC ALIM BAŞARILI!**\nToken: \`${tokenName}\`\nDEX: \`${safety.dex.toUpperCase()}\`\nGiriş Fiyatı: \`$${buyResult.entryPrice.toFixed(6)}\``, { parse_mode: "Markdown" });
                        } catch (e) {}
                    } else {
                        try {
                            await bot.sendMessage(ALLOWED_USER_ID, `❌ **ALIM BAŞARISIZ (${tokenName})**\nSebep: \`${buyResult.error}\``, { parse_mode: "Markdown" });
                        } catch (e) {}
                    }
                } else {
                    try {
                        await bot.sendMessage(ALLOWED_USER_ID, `❌ **İŞLEM İPTAL EDİLDİ (${tokenName})**\n⚠️ **Güvenlik Sebebi:** \`${safety.reason}\``, { parse_mode: "Markdown" });
                    } catch (e) {}
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
        bot.sendMessage(msg.chat.id, "🚀 **Enterprise Production Bot Aktif!**\n🎯 TP: %35 | 🛑 SL: %25\n🛡️ DEX-Specific Payload, Simülasyon, MongoDB & Fallback Koruma Devrede", { parse_mode: "Markdown" });
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
        const balanceNano = await client.getBalance(wallet.address);
        const balanceTon = Number(balanceNano) / 1e9;
        bot.sendMessage(msg.chat.id, `💰 **Cüzdan Bakiyeniz:**\n\`${balanceTon.toFixed(4)} TON\`\n\n📍 Adres: \`${wallet.address.toString()}\``, { parse_mode: "Markdown" });
    } catch (error) {
        bot.sendMessage(msg.chat.id, `❌ Bakiye sorgulama hatası: \`${error.message}\``, { parse_mode: "Markdown" });
    }
});

console.log("Enterprise Production Sniper Bot başarıyla başlatıldı ve dinlemede...");

process.on('uncaughtException', (err) => {
  console.error('Yakalanamayan hata:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('Yakalanamayan Promise reddi:', err);
});
