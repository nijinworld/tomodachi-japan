'use strict';
// 子どもからの評価アンケートの集計と、「返し方」の記録。
//
// このシステムで、いちばん効果が大きいと分かっているのはここです（d=0.27）。
// ただし効果のほぼ全部は「返し方」に載っています（設計あり 0.568／なし 0.050）。
// だからこのモジュールは、集計よりも「返したか・宣言したか・子どもと話したか」の
// 記録のほうを重く扱います。3つが揃っていない回は compliant=false として残します。
const fs = require('node:fs');
const path = require('node:path');
const { round, mean } = require('./util');

function loadSpec() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'spec', 'survey.ja.json'), 'utf8'));
}

// responses: [{ studentId, answers: { itemCode: 1..5 } }]
function aggregate(responses, spec = loadSpec()) {
  const minN = spec.administration.min_responses_to_show;
  const n = responses.length;
  if (n < minN) {
    return { n, suppressed: true, min_required: minN, note: `回答が${minN}件未満のため、先生には返しません（個人が割れるため）。`, dims: {}, items: [] };
  }
  const items = spec.items.map((it) => {
    const vals = responses.map((r) => r.answers[it.code]).filter((v) => typeof v === 'number');
    return { code: it.code, dimension: it.dimension, text: it.text, n: vals.length, mean: round(mean(vals), 2) };
  });
  // 点数化しない指標（ともだち＝所属感）は、観点の集計から外す。
  // 先生の評価に混ぜないため。時系列で見るだけにする。
  const nonScored = spec.non_scored || [];
  const nonScoredDims = new Set(nonScored.map((x) => x.dimension));

  const dims = {};
  for (const it of items) {
    if (nonScoredDims.has(it.dimension)) continue;
    if (!dims[it.dimension]) dims[it.dimension] = [];
    if (it.mean !== null) dims[it.dimension].push(it.mean);
  }
  const dimOut = {};
  for (const [d, vals] of Object.entries(dims)) dimOut[d] = { mean: round(mean(vals), 2), items: vals.length };

  const belonging = nonScored.map((x) => {
    const vals = items.filter((it) => x.items.includes(it.code)).map((it) => it.mean).filter((v) => v !== null);
    return { key: x.key, label: x.label, mean: round(mean(vals), 2), items: vals.length, note: x.note };
  });

  return { n, suppressed: false, min_required: minN, dims: dimOut, items, belonging, scale: spec.scale };
}

function withDelta(current, previous) {
  if (!previous || previous.suppressed || current.suppressed) return current;
  const dims = {};
  for (const [d, v] of Object.entries(current.dims)) {
    const p = previous.dims[d];
    dims[d] = { ...v, previous: p ? p.mean : null, delta: p ? round(v.mean - p.mean, 2) : null };
  }
  return { ...current, dims };
}

// 「返し方」の設計が守られているか。守られていない回は d=0.050 側として扱う。
// cycle: { returned_at, action_declared_at, discussed_with_students_at }
function designCompliance(cycle = {}) {
  const steps = [
    { key: 'returned_at', label: '先生に観点別で返した（順位は返していない）', ok: !!cycle.returned_at },
    { key: 'action_declared_at', label: 'チームの週次で次の1手を1つ宣言した', ok: !!cycle.action_declared_at },
    { key: 'discussed_with_students_at', label: '子どもに「次はこうします」と伝えた', ok: !!cycle.discussed_with_students_at },
  ];
  const compliant = steps.every((s) => s.ok);
  return {
    steps,
    compliant,
    expected_d: compliant ? 0.568 : 0.05,
    evidence_id: 'student_survey_design',
    note: compliant
      ? '設計あり。メタ分析では d=0.568 側。'
      : '設計なし。メタ分析では d=0.050 側。ここを飛ばすと、アンケートを取った意味がほぼ消えます。',
  };
}

module.exports = { aggregate, withDelta, designCompliance, loadSpec };
