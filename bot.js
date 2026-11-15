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
    // 1. Havuzları ve varlıkları (assets) aynı anda çekiyoruz
    const [poolsRes, assetsRes] = await Promise.all([
      fetch('https://api.ston.fi/v1/pools'),
      fetch('https://api.ston.fi/v1/assets')
    ]);

    const poolsData = await poolsRes.json();
    const assetsData = await assetsRes.json();
    
    const pools = poolsData.pool_list || [];
    const assets = assetsData.asset_list || [];

    // Token adresinden sembolü bulmak için sözlük (map) oluşturuyoruz
    const assetMap = {};
    for (const asset of assets) {
      assetMap[asset.contract_address] = asset.symbol || 'Bilinmiyor';
    }

    for (const pool of pools) {
      const poolAddress = pool.address;

      if (isFirstRun) {
        knownPools.add(poolAddress);
        continue;
      }

      if (!knownPools.has(poolAddress)) {
        knownPools.add(poolAddress);
        
        const token0Addr = pool.token0_address;
        const token1Addr = pool.token1_address;
        
        // Adreslere karşılık gelen token isimlerini (sembollerini) alıyoruz
        const symbol0 = assetMap[token0Addr] || token0Addr.slice(0, 6) + '...';
        const symbol1 = assetMap[token1Addr] || token1Addr.slice(0, 6) + '...';
        
        const liquidityUsd = Number(pool.lp_total_supply_usd || 0).toFixed(2);
        const stonfiLink = `https://app.ston.fi/swap?chart=to&ft=${token0Addr}&tt=${token1Addr}`;

        const alertMsg = `🚨 *YENİ HAVUZ / COİN YAKALANDI!* 🚨\n\n` +
                         `🪙 *Parite:* \`${symbol0} / ${symbol1}\`\n` +
                         `💧 *Likidite:* $${liquidityUsd}\n` +
                         `📍 *Havuz:* \`${poolAddress.slice(0, 10)}...\`\n\n` +
                         `🔗 [STON.fi'de Aç & İncele](${stonfiLink})`;
        
        console.log(`Yeni havuz bulundu: ${symbol0}/${symbol1}`);
        await sendAlert(alertMsg);
      }
    }

    if (isFirstRun) {
      isFirstRun = false;
      console.log(`Başlangıç tamamlandı. ${knownPools.size} havuz yüklendi.`);
      await sendAlert(`✅ *Bot Güncellendi!* Token isimleri (sembolleri) aktif edildi. ${knownPools.size} havuz takipte.`);
    }

  } catch (error) {
    console.error('Tarama hatası:', error.message);
  }
}

// Her 5 saniyede bir kontrol et
setInterval(checkStonFiPools, 5000);
checkStonFiPools();
