// ============================================================================
// 背离扫描 · 独立脚本（跑在 GitHub Actions 上，不依赖浏览器）
// ----------------------------------------------------------------------------
// 这个脚本是把网站里"背离扫描 DIVERGENCE SCAN"模块的核心算法（MACD Pivot 配对 +
// 零轴容忍机制）原样搬到 Node.js 里，用同一套 Twelve Data Key，对 8 个货币依次
// 扫描，遇到新的"Confirmed Divergence"（或主/次周期共振）就发 Telegram 消息。
//
// 目前只实现了和网站现在【已经在跑】的那一套算法（Pivot + 零轴容忍），不包含
// EMA52 靠近度 / 青色·红色能量柱这些【还没最终确认量化标准】的规则——等那些标准
// 定下来了，再同步加到这里和网站两边。
// ============================================================================

const TWELVE_DATA_KEY = process.env.TWELVE_DATA_API_KEY;
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!TWELVE_DATA_KEY) { console.error('缺少 TWELVE_DATA_API_KEY'); process.exit(1); }
if (!TG_TOKEN || !TG_CHAT_ID) { console.error('缺少 TELEGRAM_BOT_TOKEN 或 TELEGRAM_CHAT_ID'); process.exit(1); }

// ---------------------------------------------------------------------------
// 品种列表：7 个主要货币对 + XAUUSD（排在下面），和网站 SYMBOL_PRESETS 保持一致
// ---------------------------------------------------------------------------
const SYMBOLS = [
  { label: 'AUDCHF', query: 'AUD/CHF' },
  { label: 'AUDUSD', query: 'AUD/USD' },
  { label: 'NZDUSD', query: 'NZD/USD' },
  { label: 'GBPJPY', query: 'GBP/JPY' },
  { label: 'GBPCAD', query: 'GBP/CAD' },
  { label: 'GBPCHF', query: 'GBP/CHF' },
  { label: 'EURUSD', query: 'EUR/USD' },
  { label: 'XAUUSD', query: 'XAU/USD' },
];

// ---------------------------------------------------------------------------
// 时间周期配置（和网站 MA_TIMEFRAMES / MA_BASE_SPECS 完全一致）
// ---------------------------------------------------------------------------
const MACD_FAST = 12, MACD_SLOW = 26, MACD_SIGNAL = 9;
const PIVOT_STRENGTH = 3;

const MA_TIMEFRAMES = [
  { label: '3M',  minutes: 3,   base: 'm1' },
  { label: '5M',  minutes: 5,   base: 'm1' },
  { label: '7M',  minutes: 7,   base: 'm1' },
  { label: '10M', minutes: 10,  base: 'm1' },
  { label: '12M', minutes: 12,  base: 'm1' },
  { label: '15M', minutes: 15,  base: 'm15' },
  { label: '20M', minutes: 20,  base: 'm1' },
  { label: '23M', minutes: 23,  base: 'm1' },
  { label: '30M', minutes: 30,  base: 'm30' },
  { label: '40M', minutes: 40,  base: 'm1' },
  { label: '45M', minutes: 45,  base: 'm45' },
  { label: '1H',  minutes: 60,  base: 'h1' },
  { label: '90M', minutes: 90,  base: 'm45' },
  { label: '2H',  minutes: 120, base: 'h2' },
  { label: '3H',  minutes: 180, base: 'h1' },
  { label: '4H',  minutes: 240, base: 'h4' },
  { label: '6H',  minutes: 360, base: 'h2' },
];

const MA_BASE_SPECS = {
  m1:  { interval: '1min',  outputsize: 5000, sec: 60 },
  m15: { interval: '15min', outputsize: 2000, sec: 900 },
  m30: { interval: '30min', outputsize: 2000, sec: 1800 },
  m45: { interval: '45min', outputsize: 2000, sec: 2700 },
  h1:  { interval: '1h',    outputsize: 2000, sec: 3600 },
  h2:  { interval: '2h',    outputsize: 1500, sec: 7200 },
  h4:  { interval: '4h',    outputsize: 1200, sec: 14400 },
};

