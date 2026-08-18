'use strict';
// 盲検の二重コーディング用に、授業を選ぶ。
//
//   node scripts/sample-for-irr.js            16本を選んで一覧を出す
//   node scripts/sample-for-irr.js --n 24     本数を変える
//   node scripts/sample-for-irr.js --assign   選んだ授業を、評定者2名に割り当てて記録する
//
// なぜ「適当に16本」ではいけないか：
//   同じ先生、同じ時期、同じアームに偏ると、一致率が実態より高く出ます。
//   「似た授業ばかり見せられたから揃った」だけかもしれないからです。
//   だから、アーム・先生・時期に散らして選びます（層化抽出）。
//
// 選び方は決定的です。同じデータからは同じ16本が出ます（乱数を使いません）。
// 「気に入らない結果が出たから選び直す」ができないようにするためです。
const store = require('./../server/lib/store');
const { sha256, weekKey } = require('../server/lib/util');

const args = process.argv.slice(2);
const val = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : null;
};
const N = Number(val('--n') || 16);
const doAssign = args.includes('--assign');

const lessons = store.all('lessons');
const scores = store.all('scores').filter((s) => s.source === 'ai');
const hasTranscript = new Set(store.all('utterances').map((u) => u.lessonId));

// 採点できる授業だけが対象（書き起こしが無いと評定者も読めない）
const pool = lessons.filter((l) => hasTranscript.has(l.id));
if (!pool.length) {
  console.error('書き起こしのある授業がありません。');
  process.exit(1);
}

// 層 = アーム × 先生 × 月。この3つに散らす。
const strata = {};
for (const l of pool) {
  const month = String(l.date).slice(0, 7);
  const key = `${l.arm || '-'}|${l.facilitatorId}|${month}`;
  (strata[key] = strata[key] || []).push(l);
}

// 各層の中では、授業IDのハッシュ順に並べる（決定的で、日付にも名前にも寄らない）
for (const k of Object.keys(strata)) {
  strata[k].sort((a, b) => sha256(a.id).localeCompare(sha256(b.id)));
}

// 層を順に1本ずつ取っていく（ラウンドロビン）。偏りを最小にする取り方。
const keys = Object.keys(strata).sort();
const picked = [];
let round = 0;
while (picked.length < N) {
  let took = false;
  for (const k of keys) {
    if (picked.length >= N) break;
    if (strata[k][round]) { picked.push(strata[k][round]); took = true; }
  }
  if (!took) break;
  round += 1;
}

const raters = store.all('users').filter((u) => u.role === 'rater' && u.status !== 'disabled');
const already = {};
for (const r of store.all('ratings')) {
  (already[r.lessonId] = already[r.lessonId] || new Set()).add(r.raterId);
}

console.log('');
console.log(`  盲検の二重コーディング用に ${picked.length} 本を選びました（対象 ${pool.length} 本／層 ${keys.length}）`);
console.log('');
console.log('  授業ID                 日付        アーム  先生            採点済み');
console.log('  ---------------------  ----------  ------  --------------  --------');
for (const l of picked) {
  const f = store.get('users', l.facilitatorId);
  const done = already[l.id] ? already[l.id].size : 0;
  console.log(`  ${l.id.padEnd(21)}  ${l.date}  ${String(l.arm || '-').padEnd(6)}  ${String(f ? f.name : '').padEnd(14)}  ${done}名`);
}

// 散らばりの確認。ここが偏っていたら、一致率を信じてはいけない。
const byArm = {};
const byFac = {};
const byMonth = {};
for (const l of picked) {
  byArm[l.arm || '-'] = (byArm[l.arm || '-'] || 0) + 1;
  byFac[l.facilitatorId] = (byFac[l.facilitatorId] || 0) + 1;
  byMonth[String(l.date).slice(0, 7)] = (byMonth[String(l.date).slice(0, 7)] || 0) + 1;
}
console.log('');
console.log('  散らばり');
console.log(`    アーム   ${Object.entries(byArm).map(([k, v]) => `${k}:${v}`).join('  ')}`);
console.log(`    先生     ${Object.keys(byFac).length}名（最多 ${Math.max(...Object.values(byFac))}本）`);
console.log(`    月       ${Object.entries(byMonth).map(([k, v]) => `${k}:${v}`).join('  ')}`);

if (!doAssign) {
  console.log('');
  console.log('  この16本を評定者に割り当てるには --assign を付けてください。');
  console.log('  評定者は rater ロールのアカウントで、画面の「盲検の採点」からのみ入力します。');
  console.log('');
  process.exit(0);
}

if (raters.length < 2) {
  console.error('\n  評定者が2名いません。「人とクラス」で rater ロールのアカウントを作ってください。\n');
  process.exit(1);
}

store.setSetting('irr_sample', {
  createdAt: new Date().toISOString(),
  n: picked.length,
  lessonIds: picked.map((l) => l.id),
  raterIds: raters.slice(0, 2).map((r) => r.id),
  note: '層化抽出（アーム×先生×月）。決定的に選んでいるので、選び直しても同じになる。',
});
store.flush();

console.log('');
console.log(`  ${raters[0].name} と ${raters[1].name} に割り当てました。`);
console.log('  2人には、それぞれのアカウントでログインして「盲検の採点」から入れてもらってください。');
console.log('  ⚠️ 「この先生は〜」と口で伝えないでください。伝わった時点で、その授業のペアは使えません。');
console.log('');
