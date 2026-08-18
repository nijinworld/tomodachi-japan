'use strict';
// 費用会計（ingredients method）。
//
// この事業でいちばん疑われるのは「安さの正体は無償労働ではないか」です。
// だから、ファシリテーターの時間を3通りで置いて、3つとも出します。
//   ① 0円          … 本人がやりたくてやっている、という前提の数字
//   ② 最低賃金      … 最低限、労働として認めた場合
//   ③ 同等スキル職  … これでも成り立つなら、いちばん強い
// ③ で成り立たないなら「安いのはAIではなく無償労働」という別の話になります。
// それも正直に出します。隠して指摘されるほうが高くつきます。
const { round } = require('./util');

const SCENARIOS = [
  { id: 'zero', label: '① 0円で計上', factor: 0 },
  { id: 'minimum', label: '② 現地の最低賃金', factor: 'wage_minimum' },
  { id: 'equivalent', label: '③ 同等スキル職の平均賃金', factor: 'wage_equivalent' },
];

// item: {
//   id, label, category: '採用'|'研修'|'伴走'|'システム'|'その他',
//   actor: 'facilitator'|'mentor'|'staff'|'vendor',
//   arm: 'A'|'B'|null,
//   hours: 時間（actor の時間投入）, jpy: 直接支出（円）, qty: 何人分・何回分,
//   note
// }
// wages: { wage_minimum: 円/時, wage_equivalent: 円/時, mentor_hourly: 円/時, staff_hourly: 円/時 }
function computeItem(item, wages, scenario) {
  const qty = item.qty === undefined ? 1 : item.qty;
  const direct = (item.jpy || 0) * qty;
  const hours = (item.hours || 0) * qty;
  let rate = 0;
  if (item.actor === 'facilitator') {
    if (scenario.factor === 0) rate = 0;
    else rate = wages[scenario.factor] || 0;
  } else if (item.actor === 'mentor') {
    rate = wages.mentor_hourly || 0;
  } else if (item.actor === 'staff') {
    rate = wages.staff_hourly || 0;
  } else {
    rate = 0; // vendor は直接支出だけ
  }
  const timeCost = hours * rate;
  return { direct, hours, rate, timeCost, total: direct + timeCost };
}

// items をアーム別・シナリオ別に集計し、「ファシリテーター1名あたりの完全負荷養成コスト」を出す。
// facilitatorsTrained: { A: n, B: n } … 実際に一人前になった人数（研修開始者ではない）
// funnel: { applicants: n, hired: n } … 49名落として1名採る分を、養成コストに乗せるため
function report(items, opts) {
  const wages = opts.wages || {};
  const trained = opts.facilitatorsTrained || {};
  const out = { scenarios: {}, wages, note: 'ingredients method。受講者時間を3通りで振っている。' };

  for (const sc of SCENARIOS) {
    const arms = {};
    for (const item of items) {
      const arm = item.arm || 'ALL';
      if (!arms[arm]) arms[arm] = { byCategory: {}, direct: 0, timeCost: 0, hours: 0, total: 0 };
      const c = computeItem(item, wages, sc);
      const cat = item.category || 'その他';
      if (!arms[arm].byCategory[cat]) arms[arm].byCategory[cat] = 0;
      arms[arm].byCategory[cat] += c.total;
      arms[arm].direct += c.direct;
      arms[arm].timeCost += c.timeCost;
      arms[arm].hours += c.hours;
      arms[arm].total += c.total;
    }
    // ALL（アーム共通の費用）は、養成人数で按分する
    const totalTrained = Object.values(trained).reduce((a, b) => a + b, 0) || 0;
    const perArm = {};
    for (const [arm, v] of Object.entries(arms)) {
      if (arm === 'ALL') continue;
      const share = totalTrained ? (trained[arm] || 0) / totalTrained : 0;
      const shared = arms.ALL ? arms.ALL.total * share : 0;
      const n = trained[arm] || 0;
      perArm[arm] = {
        direct: round(v.direct, 0),
        time_cost: round(v.timeCost, 0),
        hours: round(v.hours, 1),
        shared_from_common: round(shared, 0),
        total: round(v.total + shared, 0),
        trained: n,
        cost_per_facilitator: n ? round((v.total + shared) / n, 0) : null,
        by_category: Object.fromEntries(Object.entries(v.byCategory).map(([k, x]) => [k, round(x, 0)])),
      };
    }
    const a = perArm.A ? perArm.A.cost_per_facilitator : null;
    const b = perArm.B ? perArm.B.cost_per_facilitator : null;
    out.scenarios[sc.id] = {
      label: sc.label,
      arms: perArm,
      common: arms.ALL ? round(arms.ALL.total, 0) : 0,
      b_over_a: a && b ? round(b / a, 3) : null,
      verdict: a && b
        ? (b < a ? `Bのほうが1名あたり ${round((1 - b / a) * 100, 1)}% 安い` : `Bのほうが高い（${round((b / a - 1) * 100, 1)}%）`)
        : '養成人数が未入力のため未算出',
    };
  }

  const eq = out.scenarios.equivalent;
  out.headline = eq && eq.b_over_a !== null
    ? (eq.b_over_a < 1
      ? '同等スキル職の賃金を置いてもBのほうが安い。この場合、安さの説明は「無償労働」ではない。'
      : '同等スキル職の賃金を置くとBのほうが高い。この場合、安さの正体は無償労働である。正直にそう書くこと。')
    : '③のシナリオが未算出。ここが埋まるまで「安い」と言わないこと。';

  return out;
}

module.exports = { report, computeItem, SCENARIOS };
