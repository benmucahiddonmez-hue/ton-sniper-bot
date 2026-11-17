
// bot.js - GRAM Fiyat ve Havuz Tespiti Düzenlenmiş Sürüm
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { MongoClient } = require('mongodb');
const axios = require('axios');
const { Address } = require('@ton/core');
const { buy, sell, sellValueNano, buyImpactPct, getCtx } = require('./trade.js');

const TOKEN = process.env.TELEGRAM_TOKEN;
const ALLOWED_USER_ID = parseInt(process.env.ALLOWED_USER_ID || "0");
const MONGODB_URI = process.env.MONGODB_URI;

if (!TOKEN || !ALLOWED_USER_ID) {
  console.error("HATA: TELEGRAM_TOKEN veya ALLOWED_USER_ID eksik!");
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });

// GRAM Jetton Master adresi
const GRAM_MASTER_ADDRESS = "EQC47093oX5Xhb0xuk2lCr2RhS8rj-vul61u4W2UH5ORmG_O";

// pTON adresleri GRAM adreslerinden ayrı tutulur.
let allowedPtonAddresses = [];

// GRAM fiyat ve token bilgileri
let GRAM_PRICE_USD = 0;
let GRAM_DECIMALS = 9;
let lastPriceUpdate = 0;

// Fiyat ve Zaman Aşımı Değişkenleri
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

// Yalnızca gerçek GRAM Master adresi GRAM kabul edilir.
function isGram(addr) {
  return sameAddr(addr, GRAM_MASTER_ADDRESS);
}

// GRAM fiyatını STON.fi varlık bilgisinden alır.
// TON fiyatı GRAM fiyatı olarak kullanılmaz.
async function updateGramPrice() {
  try {
    const { stonApi } = await getCtx();

    const asset = await stonApi.getAsset(GRAM_MASTER_ADDRESS);

    if (!asset) {
      throw new Error("GRAM varlığı STON.fi üzerinde bulunamadı.");
    }

    const price = Number(
      asset.dexPriceUsd ??
      asset.dexUsdPrice ??
      asset.dex_price_usd ??
      asset.dex_usd_price
    );

    const decimals = Number(asset.decimals);

    if (!Number.isFinite(price) || price <= 0) {
      throw new Error("STON.fi GRAM USD fiyatı geçersiz veya bulunamadı.");
    }

    if (Number.isInteger(decimals) && decimals >= 0 && decimals <= 30) {
      GRAM_DECIMALS = decimals;
    }

    GRAM_PRICE_USD = price;
    lastPriceUpdate = Date.now();

    console.log(
      `📊 Güncel GRAM Fiyatı: $${GRAM_PRICE_USD} | Decimals: ${GRAM_DECIMALS}`
    );

    return true;
  } catch (error) {
    console.error("GRAM fiyat güncelleme hatası:", error.message);
    return false;
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
      seenPools[p.poolAddr] = {
        status: p.status,
        firstSeen: p.firstSeen,
        attempts: p.attempts || 0
      };
    });

    console.log("✅ MongoDB bağlantısı başarıyla kuruldu.");
  } catch (err) {
    console.error("MongoDB Bağlantı Hatası:", err.message);
  }
}

async function savePositionToDb(tokenAddress, posData) {
  activePositions[tokenAddress] = posData;
  if (!positionsCollection) return;
  try {
    await positionsCollection.updateOne(
      { tokenAddress },
      { $set: { tokenAddress, ...posData } },
      { upsert: true }
    );
  } catch (err) {
    console.error("DB Pozisyon Kayıt Hatası:", err.message);
  }
}

async function removePositionFromDb(tokenAddress) {
  delete activePositions[tokenAddress];
  if (!positionsCollection) return;
  try {
    await positionsCollection.deleteOne({ tokenAddress });
  } catch (err) {
    console.error("DB Pozisyon Silme Hatası:", err.message);
  }
}

