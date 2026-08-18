'use strict';
// node test/attendance.test.js
// 出席と発話の集計のテスト。守っているのは、機能ではなく約束のほうです。
//   1. 来ているのに話していない子が、3回続いたら必ず出る（この集計の存在理由）
//   2. 判定に足りないデータで flag を立てない（「データが無い」と「問題が無い」を混ぜない）
//   3. スコアの無い授業を「発話ゼロ」に寄せない
//   4. 戻り値に先生の識別子が入らない（先生の評価に転用させない）
//   5. 同じ db と asOf からは、いつも同じ結果が出る
// db はここで手で組み立てます。data/ の実データは読みません。
const assert = require('node:assert');

const attendance = require('../server/lib/attendance');

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push(['ok', name]);
  } catch (e) {
    results.push(['NG', `${name}\n     ${e.message}`]);
  }
}

const AS_OF = '2026-08-05';
const DATES = ['2026-07-01', '2026-07-08', '2026-07-15', '2026-07-22', '2026-07-29', '2026-08-05'];
const ROSTER = ['st_t_0', 'st_t_1', 'st_t_2', 'st_t_3', 'st_t_4', 'st_t_5', 'st_t_6', 'st_t_7'];

// 授業6本 × 名簿8人。数字はその日の発話回数、null は欠席。
//   st_t_1 … 前半は話していたが、直近3回は出席していて発話ゼロ → silent_streak
//   st_t_2 … 直近3回続けて欠席               → absent_streak
//   st_t_3 … 6回出て話したのは1回（最後の回） → low_voice（直近は話しているので silent_streak にはしない）
//   st_t_4 … 出席が2回だけ。どちらも発話ゼロ  → 判定に足りないので flag なし
const PLAN = {
  st_t_0: [5, 5, 5, 5, 5, 5],
  st_t_1: [3, 2, 4, 0, 0, 0],
  st_t_2: [4, 4, 4, null, null, null],
  st_t_3: [0, 0, 0, 0, 0, 2],
  st_t_4: [null, null, null, null, 0, 0],
  st_t_5: [1, 1, 1, 1, 1, 1],
  st_t_6: [3, 3, 3, 3, 3, 3],
  st_t_7: [2, 2, 2, 2, 2, 2],
};

// withAttendees=true なら lessons に attendees を持たせる。false ならスコアからの推測に任せる。
function makeDb(withAttendees) {
  const lessons = [];
  const scores = [];
  DATES.forEach((date, i) => {
    const present = ROSTER.filter((sid) => PLAN[sid][i] !== null);
    const turns = {};
    for (const sid of present) turns[sid] = PLAN[sid][i];
    const lesson = {
      id: `ls_t${i}`,
      classId: 'cl_t',
      facilitatorId: 'u_secret_teacher',
      arm: 'A',
      date,
      durationMin: 45,
      attendance: present.length,
    };
    if (withAttendees) lesson.attendees = present.slice();
    lessons.push(lesson);
    scores.push({
      id: `sc_t${i}`,
      lessonId: `ls_t${i}`,
      classId: 'cl_t',
      facilitatorId: 'u_secret_teacher',
      date,
      source: 'ai',
      signals: {
        turns_by_student: turns,
        silent_students: present.filter((sid) => PLAN[sid][i] === 0),
      },
    });
  });
  return {
    lessons,
    scores,
    // 名簿順は classes.studentIds で決まる。students の並びは逆に入れておく
    classes: [{ id: 'cl_t', name: 'T組（8人）', facilitatorId: 'u_secret_teacher', studentIds: ROSTER.slice() }],
    students: ROSTER.slice().reverse().map((id) => ({ id, name: `こ${id}`, classId: 'cl_t', status: 'active', joinedAt: '2026-06-01' })),
  };
}

const row = (r, sid) => r.students.find((x) => x.studentId === sid);
const kinds = (r, sid) => r.flags.filter((f) => f.studentId === sid).map((f) => f.kind);