function secondaryLabelsFor(label) {
  const tf = MA_TIMEFRAMES.find(t => t.label === label);
  if (!tf) return [];
  const doubleMin = tf.minutes * 2, halfMin = tf.minutes / 2;
  return MA_TIMEFRAMES.filter(o => o.label !== label && (o.minutes === doubleMin || o.minutes === halfMin)).map(o => o.label);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// 拉取一个原生周期
// ---------------------------------------------------------------------------
async function fetchBase(query, key) {
  const spec = MA_BASE_SPECS[key];
  const url = 'https://api.twelvedata.com/time_series?symbol=' + encodeURIComponent(query) +
    '&interval=' + spec.interval + '&outputsize=' + spec.outputsize +
    '&timezone=UTC&apikey=' + encodeURIComponent(TWELVE_DATA_KEY);
  const res = await fetch(url);
  const data = await res.json();
  if (data.status === 'error' || !data.values) throw new Error(data.message || ('请求失败：' + key));
  return data.values.map(v => {
    const s = v.datetime;
    const t = Date.UTC(
      +s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10),
      s.length > 10 ? +s.slice(11, 13) : 0, s.length > 10 ? +s.slice(14, 16) : 0
    ) / 1000;
    return { t, c: parseFloat(v.close) };
  }).reverse();
}

// ---------------------------------------------------------------------------
// EMA / MACD / Pivot / 背离 —— 和网站里的算法逐行对应
// ---------------------------------------------------------------------------
function emaSeries(values, period) {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) { prev = values[i] * k + prev * (1 - k); out[i] = prev; }
  return out;
}

function aggregate(baseArr, minutes, baseIntervalSec) {
  if (!baseArr || !baseArr.length) return [];
  const bucketSec = minutes * 60;
  const map = new Map();
  for (const pt of baseArr) { const bStart = Math.floor(pt.t / bucketSec) * bucketSec; map.set(bStart, pt.c); }
  const keys = Array.from(map.keys()).sort((a, b) => a - b);
  const lastBaseTime = baseArr[baseArr.length - 1].t;
  const coverageEnd = lastBaseTime + baseIntervalSec;
  return keys.map(k => ({ t: k, c: map.get(k), closed: (k + bucketSec) <= coverageEnd }));
}

function computeMacdSeries(closes) {
  if (closes.length < MACD_SLOW + MACD_SIGNAL + 5) return null;
  const fastE = emaSeries(closes, MACD_FAST);
  const slowE = emaSeries(closes, MACD_SLOW);
  const macdFull = closes.map((_, i) => (fastE[i] != null && slowE[i] != null) ? fastE[i] - slowE[i] : null);
  const macdValsOnly = [], idxMap = [];
  macdFull.forEach((v, i) => { if (v != null) { macdValsOnly.push(v); idxMap.push(i); } });
  if (!macdValsOnly.length) return null;
  const sigE = emaSeries(macdValsOnly, MACD_SIGNAL);
  const signalFull = new Array(closes.length).fill(null);
  sigE.forEach((v, j) => { if (v != null) signalFull[idxMap[j]] = v; });
  return { macd: macdFull, signal: signalFull };
}

function findPivots(macd, strength) {
  const n = macd.length, pivots = [];
  for (let i = strength; i < n; i++) {
    if (macd[i] == null) continue;
    let isPeak = true, isValley = true;
    for (let k = 1; k <= strength; k++) {
      const l = macd[i - k];
      if (l == null) { isPeak = false; isValley = false; break; }
      if (l >= macd[i]) isPeak = false;
      if (l <= macd[i]) isValley = false;
    }
    if (!isPeak && !isValley) continue;
    const rightAvailable = (i + strength) < n;
    for (let k = 1; k <= strength && rightAvailable; k++) {
      const r = macd[i + k];
      if (r == null) { isPeak = false; isValley = false; break; }
      if (r >= macd[i]) isPeak = false;
      if (r <= macd[i]) isValley = false;
    }
    if (isPeak) pivots.push({ idx: i, type: 'peak', confirmed: rightAvailable });
    if (isValley) pivots.push({ idx: i, type: 'valley', confirmed: rightAvailable });
  }
  return pivots;
}

