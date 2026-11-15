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
    await bot.sendMessage(TG_CHAT_ID, message, { parse_mode: 'Markdown', disable_web_page_preview: true });
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

      // İlk çalıştırmada mevcut havuzları hafızaya al
      if (isFirstRun) {
        knownPools.add(poolAddress);
        continue;
      }

      // Yeni havuz yakalandığında:
      if (!knownPools.has(poolAddress)) {
        knownPools.add(poolAddress);
        
        // Token adresleri ve likidite bilgileri
        const token0 = pool.token0_address;
        const token1 = pool.token1_address;
        const liquidityUsd = Number(pool.lp_total_supply_usd || 0).toFixed(2);
        
        // STON.fi doğrudan alım/inceleme linki
        const stonfiLink = `https://app.ston.fi/swap?chart=to&ft=${token0}&tt=${token1}`;

        const alertMsg = `🚨 *YENİ COİN / HAVUZ YAKALANDI!* 🚨\n\n` +
                         `🪙 *Token 0:* \`${token0}\`\n` +
                         `🪙 *Token 1:* \`${token1}\`\n` +
                         `💧 *Likidite:* $${liquidityUsd}\n` +
                         `📍 *Havuz Adresi:* \`${poolAddress}\`\n\n` +
                         `🔗 [STON.fi'de İncele & Al](${stonfiLink})`;
        
        console.log('Yeni havuz bulundu ve detaylar gönderiliyor:', poolAddress);
        await sendAlert(alertMsg);
      }
    }

    if (isFirstRun) {
      isFirstRun = false;
      console.log(`Başlangıç tamamlandı. ${knownPools.size} mevcut havuz hafızaya alındı.`);
      await sendAlert(`✅ *Bot Güncellendi ve Tarıyor!* ${knownPools.size} havuz takipte. Yeni coin çıktığında detaylarıyla bildirim alacaksınız.`);
    }

  } catch (error) {
    console.error('Havuz tarama hatası:', error.message);
  }
}

// Her 5 saniyede bir kontrol et
setInterval(checkStonFiPools, 5000);
checkStonFiPools();
