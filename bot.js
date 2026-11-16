
const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const path = require("path");

// ==========================================
// RAILWAY AYARLARI
// ==========================================

const TG_TOKEN = process.env.TG_TOKEN || "";

const ADMIN_USER_ID = 7511782761;
const ALERT_CHAT_ID = String(ADMIN_USER_ID);

const DRY_RUN = true;

const POLL_INTERVAL_MS = 20000;
const REQUEST_TIMEOUT_MS = 12000;
const STATE_FILE = path.join(process.cwd(), "state.json");

const STON_URL = "https://api.ston.fi/v1/pools";
const DEDUST_URL = "https://api.dedust.io/v2/pools";

if (!TG_TOKEN) {
  throw new Error("TG_TOKEN Railway Variables bölümünde bulunamadı!");
}

if (!DRY_RUN) {
  throw new Error("Bu sürüm yalnızca test modunda çalışabilir.");
}

// ==========================================
// BAŞLANGIÇ
// ==========================================

const bot = new TelegramBot(TG_TOKEN, {
  polling: true
});

let knownPools = new Set();
let isFirstRun = true;
let isScanning = false;
let lastScan = null;
let scanErrors = 0;
let totalDetected = 0;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ==========================================
// DURUM KAYDI
// ==========================================

function loadState() {
  try {
    const data = JSON.parse(
      fs.readFileSync(STATE_FILE, "utf8")
    );

    knownPools = new Set(data.knownPools || []);
    isFirstRun = data.initialized !== true;

    console.log(
      `Durum yüklendi: ${knownPools.size} havuz`
    );

  } catch (error) {
    console.log("Yeni durum dosyası oluşturulacak.");
  }
}

function saveState() {
  try {
    const tempFile = STATE_FILE + ".tmp";

    fs.writeFileSync(
      tempFile,
      JSON.stringify({
        initialized: !isFirstRun,
        knownPools: [...knownPools],
        totalDetected,
        updatedAt: new Date().toISOString()
      })
    );

    fs.renameSync(tempFile, STATE_FILE);

  } catch (error) {
    console.error("Kayıt hatası:", error.message);
  }
}

// ==========================================
// HTTP İSTEKLERİ
// ==========================================

async function getJSON(url, attempts = 4) {
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetch(url, {
        headers: {
          "Accept": "application/json",
          "User-Agent": "TON-Pool-Monitor/1.0"
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });

      if (!response.ok) {
        throw new Error(
          `HTTP ${response.status}`
        );
      }

      return await response.json();

    } catch (error) {
      if (i === attempts - 1) throw error;

      const delay = Math.min(
        1000 * Math.pow(2, i),
        10000
      );

      await sleep(delay);
    }
  }
}

// ==========================================
// HAVUZ VERİLERİ
// ==========================================

function normalizePools(data) {
  if (Array.isArray(data)) return data;

  if (Array.isArray(data?.pool_list)) {
    return data.pool_list;
  }

  if (Array.isArray(data?.pools)) {
    return data.pools;
  }

  return [];
}

function getAddress(pool) {
  return (
    pool.address ||
    pool.pool_address ||
    pool.poolAddress ||
    ""
  );
}

function getTokenName(pool) {
  if (pool.symbol) return pool.symbol;

  if (pool.token0_symbol && pool.token1_symbol) {
    return `${pool.token0_symbol}/${pool.token1_symbol}`;
  }

  if (Array.isArray(pool.assets) && pool.assets.length >= 2) {
    return pool.assets.map(asset => {
      if (typeof asset === "string") {
        return asset.substring(0, 6);
      }

      return (
        asset?.symbol ||
        asset?.address?.substring(0, 6) ||
        "TOKEN"
      );
    }).join("/");
  }

  if (pool.token0_address && pool.token1_address) {
    return (
      pool.token0_address.substring(0, 6) +
      "/" +
      pool.token1_address.substring(0, 6)
    );
  }

  return "Bilinmeyen Token";
}

function getLiquidity(pool) {
  const fields = [
    "lp_total_supply_usd",
    "liquidity_usd",
    "tvl_usd",
    "reserve0_usd"
  ];

  for (const field of fields) {
    const value = Number(pool[field]);

    if (Number.isFinite(value) && value > 0) {
      return value;
    }
  }

  return null;
}

// ==========================================
// TELEGRAM BİLDİRİMLERİ
// ==========================================

async function sendAlert(message) {
  try {
    await bot.sendMessage(
      ALERT_CHAT_ID,
      message,
      {
        disable_web_page_preview: true
      }
    );

  } catch (error) {
    console.error(
      "Telegram bildirim hatası:",
      error.message
    );
  }
}

function isAdmin(msg) {
  return (
    msg &&
    msg.from &&
    Number(msg.from.id) === ADMIN_USER_ID
  );
}

// ==========================================
// YENİ HAVUZ
// ==========================================

