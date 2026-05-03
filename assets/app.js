const state = {
  sheet: "Sheet2",
  target: 0.08,
  assumptionMode: "data",
  includeDynamicBacktest: true,
  calcTimer: null,
  calcGeneration: 0,
  covCache: new Map(),
  weightCache: new Map(),
  stressResult: null,
  stressWorker: null,
  selected: new Set(),
  metrics: null,
  result: null,
  navHoverIndex: null,
  weightHoverIndex: null,
  riskHoverIndex: null,
  rollingHoverIndex: null,
  views: {},
};

const RISK_FREE_RATE = 0.0173;
const coreNames = new Set([
  "中债综合指数",
  "招商股票市场中性私募指数",
  "火富牛套利策略精选指数",
  "招商CTA私募指数",
  "火富牛期货主观精选指数",
  "上证红利指数",
  "沪深300",
  "火富牛中证1000指增精选指数",
]);

const palette = [
  "#733B73", "#F55654", "#F99551", "#FFD58C", "#91B87C", "#427C80",
  "#2F1A4C", "#636AA2", "#2597A6", "#EC9884", "#C57284", "#8E1D22",
  "#DB8F59", "#929456", "#87490D", "#EAA919", "#588393"
];
const categoryColors = {
  "??": { bg: "rgba(245, 86, 84, 0.13)", fg: "#A73434" },
  "??": { bg: "rgba(145, 184, 124, 0.18)", fg: "#4F7E42" },
  "??": { bg: "rgba(115, 59, 115, 0.13)", fg: "#733B73" },
  "??": { bg: "rgba(249, 149, 81, 0.16)", fg: "#A95F24" },
  "CTA": { bg: "rgba(66, 124, 128, 0.14)", fg: "#2E6D71" },
  "??": { bg: "rgba(255, 213, 140, 0.28)", fg: "#956B22" },
  "FOF": { bg: "rgba(115, 59, 115, 0.10)", fg: "#624062" },
  "??": { bg: "rgba(100, 116, 139, 0.12)", fg: "#475569" },
};

function assetColor(name, index = 0) {
  if (name.includes("??")) return "#FFD58C";
  if (name.includes("??")) return "#F55654";
  if (name.includes("?")) return "#91B87C";
  if (name.includes("??")) return "#733B73";
  if (name.includes("CTA") || name.includes("??")) return "#427C80";
  if (name.includes("??")) return "#F99551";
  if (name.includes("??300")) return "#636AA2";
  if (name.includes("??500")) return "#2597A6";
  if (name.includes("??1000")) return "#DB8F59";
  return palette[index % palette.length];
}
const $ = (id) => document.getElementById(id);
const pct = (x, d = 1) => `${(x * 100).toFixed(d)}%`;


function benchmarkInfo() {
  const sheet = getSheet();
  let index = sheet.headers.findIndex((h) => h.includes("沪深300"));
  let fallback = false;
  if (index < 0) {
    index = sheet.headers.findIndex((h) => h.includes("上证综指") || h.includes("上证指数") || h.includes("上证综合"));
    fallback = true;
  }
  if (index < 0) return null;
  return { index, name: sheet.headers[index], fallback };
}

function benchmarkNavs() {
  const info = benchmarkInfo();
  if (!info || !state.metrics) return null;
  const returns = state.metrics.returns.map((row) => row[info.index]);
  return { ...info, navs: maxDrawdown(returns).navs };
}

function navDisplayRange() {
  const r = state.result;
  if (!r || !r.dates.length) return { start: 0, end: 0 };
  const startMonth = $("navStart")?.value;
  const endMonth = $("navEnd")?.value;
  let start = startMonth ? r.dates.findIndex((d) => d.slice(0, 7) >= startMonth) : 0;
  let end = endMonth ? r.dates.findLastIndex((d) => d.slice(0, 7) <= endMonth) : r.dates.length - 1;
  if (start < 0) start = 0;
  if (end < 0) end = r.dates.length - 1;
  if (end < start) end = start;
  return { start, end };
}

function rollingDisplayRange() {
  const r = state.result;
  if (!r || !r.dates.length) return { start: 0, end: 0 };
  const fallback = navDisplayRange();
  const startMonth = $("rollingStart")?.value;
  const endMonth = $("rollingEnd")?.value;
  let start = startMonth ? r.dates.findIndex((d) => d.slice(0, 7) >= startMonth) : fallback.start;
  let end = endMonth ? r.dates.findLastIndex((d) => d.slice(0, 7) <= endMonth) : fallback.end;
  if (start < 0) start = fallback.start;
  if (end < 0) end = fallback.end;
  if (end < start) end = start;
  return { start, end };
}

function sliceSeries(arr, range) {
  return arr.slice(range.start, range.end + 1);
}

function rangeEndWeights() {
  const r = state.result;
  if (!r || !r.weightTimeline.length) return null;
  const range = navDisplayRange();
  return r.weightTimeline[Math.min(range.end, r.weightTimeline.length - 1)]?.weights || r.w;
}

function syncMonthlyRangeToNav() {
  const r = state.result;
  if (!r) return;
  const range = navDisplayRange();
  const startMonth = r.dates[range.start]?.slice(0, 7);
  const endMonth = r.dates[range.end]?.slice(0, 7);
  if ($("rangeStart") && startMonth) $("rangeStart").value = startMonth;
  if ($("rangeEnd") && endMonth) $("rangeEnd").value = endMonth;
}

function rebaseNavs(navs) {
  if (!navs.length) return [];
  const base = navs[0] || 1;
  return navs.map((v) => v / base);
}

function statsFromReturns(returns) {
  if (!returns.length) return { ret: 0, annReturn: 0, vol: 0, mdd: 0, sharpe: null, recoveryDays: 0, var95: 0 };
  const ret = returns.reduce((v, r) => v * (1 + r), 1) - 1;
  const annReturn = cagr(returns);
  const vol = stdev(returns) * Math.sqrt(252);
  const dd = maxDrawdown(returns);
  const mdd = dd.worst;
  const sharpe = vol > 0 ? (annReturn - RISK_FREE_RATE) / vol : null;
  return { ret, annReturn, vol, mdd, sharpe, recoveryDays: maxDrawdownRecoveryDays(dd.navs), var95: historicalVar95(returns) };
}

function categoryOf(name) {
  if (name.includes("债")) return "固收";
  if (name.includes("CTA") || name.includes("期货")) return "CTA";
  if (name.includes("中性")) return "中性";
  if (name.includes("套利")) return "套利";
  if (name.includes("指增")) return "指增";
  if (name.includes("红利") || name.includes("沪深") || name.includes("中证") || name.includes("创业") || name.includes("科创")) return "权益";
  if (name.includes("FOF")) return "FOF";
  return "复合";
}

function isEquityLike(name) {
  return ["权益", "指增"].includes(categoryOf(name));
}

function isCtaLike(name) {
  return categoryOf(name) === "CTA";
}

function isBond(name) {
  return categoryOf(name) === "固收";
}

function isPrudentMode() {
  return state.assumptionMode === "prudent";
}

function prudentVolFloors() {
  const read = (id, fallback) => {
    const value = Number($(id)?.value);
    return Number.isFinite(value) ? value / 100 : fallback;
  };
  return {
    "固收": read("floorBond", 0.04),
    "中性": read("floorNeutral", 0.07),
    "套利": read("floorArb", 0.05),
    "CTA": read("floorCta", 0.12),
    "权益": read("floorEquity", 0.25),
    "指增": read("floorEquity", 0.25),
  };
}

function effectiveAssetVol(assetIndex) {
  const historical = state.metrics?.asset?.[assetIndex]?.annVol ?? 0;
  if (!isPrudentMode()) return historical;
  const category = categoryOf(getSheet().headers[assetIndex]);
  return Math.max(historical, prudentVolFloors()[category] ?? historical);
}

function getSheet() {
  return window.FOF_DATA[state.sheet];
}

function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / Math.max(1, arr.length);
}

function stdev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1));
}

function cagr(returns) {
  if (!returns.length) return 0;
  const nav = returns.reduce((v, r) => v * (1 + r), 1);
  return nav ** (252 / returns.length) - 1;
}

function maxDrawdown(returns) {
  let nav = 1;
  let peak = 1;
  let worst = 0;
  const navs = [];
  const dds = [];
  for (const r of returns) {
    nav *= 1 + r;
    peak = Math.max(peak, nav);
    const dd = nav / peak - 1;
    worst = Math.min(worst, dd);
    navs.push(nav);
    dds.push(dd);
  }
  return { worst, navs, dds };
}

function maxDrawdownRecoveryDays(navs) {
  if (!navs.length) return 0;
  let peak = navs[0];
  let peakIndex = 0;
  let worst = 0;
  let troughIndex = 0;
  let peakAtWorst = navs[0];
  navs.forEach((nav, i) => {
    if (nav > peak) {
      peak = nav;
      peakIndex = i;
    }
    const dd = nav / peak - 1;
    if (dd < worst) {
      worst = dd;
      troughIndex = i;
      peakAtWorst = peak;
    }
  });
  if (worst === 0) return 0;
  const recovered = navs.findIndex((nav, i) => i > troughIndex && nav >= peakAtWorst);
  return recovered >= 0 ? recovered - troughIndex : navs.length - 1 - troughIndex;
}

function historicalVar95(returns) {
  if (!returns.length) return 0;
  const sorted = [...returns].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(sorted.length * 0.05) - 1);
  return Math.max(0, -sorted[index]);
}

function selectedRiskMode() {
  return $("riskMode")?.value || "covariance";
}

function covarianceMatrix(rows, idx, mode = "covariance") {
  const n = rows.length;
  const m = idx.length;
  if (n < 2 || m === 0) return Array.from({ length: m }, () => Array(m).fill(0));
  if (mode === "semivariance") {
    return idx.map((a) => idx.map((b) => {
      const daily = rows.reduce((s, row) => s + Math.min(row[a], 0) * Math.min(row[b], 0), 0) / (n - 1);
      return daily * 252;
    }));
  }
  const means = idx.map((col) => mean(rows.map((r) => r[col])));
  return idx.map((a, i) => idx.map((b, j) => {
    const daily = rows.reduce((s, row) => s + (row[a] - means[i]) * (row[b] - means[j]), 0) / (n - 1);
    return daily * 252;
  }));
}

function correlationMatrix(rows, idx) {
  const cov = covarianceMatrix(rows, idx);
  return cov.map((row, i) => row.map((v, j) => {
    const denom = Math.sqrt(Math.max(1e-12, cov[i][i] * cov[j][j]));
    return v / denom;
  }));
}

function effectiveCovarianceMatrix(rows, idx, mode = selectedRiskMode()) {
  const key = covarianceCacheKey(rows, idx, mode);
  if (state.covCache.has(key)) return state.covCache.get(key);
  const cov = covarianceMatrix(rows, idx, mode);
  if (!isPrudentMode()) {
    state.covCache.set(key, cov);
    return cov;
  }
  const corr = cov.map((row, i) => row.map((v, j) => {
    if (i === j) return 1;
    const denom = Math.sqrt(Math.max(1e-12, cov[i][i] * cov[j][j]));
    return Math.max(-0.99, Math.min(0.99, v / denom));
  }));
  const vols = idx.map((assetIndex, i) => {
    const hist = Math.sqrt(Math.max(0, cov[i][i]));
    return Math.max(hist, effectiveAssetVol(assetIndex));
  });
  const adjusted = corr.map((row, i) => row.map((value, j) => value * vols[i] * vols[j]));
  state.covCache.set(key, adjusted);
  return adjusted;
}

function covarianceCacheKey(rows, idx, mode) {
  const floors = isPrudentMode()
    ? ["floorBond", "floorNeutral", "floorArb", "floorCta", "floorEquity"].map((id) => $(id)?.value).join("/")
    : "data";
  return [
    state.sheet,
    state.assumptionMode,
    floors,
    mode,
    rows.length,
    idx.join("-"),
    rows[0]?.[idx[0]]?.toFixed(6) || "0",
    rows.at(-1)?.[idx.at(-1)]?.toFixed(6) || "0",
  ].join("|");
}

function clearComputationCache() {
  state.covCache.clear();
}