async function saveSeenPoolToDb(poolAddr, poolData) {
  seenPools[poolAddr] = poolData;
  if (!seenPoolsCollection) return;
  try {
    await seenPoolsCollection.updateOne(
      { poolAddr },
      { $set: { poolAddr, ...poolData } },
      { upsert: true }
    );
  } catch (err) {
    console.error("DB Havuz Kayıt Hatası:", err.message);
  }
}

// Router'lardan pTON adreslerini alır.
// pTON adresleri GRAM listesine eklenmez.
async function verifyRoutersAndPton() {
  try {
    const { stonApi } = await getCtx();
    const routers = await stonApi.getRouters();

    if (routers && routers.length > 0) {
      const fetchedPtons = routers
        .map(r => r.ptonMasterAddress)
        .filter(Boolean);

      allowedPtonAddresses = [
        ...new Set(fetchedPtons.map(a => {
          try {
            return Address.parse(a).toRawString();
          } catch (e) {
            return a;
          }
        }))
      ];

      console.log("🛡️ Doğrulanmış pTON adresleri:", allowedPtonAddresses);
      console.log("🪙 GRAM Master adresi:", GRAM_MASTER_ADDRESS);
    }
  } catch (err) {
    console.error("Router pTON doğrulama hatası:", err.message);
  }
}

async function fetchNewGramPools(applyFilter = true) {
  // GRAM fiyatı 120 saniyeden eskiyse yenilenir.
  if (GRAM_PRICE_USD <= 0 || Date.now() - lastPriceUpdate > 120000) {
    const updated = await updateGramPrice();

    if (!updated && GRAM_PRICE_USD <= 0) {
      throw new Error("Güncel GRAM fiyatı alınamadı.");
    }
  }

  lastFetchFailed = false;
  let allPools = [];

  // STON.fi havuzları
  try {
    const { stonApi } = await getCtx();
    const poolsList = await stonApi.getPools();

    const stonPools = poolsList.map(p => {
      if (p.deprecated) return null;

      const asset0 = p.token0Address;
      const asset1 = p.token1Address;

      const gramIs0 = isGram(asset0);
      const gramIs1 = isGram(asset1);

      if (!gramIs0 && !gramIs1) return null;

      const baseTokenAddress = gramIs0 ? asset1 : asset0;

      if (!baseTokenAddress || isGram(baseTokenAddress)) return null;

      const rawReserve = gramIs0 ? p.reserve0 : p.reserve1;
      const rGram = Number(rawReserve || 0) / Math.pow(10, GRAM_DECIMALS);

      if (!Number.isFinite(rGram) || rGram <= 0) return null;

      // GRAM rezervinin USD karşılığından yaklaşık havuz likiditesi.
      const reserveUsd = rGram * 2 * GRAM_PRICE_USD;

      let normalizedBaseAddress;
      try {
        normalizedBaseAddress = Address.parse(baseTokenAddress).toRawString();
      } catch (e) {
        return null;
      }

      return {
        address: p.address,
        dex: 'stonfi',
        name: 'TOKEN/GRAM',
        reserve_in_usd: reserveUsd,
        base_token_address: normalizedBaseAddress
      };
    }).filter(p =>
      p !== null &&
      (!applyFilter || p.reserve_in_usd >= MIN_LIQUIDITY_USD)
    );

    allPools.push(...stonPools);

    console.log(`🔎 STON.fi: ${stonPools.length} GRAM havuzu bulundu.`);
  } catch (error) {
    console.error("STON.fi havuz tarama hatası:", error.message);
    lastFetchFailed = true;
  }

  // DeDust havuzları
  try {
    const dedustRes = await axios.get(
      'https://api.dedust.io/v2/pools',
      { timeout: 8000 }
    );

    const dedustPools = (dedustRes.data || []).map(p => {
      if (p.type && p.type !== 'volatile') return null;

      const assets = p.assets || [];
      if (assets.length < 2) return null;

      // DeDust üzerinde GRAM Jetton adresini ara.
      const gramIdx = assets.findIndex(a =>
        a.type === 'jetton' &&
        a.address &&
        sameAddr(a.address, GRAM_MASTER_ADDRESS)
      );

      if (gramIdx === -1) return null;

      // Diğer havuz varlığı alınacak token olarak değerlendirilir.
      const baseIdx = gramIdx === 0 ? 1 : 0;
      const baseAsset = assets[baseIdx];

      // Native varlık için bu kodun mevcut token-address akışı kullanılamaz.
      if (!baseAsset || baseAsset.type !== 'jetton' || !baseAsset.address) {
        return null;
      }

      const rawReserve = p.reserves?.[gramIdx];
      const rGram = Number(rawReserve || 0) / Math.pow(10, GRAM_DECIMALS);

      if (!Number.isFinite(rGram) || rGram <= 0) return null;

      const reserveUsd = rGram * 2 * GRAM_PRICE_USD;

      let normalizedBaseAddress;
      try {
        normalizedBaseAddress = Address.parse(baseAsset.address).toRawString();
      } catch (e) {
        return null;
      }

      return {
        address: p.address,
        dex: 'dedust',
        name: `${baseAsset.symbol || 'TOKEN'}/GRAM`,
        reserve_in_usd: reserveUsd,
        base_token_address: normalizedBaseAddress
      };
    }).filter(p =>
      p !== null &&
      (!applyFilter || p.reserve_in_usd >= MIN_LIQUIDITY_USD)
    );

    allPools.push(...dedustPools);

    console.log(`🔎 DeDust: ${dedustPools.length} GRAM havuzu bulundu.`);
  } catch (error) {
    console.error("DeDust havuz tarama hatası:", error.message);
    lastFetchFailed = true;
  }

  return allPools;
}