async function handleNewPool(pool, dex) {
  const address = getAddress(pool);

  if (!address || knownPools.has(address)) {
    return;
  }

  knownPools.add(address);
  totalDetected++;

  const name = getTokenName(pool);
  const liquidity = getLiquidity(pool);

  const liquidityText = liquidity === null
    ? "Bilinmiyor"
    : `$${liquidity.toFixed(2)}`;

  console.log(
    `Yeni havuz: ${name} | ${dex} | ${address}`
  );

  await sendAlert(
    `🚨 YENİ HAVUZ TESPİT EDİLDİ\n\n` +
    `DEX: ${dex}\n` +
    `Token: ${name}\n` +
    `Adres: ${address}\n` +
    `Likidite: ${liquidityText}\n\n` +
    `Mod: TEST\n` +
    `İşlem: Gerçek alım yapılmadı.\n` +
    `Not: Bu bildirim güvenlik onayı değildir.`
  );

  saveState();
}

// ==========================================
// DEX TARAMA
// ==========================================

async function scanSTON() {
  const data = await getJSON(STON_URL + "?dexV2=true");
  const pools = normalizePools(data);

  return {
    name: "STON.fi",
    pools
  };
}

async function scanDeDust() {
  const data = await getJSON(DEDUST_URL);
  const pools = normalizePools(data);

  return {
    name: "DeDust",
    pools
  };
}

// ==========================================
// TÜM HAVUZLARI TARA
// ==========================================

async function checkAllPools() {
  if (isScanning) return;

  isScanning = true;

  try {
    const results = await Promise.allSettled([
      scanSTON(),
      scanDeDust()
    ]);

    let successfulScans = 0;

    for (const result of results) {
      if (result.status !== "fulfilled") {
        scanErrors++;

        console.error(
          "DEX tarama hatası:",
          result.reason?.message
        );

        continue;
      }

      successfulScans++;

      const { name, pools } = result.value;

      console.log(
        `${name}: ${pools.length} havuz bulundu.`
      );

      if (isFirstRun) {
        for (const pool of pools) {
          const address = getAddress(pool);

          if (address) {
            knownPools.add(address);
          }
        }

        continue;
      }

      for (const pool of pools) {
        const address = getAddress(pool);

        if (!address || knownPools.has(address)) {
          continue;
        }

        await handleNewPool(pool, name);
      }
    }

    if (isFirstRun && successfulScans > 0) {
      isFirstRun = false;
      saveState();

      await sendAlert(
        "✅ SNIPER BOT TEST SÜRÜMÜ AKTİF\n\n" +
        "STON.fi ve DeDust taraması başlatıldı.\n" +
        `Başlangıç havuz sayısı: ${knownPools.size}\n` +
        "Gerçek işlem: Kapalı"
      );
    }

    if (successfulScans > 0) {
      lastScan = new Date().toISOString();
    }

    if (successfulScans === 0) {
      console.log("Hiçbir DEX taranamadı.");
    }

  } catch (error) {
    console.error("Tarama hatası:", error.message);

  } finally {
    isScanning = false;
  }
}

// ==========================================
// TELEGRAM KOMUTLARI
// ==========================================

bot.on("message", async msg => {
  try {
    if (!msg.text || !isAdmin(msg)) return;

    const command = msg.text.trim().split(/\s+/)[0];

    if (command === "/start" || command === "/yardim") {
      await bot.sendMessage(
        msg.chat.id,
        "🤖 SNIPER BOT TEST PANELİ\n\n" +
        "/durum - Bot durumu\n" +
        "/havuzlar - İzlenen havuz sayısı\n" +
        "/istatistik - Tespit istatistikleri\n" +
        "/tara - Manuel tarama\n" +
        "/yardim - Yardım"
      );
    }

    else if (command === "/durum") {
      await bot.sendMessage(
        msg.chat.id,
        `🤖 BOT DURUMU\n\n` +
        `Çalışma: AKTİF\n` +
        `Mod: TEST\n` +
        `Gerçek işlem: KAPALI\n` +
        `Yönetici ID: ${ADMIN_USER_ID}\n` +
        `İzlenen havuz: ${knownPools.size}\n` +
        `Son tarama: ${lastScan || "Henüz yok"}\n` +
        `Tarama hatası: ${scanErrors}`
      );
    }

    else if (command === "/havuzlar") {
      await bot.sendMessage(
        msg.chat.id,
        `📊 İzlenen havuz sayısı: ${knownPools.size}`
      );
    }

    else if (command === "/istatistik") {
      await bot.sendMessage(
        msg.chat.id,
        `📈 İSTATİSTİK\n\n` +
        `Toplam yeni havuz: ${totalDetected}\n` +
        `Kayıtlı havuz: ${knownPools.size}\n` +
        `API hatası: ${scanErrors}\n` +
        `Mod: TEST`
      );
    }

    else if (command === "/tara") {
      await bot.sendMessage(
        msg.chat.id,
        "🔎 Manuel tarama başlatılıyor..."
      );

      await checkAllPools();

      await bot.sendMessage(
        msg.chat.id,
        "✅ Tarama tamamlandı."
      );
    }

  } catch (error) {
    console.error(
      "Komut hatası:",
      error.message
    );
  }
});

// ==========================================
// HATA YÖNETİMİ
// ==========================================

