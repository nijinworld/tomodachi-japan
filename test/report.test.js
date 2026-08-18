'use strict';
// node test/report.test.js
// 週次サマリ（server/lib/report.js）のテスト。
// db はここで手で組み立てます。data/ は読みません（本物のデータに触らないため）。
// ここで守っているのは機能ではなく、外してはいけない約束のほうです。
//   ・先生の順位を作らない／比べる言い方をしない
//   ・人格に触れる語を出さない
//   ・未測定と0を混ぜない
//   ・同じ入力から必ず同じテキストが出る
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { weekly } = require('../server/lib/report');

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push(['ok', name]);
  } catch (e) {
    results.push(['NG', `${name}\n     ${e.message}`]);
  }
}

// 2026-08-18 は火曜。この日を含む週の月曜は 2026-08-17。
const AS_OF = '2026-08-18';
const WEEK = '2026-08-17';

// ---- テスト用の db（手で組み立てる） ----

function dims(ci, td, cf, nm, sc) {
  return {
    CI: { code: 'CI', rater: 'ai', level: ci },
    TD: { code: 'TD', rater: 'ai', level: td },
    CF: { code: 'CF', rater: 'ai', level: cf },
    NM: { code: 'NM', rater: 'ai', level: nm },
    SC: { code: 'SC', rater: 'ai', level: sc },
    // 人が採点する観点。AIの平均にも、いちばん低い観点にも入れないこと
    OUT: { code: 'OUT', rater: 'human', level: 0 },
  };
}

function score(id, lessonId, fid, date, arm, ds, overall) {
  return { id, lessonId, facilitatorId: fid, classId: null, arm, date, source: 'ai', dims: ds, overall };
}

function baseDb() {
  return {
    users: [
      { id: 'u_m1', name: 'メンターX', role: 'mentor', arm: 'A', teamId: 'tm_x', status: 'active' },
      { id: 'u_f1', name: 'あおい', role: 'facilitator', arm: 'A', teamId: 'tm_x', status: 'active' },
      { id: 'u_f2', name: 'かえで', role: 'facilitator', arm: 'B', teamId: 'tm_y', status: 'active' },
    ],
    classes: [
      { id: 'c1', name: 'あおい組', facilitatorId: 'u_f1', teamId: 'tm_x', arm: 'A', studentIds: ['st_1'] },
      { id: 'c2', name: 'かえで組', facilitatorId: 'u_f2', teamId: 'tm_y', arm: 'B', studentIds: ['st_2'] },
    ],
    lessons: [
      { id: 'l1', classId: 'c1', facilitatorId: 'u_f1', arm: 'A', date: '2026-08-17' },
      { id: 'l2', classId: 'c1', facilitatorId: 'u_f1', arm: 'A', date: '2026-08-18' },
      { id: 'l3', classId: 'c2', facilitatorId: 'u_f2', arm: 'B', date: '2026-08-17' },
      // 先週の授業（本人の直近の比較に使う）
      { id: 'l0', classId: 'c1', facilitatorId: 'u_f1', arm: 'A', date: '2026-08-11' },
    ],
    scores: [
      score('s1', 'l1', 'u_f1', '2026-08-17', 'A', dims(3, 1, 3, 3, 3), 2.6),
      score('s2', 'l2', 'u_f1', '2026-08-18', 'A', dims(3, 2, 3, 3, 3), 2.8),
      score('s3', 'l3', 'u_f2', '2026-08-17', 'B', dims(2, 3, 2, 2, 2), 2.2),
      score('s0', 'l0', 'u_f1', '2026-08-11', 'A', dims(2, 2, 2, 2, 2), 2.0),
    ],
    feedbacks: [],
    mentorLogs: [],
    surveyResponses: [],
    clips: [],
    meetings: [],
    students: [],
    settings: [],
  };
}

const opts = (extra) => ({ asOf: AS_OF, weeks: 4, audience: 'admin', ...extra });

// ---- 基本 ----

