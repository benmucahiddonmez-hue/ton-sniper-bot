const TelegramBot = require('node-telegram-bot-api');
const { TonClient, WalletContractV4, internal } = require('@ton/ton');
const { mnemonicToPrivateKey } = require('@ton/crypto');

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

// Fiyat Takibi ve TP/SL (Kar Al / Zarar Durdur)
async function monitorAndSell(tokenAddress, symbol, buyPriceUsd) {
  console.log(`${symbol} için fiyat takibi (TP/SL) başlatıldı...`);
  
  const checkInterval = setInterval(async () => {
    try {
      const res = await fetch(`https://api.ston.fi/v1/assets/${tokenAddress}`);
      const data = await res.json();
      
      if (!data || !data.asset || !data.asset.dex_price_usd) {
        return;
      }

      const currentPriceUsd = Number(data.asset.dex_price_usd);
      const priceChangePercent = ((currentPriceUsd - buyPriceUsd) / buyPriceUsd) * 100;

      console.log(`${symbol} Anlık Değişim: %${priceChangePercent.toFixed(2)}`);

      if (priceChangePercent >= TAKE_PROFIT_PERCENT || priceChangePercent <= -STOP_LOSS_PERCENT) {
        clearInterval(checkInterval);
        
        const reason = priceChangePercent >= TAKE_PROFIT_PERCENT ? '🎯 HEDEF KAR (Take Profit)' : '🛑 ZARAR DURDUR (Stop Loss)';
        await sendAlert(`${reason} tetiklendi!\n🪙 *Token:* \`${symbol}\`\n📊 *Oran:* \`%${priceChangePercent.toFixed(2)}\`\nSatış simülasyonu tamamlandı.`);
        
        console.log(`${symbol} pozisyonu kapatıldı. Sebep: ${reason}`);
      }
    } catch (err) {
      console.error(`Fiyat takip hatası (${symbol}):`, err.message);
    }
  }, 10000);
}

// Otomatik Alım Simülasyonu / Cüzdan Testi
async function executeSwap(tokenAddress, symbol) {
  if (MNEMONIC.length < 12) {
    console.log("Cüzdan mnemonic eksik, alım atlanıyor.");
    return;
  }

  try {
    const keyPair = await mnemonicToPrivateKey(MNEMONIC);
    const wallet = tonClient.open(
      WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey })
    );

    const balance
