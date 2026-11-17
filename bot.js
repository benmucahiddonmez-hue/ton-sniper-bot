// bot.js - Dinamik TON & Gram Bakiyeli Production Sniper Botu
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { MongoClient } = require('mongodb');
const axios = require('axios');
const { Address } = require('@ton/core');
const { buy, sell, sellValueNano, buyImpactPct, getWalletJettonBalance, getCtx } = require('./trade.js');

const TOKEN = process.env.TELEGRAM_TOKEN;
const ALLOWED_USER_ID = parseInt(process.env.ALLOWED_USER_ID || "0");
const MONGODB_URI = process.env.MONGODB_URI;

// Gram master adresi (Gerekirse dinamik tarama ile de destekleniyor)
const GRAM_MASTER_ADDRESS = "EQC47093oX5Xhb0xuk2lCr2RhS8rj-vul61u4W2UH5ORmG_O";

if (!TOKEN || !ALLOWED_USER_ID) {
  console.error("HATA: TELEGRAM_TOKEN veya ALLOWED_USER_ID eksik!");
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });

let TON_PRICE_USD = 0;
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

let dbClient, positionsCollection, seenPoolsCollection;

function normalizeAddress(addr) {
  try {
    if (!addr) return "";
    return Address.parse(String(addr)).toRawString().toLowerCase();
  } catch (e) {
    return String(addr).toLowerCase().trim();
  }
}

async function updateTonPrice() {
  try {
    const response = await axios.get(
      'https://api.coingecko.com/api/v3/simple/price',
      {
        params: {
          ids: 'the-open-network',
          vs_currencies: 'usd'
        },
        timeout: 8000
      }
    );

    const price = Number(response.data?.['the-open-network']?.usd);

    if (!Number.isFinite(price) || price <= 0) {
      throw new Error("Geçersiz TON fiyatı");
    }

    TON_PRICE_USD = price;
    lastPriceUpdate = Date.now();

    console.log(`📊 Güncel TON Fiyatı (CoinGecko): $${TON_PRICE_USD}`);
    return true;
  } catch (error) {
    console.error("TON fiyat güncelleme hatası:", error.message);
    return false;
  }
}

// Cüzdan TON, Dinamik Gram Bakiye ve STON.fi Gram Fiyatı
async function getWalletAndGramStats(walletAddress) {
    let balanceTon = 0;
    let gramBalance = 0;
    let gramPriceUsd = 1.05; // Fallback

    try {
        const { client, stonApi } = await getCtx();
        
        if (TON_PRICE_USD <= 0) {
            await updateTonPrice();
        }

        // 1. TON Bakiyesi
        const balanceNano = await client.getBalance(walletAddress);
        balanceTon = Number(balanceNano) / 1e9;

        // 2. Dinamik Gram Bakiye (Cüzdan jeton envanterinden akıllı arama)
        try {
            const tonapiKey = process.env.TONAPI_KEY;
            const headers = tonapiKey ? { Authorization: `Bearer ${tonapiKey}` } : {};
            const res = await axios.get(`https://tonapi.io/v2/accounts/${walletAddress.toString()}/jettons`, { headers, timeout: 5000 });
            const balances = res.data?.balances || [];
            
            const foundGram = balances.find(j => {
                const symbol = (j.jetton?.symbol || "").toLowerCase();
                const name = (j.jetton?.name || "").toLowerCase();
                return symbol.includes("gram") || name.includes("gram");
            });

            if (foundGram) {
                const decimals = foundGram.jetton?.decimals || 9;
                gramBalance = Number(foundGram.balance) / Math.pow(10, decimals);
            } else {
                // Eğer dinamik bulunamazsa standart master adresten dene
                const rawGramBal = await getWalletJettonBalance(walletAddress, GRAM_MASTER_ADDRESS).catch(() => 0n);
                gramBalance = Number(rawGramBal) / 1e9;
            }
        } catch (e) {
            console.error("Gram bakiye çekilemedi:", e.message);
        }

        // 3. Gram Fiyatı Hesabı
        try {
            const asset = await stonApi.getAsset(GRAM_MASTER_ADDRESS);
            gramPriceUsd = Number(asset?.dexPriceUsd ?? asset?.dexUsdPrice ?? asset?.priceUsd ?? 0);

            if (gramPriceUsd <= 0) {
                const oneGramNano = 1000000000n;
                const routers = await stonApi.getRouters();
                const routerAddress = routers?.[0]?.address;
                
                if (routerAddress) {
                    const simulate = await stonApi.simulateSwap({
                        dexRouterAddress: routerAddress,
                        offerAddress: GRAM_MASTER_ADDRESS,
                        askAddress: "native",
                        units: oneGramNano.toString()
                    }).catch(() => null);

                    const askUnits = simulate?.minAskUnits || simulate?.askUnits;
                    if (askUnits && TON_PRICE_USD > 0) {
                        const priceInTon = Number(askUnits) / 1e9;
                        gramPriceUsd = priceInTon * TON_PRICE_USD;
                    }
                }
            }
        } catch (e) {
            console.error("Gram fiyat simülasyon hatası:", e.message);
        }

        if (gramPriceUsd <= 0) gramPriceUsd = 1.05;

        console.log(`[DEBUG STATS] TON: ${balanceTon}, Gram: ${gramBalance}, Gram USD: ${gramPriceUsd}`);

    } catch (err) {
        console.error("getWalletAndGramStats genel hata:", err.message);
    }

    return { balanceTon, gramBalance, gramPriceUsd };
}

// State Reconciliation (Durum Senkronizasyonu)
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
                await positionsCollection.updateOne({ tokenAddress: tokenAddr }, { $set: { rawBalance: pos.rawBalance } });
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