function optimizationSignature(idx) {
  const viewSig = idx.map((col) => {
    const name = getSheet().headers[col];
    const saved = state.views[name] || {};
    return `${col}:${saved.ret || ""}/${saved.dd || ""}`;
  }).join(",");
  const floors = ["floorBond", "floorNeutral", "floorArb", "floorCta", "floorEquity"].map((id) => $(id)?.value || "").join("/");
  return [
    state.sheet,
    state.target.toFixed(4),
    $("modelType")?.value,
    $("riskMode")?.value,
    $("rebalanceFreq")?.value,
    $("lookbackWindow")?.value,
    $("maxWeight")?.value,
    $("bondFloor")?.value,
    $("equityCap")?.value,
    isPrudentMode() ? "fast" : "balanced",
    state.assumptionMode,
    floors,
    idx.join("-"),
    viewSig,
  ].join("|");
}

function portfolioVolatility(w, cov) {
  if (!w || !cov || !w.length) return 0;
  const variance = w.reduce((s, x, i) => {
    return s + x * w.reduce((inner, y, j) => inner + y * (cov[i]?.[j] ?? 0), 0);
  }, 0);
  return Math.sqrt(Math.max(0, variance));
}

function displayedPortfolioVol(result, range = null) {
  if (!result) return 0;
  if (!isPrudentMode()) return result.annVol;
  const rows = range ? sliceSeries(state.metrics.returns, range) : state.metrics.returns;
  const weights = range ? (rangeEndWeights() || result.w) : result.w;
  const cov = effectiveCovarianceMatrix(rows, result.idx, selectedRiskMode());
  return portfolioVolatility(weights, cov);
}

function displayedRangeStats(rangeReturns, range) {
  const stats = statsFromReturns(rangeReturns);
  if (!isPrudentMode() || !state.result) return stats;
  const vol = displayedPortfolioVol(state.result, range);
  return {
    ...stats,
    vol,
    sharpe: vol > 0 ? (stats.annReturn - RISK_FREE_RATE) / vol : null,
  };
}

function computeMetrics() {
  const sheet = getSheet();
  const returns = [];
  for (let t = 1; t < sheet.values.length; t += 1) {
    returns.push(sheet.values[t].map((v, i) => v / sheet.values[t - 1][i] - 1));
  }
  const cols = sheet.headers.map((_, i) => returns.map((r) => r[i]));
  const asset = sheet.headers.map((name, i) => ({
    name,
    category: categoryOf(name),
    annReturn: cagr(cols[i]),
    annVol: stdev(cols[i]) * Math.sqrt(252),
    mdd: maxDrawdown(cols[i]).worst,
    dailyVar95: historicalVar95(cols[i]),
  }));
  const allIdx = sheet.headers.map((_, i) => i);
  const cov = covarianceMatrix(returns, allIdx);
  const corr = correlationMatrix(returns, allIdx);
  return { returns, cols, asset, cov, corr };
}

function selectedIdx() {
  const sheet = getSheet();
  return [...state.selected].map((name) => sheet.headers.indexOf(name)).filter((i) => i >= 0);
}

function randomWeights(n) {
  const xs = Array.from({ length: n }, () => -Math.log(Math.max(1e-9, Math.random())));
  const sum = xs.reduce((a, b) => a + b, 0);
  return xs.map((x) => x / sum);
}

function normalizeWithCaps(weights, maxWeight) {
  let w = weights.slice();
  for (let pass = 0; pass < 10; pass += 1) {
    let excess = 0;
    const free = [];
    w = w.map((x, i) => {
      if (x > maxWeight) {
        excess += x - maxWeight;
        return maxWeight;
      }
      free.push(i);
      return x;
    });
    const freeSum = free.reduce((s, i) => s + w[i], 0);
    if (excess < 1e-8 || freeSum <= 0) break;
    for (const i of free) w[i] += excess * (w[i] / freeSum);
  }
  const sum = w.reduce((a, b) => a + b, 0);
  return w.map((x) => x / Math.max(1e-12, sum));
}

function groupWeight(w, idx, predicate) {
  const sheet = getSheet();
  return w.reduce((s, x, k) => s + (predicate(sheet.headers[idx[k]]) ? x : 0), 0);
}

function applyGroupCap(w, idx, predicate, cap, maxWeight) {
  const sheet = getSheet();
  const inGroup = idx.map((col) => predicate(sheet.headers[col]));
  const current = w.reduce((s, x, i) => s + (inGroup[i] ? x : 0), 0);
  if (current <= cap || current <= 0) return w;
  const scale = cap / current;
  let excess = 0;
  const next = w.map((x, i) => {
    if (!inGroup[i]) return x;
    const capped = x * scale;
    excess += x - capped;
    return capped;
  });
  for (let pass = 0; pass < 8 && excess > 1e-8; pass += 1) {
    const receivers = next.map((x, i) => (!inGroup[i] && x < maxWeight - 1e-8 ? i : -1)).filter((i) => i >= 0);
    const room = receivers.reduce((s, i) => s + Math.max(0, maxWeight - next[i]), 0);
    if (!receivers.length || room <= 0) break;
    const add = Math.min(excess, room);
    receivers.forEach((i) => {
      const roomShare = Math.max(0, maxWeight - next[i]) / room;
      next[i] += add * roomShare;
    });
    excess -= add;
  }
  const sum = next.reduce((s, x) => s + x, 0);
  return sum > 0 ? next.map((x) => x / sum) : next;
}

function constrainedWeights(idx, weights) {
  const { maxWeight, typeCap } = constraints();
  let w = normalizeWithCaps(weights, maxWeight);
  for (let pass = 0; pass < 4; pass += 1) {
    w = applyGroupCap(w, idx, isCtaLike, typeCap, maxWeight);
    w = applyGroupCap(w, idx, isEquityLike, typeCap, maxWeight);
    w = normalizeWithCaps(w, maxWeight);
  }
  return w;
}

function constraints() {
  return {
    maxWeight: Number($("maxWeight").value) / 100,
    bondFloor: Number($("bondFloor").value) / 100,
    typeCap: Number($("equityCap").value) / 100,
  };
}

function estimateAssetReturns(rows, idx, fallbackAssetReturns) {
  return idx.map((col, k) => {
    const series = rows.map((r) => r[col]);
    const est = cagr(series);
    return Number.isFinite(est) ? est : fallbackAssetReturns[k];
  });
}

function portfolioReturn(row, idx, w) {
  return w.reduce((s, x, k) => s + x * row[idx[k]], 0);
}

function readViews(idx) {
  const sheet = getSheet();
  return idx.map((col) => {
    const name = sheet.headers[col];
    const saved = state.views[name] || {};
    const retInput = $(`view-ret-${col}`);
    const ddInput = $(`view-dd-${col}`);
    const retRaw = retInput ? retInput.value : saved.ret;
    const ddRaw = ddInput ? ddInput.value : saved.dd;
    const ret = retRaw === "" || retRaw === undefined ? null : Number(retRaw) / 100;
    const dd = ddRaw === "" || ddRaw === undefined ? null : Math.abs(Number(ddRaw) / 100);
    return {
      name,
      ret: Number.isFinite(ret) ? ret : null,
      dd: Number.isFinite(dd) ? dd : null,
    };
  });
}

function expectedReturnsByModel(idx, estimateRows, fallbackReturns) {
  const model = $("modelType").value;
  const historyReturns = estimateAssetReturns(estimateRows, idx, fallbackReturns);
  const views = readViews(idx);
  if (model !== "blackLitterman") return historyReturns;
  return historyReturns.map((prior, i) => views[i].ret === null ? prior : prior * 0.4 + views[i].ret * 0.6);
}

function viewDrawdownPenalty(w, idx) {
  const views = readViews(idx);
  const weightedExpectedDrawdown = w.reduce((s, x, i) => {
    const fallback = effectiveAssetVol(idx[i]);
    return s + x * (views[i].dd ?? fallback);
  }, 0);
  return weightedExpectedDrawdown * 0.18;
}

function riskParityScore(w, cov) {
  const contributions = riskContributions(w, cov);
  if (!contributions.length) return 999;
  const target = 1 / w.length;
  return contributions.reduce((s, x) => s + (x - target) ** 2, 0);
}

function riskContributions(w, cov) {
  const marginal = w.map((_, i) => w.reduce((s, x, j) => s + x * cov[i][j], 0));
  const portVar = w.reduce((s, x, i) => s + x * marginal[i], 0);
  if (portVar <= 1e-12) return w.map(() => 0);
  const raw = w.map((x, i) => Math.max(0, x * marginal[i] / portVar));
  const sum = raw.reduce((a, b) => a + b, 0);
  return sum > 0 ? raw.map((x) => x / sum) : w.map(() => 0);
}

function optimizationTrials(options = {}) {
  const n = options.n || selectedIdx().length || 8;
  const mode = isPrudentMode() ? "fast" : "balanced";
  const base = {
    fast: options.fast ? 1600 : 5200,
    balanced: options.fast ? 3200 : 11000,
    fine: options.fast ? 7200 : 26000,
  }[mode] || 5200;
  const cap = {
    fast: options.fast ? 6000 : 18000,
    balanced: options.fast ? 12000 : 36000,
    fine: options.fast ? 20000 : 60000,
  }[mode] || 18000;
  return Math.min(cap, Math.max(options.fast ? 1800 : 6000, n * base));
}

function solveWeights(idx, estimateRows, fallbackReturns, options = {}) {
  const sheet = getSheet();
  const n = idx.length;
  if (n < 2) return null;
  const { maxWeight, bondFloor, typeCap } = constraints();
  const model = $("modelType").value;
  const assetReturns = expectedReturnsByModel(idx, estimateRows, fallbackReturns);
  const cov = effectiveCovarianceMatrix(estimateRows, idx, selectedRiskMode());
  const trials = optimizationTrials({ ...options, n });
  let best = null;

  for (let t = 0; t < trials; t += 1) {
    const w = constrainedWeights(idx, randomWeights(n));
    const bondWeight = groupWeight(w, idx, isBond);
    const ctaWeight = groupWeight(w, idx, isCtaLike);
    const equityWeight = groupWeight(w, idx, isEquityLike);
    if (bondWeight < bondFloor || ctaWeight > typeCap || equityWeight > typeCap) continue;

    const expRet = w.reduce((s, x, k) => s + x * assetReturns[k], 0);
    let variance = 0;
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) variance += w[i] * w[j] * cov[i][j];
    }
    const vol = Math.sqrt(Math.max(0, variance));
    const miss = Math.abs(expRet - state.target);
    const ddPenalty = viewDrawdownPenalty(w, idx);
    const score = model === "riskParity"
      ? riskParityScore(w, cov) * 4 + vol * 0.35 + ddPenalty
      : vol + miss * 3.2 + Math.max(0, state.target - expRet) * 1.8 + ddPenalty;
    if (!best || score < best.score) best = { idx, w, expRet, vol, score };
  }

  if (!best) {
    const w = constrainedWeights(idx, Array.from({ length: n }, () => 1 / n));
    const expRet = w.reduce((s, x, k) => s + x * assetReturns[k], 0);
    return { idx, w, expRet, vol: 0, score: 999 };
  }
  return best;
}

function isRebalanceDate(prevDate, date, freq) {
  if (!prevDate) return true;
  if (freq === "Q") return quarterKey(prevDate) !== quarterKey(date);
  return prevDate.slice(0, 7) !== date.slice(0, 7);
}

function quarterKey(dateText) {
  const d = new Date(`${dateText}T00:00:00`);
  return `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`;
}

