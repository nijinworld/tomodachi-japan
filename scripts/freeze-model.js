'use strict';
// モデル版を凍結する。
//   node scripts/freeze-model.js "v2" "待ち時間の正規化を 3秒→5秒 に変えた"
//
// モデル版 ＝ LLM ＋ プロンプト ＋ ルーブリック の組。1文字変えたら別の版です。
// 凍結したら、必ず再スコアしてください（版が混ざったスコアは比較できません）。
const store = require('../server/lib/store');
const { computeFingerprint } = require('../server/lib/scoring');
const { id } = require('../server/lib/util');

const label = process.argv[2];
const notes = process.argv[3] || '';

if (!label) {
  console.error('使い方: node scripts/freeze-model.js "<ラベル>" "<何を変えたか>"');
  process.exit(1);
}

const fp = computeFingerprint('local-heuristic');
const existing = store.all('modelVersions').find((m) => m.fingerprint === fp.fingerprint);

if (existing) {
  console.log(`同じ内容の版がすでにあります：${existing.label}（${existing.id}）`);
  console.log(`指紋 ${existing.fingerprint.slice(0, 16)}`);
  console.log('rubric もプロンプトも変わっていないので、新しい版は作りません。');
  process.exit(0);
}

const rec = store.insert('modelVersions', {
  id: id('mv'),
  label,
  notes,
  frozen: true,
  frozenAt: new Date().toISOString(),
  frozenBy: 'cli',
  ...fp,
});
store.flush();

console.log('');
console.log(`  凍結しました：${rec.label}（${rec.id}）`);
console.log(`  指紋      ${rec.fingerprint}`);
console.log(`  rubric    ${rec.rubric_sha256.slice(0, 16)}`);
console.log(`  prompt    ${rec.prompt_sha256.slice(0, 16)}`);
console.log(`  scorer    ${rec.scorer}`);
console.log('');
console.log('  次にやること：この版で全授業を採点し直す');
console.log('    サーバを起動して  curl -X POST localhost:5173/api/rescore -d "{}" -H "content-type: application/json"');
console.log('    または画面の「モデル版」→「凍結版で全授業を再スコアする」');
console.log('');