// ---- いちばん大事なもの ----
test('出席していて3回続けて発話ゼロの子に silent_streak が立つ', () => {
  const r = attendance.summarize(makeDb(true), { asOf: AS_OF });
  assert.strictEqual(row(r, 'st_t_1').silentStreak, 3);
  assert.deepStrictEqual(kinds(r, 'st_t_1'), ['silent_streak']);
  const f = r.flags.find((x) => x.studentId === 'st_t_1');
  assert.strictEqual(f.since, '2026-07-22', 'いつからかが違う');
  assert.strictEqual(f.classId, 'cl_t');
  assert.ok(f.detail && f.detail.length > 0, '根拠の文がない');
});

test('silent_streak は直近だけを見る（前半に発話ゼロが続いていても、直近が話していれば立てない）', () => {
  const r = attendance.summarize(makeDb(true), { asOf: AS_OF });
  const st3 = row(r, 'st_t_3');
  assert.strictEqual(st3.silentStreak, 0, '最後の回に話しているのに続いている扱いになっている');
  assert.ok(!kinds(r, 'st_t_3').includes('silent_streak'));
});

test('silent_streak が flags の先頭に来る（欠席より先に目に入るように）', () => {
  const r = attendance.summarize(makeDb(true), { asOf: AS_OF });
  assert.deepStrictEqual(r.flags.map((f) => f.kind), ['silent_streak', 'absent_streak', 'low_voice']);
  assert.deepStrictEqual(r.flags.map((f) => f.studentId), ['st_t_1', 'st_t_2', 'st_t_3']);
});

// ---- 判定に足りないときは出さない ----
test('出席が2回しかない子には low_voice を立てない', () => {
  const r = attendance.summarize(makeDb(true), { asOf: AS_OF });
  const st4 = row(r, 'st_t_4');
  assert.strictEqual(st4.attended, 2);
  assert.strictEqual(st4.spokeRate, 0);
  assert.deepStrictEqual(st4.flags, [], '2回の出席で断じている');
  assert.strictEqual(st4.silentStreak, 2, '続いている回数そのものは残す');
});

test('low_voice は出席5回以上・発話が25%未満のときだけ立つ', () => {
  const r = attendance.summarize(makeDb(true), { asOf: AS_OF });
  const st3 = row(r, 'st_t_3');
  assert.strictEqual(st3.attended, 6);
  assert.strictEqual(st3.spokeSessions, 1);
  assert.strictEqual(st3.spokeRate, 0.167);
  assert.deepStrictEqual(kinds(r, 'st_t_3'), ['low_voice']);
  // 半分話している子には立たない
  assert.strictEqual(row(r, 'st_t_1').spokeRate, 0.5);
  assert.ok(!kinds(r, 'st_t_1').includes('low_voice'));
});

test('3回続けて欠席した子に absent_streak が立つ', () => {
  const r = attendance.summarize(makeDb(true), { asOf: AS_OF });
  const st2 = row(r, 'st_t_2');
  assert.strictEqual(st2.attended, 3);
  assert.strictEqual(st2.attendanceRate, 0.5);
  assert.strictEqual(st2.absentStreak, 3);
  assert.deepStrictEqual(kinds(r, 'st_t_2'), ['absent_streak']);
  assert.strictEqual(r.flags.find((f) => f.studentId === 'st_t_2').since, '2026-07-22');
});

test('よく来てよく話している子には何も立たない', () => {
  const r = attendance.summarize(makeDb(true), { asOf: AS_OF });
  for (const sid of ['st_t_0', 'st_t_5', 'st_t_6', 'st_t_7']) {
    assert.deepStrictEqual(row(r, sid).flags, [], `${sid} に flag が立っている`);
    assert.strictEqual(row(r, sid).attendanceRate, 1, sid);
    assert.strictEqual(row(r, sid).spokeRate, 1, sid);
  }
});

// ---- スコアが無い回 ----
// 授業4本。うしろ2本にはスコアが無い（誰が来たかは attendees で分かる）。
function makeUnscoredDb() {
  const dates = ['2026-07-01', '2026-07-08', '2026-07-15', '2026-07-22'];
  const roster = ['st_u_0', 'st_u_1'];
  const lessons = dates.map((date, i) => ({
    id: `ls_u${i}`, classId: 'cl_u', facilitatorId: 'u_secret_teacher', date, attendance: 2, attendees: roster.slice(),
  }));
  const scores = dates.slice(0, 2).map((date, i) => ({
    id: `sc_u${i}`,
    lessonId: `ls_u${i}`,
    classId: 'cl_u',
    date,
    signals: { turns_by_student: { st_u_0: 2, st_u_1: 0 }, silent_students: ['st_u_1'] },
  }));
  return {
    lessons,
    scores,
    classes: [{ id: 'cl_u', studentIds: roster.slice() }],
    students: roster.map((id) => ({ id, classId: 'cl_u', status: 'active' })),
  };
}

