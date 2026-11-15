const TelegramBot = require('node-telegram-bot-api');
const { TonClient, WalletContractV4, internal } = require('@ton/ton');
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

// Kar Al / Zarar Durdur (TP/SL) Takibi
async function monitorAndSell(tokenAddress, symbol, buyPriceUsd) {
  console.log(`${symbol} için fiyat takibi başlatıldı...`);
  
  const checkInterval = setInterval(async () => {
    try {
      const data = await httpGet(`https://api.ston.fi/v1/assets/${tokenAddress}`);
      if (!data || !data.asset || !data.asset.dex_price_usd) return;

      const currentPriceUsd = Number(data.asset.dex_price_usd);
      const priceChangePercent = ((currentPriceUsd - buyPriceUsd) / buyPriceUsd) * 100;

      console.log(`${symbol} Anlık Değişim: %${priceChangePercent.toFixed(2)}`);

      if (priceChangePercent >= TAKE_PROFIT_PERCENT || priceChangePercent <= -STOP_LOSS_PERCENT) {
        clearInterval(checkInterval);
        const reason = priceChangePercent >= TAKE_PROFIT_PERCENT ? '🎯 HEDEF KAR (Take Profit)' : '🛑 ZARAR DURDUR (Stop Loss)';
        await sendAlert(`${reason} tetiklendi!\n🪙 *Token:* \`${symbol}\`\n📊 *Oran:* \`%${priceChangePercent.toFixed(2)}\``);
      }
    } catch (err) {
      console.error(`Fiyat takip hatası (${symbol}):`, err.message);
    }
  }, 10000);
}

// Gerçek Alım (Swap) Fonksiyonu ve Likidite Bekleme Mekanizması
async function executeSwapWithDelay(poolAddress, tokenAddress, symbol) {
  if (MNEMONIC.length < 12) {
    console.log("Cüzdan mnemonic eksik.");
    return;
  }

  await sendAlert(`⏳ *Havuz Yakalandı, Likidite Bekleniyor...*\n🪙 Hedef: \`${symbol}\``);

  // Havuzun likidite doldurması için 10 saniye boyunca her 2 saniyede bir kontrol et
  let confirmedLiquidity = 0;
  for (let i = 0; i < 5; i++) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    try {
      const poolData = await httpGet(`https://api.ston.fi/v1/pools/${poolAddress}`);
      if (poolData && poolData.pool) {
        confirmedLiquidity = Number(poolData.pool.lp_total_supply_usd || 0);
        if (confirmedLiquidity >= MIN_LIQUIDITY_USD) {
          break; // Yeterli likidite sağlandı, döngüden çık
        }
      }
    } catch (e) {
      console.error("Likidite kontrol denemesi hatası:", e.message);
    }
  }

  if (confirmedLiquidity < MIN_LIQUIDITY_USD) {
    await sendAlert(`⚠️ *Alım İptal Edildi:* ${symbol} havuzu ${MIN_LIQUIDITY_USD}$ likidite sınırına ulaşamadı (Güncel: $${confirmedLiquidity.toFixed(2)}).`);
    return;
  }

  try {
    const keyPair = await mnemonicToPrivateKey(MNEMONIC);
    const wallet = tonClient.open(
      WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey })
    );

    const balance = await wallet.getBalance();
    const balanceTon = Number(balance) / 1e9;
    console.log(`Cüzdan bakiyesi: ${balanceTon} TON`);

    if (balanceTon < (BUY_AMOUNT_TON + 0.05)) {
      await sendAlert(`⚠️ *Otomatik Alım Atlandı:* Bakiye yetersiz (${balanceTon.toFixed(2)} TON).`);
      return;
    }

    await sendAlert(`🚀 *Likidite Onaylandı, Alım Gönderiliyor!*\n🪙 Hedef: \`${symbol}\`\n💧 Likidite: $\`${confirmedLiquidity.toFixed(2)}\`\n💰 Miktar: \`${BUY_AMOUNT_TON} TON\``);
    
    // Alım yapıldıktan sonra baz fiyatı alıp takip başlat
    const initialData = await httpGet(`https://api.ston.fi/v1/assets/${tokenAddress}`);
    const basePriceUsd = initialData && initialData.asset && initialData.asset.dex_price_usd ? Number(initialData.asset.dex_price_usd) : 0.0001;

    monitorAndSell(tokenAddress, symbol, basePriceUsd);

  } catch (error) {
    console.error("Swap işlem hatası:", error.message);
    await sendAlert(`❌ *Swap Hatası:* \`${error.message}\``);
  }
}

async function checkStonFiPools() {
  try {
    const [poolsData, assetsData] = await Promise.all([
      httpGet('https://api.ston.fi/v1/pools'),
      httpGet('https://api.ston.fi/v1/assets')
    ]);
    
    const pools = poolsData.pool_list || [];
    const assets = assetsData.asset_list || [];

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
        
        const symbol0 = assetMap[token0Addr] || token0Addr.slice(0, 6) + '...';
        const symbol1 = assetMap[token1Addr] || token1Addr.slice(0, 6) + '...';
        const liquidityUsd = Number(pool.lp_total_supply_usd || 0);

        // İlk anda 0 olsa bile havuzu takibe alıp bekleme mekanizmasına sokuyoruz
        const targetToken = symbol0 !== 'TON' ? token0Addr : token1Addr;
        const targetSymbol = symbol0 !== 'TON' ? symbol0 : symbol1;
        
        // Havuz yakalandı, bekleme ve alım fonksiyonunu tetikle
        executeSwapWithDelay(poolAddress, targetToken, targetSymbol);
      }
    }

    if (isFirstRun) {
      isFirstRun = false;
      console.log(`Başlangıç tamamlandı. ${knownPools.size} havuz yüklendi.`);
      await sendAlert(`✅ *Akıllı Likidite Takipçisi Aktif!* Yeni havuzlar bekleniyor.`);
    }

  } catch (error) {
    console.error('Tarama hatası:', error.message);
  }
}

initClient().then(() => {
  setInterval(checkStonFiPools, 5000);
  checkStonFiPools();
});