test('空の db でも落ちない。週は asOf を含む週の月曜になる', () => {
  const r = weekly({}, opts());
  assert.strictEqual(r.week, WEEK);
  assert.ok(typeof r.text === 'string' && r.text.length > 0, 'テキストが出ること');
  assert.ok(Array.isArray(r.sections) && r.sections.length === 7, '7つの節が出ること');
  assert.ok(Array.isArray(r.warnings), 'warnings は配列');
});

test('空の db では「未測定」と書かれる（0とは書かない）', () => {
  const r = weekly({}, opts());
  assert.ok(r.text.includes('未測定'), '未測定と書くこと');
  assert.ok(!/授業：0本/.test(r.text), '記録がないのに 0本 と書かないこと');
});

test('db が null でも落ちない', () => {
  const r = weekly(null, opts());
  assert.ok(r.text.includes('未測定'));
});

test('asOf がなければ例外（時計を見ないため）', () => {
  let code = null;
  try { weekly(baseDb(), { weeks: 4 }); } catch (e) { code = e.code; }
  assert.strictEqual(code, 'ASOF_REQUIRED', 'ASOF_REQUIRED を投げること');
  let code2 = null;
  try { weekly(baseDb(), { asOf: '2026/08/18' }); } catch (e) { code2 = e.code; }
  assert.strictEqual(code2, 'ASOF_REQUIRED', '形式が違えば投げること');
});

test('見出しはすべて「## 」で始まる', () => {
  const r = weekly(baseDb(), opts());
  const heads = r.text.split('\n').filter((l) => l.startsWith('#'));
  assert.strictEqual(heads.length, 7, `見出しは7つ（実際 ${heads.length}）`);
  for (const h of heads) assert.ok(h.startsWith('## '), `見出しの書き方: ${h}`);
});

test('1行は80文字までに収まる', () => {
  const r = weekly(baseDb(), opts());
  const long = r.text.split('\n').filter((l) => l.length > 80);
  assert.strictEqual(long.length, 0, `長すぎる行: ${long[0] || ''}`);
});

// ---- 順位を作らない ----

test('先生が2人いても、比べる語が出力に入らない', () => {
  const r = weekly(baseDb(), opts());
  for (const w of ['より', '最も', 'トップ', '下位', '上位', 'ランキング', '順位']) {
    assert.ok(!r.text.includes(w), `比べる語が入っている: ${w}`);
  }
});

test('先生は登録順に出る（点数で並べ替えない）', () => {
  const db = baseDb();
  // かえで（2.2）のほうが低いが、登録順は あおい → かえで のまま
  const r = weekly(db, opts());
  const i1 = r.text.indexOf('あおいさん');
  const i2 = r.text.indexOf('かえでさん');
  assert.ok(i1 > 0 && i2 > 0, '2人とも出ること');
  assert.ok(i1 < i2, '登録順のままであること');
});

test('先生ごとの一行に、本数・5観点の平均・本人の直近・いちばん低い観点が出る', () => {
  const r = weekly(baseDb(), opts());
  const line = r.text.split('\n').find((l) => l.startsWith('- あおいさん'));
  assert.ok(line, 'あおいさんの行が出ること');
  assert.ok(line.includes('今週2本'), `本数: ${line}`);
  assert.ok(line.includes('5観点の平均 2.7'), `今週の平均: ${line}`);
  assert.ok(line.includes('本人の直近1回 2.0'), `本人の直近: ${line}`);
  assert.ok(/いちばん低い観点 TD$/.test(line), `いちばん低い観点: ${line}`);
});

test('人が採点する観点（OUT）は、いちばん低い観点に選ばれない', () => {
  const r = weekly(baseDb(), opts());
  const line = r.text.split('\n').find((l) => l.startsWith('- かえでさん'));
  assert.ok(line.includes('いちばん低い観点'), 'いちばん低い観点が出ること');
  assert.ok(!line.includes('OUT'), `OUT は AI の平均にも比較にも入れない: ${line}`);
});

test('採点がまだの先生は「未測定」。0.0 とは書かない', () => {
  const db = baseDb();
  db.scores = db.scores.filter((s) => s.facilitatorId !== 'u_f2');
  const r = weekly(db, opts());
  const line = r.text.split('\n').find((l) => l.startsWith('- かえでさん'));
  assert.ok(line.includes('未測定'), `未測定と書くこと: ${line}`);
  assert.ok(!line.includes('平均 0'), `0 とは書かないこと: ${line}`);
});

