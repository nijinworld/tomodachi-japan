'use strict';
// node test/contract.test.js
// NIJIN 評価契約への変換が、向こうの不変条件を破らないことを固定する。
// ここが緩むと、「確かめていないものを確かめたことにする」方向へ静かに滑ります。
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const TMP = path.join(__dirname, '.tmp-contract');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
process.env.RANIUS_DATA_DIR = TMP;
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));

const { scoreLesson } = require('../server/lib/scoring');
const contract = require('../server/lib/contract');

const results = [];
function test(name, fn) {
  try { fn(); results.push(['ok', name]); } catch (e) { results.push(['NG', `${name}\n     ${e.message}`]); }
}

// 取り込みまで起きる、きれいな書き起こし
const GOOD = [
  { t: 5, speaker: 'T', text: 'あかりさん、きのうは なにを しましたか？' },
  { t: 9, speaker: 's1', text: 'きのう、学校に いきます' },
  { t: 12, speaker: 'T', text: 'きのう、学校に いったんだね' },
  { t: 16, speaker: 's1', text: 'きのう、学校に いったんだね' },
  { t: 22, speaker: 'T', text: 'はるとさん、どう おもう？' },
  { t: 26, speaker: 's2', text: 'ぼくは こうえんに いきました' },
  { t: 30, speaker: 'T', text: 'いいね、ありがとう' },
  { t: 36, speaker: 'T', text: 'いまの、じぶんのことばで 言ってみて' },
  { t: 41, speaker: 's2', text: 'ぼくは こうえんで あそびました' },
  { t: 48, speaker: 's3', text: 'もういちど 言って' },
  { t: 53, speaker: 'T', text: 'つまり、こうえんに いったんだね' },
];
const scored = scoreLesson(GOOD, { roster: ['s1', 's2', 's3', 's4'] });
const { observation, evaluation } = contract.evaluate(scored, { durationSec: 900 });

test('観察入力：事実だけを載せ、解釈を混ぜない', () => {
  assert.ok(observation.observations.length > 0);
  for (const o of observation.observations) {
    assert.ok(typeof o.fact === 'string' && o.fact.length > 0, 'fact が要る');
    assert.ok(o.start_sec >= 0 && o.end_sec >= o.start_sec, '時刻が壊れていない');
    assert.ok(o.confidence > 0 && o.confidence <= 1, 'confidence が範囲内');
    assert.ok(!('interpretation' in o), '観察に解釈を入れない');
  }
});

test('観察入力：level 1 を絶対に出さない', () => {
  for (const c of observation.dimension_candidates) {
    assert.notStrictEqual(c.candidate_level, 1,
      'level 1（学習を狭める働きが確認される）は、書き起こしの統計からは立てられない');
  }
});

test('不変条件2：scored 以外の軸は score も level も null', () => {
  for (const d of evaluation.dimensions) {
    if (d.status === 'scored') {
      assert.ok(Number.isInteger(d.level) && d.level >= 1 && d.level <= 5);
      assert.ok([10, 30, 50, 70, 90].includes(d.score));
    } else {
      assert.strictEqual(d.score, null, `${d.key} の score は null であること`);
      assert.strictEqual(d.level, null, `${d.key} の level は null であること`);
    }
  }
});

test('不変条件3：1軸でも未確定なら総合点を出さない', () => {
  const allScored = evaluation.dimensions.every((d) => d.status === 'scored');
  if (!allScored) {
    assert.strictEqual(evaluation.overall_score, null, '未確定があるのに総合点を出している');
    assert.strictEqual(evaluation.overall_confidence, null);
  }
});

test('不変条件4：confidence 0.65 未満は人間確認へ落ちる', () => {
  // リキャストと取り込みは 0.6。だから訂正の軸は自動確定しない。
  const cf = evaluation.dimensions.find((d) => d.key === 'corrective_feedback_and_uptake');
  assert.strictEqual(cf.status, 'review_required', '推定に頼った軸を自動確定してはいけない');
  assert.ok(cf.reason_codes.includes('LOW_CANDIDATE_CONFIDENCE')
    || cf.reason_codes.includes('LOW_EVIDENCE_CONFIDENCE'));
});

