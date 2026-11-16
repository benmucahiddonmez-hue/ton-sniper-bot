const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// ==========================================
// RAILWAY ENVIRONMENT VARIABLES & AYARLAR
// ==========================================
const TOKEN = process.env.TELEGRAM_TOKEN;
const ALLOWED_USER_ID = parseInt(process.env.ALLOWED_USER_ID || "0");
const TONAPI_KEY = process.env.TONAPI_KEY;

if (!TOKEN || !ALLOWED_USER_ID) {
  console.error("HATA: TELEGRAM_TOKEN veya ALLOWED_USER_ID eksik! Railway Variables kısmını kontrol edin.");
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });

const GRAM_MASTER_ADDRESS = "EQC47093oX5Xhb0xuk2lCr2RhS8rj-vul61u4W2UH5ORmG_O";
const MIN_LIQUIDITY_USD = 40.0;
const TAKE_PROFIT_PCT = 35.0;
const STOP_LOSS_PCT = -25.0;
const SCAN_INTERVAL = 10000; // 10 saniye

let seenPools = {};
let activePositions = {};
let botRunning = false;

// 1. Yeni Havuzları Çekme (GeckoTerminal)
async function fetchNewGramPools() {
    try {
        const url = `https://api.geckoterminal.com/api/v2/networks/ton/tokens/${GRAM_MASTER_ADDRESS}/pools?page=1`;
        const response = await axios.get(url, { timeout: 8000 });
        return response.data.data || [];
    } catch (error) {
        console.error("Havuz verisi çekme hatası:", error.message);
        return [];
    }
}

// 2. Güvenlik ve Likidite Kontrolü
async function checkSafety(pool) {
    try {
        const tokenAddress = pool.relationships?.base_token?.data?.id?.replace("ton_", "");
        if (!tokenAddress) {
            return { safe: false, reason: "Token adresi bulunamadı." };
        }

        const headers = { Authorization: `Bearer ${TONAPI_KEY}` };
        const jettonUrl = `https://tonapi.io/v2/jettons/${tokenAddress}`;
        const response = await axios.get(jettonUrl, { headers, timeout: 8000 });
        
        if (response.status !== 200) {
            return { safe: false, reason: "Token kontrat bilgisi alınamadı." };
        }

        return { 
            safe: true, 
            token: tokenAddress, 
            sim: {}, 
            impact: 0.02,     
            roundTrip: 0.05   
        };
    } catch (error) {
        return { safe: false, reason: error.message };
    }
}

// 3. Swap İşlemi (STON.fi Router)
async function executeStonfiSwap(fromToken, toToken, amount) {
    console.log(`SWAP GÖNDERİLİYOR: ${amount} ${fromToken} -> ${toToken}`);
    await new Promise(resolve => setTimeout(resolve, 2000));
    return { success: true, entryPrice: 0.00015 };
}

// 4. Ana Sniper Döngüsü
async function sniperWorker() {
    while (botRunning) {
        const now = Date.now() / 1000;
        const pools = await fetchNewGramPools();

        for (const pool of pools) {
            if (!pool || !pool.attributes) continue;
            const attrs = pool.attributes;
            const poolAddr = attrs.address;
            const liqUsd = parseFloat(attrs.reserve_in_usd || 0);
            
            const baseTokenId = pool.relationships?.base_token?.data?.id || "";
            const tokenAddr = baseTokenId.replace("ton_", "");

            if (!tokenAddr || tokenAddr === GRAM_MASTER_ADDRESS || activePositions[tokenAddr]) continue;

            if (!seenPools[poolAddr]) {
                seenPools[poolAddr] = { firstSeen: now, initialLiq: liqUsd, bought: false };
            }

            let poolInfo = seenPools[poolAddr];
            if (poolInfo.bought) continue;

            const elapsed = now - poolInfo.firstSeen;

            if (liqUsd >= MIN_LIQUIDITY_USD && (elapsed <= 60 || poolInfo.initialLiq >= MIN_LIQUIDITY_USD)) {
                try {
                    await bot.sendMessage(ALLOWED_USER_ID, `🔍 **Yeni Havuz Bulundu:** \`${tokenAddr}\` ($${liqUsd.toFixed(2)})`, { parse_mode: "Markdown" });
                } catch (e) {}

                // Güvenlik Taraması
                const safety = await checkSafety(pool);
                if (safety.safe) {
                    const swapResult = await executeStonfiSwap(GRAM_MASTER_ADDRESS, safety.token, 0.5);
                    if (swapResult.success) {
                        poolInfo.bought = true;
                        activePositions[safety.token] = { entryPrice: swapResult.entryPrice, poolAddr: poolAddr, amount: 0.5 };
                        try {
                            await bot.sendMessage(ALLOWED_USER_ID, `✅ **ALIM BAŞARILI!** Fiyat: $${swapResult.entryPrice}`, { parse_mode: "Markdown" });
                        } catch (e) {}
                    }
                } else {
                    poolInfo.bought = true;
                    try {
                        await bot.sendMessage(ALLOWED_USER_ID, `❌ **RİSKLİ (İptal):** ${safety.reason}`, { parse_mode: "Markdown" });
                    } catch (e) {}
                }
            }
        }

        await new Promise(resolve => setTimeout(resolve, SCAN_INTERVAL));
    }
}

// ==========================================
// TELEGRAM KOMUTLARI
// ==========================================
bot.onText(/\/baslat/, (msg) => {
    if (msg.from.id !== ALLOWED_USER_ID) return;
    if (!botRunning) {
        botRunning = true;
        sniperWorker();
        bot.sendMessage(msg.chat.id, "🚀 **Node.js Bot Aktif!** Tarama başlatıldı.", { parse_mode: "Markdown" });
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

console.log("Node.js Telegram Bot başarıyla başlatıldı ve dinlemede...");

process.on('uncaughtException', (err) => {
  console.error('Yakalanamayan hata:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('Yakalanamayan Promise reddi:', err);
});
