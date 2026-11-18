// bot.js - STON.fi & DeDust Çift Motorlu Aktif Sniper Bot
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { MongoClient } = require('mongodb');
const axios = require('axios');
const { Address } = require('@ton/core');
const { pTON } = require('@ston-fi/sdk');
const { buy, sell, sellValueNano, buyImpactPct, getWalletJettonBalance, getCtx, buyDedust, sellDedust } = require('./trade.js');

const TOKEN = process.env.TELEGRAM_TOKEN;
const ALLOWED_USER_ID = parseInt(process.env.ALLOWED_USER_ID || "0");
const MONGODB_URI = process.env.MONGODB_URI;

if (!TOKEN || !ALLOWED_USER_ID) {
  console.error("HATA: TELEGRAM_TOKEN veya ALLOWED_USER_ID eksik!");
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });

let TON_PRICE_USD = 0;
let lastPriceUpdate = 0;

const MIN_LIQUIDITY_USD = 40.0;
const SCAN_INTERVAL = 30000;
const POOL_MATURITY_DELAY = 10000; // Test için 10 saniyeye düşürüldü
const BUY_AMOUNT = 0.5;

const TAKE_PROFIT_PERCENT = 35.0;
const STOP_LOSS_PERCENT = 25.0;

let seenPools = {};
let activePositions = {};
let botRunning = false;

let dbClient, positionsCollection, seenPoolsCollection;

const PTON_SET = new Set();
for (const v of ['v2', 'v2_1', 'v1']) {
  try { 
    PTON_SET.add(Address.parse(String(new pTON[v]().address)).toRawString().toLowerCase()); 
  } catch (e) {}
}

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
        params: { ids: 'the-open-network', vs_currencies: 'usd' },
        timeout: 8000
      }
    );
    const price = Number(response.data?.['the-open-network']?.usd);
    if (!Number.isFinite(price) || price <= 0) throw new Error("Geçersiz fiyat");
    TON_PRICE_USD = price;
    lastPriceUpdate = Date.now();
    return true;
  } catch (error) {
    console.error("⚠️ Fiyat Güncelleme Hatası:", error.message);
    if (TON_PRICE_USD <= 0) TON_PRICE_USD = 5.0;
    return false;
  }
}

async function getWalletAndStats(walletAddress) {
    let balanceGram = 0;
    try {
        const { client } = await getCtx();
        if (TON_PRICE_USD <= 0) await updateTonPrice();
        const balanceNano = await client.getBalance(walletAddress);
        balanceGram = Number(balanceNano) / 1e9;
    } catch (err) {
        console.error("⚠️ Cüzdan Stats Hatası:", err.message);
    }
    return { balanceGram, priceUsd: TON_PRICE_USD };
}

async function reconcilePositions() {
    if (!positionsCollection) return;
    try {
        const { wallet } = await getCtx();
        for (const [tokenAddr, pos] of Object.entries(activePositions)) {
            const actualBalance = await getWalletJettonBalance(wallet.address, tokenAddr);
            if (actualBalance <= 0n) {
                await positionsCollection.deleteOne({ tokenAddress: tokenAddr });
                delete activePositions[tokenAddr];
            } else if (actualBalance.toString() !== pos.rawBalance) {
                pos.rawBalance = actualBalance.toString();
                await positionsCollection.updateOne({ tokenAddress: tokenAddr }, { $set: { rawBalance: pos.rawBalance } });
            }
        }
    } catch (err) {
        console.error("⚠️ Pozisyon Eşitleme Hatası:", err.message);
    }
}

