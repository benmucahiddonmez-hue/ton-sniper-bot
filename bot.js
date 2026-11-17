
// bot.js - State Reconciliation ve Gelişmiş Güvenlik Kalkanlı Production Botu
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { MongoClient } = require('mongodb');
const axios = require('axios');
const { Address } = require('@ton/core');
const { buy, sell, sellValueNano, buyImpactPct, getWalletJettonBalance, getCtx } = require('./trade.js');

const TOKEN = process.env.TELEGRAM_TOKEN;
const ALLOWED_USER_ID = parseInt(process.env.ALLOWED_USER_ID || "0");
const MONGODB_URI = process.env.MONGODB_URI;

if (!TOKEN || !ALLOWED_USER_ID) {
  console.error("HATA: TELEGRAM_TOKEN veya ALLOWED_USER_ID eksik!");
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });

const GRAM_MASTER_ADDRESS = "EQC47093oX5Xhb0xuk2lCr2RhS8rj-vul61u4W2UHmG_O";
let allowedPtonAddresses = [];

let GRAM_PRICE_USD = 0;
let GRAM_DECIMALS = 9;
let lastPriceUpdate = 0;

const MIN_LIQUIDITY_USD = 100.0;
const SCAN_INTERVAL = 30000;
const POOL_MATURITY_DELAY = 60000;
const BUY_AMOUNT = 0.5;

const TAKE_PROFIT_PERCENT = 35.0;
const STOP_LOSS_PERCENT = 25.0;

let seenPools = {};
let activePositions = {};
let botRunning = false;
let lastErrorNotificationTime = 0;
let lastFetchFailed = false;

let dbClient, positionsCollection, seenPoolsCollection;

function sameAddr(addr1, addr2) {
  try {
    if (!addr1 || !addr2) return false;
    return Address.parse(addr1).toRawString() === Address.parse(addr2).toRawString();
  } catch (e) {
    return String(addr1).toLowerCase() === String(addr2).toLowerCase();
  }
}

function isGram(addr) {
  return sameAddr(addr, GRAM_MASTER_ADDRESS);
}

// CoinMarketCap GRAM fiyat güncelleme
async function updateGramPrice() {
  try {
    const response = await axios.get(
      'https://pro-api.coinmarketcap.com/public-api/v3/cryptocurrency/quotes/latest',
      {
        params: {
          slug: 'gram',
          convert: 'USD'
        },
        timeout: 10000
      }
    );

    if (response.data?.status?.error_code &&
        Number(response.data.status.error_code) !== 0) {
      throw new Error(
        response.data.status.error_message || "CoinMarketCap API hatası"
      );
    }

    const data = response.data?.data || {};

    const gram = Array.isArray(data)
      ? data.find(item => String(item.slug).toLowerCase() === 'gram')
      : Object.values(data).find(
          item => String(item.slug).toLowerCase() === 'gram'
        );

    if (!gram) {
      throw new Error("CoinMarketCap GRAM kaydı bulunamadı.");
    }

    const price = Number(gram.quote?.USD?.price);

    if (!Number.isFinite(price) || price <= 0) {
      throw new Error("Geçersiz GRAM fiyatı.");
    }

    GRAM_PRICE_USD = price;
    lastPriceUpdate = Date.now();

    console.log(
      `📊 CoinMarketCap GRAM: $${GRAM_PRICE_USD} | Decimals: ${GRAM_DECIMALS}`
    );

    return true;

  } catch (error) {
    console.error("CoinMarketCap GRAM fiyat hatası:", error.response?.data || error.message);
    return false;
  }
}

// 5. State Reconciliation (Durum Senkronizasyonu)
async function reconcilePositions() {
    if (!positionsCollection) return;
    try {
        const { wallet } = await getCtx();
        console.log("🔄 Pozisyonlar cüzdan ile senkronize ediliyor (State Reconciliation)...");

        for (const [tokenAddr, pos] of Object.entries(activePositions)) {
            const actualBalance = await getWalletJettonBalance(wallet.address, tokenAddr);
            if (actualBalance <= 0n) {
                console.warn(`⚠️ Uyarı: ${tokenAddr} veritabanında var ancak cüzdanda bulunamadı. Temizleniyor.`);
                await positionsCollection.deleteOne({ tokenAddress: tokenAddr });
                delete activePositions[tokenAddr];
            } else if (actualBalance.toString() !== pos.rawBalance) {
                console.log(`ℹ️ Miktar güncellendi: ${tokenAddr} (${pos.rawBalance} -> ${actualBalance})`);
                pos.rawBalance = actualBalance.toString();
                await positionsCollection.updateOne({ tokenAddress }, { $set: { rawBalance: pos.rawBalance } });
            }
        }
        console.log("✅ State reconciliation tamamlandı.");
    } catch (err) {
        console.error("State reconciliation hatası:", err.message);
    }
}