bot.on("polling_error", error => {
  console.error(
    "Telegram polling hatası:",
    error.message
  );
});

process.on("unhandledRejection", error => {
  console.error("Promise hatası:", error);
});

process.on("uncaughtException", error => {
  console.error("Beklenmeyen hata:", error);
});

// ==========================================
// BAŞLAT
// ==========================================

async function start() {
  console.log("Sniper Bot başlatılıyor...");

  loadState();

  await checkAllPools();

  setInterval(
    checkAllPools,
    POLL_INTERVAL_MS
  );

  console.log("Bot çalışıyor.");
}

start().catch(error => {
  console.error("Başlatma hatası:", error.message);
  process.exit(1);
});
   const txParams = await router.getSwapJettonToTonTxParams({
      userWalletAddress: wallet.address.toString(),
      offerJettonAddress: sim.offerAddress,
      offerAmount: sim.offerUnits,
      minAskAmount: sim.minAskUnits,
      proxyTon
    });

    await sendTx(txParams);
    return { success: true, tonOut };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function monitorPositions() {
  if (isMonitoring || activePositions.size === 0) return;
  isMonitoring = true;
  try {
    for (const [key, pos] of activePositions) {
      try {
        const sim = await simulate(pos.tokenAddress, 'ton', BigInt(pos.tokenAmount));
        const value = Number(fromNano(BigInt(sim.askUnits)));
        const pnl = ((value - pos.buyTon) / pos.buyTon) * 100;
        pos.lastPnl = pnl;
        pos.failCount = 0;

        if (pnl >= TAKE_PROFIT_PCT || pnl <= -STOP_LOSS_PCT) {
          const reason = pnl >= TAKE_PROFIT_PCT ? '🎯 Take Profit' : '🛑 Stop Loss';
          const r = await enqueue(() => executeSell(pos));
          if (r.success) {
            activePositions.delete(key);
            saveState();
            await sendAlert(`${reason} *[${pos.token}]* satildi${DRY_RUN ? ' (TEST)' : ''}\nGiris: ${pos.buyTon} TON → Cikis: ${r.tonOut.toFixed(3)} TON (%${pnl.toFixed(1)})`);
          } else {
            await sendAlert(`❌ *[${pos.token}]* satim basarisiz: \`${r.error}\``);
          }
        }
      } catch (e) {
        pos.failCount = (pos.failCount || 0) + 1;
        console.error(`Izleme hatasi [${pos.token}]:`, e.message);
        if (pos.failCount === 3) {
          await sendAlert(`⚠️ *[${pos.token}]* icin fiyat alinamiyor.`);
        }
      }
      await sleep(1500);
    }
    saveState();
  } finally {
    isMonitoring = false;
  }
}

if (bot) {
  bot.on('message', async (msg) => {
    try {
      if (!msg || !msg.text) return;
      if (String(msg.chat.id) !== String(TG_CHAT_ID)) return;
      const text = msg.text.trim();

      if (text === '/bakiye') {
        const { wallet } = await getWallet();
        const addr = wallet.address.toString({ bounceable: false });
        const bal = await retry(() => tonClient.getBalance(wallet.address));
        await bot.sendMessage(msg.chat.id,
          `💰 *Cüzdan*\n\`${addr}\`\nTON: \`${Number(fromNano(bal)).toFixed(4)}\`\nAçık pozisyon: \`${activePositions.size}\`\nİzlenen havuz: \`${knownPools.size}\`\nMod: ${DRY_RUN ? 'TEST' : 'GERÇEK'}`,
          { parse_mode: 'Markdown' });
      }

      if (text === '/pozisyonlar') {
        if (activePositions.size === 0) return bot.sendMessage(msg.chat.id, 'Acik pozisyon yok.');
        const lines = [...activePositions.values()].map(p =>
          `- ${p.token}: ${p.buyTon} TON, PnL ${p.lastPnl !== undefined ? p.lastPnl.toFixed(1) + '%' : '?'}`);
        await bot.sendMessage(msg.chat.id, lines.join('\n'));
      }
    } catch (err) {
      console.error('Komut hatasi:', err.message);
      try { await bot.sendMessage(msg.chat.id, `❌ Hata: ${err.message}`); } catch (e) {}
    }
  });
}

function getPoolDisplayName(pool) {
  if (pool.symbol) return pool.symbol;
  if (pool.token0_symbol && pool.token1_symbol) return `${pool.token0_symbol}/${pool.token1_symbol}`;
  if (pool.token0_address && pool.token1_address) {
    return `${pool.token0_address.substring(0, 4)}/${pool.token1_address.substring(0, 4)}`;
  }
  if (pool.assets && Array.isArray(pool.assets) && pool.assets.length >= 2) {
    const a0 = typeof pool.assets[0] === 'string' ? pool.assets[0].substring(0, 4) : 'TON';
    const a1 = typeof pool.assets[1] === 'string' ? pool.assets[1].substring(0, 4) : 'TOKEN';
    return `${a0}/${a1}`;
  }
  if (pool.address) return `Pool_${pool.address.substring(0, 4)}...${pool.address.substring(pool.address.length - 4)}`;
  return "Yeni Token";
}