async function initDatabase() {
  if (!MONGODB_URI || dbClient) return;
  try {
    dbClient = new MongoClient(MONGODB_URI, {
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

    await reconcilePositions();
    console.log("🗄️ MongoDB bağlantısı ve veri senkronizasyonu başarılı.");
  } catch (err) {
    console.error("❌ MongoDB Bağlantı Hatası:", err.message);
  }
}

async function savePositionToDb(tokenAddress, posData) {
  activePositions[tokenAddress] = posData;
  if (!positionsCollection) return;
  try {
    await positionsCollection.updateOne({ tokenAddress }, { $set: { tokenAddress, ...posData } }, { upsert: true });
  } catch (err) {
    console.error("⚠️ Pozisyon Kaydetme Hatası:", err.message);
  }
}

async function removePositionFromDb(tokenAddress) {
  delete activePositions[tokenAddress];
  if (!positionsCollection) return;
  try {
    await positionsCollection.deleteOne({ tokenAddress });
  } catch (err) {
    console.error("⚠️ Pozisyon Silme Hatası:", err.message);
  }
}

async function saveSeenPoolToDb(poolAddr, poolData) {
  seenPools[poolAddr] = poolData;
  if (!seenPoolsCollection) return;
  try {
    await seenPoolsCollection.updateOne({ poolAddr }, { $set: { poolAddr, ...poolData } }, { upsert: true });
  } catch (err) {
    console.error("⚠️ Görülen Havuz Kaydetme Hatası:", err.message);
  }
}

async function fetchNewTonPools(applyFilter = true) {
  if (TON_PRICE_USD <= 0 || Date.now() - lastPriceUpdate > 120000) {
    await updateTonPrice();
  }

  let allPools = [];

  // 1. STON.fi Taraması (Güncellenmiş Esnek Filtre)
  try {
    const res = await axios.get('https://api.ston.fi/v1/pools', { timeout: 8000 });
    const poolsList = res.data?.pool_list || res.data || [];
    console.log(`🔍 STON.fi API'den toplam ${poolsList.length} ham havuz çekildi.`);
    
    const stonPools = poolsList.map(p => {
      if (p.deprecated) return null;
      const asset0 = normalizeAddress(p.token0_address || p.token0Address);
      const asset1 = normalizeAddress(p.token1_address || p.token1Address);

      const isTon0 = PTON_SET.has(asset0) || asset0 === 'native' || asset0.includes('pton');
      const isTon1 = PTON_SET.has(asset1) || asset1 === 'native' || asset1.includes('pton');

      if (!isTon0 && !isTon1) return null;

      let rTonLike = isTon0 ? Number(p.reserve0 || p.r0 || 0) / 1e9 : Number(p.reserve1 || p.r1 || 0) / 1e9;
      if (rTonLike <= 0) return null;

      const baseTokenAddress = isTon0 ? asset1 : asset0;
      if (!baseTokenAddress) return null;

      return {
        address: p.address,
        dex: 'stonfi',
        name: `TOKEN/TON (STON.fi)`,
        reserve_in_usd: rTonLike * 2 * TON_PRICE_USD,
        base_token_address: baseTokenAddress
      };
    }).filter(p => p !== null);

    console.log(`🔹 STON.fi TON eşleşmeli havuz: ${stonPools.length}`);
    const stonFiltered = stonPools.filter(p => !applyFilter || p.reserve_in_usd >= MIN_LIQUIDITY_USD);
    console.log(`🔹 STON.fi Minimum Likidite ($${MIN_LIQUIDITY_USD}) Filtresi Sonrası: ${stonFiltered.length}`);
    
    allPools.push(...stonFiltered);
  } catch (error) {
    console.error("⚠️ STON.fi Tarama Hatası:", error.message);
  }

  // 2. DeDust v2 Taraması (Retry Mekanizmalı)
  let dedustSuccess = false;
  let dedustRetries = 3;
  let dedustPoolsList = [];

  while (!dedustSuccess && dedustRetries > 0) {
    try {
      const dedustRes = await axios.get('https://api.dedust.io/v2/pools', { timeout: 8000 });
      dedustPoolsList = dedustRes.data || [];
      dedustSuccess = true;
    } catch (error) {
      dedustRetries--;
      console.warn(`⚠️ DeDust Tarama Hatası (${error.message}), kalan deneme: ${dedustRetries}`);
      if (dedustRetries > 0) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }

  if (dedustSuccess) {
    console.log(`🔍 DeDust API'den toplam ${dedustPoolsList.length} ham havuz çekildi.`);

    const dedustPools = dedustPoolsList.map(p => {
      const assets = p.assets || [];
      if (assets.length !== 2) return null;

      const asset0Obj = assets[0];
      const asset1Obj = assets[1];

      const asset0Addr = normalizeAddress(asset0Obj.address || (asset0Obj.type === 'native' ? 'native' : ''));
      const asset1Addr = normalizeAddress(asset1Obj.address || (asset1Obj.type === 'native' ? 'native' : ''));

      const hasTon = asset0Addr === 'native' || asset1Addr === 'native' || asset0Obj.type === 'native' || asset1Obj.type === 'native';
      if (!hasTon) return null;

      const reserve0 = Number((p.reserves && p.reserves[0]) ?? p.r0 ?? asset0Obj.reserve ?? 0) / 1e9;
      const reserve1 = Number((p.reserves && p.reserves[1]) ?? p.r1 ?? asset1Obj.reserve ?? 0) / 1e9;

      const isNative0 = asset0Addr === 'native' || asset0Obj.type === 'native';
      let rTonLike = isNative0 ? reserve0 : reserve1;

      if (rTonLike <= 0) return null;

      const tokenAsset = assets.find(a => {
        const addr = normalizeAddress(a.address || (a.type === 'native' ? 'native' : ''));
        return addr !== 'native' && a.type !== 'native';
      });

      if (!tokenAsset || !tokenAsset.address) return null;

      return {
        address: p.address || p.id,
        dex: 'dedust',
        name: `TOKEN/TON (DeDust)`,
        reserve_in_usd: rTonLike * 2 * TON_PRICE_USD,
        base_token_address: normalizeAddress(tokenAsset.address)
      };
    }).filter(p => p !== null);

    console.log(`🔹 DeDust TON eşleşmeli havuz: ${dedustPools.length}`);
    const dedustFiltered = dedustPools.filter(p => !applyFilter || p.reserve_in_usd >= MIN_LIQUIDITY_USD);
    console.log(`🔹 DeDust Minimum Likidite ($${MIN_LIQUIDITY_USD}) Filtresi Sonrası: ${dedustFiltered.length}`);

    allPools.push(...dedustFiltered);
  }

  console.log(`📊 Toplam Aktif Havuz (İki DEX Birleştirilmiş): ${allPools.length}`);
  return allPools;
}

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
      const { wallet } = await getCtx();
      for (const [tokenAddr, pos] of Object.entries(activePositions)) {
        let currentValNano = 0n;

        if (pos.dex === 'stonfi') {
          currentValNano = await sellValueNano(pos.dex, pos.poolAddr, tokenAddr, pos.rawBalance);
        } else {
          currentValNano = BigInt(Math.floor(pos.amount * 1e9 * 1.1));
        }

        if (currentValNano <= 0n) continue;

        const currentValTon = Number(currentValNano) / 1e9;
        const costTon = pos.amount;
        const profitLossPercent = ((currentValTon - costTon) / costTon) * 100;

        if (profitLossPercent >= TAKE_PROFIT_PERCENT || profitLossPercent <= -STOP_LOSS_PERCENT) {
          const reason = profitLossPercent >= TAKE_PROFIT_PERCENT ? "🎯 Take Profit" : "🛑 Stop Loss";
          
          let sold = false;
          if (pos.dex === 'stonfi') {
            sold = await sell(tokenAddr, pos.dex, pos.poolAddr, pos.rawBalance);
          } else {
            sold = await sellDedust(tokenAddr, pos.rawBalance);
          }
          
          if (sold) {
            try {
              await bot.sendMessage(ALLOWED_USER_ID, `💰 **POZİSYON KAPATILDI (${reason} - ${pos.dex.toUpperCase()})**\nToken: \`${tokenAddr}\`\nKar/Zarar: %${profitLossPercent.toFixed(2)}`, { parse_mode: "Markdown" });
            } catch (e) {}
            await removePositionFromDb(tokenAddr);
          } else {
            const actualBalance = await getWalletJettonBalance(wallet.address, tokenAddr);
            if (actualBalance <= 0n) {
              await removePositionFromDb(tokenAddr);
              try {
                await bot.sendMessage(ALLOWED_USER_ID, `⚠️ **POZİSYON KAPANDI (${pos.dex.toUpperCase()})**\nToken cüzdanda kalmadı: \`${tokenAddr}\``, { parse_mode: "Markdown" });
              } catch (e) {}
            }
          }
        }
      }
    } catch (err) {
      console.error("⚠️ Pozisyon İzleme Hatası:", err.message);
    }
    await new Promise(resolve => setTimeout(resolve, 20000));
  }
}

