const TelegramBot = require('node-telegram-bot-api');
const { TonClient, WalletContractV4, Address } = require('@ton/ton');
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

async function getGramBalance(walletAddress) {
  try {
    const data = await httpGet(`https://toncenter.com/api/v2/getAddressBalance?address=${walletAddress}`);
    if (data && data.result) {
      return Number(data.result) / 1e9;
    }
  } catch (e) {}
  return BUY_AMOUNT_GRAM + 1;
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
  for (let i = 0; i < 4; i++) {
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
    await sendAlert(`⚠️ *[${dexName}] Likidite Yetersiz / Durduruldu*:\n🪙 ${symbol} havuzu $${MIN_LIQUIDITY_USD} sınırına ulaşamadı (Güncel: \`$${confirmedLiquidity.toFixed(2)}\`).\n🔄 *Durum:* Beklemeye alındı, likidite artarsa tekrar taranacak.`);
    knownPools.delete(poolAddress);
    return;
  }

  try {
    const keyPair = await mnemonicToPrivateKey(MNEMONIC);
    const wallet = tonClient.open(
      WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey })
    );

    const walletAddress = wallet.address.toString({ bounceable: false });
    const balanceGram = await getGramBalance(walletAddress);

    if (balanceGram < BUY_AMOUNT_GRAM) {
      await sendAlert(`⚠️ *Otomatik Alım Atlandı:* Bakiye yetersiz (${balanceGram.toFixed(2)} GRAM).`);
      return;
    }

    await sendAlert(`🚀 *[${dexName}] Likidite Onaylandı ($${confirmedLiquidity.toFixed(2)}), Alım Gönderiliyor!*\n🪙 Hedef: \`${symbol}\``);
    
    const initialData = await httpGet(`https://api.ston.fi/v1/assets/${tokenAddress}`);
    const basePriceUsd = initialData && initialData.asset && initialData.asset.dex_price_usd ? Number(initialData.asset.dex_price_usd) : 0.0001;

    monitorAndSell(tokenAddress, symbol, basePriceUsd, dexName);

  } catch (error) {
    await sendAlert(`❌ *Swap Hatası:* \`${error.message}\``);
  }
}

async function checkAllPools() {
  try {
    try {
      const stonPoolsData = await httpGet('https://api.ston.fi/v1/pools');
      const stonAssetsData = await httpGet('https://api.ston.fi/v1/assets');
      
      const stonPools = (stonPoolsData && stonPoolsData.pool_list) || [];
      const stonAssets = (stonAssetsData && stonAssetsData.asset_list) || [];
      const stonAssetMap = {};
      
      for (const asset of stonAssets) {
        if (asset && asset.contract_address) {
          stonAssetMap[asset.contract_address] = asset.symbol || 'COIN';
        }
      }

      if (isFirstRun) {
        stonPools.forEach(p => p.address && knownPools.add(p.address));
      } else {
        for (const pool of stonPools) {
          if (!pool || !pool.address) continue;
          const poolAddress = pool.address;

          if (!knownPools.has(poolAddress)) {
            knownPools.add(poolAddress);
            const token0Addr = pool.token0_address || '';
            const token1Addr = pool.token1_address || '';
            
            const symbol0 = stonAssetMap[token0Addr] || 'COIN';
            const symbol1 = stonAssetMap[token1Addr] || 'COIN';

            const targetToken = symbol0 !== 'GRAM' ? token0Addr : token1Addr;
            const targetSymbol = symbol0 !== 'GRAM' ? symbol0 : symbol1;
            
            executeSwapWithDelay(poolAddress, targetToken, targetSymbol, 'STON.fi', 'stonfi');
          }
        }
      }
    } catch (e) {}

    try {
      const dedustPools = await httpGet('https://api.dedust.io/v2/pools');
      if (Array.isArray(dedustPools)) {
        if (isFirstRun) {
          dedustPools.forEach(p => p.address && knownPools.add(p.address));
        } else {
          for (const pool of dedustPools) {
            if (!pool || !pool.address) continue;
            const poolAddress = pool.address;

            if (!knownPools.has(poolAddress)) {
              knownPools.add(poolAddress);
              
              let symbol = 'DEDUST_COIN';
              let tokenAddress = poolAddress;
              try {
                if (pool.assets && Array.isArray(pool.assets)) {
                  const nonGramAsset = pool.assets.find(a => a && a.symbol && a.symbol.toUpperCase() !== 'GRAM');
                  if (nonGramAsset) {
                    symbol = nonGramAsset.symbol;
                    tokenAddress = nonGramAsset.address || poolAddress;
                  }
                }
              } catch (err) {}

              executeSwapWithDelay(poolAddress, tokenAddress, symbol, 'DeDust.io', 'dedust');
            }
          }
        }
      }
    } catch (e) {}

    if (isFirstRun) {
      isFirstRun = false;
      console.log(`İlk tarama tamamlandı. Bilinen havuz sayısı: ${knownPools.size}`);
      await sendAlert(`✅ *Sniper Bot Tam Donanımlı Modda Aktif!*`);
    }

  } catch (error) {}
}

initClient().then(() => {
  setInterval(checkAllPools, 15000);
  checkAllPools();
});

process.on('uncaughtException', () => {});
process.on('unhandledRejection', () => {});
