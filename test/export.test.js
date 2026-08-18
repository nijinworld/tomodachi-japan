'use strict';
// node test/export.test.js
// 書き出しのテスト。守っているのは3つです。
//   1. Excel で開いても日本語が化けない（BOM）
//   2. 子どもの識別子が外に出ない（仮名化を破らない）
//   3. 同じデータからは必ず同じファイルが出る（再現性）
// db はここで手で組み立てます。data/ の実データは読みません。
const assert = require('node:assert');

const xp = require('../server/lib/export');

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push(['ok', name]);
  } catch (e) {
    results.push(['NG', `${name}\n     ${e.message}`]);
  }
}

const DIMS = ['CI', 'TD', 'CF', 'NM', 'SC', 'OUT'];

// ---- テスト用の db ----
// 授業2本、うち ls_1 は2名が採点、ls_2 は1名だけ（＝IRRのペアにならない）。
function makeDims(base) {
  const out = {};
  DIMS.forEach((code, i) => {
    out[code] = {
      code,
      name: `観点${code}`,
      rater: code === 'OUT' ? 'human' : 'ai',
      indicator: 'x',
      value: base + i / 100,
      level: (base * 10 + i) % 5,
    };
  });
  return out;
}

function makeDb() {
  return {
    lessons: [
      { id: 'ls_1', classId: 'cl_0', facilitatorId: 'u_a1', arm: 'A', date: '2026-06-23', durationMin: 45, attendance: 8 },
      { id: 'ls_2', classId: 'cl_1', facilitatorId: 'u_b1', arm: 'B', date: '2026-07-01', durationMin: 45, attendance: 7 },
      { id: 'ls_3', classId: 'cl_1', facilitatorId: 'u_b1', arm: 'B', date: '2026-07-08', durationMin: 45, attendance: 8 },
    ],
    scores: [
      {
        id: 'sc_1',
        lessonId: 'ls_1',
        facilitatorId: 'u_a1',
        classId: 'cl_0',
        arm: 'A',
        date: '2026-06-23',
        source: 'ai',
        modelVersionId: 'mv_1',
        dims: makeDims(0.5),
        overall: 2.8,
        signals: {
          teacher_talk_ratio: 0.738,
          uptake_rate: 0.462,
          wait_time_median_sec: 3,
          student_turn_gini: 0.212,
          silent_student_count: 0,
        },
      },
      {
        id: 'sc_2',
        lessonId: 'ls_2',
        facilitatorId: 'u_b1',
        classId: 'cl_1',
        arm: 'B',
        date: '2026-07-01',
        source: 'ai',
        modelVersionId: 'mv_1',
        dims: makeDims(0.3),
        overall: 2.2,
        signals: {
          teacher_talk_ratio: 0.51,
          uptake_rate: 0.6,
          wait_time_median_sec: 4,
          student_turn_gini: 0.18,
          silent_student_count: 1,
        },
      },
    ],
    ratings: [
      { id: 'rt_1', lessonId: 'ls_1', raterId: 'u_rater2', blind: true, dims: { CI: 3, TD: 2, CF: 3, NM: 3, SC: 3, OUT: 4 }, createdAt: '2026-08-10T00:00:00.000Z' },
      { id: 'rt_2', lessonId: 'ls_1', raterId: 'u_rater1', blind: true, dims: { CI: 2, TD: 1, CF: 4, NM: 4, SC: 3, OUT: 3 }, createdAt: '2026-08-10T00:00:00.000Z' },
      { id: 'rt_3', lessonId: 'ls_2', raterId: 'u_rater1', blind: false, dims: { CI: 2, TD: 2, CF: 3, NM: 4, SC: 3, OUT: 4 }, createdAt: '2026-08-11T00:00:00.000Z' },
    ],
    mentorLogs: [
      { id: 'ml_1', mentorId: 'u_mentorA', facilitatorId: 'u_a1', arm: 'A', date: '2026-06-24', week: '2026-06-22', minutes: 50, kind: 'observation', note: '授業を見て所見を書いた' },
      { id: 'ml_2', mentorId: 'u_mentorB', facilitatorId: 'u_b1', arm: 'B', date: '2026-06-24', week: '2026-06-22', minutes: 8, kind: 'feedback', note: 'AIの所見を確認した' },
    ],
    surveyResponses: [
      { id: 'sr_1', facilitatorId: 'u_a1', classId: 'cl_0', studentId: 'st_0_0|あかり1', arm: 'A', cycle: '2026-C1', answers: { CI1: 3, TD1: 4, BL1: 5 }, createdAt: '2026-07-05T00:00:00.000Z' },
      { id: 'sr_2', facilitatorId: 'u_a1', classId: 'cl_0', studentId: 'st_0_1|はると1', arm: 'A', cycle: '2026-C1', answers: { CI1: 4, TD1: 5, BL1: 4 }, createdAt: '2026-07-05T00:00:00.000Z' },
      { id: 'sr_3', facilitatorId: 'u_b1', classId: 'cl_1', studentId: 'st_3_0|ひなた4', arm: 'B', cycle: '2026-C2', answers: { CI1: 2, TD1: 3, BL1: 3 }, createdAt: '2026-07-19T00:00:00.000Z' },
    ],
    costItems: [
      { id: 'ci_1', category: '研修', actor: 'facilitator', arm: 'B', label: '事前研修の受講（本人の時間）', hours: 60, jpy: 0, qty: 3, note: '未経験のぶん長い、そのぶん時間が要る' },
      { id: 'ci_2', category: '採用', actor: 'vendor', arm: null, label: '募集広告・スカウト', hours: 0, jpy: 180000, qty: 1 },
    ],
  };
}

