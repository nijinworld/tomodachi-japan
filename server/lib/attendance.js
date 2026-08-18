'use strict';
// 出席と発話の集計。これは「子どもを見るための道具」です。
//
// スコア（scoring.js）は先生を見るための道具ですが、ここで出すのは子ども1人ひとりの
// 「来ているか」と「話しているか」だけです。いちばん見たいのは、
// **来ているのに一度も話していない子**。8人のオンラインクラスで3回続けて発話がない子は、
// たいてい次にいなくなります。辞めたあとに解約率で気づくのでは遅い。辞める前に見つけるための集計です。
//
// 守っていること（外すときは理由を先に書いてください）：
//   - 子どもをランキングしない。並びは名簿順だけ。「最も少ない」のような語も使わない
//   - 戻り値のどこにも先生（facilitator）の識別子を入れない。先生の評価に転用させないため
//   - 「データがない」と「問題がない」を混ぜない。判定に足りなければ flag を出さない
//   - 推測したところは、推測だと分かる形で warnings に残す
//   - 基準日は opts.asOf。Date.now() も Math.random() も引数なしの new Date() も使わない（再現性が最優先）
const { mean, round } = require('./util');

// flag は3つだけ。この配列の順が、そのまま出す順（silent_streak が最優先）。
const FLAG_KINDS = ['silent_streak', 'absent_streak', 'low_voice'];
const STREAK_MIN = 3;             // 3回続いたら見に行く。2回はまだ「たまたま」がある
const LOW_VOICE_RATE = 0.25;      // 期間全体で、話した回が4回に1回に満たない
const LOW_VOICE_MIN_SESSIONS = 5; // これ未満では判定しない（少ない回数の割合で子どもを断じないため）

function arr(x) {
  return Array.isArray(x) ? x : [];
}

// 日付は文字列（YYYY-MM-DD）のまま比べる。ローカル時刻を混ぜないため UTC で足し引きする
function shiftDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// 末尾から数えて、条件が続いている回数
function trailingRun(seq, ok) {
  let n = 0;
  for (let i = seq.length - 1; i >= 0; i -= 1) {
    if (!ok(seq[i])) break;
    n += 1;
  }
  return n;
}