function runDynamicBacktest(staticSolution) {
  const sheet = getSheet();
  const metrics = state.metrics;
  const idx = staticSolution.idx;
  const lookback = Number($("lookbackWindow").value);
  const freq = $("rebalanceFreq").value;
  const fallbackReturns = idx.map((i) => metrics.asset[i].annReturn);
  const portReturns = [];
  const dates = sheet.dates.slice(1);
  const weightTimeline = [];
  const riskTimeline = [];
  const rebalancePoints = [];
  let current = { idx, w: constrainedWeights(idx, Array.from({ length: idx.length }, () => 1 / idx.length)) };
  let prevDate = null;

  for (let t = 0; t < metrics.returns.length; t += 1) {
    const date = dates[t];
    const start = Math.max(0, t - lookback);
    const enoughHistory = t >= Math.min(lookback, 60);
    if (enoughHistory && isRebalanceDate(prevDate, date, freq)) {
      const rows = metrics.returns.slice(start, t);
      const cacheKey = `${optimizationSignature(idx)}|${start}-${t}`;
      if (state.weightCache.has(cacheKey)) {
        const cached = state.weightCache.get(cacheKey);
        current = { idx, w: cached.w.slice(), expRet: cached.expRet, vol: cached.vol };
      } else {
        current = solveWeights(idx, rows, fallbackReturns, { fast: true }) || current;
        if (state.weightCache.size > 800) state.weightCache.clear();
        state.weightCache.set(cacheKey, { w: current.w.slice(), expRet: current.expRet, vol: current.vol });
      }
      const cov = effectiveCovarianceMatrix(rows, idx, selectedRiskMode());
      const risk = riskContributions(current.w, cov);
      prevDate = date;
      rebalancePoints.push({ date, weights: current.w.slice(), risk });
      riskTimeline.push({ date, contributions: risk });
    }
    const r = portfolioReturn(metrics.returns[t], idx, current.w);
    portReturns.push(r);
    weightTimeline.push({ date, weights: current.w.slice() });
  }

  const dd = maxDrawdown(portReturns);
  const years = yearlyReturns(dates, portReturns);
  const months = monthlyReturns(dates, portReturns);
  const positive = years.filter((y) => y.ret > 0).length / Math.max(1, years.length);
  const stressCorr = buildStressCorr(portReturns, idx);

  return {
    portReturns,
    dates,
    navs: dd.navs,
    drawdowns: dd.dds,
    mdd: dd.worst,
    years,
    months,
    positive,
    annReturn: cagr(portReturns),
    annVol: stdev(portReturns) * Math.sqrt(252),
    weightTimeline,
    riskTimeline,
    rebalancePoints,
    stressCorr,
  };
}

function runStaticBacktest(staticSolution) {
  const sheet = getSheet();
  const metrics = state.metrics;
  const idx = staticSolution.idx;
  const weights = staticSolution.w.slice();
  const portReturns = metrics.returns.map((row) => portfolioReturn(row, idx, weights));
  const dates = sheet.dates.slice(1);
  const navData = maxDrawdown(portReturns);
  const cov = effectiveCovarianceMatrix(metrics.returns, idx, selectedRiskMode());
  const risk = riskContributions(weights, cov);
  const weightTimeline = dates.map((date) => ({ date, weights: weights.slice() }));
  const riskTimeline = dates.map((date) => ({ date, contributions: risk.slice() }));
  return {
    idx,
    w: weights,
    portReturns,
    dates,
    navs: navData.navs,
    drawdowns: navData.dds,
    mdd: navData.worst,
    years: yearlyReturns(dates, portReturns),
    months: monthlyReturns(dates, portReturns),
    positive: yearlyReturns(dates, portReturns).filter((y) => y.ret > 0).length / Math.max(1, yearlyReturns(dates, portReturns).length),
    annReturn: cagr(portReturns),
    annVol: stdev(portReturns) * Math.sqrt(252),
    weightTimeline,
    riskTimeline,
    rebalancePoints: [{ date: dates[0], weights: weights.slice(), risk }],
    stressCorr: buildStressCorr(portReturns, idx),
    isStaticPreview: true,
  };
}

function buildStressCorr(portReturns, idx) {
  const threshold = portReturns.slice().sort((a, b) => a - b)[Math.max(0, Math.floor(portReturns.length * 0.1) - 1)];
  const rows = state.metrics.returns.filter((_, i) => portReturns[i] <= threshold);
  return correlationMatrix(rows, idx);
}

function optimize() {
  const idx = selectedIdx();
  if (idx.length < 2) return null;
  const fallbackReturns = idx.map((i) => state.metrics.asset[i].annReturn);
  const staticSolution = solveWeights(idx, state.metrics.returns, fallbackReturns);
  if (!staticSolution) return null;
  const dynamic = state.includeDynamicBacktest ? runDynamicBacktest(staticSolution) : runStaticBacktest(staticSolution);
  return { ...staticSolution, ...dynamic };
}

function yearlyReturns(dates, returns) {
  const byYear = {};
  dates.forEach((d, i) => {
    const y = d.slice(0, 4);
    if (!byYear[y]) byYear[y] = [];
    byYear[y].push(returns[i]);
  });
  return Object.entries(byYear).map(([year, rows]) => ({
    year,
    ret: rows.reduce((nav, value) => nav * (1 + value), 1) - 1,
    mdd: maxDrawdown(rows).worst,
    vol: stdev(rows) * Math.sqrt(252),
  }));
}

function monthlyReturns(dates, returns) {
  const byMonth = {};
  dates.forEach((d, i) => {
    const m = d.slice(0, 7);
    byMonth[m] = (byMonth[m] ?? 1) * (1 + returns[i]);
  });
  return Object.entries(byMonth).map(([month, nav]) => ({ month, ret: nav - 1 }));
}

function renderSheetSwitch() {
  const box = $("sheetSwitch");
  box.innerHTML = "";
  Object.keys(window.FOF_DATA).forEach((name) => {
    const btn = document.createElement("button");
    btn.textContent = name === "Sheet2" ? "核心池" : "全资产池";
    btn.className = name === state.sheet ? "active" : "";
    btn.onclick = () => {
      state.sheet = name;
      resetSelection();
      refreshAll();
    };
    box.appendChild(btn);
  });
}

function resetSelection() {
  const sheet = getSheet();
  state.selected = new Set(sheet.headers.filter((h) => state.sheet === "Sheet2" || coreNames.has(h)));
}

function renderAssetList() {
  const sheet = getSheet();
  const list = $("assetList");
  list.innerHTML = "";
  sheet.headers.forEach((name) => {
    const item = document.createElement("label");
    item.className = "asset-item";
    item.title = name;
    item.innerHTML = `
      <input type="checkbox" ${state.selected.has(name) ? "checked" : ""} />
      <span class="asset-name">${name}</span>
      <span class="tag" style="--tag-bg:${categoryColors[categoryOf(name)]?.bg || categoryColors["??"].bg};--tag-fg:${categoryColors[categoryOf(name)]?.fg || categoryColors["??"].fg}">${categoryOf(name)}</span>
    `;
    item.querySelector("input").onchange = (e) => {
      if (e.target.checked) state.selected.add(name);
      else state.selected.delete(name);
      renderViewInputs();
      scheduleRefreshCalc(120);
    };
    list.appendChild(item);
  });
}

function renderViewInputs() {
  const sheet = getSheet();
  const box = $("viewInputs");
  const idx = selectedIdx();
  box.innerHTML = `
    <div class="view-row header">
      <span>资产</span>
      <span>预期收益%</span>
      <span>预期波动率%</span>
    </div>
  `;
  idx.forEach((col) => {
    const name = sheet.headers[col];
    const saved = state.views[name] || {};
    const fallbackRet = state.metrics ? (state.metrics.asset[col].annReturn * 100).toFixed(1) : "";
    const fallbackDd = state.metrics ? (effectiveAssetVol(col) * 100).toFixed(1) : "";
    const row = document.createElement("label");
    row.className = "view-row";
    row.title = name;
    row.innerHTML = `
      <span>${shortName(name)}</span>
      <input id="view-ret-${col}" type="number" step="0.5" value="${saved.ret ?? ""}" placeholder="${fallbackRet}" />
      <input id="view-dd-${col}" type="number" step="0.5" value="${saved.dd ?? ""}" placeholder="${fallbackDd}" />
    `;
    row.querySelectorAll("input").forEach((input) => {
      input.onchange = () => {
        state.views[name] = {
          ret: $(`view-ret-${col}`).value,
          dd: $(`view-dd-${col}`).value,
        };
        scheduleRefreshCalc();
      };
    });
    box.appendChild(row);
  });
}

function renderKpis() {
  const r = state.result;
  const vol = displayedPortfolioVol(r);
  const sharpe = r && vol > 0 ? (r.annReturn - RISK_FREE_RATE) / vol : null;
  $("kpiReturn").textContent = r ? pct(r.annReturn) : "--";
  $("kpiVol").textContent = r ? pct(vol) : "--";
  $("kpiMdd").textContent = r ? pct(r.mdd) : "--";
  $("kpiSharpe").textContent = sharpe === null ? "--" : sharpe.toFixed(2);
  $("kpiPositive").textContent = r ? pct(r.positive, 0) : "--";
}

function renderLogic() {
  const freq = $("rebalanceFreq").value === "M" ? "月度" : "季度";
  const lookbackLabel = $("lookbackWindow").selectedOptions[0].textContent;
  const modelText = $("modelType").selectedOptions[0].textContent;
  const riskText = $("riskMode").selectedOptions[0].textContent;
  const model = $("modelType").value;
  const backtestText = isPrudentMode() ? "模拟压力测算" : "滚动调仓回测";
  const assumptionText = isPrudentMode()
    ? "模拟测算：保留历史相关性，并使用资产类别年化波动率下限"
    : "数据回看：使用历史收益、波动和相关性";
  const modelDetail = {
    history: "滚动估计预期收益和协方差，在满足约束后寻找贴近目标收益且波动较低的权重",
    riskParity: "滚动估计风险矩阵，让各资产总风险贡献尽量均衡，并兼顾组合波动和约束",
    blackLitterman: "以历史收益为先验，叠加投资观点输入；未输入观点的资产继续使用历史先验",
  }[model];
  $("logicText").innerHTML = `采用 <span class="logic-param">${modelText}</span>：${modelDetail}。当前计算为 <span class="logic-param">${backtestText}</span>，风险假设为 <span class="logic-param">${assumptionText}</span>。在每个 <span class="logic-param">${freq}</span> 调仓日，用过去 <span class="logic-param">${lookbackLabel}</span> 数据和 <span class="logic-param">${riskText}</span> 风险口径重新估计组合；约束为单资产上限 <span class="logic-param">${$("maxWeight").value}%</span>、债券底仓下限 <span class="logic-param">${$("bondFloor").value}%</span>、CTA 与权益单类上限 <span class="logic-param">${$("equityCap").value}%</span>，目标收益 <span class="logic-param">${pct(state.target)}</span>。`;
}

function renderWeightChart() {
  const r = state.result;
  const canvas = $("weightChart");
  const ctx = setupCanvas(canvas, 300);
  if (!r) return;
  const weights = rangeEndWeights() || r.w;
  const rows = r.idx.map((idx, i) => ({ name: shortName(getSheet().headers[idx]), value: weights[i], color: assetColor(getSheet().headers[idx], i) })).sort((a, b) => b.value - a.value);
  drawBarChart(ctx, canvas, rows, { horizontal: true, valueFormatter: (v) => pct(v), min: 0, max: Math.max(0.4, ...rows.map((x) => x.value)), fontSize: 14, minBarHeight: 13, gap: 7, leftPad: 112, rightPad: 48 });
}

function renderCategoryPieChart() {
  const r = state.result;
  const canvas = $("categoryPieChart");
  const legend = $("categoryPieLegend");
  if (!canvas || !legend) return;
  const ctx = setupCanvas(canvas, 300);
  legend.innerHTML = "";
  if (!r) return;
  const rows = latestMonthCategoryWeights().filter((row) => row.value > 0.0001);
  drawPieChart(ctx, canvas, rows, { title: "策略占比", center: "100%" });
  renderPieLegend(legend, rows);
}

function renderPieLegend(legend, rows) {
  legend.innerHTML = "";
  rows.forEach((row) => {
    const item = document.createElement("div");
    item.innerHTML = `<span><i style="background:${row.color}"></i>${row.name}</span><strong>${pct(row.value)}</strong>`;
    legend.appendChild(item);
  });
}

function drawPieChart(ctx, canvas, rows, opts = {}) {
  const rect = canvas.getBoundingClientRect();
  const width = rect.width;
  const height = Number(canvas.getAttribute("height")) || 220;
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.max(58, Math.min(width, height) * (opts.radiusRatio || 0.42));
  const total = rows.reduce((s, row) => s + row.value, 0);
  if (total <= 0) return;
  let start = -Math.PI / 2;
  rows.forEach((row) => {
    const angle = (row.value / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, radius, start, start + angle);
    ctx.closePath();
    ctx.fillStyle = row.color;
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.stroke();
    start += angle;
  });
  ctx.beginPath();
  ctx.arc(cx, cy, radius * 0.48, 0, Math.PI * 2);
  ctx.fillStyle = "#fbfcfb";
  ctx.fill();
  ctx.fillStyle = "#26302b";
  ctx.font = `${opts.compact ? "600 13px" : "600 17px"} Microsoft YaHei, Arial`;
  ctx.textAlign = "center";
  ctx.fillText(opts.title || "占比", cx, cy - 2);
  ctx.fillStyle = "#6e7772";
  ctx.font = `${opts.compact ? 11 : 13}px Microsoft YaHei, Arial`;
  ctx.fillText(opts.center || "100%", cx, cy + 20);
  ctx.textAlign = "left";
}