// STON.fi Havuz Taraması
async function fetchNewTonPools(applyFilter = true) {
  if (TON_PRICE_USD <= 0 || Date.now() - lastPriceUpdate > 120000) {
    const updated = await updateTonPrice();
    if (!updated && TON_PRICE_USD <= 0) throw new Error("Güncel TON fiyatı alınamadı.");
  }

  let allPools = [];

  try {
    const { stonApi } = await getCtx();
    const poolsList = await stonApi.getPools();
    
    const stonPools = poolsList.map(p => {
      if (p.deprecated) return null;
      
      const asset0 = p.token0Address;
      const asset1 = p.token1Address;

      const isNative0 = p.lpFee?.toString().includes("native") || asset0?.includes("native") || p.isNative0;
      const isNative1 = p.lpFee?.toString().includes("native") || asset1?.includes("native") || p.isNative1;

      const rTon = Number(isNative0 ? p.reserve0 : (isNative1 ? p.reserve1 : 0)) / 1e9;
      if (rTon <= 0) return null;

      const baseTokenAddress = isNative0 ? asset1 : asset0;
      if (!baseTokenAddress) return null;

      const reserveUsd = rTon * 2 * TON_PRICE_USD;

      return {
        address: p.address,
        dex: 'stonfi',
        name: 'TOKEN/TON',
        reserve_in_usd: reserveUsd,
        base_token_address: normalizeAddress(baseTokenAddress)
      };
    }).filter(p => p !== null && (!applyFilter || p.reserve_in_usd >= MIN_LIQUIDITY_USD));
    
    allPools.push(...stonPools);
  } catch (error) {
    console.error("STON.fi tarama hatası:", error.message);
  }

  return allPools;
}

// Genişletilmiş Güvenlik (Mint & Freeze Kalkanı)
async function checkSafetyWithSimulation(tokenAddress) {
  try {
    const tonapiKey = process.env.TONAPI_KEY;
    if (!tonapiKey) return { safe: false, reason: "TONAPI_KEY eksik." };

    const headers = { Authorization: `Bearer ${tonapiKey}` };
    const response = await axios.get(`https://tonapi.io/v2/jettons/${tokenAddress}`, { headers, timeout: 8000 });
    const data = response.data || {};

    if (data.mintable === true) return { safe: false, reason: "MINT yetkisi açık!" };
    if (data.can_freeze === true) return { safe: false, reason: "Freeze yetkisi aktif!" };

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
  await updateTonPrice();

  let initialPools = await fetchNewTonPools(false);
  for (const p of (initialPools || [])) {
    if (!seenPools[p.address]) {
      seenPools[p.address] = { status: 'old', firstSeen: Date.now(), attempts: 0 };
      await saveSeenPoolToDb(p.address, seenPools[p.address]);
    }
  }

  while (botRunning) {
    let pools = [];
    try {
      pools = await fetchNewTonPools(true);
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

      if (!tokenAddr || activePositions[tokenAddr]) continue;

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
            await bot.sendMessage(ALLOWED_USER_ID, `✅ **YEREL TON İLE ALIM ONAYLANDI (${BUY_AMOUNT} TON)!**\nToken: \`${tokenName}\``, { parse_mode: "Markdown" });
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

// /baslat Komutu
bot.onText(/\/baslat/, async (msg) => {
  if (msg.from.id !== ALLOWED_USER_ID) return;
  if (!botRunning) {
    try {
      await getCtx();
      await updateTonPrice();
      await initDatabase();

      const { wallet } = await getCtx();
      const stats = await getWalletAndGramStats(wallet.address);

      botRunning = true;
      bot.sendMessage(
        msg.chat.id, 
        `🚀 **Yerel TON Sniper Bot Başlatıldı!**\n\n` +
        `🟢 **Durum:** Aktif Çalışıyor\n` +
        `💰 **TON:** \`${stats.balanceTon.toFixed(2)}\`\n` +
        `🪙 **Gram:** \`${stats.gramBalance.toFixed(2)}\`\n` +
        `📈 **Gram Fiyatı:** \`$${stats.gramPriceUsd.toFixed(4)}\``, 
        { parse_mode: "Markdown" }
      );
      
      sniperWorker();
    } catch (e) {
      bot.sendMessage(msg.chat.id, `❌ Başlatma Hatası: \`${e.message}\``);
    }
  }
});

// /durdur Komutu
bot.onText(/\/durdur/, (msg) => {
  if (msg.from.id !== ALLOWED_USER_ID) return;
  botRunning = false;
  bot.sendMessage(msg.chat.id, "🛑 Bot durduruldu.").then(async () => {
    if (dbClient) try { await dbClient.close(); } catch (e) {}
    process.exit(0);
  });
});

// /bakiye Komutu
bot.onText(/\/bakiye/, async (msg) => {
  if (msg.from.id !== ALLOWED_USER_ID) return;
  try {
    const { wallet } = await getCtx();
    const stats = await getWalletAndGramStats(wallet.address);

    bot.sendMessage(
      msg.chat.id, 
      `💰 **Cüzdan Durumu:**\n\n` +
      `🔹 **TON:** \`${stats.balanceTon.toFixed(4)}\`\n` +
      `🔹 **Gram:** \`${stats.gramBalance.toFixed(4)}\`\n` +
      `🔹 **Gram Fiyatı:** \`$${stats.gramPriceUsd.toFixed(4)}\``, 
      { parse_mode: "Markdown" }
    );
  } catch (error) {
    bot.sendMessage(msg.chat.id, `❌ Hata: \`${error.message}\``);
  }
});

console.log("Yerel TON Sniper Bot hazır.");
