const TelegramBot = require('node-telegram-bot-api');
const https = require('https');

const TG_TOKEN = process.env.TG_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const BUY_AMOUNT_GRAM = Number(process.env.BUY_AMOUNT_TON || 0.5);

// Telegram botunu polling (mesaj dinleme) aktif olarak başlatıyoruz
const bot = new TelegramBot(TG_TOKEN, { polling: true });

let knownPools = new Set();
let isFirstRun = true;

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 6000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('JSON parse hatası'));
        }
      });
    });
    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Zaman aşımı'));
    });
  });
}

async function sendAlert(message) {
  try {
    await bot.sendMessage(TG_CHAT_ID, message, { parse_mode: 'Markdown', disable_web_page_preview: true });
  } catch (err) {}
}

// Telegram'dan gelen /bakiye komutunu yakalayan güvenli dinleyici
bot.on('message', async (msg) => {
  if (!msg || !msg.text) return;
  const chatId = msg.chat.id;
  const text = msg.text.trim();

  if (text === '/bakiye') {
    try {
      await bot.sendMessage(chatId, `💰 *Cüzdan Durumu:* Bot aktif ve çalışıyor.\n- **İşlem Miktarı:** \`${BUY_AMOUNT_GRAM} GRAM\`\n- **İzlenen Havuz Sayısı:** \`${knownPools.size}\``, { parse_mode: 'Markdown' });
    } catch (err) {}
  }
});

async function checkAllPools() {
  try {
    let stonCount = 0;
    let dedustCount = 0;

    // 1. STON.fi Taraması
    try {
      const stonData = await httpGet('https://api.ston.fi/v1/pools');
      const pools = stonData && (stonData.pool_list || stonData.pools || stonData);
      if (Array.isArray(pools)) {
        stonCount = pools.length;
        if (isFirstRun) {
          pools.forEach(p => p.address && knownPools.add(p.address));
        } else {
          for (const pool of pools) {
            if (!pool || !pool.address) continue;
            if (!knownPools.has(pool.address)) {
              knownPools.add(pool.address);
              await sendAlert(`⏳ *[STON.fi] Yeni Havuz Yakalandı!*\n📍 Adres: \`${pool.address}\``);
            }
          }
        }
      }
    } catch (e) {}

    // 2. DeDust.io Taraması
    try {
      const dedustData = await httpGet('https://api.dedust.io/v2/pools');
      if (Array.isArray(dedustData)) {
        dedustCount = dedustData.length;
        if (isFirstRun) {
          dedustData.forEach(p => p.address && knownPools.add(p.address));
        } else {
          for (const pool of dedustData) {
            if (!pool || !pool.address) continue;
            if (!knownPools.has(pool.address)) {
              knownPools.add(pool.address);
              await sendAlert(`⏳ *[DeDust.io] Yeni Havuz Yakalandı!*\n📍 Adres: \`${pool.address}\``);
            }
          }
        }
      }
    } catch (e) {}

    if (isFirstRun) {
      isFirstRun = false;
      console.log(`İlk tarama tamamlandı. STON: ${stonCount}, DeDust: ${dedustCount}`);
      await sendAlert(`✅ *Sniper Bot Kararlı Modda Başlatıldı!*\n📊 STON: ${stonCount} | DeDust: ${dedustCount} havuz tarandı.`);
    }

  } catch (error) {
    console.log("Tarama hatası:", error.message);
  }
}

console.log("Bot başlatılıyor...");
setInterval(checkAllPools, 15000);
checkAllPools();

process.on('uncaughtException', (err) => console.log('Hata yakalandı:', err));
process.on('unhandledRejection', (err) => console.log('Reddedilme:', err));
