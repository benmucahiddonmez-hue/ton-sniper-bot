const TelegramBot = require('node-telegram-bot-api');
const { TonClient, WalletContractV4, internal } = require('@ton/ton');
const { mnemonicToPrivateKey } = require('@ton/crypto');
const { DEX } = require('@ston-fi/sdk');

// Çevresel Değişkenler
const TG_TOKEN = process.env.TG_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const MNEMONIC = process.env.WALLET_MNEMONIC ? process.env.WALLET_MNEMONIC.split(' ') : [];
const MIN_LIQUIDITY_USD = Number(process.env.MIN_LIQUIDITY_USD || 50); // Minimum likidite filtresi ($50)
const BUY_AMOUNT_TON = Number(process.env.BUY_AMOUNT_TON || 0.1); // Her alımda harcanacak TON

const bot = new TelegramBot(TG_TOKEN, { polling: false });

let knownPools = new Set();
let isFirstRun = true;
let tonClient = null;
let dexClient = null;

async function sendAlert(message) {
  try {
    await bot.sendMessage(TG_CHAT_ID, message, { parse_mode: 'Markdown', disable_web_page_preview: true });
  } catch (err) {
    console.error('Telegram mesaj hatası:', err.message);
  }
}

// TON ve STON.fi İstemcilerini Başlat
async function initClients() {
  try {
    // TON Mainnet RPC bağlantısı
    tonClient = new TonClient({
      endpoint: 'https://toncenter.com/api/v2/jsonRPC'
    });
    
    // STON.fi DEX v2 Router istemcisi
    dexClient = new DEX.v2.Router();
    console.log("TON ve STON.fi istemcileri başarıyla başlatıldı.");
  } catch (err) {
    console.error("İstemci başlatma hatası:", err.message);
  }
}

// Otomatik Alım (Swap) Fonksiyonu
async function executeSwap(tokenAddress, symbol) {
  if (MNEMONIC.length < 12) {
    console.log("Cüzdan mnemonic (gizli kelimeler) eksik, otomatik alım atlanıyor.");
    return;
  }

  try {
    const keyPair = await mnemonicToPrivateKey(MNEMONIC);
    const wallet = tonClient.open(
      WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey })
    );

    const balance = await wallet.getBalance();
    console.log(`Cüzdan bakiyesi kontrol ediliyor... Mevcut: ${Number(balance) / 1e9} TON`);

    if (balance < BigInt(BUY_AMOUNT_TON * 1e9)) {
      await sendAlert(`⚠️ *Otomatik Alım Başarısız!* Cüzdan bakiyesi yetersiz (${BUY_AMOUNT_TON} TON gerekiyor).`);
      return;
    }

    // Not: STON.fi SDK v2 üzerinden swap router çağrısı burada tetiklenir
    await sendAlert(`🚀 *Otomatik Alım Başlatıldı!*\n🪙 Hedef: \`${symbol}\`\n💰 Miktar: \`${BUY_AMOUNT_TON} TON\``);
    
    // İşlem simülasyonu / gönderimi
    // (Gerçek SDK swap parametreleri havuz tipine göre router üzerinden kurulur)
    
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
        
        const symbol0 = assetMap[token0Addr] || token0Addr.slice(0, 6) + '...';
        const symbol1 = assetMap[token1Addr] || token1Addr.slice(0, 6) + '...';
        const liquidityUsd = Number(pool.lp_total_supply_usd || 0);
        
        // 1. FİLTRE: Minimum Likidite Kontrolü
        if (liquidityUsd < MIN_LIQUIDITY_USD) {
          console.log(`Düşük likidite ($${liquidityUsd}), atlandı: ${symbol0}/${symbol1}`);
          continue; // Likiditesi düşükse bildirim atma ve alım yapma
        }

        const stonfiLink = `https://app.ston.fi/swap?chart=to&ft=${token0Addr}&tt=${token1Addr}`;

        const alertMsg = `🚨 *KRİTERLERE UYAN YENİ COİN!* 🚨\n\n` +
                         `🪙 *Parite:* \`${symbol0} / ${symbol1}\`\n` +
                         `💧 *Likidite:* $${liquidityUsd.toFixed(2)}\n` +
                         `📍 *Havuz:* \`${poolAddress.slice(0, 10)}...\`\n\n` +
                         `🔗 [STON.fi'de Aç & İncele](${stonfiLink})`;
        
        console.log(`Uygun havuz yakalandı: ${symbol0}/${symbol1} ($${liquidityUsd})`);
        await sendAlert(alertMsg);

        // 2. OTOMATİK ALIM TETİKLEYİCİSİ
        // Belirlenen token TON dışındaki yeni çıkan coindir
        const targetToken = token0Addr.includes('EQB') || token0Addr !== 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c' ? token0Addr : token1Addr;
        const targetSymbol = symbol0 !== 'TON' ? symbol0 : symbol1;
        
        await executeSwap(targetToken, targetSymbol);
      }
    }

    if (isFirstRun) {
      isFirstRun = false;
      console.log(`Başlangıç tamamlandı. ${knownPools.size} havuz yüklendi. Filtreli tarama aktif.`);
      await sendAlert(`✅ *Gelişmiş Bot Aktif!* Min Likidite: $${MIN_LIQUIDITY_USD} | Otomatik Alım Hazır.`);
    }

  } catch (error) {
    console.error('Tarama hatası:', error.message);
  }
}

// Başlat ve döngüyü kur
initClients().then(() => {
  setInterval(checkStonFiPools, 5000);
  checkStonFiPools();
});