// ---- 汎用CSV ----
test('CSV：カンマ・引用符・改行をエスケープする', () => {
  const cols = [{ key: 'a', label: 'a' }, { key: 'b', label: 'b' }, { key: 'c', label: 'c' }];
  const csv = xp.toCsv([{ a: 'あ,い', b: '「"引用"」', c: '1行目\n2行目' }], cols);
  assert.ok(csv.includes('"あ,い"'), 'カンマを含む値は囲まれていない');
  assert.ok(csv.includes('"「""引用""」"'), '引用符が倍化されていない');
  assert.ok(csv.includes('"1行目\n2行目"'), '改行を含む値は囲まれていない');
});

test('CSV：先頭にBOMが付く（Excelで化けないため）', () => {
  const csv = xp.toCsv([], [{ key: 'a', label: 'a' }]);
  assert.strictEqual(csv.charCodeAt(0), 0xFEFF);
});

test('CSV：null と undefined は空文字（0 にしない）', () => {
  const cols = [{ key: 'a', label: 'a' }, { key: 'b', label: 'b' }, { key: 'c', label: 'c' }];
  const csv = xp.toCsv([{ a: null, b: undefined, c: 0 }], cols);
  const body = csv.slice(1).split('\r\n')[1];
  assert.strictEqual(body, ',,0');
});

test('CSV：行がなくてもヘッダは出る', () => {
  const csv = xp.toCsv([], [{ key: 'a', label: 'ア' }, { key: 'b', label: 'イ' }]);
  assert.strictEqual(csv.slice(1), 'ア,イ\r\n');
});

// ---- 一覧 ----
test('データセットは8つ。id・列がすべて揃っている', () => {
  const ds = xp.datasets();
  assert.strictEqual(ds.length, 8);
  const ids = ds.map((d) => d.id);
  assert.deepStrictEqual(ids, [
    'scores_long', 'scores_wide', 'mentor_logs', 'ratings',
    'irr_pairs', 'survey_responses', 'cost_items', 'lessons',
  ]);
  for (const d of ds) {
    assert.ok(d.label && d.description, `${d.id} に説明がない`);
    assert.ok(d.columns.length > 0, `${d.id} に列がない`);
    for (const c of d.columns) assert.ok(c.key && c.label, `${d.id} の列に key/label がない`);
  }
});

test('知らない id は例外になる', () => {
  let code = null;
  try { xp.build('nope', {}); } catch (e) { code = e.code; }
  assert.strictEqual(code, 'UNKNOWN_DATASET');
});

// ---- 空でも落ちない ----
test('空のdbでも8つすべてがヘッダだけのCSVを返す', () => {
  for (const d of xp.datasets()) {
    const r = xp.build(d.id, {});
    assert.strictEqual(r.rows.length, 0, `${d.id} に行が出ている`);
    const labels = d.columns.map((c) => c.label).join(',');
    assert.strictEqual(r.csv.slice(1), `${labels}\r\n`, `${d.id} のヘッダが違う`);
    assert.strictEqual(r.filename, `ranius_${d.id}_nodata.csv`, `${d.id} のファイル名が違う`);
  }
});

test('コレクションが丸ごと無いdbでも落ちない', () => {
  for (const d of xp.datasets()) {
    assert.doesNotThrow(() => xp.build(d.id, undefined));
    assert.doesNotThrow(() => xp.build(d.id, { scores: null, lessons: 'こわれた値' }));
  }
});

// ---- scores ----
test('scores_long の行数 = 授業数 × 観点数', () => {
  const db = makeDb();
  const r = xp.build('scores_long', db);
  assert.strictEqual(r.rows.length, db.scores.length * DIMS.length);
  assert.strictEqual(r.rows.length, 12);
});