function renderYearChart() {
  const r = state.result;
  const canvas = $("yearChart");
  const ctx = setupCanvas(canvas, 340);
  if (!r) return;
  drawYearMetricChart(ctx, canvas, r.years, r.dates.at(-1));
}

function yearLabel(year, lastDate) {
  return lastDate && year === lastDate.slice(0, 4) && !lastDate.endsWith("12-31") ? `${year}*` : year;
}

function drawYearMetricChart(ctx, canvas, years, lastDate) {
  const rect = canvas.getBoundingClientRect();
  const height = Number(canvas.getAttribute("height")) || 340;
  const pad = { l: 48, r: 18, t: 28, b: 44 };
  const w = rect.width - pad.l - pad.r;
  const h = height - pad.t - pad.b;
  const values = years.flatMap((row) => [row.ret, row.mdd, row.vol]);
  const max = Math.max(0.05, ...values);
  const min = Math.min(-0.05, ...values);
  const zeroY = pad.t + (1 - (0 - min) / Math.max(1e-9, max - min)) * h;
  drawGrid(ctx, pad, w, h, 5);
  ctx.strokeStyle = "rgba(23, 33, 28, 0.32)";
  ctx.beginPath();
  ctx.moveTo(pad.l, zeroY);
  ctx.lineTo(pad.l + w, zeroY);
  ctx.stroke();
  const groupW = w / Math.max(1, years.length);
  const barW = Math.max(8, Math.min(24, groupW * 0.18));
  const colors = {
    ret: "rgba(185, 28, 28, 0.86)",
    mdd: "rgba(21, 128, 61, 0.82)",
    vol: "rgba(30, 90, 168, 0.42)",
  };
  years.forEach((row, i) => {
    const cx = pad.l + i * groupW + groupW / 2;
    [
      { value: row.ret, color: colors.ret, offset: -barW * 1.15 },
      { value: row.mdd, color: colors.mdd, offset: 0 },
      { value: row.vol, color: colors.vol, offset: barW * 1.15 },
    ].forEach((bar) => {
      const y = pad.t + (1 - (bar.value - min) / Math.max(1e-9, max - min)) * h;
      ctx.fillStyle = bar.color;
      ctx.fillRect(cx + bar.offset - barW / 2, Math.min(y, zeroY), barW, Math.max(2, Math.abs(zeroY - y)));
    });
    ctx.fillStyle = "#6e7772";
    ctx.font = "11px Microsoft YaHei, Arial";
    ctx.textAlign = "center";
    ctx.fillText(yearLabel(row.year, lastDate), cx, height - 18);
  });
  ctx.textAlign = "left";
  ctx.fillStyle = colors.ret;
  ctx.fillRect(pad.l, 8, 10, 10);
  ctx.fillStyle = colors.mdd;
  ctx.fillRect(pad.l + 92, 8, 10, 10);
  ctx.fillStyle = colors.vol;
  ctx.fillRect(pad.l + 206, 8, 10, 10);
  ctx.fillStyle = "#39443e";
  ctx.font = "12px Microsoft YaHei, Arial";
  ctx.fillText("年度收益", pad.l + 14, 17);
  ctx.fillText("年度最大回撤", pad.l + 106, 17);
  ctx.fillText("年度波动率", pad.l + 220, 17);
  ctx.fillStyle = "#6e7772";
  ctx.fillText(pct(max), 8, pad.t + 4);
  ctx.fillText("0%", 14, zeroY + 4);
  ctx.fillText(pct(min), 8, pad.t + h);
}

function renderWeightTimeline() {
  const r = state.result;
  const canvas = $("weightTimelineChart");
  const ctx = setupCanvas(canvas, 310);
  $("weightLegend").innerHTML = "";
  if (!r) return;
  r.idx.forEach((idx, i) => {
    const item = document.createElement("span");
    item.innerHTML = `<i style="background:${assetColor(getSheet().headers[idx], i)}"></i>${shortName(getSheet().headers[idx])}`;
    $("weightLegend").appendChild(item);
  });

  const rect = canvas.getBoundingClientRect();
  const pad = { l: 44, r: 16, t: 18, b: 30 };
  const w = rect.width - pad.l - pad.r;
  const h = 310 - pad.t - pad.b;
  drawGrid(ctx, pad, w, h, 4);
  const range = navDisplayRange();
  const series = sliceSeries(r.weightTimeline, range);
  if (!series.length) return;
  if (r.isStaticPreview) {
    drawStaticPreviewNotice(ctx, pad, w, "当前为静态权重预览；点击“运行滚动回测”查看动态调仓。");
  }
  const step = Math.max(1, Math.floor(series.length / Math.max(80, rect.width / 7)));
  for (let t = 0; t < series.length; t += step) {
    const x = pad.l + (t / Math.max(1, series.length - 1)) * w;
    const nextT = Math.min(series.length - 1, t + step);
    const x2 = pad.l + (nextT / Math.max(1, series.length - 1)) * w;
    let top = pad.t + h;
    series[t].weights.forEach((weight, i) => {
      const bh = weight * h;
      ctx.fillStyle = assetColor(getSheet().headers[r.idx[i]], i);
      ctx.fillRect(x, top - bh, Math.max(1, x2 - x + 1), bh);
      top -= bh;
    });
  }
  if (state.weightHoverIndex !== null && series[state.weightHoverIndex]) {
    const x = pad.l + (state.weightHoverIndex / Math.max(1, series.length - 1)) * w;
    ctx.strokeStyle = "rgba(23, 33, 28, 0.36)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, pad.t);
    ctx.lineTo(x, pad.t + h);
    ctx.stroke();
  }
  ctx.fillStyle = "#6e7772";
  ctx.font = "12px Microsoft YaHei, Arial";
  ctx.fillText("100%", 6, pad.t + 4);
  ctx.fillText("0%", 14, pad.t + h);
  for (let i = 0; i <= 4; i += 1) {
    const idx = Math.round((series.length - 1) * (i / 4));
    const x = pad.l + (idx / Math.max(1, series.length - 1)) * w;
  ctx.fillText(series[idx].date.slice(0, 7), Math.min(x, pad.l + w - 42), 302);
  }
}

function renderRiskContributionChart() {
  const r = state.result;
  const canvas = $("riskContributionChart");
  const ctx = setupCanvas(canvas, 310);
  $("riskLegend").innerHTML = "";
  if (!r || !r.riskTimeline.length) return;
  r.idx.forEach((idx, i) => {
    const item = document.createElement("span");
    item.innerHTML = `<i style="background:${assetColor(getSheet().headers[idx], i)}"></i>${shortName(getSheet().headers[idx])}`;
    $("riskLegend").appendChild(item);
  });

  const rect = canvas.getBoundingClientRect();
  const pad = { l: 44, r: 16, t: 18, b: 30 };
  const w = rect.width - pad.l - pad.r;
  const h = 310 - pad.t - pad.b;
  const range = navDisplayRange();
  const startDate = r.dates[range.start];
  const endDate = r.dates[range.end];
  const series = r.riskTimeline.filter((p) => p.date >= startDate && p.date <= endDate);
  if (!series.length) return;
  drawGrid(ctx, pad, w, h, 4);
  if (r.isStaticPreview) {
    drawStaticPreviewNotice(ctx, pad, w, "当前为静态风险贡献预览；点击“运行滚动回测”查看动态风险贡献。");
  }
  const step = Math.max(1, Math.floor(series.length / Math.max(60, rect.width / 10)));
  for (let t = 0; t < series.length; t += step) {
    const x = pad.l + (t / Math.max(1, series.length - 1)) * w;
    const nextT = Math.min(series.length - 1, t + step);
    const x2 = pad.l + (nextT / Math.max(1, series.length - 1)) * w;
    let top = pad.t + h;
    series[t].contributions.forEach((value, i) => {
      const bh = value * h;
      ctx.fillStyle = assetColor(getSheet().headers[r.idx[i]], i);
      ctx.fillRect(x, top - bh, Math.max(1, x2 - x + 1), bh);
      top -= bh;
    });
  }
  if (state.riskHoverIndex !== null && series[state.riskHoverIndex]) {
    const x = pad.l + (state.riskHoverIndex / Math.max(1, series.length - 1)) * w;
    ctx.strokeStyle = "rgba(23, 33, 28, 0.36)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, pad.t);
    ctx.lineTo(x, pad.t + h);
    ctx.stroke();
  }
  ctx.fillStyle = "#6e7772";
  ctx.font = "12px Microsoft YaHei, Arial";
  ctx.fillText("100%", 6, pad.t + 4);
  ctx.fillText("0%", 14, pad.t + h);
  for (let i = 0; i <= 4; i += 1) {
    const idx = Math.round((series.length - 1) * (i / 4));
    const x = pad.l + (idx / Math.max(1, series.length - 1)) * w;
    ctx.fillText(series[idx].date.slice(0, 7), Math.min(x, pad.l + w - 42), 302);
  }
}

function drawStaticPreviewNotice(ctx, pad, w, text) {
  ctx.save();
  const boxWidth = Math.min(w - 16, 430);
  ctx.fillStyle = "rgba(255, 255, 255, 0.88)";
  ctx.fillRect(pad.l + 8, pad.t + 8, boxWidth, 34);
  ctx.strokeStyle = "rgba(234, 169, 25, 0.42)";
  ctx.strokeRect(pad.l + 8, pad.t + 8, boxWidth, 34);
  ctx.fillStyle = "#87490D";
  ctx.font = "12px Microsoft YaHei, Arial";
  ctx.fillText(text, pad.l + 18, pad.t + 30);
  ctx.restore();
}

function renderHeatmap(targetId, matrix) {
  const sheet = getSheet();
  const r = state.result;
  const box = $(targetId);
  box.innerHTML = "";
  if (!r) return;
  box.style.setProperty("--n", r.idx.length);
  box.appendChild(document.createElement("span"));
  r.idx.forEach((idx) => {
    const label = document.createElement("div");
    label.className = "heat-label";
    label.textContent = shortName(sheet.headers[idx]);
    box.appendChild(label);
  });
  r.idx.forEach((rowIdx, localRow) => {
    const rowLabel = document.createElement("div");
    rowLabel.className = "heat-label";
    rowLabel.textContent = shortName(sheet.headers[rowIdx]);
    box.appendChild(rowLabel);
    r.idx.forEach((_, localCol) => {
      const v = matrix[localRow]?.[localCol] ?? 0;
      const cell = document.createElement("div");
      cell.className = "heat-cell";
      cell.style.background = corrColor(v);
      cell.style.color = Math.abs(v) > 0.55 ? "#fff" : "#17211c";
      cell.textContent = Number.isFinite(v) ? v.toFixed(2) : "--";
      box.appendChild(cell);
    });
  });
}

function renderCorrelationPanels() {
  const r = state.result;
  if (!r) return;
  const range = navDisplayRange();
  const normalRows = sliceSeries(state.metrics.returns, range);
  const rangeReturns = sliceSeries(r.portReturns, range);
  renderHeatmap("corrHeatmap", correlationMatrix(normalRows, r.idx));
  renderHeatmap("stressCorrHeatmap", buildStressCorrFromRows(normalRows, rangeReturns, r.idx));
}

function buildStressCorrFromRows(rows, portReturns, idx) {
  if (!rows.length || !portReturns.length) return correlationMatrix(rows, idx);
  const threshold = portReturns.slice().sort((a, b) => a - b)[Math.max(0, Math.floor(portReturns.length * 0.1) - 1)];
  const stressRows = rows.filter((_, i) => portReturns[i] <= threshold);
  return correlationMatrix(stressRows.length ? stressRows : rows, idx);
}

function corrColor(v) {
  if (v >= 0) {
    const a = Math.min(1, v);
    return `rgba(199, 68, 62, ${0.12 + a * 0.78})`;
  }
  const a = Math.min(1, Math.abs(v));
  return `rgba(35, 130, 90, ${0.12 + a * 0.78})`;
}

function shortName(name) {
  return name.replace("火富牛", "").replace("招商", "").replace("精选指数", "").replace("私募指数", "");
}

