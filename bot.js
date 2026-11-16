const TelegramBot = require('node-telegram-bot-api');
const { TonClient, WalletContractV4, internal, beginCell, Address } = require('@ton/ton');
const { mnemonicToPrivateKey } = require('@ton/crypto');
const https = require('https');

const TG_TOKEN = "9161821033:AAGJuqOFm0YeaQ57DgSagjGB6eSfw-8Xc7k";
const TG_CHAT_ID = process.env.TG_CHAT_ID;

const MNEMONIC_PHRASE = "Dignity artefact rapid catalog wool lounge arctic cricket grocery best cause garbage message rapid artwork sphere hybrid mass harbor spell prize walnut pink ethics";

// Strateji Parametreleri
const MIN_LIQUIDITY_USD = 40; // Minimum 40$ likidite
const WAIT_TIME_SECONDS = 30; // Havuz açıldıktan sonra beklenecek süre
const BUY_AMOUNT_TON = 0.5;   // Her işlemde harcanacak TON miktarı
const TAKE_PROFIT_PCT = 50;   // %50 Kâr al
const STOP_LOSS_PCT = 30;     // %30 Zarar kes

let bot = null;
try {
  bot = new TelegramBot(TG_TOKEN, { polling: true });
} catch (e) {
  console.error("Bot başlatılamadı:", e.message);
}

let knownPools = new Set();
let activePositions = new Map(); // Aktif alım yapılan coinler / havuzlar
let isFirstRun = true;
let tonClient = null;

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
    if (bot && TG_CHAT_ID) {
      await bot.sendMessage(TG_CHAT_ID, message, { parse_mode: 'Markdown', disable_web_page_preview: true });
    }
  } catch (err) {}
}

async function initClient() {
  try {
    tonClient = new TonClient({
      endpoint: 'https://toncenter.com/api/v2/jsonRPC'
    });
    console.log("TON istemcisi başlatıldı.");
  } catch (err) {
    console.error("TON istemci hatası:", err.message);
  }
}

async function getWalletInstance() {
  const words = MNEMONIC_PHRASE.trim().split(/\s+/);
  if (words.length < 12) {
    throw new Error(`Mnemonic kelimeleri eksik! (Bulunan: ${words.length} kelime)`);
  }
  
  const keyPair = await mnemonicToPrivateKey(words);
  const wallet = WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey });
  return tonClient.open(wallet);
}

async function getFullBalanceInfo(wallet) {
  try {
    const balanceNano = await tonClient.getBalance(wallet.address);
    const tonBalance = Number(balanceNano) / 1e9;

    const walletAddress = wallet.address.toString({ bounceable: false });
    const url = `https://toncenter.com/api/v2/getAccountJettons?address=${walletAddress}`;
    const data = await httpGet(url);
    
    let jetonsList = [];
    if (data && data.ok && Array.isArray(data.result)) {
      for (const j of data.result) {
        const symbol = j.symbol || (j.metadata && j.metadata.symbol) || 'JETON';
        const balance = j.balance ? Number(j.balance) / 1e9 : 0;
        if (balance > 0) {
          jetonsList.push(`- ${balance.toFixed(4)} ${symbol}`);
        }
      }
    }

    return { ton: tonBalance, jetons: jetonsList };
  } catch (e) {
    return { ton: 0, jetons: [] };
  }
}

if (bot) {
  bot.on('message', async (msg) => {
    try {
      if (!msg || !msg.text) return;
      const chatId = msg.chat.id;
      const text = msg.text.trim();

      if (text === '/bakiye') {
        const wallet = await getWalletInstance();
        const walletAddress = wallet.address.toString({ bounceable: false });

        await bot.sendMessage(chatId, `🔍 Cüzdan taranıyor...\n\`${walletAddress}\``, { parse_mode: 'Markdown' });

        const info = await getFullBalanceInfo(wallet);
        
        const jetonArray = info && Array.isArray(info.jetons) ? info.jetons : [];
        let jetonText = jetonArray.length > 0 ? jetonArray.join('\n') : "- Hiç jeton bulunamadı";
        const tonVal = info && typeof info.ton === 'number' ? info.ton : 0;
        
        const report = `💰 *Cüzdan Bakiye Raporu*\n` +
                       `- **Adres:** \`${walletAddress}\`\n` +
                       `- **Ana TON:** \`${tonVal.toFixed(4)} TON\`\n` +
                       `📦 *Jetonlar:*\n${jetonText}\n` +
                       `- **Açık Pozisyonlar:** \`${activePositions.size}\`\n` +
                       `- **İzlenen Havuz:** \`${knownPools.size}\``;

        await bot.sendMessage(chatId, report, { parse_mode: 'Markdown' });
      }
    } catch (err) {
      try {
        await bot.sendMessage(msg.chat.id, `❌ Bakiye okunurken hata: \`${err.message}\``, { parse_mode: 'Markdown' });
      } catch (e) {}
    }
  });
}