async function handleNewPool(pool) {
  const poolAddress = pool.address;
  const dex = pool.dex || 'STON.fi';
  const tokenName = getPoolDisplayName(pool);

  const liquidityUsd = Number(
    pool.lp_total_supply_usd || pool.liquidity_usd || pool.reserve0_usd || pool.usd_price || pool.tvl_usd || 0
  );

  knownPools.add(poolAddress);

  await sendAlert(`🚨 *Yeni Havuz (${dex})*\n🪙 *${tokenName}*\n📍 \`${poolAddress}\`\n💧 Likidite: \`$${liquidityUsd.toFixed(2)}\`\n⏳ ${WAIT_TIME_SECONDS} sn bekleniyor...`);

  setTimeout(async () => {
    try {
      if (dex !== 'STON.fi') {
        await sendAlert(`ℹ️ *[${tokenName}]* DeDust havuzu: otomatik alim desteklenmiyor.`);
        return;
      }

      if (activePositions.size >= MAX_OPEN_POSITIONS) {
        await sendAlert(`⏸️ *[${tokenName}]* atlandi: acik pozisyon limiti dolu.`);
        return;
      }

      if (liquidityUsd > 0 && liquidityUsd < MIN_LIQUIDITY_USD) {
        await sendAlert(`❌ *[${tokenName}]* iptal: likidite $${MIN_LIQUIDITY_USD} altinda.`);
        return;
      }

      await sendAlert(`🛡️ *[${tokenName}]* guvenlik taramasi...`);
      const safety = await checkSafety(pool);
      if (!safety.safe) {
        await sendAlert(`🚨 *[${tokenName}]* RISK, islem iptal.\nSebep: \`${safety.reason}\``);
        return;
      }

      await sendAlert(`🚀 *[${tokenName}]* kontroller tamam. Alim siraya aliniyor...`);

      const buy = await enqueue(() => executeBuy(safety.token, safety.sim));
      if (!buy.success) {
        await sendAlert(`❌ *[${tokenName}]* alim basarisiz: \`${buy.error}\``);
        return;
      }

      activePositions.set(poolAddress, {
        token: tokenName,
        tokenAddress: safety.token,
        poolAddress,
        dex,
        buyTon: BUY_AMOUNT_TON,
        tokenAmount: buy.tokenAmount.toString(),
        openedAt: Date.now()
      });
      saveState();

      await sendAlert(`✅ *[${tokenName}]* pozisyon acildi${buy.dryRun ? ' (TEST)' : ''}! ${BUY_AMOUNT_TON} TON`);
    } catch (err) {
      console.error('handleNewPool hatasi:', err);
      await sendAlert(`❌ [${tokenName}] hata: \`${err.message}\``);
    }
  }, WAIT_TIME_SECONDS * 1000);
}

async function scanDex(name, url, listPicker) {
  try {
    const data = await retry(() => httpGet(url));
    const pools = listPicker(data);
    if (!Array.isArray(pools)) return;
    if (isFirstRun) {
      pools.forEach(p => p && p.address && knownPools.add(p.address));
      return;
    }
    for (const pool of pools) {
      if (!pool || !pool.address || knownPools.has(pool.address)) continue;
      pool.dex = name;
      await handleNewPool(pool);
    }
  } catch (e) {
    console.error(`${name} tarama hatasi:`, e.message);
  }
}

async function checkAllPools() {
  if (isPolling) return;
  isPolling = true;
  try {
    await scanDex('STON.fi', 'https://api.ston.fi/v1/pools', d => d && (d.pool_list || d.pools || d));
    await sleep(2000);
    await scanDex('DeDust.io', 'https://api.dedust.io/v2/pools', d => d);

    if (isFirstRun) {
      isFirstRun = false;
      await sendAlert(`✅ *Sniper Bot Aktif*\nMod: ${DRY_RUN ? 'TEST' : 'GERÇEK'}\nKomutlar: /bakiye /pozisyonlar`);
    }
    saveState();
  } finally {
    isPolling = false;
  }
}

loadState();
initClient().then(() => {
  setInterval(checkAllPools, POLL_INTERVAL_MS);
  setInterval(monitorPositions, MONITOR_INTERVAL_MS);
  checkAllPools();
}).catch(err => {
  console.error('Baslatma hatasi:', err);
  process.exit(1);
});