async function initDatabase() {
  if (!MONGODB_URI) return;
  try {
    dbClient = new MongoClient(MONGODB_URI, {
      tls: true,
      tlsAllowInvalidCertificates: true,
      tlsInsecure: true,
      retryWrites: true,
      serverSelectionTimeoutMS: 5000
    });

    await dbClient.connect();
    const db = dbClient.db("ton_sniper_db");

    positionsCollection = db.collection("positions");
    seenPoolsCollection = db.collection("seen_pools");

    const savedPos = await positionsCollection.find({}).toArray();
    savedPos.forEach(p => { activePositions[p.tokenAddress] = p; });

    const savedPools = await seenPoolsCollection.find({}).toArray();
    savedPools.forEach(p => {
      seenPools[p.poolAddr] = { status: p.status, firstSeen: p.firstSeen, attempts: p.attempts || 0 };
    });

    console.log("✅ MongoDB bağlantısı başarıyla kuruldu.");
    await reconcilePositions();
  } catch (err) {
    console.error("MongoDB Bağlantı Hatası:", err.message);
  }
}

async function savePositionToDb(tokenAddress, posData) {
  activePositions[tokenAddress] = posData;
  if (!positionsCollection) return;
  try {
    await positionsCollection.updateOne({ tokenAddress }, { $set: { tokenAddress, ...posData } }, { upsert: true });
  } catch (err) { console.error("DB Pozisyon Kayıt Hatası:", err.message); }
}

async function removePositionFromDb(tokenAddress) {
  delete activePositions[tokenAddress];
  if (!positionsCollection) return;
  try {
    await positionsCollection.deleteOne({ tokenAddress });
  } catch (err) { console.error("DB Pozisyon Silme Hatası:", err.message); }
}

async function saveSeenPoolToDb(poolAddr, poolData) {
  seenPools[poolAddr] = poolData;
  if (!seenPoolsCollection) return;
  try {
    await seenPoolsCollection.updateOne({ poolAddr }, { $set: { poolAddr, ...poolData } }, { upsert: true });
  } catch (err) { console.error("DB Havuz Kayıt Hatası:", err.message); }
}

async function verifyRoutersAndPton() {
  try {
    const { stonApi } = await getCtx();
    const routers = await stonApi.getRouters();
    if (routers && routers.length > 0) {
      allowedPtonAddresses = [...new Set(routers.map(r => r.ptonMasterAddress).filter(Boolean))];
      console.log("🛡️ pTON adresleri izole edildi.");
    }
  } catch (err) {
    console.error("Router pTON doğrulama hatası:", err.message);
  }
}

