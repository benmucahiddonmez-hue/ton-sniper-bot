const TelegramBot = require('node-telegram-bot-api');
const { TonClient, WalletContractV4 } = require('@ton/ton');
const { mnemonicToPrivateKey } = require('@ton/crypto');
const https = require('https');

const TG_TOKEN = process.env.TG_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const MNEMONIC = process.env.WALLET_MNEMONIC ? process.env.WALLET_MNEMONIC.split(' ') : [];
const MIN_LIQUIDITY_USD = Number(process.env.MIN_LIQUIDITY_USD || 50);
const BUY_AMOUNT_TON = Number(process.env.BUY_AMOUNT_TON || 0.5);
const TAKE_PROFIT_PERCENT = Number(process.env.TAKE_PROFIT_PERCENT || 50);
const STOP_LOSS_PERCENT = Number(process.env.STOP_LOSS_PERCENT || 30);

const bot = new TelegramBot(TG_TOKEN, { polling: false });

let knownPools = new Set();
let isFirstRun = true;
let tonClient = null;

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', (err) => reject(err));
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
      console.error(`Fiyat takip hatası (${symbol}):`, err.message);
    }
  }, 10000);
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
      console.error("Likidite kontrol hatası:", e.message);
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
    const balanceTon = Number(balance) / 1e9;

    if (balanceTon < (BUY_AMOUNT_TON + 0.05)) {
      await sendAlert(`⚠️ *Otomatik Alım Atlandı:* Bakiye yetersiz (${balanceTon.toFixed(2)} TON).`);
      return;
    }

    await sendAlert(`🚀 *[${dexName}] Likidite Onaylandı, Alım Gönderiliyor!*\n🪙 Hedef: \`${symbol}\`\n💰 Miktar: \`${BUY_AMOUNT_TON} TON\``);
    
    const initialData = await httpGet(`https://api.ston.fi/v1/assets/${tokenAddress}`);
    const basePriceUsd = initialData && initialData.asset && initialData.asset.dex_price_usd ? Number(initialData.asset.dex_price_usd) : 0.0001;

    monitorAndSell(tokenAddress, symbol, basePriceUsd, dexName);

  } catch (error) {
    console.error("Swap işlem hatası:", error.message);
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
          const symbol1 = stonAssetMap[token1Addr] || 'COIN';

          const targetToken = symbol0 !== 'TON' ? token0Addr : token1Addr;
          const targetSymbol = symbol0 !== 'TON' ? symbol0 : symbol1;
          
          executeSwapWithDelay(poolAddress, targetToken, targetSymbol, 'STON.fi', 'stonfi');
        }
      }
    } catch (stonErr) {
      console.error("STON.fi tarama hatası:", stonErr.message);
    }

    // 2. DeDust.io Taraması (Güvenli ve Hatasız Mod)
    try {
      const dedustPools = await httpGet('https://api.dedust.io/v2/pools');
      if (Array.isArray(dedustPools)) {
        for (const pool of dedustPools) {
          if (!pool || !pool.address) continue;
          const poolAddress = pool.address;

          if (isFirstRun) {
            knownPools.add(poolAddress);
            continue;
          }

          if (!knownPools.has(poolAddress)) {
            knownPools.add(poolAddress);
            
            // DeDust sembol ayrıştırma güvenliği
            let symbol = 'DEDUST_COIN';
            let tokenAddress = poolAddress;

            try {
              if (pool.assets && Array.isArray(pool.assets)) {
                const nonTonAsset = pool.assets.find(a => a && a.symbol && a.symbol.toUpperCase() !== 'TON');
                if (nonTonAsset) {
                  symbol = nonTonAsset.symbol;
                  tokenAddress = nonTonAsset.address || poolAddress;
                }
              }
            } catch (innerErr) {
              // Varlık okuma hatası olursa varsayılan değerlerle devam et
            }

            executeSwapWithDelay(poolAddress, tokenAddress, symbol, 'DeDust.io', 'dedust');
          }
        }
      }
    } catch (dedustErr) {
      console.error("DeDust tarama hatası:", dedustErr.message);
    }

    if (isFirstRun) {
      isFirstRun = false;
      console.log(`Çift Borsalı Tarama Aktif. Toplam bilinen havuz: ${knownPools.size}`);
      await sendAlert(`✅ *Çift Borsalı (STON.fi + DeDust) Sniper Aktif ve Stabil!*`);
    }

  } catch (error) {
    console.error('Genel tarama döngü hatası:', error.message);
  }
}

initClient().then(() => {
  setInterval(checkAllPools, 10000);
  checkAllPools();
});

process.on('uncaughtException', (err) => {
  console.error('Kritik Hata Yakalandı (Çökme Engellendi):', err.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('İşlenmeyen Sözleşme Hatası (Çökme Engellendi):', reason);
});