test('スコアの無い授業を「発話ゼロ」として数えない（分母から外す）', () => {
  const r = attendance.summarize(makeUnscoredDb(), { asOf: '2026-07-22' });
  const st = row(r, 'st_u_1');
  assert.strictEqual(st.sessions, 4, '出席は4回とも分かっている');
  assert.strictEqual(st.attended, 4);
  assert.strictEqual(st.spokeKnownSessions, 2, 'スコアの無い回まで分母に入っている');
  assert.strictEqual(st.spokeSessions, 0);
  assert.strictEqual(st.spokeRate, 0);
  assert.strictEqual(st.silentStreak, 2, 'スコアの無い回を発話ゼロとして数えている');
  assert.deepStrictEqual(st.flags, [], '不明な回で flag を立てている');
});

test('誰が来たかも分からない授業は、出席の分母にも入れない', () => {
  const db = makeUnscoredDb();
  for (const l of db.lessons) delete l.attendees; // スコアも attendees も無い回ができる
  const r = attendance.summarize(db, { asOf: '2026-07-22' });
  assert.strictEqual(row(r, 'st_u_1').sessions, 2, '分からない回を欠席として数えている');
  assert.strictEqual(row(r, 'st_u_1').absentStreak, 0);
  assert.ok(r.warnings.some((w) => w.includes('スコアが無く')), '分からなかったことが warnings に残っていない');
});

// ---- attendees あり／なし ----
test('attendees が無くてもスコアから名簿を推測して動く（推測だと warnings に残す）', () => {
  const withA = attendance.summarize(makeDb(true), { asOf: AS_OF });
  const guessed = attendance.summarize(makeDb(false), { asOf: AS_OF });
  assert.deepStrictEqual(guessed.students, withA.students, '推測した結果が記録と食い違う');
  assert.deepStrictEqual(guessed.flags, withA.flags);
  assert.strictEqual(withA.warnings.length, 0, 'attendees があるのに推測の断りが出ている');
  assert.ok(guessed.warnings.some((w) => w.includes('推測')), '推測したことが残っていない');
  assert.ok(guessed.warnings.some((w) => w.includes('attendees')), '何が無かったのかが書かれていない');
});

test('推測した人数が attendance の記録と合わないときは、授業を名指しで残す', () => {
  const db = makeDb(false);
  db.lessons[2].attendance = 5; // スコアからは7人読める
  const r = attendance.summarize(db, { asOf: AS_OF });
  const w = r.warnings.find((x) => x.includes('ls_t2'));
  assert.ok(w, '合わない授業が warnings に出ていない');
  assert.ok(w.includes('5') && w.includes('7'), '記録と推測の両方の人数が書かれていない');
});

// ---- 先生の評価に使わせない ----
test('戻り値に先生の識別子が入っていない', () => {
  for (const db of [makeDb(true), makeDb(false)]) {
    const s = JSON.stringify(attendance.summarize(db, { asOf: AS_OF }));
    assert.ok(!s.includes('u_secret_teacher'), '先生のIDが出ている');
    assert.ok(!s.includes('facilitator'), 'facilitator という語が出ている');
    assert.ok(!s.includes('arm'), 'アームが出ている（先生の比較に使えてしまう）');
  }
});

test('子どもの並びは名簿順（成績や発話量で並べ替えない）', () => {
  const r = attendance.summarize(makeDb(true), { asOf: AS_OF });
  assert.deepStrictEqual(r.students.map((x) => x.studentId), ROSTER);
});

// ---- 期間とクラス ----
test('asOf より後の授業も、期間より前の授業も入らない', () => {
  const db = makeDb(true);
  db.lessons.push({ id: 'ls_future', classId: 'cl_t', date: '2026-09-01', attendees: ROSTER.slice() });
  const r = attendance.summarize(db, { asOf: AS_OF, weeks: 2 }); // 2026-07-22 以降の3本だけ
  assert.strictEqual(r.classes[0].sessions, 3);
  assert.strictEqual(row(r, 'st_t_0').sessions, 3);
});