test('不変条件5：measurement は採点に使われていない', () => {
  // 発話比を大きく変えても、軸のスコアは動かない
  const loud = scoreLesson([...GOOD, { t: 300, speaker: 'T', text: 'あ'.repeat(400) }], { roster: ['s1', 's2', 's3', 's4'] });
  const after = contract.evaluate(loud, { durationSec: 900 }).evaluation;
  assert.notStrictEqual(after.measurement.teacher_talk_ratio, evaluation.measurement.teacher_talk_ratio,
    '発話比自体は変わること');
  const before = evaluation.dimensions.map((d) => `${d.key}:${d.status}:${d.score}`).join('|');
  const now = after.dimensions.map((d) => `${d.key}:${d.status}:${d.score}`).join('|');
  assert.strictEqual(now, before, '発話比が変わっても、軸の判定は動いてはいけない');
});

test('不変条件6：観察できない軸を低得点で埋めない', () => {
  const thin = scoreLesson([{ t: 5, speaker: 'T', text: 'はじめましょう' }], { roster: ['s1'] });
  const r = contract.evaluate(thin, { durationSec: 900 }).evaluation;
  for (const d of r.dimensions) {
    assert.notStrictEqual(d.score, 10, '判定できない軸に最低点を入れてはいけない');
    assert.ok(['not_observable', 'review_required'].includes(d.status));
  }
  assert.strictEqual(r.overall_score, null);
});

test('不変条件7：観察層は点を返さない', () => {
  const json = JSON.stringify(observation);
  assert.ok(!json.includes('"overall_score"'), '観察入力に総合点を入れない');
  assert.ok(!json.includes('"score"'), '観察入力にスコアを入れない');
});

test('人間評定が主の軸は、こちらから候補を出さない', () => {
  const out = observation.dimension_candidates.find((c) => c.dimension_key === 'output_quality_and_transformation');
  assert.strictEqual(out, undefined, 'アウトプットの軸はAIが候補を出さない');
  const dim = evaluation.dimensions.find((d) => d.key === 'output_quality_and_transformation');
  assert.strictEqual(dim.status, 'not_observable');
});

test('発話量の軸（TD）は契約に持ち込まれない', () => {
  const keys = evaluation.dimensions.map((d) => d.key);
  assert.strictEqual(keys.length, 5);
  assert.ok(!keys.some((k) => k.includes('turn') || k.includes('talk')),
    '発話量・発話比は軸にしない（measurement に置く）');
  assert.ok(evaluation.measurement.teacher_talk_ratio !== undefined);
});

test('限界を必ず書く', () => {
  assert.ok(evaluation.limitations.length >= 2);
  assert.ok(evaluation.limitations.some((l) => l.includes('書き起こし')), '何を見ていないかを書く');
});

test('版が全部記録される', () => {
  const m = evaluation.model_metadata;
  for (const k of ['provider', 'model', 'prompt_version', 'rubric_version', 'scorer_version', 'contract_version']) {
    assert.ok(m[k], `${k} が要る`);
  }
  assert.strictEqual(m.rubric_version, 'nijin-nihongo-1.0.0');
});

test('決定的：同じ書き起こしから同じ評価が出る', () => {
  const a = contract.evaluate(scoreLesson(GOOD, { roster: ['s1', 's2', 's3', 's4'] }), { durationSec: 900 }).evaluation;
  const b = contract.evaluate(scoreLesson(GOOD, { roster: ['s1', 's2', 's3', 's4'] }), { durationSec: 900 }).evaluation;
  assert.deepStrictEqual(a.dimensions, b.dimensions);
  assert.strictEqual(a.analysis_id, b.analysis_id, '同じ入力なら分析IDも同じ');
});

test('ルーブリック：nijin-core と2軸だけキーを共有する', () => {
  const rubric = contract.loadRubric();
  const keys = rubric.dimensions.map((d) => d.key);
  assert.ok(keys.includes('psychological_safety_and_participation_choice'));
  assert.ok(keys.includes('output_quality_and_transformation'));
  assert.strictEqual(rubric.dimensions.reduce((a, d) => a + d.weight, 0), 100, '重みの合計は100');
});

const ng = results.filter((r) => r[0] === 'NG');
console.log('');
for (const [s, name] of results) console.log(`  ${s === 'ok' ? '  ok' : '  NG'}  ${name}`);
console.log('');
console.log(`  ${results.length - ng.length} / ${results.length} 通過`);
console.log('');
process.exit(ng.length ? 1 : 0);