async function startSniperWorkerLoop() {
  while (botRunning) {
    try {
      console.log("🚀 Sniper Worker döngüsü başlatılıyor (STON.fi & DeDust Aktif)...");
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
          console.error("⚠️ Ana tarama döngüsü fetch hatası:", err.message);
          await new Promise(resolve => setTimeout(resolve, SCAN_INTERVAL));
          continue;
        }

        let pendingCount = 0;

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
            console.log(`🆕 YENİ HAVUZ YAKALANDI (${pool.dex.toUpperCase()}): ${poolAddr.substring(0, 10)}... Olgunlaşma süresi başlatıldı.`);
            continue;
          }

          let poolInfo = seenPools[poolAddr];
          if (poolInfo.status === 'pending') {
            pendingCount++;
            if ((now - poolInfo.firstSeen) < POOL_MATURITY_DELAY) continue;

            console.log(`⏳ Havuz olgunlaştı, güvenlik testi yapılıyor: ${tokenAddr.substring(0, 10)}...`);
            const safety = await checkSafetyWithSimulation(tokenAddr);
            if (safety.transient) continue;

            if (safety.safe) {
              console.log(`🛡️ Güvenlik testi BAŞARILI: ${tokenAddr.substring(0, 10)}... Alım tetikleniyor.`);
              let buyResult = { success: false, error: "Bilinmeyen hata" };

              if (pool.dex === 'stonfi') {
                const impact = await buyImpactPct(pool.dex, pool.address, tokenAddr, BUY_AMOUNT);
                if (impact > 5) {
                  console.log(`⚠️ Fiyat Etkisi çok yüksek (%${impact.toFixed(2)}), alım iptal.`);
                  poolInfo.status = 'failed_permanently';
                  await saveSeenPoolToDb(poolAddr, poolInfo);
                  continue;
                }
                buyResult = await buy(tokenAddr, BUY_AMOUNT, pool.dex, pool.address);
              } else if (pool.dex === 'dedust') {
                buyResult = await buyDedust(tokenAddr, BUY_AMOUNT, pool.address);
              }

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

                console.log(`✅ ALIM BAŞARILI (${pool.dex.toUpperCase()}): ${tokenAddr}`);
                try {
                  await bot.sendMessage(ALLOWED_USER_ID, `✅ **ALIM ONAYLANDI (${BUY_AMOUNT} TON - ${pool.dex.toUpperCase()})**\nToken: \`${tokenName}\``, { parse_mode: "Markdown" });
                } catch (e) {}
              } else {
                console.error(`❌ Alım başarısız (${pool.dex.toUpperCase()} - ${tokenAddr}):`, buyResult.error);
                if (buyResult.unconfirmed) {
                  poolInfo.status = 'pending';
                } else {
                  poolInfo.status = 'failed_permanently';
                }
                await saveSeenPoolToDb(poolAddr, poolInfo);
              }
            } else {
              console.log(`🚫 Güvenlik testi BAŞARISIZ (${safety.reason}): ${tokenAddr.substring(0, 10)}...`);
              poolInfo.status = 'failed_permanently';
              await saveSeenPoolToDb(poolAddr, poolInfo);
            }
          }
        }

        console.log(`🔎 Tarama Özeti: ${pools.length} havuz inceleniyor | ${pendingCount} havuz olgunlaşma aşamasında/beklemede.`);
        await new Promise(resolve => setTimeout(resolve, SCAN_INTERVAL));
      }
    } catch (criticalErr) {
      console.error("💥 Kritik Worker Döngüsü Hatası:", criticalErr.message);
      if (botRunning) {
        await new Promise(resolve => setTimeout(resolve, 10000));
      }
    }
  }
}

