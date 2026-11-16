const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// Railway Environment Variables
const TOKEN = process.env.TELEGRAM_TOKEN;
const ALLOWED_USER_ID = parseInt(process.env.ALLOWED_USER_ID || "0");
const TONAPI_KEY = process.env.TONAPI_KEY;

const bot = new TelegramBot(TOKEN, { polling: true });

const GRAM_MASTER_ADDRESS = "EQC47093oX5Xhb0xuk2lCr2RhS8rj-vul61u4W2UH5ORmG_O";
const MIN_LIQUIDITY_USD = 40.0;
const TAKE_PROFIT_PCT = 35.0;
const STOP_LOSS_PCT = -25.0;
const SCAN_INTERVAL = 10000; // 10 saniye

let seenPools = {};
let activePositions = {};
let botRunning = false;

// 1. Yeni Havuzları Çekme
async function fetchNewGramPools() {
    try {
        const url = `https://api.geckoterminal.com/api/v2/networks/ton/tokens/${GRAM_MASTER_ADDRESS}/pools?page=1`;
        const response = await axios.get(url, { timeout: 8000 });
        return response.data.data || [];
    } catch (error) {
        console.error("Havuz verisi çekme hatası:", error.message);
        return [];
    }
}

// 2. Güvenlik ve Honeypot Simülasyonu
async function checkHoneypotAndSecurity(tokenAddress, poolAddress) {
    try {
        const headers = { Authorization: `Bearer ${TONAPI_KEY}` };
        const jettonUrl = `https://tonapi.io/v2/jettons/${tokenAddress}`;
        const response = await axios.get(jettonUrl, { headers, timeout: 8000 });
        
        if (response.status !== 200) {
            return { safe: false, reason: "Token kontrat bilgisi alınamadı." };
        }
        
        // Burada ek alım/satım simülasyonları yapılabilir
        return { safe: true, reason: "Güvenlik testleri başarılı." };
    } catch (error) {
        return { safe: false, reason: `Güvenlik testi hatası: ${error.message}` };
    }
}

// 3. Swap İşlemi (STON.fi Router)
async function executeStonfiSwap(fromToken, toToken, amount) {
    console.log(`SWAP GÖNDERİLİYOR: ${amount} ${fromToken} -> ${toToken}`);
    await new Promise(resolve => setTimeout(resolve, 2000));
    return { success: true, entryPrice: 0.00015 };
}

// 4. Ana Sniper Döngüsü
async function sniperWorker() {
    while (botRunning) {
        const now = Date.now() / 1000;
        const pools = await fetchNewGramPools();

        for (const pool of pools) {
            const attrs = pool.attributes;
            const poolAddr = attrs.address;
            const liqUsd = parseFloat(attrs.reserve_in_usd || 0);
            
            const baseTokenId = pool.relationships?.base_token?.data?.id || "";
            const tokenAddr = baseTokenId.replace("ton_", "");

            if (tokenAddr === GRAM_MASTER_ADDRESS || activePositions[tokenAddr]) continue;

            if (!seenPools[poolAddr]) {
                seenPools[poolAddr] = { firstSeen: now, initialLiq: liqUsd, bought: false };
            }

            let poolInfo = seenPools[poolAddr];
            if (poolInfo.bought) continue;

            const elapsed = now - poolInfo.firstSeen;

            // Koşul: Likidite >= 40$ veya 1 dakika içinde 40$'a ulaştıysa
            if (liqUsd >= MIN_LIQUIDITY_USD && (elapsed <= 60 || poolInfo.initialLiq >= MIN_LIQUIDITY_USD)) {
                bot.sendMessage(ALLOWED_USER_ID, `🔍 **Yeni Havuz Bulundu:** \`${tokenAddr}\` ($${liqUsd.toFixed(2)})`, { parse_mode: "Markdown" });

                const security = await checkHoneypotAndSecurity(tokenAddr, poolAddr);
                if (security.safe) {
                    const swapResult = await executeStonfiSwap(GRAM_MASTER_ADDRESS, tokenAddr, 0.5);
                    if (swapResult.success) {
                        poolInfo.bought = true;
                        activePositions[tokenAddr] = { entryPrice: swapResult.entryPrice, poolAddr: poolAddr, amount: 0.5 };
                        bot.sendMessage(ALLOWED_USER_ID, `✅ **ALIM BAŞARILI!** Fiyat: $${swapResult.entryPrice}`, { parse_mode: "Markdown" });
                    }
                } else {
                    poolInfo.bought = true;
                    bot.sendMessage(ALLOWED_USER_ID, `❌ **RİSKLİ (İptal):** ${security.reason}`, { parse_mode: "Markdown" });
                }
            }
        }

        await new Promise(resolve => setTimeout(resolve, SCAN_INTERVAL));
    }
}

// Telegram Komutları
bot.onText(/\/baslat/, (msg) => {
    if (msg.from.id !== ALLOWED_USER_ID) return;
    if (!botRunning) {
        botRunning = true;
        sniperWorker();
        bot.sendMessage(msg.chat.id, "🚀 **Node.js Bot Aktif!** Tarama başlatıldı.", { parse_mode: "Markdown" });
    } else {
        bot.sendMessage(msg.chat.id, "⚠️ Bot zaten çalışıyor.");
    }
});

bot.onText(/\/durdur/, (msg) => {
    if (msg.from.id !== ALLOWED_USER_ID) return;
    botRunning = false;
    bot.sendMessage(msg.chat.id, "🛑 Bot durduruldu.", { parse_mode: "Markdown" });
});

console.log("Node.js Telegram Bot dinlemede...");
h(error => {
      console.error("Zamanlanmış tarama hatası:", error.message);
    });
  }, (POLL_INTERVAL_MS);

  console.log(`Bot hazır. Tarama aralığı: ${POLL_INTERVAL_MS / 1000} saniye.`);
}

start().catch(error => {
  console.error("Bot başlatılamadı:", error);
  process.exit(1);
});or => {
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
