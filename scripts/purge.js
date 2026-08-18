'use strict';
// 書き起こしを消す。
//
//   node scripts/purge.js                 保存期間を過ぎた授業の発話を消す
//   node scripts/purge.js --dry-run       何を消すかだけ見る
//   node scripts/purge.js --days 90       期間を指定して消す（設定は変えない）
//   node scripts/purge.js --student st_x  ある子どものことばだけを消す（同意の撤回に使う）
//
// 消すのは **子どものことば** だけです。
//   消す   … 発話（utterances）、スコアやフィードバックに引用された本文
//   残す   … スコア、信号（数値）、時刻、イベントの種類
// 数値を残すのは、あとから「この授業は何点だったか」を説明できるようにするためです。
// ことばを消すのは、それが子どものものだからです。
const store = require('../server/lib/store');
const { isoDate } = require('../server/lib/util');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : null;
};

const dryRun = has('--dry-run');
const studentId = val('--student');
const days = Number(val('--days') || store.setting('transcript_retention_days', 180));

// 引用された本文を伏せる（イベントの種類と時刻は残す）
function redactEvents(events, keep) {
  let n = 0;
  for (const e of events || []) {
    if (keep && keep(e) === false) continue;
    if (e.text) { e.text = ''; e.redacted = true; n += 1; }
  }
  return n;
}

function purgeLesson(lesson, keepSpeaker) {
  const utts = store.all('utterances').filter((u) => u.lessonId === lesson.id
    && (!keepSpeaker || u.speaker === keepSpeaker));
  if (!utts.length && keepSpeaker) return { utterances: 0, quotes: 0 };
  let quotes = 0;
  for (const sc of store.all('scores').filter((x) => x.lessonId === lesson.id)) {
    quotes += redactEvents(sc.events, keepSpeaker ? (e) => e.speaker === keepSpeaker : null);
    for (const d of Object.values(sc.dims || {})) {
      quotes += redactEvents(d.evidence, keepSpeaker ? (e) => e.speaker === keepSpeaker : null);
    }
  }
  for (const fb of store.all('feedbacks').filter((x) => x.lessonId === lesson.id)) {
    quotes += redactEvents(fb.evidence, keepSpeaker ? (e) => e.speaker === keepSpeaker : null);
  }
  if (!dryRun) {
    store.remove('utterances', (u) => u.lessonId === lesson.id
      && (!keepSpeaker || u.speaker === keepSpeaker));
    store.update('lessons', lesson.id, {
      transcript_purged: keepSpeaker ? lesson.transcript_purged : true,
      purgedAt: new Date().toISOString(),
    });
    // scores / feedbacks は参照を書き換えたので保存し直す
    store.replaceAll('scores', store.all('scores'));
    store.replaceAll('feedbacks', store.all('feedbacks'));
  }
  return { utterances: utts.length, quotes };
}

let lessons;
let heading;

if (studentId) {
  const st = store.get('students', studentId);
  if (!st) {
    console.error(`その子どもがいません: ${studentId}`);
    process.exit(1);
  }
  const ids = new Set(store.all('utterances').filter((u) => u.speaker === studentId).map((u) => u.lessonId));
  lessons = store.all('lessons').filter((l) => ids.has(l.id));
  heading = `${st.name}（${studentId}）のことばを、${lessons.length}本の授業から消します`;
} else {
  const cutoff = isoDate(Date.now() - days * 86400000);
  const withUtt = new Set(store.all('utterances').map((u) => u.lessonId));
  lessons = store.all('lessons').filter((l) => l.date < cutoff && withUtt.has(l.id));
  heading = `${cutoff} より前の授業 ${lessons.length}本（保存期間 ${days}日）`;
}

let utt = 0;
let quotes = 0;
for (const l of lessons) {
  const r = purgeLesson(l, studentId || null);
  utt += r.utterances;
  quotes += r.quotes;
}

if (!dryRun) {
  store.setSetting('last_purge_at', new Date().toISOString());
  store.insert('auditLog', {
    id: `au_purge_${Date.now().toString(36)}`,
    at: new Date().toISOString(),
    actor: 'cli',
    action: studentId ? 'purge.student' : 'purge.retention',
    target: studentId || `${days}日`,
    detail: `授業${lessons.length}本 / 発話${utt} / 引用${quotes}`,
  });
  store.flush();
}

console.log('');
console.log(`  ${heading}`);
console.log(`  発話 ${utt}件、引用された本文 ${quotes}か所を${dryRun ? '消します（--dry-run なので消していません）' : '消しました'}。`);
console.log('  スコアと信号（数値）は残っています。');
if (dryRun) console.log('\n  実行するには --dry-run を外してください。');
console.log('');