function detectDivergence(series, closes, strength) {
  const pivots = findPivots(series.macd, strength);
  const peaks = pivots.filter(p => p.type === 'peak');
  const valleys = pivots.filter(p => p.type === 'valley');
  const ZERO_AXIS_TOLERANCE_BARS = 2;

  function zeroAxisOk(i1, i2, wantPositive) {
    let streak = 0, maxStreak = 0;
    for (let i = i1 + 1; i < i2; i++) {
      const m = series.macd[i], s = series.signal[i];
      const breach = wantPositive ? ((m != null && m < 0) || (s != null && s < 0)) : ((m != null && m > 0) || (s != null && s > 0));
      if (breach) { streak++; maxStreak = Math.max(maxStreak, streak); } else streak = 0;
    }
    return maxStreak <= ZERO_AXIS_TOLERANCE_BARS;
  }

  function findPair(list, wantPositive, isBearish) {
    const recent = list.slice(-6);
    for (let j = recent.length - 1; j >= 1; j--) {
      const p2 = recent[j];
      const m2 = series.macd[p2.idx], s2 = series.signal[p2.idx];
      if (wantPositive ? !(m2 > 0 && s2 > 0) : !(m2 < 0 && s2 < 0)) continue;
      for (let i = j - 1; i >= 0; i--) {
        const p1 = recent[i];
        const m1 = series.macd[p1.idx], s1 = series.signal[p1.idx];
        if (wantPositive ? !(m1 > 0 && s1 > 0) : !(m1 < 0 && s1 < 0)) continue;
        if (!zeroAxisOk(p1.idx, p2.idx, wantPositive)) continue;
        const priceOk = isBearish ? (closes[p2.idx] > closes[p1.idx]) : (closes[p2.idx] < closes[p1.idx]);
        const macdOk = isBearish ? (m2 < m1) : (m2 > m1);
        if (priceOk && macdOk) return { p1, p2 };
      }
    }
    return null;
  }

  if (peaks.length >= 2) { const pair = findPair(peaks, true, true); if (pair) return { type: 'bearish', confirmed: pair.p2.confirmed, p2idx: pair.p2.idx }; }
  if (valleys.length >= 2) { const pair = findPair(valleys, false, false); if (pair) return { type: 'bullish', confirmed: pair.p2.confirmed, p2idx: pair.p2.idx }; }
  return null;
}

// ---------------------------------------------------------------------------
// 每个货币：拉 7 个原生周期 -> 合并出 17 个 timeframe -> 逐个跑背离检测
// ---------------------------------------------------------------------------
async function scanSymbol(sym, reqDelayMs) {
  const bases = {};
  for (const key of Object.keys(MA_BASE_SPECS)) {
    try {
      bases[key] = await fetchBase(sym.query, key);
    } catch (e) {
      console.error(sym.label, key, '拉取失败：', e.message);
    }
    await sleep(reqDelayMs);
  }
  const results = {};
  for (const tf of MA_TIMEFRAMES) {
    const baseArr = bases[tf.base];
    if (!baseArr) continue;
    const baseSec = MA_BASE_SPECS[tf.base].sec;
    const buckets = aggregate(baseArr, tf.minutes, baseSec).filter(b => b.closed);
    const minNeeded = MACD_SLOW + MACD_SIGNAL + PIVOT_STRENGTH * 2 + 6;
    if (buckets.length < minNeeded) continue;
    const closes = buckets.map(b => b.c);
    const series = computeMacdSeries(closes);
    if (!series) continue;
    const div = detectDivergence(series, closes, PIVOT_STRENGTH);
    if (div) results[tf.label] = div;
  }
  return results;
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------
async function sendTelegram(text) {
  const url = 'https://api.telegram.org/bot' + encodeURIComponent(TG_TOKEN) + '/sendMessage';
  try {
    const res = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text }),
    });
    const data = await res.json();
    if (!data.ok) console.error('Telegram 发送失败：', data.description);
  } catch (e) { console.error('Telegram 请求异常：', e.message); }
}