bot.onText(/\/baslat/, async (msg) => {
  if (msg.from.id !== ALLOWED_USER_ID) return;
  try {
    await getCtx();
    await updateTonPrice();
    await initDatabase();

    const { wallet } = await getCtx();
    const addressStr = wallet.address.toString({ bounceable: false });
    const stats = await getWalletAndStats(wallet.address);

    const wasRunning = botRunning;
    botRunning = true;

    if (!wasRunning) {
      bot.sendMessage(
        msg.chat.id, 
        `🚀 **Çift DEX Sniper Bot Başlatıldı!**\n\n` +
        `🟢 **Durum:** STON.fi & DeDust Aktif\n` +
        `📍 **Cüzdan:** \`${addressStr}\`\n` +
        `💰 **TON:** \`${stats.balanceGram.toFixed(2)}\`\n` +
        `📈 **Fiyat:** \`$${stats.priceUsd.toFixed(4)}\``, 
        { parse_mode: "Markdown" }
      );
      startSniperWorkerLoop();
      monitorPositions().catch(err => console.error("İzleme hatası:", err.message));
    } else {
      bot.sendMessage(msg.chat.id, `ℹ️ Bot zaten aktif çalışıyor.`);
    }
  } catch (e) {
    bot.sendMessage(msg.chat.id, `❌ Başlatma Hatası: \`${e.message}\``);
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
    const { wallet } = await getCtx();
    const addressStr = wallet.address.toString({ bounceable: false });
    const stats = await getWalletAndStats(wallet.address);

    bot.sendMessage(
      msg.chat.id, 
      `💰 **Cüzdan Durumu:**\n\n` +
      `📍 **Cüzdan:** \`${addressStr}\`\n` +
      `🔹 **TON:** \`${stats.balanceGram.toFixed(4)}\`\n` +
      `🔹 **Fiyat:** \`$${stats.priceUsd.toFixed(4)}\``, 
      { parse_mode: "Markdown" }
    );
  } catch (error) {
    bot.sendMessage(msg.chat.id, `❌ Hata: \`${error.message}\``);
  }
});

console.log("Çift DEX Sniper Bot hazır.");
