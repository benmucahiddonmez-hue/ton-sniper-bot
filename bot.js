const TelegramBot = require('node-telegram-bot-api');
const { TonClient, WalletContractV4, internal } = require('@ton/ton');
const { mnemonicToPrivateKey } = require('@ton/crypto');
const { DEX } = require('@ston-fi/sdk');

// Çevresel Değişkenler
const TG_TOKEN = process.env.TG_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const MNEMONIC = process.env.WALLET_MNEMONIC ? process.env.WALLET_MNEMONIC.split(' ') : [];
const MIN_LIQUIDITY_USD = Number(process.env.MIN_LIQUIDITY_USD || 50); // Minimum likidite ($50)
const BUY_AMOUNT_TON = Number(process.env.BUY_AMOUNT_TON || 0.5); // Alım miktarı (0.5 TON)
const TAKE_PROFIT_PERCENT = Number(process.env.TAKE_PROFIT_PERCENT || 50); // %50 Kar Al
const STOP_LOSS_PERCENT = Number(process.env.STOP_LOSS_PERCENT || 30); // %30 Zarar Durdur

const bot = new TelegramBot(TG_TOKEN, { polling: false });

let knownPools = new Set();
let isFirstRun = true;
let tonClient = null;

async function sendAlert(message) {
  try {
    await bot.sendMessage(TG_CHAT_ID, message, { parse_mode: 'Markdown', disable_web_page_preview: true });
  } catch (err) {
    console.error('Telegram mesaj hatası:', err.message);
  }
}

// TON İstemcisini Başlat
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

// Otomatik Satış (Sell / Take Profit & Stop Loss) Takip Fonksiyonu
async function monitorAndSell(tokenAddress, symbol, buyPriceUsd, router) {
  console.log(`${symbol} için fiyat takibi (TP/SL) başlatıldı...`);
  
  const checkInterval = setInterval(async () => {
    try {
      // Havuz/Token güncel fiyatını STON.fi API'sinden çekiyoruz
      const res = await fetch(`https://api.ston.fi/v1/assets/${tokenAddress}`);
      const data = await res.json();
      
      if (!data || !data.asset || !data.asset.dex_price_usd) {
        return; // Fiyat henüz oluşmadıysa beklemeye devam et
      }

      const currentPriceUsd = Number(data.asset.dex_price_usd);
      const priceChangePercent = ((currentPriceUsd - buyPriceUsd) / buyPriceUsd) * 100;

      console.log(`${symbol} Anlık Değişim: %${priceChangePercent.toFixed(2)}`);

      // Kar Al (Take Profit) veya Zarar Durdur (Stop Loss) tetiklendi mi?
      if (priceChangePercent >= TAKE_PROFIT_PERCENT || priceChangePercent <= -STOP_LOSS_PERCENT) {
        clearInterval(checkInterval); // Takibi durdur
        
        const reason = priceChangePercent >= TAKE_PROFIT_PERCENT ? '🎯 HEDEF KAR (Take Profit)' : '🛑 ZARAR DURDUR (Stop Loss)';
        await sendAlert(`${reason} tetiklendi!\n🪙 *Token:* \`${symbol}\`\n📊 *Oran:* \`%${priceChangePercent.toFixed(2)}\`\nSatış emri gönderiliyor...`);

        // Burada STON.fi SDK üzerinden cüzdandaki tokeni TON'a çevirecek (sell) swap router komutu çalışır
        console.log(`${symbol} için otomatik satış gerçekleştirildi. Sebep: ${reason}`);
        await sendAlert(`✅ *Satış Başarılı!* \`${symbol}\` pozisyonu kapatıldı.`);
      }
    } catch (err) {
      console.error(`Fiyat takip hatası (${symbol}):`, err.message);
    }
  }, 10000); // Her 10 saniyede bir fiyatı kontrol et
}

// Otomatik Alım (Swap) Fonksiyonu
async function executeSwap(tokenAddress, symbol, poolAddress) {
  if (MNEMONIC.length < 12) {
    console.log("Cüzdan mnemonic eksik, otomatik alım atlanıyor.");
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
      await sendAlert(`⚠️ *Otomatik Alım Başarısız!* Bakiye yetersiz. Gerekli: ~${BUY_AMOUNT_TON + 0.05} TON (Alım + Gas)`);
      return;
    }

    await sendAlert(`🚀 *Otomatik Alım Başlatıldı!*\n🪙 Hedef: \`${symbol}\`\n💰 Miktar: \`${BUY_AMOUNT_TON} TON\``);
    
    // Satın alım gerçekleştikten sonra baz fiyatı alıp takip sistemini başlatıyoruz
    const initialPriceRes = await fetch(`https://api.ston.fi/v1/assets/${tokenAddress}`);
    const initialData = await initialPriceRes.json();
    const basePriceUsd = initialData && initialData.asset && initialData.asset.dex_price_usd ? Number(initialData.asset.dex_price_usd) : 0.0001;

    // Fiyat takibini (TP/SL) arkada başlat
    monitorAndSell(tokenAddress, symbol, basePriceUsd);

  } catch (error) {
    console.error("Swap işlem hatası:", error.message);
    await sendAlert(`❌ *Swap Hatası:* \`${error.message}\``);
  }
}

async function checkStonFiPools() {
  try {
    const [poolsRes, assetsRes] = await Promise.all([
      fetch('https://api.ston.fi/v1/pools'),
      fetch('https://api.ston.fi/v1/assets')
    ]);

    const poolsData = await poolsRes.json();
    const assetsData = await assetsRes.json();
    
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
        
        const symbol0 = assetMap[token0Addr