function renderMonthlyGrid() {
  const r = state.result;
  const box = $("monthGrid");
  box.innerHTML = "";
  if (!r) return;
  const start = $("rangeStart").value || r.months[0]?.month;
  const end = $("rangeEnd").value || r.months.at(-1)?.month;
  const rows = r.months.filter((m) => (!start || m.month >= start) && (!end || m.month <= end));
  const maxAbs = Math.max(0.01, ...rows.map((m) => Math.abs(m.ret)));
  const byYear = {};
  rows.forEach((m) => {
    const year = m.month.slice(0, 4);
    if (!byYear[year]) byYear[year] = [];
    byYear[year].push(m);
  });
  Object.entries(byYear).forEach(([year, months]) => {
    const row = document.createElement("div");
    row.className = "month-year-row";
    row.innerHTML = `<div class="month-year-label">${year}</div><div class="month-cells"></div>`;
    const cells = row.querySelector(".month-cells");
    months.forEach((m) => {
      const cell = document.createElement("div");
      const intensity = Math.min(1, Math.abs(m.ret) / maxAbs);
      cell.className = `month-cell ${m.ret < 0 ? "loss" : "gain"}`;
      cell.style.setProperty("--alpha", 0.14 + intensity * 0.62);
      cell.innerHTML = `<span>${m.month.slice(5)}</span><strong>${pct(m.ret)}</strong>`;
      cells.appendChild(cell);
    });
    const total = months.reduce((v, m) => v * (1 + m.ret), 1) - 1;
    const totalCell = document.createElement("div");
    const totalIntensity = Math.min(1, Math.abs(total) / maxAbs);
    totalCell.className = `month-cell total ${total < 0 ? "loss" : "gain"}`;
    totalCell.style.setProperty("--alpha", 0.18 + totalIntensity * 0.62);
    totalCell.innerHTML = `<span>年度</span><strong>${pct(total)}</strong>`;
    cells.appendChild(totalCell);
    box.appendChild(row);
  });
  if (rows.length) {
    const total = rows.reduce((v, m) => v * (1 + m.ret), 1) - 1;
    const row = document.createElement("div");
    row.className = "month-year-row interval-total-row";
    row.innerHTML = `
      <div class="month-year-label">区间</div>
      <div class="month-cells">
        <div class="month-cell total ${total < 0 ? "loss" : "gain"}">
          <span>总收益</span><strong>${pct(total)}</strong>
        </div>
      </div>
    `;
    box.appendChild(row);
  }
}

function assetYearlyReturns(assetIndex) {
  const dates = getSheet().dates.slice(1);
  const returns = state.metrics.returns.map((row) => row[assetIndex]);
  return yearlyReturns(dates, returns);
}

function miniReturnCell(value, maxAbs) {
  const width = Math.max(3, Math.min(50, Math.abs(value) / Math.max(0.01, maxAbs) * 50));
  const cls = value < 0 ? "negative" : "positive";
  return `<div class="mini-return ${cls}"><span>${pct(value)}</span><i style="width:${width}%"></i></div>`;
}

function compoundReturns(returns) {
  return returns.reduce((v, ret) => v * (1 + ret), 1) - 1;
}

function rollingReturnSeries(period) {
  const r = state.result;
  if (!r) return [];
  const range = rollingDisplayRange();
  const navs = sliceSeries(r.navs, range);
  const dates = sliceSeries(r.dates, range);
  if (navs.length <= period) return [];
  const rows = [];
  for (let i = period; i < navs.length; i += 1) {
    rows.push({ date: dates[i], ret: navs[i] / navs[i - period] - 1 });
  }
  return rows;
}

function positiveRollingProbability(period) {
  const rows = rollingReturnSeries(period);
  if (!rows.length) return null;
  return rows.filter((row) => row.ret > 0).length / rows.length;
}

function latestMonthContributions() {
  const r = state.result;
  if (!r) return [];
  const range = navDisplayRange();
  const latestMonth = r.dates[range.end]?.slice(0, 7);
  if (!latestMonth) return [];
  const rangeDates = sliceSeries(r.dates, range);
  const monthKeys = [...new Set(rangeDates.map((date) => date.slice(0, 7)))];
  const recentMonths = monthKeys.slice(-3);
  const values = r.idx.map((idx, i) => ({
    name: shortName(getSheet().headers[idx]),
    color: assetColor(getSheet().headers[idx], i),
    value: 0,
    negativeMonths: 0,
  }));
  const monthValues = new Map(recentMonths.map((month) => [month, r.idx.map(() => 0)]));
  r.dates.forEach((date, t) => {
    if (t < range.start || t > range.end) return;
    const month = date.slice(0, 7);
    if (!recentMonths.includes(month)) return;
    const weights = r.weightTimeline[t]?.weights || r.w;
    r.idx.forEach((idx, i) => {
      monthValues.get(month)[i] += (weights[i] || 0) * (state.metrics.returns[t]?.[idx] || 0);
    });
  });
  const latestValues = monthValues.get(latestMonth) || [];
  values.forEach((row, i) => {
    row.value = latestValues[i] || 0;
    row.negativeMonths = recentMonths.reduce((count, month) => count + ((monthValues.get(month)?.[i] || 0) < 0 ? 1 : 0), 0);
  });
  return values.sort((a, b) => a.value - b.value);
}

function latestMonthCategoryWeights() {
  const r = state.result;
  if (!r) return [];
  const weights = rangeEndWeights() || r.w;
  const groups = new Map();
  r.idx.forEach((idx, i) => {
    const name = getSheet().headers[idx];
    const category = categoryOf(name);
    const current = groups.get(category) || { name: category, color: assetColor(name, i), value: 0 };
    current.value += weights[i] || 0;
    groups.set(category, current);
  });
  return [...groups.values()].sort((a, b) => b.value - a.value);
}

function renderReturnMonitoring() {
  const r = state.result;
  if (!r) return;
  renderYtdMonitor();
  renderMonthCategoryPieChart();
  renderContributionList();
  renderRollingProbability();
  drawRollingReturnChart();
}

function renderYtdMonitor() {
  const r = state.result;
  const box = $("ytdMonitorGrid");
  if (!box || !r) return;
  const latestDate = r.dates.at(-1);
  const year = latestDate?.slice(0, 4);
  const start = r.dates.findIndex((date) => date.slice(0, 4) === year);
  const ytd = start >= 0 ? compoundReturns(r.portReturns.slice(start)) : 0;
  const lastWeek = compoundReturns(r.portReturns.slice(Math.max(0, r.portReturns.length - 5)));
  const status = ytd <= 0 ? "触发预警" : ytd < 0.01 ? "接近预警" : "正常";
  const statusClass = ytd <= 0 ? "risk" : ytd < 0.01 ? "watch" : "ok";
  box.innerHTML = `
    <div class="monitor-card ${statusClass}"><span>YTD 收益</span><strong>${pct(ytd)}</strong><em>${status}</em></div>
    <div class="monitor-card"><span>近一周收益</span><strong>${pct(lastWeek)}</strong><em>周度监测</em></div>
    <div class="monitor-card"><span>最新日期</span><strong>${latestDate}</strong><em>若 YTD 接近 0% 或转负，应触发风险复盘</em></div>
  `;
}

function renderContributionList() {
  const box = $("contributionList");
  if (!box) return;
  const rows = latestMonthContributions().sort((a, b) => Math.abs(b.value) - Math.abs(a.value)).slice(0, 7);
  if (!rows.length) {
    box.innerHTML = `<div class="empty-note">暂无本月盈亏贡献数据</div>`;
    return;
  }
  box.innerHTML = rows.map((row) => `
    <div class="${row.value < 0 ? "negative" : "positive"}">
      <span><i style="background:${row.color}"></i>${row.name}</span>
      <strong>${pct(row.value)}</strong>
    </div>
  `).join("");
}

function renderMonthCategoryPieChart() {
  const canvas = $("monthCategoryPieChart");
  const legend = $("monthCategoryPieLegend");
  if (!canvas || !legend) return;
  const ctx = setupCanvas(canvas, 260);
  const rows = latestMonthCategoryWeights();
  if (!rows.length) {
    legend.innerHTML = `<div class="empty-note">暂无资产类型数据</div>`;
    return;
  }
  drawPieChart(ctx, canvas, rows, { title: "类型", center: "100%", compact: true, radiusRatio: 0.44 });
  renderPieLegend(legend, rows);
}

function renderRollingProbability() {
  const box = $("rollingProbabilityGrid");
  if (!box) return;
  const periods = [
    { label: "持有三个月", value: 63 },
    { label: "持有六个月", value: 126 },
    { label: "持有一年", value: 252 },
    { label: "持有两年", value: 504 },
  ];
  box.innerHTML = periods.map((period) => {
    const prob = positiveRollingProbability(period.value);
    return `<div class="prob-card"><span>${period.label}</span><strong>${prob === null ? "--" : pct(prob, 0)}</strong><em>收益 > 0%</em></div>`;
  }).join("");
}

