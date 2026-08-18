'use strict';
// 合言葉を設定する。
//   node scripts/set-passcode.js <ユーザーIDまたは名前> <合言葉>
//   node scripts/set-passcode.js --list
//
// 合言葉は scrypt でハッシュして保存します。平文はどこにも残りません。
// 忘れたら、このコマンドで入れ直してください（復元はできません）。
const store = require('../server/lib/store');
const auth = require('../server/lib/auth');

const [target, passcode] = process.argv.slice(2);

if (target === '--list' || !target) {
  const users = store.all('users');
  if (!users.length) {
    console.log('\n  ユーザーがいません。node scripts/seed.js を実行するか、画面から登録してください。\n');
    process.exit(0);
  }
  console.log('');
  console.log('  ID                    ロール         合言葉  名前');
  console.log('  --------------------  -------------  ------  ----------------');
  for (const u of users) {
    console.log(`  ${u.id.padEnd(20)}  ${String(u.role).padEnd(13)}  ${u.hash ? '設定済' : '未設定'}  ${u.name}`);
  }
  console.log('');
  console.log('  使い方: node scripts/set-passcode.js <ID または 名前> <合言葉>');
  console.log('');
  process.exit(0);
}

if (!passcode) {
  console.error('合言葉を指定してください: node scripts/set-passcode.js <ID> <合言葉>');
  process.exit(1);
}
if (passcode.length < 8) {
  console.error('合言葉は8文字以上にしてください。');
  process.exit(1);
}

const user = store.all('users').find((u) => u.id === target) || store.all('users').find((u) => u.name === target);
if (!user) {
  console.error(`そのユーザーが見つかりません: ${target}`);
  console.error('一覧は node scripts/set-passcode.js --list');
  process.exit(1);
}

store.update('users', user.id, auth.hashPasscode(passcode));
store.flush();

console.log('');
console.log(`  ${user.name}（${user.id}／${user.role}）の合言葉を設定しました。`);
console.log('  本人には口頭で伝え、初回ログイン後に本人に変更してもらってください。');
console.log('');