// ---- 人格に触れる語 ----

test('人格語を含む宣言が meetings にあれば例外（PERSONALITY_TERM）', () => {
  const db = baseDb();
  db.meetings = [{
    id: 'mt1',
    teamId: 'tm_x',
    date: '2026-08-17',
    declarations: [{ facilitatorId: 'u_f1', dimension: 'TD', action: '熱意をもっと前に出す' }],
  }];
  let err = null;
  try { weekly(db, opts()); } catch (e) { err = e; }
  assert.ok(err, '例外になること');
  assert.strictEqual(err.code, 'PERSONALITY_TERM');
  assert.ok(err.terms.includes('熱意'), `見つけた語: ${JSON.stringify(err.terms)}`);
});

test('人格語のない宣言は、そのまま「今週の宣言」に出る', () => {
  const db = baseDb();
  db.meetings = [{
    id: 'mt1',
    teamId: 'tm_x',
    date: '2026-08-17',
    declarations: [
      { facilitatorId: 'u_f1', dimension: 'TD', action: '指名したあと3つ数えてから次に行く' },
      { facilitatorId: 'u_f2', dimension: 'SC', action: '開始5分以内に全員に1回ずつ順番を回す' },
    ],
  }];
  const r = weekly(db, opts());
  assert.ok(r.text.includes('指名したあと3つ数えてから次に行く'), '宣言が出ること');
  assert.ok(r.text.includes('開始5分以内に全員に1回ずつ順番を回す'), 'もう1人の宣言も出ること');
});

test('今週のチーム会がなければ「未測定」', () => {
  const db = baseDb();
  db.meetings = [{ id: 'mt0', teamId: 'tm_x', date: '2026-07-06', declarations: [] }];
  const r = weekly(db, opts());
  const sec = r.sections.find((s) => s.title === '今週の宣言');
  assert.ok(sec.lines.join('\n').includes('未測定'), '未測定と書くこと');
});

// ---- メンターの記録 ----

test('メンター記録がない週は「0人」ではなく「未測定」', () => {
  const r = weekly(baseDb(), opts());
  const sec = r.sections.find((s) => s.title === 'メンターの記録');
  const body = sec.lines.join('\n');
  assert.ok(body.includes('未測定'), '未測定と書くこと');
  assert.ok(!body.includes('0人'), `0人 と書いてはいけない: ${body}`);
  assert.ok(!body.includes('0時間'), `0時間 と書いてはいけない: ${body}`);
  assert.ok(r.warnings.some((w) => w.includes('メンター')), 'warnings に残すこと');
});

test('メンター記録があれば、今週の担当人数と時間が出る', () => {
  const db = baseDb();
  db.mentorLogs = [
    { id: 'ml1', mentorId: 'u_m1', facilitatorId: 'u_f1', arm: 'A', date: '2026-08-17', minutes: 60, kind: 'observation' },
    { id: 'ml2', mentorId: 'u_m1', facilitatorId: 'u_f2', arm: 'A', date: '2026-08-18', minutes: 30, kind: 'feedback' },
  ];
  const r = weekly(db, opts());
  const body = r.sections.find((s) => s.title === 'メンターの記録').lines.join('\n');
  assert.ok(body.includes('担当2人'), `担当人数: ${body}`);
  assert.ok(body.includes('1.5時間'), `時間: ${body}`);
  assert.ok(body.includes('外挿'), '1.0FTE換算が外挿であることを書くこと');
});

// ---- 返し方が止まっているアンケート ----

function withSurvey(entry) {
  const db = baseDb();
  db.surveyResponses = [
    { id: 'sr1', facilitatorId: 'u_f1', classId: 'c1', cycle: '2026-C1', studentId: null, arm: 'A', answers: { CI1: 4 } },
    { id: 'sr2', facilitatorId: 'u_f1', classId: 'c1', cycle: '2026-C1', studentId: null, arm: 'A', answers: { CI1: 3 } },
  ];
  db.settings = [{ id: 'set_survey_cycles', key: 'survey_cycles', value: { 'u_f1|2026-C1': entry } }];
  return db;
}

