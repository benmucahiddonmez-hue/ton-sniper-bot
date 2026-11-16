// Kurulum: npm i node-telegram-bot-api @ton/ton @ton/core @ton/crypto @ston-fi/sdk @ston-fi/api
const TelegramBot = require('node-telegram-bot-api');
const { TonClient, WalletContractV4, internal, beginCell, Address, toNano, fromNano } = require('@ton/ton');
const { mnemonicToPrivateKey } = require('@ton/crypto');
const https = require('https');
const fs = require('fs');

// ================= AYARLAR (Dolduruldu) =================
const TG_TOKEN = "9161821033:AAGJuqOFm0YeaQ57DgSagjGB6eSfw-8Xc7k";
const TG_CHAT_ID = "15658"; // Sadece bu sohbet komut verebilir
const MNEMONIC_PHRASE = "Dignity artefact rapid catalog wool lounge arctic cricket grocery best cause garbage message rapid artwork sphere hybrid mass harbor spell prize walnut pink ethics";
const TONCENTER_KEY = "fa0dcf2b6a22aa02db88e34f19b22e1b12b32279165b4c19ef6d48342795fbb0"; // Toncenter API Key eklendi

// true: gerçek işlem YOK, "kağıt üstünde" (paper) çalışır. İlk testleri böyle yap.
const DRY_RUN = true;

const MIN_LIQUIDITY_USD = 40;      // likidite alanı okunabiliyorsa uygulanır
const MAX_PRICE_IMPACT = 0.05;     // 0.5 TON'luk alımda max %5 fiyat etkisi (likidite yetersizliği göstergesi)
const MIN_ROUNDTRIP = 0.85;        // al-sat simülasyonunda geri dönen oran bunun altındaysa riskli
const SLIPPAGE = "0.05";           // %5
const WAIT_TIME_SECONDS = 60;
const BUY_AMOUNT_TON = 0.5;
const TON_RESERVE = 0.3;           // cüzdanda gas için hep bırakılacak TON
const TAKE_PROFIT_PCT = 50;
const STOP_LOSS_PCT = 30;
const MAX_OPEN_POSITIONS = 3;
const POLL_INTERVAL_MS = 20000;    // yeni havuz taraması
const MONITOR_INTERVAL_MS = 30000; // TP/SL kontrolü
const STATE_FILE = './state.json';
// ================================================================

let bot = null;
try {
  bot = new TelegramBot(TG_TOKEN, { polling: true });
} catch (e) {
  console.error("Bot başlatılamadı:", e.message);
}

let knownPools = new Set();
let activePositions = new Map();
let isFirstRun = true;
let tonClient = null;
let stonClient = null;
let apiClient = null;
let dexFactory = null;
let walletCache = null;
let isPolling = false;
let isMonitoring = false;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- Kalıcı durum ----------
function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    knownPools = new Set(s.knownPools || []);
    activePositions = new Map(Object.entries(s.positions || {}));
    if (knownPools.size > 0) isFirstRun = false;
    console.log(`Durum yüklendi: ${knownPools.size} havuz, ${activePositions.size} pozisyon`);
  } catch (e) {}
}
function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      knownPools: [...knownPools],
      positions: Object.fromEntries(activePositions)
    }));
  } catch (e) {
    console.error('State kaydedilemedi:', e.message);
  }
}

// ---------- Yardımcılar ----------
async function retry(fn, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      const is429 = String(e && e.message).includes('429') ||
                    (e && e.response && e.response.status === 429);
      if (!is429 || i === tries - 1) throw e;
      await sleep(1000 * 2 ** i);
    }
  }
}

// İşlemleri sırayla çalıştırır (seqno çakışması ve 429 önlenir)
let txQueue = Promise.resolve();
function enqueue(fn) {
  const run = txQueue.then(fn, fn);
  txQueue = run.catch(() => {});
  return run;
}

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', ...headers }, timeout: 8000 }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        if (res.statusCode === 429) return reject(new Error('Request failed with status code 429'));
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('JSON parse hatası')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Zaman aşımı')); });
  });
}