process.on('uncaughtException', (err) => console.error('Yakalanamayan hata:', err));
process.on('unhandledRejection', (err) => console.error('Yakalanamayan Promise reddi:', err));
alletAddress: wallet.address.toString(),
      offerJettonAddress: sim.offerAddress,
      offerAmount: sim.offerUnits,
      minAskAmount: sim.minAskUnits,
      proxyTon
    });

    await sendTx(txParams);
    return { success: true, tonOut };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function monitorPositions() {
  if (isMonitoring || activePositions.size === 0) return;
  isMonitoring = true;
  try {
    for (const [key, pos] of activePositions) {
      try {
        const sim = await simulate(pos.tokenAddress, 'ton', BigInt(pos.tokenAmount));
        const value = Number(fromNano(BigInt(sim.askUnits)));
        const pnl = ((value - pos.buyTon) / pos.buyTon) * 100;
        pos.lastPnl = pnl;
        pos.failCount = 0;

        if (pnl >= TAKE_PROFIT_PCT || pnl <= -STOP_LOSS_PCT) {
          const reason = pnl >= TAKE_PROFIT_PCT ? '🎯 Take Profit' : '🛑 Stop Loss';
          const r = await enqueue(() => executeSell(pos));
          if (r.success) {
            activePositions.delete(key);
            saveState();
            await sendAlert(`${reason} *[${pos.token}]* satıldı${DRY_RUN ? ' (TEST)' : ''}\nGiriş: ${pos.buyTon} TON → Çıkış: ${r.tonOut.toFixed(3)} TON (%${pnl.toFixed(1)})`);
          } else {
            await sendAlert(`❌ *[${pos.token}]* satım başarısız: \`${r.error}\``);
          }
        }
      } catch (e) {
        pos.failCount = (pos.failCount || 0) + 1;
        console.error(`İzleme hatası [${pos.token}]:`, e.message);
        if (pos.failCount === 3) {
          await sendAlert(`⚠️ *[${pos.token}]* için fiyat alınamıyor (3 deneme). Likidite çekilmiş olabilir (rug), cüzdanı kontrol et.`);
        }
      }
      await sleep(1500);
    }
    saveState();
  } finally {
    isMonitoring = false;
  }
}

if (bot) {
  bot.on('message', async (msg) => {
    try {
      if (!msg || !msg.text) return;
      if (String(msg.chat.id) !== String(TG_CHAT_ID)) return;
      const text = msg.text.trim();

      if (text === '/bakiye') {
        const { wallet } = await getWallet();
        const addr = wallet.address.toString({ bounceable: false });
        const bal = await retry(() => tonClient.getBalance(wallet.address));
        await bot.sendMessage(msg.chat.id,
          `💰 *Cüzdan*\n\`${addr}\`\nTON: \`${Number(fromNano(bal)).toFixed(4)}\`\nAçık pozisyon: \`${activePositions.size}\`\nİzlenen havuz: \`${knownPools.size}\`\nMod: ${DRY_RUN ? 'TEST' : 'GERÇEK'}`, { parse_mode: 'Markdown' }); }  if (text === '/pozisyonlar') { if (activePositions.size === 0) return bot.sendMessage(msg.chat.id, 'Açık pozisyon yok.'); const lines = [...activePositions.values()].map(p => `- ${p.token}: ${p.buyTon} TON, PnL${p.lastPnl !== undefined ? p.lastPnl.toFixed(1) + '%' : '?'}`);
        await bot.sendMessage(msg.chat.id, lines.join('\n'));
      }
    } catch (err) {
      console.error('Komut hatası:', err.message);
      try { await bot.sendMessage(msg.chat.id, `❌ Hata: ${err.message}`); } catch (e) {} } }); }  function getPoolDisplayName(pool) { if (pool.symbol) return pool.symbol; if (pool.token0_symbol && pool.token1_symbol) return `${pool.token0_symbol}/${pool.token1_symbol}`; if (pool.token0_address && pool.token1_address) { return `${pool.token0_address.substring(0, 4)}/${pool.token1_address.substring(0, 4)}`; } if (pool.assets && Array.isArray(pool.assets) && pool.assets.length >= 2) { const a0 = typeof pool.assets[0] === 'string' ? pool.assets[0].substring(0, 4) : 'TON'; const a1 = typeof pool.assets[1] === 'string' ? pool.assets[1].substring(0, 4) : 'TOKEN'; return `${a0}/${a1}`; } if (pool.address) return `Pool_${pool.address.substring(0, 4)}...${pool.address.substring(pool.address.length - 4)}`; return "Yeni Token"; }  async function handleNewPool(pool) { const poolAddress = pool.address; const dex = pool.dex \vert{}\vert{} 'STON.fi'; const tokenName = getPoolDisplayName(pool);  const liquidityUsd = Number( pool.lp_total_supply_usd \vert{}\vert{} pool.liquidity_usd \vert{}\vert{} pool.reserve0_usd \vert{}\vert{} pool.usd_price \vert{}\vert{} pool.tvl_usd \vert{}\vert{} 0 );  knownPools.add(poolAddress);  await sendAlert(`🚨 *Yeni Havuz (${dex})*\n🪙 *${tokenName}*\n📍 \`${poolAddress}\`\n💧 Likidite: \`$${liquidityUsd.toFixed(2)}\`\n⏳ ${WAIT_TIME_SECONDS} sn bekleniyor...`);

  setTimeout(async () => {
    try {
      if (dex !== 'STON.fi') {
        await sendAlert(`ℹ️ *[${tokenName}]* DeDust havuzu: otomatik alım desteklenmiyor, sadece bildirim.`);
        return;
      }

      if (activePositions.size >= MAX_OPEN_POSITIONS) {
        await sendAlert(`⏸️ *[${tokenName}]* atlandı: açık pozisyon limiti (${MAX_OPEN_POSITIONS}) dolu.`);
        return;
      }

      if (liquidityUsd > 0 && liquidityUsd < MIN_LIQUIDITY_USD) {
        await sendAlert(`❌ *[${tokenName}]* iptal: likidite$${MIN_LIQUIDITY_USD} altında ($${liquidityUsd.toFixed(2)}).`); return; }  await sendAlert(`🛡️ *[${tokenName}]* güvenlik taraması...`);
      const safety = await checkSafety(pool);
      if (!safety.safe) {
        await sendAlert(`🚨 *[${tokenName}]* RİSK, işlem iptal.\nSebep: \`${safety.reason}\``);
        return;
      }

      await sendAlert(`🚀 *[${tokenName}]* kontroller tamam (fiyat etkisi %${(safety.impact * 100).toFixed(1)}, al-sat \%${(safety.roundTrip * 100).toFixed(0)}). Alım sıraya alındı...`);

      const buy = await enqueue(() => executeBuy(safety.token, safety.sim));
      if (!buy.success) {
        await sendAlert(`❌ *[${tokenName}]* alım başarısız: \`${buy.error}\``);
        return;
      }

      activePositions.set(poolAddress, {
        token: tokenName,
        tokenAddress: safety.token,
        poolAddress,
        dex,
        buyTon: BUY_AMOUNT_TON,
        tokenAmount: buy.tokenAmount.toString(),
        openedAt: Date.now()
      });
      saveState();

      await sendAlert(`✅ *[${tokenName}]* pozisyon açıldı${buy.dryRun ? ' (TEST, gerçek işlem yok)' : ''}! ${BUY_AMOUNT_TON} TON\n🎯 +\%${TAKE_PROFIT_PCT} | 🛑 -%${STOP_LOSS_PCT}`); } catch (err) { console.error('handleNewPool hatası:', err); await sendAlert(`❌ [${tokenName}] hata: \`${err.message}\``); } }, WAIT_TIME_SECONDS * 1000); }  async function scanDex(name, url, listPicker) { try { const data = await retry(() => httpGet(url)); const pools = listPicker(data); if (!Array.isArray(pools)) return; if (isFirstRun) { pools.forEach(p => p && p.address && knownPools.add(p.address)); return; } for (const pool of pools) { if (!pool \vert{}\vert{} !pool.address \vert{}\vert{} knownPools.has(pool.address)) continue; pool.dex = name; await handleNewPool(pool); } } catch (e) { console.error(`${name} tarama hatası:`, e.message);
  }
}

