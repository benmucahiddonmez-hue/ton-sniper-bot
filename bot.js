// bot.js - Şeffaf Log Destekli Çift DEX Sniper Bot
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { MongoClient } = require('mongodb');
const axios = require('axios');
const { Address } = require('@ton/core');
const { buy, sell, sellValueNano, buyImpactPct, getWalletJettonBalance, getCtx } = require('./trade.js');

const TOKEN = process.env.TELEGRAM_TOKEN;
const ALLOWED_USER_ID = parseInt(process.env.ALLOWED_USER_ID || "0");
const MONGODB_URI = process.env.MONGODB_URI;

const GRAM_MASTER_ADDRESS = "EQC47093oX5Xhb0xuk2lCr2RhS8rj-vul61u4W2UH5ORmG_O";

if (!TOKEN || !ALLOWED_USER_ID) {
  console.error("HATA: TELEGRAM_TOKEN veya ALLOWED_USER_ID eksik!");
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });

let TON_PRICE_USD = 0;
let lastPriceUpdate = 0;

const MIN_LIQUIDITY_USD = 40.0;
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
        params: { ids: 'the-open-network', vs_currencies: 'usd' },
        timeout: 8000
      }
    );
    const price = Number(response.data?.['the-open-network']?.usd);
    if (!Number.isFinite(price) || price <= 0) throw new Error("Geçersiz TON fiyatı");
    TON_PRICE_USD = price;
    lastPriceUpdate = Date.now();
    return true;
  } catch (error) {
    if (TON_PRICE_USD <= 0) TON_PRICE_USD = 5.0;
    return false;
  }
}

async function getWalletAndGramStats(walletAddress) {
    let balanceTon = 0;
    let gramBalance = 0;
    let gramPriceUsd = process.env.GRAM_MANUAL_PRICE ? parseFloat(process.env.GRAM_MANUAL_PRICE) : 1.05;

    try {
        const { client } = await getCtx();
        if (TON_PRICE_USD <= 0) { await updateTonPrice(); }

        const balanceNano = await client.getBalance(walletAddress);
        balanceTon = Number(balanceNano) / 1e9;

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
                const rawGramBal = await getWalletJettonBalance(walletAddress, GRAM_MASTER_ADDRESS).catch(() => 0n);
                gramBalance = Number(rawGramBal) / 1e9;
            }
        } catch (e) {}
    } catch (err) {}

    return { balanceTon, gramBalance, gramPriceUsd };
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
    } catch (err) {}
}