test('classId を指定すると、そのクラスだけを返す', () => {
  const db = makeDb(true);
  db.classes.push({ id: 'cl_other', studentIds: ['st_o_0'] });
  db.students.push({ id: 'st_o_0', classId: 'cl_other', status: 'active' });
  const all = attendance.summarize(db, { asOf: AS_OF });
  const one = attendance.summarize(db, { asOf: AS_OF, classId: 'cl_t' });
  assert.strictEqual(all.students.length, 9);
  assert.strictEqual(one.students.length, 8);
  assert.deepStrictEqual(one.classes.map((c) => c.classId), ['cl_t']);
});

test('クラスの集計は授業数・平均出席・silent の人数を出す', () => {
  const r = attendance.summarize(makeDb(true), { asOf: AS_OF });
  const c = r.classes[0];
  assert.strictEqual(c.classId, 'cl_t');
  assert.strictEqual(c.sessions, 6);
  assert.strictEqual(c.meanAttendance, 6.83);
  assert.strictEqual(c.silentChildren, 1);
  assert.strictEqual(c.flaggedChildren, 3);
});

test('入る前の回は欠席として数えない', () => {
  const db = makeDb(true);
  db.students = db.students.map((s) => (s.id === 'st_t_4' ? { ...s, joinedAt: '2026-07-29' } : s));
  const r = attendance.summarize(db, { asOf: AS_OF });
  const st4 = row(r, 'st_t_4');
  assert.strictEqual(st4.sessions, 2, '入会前の回まで数えている');
  assert.strictEqual(st4.attendanceRate, 1);
});

// ---- 再現性 ----
test('asOf が無ければ計算しない（今日の日付を勝手に使わない）', () => {
  let code = null;
  try { attendance.summarize(makeDb(true), {}); } catch (e) { code = e.code; }
  assert.strictEqual(code, 'ASOF_REQUIRED');
  try { attendance.summarize(makeDb(true), { asOf: '2026/08/05' }); } catch (e) { code = e.code; }
  assert.strictEqual(code, 'ASOF_REQUIRED');
});

test('同じ db と asOf からは、何度でも同じ結果が出る（決定的）', () => {
  const a = attendance.summarize(makeDb(true), { asOf: AS_OF });
  const b = attendance.summarize(makeDb(true), { asOf: AS_OF });
  assert.strictEqual(JSON.stringify(a), JSON.stringify(b));
  // 並び順が変わっただけの db でも同じ結果になること
  const shuffled = makeDb(true);
  shuffled.lessons.reverse();
  shuffled.scores.reverse();
  assert.strictEqual(JSON.stringify(attendance.summarize(shuffled, { asOf: AS_OF })), JSON.stringify(a));
});

test('集計は元の db を書き換えない', () => {
  const db = makeDb(true);
  const before = JSON.stringify(db);
  attendance.summarize(db, { asOf: AS_OF });
  assert.strictEqual(JSON.stringify(db), before);
});

test('空の db でも落ちない（0人・0件を返す）', () => {
  for (const db of [undefined, {}, { lessons: null, scores: 'こわれた値' }]) {
    const r = attendance.summarize(db, { asOf: AS_OF });
    assert.deepStrictEqual(r.students, []);
    assert.deepStrictEqual(r.classes, []);
    assert.deepStrictEqual(r.flags, []);
    assert.ok(r.note.length > 0);
  }
});

test('note は期間と、この集計が何でないかを書く', () => {
  const r = attendance.summarize(makeDb(true), { asOf: AS_OF });
  assert.ok(r.note.includes('2026-06-10') && r.note.includes(AS_OF), '期間が書かれていない');
  assert.ok(r.note.includes('名簿順'), '順位をつけていないことが書かれていない');
});

// ---- 結果 ----
const ng = results.filter((r) => r[0] === 'NG');
console.log('');
for (const [s, name] of results) console.log(`  ${s === 'ok' ? '  ok' : '  NG'}  ${name}`);
console.log('');
console.log(`  ${results.length - ng.length} / ${results.length} 通過`);
console.log('');
process.exit(ng.length ? 1 : 0);