async function checkAllPools() {
  if (isPolling) return;
  isPolling = true;
  try {
    await scanDex('STON.fi', 'https://api.ston.fi/v1/pools', d => d && (d.pool_list || d.pools || d));
    await sleep(2000);
    await scanDex('DeDust.io', 'https://api.dedust.io/v2/pools', d => d);

    if (isFirstRun) {
      isFirstRun = false;
      await sendAlert(`✅ *Sniper Bot Aktif*\nMod: ${DRY_RUN ? 'TEST (DRY_RUN)' : 'GERÇEK'}\nMin likid
JettonTxParams({
      userWalletAddress: wallet.address.toString(),
      offerAmount: sim.offerUnits,
      minAskAmount: sim.minAskUnits,
      askJettonAddress: sim.askAddress,
      proxyTon
    });

    await sendTx(txParams);

    // Jeton bakiyesinin geldiğini doğrula
    let bal = 0n;
    for (let i = 0; i < 12; i++) {
      await sleep(5000);
      bal = await getJettonBalance(token, wallet.address);
      if (bal > 0n) break;
    }
    if (bal === 0n) {
      return { success: false, error: "Tx gönderildi ama jeton bakiyesi görünmedi. Cüzdanı elle kontrol et!" };
    }
    return { success: true, tokenAmount: bal };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ---------- Satım ----------
async function executeSell(pos) {
  try {
    const { wallet } = await getWallet();
    const amount = BigInt(pos.tokenAmount);
    const sim = await simulate(pos.tokenAddress, 'ton', amount);
    const tonOut = Number(fromNano(BigInt(sim.askUnits)));

    if (DRY_RUN) return { success: true, tonOut };

    const routerInfo = sim.router;
    const contracts = dexFactory(routerInfo);
    const router = stonClient.open(contracts.Router.create(routerInfo.address));
    const proxyTon = contracts.pTON.create(routerInfo.ptonMasterAddress);

    const txParams = await router.getSwapJettonToTonTxParams({
      userWalletAddress: wallet.address.toString(),
      offerJettonAddress: sim.offerAddress,
      offerAmount: sim.offerUnits,
      minAskAmount: sim.minAskUnits,
      proxyTon
    });

    await sendTx(txParams);
    return { success: true, tonOut };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ---------- Take Profit / Stop Loss takibi ----------
async function monitorPositions() {
  if (isMonitoring || activePositions.size === 0) return;
  isMonitoring = true;
  try {
    for (const [key, pos] of activePositions) {
      try {
        const sim = await simulate(pos.tokenAddress, 'ton', BigInt(pos.tokenAmount));
        const value = Number(fromNano(BigInt(sim.askUnits)));
        const pnl = ((value - pos.buyTon) / pos.buyTon) * 100;
        pos.lastPnl = pnl;
        pos.failCount = 0;

        if (pnl >= TAKE_PROFIT_PCT || pnl <= -STOP_LOSS_PCT) {
          const reason = pnl >= TAKE_PROFIT_PCT ? '🎯 Take Profit' : '🛑 Stop Loss';
          const r = await enqueue(() => executeSell(pos));
          if (r.success) {
            activePositions.delete(key);
            saveState();
            await sendAlert(`${reason} *[${pos.token}]* satıldı${DRY_RUN ? ' (TEST)' : ''}\nGiriş: ${pos.buyTon} TON → Çıkış: ${r.tonOut.toFixed(3)} TON (%${pnl.toFixed(1)})`);
          } else {
            await sendAlert(`❌ *[${pos.token}]* satım başarısız: \`${r.error}\``);
          }
        }
      } catch (e) {
        pos.failCount = (pos.failCount || 0) + 1;
        console.error(`İzleme hatası [${pos.token}]:`, e.message);
        if (pos.failCount === 3) {
          await sendAlert(`⚠️ *[${pos.token}]* için fiyat alınamıyor (3 deneme). Likidite çekilmiş olabilir (rug), cüzdanı kontrol et.`);
        }
      }
      await sleep(1500);
    }
    saveState();
  } finally {
    isMonitoring = false;
  }
}