async function initDatabase() {
  if (!MONGODB_URI) return;
  try {
    dbClient = new MongoClient(MONGODB_URI, {
      tls: true,
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

    await reconcilePositions();
  } catch (err) {}
}

async function savePositionToDb(tokenAddress, posData) {
  activePositions[tokenAddress] = posData;
  if (!positionsCollection) return;
  try {
    await positionsCollection.updateOne({ tokenAddress }, { $set: { tokenAddress, ...posData } }, { upsert: true });
  } catch (err) {}
}

async function removePositionFromDb(tokenAddress) {
  delete activePositions[tokenAddress];
  if (!positionsCollection) return;
  try {
    await positionsCollection.deleteOne({ tokenAddress });
  } catch (err) {}
}

async function saveSeenPoolToDb(poolAddr, poolData) {
  seenPools[poolAddr] = poolData;
  if (!seenPoolsCollection) return;
  try {
    await seenPoolsCollection.updateOne({ poolAddr }, { $set: { poolAddr, ...poolData } }, { upsert: true });
  } catch (err) {}
}

// Orijinal ve Çalışan fetchNewTonPools Fonksiyonu
async function fetchNewTonPools(applyFilter = true) {
  if (TON_PRICE_USD <= 0 || Date.now() - lastPriceUpdate > 120000) {
    await updateTonPrice();
  }

  let allPools = [];
  const normalizedGram = normalizeAddress(GRAM_MASTER_ADDRESS);
  const gramUsd = process.env.GRAM_MANUAL_PRICE ? parseFloat(process.env.GRAM_MANUAL_PRICE) : 1.05;

  // 1. STON.fi Taraması
  try {
    const { stonApi } = await getCtx();
    const poolsList = await stonApi.getPools();
    
    const stonPools = poolsList.map(p => {
      if (p.deprecated) return null;
      
      const asset0 = normalizeAddress(p.token0Address);
      const asset1 = normalizeAddress(p.token1Address);

      const isNative0 = p.lpFee?.toString().includes("native") || asset0?.includes("native") || p.isNative0;
      const isNative1 = p.lpFee?.toString().includes("native") || asset1?.includes("native") || p.isNative1;

      const isGram0 = asset0 === normalizedGram;
      const isGram1 = asset1 === normalizedGram;

      const hasBase = isNative0 || isNative1 || isGram0 || isGram1;
      if (!hasBase) return null;

      let rTonLike = 0;
      if (isNative0) rTonLike = Number(p.reserve0) / 1e9;
      else if (isNative1) rTonLike = Number(p.reserve1) / 1e9;
      else if (isGram0) rTonLike = (Number(p.reserve0) / 1e9) * gramUsd / TON_PRICE_USD;
      else if (isGram1) rTonLike = (Number(p.reserve1) / 1e9) * gramUsd / TON_PRICE_USD;

      if (rTonLike <= 0) return null;

      let baseTokenAddress = null;
      if (isNative0 || isGram0) baseTokenAddress = asset1;
      else baseTokenAddress = asset0;

      if (!baseTokenAddress || baseTokenAddress === normalizedGram) return null;

      const reserveUsd = rTonLike * 2 * TON_PRICE_USD;

      return {
        address: p.address,
        dex: 'stonfi',
        name: `TOKEN/${isGram0 || isGram1 ? 'GRAM' : 'TON'} (STON.fi)`,
        reserve_in_usd: reserveUsd,
        base_token_address: baseTokenAddress
      };
    }).filter(p => p !== null && (!applyFilter || p.reserve_in_usd >= MIN_LIQUIDITY_USD));
    
    allPools.push(...stonPools);
  } catch (error) {}

  // 2. DeDust v2 Taraması
  try {
    const dedustRes = await axios.get('https://api.dedust.io/v2/pools', { timeout: 8000 });
    const dedustPoolsList = dedustRes.data || [];

    const dedustPools = dedustPoolsList.map(p => {
      const assets = p.assets || [];
      if (assets.length !== 2) return null;

      const asset0Addr = normalizeAddress(assets[0].address || (assets[0].type === 'native' ? 'native' : ''));
      const asset1Addr = normalizeAddress(assets[1].address || (assets[1].type === 'native' ? 'native' : ''));

      const hasTon = asset0Addr === 'native' || asset1Addr === 'native';
      const hasGram = asset0Addr === normalizedGram || asset1Addr === normalizedGram;

      if (!hasTon && !hasGram) return null;

      const reserve0 = Number(p.r0 || assets[0].reserve || 0) / 1e9;
      const reserve1 = Number(p.r1 || assets[1].reserve || 0) / 1e9;

      let rTonLike = 0;
      if (hasTon) {
        rTonLike = asset0Addr === 'native' ? reserve0 : reserve1;
      } else if (hasGram) {
        const gramRes = asset0Addr === normalizedGram ? reserve0 : reserve1;
        rTonLike = (gramRes * gramUsd) / (TON_PRICE_USD > 0 ? TON_PRICE_USD : 1.05);
      }

      if (rTonLike <= 0) return null;

      const tokenAsset = assets.find(a => {
        const addr = normalizeAddress(a.address || (a.type === 'native' ? 'native' : ''));
        return addr !== 'native' && addr !== normalizedGram;
      });

      if (!tokenAsset || !tokenAsset.address) return null;

      const reserveUsd = rTonLike * 2 * TON_PRICE_USD;

      return {
        address: p.address || p.id,
        dex: 'dedust',
        name: `TOKEN/${hasGram ? 'GRAM' : 'TON'} (DeDust)`,
        reserve_in_usd: reserveUsd,
        base_token_address: normalizeAddress(tokenAsset.address)
      };
    }).filter(p => p !== null && (!applyFilter || p.reserve_in_usd >= MIN_LIQUIDITY_USD));

    allPools.push(...dedustPools);
  } catch (error) {}

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
    } catch (err) {}
    await new Promise(resolve => setTimeout(resolve, 20000));
  }
}

