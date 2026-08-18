'use strict';
// data/ を丸ごとコピーして残す。
//   node scripts/backup.js               → backups/YYYY-MM-DD_HHMM/
//   node scripts/backup.js <保存先>       → 指定した場所へ
//   node scripts/backup.js --list        → いままでの控え
//   node scripts/backup.js --keep 30     → 古い控えを30世代だけ残して消す
//
// 復元は、コピーを data/ に戻すだけです（サーバは止めてから）。
// このシステムのデータは data/*.json がすべてです。他の場所には何も持っていません。
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const BACKUPS = path.join(ROOT, 'backups');

const args = process.argv.slice(2);
const val = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : null;
};
// 保存先は、`--` で始まらない最初の引数だけを見る（--keep 30 を保存先と誤解しないため）
const keepVal = val('--keep');
const arg = args.find((a2, i) => !a2.startsWith('--') && args[i - 1] !== '--keep') || null;

if (args.includes('--list')) {
  if (!fs.existsSync(BACKUPS)) {
    console.log('\n  控えはまだありません。\n');
    process.exit(0);
  }
  const rows = fs.readdirSync(BACKUPS).sort().reverse();
  console.log('');
  for (const r of rows) {
    const dir = path.join(BACKUPS, r);
    const files = fs.readdirSync(dir);
    const bytes = files.reduce((a, f) => a + fs.statSync(path.join(dir, f)).size, 0);
    console.log(`  ${r}  ${files.length}ファイル  ${(bytes / 1024 / 1024).toFixed(1)}MB`);
  }
  console.log('');
  process.exit(0);
}

if (!fs.existsSync(DATA)) {
  console.error('data/ がありません。');
  process.exit(1);
}

const now = new Date();
const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  + `_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
const dest = arg ? path.resolve(arg) : path.join(BACKUPS, stamp);

fs.mkdirSync(dest, { recursive: true });
let n = 0;
let bytes = 0;
for (const f of fs.readdirSync(DATA)) {
  if (!f.endsWith('.json')) continue;
  const src = path.join(DATA, f);
  fs.copyFileSync(src, path.join(dest, f));
  n += 1;
  bytes += fs.statSync(src).size;
}

// 古い控えを間引く。ディスクが埋まって控えが止まるのがいちばん困る。
let removed = 0;
const keep = Number(keepVal || 0);
if (keep > 0 && fs.existsSync(BACKUPS)) {
  const dirs = fs.readdirSync(BACKUPS).sort().reverse();
  for (const d of dirs.slice(keep)) {
    fs.rmSync(path.join(BACKUPS, d), { recursive: true, force: true });
    removed += 1;
  }
}

console.log('');
console.log(`  ${n}ファイル（${(bytes / 1024 / 1024).toFixed(1)}MB）を控えました。`);
console.log(`  ${dest}`);
if (removed) console.log(`  古い控えを ${removed} 世代消しました（--keep ${keep}）。`);
console.log('');
console.log('  復元するときは、サーバを止めてから、このフォルダの中身を data/ に戻してください。');
console.log('');
