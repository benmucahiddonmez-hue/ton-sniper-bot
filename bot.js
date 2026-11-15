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

// Güvenli HTTP GET isteği fonksiyonu (çökmeleri önler)
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
        const reason = priceChangePercent >= TAKE_PROFIT_PERCENT ? '🎯 HEDEF KAR' : '🛑 ZARAR DURDUR';
        await sendAlert(`${reason} tetiklendi!\n🪙 *Token:* \`${symbol}\`\n📊 *Oran:* \`%${priceChangePercent.toFixed(2)}\``);
      }
    } catch (err) {
      console.error(`Fiyat takip hatası (${symbol}):`, err.message);
    }
  }, 10000);
}

async function executeSwap(tokenAddress, symbol) {
  if (MNEMONIC.length < 12) {
    console.log("Cüzdan mnemonic eksik.");
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
      await sendAlert(`⚠️ *Alım Atlandı:* Bakiye yetersiz (${balanceTon.toFixed(2)} TON).`);
      return;
    }

    await sendAlert(`🚀 *Otomatik Alım Başlatıldı!*\n🪙 Hedef: \`${symbol}\`\n💰 Miktar: \`${BUY_AMOUNT_TON} TON\``);
    
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
        
        if (liquidityUsd < MIN_LIQUIDITY_USD) {
          continue;
        }

        const stonfiLink = `https://app.ston.fi/swap?chart=to&ft=${token0Addr}&tt=${token1Addr}`;
        const alertMsg = `🚨 *YENİ COİN!* 🪙 \`${symbol0} / ${symbol1}\`\n💧 *Likidite:* $\`${liquidityUsd.toFixed(2)}\`\n🔗 [Aç](${stonfiLink})`;
        
        await sendAlert(alertMsg);

        const targetToken = symbol0 !== 'TON' ? token0Addr : token1Addr;
        const targetSymbol = symbol0 !== 'TON' ? symbol0 : symbol1;
        
        await executeSwap(targetToken, targetSymbol);
      }
    }

    if (isFirstRun) {
      isFirstRun = false;
      console.log(`Başlangıç tamamlandı. ${knownPools.size} havuz yüklendi.`);
      await sendAlert(`✅ *Bot Stabil Sürüme Geçti ve Aktif!*`);
    }

  } catch (error) {
    console.error('Tarama hatası:', error.message);
  }
}

initClient().then(() => {
  setInterval(checkStonFiPools, 5000);
  checkStonFiPools();
});
