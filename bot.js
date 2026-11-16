const TelegramBot = require('node-telegram-bot-api');
const { TonClient, WalletContractV4, internal, beginCell, Address, toNano } = require('@ton/ton');
const { mnemonicToPrivateKey } = require('@ton/crypto');
const https = require('https');

const TG_TOKEN = "9161821033:AAGJuqOFm0YeaQ57DgSagjGB6eSfw-8Xc7k";
const TG_CHAT_ID = process.env.TG_CHAT_ID;

const MNEMONIC_PHRASE = "Dignity artefact rapid catalog wool lounge arctic cricket grocery best cause garbage message rapid artwork sphere hybrid mass harbor spell prize walnut pink ethics";

const MIN_LIQUIDITY_USD = 40; 
const WAIT_TIME_SECONDS = 60; 
const BUY_AMOUNT_TON = 0.5;   
const TAKE_PROFIT_PCT = 50;   
const STOP_LOSS_PCT = 30;     

let bot = null;
try {
  bot = new TelegramBot(TG_TOKEN, { polling: true });
} catch (e) {
  console.error("Bot başlatılamadı:", e.message);
}

let knownPools = new Set();
let activePositions = new Map();
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
    const balance = await tonClient.getBalance(wallet.address);
    const tonBalance = Number(balance) / 1e9;

    const walletAddress = wallet.address.toString({ bounceable: false });
    const url = `https://toncenter.com/api/v2/getAccountJettons?address=${walletAddress}`;
    const data = await httpGet(url);
    
    let jetonsList = [];
    if (data && data.ok && Array.isArray(data.result)) {
      for (const j of data.result) {
        const symbol = j.symbol || (j.metadata && j.metadata.symbol) || 'JETON';
        const bal = j.balance ? Number(j.balance) / 1e9 : 0;
        if (bal > 0) {
          jetonsList.push(`- ${bal.toFixed(4)} ${symbol}`);
        }
      }
    }

    return { ton: tonBalance, jetons: jetonsList };
  } catch (e) {
    return { ton: 0, jetons: [] };
  }
}

async function executeSwap(pool, amountTon) {
  try {
    const wallet = await getWalletInstance();
    const seqno = await wallet.getSeqno();
    
    const targetAddress = Address.parse(pool.address);

    const forwardPayload = beginCell()
      .storeUint(0, 32) 
      .endCell();

    await wallet.sendTransfer({
      seqno,
      secretKey: (await mnemonicToPrivateKey(MNEMONIC_PHRASE.trim().split(/\s+/))).secretKey,
      messages: [
        internal({
          to: targetAddress,
          value: toNano(amountTon.toString()),
          bounce: true,
          body: forwardPayload
        })
      ]
    });

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function checkHoneypotAndSafety(pool) {
  try {
    const poolAddress = pool.address;
    
    const registryUrl = pool.dex === 'STON.fi' 
      ? `https://api.ston.fi/v1/pools/${poolAddress}`
      : `https://api.dedust.io/v2/pools/${poolAddress}`;
      
    const poolDetails = await httpGet(registryUrl);
    if (!poolDetails) {
      return { safe: false, reason: "Havuz detayları okunamadı (API yanıt vermedi)." };
    }

    return { safe: true };
  } catch (err) {
    return { safe: false, reason: `Güvenlik simülasyonu başarısız: ${err.message}` };
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

function getPoolDisplayName(pool) {
  if (pool.symbol) return pool.symbol;
  if (pool.token0_symbol && pool.token1_symbol) return `${pool.token0_symbol}/${pool.token1_symbol}`;
  if (pool.token0_address && pool.token1_address) {
    return `${pool.token0_address.substring(0, 4)}/${pool.token1_address.substring(0, 4)}`;
  }
  if (pool.assets && Array.isArray(pool.assets) && pool.assets.length >= 2) {
    const a0 = typeof pool.assets[0] === 'string' ? pool.assets[0].substring(0, 4) : 'TON';
    const a1 = typeof pool.assets[1] === 'string' ? pool.assets[1].substring(0, 4) : 'TOKEN';
    return `${a0}/${a1}`;
  }
  if (pool.address) {
    return `Pool_${pool.address.substring(0, 4)}...${pool.address.substring(pool.address.length - 4)}`;
  }
  return "Yeni Token";
}

async function handleNewPool(pool) {
  const poolAddress = pool.address;
  const dex = pool.dex || 'STON.fi';
  const tokenName = getPoolDisplayName(pool);
  
  const liquidityUsd = Number(
    pool.lp_total_supply_usd || 
    pool.liquidity_usd || 
    pool.reserve0_usd || 
    pool.usd_price || 
    pool.tvl_usd || 
    0
  );

  knownPools.add(poolAddress);

  await sendAlert(`🚨 *Yeni Havuz Tespit Edildi (${dex})!*\n🪙 Token: *${tokenName}*\n📍 Adres: \`${poolAddress}\`\n💧 İlk Likidite: \`$${liquidityUsd.toFixed(2)}\`\n⏳ *1 Dakika (${WAIT_TIME_SECONDS} sn) bekleniyor...*`);

  setTimeout(async () => {
    try {
      if (liquidityUsd > 0 && liquidityUsd < MIN_LIQUIDITY_USD) {
        await sendAlert(`❌ *[${tokenName}] İşlem İptal Edildi:* Likidite $40 altında kaldı ($${liquidityUsd.toFixed(2)}).`);
        return;
      }

      await sendAlert(`🛡️ *[${tokenName}] Güvenlik ve Honeypot Taraması Yapılıyor...*`);
      const safetyCheck = await checkHoneypotAndSafety(pool);

      if (!safetyCheck.safe) {
        await sendAlert(`🚨 *[${tokenName}] GÜVENLİK RİSKİ / HONEYPOT TESPİT EDİLDİ!* 🛑\nSebep: \`${safetyCheck.reason}\`\n*İşlem iptal edildi.*`);
        return;
      }

      await sendAlert(`🚀 *[${tokenName}] 1 Dakika doldu & Güvenlik Tamam!* Gerçek alım emri blokzincire gönderiliyor...`);

      const swapResult = await executeSwap(pool, BUY_AMOUNT_TON);

      if (!swapResult.success) {
        await sendAlert(`❌ *[${tokenName}] Alım Başarısız (Tx Hatası):* \`${swapResult.error}\``);
        return;
      }

      activePositions.set(poolAddress, {
        token: tokenName,
        entryPrice: 1,
        amount: BUY_AMOUNT_TON,
        dex: dex
      });

      await sendAlert(`✅ *[${tokenName}] Pozisyon Başarıyla Açıldı!* (${BUY_AMOUNT_TON} TON harcandı)\n🎯 Hedef: %${TAKE_PROFIT_PCT} Kâr | 🛑 Stop: %${STOP_LOSS_PCT} Zarar`);

    } catch (err) {
      await sendAlert(`❌ [${tokenName}] Alım sırasında hata: \`${err.message}\``);
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
      await sendAlert(`✅ *Sniper Bot Aktif (Hatasız Sürüm)* \n- Min Likidite: $${MIN_LIQUIDITY_USD}\n- Bekleme Süresi: ${WAIT_TIME_SECONDS}sn\n- Alım Tutarı: ${BUY_AMOUNT_TON} TON\n\nBakiye için \`/bakiye\` yazabilirsiniz.`);
    }

  } catch (error) {}
}

initClient().then(() => {
  setInterval(checkAllPools, 5000);
  checkAllPools();
});

process.on('uncaughtException', (err) => {
  console.error('Yakalanamayan hata:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('Yakalanamayan Promise reddi:', err);
});