// ---------- Telegram komutları ----------
if (bot) {
  bot.on('message', async (msg) => {
    try {
      if (!msg || !msg.text) return;
      if (String(msg.chat.id) !== String(TG_CHAT_ID)) return;
      const text = msg.text.trim();

      if (text === '/bakiye') {
        const { wallet } = await getWallet();
        const addr = wallet.address.toString({ bounceable: false });
        const bal = await retry(() => tonClient.getBalance(wallet.address));
        await bot.sendMessage(msg.chat.id,
          `💰 *Cüzdan*\n\`${addr}\`\nTON: \`${Number(fromNano(bal)).toFixed(4)}\`\nAçık pozisyon: \`${activePositions.size}\`\nİzlenen havuz: \`${knownPools.size}\`\nMod: ${DRY_RUN ? 'TEST' : 'GERÇEK'}`,
          { parse_mode: 'Markdown' });
      }

      if (text === '/pozisyonlar') {
        if (activePositions.size === 0) return bot.sendMessage(msg.chat.id, 'Açık pozisyon yok.');
        const lines = [...activePositions.values()].map(p =>
          `- ${p.token}: ${p.buyTon} TON, PnL ${p.lastPnl !== undefined ? p.lastPnl.toFixed(1) + '%' : '?'}`);
        await bot.sendMessage(msg.chat.id, lines.join('\n'));
      }
    } catch (err) {
      console.error('Komut hatası:', err.message);
      try { await bot.sendMessage(msg.chat.id, `❌ Hata: ${err.message}`); } catch (e) {}
    }
  });
}

// ---------- Havuz tespiti ----------
function getPoolDisplayName(pool) {
  if (pool.symbol) return pool.symbol;
  if (pool.token0_symbol && pool.token1_symbol) return `${pool.token0_symbol}/${pool.token1_symbol}`;
  if (pool.token0_address && pool.token1_address) {
    return `${pool.token0_address.substring(0, 4)}/${pool.token1_address.substring(0, 4)}`;
  }
  if (pool.assets && Array.isArray(pool.assets) && pool.assets.length >= 2) {
    const a0 = typeof pool.assets[0] === 'string' ? pool.assets[0].substring(0, 4) : 'TON';
    const a1 = typeof pool.assets[1] === 'string' ? pool.assets[1].substring(0, 4) : 'TOKEN';
    return `${a0}/${a1}`;
  }
  if (pool.address) return `Pool_${pool.address.substring(0, 4)}...${pool.address.substring(pool.address.length - 4)}`;
  return "Yeni Token";
}

