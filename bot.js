const TelegramBot = require('node-telegram-bot-api');
const { TonClient, WalletContractV4 } = require('@ton/ton');
const { mnemonicToPrivateKey } = require('@ton/crypto');
const https = require('https');

const TG_TOKEN = "9161821033:AAGJuqOFm0YeaQ57DgSagjGB6eSfw-8Xc7k";
const TG_CHAT_ID = process.env.TG_CHAT_ID;

const MNEMONIC_PHRASE = "Dignity artefact rapid catalog wool lounge arctic cricket grocery best cause garbage message rapid artwork sphere hybrid mass harbor spell prize walnut pink ethics";

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
    if (TG_CHAT_ID) {
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
  } catch (err) {}
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

bot.on('message', async (msg) => {
  if (!msg || !msg.text) return;
  const chatId = msg.chat.id;
  const text = msg.text.trim();

  if (text === '/bakiye') {
    try {
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
                     `- **İzlenen Havuz:** \`${knownPools.size}\``;

      await bot.sendMessage(chatId, report, { parse_mode: 'Markdown' });
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
      await sendAlert(`✅ *Sniper Bot Aktif!* Bakiye için \`/bakiye\` yazabilirsiniz.`);
    }

  } catch (error) {}
}

initClient().then(() => {
  setInterval
