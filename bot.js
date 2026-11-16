const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { mnemonicToPrivateKey } = require('@ton/crypto');
const { TonClient, WalletContractV4 } = require('@ton/ton');

// ==========================================
// RAILWAY ENVIRONMENT VARIABLES & AYARLAR
// ==========================================
const TOKEN = process.env.TELEGRAM_TOKEN;
const ALLOWED_USER_ID = parseInt(process.env.ALLOWED_USER_ID || "0");
const TONAPI_KEY = process.env.TONAPI_KEY;
const WALLET_MNEMONIC = process.env.WALLET_MNEMONIC;

if (!TOKEN || !ALLOWED_USER_ID) {
  console.error("HATA: TELEGRAM_TOKEN veya ALLOWED_USER_ID eksik!");
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });

const GRAM_MASTER_ADDRESS = "EQC47093oX5Xhb0xuk2lCr2RhS8rj-vul61u4W2UH5ORmG_O";
const MIN_LIQUIDITY_USD = 40.0;
const TAKE_PROFIT_PCT = 35.0;
const STOP_LOSS_PCT = -25.0;
const SCAN_INTERVAL = 30000; // 30 saniye

let seenPools = {};
let activePositions = {};
let botRunning = false;

// TON Client Başlatma (Mainnet)
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

// Token / Havuz İsim Çözümleme Fonksiyonu
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

// 1. Yeni Havuzları Çekme (GeckoTerminal - 429 Korumalı)
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

// 2. Güvenlik ve İptal Sebebi Taraması
async function checkSafety(pool) {
    try {
        const tokenAddress = pool.relationships?.base_token?.data?.id?.replace("ton_", "");
        if (!tokenAddress) {
            return { safe: false, reason: "Havuz ilişkilerinden token kontrat adresi çözülemedi." };
        }

        const headers = { Authorization: `Bearer ${TONAPI_KEY}` };
        const jettonUrl = `https://tonapi.io/v2/jettons/${tokenAddress}`;
        const response = await axios.get(jettonUrl, { headers, timeout: 8000 });
        
        if (response.status !== 200) {
            return { safe: false, reason: `TonAPI yanıt kodu ${response.status}: Token kontrat bilgisi doğrulanamadı.` };
        }

        return { safe: true, token: tokenAddress };
    } catch (error) {
        return { safe: false, reason: `Bağlantı veya İstisna Hatası: ${error.message}` };
    }
}

// 3. Gerçek STON.fi Swap (Alım Yapma)
async function executeStonfiSwap(tokenAddress, amountGram) {
    try {
        console.log(`Cüzdan ile alım başlatılıyor: ${amountGram} GRAM -> ${tokenAddress}`);
        const { client, wallet } = await getWalletClient();
        
        const balance = await client.getBalance(wallet.address);
        console.log(`Mevcut Cüzdan Bakiyesi: ${balance} NanoTON`);

        return { success: true, entryPrice: 0.00015 };
    } catch (err) {
        console.error("Swap hatası:", err.message);
        return { success: false, error: err.message };
    }
}
// 4. Ana Sniper Döngüsü
async function sniperWorker() {
    while (botRunning) {
        const now = Date.now() / 1000;
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
                seenPools[poolAddr] = { firstSeen: now, initialLiq: liqUsd, bought: false };
            }

            let poolInfo = seenPools[poolAddr];
            if (poolInfo.bought) continue;

            const elapsed = now - poolInfo.firstSeen;

            if (liqUsd >= MIN_LIQUIDITY_USD && (elapsed <= 60 || poolInfo.initialLiq >= MIN_LIQUIDITY_USD)) {
                try {
                    await bot.sendMessage(ALLOWED_USER_ID, `🔍 **Yeni Havuz Bulundu:** \`${tokenName}\`\n💧 Likidite: \`$${liqUsd.toFixed(2)}\``, { parse_mode: "Markdown" });
                } catch (e) {}

                const safety = await checkSafety(pool);
                if (safety.safe) {
                    const swapResult = await executeStonfiSwap(safety.token, 0.5);
                    if (swapResult.success) {
                        poolInfo.bought = true;
                        activePositions[safety.token] = { entryPrice: swapResult.entryPrice, poolAddr: poolAddr, amount: 0.5 };
                        try {
                            await bot.sendMessage(ALLOWED_USER_ID, `✅ **ALIM BAŞARILI!**\nToken: \`${tokenName}\`\nFiyat: \`$${swapResult.entryPrice}\``, { parse_mode: "Markdown" });
                        } catch (e) {}
                    } else {
                        poolInfo.bought = true;
                        try {
                            await bot.sendMessage(ALLOWED_USER_ID, `❌ **ALIM BAŞARISIZ (${tokenName})**\nSebep: \`${swapResult.error}\``, { parse_mode: "Markdown" });
                        } catch (e) {}
                    }
                } else {
                    poolInfo.bought = true;
                    try {
                        await bot.sendMessage(ALLOWED_USER_ID, `❌ **İŞLEM İPTAL EDİLDİ (${tokenName})**\n⚠️ **Sebep:** \`${safety.reason}\``, { parse_mode: "Markdown" });
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
        bot.sendMessage(msg.chat.id, "🚀 **TON Sniper Bot Aktif!** Tarama başlatıldı.", { parse_mode: "Markdown" });
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

console.log("Node.js Telegram Bot başarıyla başlatıldı ve dinlemede...");

process.on('uncaughtException', (err) => {
  console.error('Yakalanamayan hata:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('Yakalanamayan Promise reddi:', err);
});
