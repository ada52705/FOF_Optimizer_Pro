self.onmessage = (event) => {
  const result = simulateStress(event.data);
  self.postMessage(result);
};

function simulateStress(payload) {
  const paths = payload.paths || 1000;
  const horizon = payload.horizon || 252;
  const weights = payload.weights || [];
  const annReturn = payload.annReturn || 0;
  const cov = payload.cov || [];
  const categories = payload.categories || [];
  const stressCorr = payload.stressCorr || 0.75;
  const dailyCov = cov.map((row) => row.map((v) => v / 252));
  const chol = cholesky(dailyCov);
  const dailyMean = annReturn / 252;
  const mdds = [];
  for (let p = 0; p < paths; p += 1) {
    let nav = 1;
    let peak = 1;
    let worst = 0;
    for (let t = 0; t < horizon; t += 1) {
      const z = weights.map(() => normalRandom());
      const assetReturns = weights.map((_, i) => {
        const shock = chol[i].reduce((s, c, j) => s + c * z[j], 0);
        return dailyMean + shock;
      });
      const r = weights.reduce((s, w, i) => s + w * assetReturns[i], 0);
      nav *= Math.max(0.01, 1 + r);
      peak = Math.max(peak, nav);
      worst = Math.min(worst, nav / peak - 1);
    }
    mdds.push(worst);
  }
  mdds.sort((a, b) => a - b);
  const stressMdd = stressScenarioDrawdown(weights, categories);
  const extremeVol = extremeCorrVol(weights, cov, stressCorr);
  return {
    median: quantileSorted(mdds, 0.50),
    p75: quantileSorted(mdds, 0.25),
    p95: quantileSorted(mdds, 0.05),
    p99: quantileSorted(mdds, 0.01),
    stressMdd,
    extremeVol,
  };
}

function quantileSorted(arr, q) {
  if (!arr.length) return 0;
  const i = Math.max(0, Math.min(arr.length - 1, Math.floor(arr.length * q)));
  return arr[i];
}

function normalRandom() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function cholesky(matrix) {
  const n = matrix.length;
  const l = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j <= i; j += 1) {
      let sum = matrix[i][j] || 0;
      for (let k = 0; k < j; k += 1) sum -= l[i][k] * l[j][k];
      if (i === j) l[i][j] = Math.sqrt(Math.max(sum, 1e-10));
      else l[i][j] = sum / Math.max(1e-10, l[j][j]);
    }
  }
  return l;
}

function stressScenarioDrawdown(weights, categories) {
  const shock = {
    "固收": -0.025,
    "中性": -0.055,
    "套利": -0.045,
    "CTA": -0.10,
    "权益": -0.24,
    "指增": -0.28,
  };
  return weights.reduce((s, w, i) => s + w * (shock[categories[i]] ?? -0.08), 0);
}

function extremeCorrVol(weights, cov, stressCorr) {
  const vols = cov.map((row, i) => Math.sqrt(Math.max(0, row[i] || 0)));
  let variance = 0;
  for (let i = 0; i < weights.length; i += 1) {
    for (let j = 0; j < weights.length; j += 1) {
      const corr = i === j ? 1 : stressCorr;
      variance += weights[i] * weights[j] * corr * vols[i] * vols[j];
    }
  }
  return Math.sqrt(Math.max(0, variance));
}
