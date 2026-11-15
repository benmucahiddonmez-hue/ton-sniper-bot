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
let isFirstRun = true;
let tonClient = null;

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 7000 }, (res) => {
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
      reject(new Error('API İstek Zaman Aşımı'));
    });
  });
}

async function sendAlert(message) {
  try {
    await bot.sendMessage(TG_CHAT_ID, message, { parse_mode: 'Markdown', disable_web_page_preview: true });
  } catch (err) {
    console.error('Telegram mesaj hatası:', err.message);
  }
}

async function initClient() {
  try {
    tonClient = new TonClient({
      endpoint: 'https://toncenter.com/api/v2/jsonRPC'
    });
    console.log("TON istemcisi başarıyla başlatıldı.");
  } catch (err) {
    console.error("İstemci başlatma hatası:", err.message);
  }
}

async function monitorAndSell(tokenAddress, symbol, buyPriceUsd, dexName) {
  console.log(`${dexName} - ${symbol} için fiyat takibi başlatıldı...`);
  
  const checkInterval = setInterval(async () => {
    try {
      const data = await httpGet(`https://api.ston.fi/v1/assets/${tokenAddress}`);
      if (!data || !data.asset || !data.asset.dex_price_usd) return;

      const currentPriceUsd = Number(data.asset.dex_price_usd);
      const priceChangePercent = ((currentPriceUsd - buyPriceUsd) / buyPriceUsd) * 100;

      if (priceChangePercent >= TAKE_PROFIT_PERCENT || priceChangePercent <= -STOP_LOSS_PERCENT) {
        clearInterval(checkInterval);
        const reason = priceChangePercent >= TAKE_PROFIT_PERCENT ? '🎯 HEDEF KAR (Take Profit)' : '🛑 ZARAR DURDUR (Stop Loss)';
        await sendAlert(`${reason} tetiklendi!\n🏢 *Borsa:* \`${dexName}\`\n🪙 *Token:* \`${symbol}\`\n📊 *Oran:* \`%${priceChangePercent.toFixed(2)}\``);
      }
    } catch (err) {
      // Fiyat takip hatalarını yut, çökmesin
    }
  }, 12000);
}

async function executeSwapWithDelay(poolAddress, tokenAddress, symbol, dexName, checkType) {
  if (MNEMONIC.length < 12) return;

  await sendAlert(`⏳ *[${dexName}] Havuz Yakalandı, Likidite Bekleniyor...*\n🪙 Hedef: \`${symbol}\``);

  let confirmedLiquidity = 0;
  for (let i = 0; i < 5; i++) {
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
    } catch (e) {
      // Kontrol aşamasındaki hatalar atlanır
    }
  }

  if (confirmedLiquidity < MIN_LIQUIDITY_USD) {
    await sendAlert(`⚠️ *[${dexName}] Alım İptal Edildi:* ${symbol} havuzu ${MIN_LIQUIDITY_USD}$ likidite sınırına ulaşamadı (Güncel: $${confirmedLiquidity.toFixed(2)}).`);
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

    await sendAlert(`🚀 *[${dexName}] Likidite Onaylandı, Alım Gönderiliyor!*\n🪙 Hedef: \`${symbol}\`\n💰 Miktar: \`${BUY_AMOUNT_GRAM} GRAM\``);
    
    const initialData = await httpGet(`https://api.ston.fi/v1/assets/${tokenAddress}`);
    const basePriceUsd = initialData && initialData.asset && initialData.asset.dex_price_usd ? Number(initialData.asset.dex_price_usd) : 0.0001;

    monitorAndSell(tokenAddress, symbol, basePriceUsd, dexName);

  } catch (error) {
    await sendAlert(`❌ *Swap Hatası:* \`${error.message}\``);
  }
}

async function checkAllPools() {
  try {
    // 1. STON.fi Taraması
    try {
      const stonPoolsData = await httpGet('https://api.ston.fi/v1/pools');
      const stonAssetsData = await httpGet('https://api.ston.fi/v1/assets');
      
      const stonPools = (stonPoolsData && stonPoolsData.pool_list) || [];
      const stonAssets = (stonAssetsData && stonAssetsData.asset_list) || [];
      const stonAssetMap = {};
      
      for (const asset of stonAssets) {
        if (asset && asset.contract_address) {
          stonAssetMap[asset.contract_address] = asset.symbol || 'Bilinmiyor';
        }
      }

      for (const pool of stonPools) {
        if (!pool || !pool.address) continue;
        const poolAddress = pool.address;

        if (isFirstRun) {
          knownPools.add(poolAddress);
          continue;
        }

        if (!knownPools.has(poolAddress)) {
          knownPools.add(poolAddress);
          const token0Addr = pool.token0_address || '';
          const token1Addr = pool.token1_address || '';
          const symbol0 = stonAssetMap[token0Addr] || 'COIN';
          const symbol1 = ston