async function startSniperWorkerLoop() {
  while (botRunning) {
    try {
      console.log("🚀 Sniper Worker döngüsü başlatılıyor...");
      
      monitorPositions().catch(err => {});
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

        // Seninki ile birebir uyumlu şeffaf log bloğu
        const countBy = (list, dex) => list.filter(p => p && p.dex === dex).length;
        const newPools = pools.filter(p => p && !seenPools[p.address]);
        const pendingPools = pools.filter(p => p && seenPools[p.address]?.status === 'pending');

        console.log(
          `🔎 [STON.fi] Yeni: ${countBy(newPools, 'stonfi')} | Bekleyen: ${countBy(pendingPools, 'stonfi')} | Toplam uygun: ${countBy(pools, 'stonfi')}\n` +
          `🔎 [DeDust]  Yeni: ${countBy(newPools, 'dedust')} | Bekleyen: ${countBy(pendingPools, 'dedust')} | Toplam uygun: ${countBy(pools, 'dedust')}`
        );

        for (const pool of pools) {
          if (!botRunning) break;
          if (!pool) continue;

          const poolAddr = pool.address;
          const tokenAddr = pool.base_token_address;
          const tokenName = pool.name;

          if (!tokenAddr || activePositions[tokenAddr]) continue;

          const now = Date.now();
          if (!seenPools[poolAddr]) {
            console.log(`🆕 [YENİ HAVUZ YAKALANDI] Adres: ${poolAddr} (${pool.dex.toUpperCase()}) - Olgunlaşma süresi (60sn).`);
            seenPools[poolAddr] = { status: 'pending', firstSeen: now, attempts: 0 };
            await saveSeenPoolToDb(poolAddr, seenPools[poolAddr]);
            continue;
          }

          let poolInfo = seenPools[poolAddr];
          if (poolInfo.status !== 'pending') continue;
          
          if ((now - poolInfo.firstSeen) < POOL_MATURITY_DELAY) continue;

          console.log(`🛡️ [GÜVENLİK] Havuz olgunlaştı, güvenlik taraması: ${tokenAddr}`);
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
                await bot.sendMessage(ALLOWED_USER_ID, `✅ **ALIM ONAYLANDI (${BUY_AMOUNT} TON - ${pool.dex.toUpperCase()})**\nToken: \`${tokenName}\``, { parse_mode: "Markdown" });
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

        console.log(`💤 Tarama döngüsü tamamlandı, ${SCAN_INTERVAL / 1000} saniye sonra tekrar aranacak...\n`);
        await new Promise(resolve => setTimeout(resolve, SCAN_INTERVAL));
      }
    } catch (criticalErr) {
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
    const stats = await getWalletAndGramStats(wallet.address);

    const wasRunning = botRunning;
    botRunning = true;

    if (!wasRunning) {
      bot.sendMessage(
        msg.chat.id, 
        `🚀 **Şeffaf Loglu Sniper Bot Başlatıldı!**\n\n` +
        `🟢 **Durum:** Aktif Çalışıyor\n` +
        `💰 **TON:** \`${stats.balanceTon.toFixed(2)}\`\n` +
        `🪙 **Gram:** \`${stats.gramBalance.toFixed(2)}\`\n` +
        `📈 **Gram Fiyatı:** \`$${stats.gramPriceUsd.toFixed(4)}\``, 
        { parse_mode: "Markdown" }
      );
      startSniperWorkerLoop();
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

console.log("Şeffaf Log Destekli Sniper Bot hazır.");