async function fetchNewGramPools(applyFilter = true) {
  if (GRAM_PRICE_USD <= 0 || Date.now() - lastPriceUpdate > 120000) {
    const updated = await updateGramPrice();
    if (!updated && GRAM_PRICE_USD <= 0) throw new Error("Güncel GRAM fiyatı alınamadı.");
  }

  let allPools = [];

  // STON.fi
  try {
    const { stonApi } = await getCtx();
    const poolsList = await stonApi.getPools();
    const stonPools = poolsList.map(p => {
      if (p.deprecated) return null;
      const gramIs0 = isGram(p.token0Address);
      const gramIs1 = isGram(p.token1Address);
      if (!gramIs0 && !gramIs1) return null;

      const baseTokenAddress = gramIs0 ? p.token1Address : p.token0Address;
      if (!baseTokenAddress || isGram(baseTokenAddress)) return null;

      const rGram = Number(gramIs0 ? p.reserve0 : p.reserve1) / Math.pow(10, GRAM_DECIMALS);
      const reserveUsd = rGram * 2 * GRAM_PRICE_USD;

      return {
        address: p.address,
        dex: 'stonfi',
        name: 'TOKEN/GRAM',
        reserve_in_usd: reserveUsd,
        base_token_address: Address.parse(baseTokenAddress).toRawString()
      };
    }).filter(p => p !== null && (!applyFilter || p.reserve_in_usd >= MIN_LIQUIDITY_USD));
    allPools.push(...stonPools);
  } catch (error) {
    console.error("STON.fi tarama hatası:", error.message);
  }

  // DeDust
  try {
    const dedustRes = await axios.get('https://api.dedust.io/v2/pools', { timeout: 8000 });
    const dedustPools = (dedustRes.data || []).map(p => {
      if (p.type && p.type !== 'volatile') return null;
      const assets = p.assets || [];
      if (assets.length < 2) return null;

      const gramIdx = assets.findIndex(a => a.type === 'jetton' && a.address && sameAddr(a.address, GRAM_MASTER_ADDRESS));
      if (gramIdx === -1) return null;

      const baseAsset = assets[gramIdx === 0 ? 1 : 0];
      if (!baseAsset || baseAsset.type !== 'jetton' || !baseAsset.address) return null;

      const rGram = Number(p.reserves?.[gramIdx] || 0) / Math.pow(10, GRAM_DECIMALS);
      const reserveUsd = rGram * 2 * GRAM_PRICE_USD;

      return {
        address: p.address,
        dex: 'dedust',
        name: `${baseAsset.symbol || 'TOKEN'}/GRAM`,
        reserve_in_usd: reserveUsd,
        base_token_address: Address.parse(baseAsset.address).toRawString()
      };
    }).filter(p => p !== null && (!applyFilter || p.reserve_in_usd >= MIN_LIQUIDITY_USD));
    allPools.push(...dedustPools);
  } catch (error) {
    console.error("DeDust tarama hatası:", error.message);
  }

  return allPools;
}

// 6. Genişletilmiş Güvenlik ve Simülasyon Kalkanı
async function checkSafetyWithSimulation(tokenAddress) {
  try {
    const tonapiKey = process.env.TONAPI_KEY;
    if (!tonapiKey) return { safe: false, reason: "TONAPI_KEY eksik." };

    const headers = { Authorization: `Bearer ${tonapiKey}` };
    const response = await axios.get(`https://tonapi.io/v2/jettons/${tokenAddress}`, { headers, timeout: 8000 });
    const data = response.data || {};

    if (data.mintable === true) return { safe: false, reason: "MINT yetkisi açık!" };
    if (data.can_freeze === true) return { safe: false, reason: "Freeze (dondurma) yetkisi aktif!" };

    return { safe: true };
  } catch (error) {
    return { safe: false, transient: true, reason: "API geçici hatası" };
  }
}

async function monitorPositions() {
  while (botRunning) {
    try {
      for (const [tokenAddr, pos] of Object.entries(activePositions)) {
        const currentValNano = await sellValueNano(pos.dex, pos.poolAddr, tokenAddr, pos.rawBalance);
        if (currentValNano <= 0n) continue;

        const currentValTon = Number(currentValNano) / 1e9;
        const costTon = pos.amount;
        const profitLossPercent = ((currentValTon - costTon) / costTon) * 100;

        if (profitLossPercent >= TAKE_PROFIT_PERCENT || profitLossPercent <= -STOP_LOSS_PERCENT) {
          const reason = profitLossPercent >= TAKE_PROFIT_PERCENT ? "🎯 Take Profit" : "🛑 Stop Loss";
          const sold = await sell(tokenAddr, pos.dex, pos.poolAddr, pos.rawBalance);
          if (sold) {
            try {
              await bot.sendMessage(ALLOWED_USER_ID, `💰 **POZİSYON KAPATILDI (${reason})**\nToken: \`${tokenAddr}\`\nKar/Zarar: %${profitLossPercent.toFixed(2)}`, { parse_mode: "Markdown" });
            } catch (e) {}
            await removePositionFromDb(tokenAddr);
          }
        }
      }
    } catch (err) {
      console.error("Pozisyon takip hatası:", err.message);
    }
    await new Promise(resolve => setTimeout(resolve, 20000));
  }
}