test('返し方が欠けているサイクルが「返し方が止まっているアンケート」に出る', () => {
  const db = withSurvey({ returned_at: '2026-08-17T00:00:00.000Z' });
  const r = weekly(db, opts());
  const body = r.sections.find((s) => s.title === '返し方が止まっているアンケート').lines.join('\n');
  assert.ok(body.includes('あおいさんの 2026-C1'), `対象が出ること: ${body}`);
  assert.ok(body.includes('2つが欠けています'), `欠けた数: ${body}`);
  assert.ok(body.includes('子どもに'), '欠けている手順の中身が出ること');
  assert.ok(r.warnings.some((w) => w.includes('返し方')), 'warnings に残すこと');
});

test('3手順そろっていれば、止まっているものは0件', () => {
  const db = withSurvey({
    returned_at: '2026-08-17T00:00:00.000Z',
    action_declared_at: '2026-08-17T00:00:00.000Z',
    discussed_with_students_at: '2026-08-18T00:00:00.000Z',
  });
  const r = weekly(db, opts());
  const body = r.sections.find((s) => s.title === '返し方が止まっているアンケート').lines.join('\n');
  assert.ok(body.includes('止まっているものはありません'), body);
});

test('アンケートの回答が1件もなければ「未測定」', () => {
  const r = weekly(baseDb(), opts());
  const body = r.sections.find((s) => s.title === '返し方が止まっているアンケート').lines.join('\n');
  assert.ok(body.includes('未測定'), body);
});

// ---- 止まっているもの ----

test('90日以上、書き起こしが入っていないクラスが出る', () => {
  const db = baseDb();
  db.lessons.push({ id: 'l9', classId: 'c2', facilitatorId: 'u_f2', arm: 'B', date: '2026-03-02' });
  // c2 の書き起こし（＝AIスコア）は 2026-03-02 の1本だけにする
  db.scores = db.scores.filter((s) => s.facilitatorId === 'u_f1');
  db.scores.push(score('s9', 'l9', 'u_f2', '2026-03-02', 'B', dims(2, 2, 2, 2, 2), 2.0));
  const r = weekly(db, opts());
  const body = r.sections.find((s) => s.title === '止まっているもの').lines.join('\n');
  assert.ok(body.includes('90日以上、書き起こしが入っていないクラス：1件'), body);
  assert.ok(body.includes('かえで組'), 'クラス名が出ること');
  assert.ok(body.includes('2026-03-02'), '最後の日付が出ること');
});

test('所見が未読のまま7日以上なら出る（7日未満は出さない）', () => {
  const db = baseDb();
  db.feedbacks = [
    { id: 'fb1', facilitatorId: 'u_f1', createdAt: '2026-08-01T00:00:00.000Z', acknowledgedAt: null },
    { id: 'fb2', facilitatorId: 'u_f1', createdAt: '2026-08-17T00:00:00.000Z', acknowledgedAt: null },
    { id: 'fb3', facilitatorId: 'u_f1', createdAt: '2026-07-01T00:00:00.000Z', acknowledgedAt: '2026-07-02T00:00:00.000Z' },
  ];
  const r = weekly(db, opts());
  const body = r.sections.find((s) => s.title === '止まっているもの').lines.join('\n');
  assert.ok(body.includes('所見が未読のまま7日以上：1件'), body);
  assert.ok(body.includes('2026-08-01'), 'いちばん古い日付が出ること');
});

test('視聴の問いに答えていないクリップが出る', () => {
  const db = baseDb();
  db.clips = [
    {
      id: 'cp1',
      lessonId: 'l1',
      title: '00:13 の場面',
      prompt: 'この30秒で、子どもが言い直したきっかけは何ですか。',
      views: [
        { userId: 'u_f1', date: '2026-08-17', answer: '' },
        { userId: 'u_f2', date: '2026-08-17', answer: '00:13 あたりです。' },
      ],
    },
  ];
  const r = weekly(db, opts());
  const body = r.sections.find((s) => s.title === '止まっているもの').lines.join('\n');
  assert.ok(body.includes('視聴の問いに答えていないクリップ：1件'), body);
  assert.ok(body.includes('00:13 の場面'), 'クリップの題が出ること');
});