// db: { lessons: [], scores: [], students: [], classes: [] }
// opts: { asOf: 'YYYY-MM-DD'（必須）, weeks: 8, classId?: string }
// 戻り値の students[].flags は kind の配列。中身（since / detail）は flags に入っています。
function summarize(db, opts = {}) {
  const asOf = opts.asOf;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(asOf == null ? '' : asOf))) {
    // 今日の日付を勝手に使わない。同じ db から違う結果が出るようになるため
    const e = new Error('opts.asOf（YYYY-MM-DD）が必要です。基準日を省くと、同じデータから違う結果が出ます。');
    e.code = 'ASOF_REQUIRED';
    throw e;
  }
  const weeks = typeof opts.weeks === 'number' && opts.weeks > 0 ? opts.weeks : 8;
  const from = shiftDays(asOf, -weeks * 7); // 両端を含む
  const source = db || {};

  const warnings = [];      // 全体について
  const lessonWarnings = []; // 授業ごと（日付順に出す）

  // ---- 期間内の授業 ----
  const lessons = arr(source.lessons)
    .filter((l) => l && typeof l.date === 'string' && l.date >= from && l.date <= asOf)
    .filter((l) => !opts.classId || l.classId === opts.classId)
    .slice()
    .sort((a, b) => (a.date === b.date ? String(a.id).localeCompare(String(b.id)) : a.date.localeCompare(b.date)));

  const scoresByLesson = {};
  for (const s of arr(source.scores)) {
    if (!s || !s.lessonId) continue;
    if (!scoresByLesson[s.lessonId]) scoresByLesson[s.lessonId] = [];
    scoresByLesson[s.lessonId].push(s);
  }

  // ---- 名簿。並びはここで一度だけ決めて、以降は動かさない ----
  // 名簿順を崩すと、それはもう順位表です。
  const classOrder = [];
  const rosterOf = {};
  const classOfStudent = {};
  const addClass = (cid) => {
    if (!cid || rosterOf[cid]) return;
    rosterOf[cid] = [];
    classOrder.push(cid);
  };
  const addStudent = (cid, sid) => {
    if (!cid || !sid) return;
    addClass(cid);
    if (!rosterOf[cid].includes(sid)) rosterOf[cid].push(sid);
    if (!classOfStudent[sid]) classOfStudent[sid] = cid;
  };

  for (const c of arr(source.classes)) {
    if (!c || !c.id) continue;
    if (opts.classId && c.id !== opts.classId) continue;
    addClass(c.id);
    for (const sid of arr(c.studentIds)) addStudent(c.id, sid);
  }
  for (const s of arr(source.students)) {
    if (!s || !s.id || !s.classId) continue;
    if (opts.classId && s.classId !== opts.classId) continue;
    addStudent(s.classId, s.id);
  }
  const studentMeta = {};
  for (const s of arr(source.students)) if (s && s.id) studentMeta[s.id] = s;

  // ---- 授業ごとに「その日いた子」と「その日の発話」を決める ----
  let inferredCount = 0;
  let unknownCount = 0;
  const sessions = [];
  for (const l of lessons) {
    const scored = scoresByLesson[l.id] || [];
    if (scored.length > 1) {
      // 再スコアで採点が複数ある授業。db の並び順で最初の1件に固定する（順が揺れると結果も揺れるため）
      const shapes = new Set(scored.map((s) => JSON.stringify((s.signals || {}).turns_by_student || null)));
      if (shapes.size > 1) {
        lessonWarnings.push(`${l.id}（${l.date}・${l.classId}）には発話の記録が食い違う採点が${scored.length}件あります。db の並び順で最初の1件を使いました。`);
      }
    }
    const signals = (scored[0] || {}).signals || {};
    const turns = signals.turns_by_student && typeof signals.turns_by_student === 'object' ? signals.turns_by_student : null;
    const silent = new Set(arr(signals.silent_students));

    let present = null;
    if (Array.isArray(l.attendees)) {
      // 記録がある。これがいちばん強い
      present = new Set(l.attendees.filter(Boolean));
      if (turns) {
        const extra = Object.keys(turns).filter((sid) => turns[sid] > 0 && !present.has(sid));
        if (extra.length) {
          lessonWarnings.push(`${l.id}（${l.date}・${l.classId}）：attendees に無い子の発話が記録されています（${extra.length}人）。attendees をそのまま使いました。`);
        }
      }
    } else if (turns || silent.size) {
      // 記録が無いので、スコアに出てくる子を「その日いた子」とみなす。これは推測です
      present = new Set([...Object.keys(turns || {}), ...silent]);
      inferredCount += 1;
      if (typeof l.attendance === 'number' && l.attendance !== present.size) {
        lessonWarnings.push(`${l.id}（${l.date}・${l.classId}）：出席人数は${l.attendance}人と記録されていますが、スコアからは${present.size}人読み取れました。推測が合っていません。`);
      }
    } else {
      // 誰がいたか分からない。分母にも分子にも入れない（欠席0回として数えない）
      unknownCount += 1;
    }

    if (present) {
      for (const sid of present) if (!classOfStudent[sid] && l.classId) addStudent(l.classId, sid);
    }
    sessions.push({
      lessonId: l.id,
      classId: l.classId || null,
      date: l.date,
      known: !!present,
      present: present || new Set(),
      turns,
      silent,
    });
  }

  // 出席していたその日、発話が数えられたか。数えられていなければ null（0にしない）
  const spokeAt = (s, sid) => {
    if (s.turns && typeof s.turns[sid] === 'number') return s.turns[sid] > 0;
    if (s.silent.has(sid)) return false;
    return null;
  };

  // ---- 子どもごと（名簿順） ----
  const studentsOut = [];
  const flags = [];
  const silentByClass = {};
  const flaggedByClass = {};
  for (const cid of classOrder) {
    silentByClass[cid] = 0;
    flaggedByClass[cid] = 0;
    for (const sid of rosterOf[cid]) {
      const joinedAt = (studentMeta[sid] || {}).joinedAt;
      // 入る前の回は「欠席」ではない
      const mine = sessions.filter((s) => s.classId === cid && s.known && (!joinedAt || s.date >= joinedAt));

      const presenceSeq = []; // 誰がいたか分かった回
      const voiceSeq = [];    // そのうち、出席していて発話も数えられた回
      let attended = 0;
      let spoke = 0;
      for (const s of mine) {
        const here = s.present.has(sid);
        presenceSeq.push({ date: s.date, present: here });
        if (!here) continue;
        attended += 1;
        const said = spokeAt(s, sid);
        if (said === null) continue; // スコアが無い回は「不明」。分母から外す
        voiceSeq.push({ date: s.date, spoke: said });
        if (said) spoke += 1;
      }

      const absentStreak = trailingRun(presenceSeq, (x) => !x.present);
      const silentStreak = trailingRun(voiceSeq, (x) => !x.spoke);
      const spokeRate = voiceSeq.length ? round(spoke / voiceSeq.length, 3) : null;

      const kinds = [];
      const add = (kind, since, detail) => {
        kinds.push(kind);
        flags.push({ studentId: sid, classId: cid, kind, since, detail });
      };
      if (silentStreak >= STREAK_MIN) {
        const since = voiceSeq[voiceSeq.length - silentStreak].date;
        add('silent_streak', since, `${since} から、出席した${silentStreak}回続けて発話が数えられていません。来ています。話していません。`);
      }
      if (absentStreak >= STREAK_MIN) {
        const since = presenceSeq[presenceSeq.length - absentStreak].date;
        add('absent_streak', since, `${since} から、${absentStreak}回続けて欠席しています。`);
      }
      // 出席が少ないうちは判定しない。発話が数えられた回も同じだけ要る（不明を「話していない」に寄せないため）
      if (attended >= LOW_VOICE_MIN_SESSIONS && voiceSeq.length >= LOW_VOICE_MIN_SESSIONS && spokeRate < LOW_VOICE_RATE) {
        add('low_voice', voiceSeq[0].date, `発話が数えられた${voiceSeq.length}回のうち、話したのは${spoke}回です（出席は${attended}回）。`);
      }
      if (kinds.includes('silent_streak')) silentByClass[cid] += 1;
      if (kinds.length) flaggedByClass[cid] += 1;

      studentsOut.push({
        studentId: sid,
        classId: cid,
        sessions: presenceSeq.length,
        attended,
        attendanceRate: presenceSeq.length ? round(attended / presenceSeq.length, 3) : null,
        absentStreak,
        spokeSessions: spoke,
        spokeKnownSessions: voiceSeq.length, // spokeRate の分母。割合だけ見せない
        spokeRate,
        silentStreak,
        flags: FLAG_KINDS.filter((k) => kinds.includes(k)),
      });
    }
  }

  // ---- クラスごと ----
  const classesOut = classOrder.map((cid) => {
    const known = sessions.filter((s) => s.classId === cid && s.known);
    return {
      classId: cid,
      sessions: known.length,
      meanAttendance: known.length ? round(mean(known.map((s) => s.present.size)), 2) : null,
      silentChildren: silentByClass[cid] || 0,
      flaggedChildren: flaggedByClass[cid] || 0,
    };
  });

  if (unknownCount) {
    warnings.push(`${unknownCount}件の授業にスコアが無く、誰が出ていたか分かりません。この授業は出席率・発話率のどちらの分母にも入れていません（欠席0回・発話0回として数えていません）。`);
  }
  if (inferredCount) {
    warnings.push(`${inferredCount}件の授業に attendees（その日いた子のID）がありません。スコアの turns_by_student と silent_students に出てくる子を「その日いた子」とみなしました。これは記録ではなく推測です。`);
  }

  return {
    students: studentsOut,
    classes: classesOut,
    // silent_streak が先。欠席より、来ているのに話していないほうが先に目に入るように
    flags: FLAG_KINDS.flatMap((kind) => flags.filter((f) => f.kind === kind)),
    note: `${from} 〜 ${asOf}（${weeks}週）の集計です。並びは名簿順で、子どもの間に順位はつけていません。`
      + 'flag は「見に行く先」であって、子どもの評価でも先生の評価でもありません（先生の識別子はこの結果に入れていません）。'
      + '判定に足るデータが無い子には flag を出していません。出ていないことは、問題が無いことではありません。',
    warnings: warnings.concat(lessonWarnings),
  };
}

module.exports = { summarize };