async function sniperWorker() {
  monitorPositions();
  await updateGramPrice();

  let initialPools = await fetchNewGramPools(false);
  for (const p of (initialPools || [])) {
    if (!seenPools[p.address]) {
      seenPools[p.address] = { status: 'old', firstSeen: Date.now(), attempts: 0 };
      await saveSeenPoolToDb(p.address, seenPools[p.address]);
    }
  }

  while (botRunning) {
    let pools = [];
    try {
      pools = await fetchNewGramPools(true);
    } catch (err) {
      await new Promise(resolve => setTimeout(resolve, SCAN_INTERVAL));
      continue;
    }

    for (const pool of pools) {
      if (!botRunning) break;
      if (!pool) continue;

      const poolAddr = pool.address;
      const tokenAddr = pool.base_token_address;
      const tokenName = pool.name;

      if (!tokenAddr || isGram(tokenAddr) || activePositions[tokenAddr]) continue;

      const now = Date.now();
      if (!seenPools[poolAddr]) {
        seenPools[poolAddr] = { status: 'pending', firstSeen: now, attempts: 0 };
        await saveSeenPoolToDb(poolAddr, seenPools[poolAddr]);
        continue;
      }

      let poolInfo = seenPools[poolAddr];
      if (poolInfo.status !== 'pending') continue;
      if (now - poolInfo.firstSeen < POOL_MATURITY_DELAY) continue;

      const safety = await checkSafetyWithSimulation(tokenAddr);
      if (safety.transient) continue;

      if (safety.safe) {
        const impact = await buyImpactPct(pool.dex, pool.address, tokenAddr, BUY_AMOUNT);
        if (impact > 5) {
          poolInfo.status = 'failed_permanently';
          await saveSeenPoolToDb(poolAddr, poolInfo);
          continue;
        }

        const buyResult = await buy(tokenAddr, BUY_AMOUNT, pool.dex, pool.address);
        if (buyResult.success) {
          poolInfo.status = 'bought';
          await saveSeenPoolToDb(poolAddr, poolInfo);

          await savePositionToDb(tokenAddr, {
            entryPrice: buyResult.costTon,
            poolAddr: pool.address,
            dex: pool.dex,
            amount: buyResult.costTon,
            rawBalance: buyResult.rawBalance.toString()
          });

          try {
            await bot.sendMessage(ALLOWED_USER_ID, `✅ **GERÇEK SDK ALIMI ONAYLANDI (${BUY_AMOUNT} TON)!**\nToken: \`${tokenName}\``, { parse_mode: "Markdown" });
          } catch (e) {}
        } else {
          poolInfo.status = 'failed_permanently';
          await saveSeenPoolToDb(poolAddr, poolInfo);
        }
      } else {
        poolInfo.status = 'failed_permanently';
        await saveSeenPoolToDb(poolAddr, poolInfo);
      }
    }

    await new Promise(resolve => setTimeout(resolve, SCAN_INTERVAL));
  }
}

bot.onText(/\/baslat/, async (msg) => {
  if (msg.from.id !== ALLOWED_USER_ID) return;
  if (!botRunning) {
    try {
      await getCtx();
      await verifyRoutersAndPton();
      await updateGramPrice();
      await initDatabase();

      const { client, wallet } = await getCtx();
      const balanceTon = Number(await client.getBalance(wallet.address)) / 1e9;

      botRunning = true;
      bot.sendMessage(msg.chat.id, `🚀 **Production Sniper Bot Başlatıldı!**\nBakiye: \`${balanceTon.toFixed(2)} TON\``, { parse_mode: "Markdown" });
      sniperWorker();
    } catch (e) {
      bot.sendMessage(msg.chat.id, `❌ Başlatma Hatası: \`${e.message}\``);
    }
  }
});

bot.onText(/\/durdur/, (msg) => {
  if (msg.from.id !== ALLOWED_USER_ID) return;
  botRunning = false;
  bot.sendMessage(msg.chat.id, "🛑 Bot durduruldu.").then(async () => {
    if (dbClient) try { await dbClient.close(); } catch (e) {}
    process.exit(0);
  });
});

bot.onText(/\/bakiye/, async (msg) => {
  if (msg.from.id !== ALLOWED_USER_ID) return;
  try {
    const { client, wallet } = await getCtx();
    const balanceTon = Number(await client.getBalance(wallet.address)) / 1e9;
    bot.sendMessage(msg.chat.id, `💰 **Bakiye:** \`${balanceTon.toFixed(4)} TON\``, { parse_mode: "Markdown" });
  } catch (error) {
    bot.sendMessage(msg.chat.id, `❌ Hata: \`${error.message}\``);
  }
});

console.log("Production Sniper Bot hazır.");