async function sendAlert(message) {
  if (!bot || !TG_CHAT_ID) return;
  try {
    await bot.sendMessage(TG_CHAT_ID, message, { parse_mode: 'Markdown', disable_web_page_preview: true });
  } catch (err) {
    // Markdown bozulduysa düz metin gönder
    try { await bot.sendMessage(TG_CHAT_ID, message.replace(/[*_`]/g, '')); }
    catch (e2) { console.error('Telegram mesajı gönderilemedi:', e2.message); }
  }
}

// ---------- TON / STON.fi başlatma ----------
async function initClient() {
  tonClient = new TonClient({
    endpoint: 'https://toncenter.com/api/v2/jsonRPC',
    apiKey: TONCENTER_KEY
  });

  // @ston-fi paketleri ESM olabilir, o yüzden dinamik import
  const sdk = await import('@ston-fi/sdk');
  const api = await import('@ston-fi/api');
  dexFactory = sdk.dexFactory;
  stonClient = new sdk.Client({
    endpoint: 'https://toncenter.com/api/v2/jsonRPC',
    apiKey: TONCENTER_KEY
  });
  apiClient = new api.StonApiClient();
  console.log("TON ve STON.fi istemcileri başlatıldı.");
}

async function getWallet() {
  if (walletCache) return walletCache;
  const words = MNEMONIC_PHRASE.trim().split(/\s+/);
  if (words.length < 12) throw new Error(`Mnemonic eksik! (Bulunan: ${words.length} kelime)`);
  const keyPair = await mnemonicToPrivateKey(words);
  const wc = WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey });
  walletCache = { wallet: tonClient.open(wc), secretKey: keyPair.secretKey };
  return walletCache;
}

// Mesajı gönderir, seqno artana kadar bekler
async function sendTx(txParams) {
  const { wallet, secretKey } = await getWallet();
  const seqno = await retry(() => wallet.getSeqno());
  await retry(() => wallet.sendTransfer({
    seqno,
    secretKey,
    messages: [internal({ to: txParams.to, value: txParams.value, body: txParams.body, bounce: true })]
  }));
  for (let i = 0; i < 20; i++) {
    await sleep(3000);
    const cur = await retry(() => wallet.getSeqno());
    if (cur > seqno) return true;
  }
  throw new Error('İşlem zincire girmedi (seqno artmadı)');
}

// ---------- Jeton okuma ----------
async function getJettonInfo(masterAddr) {
  const res = await retry(() => tonClient.runMethod(Address.parse(masterAddr), 'get_jetton_data'));
  const totalSupply = res.stack.readBigNumber();
  const mintable = res.stack.readBigNumber() !== 0n;
  let admin = null;
  try { admin = res.stack.readAddressOpt(); } catch (e) { admin = null; }
  return { totalSupply, mintable, admin };
}

async function getJettonBalance(masterAddr, ownerAddress) {
  const r1 = await retry(() => tonClient.runMethod(
    Address.parse(masterAddr),
    'get_wallet_address',
    [{ type: 'slice', cell: beginCell().storeAddress(ownerAddress).endCell() }]
  ));
  const jettonWallet = r1.stack.readAddress();
  try {
    const r2 = await retry(() => tonClient.runMethod(jettonWallet, 'get_wallet_data'));
    return r2.stack.readBigNumber();
  } catch (e) {
    return 0n; // jeton cüzdanı henüz oluşmadı
  }
}

// ---------- STON.fi simülasyon ----------
function simulate(offerAddress, askAddress, offerUnits) {
  return retry(() => apiClient.simulateSwap({
    offerAddress,
    askAddress,
    offerUnits: offerUnits.toString(),
    slippageTolerance: SLIPPAGE
  }));
}

// Havuzdaki iki tokendan TON olmayanı bulur (simülasyonu çalışan adres)
async function resolveToken(pool) {
  const cands = [pool.token0_address, pool.token1_address].filter(Boolean);
  for (const c of cands) {
    try {
      const sim = await simulate('ton', c, toNano(BUY_AMOUNT_TON.toString()));
      if (sim && sim.askUnits && BigInt(sim.askUnits) > 0n) return { token: c, sim };
    } catch (e) {
      console.error(`resolveToken (${c.substring(0, 6)}...):`, e.message);
    }
  }
  return null;
}

// ---------- Güvenlik kontrolü ----------
async function checkSafety(pool) {
  try {
    const resolved = await resolveToken(pool);
    if (!resolved) return { safe: false, reason: "Token bulunamadı / simülasyon çalışmadı." };
    const { token, sim } = resolved;

    // 1) Likidite göstergesi: fiyat etkisi
    const impact = Number(sim.priceImpact || 0);
    if (impact > MAX_PRICE_IMPACT) {
      return { safe: false, reason: `Fiyat etkisi yüksek (%${(impact * 100).toFixed(1)}), likidite yetersiz.` };
    }

    // 2) Jeton sahibi yeni token basabiliyor mu?
    let info;
    try {
      info = await getJettonInfo(token);
    } catch (e) {
      return { safe: false, reason: `Jeton verisi okunamadı: ${e.message}` };
    }
    if (info.mintable && info.admin) {
      return { safe: false, reason: "Yönetici hâlâ yeni jeton basabiliyor (mint yetkisi açık)." };
    }

    // 3) Al-sat simülasyonu: alınan jeton geri satılırsa ne kadar TON döner?
    const sellSim = await simulate(token, 'ton', BigInt(sim.askUnits));
    const back = Number(BigInt(sellSim.askUnits)) / Number(toNano(BUY_AMOUNT_TON.toString()));
    if (back < MIN_ROUNDTRIP) {
      return { safe: false, reason: `Al-sat simülasyonunda sadece %${(back * 100).toFixed(0)} geri dönüyor.` };
    }

    return { safe: true, token, sim, roundTrip: back, impact };
  } catch (err) {
    return { safe: false, reason: `Güvenlik kontrolü başarısız: ${err.message}` };
  }
}

// ---------- Alım ----------
async function executeBuy(token, sim) {
  try {
    const { wallet } = await getWallet();
    const balTon = Number(fromNano(await retry(() => tonClient.getBalance(wallet.address))));
    if (balTon < BUY_AMOUNT_TON + TON_RESERVE) {
      return { success: false, error: `Yetersiz bakiye (${balTon.toFixed(2)} TON)` };
    }

    if (DRY_RUN) return { success: true, tokenAmount: BigInt(sim.askUnits), dryRun: true };

    const routerInfo = sim.router;
    const contracts = dexFactory(routerInfo);
    const router = stonClient.open(contracts.Router.create(routerInfo.address));
    const proxyTon = contracts.pTON.create(routerInfo.ptonMasterAddress);

    const txParams = await router.getSwapTonToJettonTxParams({
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
