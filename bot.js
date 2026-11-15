const https = require('https');

const TG_TOKEN = process.env.TG_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const MNEMONIC = process.env.WALLET_MNEMONIC ? process.env.WALLET_MNEMONIC.split(' ') : [];
const MIN_LIQUIDITY_USD = Number(process.env.MIN_LIQUIDITY_USD || 50);
const BUY_AMOUNT_GRAM = Number(process.env.BUY_AMOUNT_TON || 0.5);

let knownPools = new Set();
let isFirstRun = true;

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 6000 }, (res) => {
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

async function sendTelegram(message) {
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  const postData = JSON.stringify({
    chat_id: TG_CHAT_ID,
    text: message,
    parse_mode: 'Markdown',
    disable_web_page_preview: true
  });

  const options = {
    hostname: 'api.telegram.org',
    port: 443,
    path: `/bot${TG_TOKEN}/sendMessage`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData)
    }
  };

  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      resolve();
    });
    req.on('error', () => resolve());
    req.write(postData);
    req.end();
  });
}

async function checkAllPools() {
  try {
    let stonCount = 0;
    let dedustCount = 0;

    // STON.fi Taraması
    try {
      const stonPoolsData = await httpGet('[https://api.ston.fi/v1/pools](https://api.ston.fi/v1/pools)');
      const stonPools = (stonPoolsData && stonPoolsData.pool_list) || [];
      stonCount = stonPools.length;

      if (isFirstRun) {
        stonPools.forEach(p => p.address && knownPools.add(p.address));
      } else {
        for (const pool of stonPools) {
          if (!pool || !pool.address) continue;
          const poolAddress = pool.address;

          if (!knownPools.has(poolAddress)) {
            knownPools.add(poolAddress);
            await sendTelegram(`⏳ *[STON.fi] Yeni Havuz Yakalandı!*\n📍 Adres: \`${poolAddress}\``);
          }
        }
      }
    } catch (e) {}

    // DeDust.io Taraması
    try {
      const dedustPools = await httpGet('[https://api.dedust.io/v2/pools](https://api.dedust.io/v2/pools)');
      if (Array.isArray(dedustPools)) {
        dedustCount = dedustPools.length;
        if (isFirstRun) {
          dedustPools.forEach(p => p.address && knownPools.add(p.address));
        } else {
          for (const pool of dedustPools) {
            if (!pool || !pool.address) continue;
            const poolAddress = pool.address;

            if (!knownPools.has(poolAddress)) {
              knownPools.add(poolAddress);
              await sendTelegram(`⏳ *[DeDust.io] Yeni Havuz Yakalandı!*\n📍 Adres: \`${poolAddress}\``);
            }
          }
        }
      }
    } catch (e) {}

    if (isFirstRun) {
      isFirstRun = false;
      console.log(`İlk tarama tamamlandı. STON: ${stonCount}, DeDust: ${dedustCount}`);
      await sendTelegram(`✅ *Sniper Bot Kararlı Modda Başlatıldı!*\n📊 STON: ${stonCount} | DeDust: ${dedustCount} havuz tarandı.`);
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
