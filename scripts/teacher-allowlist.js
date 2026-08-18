'use strict';
// Ranius 本体（ranius-platform）の教師許可リスト用に、メールアドレスのハッシュを作る。
//
//   node scripts/teacher-allowlist.js a@example.com b@example.com
//   node scripts/teacher-allowlist.js --file teachers.txt        1行1メール
//   node scripts/teacher-allowlist.js --from-users               このシステムの先生から作る
//
// 出てきた値を、Cloud Run の環境変数 PILOT_TEACHER_EMAIL_SHA256S に
// カンマ区切りで入れてください。**コードの変更は要りません。**
//
// なぜハッシュかというと、向こうがメールアドレスそのものを持たない設計だからです
// （services/platform-api/src/auth.js:104）。この方針はそのまま守ります。
// 正規化のしかたも向こうに合わせています：trim して小文字にしてから sha256。
const crypto = require('node:crypto');
const fs = require('node:fs');
const store = require('../server/lib/store');

const args = process.argv.slice(2);
const val = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : null;
};

// 向こうの emailSha256 と同じ計算。ここがずれると、登録できないのに理由が分かりません。
const emailSha256 = (email) => crypto.createHash('sha256')
  .update(String(email || '').trim().toLowerCase()).digest('hex');

let emails = [];
if (args.includes('--from-users')) {
  emails = store.all('users')
    .filter((u) => ['facilitator', 'mentor'].includes(u.role) && u.email)
    .map((u) => u.email);
  if (!emails.length) {
    console.error('\n  このシステムの先生にメールアドレスが入っていません。');
    console.error('  「人とクラス」で登録するか、引数でメールを渡してください。\n');
    process.exit(1);
  }
} else if (val('--file')) {
  emails = fs.readFileSync(val('--file'), 'utf8').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
} else {
  emails = args.filter((a) => a.includes('@'));
}

if (!emails.length) {
  console.log('');
  console.log('  使い方:');
  console.log('    node scripts/teacher-allowlist.js sensei@example.com another@example.com');
  console.log('    node scripts/teacher-allowlist.js --file teachers.txt');
  console.log('    node scripts/teacher-allowlist.js --from-users');
  console.log('');
  process.exit(0);
}

// 重複と表記ゆれを潰す（同じ人を2回入れても意味がないため）
const seen = new Map();
for (const e of emails) {
  const norm = String(e).trim().toLowerCase();
  if (!norm.includes('@')) continue;
  seen.set(norm, emailSha256(norm));
}

console.log('');
console.log(`  ${seen.size} 件のハッシュを作りました（重複と大文字小文字は潰しています）`);
console.log('');
for (const [email, hash] of seen) {
  // メールアドレスそのものは、この画面にしか出しません。控えを取らないでください。
  const masked = email.replace(/^(.).*(@.*)$/, '$1***$2');
  console.log(`  ${masked.padEnd(28)} ${hash}`);
}
console.log('');
console.log('  ── Cloud Run の環境変数に入れる値 ─────────────────');
console.log('');
console.log(`  PILOT_TEACHER_EMAIL_SHA256S=${[...seen.values()].join(',')}`);
console.log('');
console.log('  ── 入れ方 ────────────────────────────────');
console.log('');
console.log('  1. いまの値を消さないこと。**既存のハッシュに追記**してください');
console.log('     （消すと、いまの先生がログインできなくなります）');
console.log('  2. nijin-platform-api の環境変数を更新して、リビジョンを1つ進める');
console.log('  3. 先生に、そのGoogleアカウントで /teacher からログインしてもらう');
console.log('     初回ログイン時に自動で教師登録されます（POST /v1/onboarding/teacher）');
console.log('');
console.log('  ⚠️ Googleアカウントで、メールが確認済みであることが条件です。');
console.log('     他の方法（メール+パスワード）では登録が通りません。');
console.log('');