// ---- 撤退基準 ----

test('撤退基準は、触れているものと未測定を分けて書く', () => {
  const db = baseDb();
  db.incidents = [{ id: 'in1', status: 'open', kind: 'safeguarding' }];
  const r = weekly(db, opts());
  const body = r.sections.find((s) => s.title === '撤退基準').lines.join('\n');
  assert.ok(body.includes('触れています'), body);
  assert.ok(body.includes('未測定'), '測れていない基準は未測定と書くこと');
  assert.ok(r.warnings.some((w) => w.includes('停止')), '停止に当たることを warnings に残すこと');
});

test('incidents が渡されなければ、事案は0件ではなく未測定', () => {
  const r = weekly(baseDb(), opts());
  const body = r.sections.find((s) => s.title === '撤退基準').lines.join('\n');
  assert.ok(body.includes('未測定'), body);
  assert.ok(body.includes('セーフガーディング事案'), '未測定の中身を並べること');
});

// ---- メンター向けの絞り込み ----

test('audience mentor ＋ mentorId で、担当の先生だけになる', () => {
  const db = baseDb();
  db.mentorLogs = [
    { id: 'ml1', mentorId: 'u_m1', facilitatorId: 'u_f1', arm: 'A', date: '2026-08-17', minutes: 60, kind: 'observation' },
  ];
  const r = weekly(db, opts({ audience: 'mentor', mentorId: 'u_m1' }));
  assert.ok(r.text.includes('あおいさん'), '担当の先生は出ること');
  assert.ok(!r.text.includes('かえでさん'), '担当外の先生は出さないこと');
  assert.ok(r.text.includes('メンター'), '宛先がメンターであること');
});

test('担当が特定できないときは、広げずに warnings に残す', () => {
  const r = weekly(baseDb(), opts({ audience: 'mentor', mentorId: 'u_unknown' }));
  assert.ok(r.warnings.some((w) => w.includes('担当')), '担当不明を残すこと');
  assert.ok(!r.text.includes('あおいさん'), '担当が分からないときに広げないこと');
});

// ---- 再現性 ----

test('同じ db と同じ asOf からは、必ず同じテキストが出る', () => {
  const a = weekly(baseDb(), opts());
  const b = weekly(baseDb(), opts());
  assert.strictEqual(a.text, b.text, '2回目のテキストが違う');
  assert.strictEqual(JSON.stringify(a.sections), JSON.stringify(b.sections), '節の中身が違う');
  assert.strictEqual(a.week, b.week);
});

test('週が違えば、対象週の見出しも変わる（週の切り替えができている）', () => {
  const a = weekly(baseDb(), opts());
  const b = weekly(baseDb(), opts({ asOf: '2026-08-11' }));
  assert.strictEqual(b.week, '2026-08-10');
  assert.notStrictEqual(a.text, b.text);
});

test('report.js は時計や乱数を使っていない（ソースを検査）', () => {
  const raw = fs.readFileSync(path.join(__dirname, '..', 'server', 'lib', 'report.js'), 'utf8');
  // コメントは外して見る（「使いません」と書いた行そのものを拾ってしまうため）
  const src = raw.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!/Math\.random/.test(src), 'Math.random を使わないこと');
  assert.ok(!/Date\.now/.test(src), 'Date.now を使わないこと');
  assert.ok(!/new Date\(\s*\)/.test(src), '引数なしの new Date() を使わないこと');
  assert.ok(!/require\(['"]\.\/store['"]\)/.test(src), 'store を require しないこと');
});

// ---- 結果 ----
const ng = results.filter((r) => r[0] === 'NG');
console.log('');
for (const [s, name] of results) console.log(`  ${s === 'ok' ? '  ok' : '  NG'}  ${name}`);
console.log('');
console.log(`  ${results.length - ng.length} / ${results.length} 通過`);
console.log('');
process.exit(ng.length ? 1 : 0);