async function handleNewPool(pool) {
  const poolAddress = pool.address;
  const dex = pool.dex || 'STON.fi';
  const tokenName = getPoolDisplayName(pool);

  const liquidityUsd = Number(
    pool.lp_total_supply_usd || pool.liquidity_usd || pool.reserve0_usd || pool.usd_price || pool.tvl_usd || 0
  );

  knownPools.add(poolAddress);

  await sendAlert(`🚨 *Yeni Havuz (${dex})*\n🪙 *${tokenName}*\n📍 \`${poolAddress}\`\n💧 Likidite: \`$${liquidityUsd.toFixed(2)}\`\n⏳ ${WAIT_TIME_SECONDS} sn bekleniyor...`);

  setTimeout(async () => {
    try {
      if (dex !== 'STON.fi') {
        await sendAlert(`ℹ️ *[${tokenName}]* DeDust havuzu: otomatik alım desteklenmiyor, sadece bildirim.`);
        return;
      }

      if (activePositions.size >= MAX_OPEN_POSITIONS) {
        await sendAlert(`⏸️ *[${tokenName}]* atlandı: açık pozisyon limiti (${MAX_OPEN_POSITIONS}) dolu.`);
        return;
      }

      if (liquidityUsd > 0 && liquidityUsd < MIN_LIQUIDITY_USD) {
        await sendAlert(`❌ *[${tokenName}]* iptal: likidite $${MIN_LIQUIDITY_USD} altında ($${liquidityUsd.toFixed(2)}).`);
        return;
      }

      await sendAlert(`🛡️ *[${tokenName}]* güvenlik taraması...`);
      const safety = await checkSafety(pool);
      if (!safety.safe) {
        await sendAlert(`🚨 *[${tokenName}]* RİSK, işlem iptal.\nSebep: \`${safety.reason}\``);
        return;
      }

      await sendAlert(`🚀 *[${tokenName}]* kontroller tamam (fiyat etkisi %${(safety.impact * 100).toFixed(1)}, al-sat %${(safety.roundTrip * 100).toFixed(0)}). Alım sıraya alındı...`);

      const buy = await enqueue(() => executeBuy(safety.token, safety.sim));
      if (!buy.success) {
        await sendAlert(`❌ *[${tokenName}]* alım başarısız: \`${buy.error}\``);
        return;
      }

      activePositions.set(poolAddress, {
        token: tokenName,
        tokenAddress: safety.token,
        poolAddress,
        dex,
        buyTon: BUY_AMOUNT_TON,
        tokenAmount: buy.tokenAmount.toString(),
        openedAt: Date.now()
      });
      saveState();

      await sendAlert(`✅ *[${tokenName}]* pozisyon açıldı${buy.dryRun ? ' (TEST, gerçek işlem yok)' : ''}! ${BUY_AMOUNT_TON} TON\n🎯 +%${TAKE_PROFIT_PCT} | 🛑 -%${STOP_LOSS_PCT}`);
    } catch (err) {
      console.error('handleNewPool hatası:', err);
      await sendAlert(`❌ [${tokenName}] hata: \`${err.message}\``);
    }
  }, WAIT_TIME_SECONDS * 1000);
}

async function scanDex(name, url, listPicker) {
  try {
    const data = await retry(() => httpGet(url));
    const pools = listPicker(data);
    if (!Array.isArray(pools)) return;
    if (isFirstRun) {
      pools.forEach(p => p && p.address && knownPools.add(p.address));
      return;
    }
    for (const pool of pools) {
      if (!pool || !pool.address || knownPools.has(pool.address)) continue;
      pool.dex = name;
      await handleNewPool(pool);
    }
  } catch (e) {
    console.error(`${name} tarama hatası:`, e.message);
  }
}

async function checkAllPools() {
  if (isPolling) return;
  isPolling = true;
  try {
    await scanDex('STON.fi', 'https://api.ston.fi/v1/pools', d => d && (d.pool_list || d.pools || d));
    await sleep(2000);
    await scanDex('DeDust.io', 'https://api.dedust.io/v2/pools', d => d);

    if (isFirstRun) {
      isFirstRun = false;
      await sendAlert(`✅ *Sniper Bot Aktif*\nMod: ${DRY_RUN ? 'TEST (DRY_RUN)' : 'GERÇEK'}\nMin likidite: $${MIN_LIQUIDITY_USD}\nBekleme: ${WAIT_TIME_SECONDS}sn\nTarama: ${POLL_INTERVAL_MS / 1000}sn\n\nKomutlar: /bakiye /pozisyonlar`);
    }
    saveState();
  } finally {
    isPolling = false;
  }
}

// ---------- Başlat ----------
if ([TG_TOKEN, MNEMONIC_PHRASE, TONCENTER_KEY, TG_CHAT_ID].some(v => String(v).includes('BURAYA'))) {
  console.error('Ayarların başındaki *_BURAYA yazan değerleri doldurmadın!');
  process.exit(1);
}

loadState();
initClient().then(() => {
  setInterval(checkAllPools, POLL_INTERVAL_MS);
  setInterval(monitorPositions, MONITOR_INTERVAL_MS);
  checkAllPools();
}).catch(err => {
  console.error('Başlatma hatası:', err);
  process.exit(1);
});

process.on('uncaughtException', (err) => console.error('Yakalanamayan hata:', err));
process.on('unhandledRejection', (err) => console.error('Yakalanamayan Promise reddi:', err));
FirstRun = false;
      await sendAlert(`✅ *Sniper Bot Aktif (429 Korumalı & Tam Sürüm)* \n- Min Likidite: $${MIN_LIQUIDITY_USD}\n- Bekleme Süresi: ${WAIT_TIME_SECONDS}sn\n- Tarama Sıklığı: Her 10 saniye\n\nBakiye için \`/bakiye\` yazabilirsiniz.`);
    }

  } catch (error) {}
}

initClient().then(() => {
  setInterval(checkAllPools, 10000);
  checkAllPools();
});

process.on('uncaughtException', (err) => {
  console.error('Yakalanamayan hata:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('Yakalanamayan Promise reddi:', err);
});
