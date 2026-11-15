const TelegramBot = require('node-telegram-bot-api');
const { TonClient, WalletContractV4 } = require('@ton/ton');
const { mnemonicToPrivateKey } = require('@ton/crypto');
https = require('https');

const TG_TOKEN = process.env.TG_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
// 12 kelimenizi boşluklarla buraya yazabilirsiniz veya Railway'e WALLET_MNEMONIC olarak ekleyebilirsiniz
const MNEMONIC_PHRASE = process.env.WALLET_MNEMONIC || "wet sunny glow owner cactus ugly toilet web always person citizen copy";
const BUY_AMOUNT_GRAM = Number(process.env.BUY_AMOUNT_TON || 0.5);

const bot = new TelegramBot(TG_TOKEN, { polling: true });

let knownPools = new Set();
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
    await bot.sendMessage(TG_CHAT_ID, message, { parse_mode: 'Markdown', disable_web_page_preview: true });
  } catch (err) {}
}

async function initClient() {
  try {
    tonClient = new TonClient({
      endpoint: 'https://toncenter.com/api/v2/jsonRPC'
    });
    console.log("TON istemcisi başlatıldı.");
  } catch (err) {}
}

// 12 kelimeden Tonkeeper uyumlu cüzdan nesnesini türeten fonksiyon
async function getWalletInstance() {
  const words = MNEMONIC_PHRASE.trim().split(/\s+/);
  if (words.length < 12) throw new Error("Mnemonic kelimeleri eksik!");
  
  const keyPair = await mnemonicToPrivateKey(words);
  // Tonkeeper standart v4 cüzdan kontratı
  const wallet = WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey });
  return tonClient.open(wallet);
}

// Cüzdandaki GRAM bakiyesini sorgulama
async function getGramBalance(walletAddress) {
  try {
    const url = `https://toncenter.com/api/v2/getAccountJettons?address=${walletAddress}`;
    const data = await httpGet(url);
    
    if (data && data.ok && Array.isArray(data.result)) {
      for (const j of data.result) {
        const symbol = j.symbol || (j.metadata && j.metadata.symbol) || '';
        const balance = j.balance ? Number(j.balance) / 1e9 : 0;
        
        if (symbol.toUpperCase().includes('GRAM') || balance > 0) {
          return { symbol: symbol || 'GRAM', balance: balance };
        }
      }
    }
  } catch (e) {}
  return { symbol: 'GRAM', balance: 0 };
}

// Telegram /bakiye komutu dinleyicisi
bot.on('message', async (msg) => {
  if (!msg || !msg.text) return;
  const chatId = msg.chat.id;
  const text = msg.text.trim();

  if (text === '/bakiye') {
    try {
      const wallet = await getWalletInstance();
      const walletAddress = wallet.address.toString({ bounceable: false });

      await bot.sendMessage(chatId, `🔍 Cüzdan taranıyor...\n\`${walletAddress}\``, { parse_mode: 'Markdown' });

      const assetInfo = await getGramBalance(walletAddress);
      
      await bot.sendMessage(chatId, `💰 *Cüzdan Bakiye Raporu*\n- **Adres:** \`${walletAddress}\`\n- **Bakiye:** \`${assetInfo.balance.toFixed(4)} ${assetInfo.symbol}\`\n- **İzlenen Havuz:** \`${knownPools.size}\``, { parse_mode: 'Markdown' });
    } catch (err) {
      await bot.sendMessage(chatId, `❌ Bakiye okunurken hata: \`${err.message}\``, { parse_mode: 'Markdown' });
    }
  }
});

async function checkAllPools() {
  try {
    let stonCount = 0;
    let dedustCount = 0;

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
      await sendAlert(`✅ *Sniper Bot Mnemonic Modunda Aktif!* Bakiye için \`/bakiye\` yazabilirsiniz.`);
    }

  } catch (error) {}
}

initClient().then(() => {
  setInterval(checkAllPools, 15000);
  checkAllPools();
});

process.on('uncaughtException', () => {});
process.on('unhandledRejection', () => {});