function renderTable() {
  const sheet = getSheet();
  const thead = $("assetTableHead");
  const tbody = $("assetTable");
  tbody.innerHTML = "";
  const selected = state.metrics.asset.map((a, i) => ({ ...a, index: i })).filter((a) => state.selected.has(sheet.headers[a.index]));
  const years = [...new Set(selected.flatMap((a) => assetYearlyReturns(a.index).map((y) => y.year)))];
  thead.innerHTML = `
    <tr>
      <th>资产</th>
      <th>类别</th>
      <th>年化收益</th>
      <th>年化波动</th>
      <th>最大回撤</th>
      <th>日度 VaR (95%)</th>
      ${years.map((y) => `<th>${y}</th>`).join("")}
    </tr>
  `;
  const yearMaxAbs = {};
  years.forEach((year) => {
    yearMaxAbs[year] = Math.max(0.01, ...selected.map((a) => Math.abs(assetYearlyReturns(a.index).find((y) => y.year === year)?.ret ?? 0)));
  });
  selected.forEach((a) => {
    const yearly = new Map(assetYearlyReturns(a.index).map((y) => [y.year, y.ret]));
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${a.name}</td>
      <td><span class="category-pill">${a.category}</span></td>
      <td>${miniReturnCell(a.annReturn, Math.max(...selected.map((x) => Math.abs(x.annReturn)), 0.01))}</td>
      <td>${pct(effectiveAssetVol(a.index))}</td>
      <td>${pct(a.mdd)}</td>
      <td>${pct(a.dailyVar95)}</td>
      ${years.map((year) => `<td>${miniReturnCell(yearly.get(year) ?? 0, yearMaxAbs[year])}</td>`).join("")}
    `;
    tbody.appendChild(tr);
  });
}

function drawNavChart() {
  const canvas = $("navChart");
  const ctx = setupCanvas(canvas, 300);
  const r = state.result;
  if (!r) return;
  const rect = canvas.getBoundingClientRect();
  const pad = { l: 42, r: 50, t: 20, b: 34 };
  const w = rect.width - pad.l - pad.r;
  const h = 300 - pad.t - pad.b;
  const range = navDisplayRange();
  const dates = sliceSeries(r.dates, range);
  const navs = rebaseNavs(sliceSeries(r.navs, range));
  const rangeReturns = sliceSeries(r.portReturns, range);
  const drawdowns = maxDrawdown(rangeReturns).dds;
  const benchFull = benchmarkNavs();
  const bench = benchFull ? { ...benchFull, navs: rebaseNavs(sliceSeries(benchFull.navs, range)) } : null;
  renderNavRangeStats(displayedRangeStats(rangeReturns, range));
  const allNavs = bench ? navs.concat(bench.navs) : navs;
  const ddMinRaw = Math.min(...drawdowns, -0.01);
  const ddMin = Math.min(ddMinRaw, -0.04);
  const ddBandTop = pad.t + h * 0.50;
  const ddBandH = h * 0.46;
  const navSpan = Math.max(0.05, ...allNavs.map((v) => Math.abs(v - 1)));
  const navMin = 1 - navSpan;
  const navMax = 1 + navSpan;
  const legend = $("benchmarkLegend");
  if (legend) {
    legend.innerHTML = `<i class="line-gold"></i>${bench ? `${bench.name}${bench.fallback ? "（临时代标）" : ""}` : "沪深300"}`;
  }
  drawGrid(ctx, pad, w, h, 4);
  drawQuarterTicks(ctx, dates, pad, w, h);
  ctx.save();
  ctx.strokeStyle = "rgba(30, 90, 168, 0.18)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad.l, ddBandTop);
  ctx.lineTo(pad.l + w, ddBandTop);
  ctx.stroke();
  ctx.restore();
  drawDrawdownArea(ctx, drawdowns, pad, w, ddBandTop, ddBandH, ddMin);
  if (bench) drawLine(ctx, bench.navs, pad, w, h, navMin, navMax, "#F99551", 1.6);
  drawLine(ctx, navs, pad, w, h, navMin, navMax, "#1E5AA8", 3.6);

  if (state.navHoverIndex !== null && navs[state.navHoverIndex] !== undefined) {
    const x = pad.l + (state.navHoverIndex / Math.max(1, navs.length - 1)) * w;
    const navY = pad.t + (1 - (navs[state.navHoverIndex] - navMin) / Math.max(1e-9, navMax - navMin)) * h;
    ctx.strokeStyle = "rgba(23, 33, 28, 0.28)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, pad.t);
    ctx.lineTo(x, pad.t + h);
    ctx.stroke();
    drawPoint(ctx, x, navY, "#1E5AA8");
    if (bench && bench.navs[state.navHoverIndex] !== undefined) {
      const benchY = pad.t + (1 - (bench.navs[state.navHoverIndex] - navMin) / Math.max(1e-9, navMax - navMin)) * h;
      drawPoint(ctx, x, benchY, "#F99551");
    }
  }

  ctx.fillStyle = "#6e7772";
  ctx.font = "12px Microsoft YaHei, Arial";
  ctx.fillText(navMax.toFixed(2), 6, pad.t + 4);
  ctx.fillText("1.00", 6, ddBandTop + 4);
  ctx.fillText(navMin.toFixed(2), 6, pad.t + h + 4);
  ctx.fillText("0%", pad.l + w + 8, ddBandTop + 4);
  ctx.fillText(pct(ddMin), pad.l + w + 8, ddBandTop + ddBandH);
}

function drawDrawdownArea(ctx, drawdowns, pad, w, top, height, min) {
  ctx.save();
  const baseline = top;
  ctx.beginPath();
  drawdowns.forEach((v, i) => {
    const x = pad.l + (i / Math.max(1, drawdowns.length - 1)) * w;
    const y = top + (Math.abs(v) / Math.max(1e-9, Math.abs(min))) * height;
    if (i === 0) ctx.moveTo(x, baseline);
    ctx.lineTo(x, y);
  });
  ctx.lineTo(pad.l + w, baseline);
  ctx.closePath();
  ctx.fillStyle = "rgba(100, 116, 139, 0.18)";
  ctx.fill();
  ctx.strokeStyle = "rgba(100, 116, 139, 0.34)";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}

function drawQuarterTicks(ctx, dates, pad, w, h) {
  drawDateTicks(ctx, dates, pad, w, h, { quarterly: true, yOffset: 20, fontSize: 11 });
}

function drawDateTicks(ctx, dates, pad, w, h, opts = {}) {
  ctx.save();
  ctx.strokeStyle = "rgba(100, 116, 139, 0.24)";
  ctx.fillStyle = "#64748b";
  ctx.font = `${opts.fontSize || 11}px Microsoft YaHei, Arial`;
  const seen = new Set();
  dates.forEach((date, i) => {
    const month = date.slice(5, 7);
    const key = date.slice(0, 7);
    const isQuarter = [ "01", "04", "07", "10" ].includes(month);
    if ((opts.quarterly && !isQuarter) || seen.has(key)) return;
    seen.add(key);
    const x = pad.l + (i / Math.max(1, dates.length - 1)) * w;
    ctx.beginPath();
    ctx.moveTo(x, pad.t);
    ctx.lineTo(x, pad.t + h + 4);
    ctx.stroke();
    ctx.fillText(key, Math.min(x + 3, pad.l + w - 42), pad.t + h + (opts.yOffset || 20));
  });
  ctx.restore();
}

function drawPoint(ctx, x, y, color) {
  ctx.fillStyle = "#fff";
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x, y, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

function setupCanvas(canvas, height) {
  const ctx = canvas.getContext("2d");
  const ratio = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * ratio;
  canvas.height = height * ratio;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, rect.width, height);
  return ctx;
}

function drawGrid(ctx, pad, w, h, lines) {
  ctx.strokeStyle = "#edf1ee";
  ctx.lineWidth = 1;
  for (let i = 0; i <= lines; i += 1) {
    const y = pad.t + (h * i) / lines;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(pad.l + w, y);
    ctx.stroke();
  }
}

function drawLine(ctx, arr, pad, w, h, min, max, color, lineWidth) {
  ctx.beginPath();
  arr.forEach((v, i) => {
    const x = pad.l + (i / Math.max(1, arr.length - 1)) * w;
    const y = pad.t + (1 - (v - min) / Math.max(1e-9, max - min)) * h;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.stroke();
}

function drawRollingReturnChart() {
  const canvas = $("rollingReturnChart");
  if (!canvas) return;
  const ctx = setupCanvas(canvas, 300);
  const period = Number($("rollingWindow")?.value || 63);
  const rows = rollingReturnSeries(period);
  const rect = canvas.getBoundingClientRect();
  const pad = { l: 46, r: 18, t: 18, b: 34 };
  const w = rect.width - pad.l - pad.r;
  const chartHeight = 300;
  const h = chartHeight - pad.t - pad.b;
  ctx.fillStyle = "#6e7772";
  ctx.font = "12px Microsoft YaHei, Arial";
  if (!rows.length) {
    ctx.fillText("净值区间需大于滚动周期，当前样本不足。", pad.l, pad.t + 30);
    return;
  }
  const values = rows.map((row) => row.ret);
  const maxAbs = Math.max(0.02, ...values.map((v) => Math.abs(v)));
  const min = -maxAbs;
  const max = maxAbs;
  drawGrid(ctx, pad, w, h, 4);
  drawDateTicks(ctx, rows.map((row) => row.date), pad, w, h, { quarterly: true, yOffset: 22, fontSize: 10 });
  const zeroY = pad.t + (1 - (0 - min) / (max - min)) * h;
  ctx.strokeStyle = "rgba(17, 24, 39, 0.32)";
  ctx.beginPath();
  ctx.moveTo(pad.l, zeroY);
  ctx.lineTo(pad.l + w, zeroY);
  ctx.stroke();
  ctx.beginPath();
  rows.forEach((row, i) => {
    const x = pad.l + (i / Math.max(1, rows.length - 1)) * w;
    const y = pad.t + (1 - (row.ret - min) / Math.max(1e-9, max - min)) * h;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = "#1E5AA8";
  ctx.lineWidth = 2.4;
  ctx.stroke();
  if (state.rollingHoverIndex !== null && rows[state.rollingHoverIndex]) {
    const hover = rows[state.rollingHoverIndex];
    const x = pad.l + (state.rollingHoverIndex / Math.max(1, rows.length - 1)) * w;
    const y = pad.t + (1 - (hover.ret - min) / Math.max(1e-9, max - min)) * h;
    ctx.strokeStyle = "rgba(23, 33, 28, 0.30)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, pad.t);
    ctx.lineTo(x, pad.t + h);
    ctx.stroke();
    drawPoint(ctx, x, y, "#1E5AA8");
  }
  ctx.fillStyle = "#6e7772";
  ctx.fillText(pct(max), 6, pad.t + 4);
  ctx.fillText("0%", 12, zeroY + 4);
  ctx.fillText(pct(min), 6, pad.t + h);
}

function drawBarChart(ctx, canvas, rows, opts) {
  const rect = canvas.getBoundingClientRect();
  const height = Number(canvas.getAttribute("height")) || 280;
  const pad = opts.horizontal
    ? (opts.compact ? { l: 74, r: 36, t: 10, b: 12 } : { l: 92, r: 44, t: 12, b: 18 })
    : (opts.compact ? { l: 36, r: 12, t: 14, b: 30 } : { l: 42, r: 16, t: 18, b: 38 });
  if (opts.leftPad) pad.l = opts.leftPad;
  if (opts.rightPad) pad.r = opts.rightPad;
  const w = rect.width - pad.l - pad.r;
  const h = height - pad.t - pad.b;
  ctx.fillStyle = "#6e7772";
  ctx.font = `${opts.fontSize || (opts.compact ? 10 : 12)}px Microsoft YaHei, Arial`;

  if (opts.horizontal) {
    const gap = opts.gap ?? (opts.compact ? 6 : 8);
    const bh = Math.max(opts.minBarHeight || (opts.compact ? 9 : 12), (h - gap * (rows.length - 1)) / Math.max(1, rows.length));
    rows.forEach((row, i) => {
      const y = pad.t + i * (bh + gap);
      const bw = (row.value / opts.max) * w;
      ctx.fillStyle = "#edf1ee";
      ctx.fillRect(pad.l, y, w, bh);
      ctx.fillStyle = row.color;
      ctx.fillRect(pad.l, y, bw, bh);
      ctx.fillStyle = "#39443e";
      ctx.fillText(compactText(ctx, row.name, pad.l - 12), 8, y + bh - 2);
      ctx.fillText(opts.valueFormatter(row.value), pad.l + w + 8, y + bh - 2);
    });
    return;
  }

  const max = opts.max;
  const min = opts.min;
  const zeroY = pad.t + (1 - (0 - min) / Math.max(1e-9, max - min)) * h;
  drawGrid(ctx, pad, w, h, 4);
  ctx.strokeStyle = "#9aa49e";
  ctx.beginPath();
  ctx.moveTo(pad.l, zeroY);
  ctx.lineTo(pad.l + w, zeroY);
  ctx.stroke();
  const gap = opts.compact ? 10 : 12;
  const bw = Math.max(opts.compact ? 14 : 18, (w - gap * (rows.length - 1)) / Math.max(1, rows.length));
  rows.forEach((row, i) => {
    const x = pad.l + i * (bw + gap);
    const y = pad.t + (1 - (row.value - min) / Math.max(1e-9, max - min)) * h;
    ctx.fillStyle = row.color;
    ctx.fillRect(x, Math.min(y, zeroY), bw, Math.max(2, Math.abs(zeroY - y)));
    ctx.fillStyle = "#39443e";
    ctx.fillText(row.name, x, height - 14);
    ctx.fillText(opts.valueFormatter(row.value), x - 2, Math.min(y, zeroY) - 5);
  });
}

function compactText(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let clipped = text;
  while (clipped.length > 2 && ctx.measureText(`${clipped}...`).width > maxWidth) {
    clipped = clipped.slice(0, -1);
  }
  return `${clipped}...`;
}

function refreshCalc() {
  clearComputationCache();
  renderLogic();
  state.result = optimize();
  state.stressResult = null;
  renderKpis();
  renderWeightChart();
  renderCategoryPieChart();
  renderYearChart();
  renderWeightTimeline();
  renderRiskContributionChart();
  renderCorrelationPanels();
  renderMonthlyGrid();
  renderTable();
  renderReturnMonitoring();
  drawNavChart();
  renderStressModule();
  if (isPrudentMode()) runStressSimulation();
}

function scheduleRefreshCalc(delay = 420) {
  clearTimeout(state.calcTimer);
  state.calcTimer = setTimeout(() => {
    syncBacktestModeFromControl();
    refreshCalc();
  }, delay);
}

function runRollingBacktestNow() {
  clearTimeout(state.calcTimer);
  state.includeDynamicBacktest = true;
  refreshCalc();
}

function syncBacktestModeFromControl() {
  state.includeDynamicBacktest = !isPrudentMode();
}

function applyAssumptionModeDefaults() {
  state.includeDynamicBacktest = !isPrudentMode();
}

function refreshAll() {
  const sheet = getSheet();
  state.metrics = computeMetrics();
  $("dateRange").textContent = `${sheet.dates[0]} - ${sheet.dates.at(-1)}`;
  $("yearCutoff").textContent = sheet.dates.at(-1);
  const firstMonth = sheet.dates[1]?.slice(0, 7) || sheet.dates[0].slice(0, 7);
  const lastMonth = sheet.dates.at(-1).slice(0, 7);
  $("rangeStart").min = firstMonth;
  $("rangeStart").max = lastMonth;
  $("rangeEnd").min = firstMonth;
  $("rangeEnd").max = lastMonth;
  $("rangeStart").value = firstMonth;
  $("rangeEnd").value = lastMonth;
  $("navStart").min = firstMonth;
  $("navStart").max = lastMonth;
  $("navEnd").min = firstMonth;
  $("navEnd").max = lastMonth;
  $("navStart").value = firstMonth;
  $("navEnd").value = lastMonth;
  if ($("rollingStart") && $("rollingEnd")) {
    $("rollingStart").min = firstMonth;
    $("rollingStart").max = lastMonth;
    $("rollingEnd").min = firstMonth;
    $("rollingEnd").max = lastMonth;
    $("rollingStart").value = firstMonth;
    $("rollingEnd").value = lastMonth;
  }
  renderNavYearSelect(firstMonth, lastMonth);
  renderRollingYearSelect(firstMonth, lastMonth);
  renderNavCustomYearSelects(firstMonth, lastMonth);
  renderSheetSwitch();
  renderAssetList();
  renderViewInputs();
  refreshCalc();
}

function stressPayload() {
  const r = state.result;
  if (!r) return null;
  const weights = rangeEndWeights() || r.w;
  const cov = effectiveCovarianceMatrix(state.metrics.returns, r.idx, selectedRiskMode());
  return {
    paths: Number($("mcPaths")?.value || 1000),
    horizon: Number($("mcHorizon")?.value || 252),
    weights,
    annReturn: r.annReturn,
    cov,
    categories: r.idx.map((idx) => categoryOf(getSheet().headers[idx])),
    stressCorr: Number($("stressCorr")?.value || 0.75),
  };
}

function runStressSimulation() {
  const payload = stressPayload();
  if (!payload) return;
  $("stressCards").innerHTML = `<div class="stress-card"><span>模拟状态</span><strong>计算中</strong><em>使用后台 Worker，失败时自动降级</em></div>`;
  const generation = ++state.calcGeneration;
  if (window.Worker) {
    try {
      if (!state.stressWorker) state.stressWorker = new Worker("./assets/risk-worker.js");
      state.stressWorker.onmessage = (event) => {
        if (generation !== state.calcGeneration) return;
        state.stressResult = event.data;
        renderStressModule();
      };
      state.stressWorker.onerror = () => {
        state.stressWorker?.terminate?.();
        state.stressWorker = null;
        state.stressResult = simulateStressLocal(payload);
        renderStressModule();
      };
      state.stressWorker.postMessage(payload);
      return;
    } catch (error) {
      state.stressResult = simulateStressLocal(payload);
      renderStressModule();
      return;
    }
  }
  state.stressResult = simulateStressLocal(payload);
  renderStressModule();
}

function simulateStressLocal(payload) {
  const paths = Math.min(800, payload.paths || 1000);
  const horizon = payload.horizon || 252;
  const dailyVol = portfolioVolatility(payload.weights, payload.cov) / Math.sqrt(252);
  const dailyMean = (payload.annReturn || 0) / 252;
  const mdds = [];
  for (let p = 0; p < paths; p += 1) {
    let nav = 1;
    let peak = 1;
    let worst = 0;
    for (let t = 0; t < horizon; t += 1) {
      const r = dailyMean + dailyVol * normalRandom();
      nav *= Math.max(0.01, 1 + r);
      peak = Math.max(peak, nav);
      worst = Math.min(worst, nav / peak - 1);
    }
    mdds.push(worst);
  }
  mdds.sort((a, b) => a - b);
  const shock = { "固收": -0.025, "中性": -0.055, "套利": -0.045, "CTA": -0.10, "权益": -0.24, "指增": -0.28 };
  const stressMdd = payload.weights.reduce((s, w, i) => s + w * (shock[payload.categories[i]] ?? -0.08), 0);
  return {
    median: mdds[Math.floor(mdds.length * 0.50)] || 0,
    p75: mdds[Math.floor(mdds.length * 0.25)] || 0,
    p95: mdds[Math.floor(mdds.length * 0.05)] || 0,
    p99: mdds[Math.floor(mdds.length * 0.01)] || 0,
    stressMdd,
    extremeVol: dailyVol * Math.sqrt(252),
  };
}

function normalRandom() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function renderStressModule() {
  const box = $("stressCards");
  const canvas = $("stressDrawdownChart");
  if (!box || !canvas) return;
  const panel = document.querySelector(".prudent-stress-panel");
  if (panel) panel.hidden = !isPrudentMode();
  if (!isPrudentMode()) {
    box.innerHTML = "";
    setupCanvas(canvas, 280);
    return;
  }
  const s = state.stressResult;
  if (!s) {
    box.innerHTML = `<div class="stress-card"><span>模拟状态</span><strong>待计算</strong><em>点击重新模拟或调整模拟参数</em></div>`;
    setupCanvas(canvas, 280);
    return;
  }
  box.innerHTML = `
    <div class="stress-card"><span>模拟最大回撤 中位数</span><strong>${pct(s.median)}</strong><em>多数路径的回撤中枢</em></div>
    <div class="stress-card warning"><span>模拟最大回撤 P95</span><strong>${pct(s.p95)}</strong><em>较差 5% 路径</em></div>
    <div class="stress-card danger"><span>模拟最大回撤 P99</span><strong>${pct(s.p99)}</strong><em>极端 1% 路径</em></div>
    <div class="stress-card danger"><span>压力情景一次冲击</span><strong>${pct(s.stressMdd)}</strong><em>权益、CTA、套利等同时受压</em></div>
  `;
  drawStressChart();
}

function drawStressChart() {
  const canvas = $("stressDrawdownChart");
  const s = state.stressResult;
  if (!canvas || !s) return;
  const ctx = setupCanvas(canvas, 280);
  const rows = [
    { name: "历史回撤", value: state.result?.mdd || 0, color: "#91B87C" },
    { name: "模拟P75", value: s.p75, color: "#FFD58C" },
    { name: "模拟P95", value: s.p95, color: "#F99551" },
    { name: "模拟P99", value: s.p99, color: "#F55654" },
    { name: "压力冲击", value: s.stressMdd, color: "#8E1D22" },
  ];
  const rect = canvas.getBoundingClientRect();
  const pad = { l: 90, r: 42, t: 16, b: 24 };
  const w = rect.width - pad.l - pad.r;
  const h = 280 - pad.t - pad.b;
  const maxAbs = Math.max(0.04, ...rows.map((row) => Math.abs(row.value)));
  const gap = 10;
  const bh = Math.max(22, (h - gap * (rows.length - 1)) / rows.length);
  ctx.font = "13px Microsoft YaHei, Arial";
  rows.forEach((row, i) => {
    const y = pad.t + i * (bh + gap);
    const bw = Math.abs(row.value) / maxAbs * w;
    ctx.fillStyle = "#edf1ee";
    ctx.fillRect(pad.l, y, w, bh);
    ctx.fillStyle = row.color;
    ctx.fillRect(pad.l, y, bw, bh);
    ctx.fillStyle = "#39443e";
    ctx.fillText(row.name, 10, y + bh - 6);
    ctx.fillText(pct(row.value), pad.l + Math.min(w - 42, bw + 8), y + bh - 6);
  });
}

function renderNavRangeStats(stats) {
  const box = $("navRangeStats");
  if (!box) return;
  const cls = (value) => value > 0 ? "value-positive" : value < 0 ? "value-negative" : "";
  box.innerHTML = `
    <div class="range-stat"><span>区间收益</span><strong class="${cls(stats.ret)}">${pct(stats.ret)}</strong></div>
    <div class="range-stat"><span>区间年化收益</span><strong class="${cls(stats.annReturn)}">${pct(stats.annReturn)}</strong></div>
    <div class="range-stat"><span>区间最大回撤</span><strong class="${cls(stats.mdd)}">${pct(stats.mdd)}</strong></div>
    <div class="range-stat"><span>区间年化波动</span><strong>${pct(stats.vol)}</strong></div>
    <div class="range-stat"><span>区间夏普</span><strong>${stats.sharpe === null ? "--" : stats.sharpe.toFixed(2)}</strong></div>
    <div class="range-stat"><span>最大回撤回补期</span><strong>${stats.recoveryDays} 天</strong></div>
    <div class="range-stat"><span>VaR (95%置信)</span><strong>${pct(stats.var95)}</strong></div>
  `;
}

function renderNavYearSelect(firstMonth, lastMonth) {
  const select = $("navYearSelect");
  if (!select) return;
  const firstYear = Number(firstMonth.slice(0, 4));
  const lastYear = Number(lastMonth.slice(0, 4));
  select.innerHTML = `<option value="all">全部</option>${Array.from({ length: lastYear - firstYear + 1 }, (_, i) => firstYear + i).map((y) => `<option value="${y}">${y}</option>`).join("")}<option value="custom">自定义</option>`;
  select.value = "all";
}

function renderRollingYearSelect(firstMonth, lastMonth) {
  const select = $("rollingYearSelect");
  if (!select) return;
  const firstYear = Number(firstMonth.slice(0, 4));
  const lastYear = Number(lastMonth.slice(0, 4));
  select.innerHTML = `<option value="all">全部</option>${Array.from({ length: lastYear - firstYear + 1 }, (_, i) => firstYear + i).map((y) => `<option value="${y}">${y}</option>`).join("")}<option value="custom">自定义</option>`;
  select.value = "all";
}

function renderNavCustomYearSelects(firstMonth, lastMonth) {
  const startSelect = $("navStartYear");
  const endSelect = $("navEndYear");
  if (!startSelect || !endSelect) return;
  const firstYear = Number(firstMonth.slice(0, 4));
  const lastYear = Number(lastMonth.slice(0, 4));
  const options = Array.from({ length: lastYear - firstYear + 1 }, (_, i) => firstYear + i)
    .map((year) => `<option value="${year}">${year}</option>`)
    .join("");
  startSelect.innerHTML = options;
  endSelect.innerHTML = options;
  startSelect.value = String(firstYear);
  endSelect.value = String(lastYear);
}

function syncNavCustomYearSelects() {
  if ($("navStartYear") && $("navStart")?.value) $("navStartYear").value = $("navStart").value.slice(0, 4);
  if ($("navEndYear") && $("navEnd")?.value) $("navEndYear").value = $("navEnd").value.slice(0, 4);
}

function refreshNavRangeCharts() {
  state.navHoverIndex = null;
  syncNavCustomYearSelects();
  syncMonthlyRangeToNav();
  renderWeightChart();
  renderCategoryPieChart();
  drawNavChart();
  renderWeightTimeline();
  renderRiskContributionChart();
  renderMonthlyGrid();
  renderCorrelationPanels();
  renderReturnMonitoring();
  state.stressResult = null;
  renderStressModule();
  if (isPrudentMode()) runStressSimulation();
}

function renderAssumptionMode() {
  const dataMode = state.assumptionMode === "data";
  $("modeData")?.classList.toggle("active", dataMode);
  $("modePrudent")?.classList.toggle("active", !dataMode);
  document.querySelector(".assumption-block")?.classList.toggle("prudent-active", !dataMode);
  document.body.classList.toggle("mode-data", dataMode);
  document.body.classList.toggle("mode-simulation", !dataMode);
  document.querySelector(".prudent-stress-panel")?.toggleAttribute("hidden", dataMode);
}

function exportResult() {
  const r = state.result;
  if (!r) return;
  const vol = displayedPortfolioVol(r);
  const lines = [
    `目标收益,${pct(state.target)}`,
    `风险假设模式,${isPrudentMode() ? "模拟测算" : "数据回看"}`,
    `调仓频率,${$("rebalanceFreq").selectedOptions[0].textContent}`,
    `回看窗口,${$("lookbackWindow").selectedOptions[0].textContent}`,
    `风险口径,${$("riskMode").selectedOptions[0].textContent}`,
    `组合模型,${$("modelType").selectedOptions[0].textContent}`,
    `样本年化收益,${pct(r.annReturn)}`,
    `年化波动,${pct(vol)}`,
    `最大回撤,${pct(r.mdd)}`,
    `夏普值(无风险收益1.73%),${vol > 0 ? ((r.annReturn - RISK_FREE_RATE) / vol).toFixed(2) : "--"}`,
    `年度正收益概率,${pct(r.positive, 0)}`,
    "",
    "资产,当前建议权重",
    ...r.idx.map((idx, i) => `${getSheet().headers[idx]},${pct(r.w[i])}`),
  ];
  navigator.clipboard?.writeText(lines.join("\n"));
  $("exportBtn").textContent = "已复制";
  setTimeout(() => ($("exportBtn").textContent = "导出结果"), 1200);
}

function handleNavHover(event) {
  const r = state.result;
  if (!r) return;
  const canvas = $("navChart");
  const rect = canvas.getBoundingClientRect();
  const pad = { l: 42, r: 50, t: 20, b: 28 };
  const w = rect.width - pad.l - pad.r;
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const tooltip = $("navTooltip");
  if (x < pad.l || x > pad.l + w || y < pad.t || y > 300 - pad.b) {
    state.navHoverIndex = null;
    tooltip.style.display = "none";
    drawNavChart();
    return;
  }
  const range = navDisplayRange();
  const dates = sliceSeries(r.dates, range);
  const navs = rebaseNavs(sliceSeries(r.navs, range));
  const drawdowns = maxDrawdown(sliceSeries(r.portReturns, range)).dds;
  const idx = Math.round(((x - pad.l) / Math.max(1, w)) * (navs.length - 1));
  state.navHoverIndex = Math.max(0, Math.min(navs.length - 1, idx));
  const date = dates[state.navHoverIndex];
  const nav = navs[state.navHoverIndex];
  const dd = drawdowns[state.navHoverIndex];
  const benchFull = benchmarkNavs();
  const bench = benchFull ? { ...benchFull, navs: rebaseNavs(sliceSeries(benchFull.navs, range)) } : null;
  const benchText = bench && bench.navs[state.navHoverIndex] !== undefined ? `<br/>${bench.name}${bench.fallback ? "（临时代标）" : ""}：${bench.navs[state.navHoverIndex].toFixed(4)}` : "";
  tooltip.innerHTML = `<strong>${date}</strong><br/>组合净值：${nav.toFixed(4)}${benchText}<br/>回撤：${pct(dd, 2)}`;
  tooltip.style.display = "block";
  tooltip.style.left = `${Math.min(rect.width - 168, Math.max(8, x + 14))}px`;
  tooltip.style.top = `${Math.min(250, Math.max(8, y + 14))}px`;
  drawNavChart();
}

function clearNavHover() {
  state.navHoverIndex = null;
  $("navTooltip").style.display = "none";
  drawNavChart();
}

function handleRollingHover(event) {
  const rows = rollingReturnSeries(Number($("rollingWindow")?.value || 63));
  const canvas = $("rollingReturnChart");
  const tooltip = $("rollingTooltip");
  if (!canvas || !tooltip || !rows.length) return;
  const rect = canvas.getBoundingClientRect();
  const pad = { l: 46, r: 18, t: 18, b: 34 };
  const w = rect.width - pad.l - pad.r;
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  if (x < pad.l || x > pad.l + w || y < pad.t || y > 300 - pad.b) {
    clearRollingHover();
    return;
  }
  const idx = Math.round(((x - pad.l) / Math.max(1, w)) * (rows.length - 1));
  state.rollingHoverIndex = Math.max(0, Math.min(rows.length - 1, idx));
  const point = rows[state.rollingHoverIndex];
  tooltip.innerHTML = `<strong>${point.date}</strong><br/>滚动收益：${pct(point.ret, 2)}`;
  tooltip.style.display = "block";
  tooltip.style.left = `${Math.min(rect.width - 150, Math.max(8, x + 14))}px`;
  tooltip.style.top = `${Math.min(230, Math.max(8, y + 14))}px`;
  drawRollingReturnChart();
}

function clearRollingHover() {
  state.rollingHoverIndex = null;
  const tooltip = $("rollingTooltip");
  if (tooltip) tooltip.style.display = "none";
  drawRollingReturnChart();
}

function handleWeightHover(event) {
  const r = state.result;
  if (!r || !r.weightTimeline.length) return;
  const canvas = $("weightTimelineChart");
  const rect = canvas.getBoundingClientRect();
  const pad = { l: 44, r: 16, t: 18, b: 30 };
  const w = rect.width - pad.l - pad.r;
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const tooltip = $("weightTooltip");
  if (x < pad.l || x > pad.l + w || y < pad.t || y > 310 - pad.b) {
    clearWeightHover();
    return;
  }
  const range = navDisplayRange();
  const series = sliceSeries(r.weightTimeline, range);
  const idx = Math.round(((x - pad.l) / Math.max(1, w)) * (series.length - 1));
  state.weightHoverIndex = Math.max(0, Math.min(series.length - 1, idx));
  const point = series[state.weightHoverIndex];
  if (!point) return;
  const nav = rebaseNavs(sliceSeries(r.navs, range))[state.weightHoverIndex] ?? 1;
  const items = point.weights.map((weight, i) => ({
    name: shortName(getSheet().headers[r.idx[i]]),
    value: weight,
    color: assetColor(getSheet().headers[r.idx[i]], i),
  })).sort((a, b) => b.value - a.value);
  tooltip.innerHTML = `
    <strong>${point.date}</strong><br/>
    组合净值：${nav.toFixed(4)}
    <div class="tooltip-list">
      ${items.map((item) => `<div><span><i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${item.color};margin-right:5px"></i>${item.name}</span><strong>${pct(item.value, 1)}</strong></div>`).join("")}
    </div>
  `;
  tooltip.style.display = "block";
  tooltip.style.left = `${Math.min(rect.width - 326, Math.max(8, x + 14))}px`;
  tooltip.style.top = `${Math.min(250, Math.max(8, y + 14))}px`;
  renderWeightTimeline();
}

function clearWeightHover() {
  state.weightHoverIndex = null;
  $("weightTooltip").style.display = "none";
  renderWeightTimeline();
}

function handleRiskHover(event) {
  const r = state.result;
  if (!r || !r.riskTimeline.length) return;
  const canvas = $("riskContributionChart");
  const rect = canvas.getBoundingClientRect();
  const pad = { l: 44, r: 16, t: 18, b: 30 };
  const w = rect.width - pad.l - pad.r;
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const tooltip = $("riskTooltip");
  if (x < pad.l || x > pad.l + w || y < pad.t || y > 310 - pad.b) {
    clearRiskHover();
    return;
  }
  const idx = Math.round(((x - pad.l) / Math.max(1, w)) * (r.riskTimeline.length - 1));
  state.riskHoverIndex = Math.max(0, Math.min(r.riskTimeline.length - 1, idx));
  const point = r.riskTimeline[state.riskHoverIndex];
  const items = point.contributions.map((value, i) => ({
    name: shortName(getSheet().headers[r.idx[i]]),
    value,
    color: assetColor(getSheet().headers[r.idx[i]], i),
  })).sort((a, b) => b.value - a.value);
  tooltip.innerHTML = `
    <strong>${point.date}</strong><br/>
    风险贡献占比
    <div class="tooltip-list">
      ${items.map((item) => `<div><span><i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${item.color};margin-right:5px"></i>${item.name}</span><strong>${pct(item.value, 1)}</strong></div>`).join("")}
    </div>
  `;
  tooltip.style.display = "block";
  tooltip.style.left = `${Math.min(rect.width - 326, Math.max(8, x + 14))}px`;
  tooltip.style.top = `${Math.min(250, Math.max(8, y + 14))}px`;
  renderRiskContributionChart();
}

function clearRiskHover() {
  state.riskHoverIndex = null;
  $("riskTooltip").style.display = "none";
  renderRiskContributionChart();
}

function init() {
  resetSelection();
  $("modeData").onclick = () => {
    state.assumptionMode = "data";
    applyAssumptionModeDefaults();
    renderAssumptionMode();
    renderViewInputs();
    scheduleRefreshCalc(120);
  };
  $("modePrudent").onclick = () => {
    state.assumptionMode = "prudent";
    applyAssumptionModeDefaults();
    renderAssumptionMode();
    renderViewInputs();
    scheduleRefreshCalc(120);
  };
  ["floorBond", "floorNeutral", "floorArb", "floorCta", "floorEquity"].forEach((id) => {
    $(id).onchange = () => {
      if (!isPrudentMode()) return;
      renderViewInputs();
      scheduleRefreshCalc();
    };
  });
  $("targetSlider").oninput = (e) => {
    state.target = Number(e.target.value) / 100;
    $("targetLabel").textContent = pct(state.target);
    document.querySelectorAll(".target-presets button").forEach((b) => b.classList.toggle("active", Number(b.dataset.target) === Number(e.target.value)));
    scheduleRefreshCalc();
  };
  document.querySelectorAll(".target-presets button").forEach((btn) => {
    btn.onclick = () => {
      $("targetSlider").value = btn.dataset.target;
      $("targetSlider").dispatchEvent(new Event("input"));
    };
  });
  ["maxWeight", "bondFloor", "equityCap", "rebalanceFreq", "lookbackWindow", "riskMode", "modelType"].forEach((id) => $(id).onchange = () => {
    syncBacktestModeFromControl();
    scheduleRefreshCalc();
  });
  ["rangeStart", "rangeEnd"].forEach((id) => $(id).onchange = renderMonthlyGrid);
  $("rollingWindow").onchange = () => {
    state.rollingHoverIndex = null;
    drawRollingReturnChart();
    renderRollingProbability();
  };
  ["rollingStart", "rollingEnd"].forEach((id) => $(id).onchange = () => {
    if ($("rollingEnd").value < $("rollingStart").value) $("rollingEnd").value = $("rollingStart").value;
    $("rollingYearSelect").value = "custom";
    state.rollingHoverIndex = null;
    drawRollingReturnChart();
    renderRollingProbability();
  });
  $("rollingYearSelect").onchange = () => {
    const value = $("rollingYearSelect").value;
    const first = $("rollingStart").min;
    const last = $("rollingEnd").max;
    if (value === "all") {
      $("rollingStart").value = first;
      $("rollingEnd").value = last;
    } else if (value !== "custom") {
      $("rollingStart").value = `${value}-01` < first ? first : `${value}-01`;
      $("rollingEnd").value = `${value}-12` > last ? last : `${value}-12`;
    }
    state.rollingHoverIndex = null;
    drawRollingReturnChart();
    renderRollingProbability();
  };
  ["navStart", "navEnd"].forEach((id) => $(id).onchange = () => {
    $("navYearSelect").value = "custom";
    refreshNavRangeCharts();
  });
  ["navStartYear", "navEndYear"].forEach((id) => $(id).onchange = () => {
    const first = $("navStart").min;
    const last = $("navEnd").max;
    const startYear = $("navStartYear").value;
    const endYear = $("navEndYear").value;
    $("navStart").value = `${startYear}-01` < first ? first : `${startYear}-01`;
    $("navEnd").value = `${endYear}-12` > last ? last : `${endYear}-12`;
    if ($("navEnd").value < $("navStart").value) $("navEnd").value = $("navStart").value;
    $("navYearSelect").value = "custom";
    refreshNavRangeCharts();
  });
  $("navYearSelect").onchange = () => {
    const value = $("navYearSelect").value;
    const first = $("navStart").min;
    const last = $("navEnd").max;
    if (value === "all") {
      $("navStart").value = first;
      $("navEnd").value = last;
    } else if (value !== "custom") {
      $("navStart").value = `${value}-01`;
      $("navEnd").value = `${value}-12` > last ? last : `${value}-12`;
    }
    refreshNavRangeCharts();
  };
  ["mcPaths", "mcHorizon", "stressCorr"].forEach((id) => {
    if ($(id)) $(id).onchange = runStressSimulation;
  });
  if ($("rebalanceBtn")) $("rebalanceBtn").onclick = () => {
    syncBacktestModeFromControl();
    refreshCalc();
  };
  if ($("runBacktestBtn")) $("runBacktestBtn").onclick = runRollingBacktestNow;
  $("runStressBtn").onclick = runStressSimulation;
  $("exportBtn").onclick = exportResult;
  $("navChart").addEventListener("mousemove", handleNavHover);
  $("navChart").addEventListener("mouseleave", clearNavHover);
  $("weightTimelineChart").addEventListener("mousemove", handleWeightHover);
  $("weightTimelineChart").addEventListener("mouseleave", clearWeightHover);
  $("riskContributionChart").addEventListener("mousemove", handleRiskHover);
  $("riskContributionChart").addEventListener("mouseleave", clearRiskHover);
  $("rollingReturnChart").addEventListener("mousemove", handleRollingHover);
  $("rollingReturnChart").addEventListener("mouseleave", clearRollingHover);
  $("selectCore").onclick = () => {
    state.selected = new Set(getSheet().headers.filter((h) => coreNames.has(h)));
    renderAssetList();
    renderViewInputs();
    scheduleRefreshCalc(120);
  };
  window.addEventListener("resize", () => {
    drawNavChart();
    renderWeightChart();
    renderCategoryPieChart();
    renderYearChart();
    renderWeightTimeline();
    renderRiskContributionChart();
    drawRollingReturnChart();
    drawStressChart();
  });
  applyAssumptionModeDefaults();
  renderAssumptionMode();
  refreshAll();
}

init();