function sessionTag() {
  const h = (new Date().getUTCHours() + 8) % 24; // MYT = UTC+8
  if (h >= 15 && h < 20) return '[LONDON]';
  if (h >= 20 || h < 3) return '[NY]';
  return '';
}

// ---------------------------------------------------------------------------
// state.json：记录"上次已经通知过"的信号，避免同一个信号持续存在时反复刷屏
// ---------------------------------------------------------------------------
import { readFile, writeFile } from 'node:fs/promises';
const STATE_PATH = new URL('../data/divergence-state.json', import.meta.url);

async function loadState() {
  try { return JSON.parse(await readFile(STATE_PATH, 'utf8')); } catch { return {}; }
}
async function saveState(state) {
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2));
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main() {
  // 8 个货币 × 7 个原生周期 = 56 次请求，免费版 8次/分钟，这里用 8 秒的间隔
  // （60/8=7.5s，留一点余量），跑完一整轮大约 56*8s ≈ 7.5 分钟。
  const REQ_DELAY_MS = 8000;
  const state = await loadState();
  const tag = sessionTag();
  const notifyLines = [];

  for (const sym of SYMBOLS) {
    console.log('扫描 ' + sym.label + ' ...');
    const results = await scanSymbol(sym, REQ_DELAY_MS);

    for (const tf of MA_TIMEFRAMES) {
      const div = results[tf.label];
      const stateKey = sym.label + '|' + tf.label;
      if (!div || !div.confirmed) {
        // 没有背离，或者只是潜在背离（不是 confirmed）：清掉上次通知记录，
        // 这样下次再出现同类型 confirmed 信号时会重新提醒一次
        if (state[stateKey]) delete state[stateKey];
        continue;
      }
      if (state[stateKey] === div.type) continue; // 信号没变化，不重复发
      state[stateKey] = div.type;
      const label = div.type === 'bullish' ? '底背离(下跌结束)' : '顶背离(上涨结束)';
      notifyLines.push((sym.icon || '💱') + ' ' + sym.label + ' ' + tag + ' ' + tf.label + ' ' + label);
    }

    // 主/次周期共振（×2 或 ÷2 精确匹配，且类型一致）
    for (const tf of MA_TIMEFRAMES) {
      const div = results[tf.label];
      if (!div || !div.confirmed) continue;
      for (const secLabel of secondaryLabelsFor(tf.label)) {
        const secDiv = results[secLabel];
        if (!secDiv || !secDiv.confirmed || secDiv.type !== div.type) continue;
        const pairKey = [tf.label, secLabel].sort().join('+');
        const stateKey = sym.label + '|MEGA|' + pairKey;
        if (state[stateKey] === div.type) continue;
        state[stateKey] = div.type;
        const label = div.type === 'bullish' ? '底背离共振(下跌结束)' : '顶背离共振(上涨结束)';
        notifyLines.push('⚠️ ' + (sym.icon || '💱') + ' ' + sym.label + ' ' + tag + ' ' + pairKey + ' ' + label);
      }
    }
  }

  if (notifyLines.length) {
    console.log('发送 Telegram：\n' + notifyLines.join('\n'));
    await sendTelegram(notifyLines.join('\n'));
  } else {
    console.log('本轮没有新的 confirmed 背离信号。');
  }

  await saveState(state);
}

main().catch(e => { console.error('脚本出错：', e); process.exit(1); });
