'use strict';
// 評価者間一致（IRR）。
// 目標は .65（MET Project の実測：評定者2名 × 授業2本 = .67）。
// これ未満なら、ルーブリックが機能していない。12月のA/Bの前に、10月20日までに測る。
//
// 手順（docs/運用手順.md 2章と対応）：
//   1. 授業のサブサンプルを選ぶ（全部は要らない。冒頭15分で6割の信頼性が出る）
//   2. 評定者2名が、AIスコアと先生の名前に盲検で独立採点する
//   3. ここで二次重みつきカッパを計算する
const { round, mean } = require('./util');

// 二次重みつきカッパ。順序尺度（0..4）の一致を測る標準的なやり方
function quadraticWeightedKappa(a, b, minCat = 0, maxCat = 4) {
  const n = a.length;
  if (n === 0 || n !== b.length) return null;
  const k = maxCat - minCat + 1;
  const O = Array.from({ length: k }, () => new Array(k).fill(0));
  const histA = new Array(k).fill(0);
  const histB = new Array(k).fill(0);
  for (let i = 0; i < n; i += 1) {
    const x = Math.round(a[i]) - minCat;
    const y = Math.round(b[i]) - minCat;
    if (x < 0 || y < 0 || x >= k || y >= k) return null;
    O[x][y] += 1;
    histA[x] += 1;
    histB[y] += 1;
  }
  let num = 0;
  let den = 0;
  for (let i = 0; i < k; i += 1) {
    for (let j = 0; j < k; j += 1) {
      const w = ((i - j) ** 2) / ((k - 1) ** 2);
      const e = (histA[i] * histB[j]) / n;
      num += w * O[i][j];
      den += w * e;
    }
  }
  if (den === 0) return 1;
  return 1 - num / den;
}

function exactAgreement(a, b) {
  if (!a.length) return null;
  let hit = 0;
  for (let i = 0; i < a.length; i += 1) if (Math.round(a[i]) === Math.round(b[i])) hit += 1;
  return hit / a.length;
}

function adjacentAgreement(a, b) {
  if (!a.length) return null;
  let hit = 0;
  for (let i = 0; i < a.length; i += 1) if (Math.abs(Math.round(a[i]) - Math.round(b[i])) <= 1) hit += 1;
  return hit / a.length;
}

// 級内相関 ICC(2,1)。連続値としての一致も併記する
function icc21(a, b) {
  const n = a.length;
  if (n < 2) return null;
  const grand = mean([...a, ...b]);
  const rowMeans = a.map((_, i) => (a[i] + b[i]) / 2);
  const colMeans = [mean(a), mean(b)];
  let msr = 0;
  for (const rm of rowMeans) msr += 2 * (rm - grand) ** 2;
  msr /= n - 1;
  let msc = 0;
  for (const cm of colMeans) msc += n * (cm - grand) ** 2;
  msc /= 1;
  let sse = 0;
  for (let i = 0; i < n; i += 1) {
    sse += (a[i] - rowMeans[i] - colMeans[0] + grand) ** 2;
    sse += (b[i] - rowMeans[i] - colMeans[1] + grand) ** 2;
  }
  const mse = sse / (n - 1);
  const denom = msr + (2 - 1) * mse + (2 * (msc - mse)) / n;
  if (denom === 0) return null;
  return (msr - mse) / denom;
}

// pairs: [{ lessonId, dim, a, b }]
// 契約の段階は 1〜5。旧い 0〜4 の採点と混ざらないよう、呼び出し側で版を分けること。
function report(pairs, target = 0.65, minCat = 1, maxCat = 5) {
  const byDim = {};
  for (const p of pairs) {
    if (!byDim[p.dim]) byDim[p.dim] = { a: [], b: [] };
    byDim[p.dim].a.push(p.a);
    byDim[p.dim].b.push(p.b);
  }
  const dims = {};
  for (const [dim, v] of Object.entries(byDim)) {
    dims[dim] = {
      n: v.a.length,
      qwk: round(quadraticWeightedKappa(v.a, v.b, minCat, maxCat), 3),
      exact: round(exactAgreement(v.a, v.b), 3),
      adjacent: round(adjacentAgreement(v.a, v.b), 3),
      icc: round(icc21(v.a, v.b), 3),
    };
  }
  const allA = pairs.map((p) => p.a);
  const allB = pairs.map((p) => p.b);
  const overall = {
    n_ratings: pairs.length,
    n_lessons: new Set(pairs.map((p) => p.lessonId)).size,
    qwk: round(quadraticWeightedKappa(allA, allB, minCat, maxCat), 3),
    exact: round(exactAgreement(allA, allB), 3),
    adjacent: round(adjacentAgreement(allA, allB), 3),
    icc: round(icc21(allA, allB), 3),
  };
  return {
    target,
    overall,
    dims,
    passes: overall.qwk !== null && overall.qwk >= target,
    note: '目標 .65。これ未満のときは、まずルーブリックの記述語（levels）を直す。スコアの計算式ではない。',
  };
}

module.exports = { quadraticWeightedKappa, exactAgreement, adjacentAgreement, icc21, report };
