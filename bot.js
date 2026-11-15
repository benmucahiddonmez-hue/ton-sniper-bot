const TelegramBot = require('node-telegram-bot-api');

const TG_TOKEN = process.env.TG_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

if (!TG_TOKEN || !TG_CHAT_ID) {
  console.error("Telegram Bot Token veya Chat ID eksik!");
}

const bot = new TelegramBot(TG_TOKEN, { polling: false });

let knownPools = new Set();
let isFirstRun = true;

async function sendAlert(message) {
  try {
    await bot.sendMessage(TG_CHAT_ID, message, { parse_mode: 'Markdown' });
    console.log("Telegram bildirimi gönderildi.");
  } catch (err) {
    console.error('Telegram mesaj hatası:', err.message);
  }
}

async function checkStonFiPools() {
  try {
    const response = await fetch('https://api.ston.fi/v1/pools');
    const data = await response.json();
    const pools = data.pool_list || [];

    for (const pool of pools) {
      const poolAddress = pool.address;

      // İlk çalıştırmada mevcut havuzları hafızaya alıyoruz (eski coinler alarm üretmesin diye)
      if (isFirstRun) {
        knownPools.add(poolAddress);
        continue;
      }

      // Eğer listede olmayan yepyeni bir havuz çıkarsa:
      if (!knownPools.has(poolAddress)) {
        knownPools.add(poolAddress);
        
        const alertMsg = `🚨 *YENİ HAVUZ YAKALANDI (STON.fi)*\n\n` +
                         `📍 *Havuz Adresi:* \`${poolAddress}\`\n` +
                         `🪙 *Token 0:* \`${pool.token0_address}\`\n` +
                         `🪙 *Token 1:* \`${pool.token1_address}\`\n` +
                         `💧 *Likidite (USD):* $${Number(pool.lp_total_supply_usd || 0).toFixed(2)}`;
        
        console.log('Yeni havuz bulundu ve bildiriliyor:', poolAddress);
        await sendAlert(alertMsg);
      }
    }

    if (isFirstRun) {
      isFirstRun = false;
      console.log(`Başlangıç tamamlandı. ${knownPools.size} mevcut havuz hafızaya alındı. Yeni listelemeler bekleniyor...`);
      await sendAlert(`✅ *Bot Aktif ve Tarıyor!* ${knownPools.size} mevcut havuz tarandı. Yeni coin bekleniyor...`);
    }

  } catch (error) {
    console.error('Havuz tarama hatası:', error.message);
  }
}

// Her 5 saniyede bir kontrol et
setInterval(checkStonFiPools, 5000);
checkStonFiPools();