test('scores_long は観点コードと rater（ai / human）を持つ', () => {
  const r = xp.build('scores_long', makeDb());
  const first = r.rows.slice(0, DIMS.length).map((x) => x.dimension);
  assert.deepStrictEqual(first, DIMS);
  assert.strictEqual(r.rows.find((x) => x.dimension === 'OUT').rater, 'human');
  assert.strictEqual(r.rows.find((x) => x.dimension === 'CI').rater, 'ai');
  assert.strictEqual(r.rows[0].lesson_id, 'ls_1');
  assert.strictEqual(r.rows[0].arm, 'A');
});

test('scores_wide は1授業1行。観点・overall・主要signalsが列に出る', () => {
  const db = makeDb();
  const r = xp.build('scores_wide', db);
  assert.strictEqual(r.rows.length, db.scores.length);
  const row = r.rows[0];
  for (const code of DIMS) assert.strictEqual(typeof row[code], 'number', `${code} が数値でない`);
  assert.strictEqual(row.overall, 2.8);
  assert.strictEqual(row.teacher_talk_ratio, 0.738);
  assert.strictEqual(row.uptake_rate, 0.462);
  assert.strictEqual(row.wait_time_median_sec, 3);
  assert.strictEqual(row.student_turn_gini, 0.212);
  assert.strictEqual(row.silent_student_count, 0);
});

test('signals が無い採点でも scores_wide は空欄で出る（落ちない）', () => {
  const r = xp.build('scores_wide', { scores: [{ lessonId: 'ls_x', date: '2026-06-23' }] });
  assert.strictEqual(r.rows.length, 1);
  assert.strictEqual(r.rows[0].teacher_talk_ratio, null);
  assert.strictEqual(r.rows[0].CI, null);
});

// ---- 評定と IRR ----
test('ratings は 評定者×授業×観点 で出る', () => {
  const db = makeDb();
  const r = xp.build('ratings', db);
  assert.strictEqual(r.rows.length, db.ratings.length * DIMS.length);
  assert.strictEqual(r.rows[0].blind, 'true');
  assert.strictEqual(r.rows.find((x) => x.lesson_id === 'ls_2').blind, 'false');
});

test('irr_pairs は2名で採点された授業だけを出す', () => {
  const r = xp.build('irr_pairs', makeDb());
  const lessons = [...new Set(r.rows.map((x) => x.lesson_id))];
  assert.deepStrictEqual(lessons, ['ls_1'], '1名しか採点していない授業が混ざっている');
  assert.strictEqual(r.rows.length, DIMS.length);
});

test('irr_pairs の a と b は入力の並び順で入れ替わらない', () => {
  const r = xp.build('irr_pairs', makeDb());
  const ci = r.rows.find((x) => x.dimension === 'CI');
  // db では u_rater2 の行が先に入っているが、並べ替えて a=u_rater1 に固定する
  assert.strictEqual(ci.rater_a, 'u_rater1');
  assert.strictEqual(ci.rater_b, 'u_rater2');
  assert.strictEqual(ci.level_a, 2);
  assert.strictEqual(ci.level_b, 3);
  assert.strictEqual(ci.diff, -1);
});

// ---- 仮名化 ----
test('survey_responses に studentId が含まれない', () => {
  const db = makeDb();
  const r = xp.build('survey_responses', db);
  assert.ok(!r.csv.includes('studentId'), '列名に studentId が出ている');
  assert.ok(!r.csv.includes('st_0_0'), '子どもの識別子が出ている');
  assert.ok(!r.csv.includes('あかり'), '子どもの名前が出ている');
  assert.ok(!r.csv.includes('はると'), '子どもの名前が出ている');
  assert.ok(!r.csv.includes('ひなた'), '子どもの名前が出ている');
  for (const row of r.rows) {
    assert.ok(!Object.keys(row).includes('studentId'), '行に studentId が残っている');
    assert.ok(!JSON.stringify(row).includes('st_'), '行に子どもの識別子が残っている');
  }
});

test('survey_responses の回答者はサイクル内の連番だけ', () => {
  const db = makeDb();
  const r = xp.build('survey_responses', db);
  assert.strictEqual(r.rows.length, 3 * 3); // 回答3件 × 項目3つ
  const c1 = [...new Set(r.rows.filter((x) => x.cycle === '2026-C1').map((x) => x.respondent_index))];
  assert.deepStrictEqual(c1, [1, 2]);
  // サイクルが変われば1に戻る（＝サイクルをまたいで同じ子を追えない）
  const c2 = [...new Set(r.rows.filter((x) => x.cycle === '2026-C2').map((x) => x.respondent_index))];
  assert.deepStrictEqual(c2, [1]);
});

test('survey_responses は項目コードから観点を引く', () => {
  const r = xp.build('survey_responses', makeDb());
  assert.strictEqual(r.rows.find((x) => x.item_code === 'CI1').dimension, 'CI');
  assert.strictEqual(r.rows.find((x) => x.item_code === 'BL1').dimension, 'BL');
});

