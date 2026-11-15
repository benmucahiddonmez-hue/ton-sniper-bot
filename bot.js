const TelegramBot = require('node-telegram-bot-api');

// Railway panelinden gireceğimiz gizli değişkenler
const TG_TOKEN = process.env.TG_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const bot = new TelegramBot(TG_TOKEN, { polling: false });

// Bilinen havuzları hafızada tutacağımız liste
let knownPools = new Set();
let isFirstRun = true;

async function sendAlert(message) {
  try {
    await bot.sendMessage(TG_CHAT_ID, message, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('Telegram mesaj hatası:', err.message);
  }
}

async function checkStonFiPools() {
  try {
    // STON.fi API üzerinden aktif havuzları çekiyoruz
    const response = await fetch('https://api.ston.fi/v1/pools');
    const data = await response.json();
    const pools = data.pool_list || [];

    for (const pool of pools) {
      const poolAddress = pool.address;

      // İlk açılışta mevcut binlerce havuzu hafızaya al (eski coinler için alarm çalmasın)
      if (isFirstRun) {
        knownPools.add(poolAddress);
        continue;
      }

      // Daha önce listede olmayan YENİ BİR HAVUZ yakalandığında:
      if (!knownPools.has(poolAddress)) {
        knownPools.add(poolAddress);
        
        const alertMsg = `🚨 *YENİ HAVUZ YAKALANDI (STON.fi)*\n\n` +
                         `📍 *Havuz Adresi:* \`${poolAddress}\`\n` +
                         `🪙 *Token 0:* \`${pool.token0_address}\`\n` +
                         `🪙 *Token 1:* \`${pool.token1_address}\`\n` +
                         `💧 *Likidite (USD):* $${Number(pool.lp_total_supply_usd || 0).toFixed(2)}`;
        
        console.log('Yeni havuz bulundu:', poolAddress);
        await sendAlert(alertMsg);
        
        // OTOMATİK ALIM (SWAP) KODU BURAYA EKLENECEK
      }
    }

    if (isFirstRun) {
      isFirstRun = false;
      console.log(`Başlangıç tamamlandı. ${knownPools.size} mevcut havuz hafızaya alındı. Yeni coinler bekleniyor...`);
      await sendAlert(`✅ *Bot Aktif!* ${knownPools.size} mevcut havuz tarandı. Yeni listelemeler bekleniyor...`);
    }

  } catch (error) {
    console.error('Havuz tarama hatası:', error.message);
  }
}

// Her 5 saniyede bir yeni havuz kontrolü yap
setInterval(checkStonFiPools, 5000);
checkStonFiPools();
