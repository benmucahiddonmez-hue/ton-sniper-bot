const TelegramBot = require('node-telegram-bot-api');
const { TonClient, WalletContractV4 } = require('@ton/ton');
const { mnemonicToPrivateKey } = require('@ton/crypto');
const https = require('https');

const TG_TOKEN = process.env.TG_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const MNEMONIC = process.env.WALLET_MNEMONIC ? process.env.WALLET_MNEMONIC.split(' ') : [];
const MIN_LIQUIDITY_USD = Number(process.env.MIN_LIQUIDITY_USD || 50);
const BUY_AMOUNT_GRAM = Number(process.env.BUY_AMOUNT_TON || 0.5);
const TAKE_PROFIT_PERCENT = Number(process.env.TAKE_PROFIT_PERCENT || 50);
const STOP_LOSS_PERCENT = Number(process.env.STOP_LOSS_PERCENT || 30);

const bot = new TelegramBot(TG_TOKEN, { polling: false });

let knownPools = new Set();
let tonClient = null;

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

async function monitorAndSell(tokenAddress, symbol, buyPriceUsd, dexName) {
  const checkInterval = setInterval(async () => {
    try {
      const data = await httpGet(`https://api.ston.fi/v1/assets/${tokenAddress}`);
      if (!data || !data.asset || !data.asset.dex_price_usd) return;

      const currentPriceUsd = Number(data.asset.dex_price_usd);
      const priceChangePercent = ((currentPriceUsd - buyPriceUsd) / buyPriceUsd) * 100;

      if (priceChangePercent >= TAKE_PROFIT_PERCENT || priceChangePercent <= -STOP_LOSS_PERCENT) {
        clearInterval(checkInterval);
        const reason = priceChangePercent >= TAKE_PROFIT_PERCENT ? '🎯 HEDEF KAR' : '🛑 ZARAR DURDUR';
        await sendAlert(`${reason} tetiklendi!\n🏢 *Borsa:* \`${dexName}\`\n🪙 *Token:* \`${symbol}\`\n📊 *Oran:* \`%${priceChangePercent.toFixed(2)}\``);
      }
    } catch (err) {}
  }, 15000);
}

async function executeSwapWithDelay(poolAddress, tokenAddress, symbol, dexName, checkType) {
  if (MNEMONIC.length < 12) return;

  await sendAlert(`⏳ *[${dexName}] Havuz Yakalandı, Likidite Bekleniyor...*\n🪙 Hedef: \`${symbol}\``);

  let confirmedLiquidity = 0;
  for (let i = 0; i < 3; i++) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    try {
      if (checkType === 'stonfi') {
        const poolData = await httpGet(`https://api.ston.fi/v1/pools/${poolAddress}`);
        if (poolData && poolData.pool) {
          confirmedLiquidity = Number(poolData.pool.lp_total_supply_usd || 0);
          if (confirmedLiquidity >= MIN_LIQUIDITY_USD) break;
        }
      } else {
        const dedustData = await httpGet(`https://api.dedust.io/v2/pools`);
        if (Array.isArray(dedustData)) {
          const found = dedustData.find(p => p && p.address === poolAddress);
          if (found) {
            confirmedLiquidity = Number(found.reservesUsd || found.lp_total_supply_usd || 0);
            if (confirmedLiquidity >= MIN_LIQUIDITY_USD) break;
          }
        }
      }
    } catch (e) {}
  }

  if (confirmedLiquidity < MIN_LIQUIDITY_USD) {
    await sendAlert(`⚠️ *[${dexName}] Alım İptal Edildi:* ${symbol} havuzu ${MIN_LIQUIDITY_USD}$ likiditeye ulaşamadı ($${confirmedLiquidity.toFixed(2)}).`);
    return;
  }

  try {
    const keyPair = await mnemonicToPrivateKey(MNEMONIC);
    const wallet = tonClient.open(
      WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey })
    );

    const balance = await wallet.getBalance();
    const balanceGram = Number(balance) / 1e9;

    if (balanceGram < (BUY_AMOUNT_GRAM + 0.05)) {
      await sendAlert(`⚠️ *Otomatik Alım Atlandı:* Bakiye yetersiz (${balanceGram.toFixed(2)} GRAM).`);
      return;
    }

    await sendAlert(`🚀 *[${dexName}] Likidite Onaylandı, Alım Gönderiliyor!*\n🪙 Hedef: \`${symbol}\``);
    
    const initialData = await httpGet(`https://api.ston.fi/v1/assets/${tokenAddress}`);
    const basePriceUsd = initialData && initialData.asset && initialData.asset.dex_price_usd ? Number(initialData.asset.dex_price_usd) : 0.0001;

    monitorAndSell(tokenAddress, symbol, basePriceUsd, dexName);

  } catch (error) {
    await sendAlert(`❌ *Swap Hatası:* \`${error.message}\``);
  }
}

let isInitialized = false;

async function checkAllPools() {
  try {
    // 1. STON.fi Taraması
    try {
      const stonPoolsData = await httpGet('https://api.ston.fi/v1/pools');
      const stonPools = (stonPoolsData && stonPoolsData.pool_list) || [];

      // Bellek şişmesini önlemek için sadece son 100 havuzu tut
      if (stonPools.length > 0 && !isInitialized) {
        stonPools.slice(-100).forEach(p => p.address && knownPools.add(p.address));
        isInitialized = true;
        console.log(`İlk yükleme tamamlandı. Bilinen havuz: ${knownPools.size}`);
        await sendAlert(`✅ *Sniper Bot Hafifletilmiş Modda Aktif!*`);
      }

      for (const pool of stonPools.slice(-30)) { // Sadece en güncel 30 havuzu tara
        if (!pool || !pool.address) continue;
        const poolAddress = pool.address;

        if (!knownPools.has(poolAddress)) {
          knownPools.add(poolAddress);
          const token0Addr = pool.token0_address || '';
          const token1Addr = pool.token1_address || '';
          const targetToken = token0Addr.includes('EQ') ? token0Addr : token1Addr;
          
          executeSwapWithDelay(poolAddress, targetToken, 'YENI_COIN', 'STON.fi', 'stonfi');
        }
      }
    } catch (e) {}

    // 2. DeDust.io Taraması
    try {
      const dedustPools = await httpGet('https://api.dedust.io/v2/pools');
      if (Array.isArray(dedustPools)) {
        for (const pool of dedustPools.slice(-30)) { // Sadece en güncel 30 havuz
          if (!pool || !pool.address) continue;
          const poolAddress = pool.address;

          if (!knownPools.has(poolAddress)) {
            knownPools.add(poolAddress);
            executeSwapWithDelay(poolAddress, poolAddress, 'DEDUST_COIN', 'DeDust.io', 'dedust');
          }
        }
      }
    } catch (e) {}

  } catch (error) {}
}

initClient().then(() => {
  setInterval(checkAllPools, 15000);
  checkAllPools();
});

process.on('uncaughtException', () => {});
process.on('unhandledRejection', () => {});