async function checkSafetyWithSimulation(tokenAddress) {
  try {
    const tonapiKey = process.env.TONAPI_KEY;
    if (!tonapiKey) {
      return { safe: false, reason: "TONAPI_KEY eksik." };
    }

    const headers = { Authorization: `Bearer ${tonapiKey}` };
    const response = await axios.get(
      `https://tonapi.io/v2/jettons/${tokenAddress}`,
      { headers, timeout: 8000 }
    );

    const data = response.data || {};

    if (data.mintable === true) {
      return { safe: false, reason: "MINT yetkisi açık!" };
    }

    return { safe: true };
  } catch (error) {
    return {
      safe: false,
      transient: true,
      reason: "API geçici hatası / Rate limit"
    };
  }
}

async function monitorPositions() {
  while (botRunning) {
    try {
      for (const [tokenAddr, pos] of Object.entries(activePositions)) {
        const currentValNano = await sellValueNano(
          pos.dex,
          pos.poolAddr,
          tokenAddr,
          pos.rawBalance
        );

        if (currentValNano <= 0n) {
          pos.failCount = (pos.failCount || 0) + 1;

          if (pos.failCount === 5) {
            try {
              await bot.sendMessage(
                ALLOWED_USER_ID,
                `⚠️ **DİKKAT:** \`${tokenAddr}\` için değer alınamıyor (Fail: 5)! Lütfen elle kontrol et.`
              );
            } catch (e) {}
          }
          continue;
        }

        pos.failCount = 0;

        const currentValTon = Number(currentValNano) / 1e9;
        const costTon = pos.amount;
        const profitLossPercent =
          ((currentValTon - costTon) / costTon) * 100;

        if (
          profitLossPercent >= TAKE_PROFIT_PERCENT ||
          profitLossPercent <= -STOP_LOSS_PERCENT
        ) {
          const reason = profitLossPercent >= TAKE_PROFIT_PERCENT
            ? "🎯 Take Profit"
            : "🛑 Stop Loss";

          const sold = await sell(
            tokenAddr,
            pos.dex,
            pos.poolAddr,
            pos.rawBalance
          );

          if (sold) {
            try {
              await bot.sendMessage(
                ALLOWED_USER_ID,
                `💰 **POZİSYON KAPATILDI (${reason})**\nToken: \`${tokenAddr}\`\nKar/Zarar: %${profitLossPercent.toFixed(2)}`,
                { parse_mode: "Markdown" }
              );
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

  let initialPools;

  do {
    lastFetchFailed = false;

    try {
      initialPools = await fetchNewGramPools(false);

      if (lastFetchFailed) {
        await new Promise(r => setTimeout(r, 5000));
      }
    } catch (e) {
      lastFetchFailed = true;
      await new Promise(r => setTimeout(r, 5000));
    }
  } while (lastFetchFailed && botRunning);

  if (initialPools) {
    for (const p of initialPools) {
      if (!seenPools[p.address]) {
        seenPools[p.address] = {
          status: 'old',
          firstSeen: Date.now(),
          attempts: 0
        };

        await saveSeenPoolToDb(p.address, seenPools[p.address]);
      }
    }

    console.log(
      `🛡️ İlk tarama tamamlandı. ${initialPools.length} mevcut havuz 'old' olarak işaretlendi.`
    );
  }

  while (botRunning) {
    let pools = [];

    try {
      pools = await fetchNewGramPools(true);
    } catch (err) {
      console.error("Havuz tarama döngü hatası:", err.message);
      await new Promise(resolve => setTimeout(resolve, SCAN_INTERVAL));
      continue;
    }

    for (const pool of pools) {
      if (!botRunning) break;
      if (!pool) continue;

      const poolAddr = pool.address;
      const tokenAddr = pool.base_token_address;
      const tokenName = pool.name;

      if (!tokenAddr || isGram(tokenAddr) || activePositions[tokenAddr]) {
        continue;
      }

      const now = Date.now();

      if (!seenPools[poolAddr]) {
        seenPools[poolAddr] = {
          status: 'pending',
          firstSeen: now,
          attempts: 0
        };

        await saveSeenPoolToDb(poolAddr, seenPools[poolAddr]);
        continue;
      }

      let poolInfo = seenPools[poolAddr];

      if (
        poolInfo.status === 'old' ||
        poolInfo.status === 'bought' ||
        poolInfo.status === 'failed_permanently'
      ) {
        continue;
      }

      if (now - poolInfo.firstSeen < POOL_MATURITY_DELAY) continue;

      const safety = await checkSafetyWithSimulation(tokenAddr);

      if (safety.transient) continue;

      if (safety.safe) {
        let impact;

        try {
          impact = await buyImpactPct(
            pool.dex,
            pool.address,
            tokenAddr,
            BUY_AMOUNT
          );
        } catch (e) {
          continue;
        }

        if (impact > 5) {
          poolInfo.status = 'failed_permanently';
          await saveSeenPoolToDb(poolAddr, poolInfo);
          continue;
        }

        const buyResult = await buy(
          tokenAddr,
          BUY_AMOUNT,
          pool.dex,
          pool.address
        );

        if (buyResult.success) {
          poolInfo.status = 'bought';
          await saveSeenPoolToDb(poolAddr, poolInfo);

          await savePositionToDb(tokenAddr, {
            entryPrice: buyResult.costTon,
            poolAddr: pool.address,
            dex: pool.dex,
            amount: buyResult.costTon,
            rawBalance: buyResult.rawBalance
          });

          try {
            await bot.sendMessage(
              ALLOWED_USER_ID,
              `✅ **SDK ALIMI ONAYLANDI (${BUY_AMOUNT} TON)!**\nToken: \`${tokenName}\``,
              { parse_mode: "Markdown" }
            );
          } catch (e) {}
        } else {
          if (buyResult.unconfirmed) {
            poolInfo.status = 'failed_permanently';
            await saveSeenPoolToDb(poolAddr, poolInfo);

            try {
              await bot.sendMessage(
                ALLOWED_USER_ID,
                `⚠️ **KRİTİK: UNCONFIRMED ALIM!**\nToken: \`${tokenName}\` havuzu kilitlendi. Cüzdanını kontrol edip token varsa **elle sat**!`,
                { parse_mode: "Markdown" }
              );
            } catch (e) {}
          } else {
            poolInfo.attempts = (poolInfo.attempts || 0) + 1;

            if (poolInfo.attempts >= 3) {
              poolInfo.status = 'failed_permanently';
            }

            await saveSeenPoolToDb(poolAddr, poolInfo);

            if (now - lastErrorNotificationTime > 180000) {
              lastErrorNotificationTime = now;

              try {
                await bot.sendMessage(
                  ALLOWED_USER_ID,
                  `❌ **ALIM BAŞARISIZ (${tokenName})**\nSebep: \`${buyResult.error}\``,
                  { parse_mode: "Markdown" }
                );
              } catch (e) {}
            }
          }
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
      const balanceTon = Number(
        await client.getBalance(wallet.address)
      ) / 1e9;

      console.log(`💰 Cüzdan Adresi: ${wallet.address.toString()}`);
      console.log(`💰 Cüzdan Bakiyesi: ${balanceTon} TON`);

      console.log("🛡️ pTON Adresleri:", allowedPtonAddresses);
      console.log("🪙 GRAM Master:", GRAM_MASTER_ADDRESS);
      console.log("🪙 GRAM Fiyatı:", GRAM_PRICE_USD);

      botRunning = true;

      bot.sendMessage(
        msg.chat.id,
        `🚀 **Sniper Bot Başlatıldı!**\nCüzdan: \`${wallet.address.toString()}\`\nBakiye: \`${balanceTon.toFixed(2)} TON\``,
        { parse_mode: "Markdown" }
      );

      sniperWorker();
    } catch (e) {
      bot.sendMessage(
        msg.chat.id,
        `❌ Başlatma Hatası: \`${e.message}\``,
        { parse_mode: "Markdown" }
      );
    }
  } else {
    bot.sendMessage(msg.chat.id, "⚠️ Bot zaten çalışıyor.");
  }
});

bot.onText(/\/durdur/, (msg) => {
  if (msg.from.id !== ALLOWED_USER_ID) return;

  botRunning = false;

  bot.sendMessage(
    msg.chat.id,
    "🛑 Bot durduruldu ve sunucu kapatılıyor.",
    { parse_mode: "Markdown" }
  ).then(async () => {
    if (dbClient) {
      try {
        await dbClient.close();
      } catch (e) {}
    }

    process.exit(0);
  });
});

bot.onText(/\/durum/, (msg) => {
  if (msg.from.id !== ALLOWED_USER_ID) return;

  bot.sendMessage(
    msg.chat.id,
    `📊 Bot Durumu: ${botRunning ? 'Aktif 🟢' : 'Durduruldu 🔴'}\nAçık Pozisyon: ${Object.keys(activePositions).length}`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/bakiye/, async (msg) => {
  if (msg.from.id !== ALLOWED_USER_ID) return;

  try {
    const { client, wallet } = await getCtx();
    const balanceTon = Number(
      await client.getBalance(wallet.address)
    ) / 1e9;

    bot.sendMessage(
      msg.chat.id,
      `💰 **Bakiye:** \`${balanceTon.toFixed(4)} TON\``,
      { parse_mode: "Markdown" }
    );
  } catch (error) {
    bot.sendMessage(
      msg.chat.id,
      `❌ Hata: \`${error.message}\``,
      { parse_mode: "Markdown" }
    );
  }
});

console.log("Canlıya hazır Sniper Bot başlatılmaya hazır...");

process.on('uncaughtException', (err) => {
  console.error("Kritik Hata (Uncaught Exception):", err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error("Yakalanamayan Promise Reddi:", reason);
});