test('どのデータセットにも子どもの名前が出ない', () => {
  const db = makeDb();
  for (const d of xp.datasets()) {
    const { csv } = xp.build(d.id, db);
    for (const name of ['あかり', 'はると', 'ひなた', 'st_0_0']) {
      assert.ok(!csv.includes(name), `${d.id} に ${name} が出ている`);
    }
  }
});

// ---- 残りのデータセット ----
test('mentor_logs は1記録1行', () => {
  const db = makeDb();
  const r = xp.build('mentor_logs', db);
  assert.strictEqual(r.rows.length, db.mentorLogs.length);
  assert.strictEqual(r.rows[0].minutes, 50);
  assert.strictEqual(r.rows[0].week, '2026-06-22');
  assert.strictEqual(r.rows[0].kind, 'observation');
});

test('lessons は採点済みかどうかを持つ', () => {
  const r = xp.build('lessons', makeDb());
  assert.strictEqual(r.rows.length, 3);
  assert.strictEqual(r.rows.find((x) => x.lesson_id === 'ls_1').scored, 'true');
  assert.strictEqual(r.rows.find((x) => x.lesson_id === 'ls_3').scored, 'false');
  assert.strictEqual(r.rows[0].duration_min, 45);
});

test('cost_items は時間と金額をそのまま出す', () => {
  const db = makeDb();
  const r = xp.build('cost_items', db);
  assert.strictEqual(r.rows.length, db.costItems.length);
  assert.strictEqual(r.rows[0].hours, 60);
  assert.strictEqual(r.rows[1].jpy, 180000);
});

// ---- 日本語とファイル名 ----
test('日本語がそのままCSVに出る（化けない・落ちない）', () => {
  const { csv } = xp.build('cost_items', makeDb());
  assert.ok(csv.includes('研修'));
  assert.ok(csv.includes('事前研修の受講（本人の時間）'));
  assert.ok(csv.includes('募集広告・スカウト'));
  assert.strictEqual(csv.charCodeAt(0), 0xFEFF);
});

test('ファイル名はデータ中のいちばん新しい日付で決まる', () => {
  const db = makeDb();
  assert.strictEqual(xp.build('lessons', db).filename, 'ranius_lessons_2026-07-08.csv');
  assert.strictEqual(xp.build('scores_long', db).filename, 'ranius_scores_long_2026-07-01.csv');
  assert.strictEqual(xp.build('mentor_logs', db).filename, 'ranius_mentor_logs_2026-06-24.csv');
  // 評定は観測日を持たないので作成時刻に落ちる
  assert.strictEqual(xp.build('ratings', db).filename, 'ranius_ratings_2026-08-11.csv');
  // 費用の明細は日付をまったく持たないので、db 全体のいちばん新しい日付を借りる
  assert.strictEqual(xp.build('cost_items', db).filename, 'ranius_cost_items_2026-07-08.csv');
});

test('ファイル名は観測日を優先する（作成時刻で上書きされない）', () => {
  // 種まきをやり直して createdAt だけが新しくなっても、ファイル名は動かないこと
  const db = makeDb();
  for (const l of db.lessons) l.createdAt = '2027-01-01T00:00:00.000Z';
  assert.strictEqual(xp.build('lessons', db).filename, 'ranius_lessons_2026-07-08.csv');
});

test('同じdbからは何度でも同じCSVとファイル名が出る（再現性）', () => {
  for (const d of xp.datasets()) {
    const a = xp.build(d.id, makeDb());
    const b = xp.build(d.id, makeDb());
    assert.strictEqual(a.csv, b.csv, `${d.id} のCSVが揺れる`);
    assert.strictEqual(a.filename, b.filename, `${d.id} のファイル名が揺れる`);
  }
});

test('書き出しは元のdbを書き換えない', () => {
  const db = makeDb();
  const before = JSON.stringify(db);
  for (const d of xp.datasets()) xp.build(d.id, db);
  assert.strictEqual(JSON.stringify(db), before);
});

test('列の数とCSVのセルの数が合う（列がずれない）', () => {
  const db = makeDb();
  for (const d of xp.datasets()) {
    const r = xp.build(d.id, db);
    const header = r.csv.slice(1).split('\r\n')[0];
    assert.strictEqual(header.split(',').length, d.columns.length, `${d.id} のヘッダの数が合わない`);
    for (const row of r.rows) {
      assert.strictEqual(Object.keys(row).length, d.columns.length, `${d.id} の行の項目数が合わない`);
    }
  }
});

// ---- 結果 ----
const ng = results.filter((r) => r[0] === 'NG');
console.log('');
for (const [s, name] of results) console.log(`  ${s === 'ok' ? '  ok' : '  NG'}  ${name}`);
console.log('');
console.log(`  ${results.length - ng.length} / ${results.length} 通過`);
console.log('');
process.exit(ng.length ? 1 : 0);