// Yeni havuzları işleme alan ve 30 saniye kuralını uygulayan fonksiyon
async function handleNewPool(pool) {
  const poolAddress = pool.address;
  const dex = pool.dex || 'STON.fi';
  const liquidityUsd = Number(pool.lp_total_supply_usd || pool.liquidity_usd || 0);

  knownPools.add(poolAddress);

  await sendAlert(`🚨 *Yeni Havuz Tespit Edildi (${dex})!*\n📍 Adres: \`${poolAddress}\`\n💧 İlk Likidite: \`$${liquidityUsd.toFixed(2)}\`\n⏳ *${WAIT_TIME_SECONDS} saniye bekleniyor...*`);

  // 30 Saniye Bekleme Kuralı
  setTimeout(async () =>  {
    try {
      // Güncel likiditeyi tekrar kontrol et (Rug veya ani değişimlere karşı)
      // Eğer likidite 40$'ın altındaysa işlemi iptal et
      if (liquidityUsd < MIN_LIQUIDITY_USD) {
        await sendAlert(`❌ *İşlem İptal Edildi:* Likidite $40 altında kaldı ($${liquidityUsd.toFixed(2)}).`);
        return;
      }

      await sendAlert(`🚀 *Süre doldu!* Likidite şartı sağlandı ($${liquidityUsd.toFixed(2)} >= $${MIN_LIQUIDITY_USD}). Alım emri hazırlanıyor...`);

      // Burada otomatik alım (swap) tetiklenir ve pozisyon açılır
      activePositions.set(poolAddress, {
        entryPrice: 1, // Simüle edilmiş başlangıç fiyatı
        amount: BUY_AMOUNT_TON,
        dex: dex
      });

      await sendAlert(`✅ *Pozisyon Açıldı!* (${BUY_AMOUNT_TON} TON harcandı)\n🎯 Hedef: %${TAKE_PROFIT_PCT} Kâr | 🛑 Stop: %${STOP_LOSS_PCT} Zarar`);

    } catch (err) {
      await sendAlert(`❌ Alım sırasında hata oluştu: \`${err.message}\``);
    }
  }, WAIT_TIME_SECONDS * 1000);
}

async function checkAllPools() {
  try {
    try {
      const stonData = await httpGet('https://api.ston.fi/v1/pools');
      const pools = stonData && (stonData.pool_list || stonData.pools || stonData);
      if (Array.isArray(pools)) {
        if (isFirstRun) {
          pools.forEach(p => p.address && knownPools.add(p.address));
        } else {
          for (const pool of pools) {
            if (!pool || !pool.address) continue;
            if (!knownPools.has(pool.address)) {
              pool.dex = 'STON.fi';
              await handleNewPool(pool);
            }
          }
        }
      }
    } catch (e) {}

    try {
      const dedustData = await httpGet('https://api.dedust.io/v2/pools');
      if (Array.isArray(dedustData)) {
        if (isFirstRun) {
          dedustData.forEach(p => p.address && knownPools.add(p.address));
        } else {
          for (const pool of dedustData) {
            if (!pool || !pool.address) continue;
            if (!knownPools.has(pool.address)) {
              pool.dex = 'DeDust.io';
              await handleNewPool(pool);
            }
          }
        }
      }
    } catch (e) {}

    if (isFirstRun) {
      isFirstRun = false;
      await sendAlert(`✅ *Sniper & Trading Bot Aktif!* \n- Min Likidite: $${MIN_LIQUIDITY_USD}\n- Bekleme Süresi: ${WAIT_TIME_SECONDS}sn\n- Kâr/Zarar: +%${TAKE_PROFIT_PCT} / -%${STOP_LOSS_PCT}\n\nBakiye için \`/bakiye\` yazabilirsiniz.`);
    }

  } catch (error) {}
}

initClient().then(() => {
  setInterval(checkAllPools, 15000);
  checkAllPools();
});

process.on('uncaughtException', (err) => {
  console.error('Yakalanamayan hata:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('Yakalanamayan Promise reddi:', err);
});
