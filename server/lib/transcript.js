'use strict';
// 書き起こし → 信号（signals）。ここで数えたものだけがスコアの根拠になる。
// 出力は必ず「値」と「時刻つきイベント」の2つ。値だけを返してはいけない。
// 所見を人格ではなく行動で書くために、根拠は常に時刻を持つ。
const { moraCount, overlap, PAT } = require('./ja');
const { gini, median, round, ts } = require('./util');

// utterances: [{ t: 秒, speaker: 'T' | studentId, text }]
function analyze(utterances, opts = {}) {
  const windowMinutes = opts.windowMinutes || 15;
  const windowSec = windowMinutes * 60;
  const us = utterances
    .filter((u) => u.t < windowSec)
    .slice()
    .sort((a, b) => a.t - b.t);

  const ev = [];
  const push = (type, u, note) => ev.push({ type, t: u.t, at: ts(u.t), speaker: u.speaker, text: u.text, note });

  const teacher = us.filter((u) => u.speaker === 'T');
  const studentUts = us.filter((u) => u.speaker !== 'T');
  const durationSec = us.length ? Math.max(...us.map((u) => u.t)) : 0;
  const per10 = (n) => (durationSec > 0 ? (n / durationSec) * 600 : 0);

  const teacherMora = teacher.reduce((a, u) => a + moraCount(u.text), 0);
  const studentMora = studentUts.reduce((a, u) => a + moraCount(u.text), 0);
  const totalMora = teacherMora + studentMora;

  // --- 発話機会の配分 ---
  const roster = opts.roster && opts.roster.length
    ? opts.roster
    : [...new Set(studentUts.map((u) => u.speaker))];
  const turns = {};
  for (const s of roster) turns[s] = 0;
  for (const u of studentUts) turns[u.speaker] = (turns[u.speaker] || 0) + 1;
  const turnCounts = roster.map((s) => turns[s] || 0);
  const silent = roster.filter((s) => !turns[s]);
  for (const s of silent) {
    ev.push({ type: 'silent_student', t: 0, at: ts(0), speaker: s, text: '', note: '窓内に発話なし' });
  }

  // 指名の連続（同じ子を続けて指名していないか）
  const nominations = [];
  for (let i = 0; i < us.length; i += 1) {
    const u = us[i];
    if (u.speaker !== 'T') continue;
    if (!PAT.nomination.test(u.text) && !PAT.question.test(u.text)) continue;
    const next = us.slice(i + 1, i + 3).find((x) => x.speaker !== 'T');
    if (next) nominations.push({ t: u.t, student: next.speaker });
  }
  let maxRun = 0;
  let run = 0;
  let prevStudent = null;
  let runStart = null;
  for (const n of nominations) {
    if (n.student === prevStudent) {
      run += 1;
    } else {
      run = 1;
      prevStudent = n.student;
      runStart = n.t;
    }
    if (run > maxRun) maxRun = run;
    if (run === 3) {
      ev.push({ type: 'nomination_run', t: runStart, at: ts(runStart), speaker: n.student, text: '', note: '同じ子への指名が3回続いた' });
    }
  }

  // --- 訂正フィードバックと取り込み ---
  let recasts = 0;
  let explicit = 0;
  let uptake = 0;
  for (let i = 1; i < us.length; i += 1) {
    const u = us[i];
    if (u.speaker !== 'T') continue;
    const prevS = us[i - 1];
    if (prevS.speaker === 'T') continue;
    const isExplicit = PAT.explicitCorrection.test(u.text);
    const ov = overlap(u.text, prevS.text);
    // 「わかった？」のような短い相づちが、たまたま文字が重なって
    // リキャストに見えてしまうのを防ぐ。言い直しは、元の発話と同じくらいの長さを持つ。
    const longEnough = moraCount(u.text) >= 0.6 * moraCount(prevS.text);
    const isRecast = !isExplicit && ov >= 0.4 && u.text !== prevS.text
      && longEnough && !PAT.emptyCheck.test(u.text.trim());
    if (!isExplicit && !isRecast) continue;
    if (isExplicit) {
      explicit += 1;
      push('explicit_correction', u, '直前の子どもの発話に対する明示的訂正');
    } else {
      recasts += 1;
      push('recast', u, '直前の子どもの発話の言い直し（重なり ' + round(ov, 2) + '）');
    }
    // 取り込み：訂正の直後2発話以内に、同じ子が教師の形に寄せて言い直したか
    const after = us.slice(i + 1, i + 3).filter((x) => x.speaker === prevS.speaker);
    const took = after.find((x) => overlap(x.text, u.text) >= 0.4 && overlap(x.text, prevS.text) < 0.95);
    if (took) {
      uptake += 1;
      push('uptake', took, '訂正のあとに言い直した');
    }
  }
  const corrections = recasts + explicit;

  // --- 意味交渉 ---
  let clarification = 0;
  let confirmation = 0;
  for (const u of us) {
    // 先生の「どこがわからない？」は理解確認であって聞き返しではない。二重に数えない。
    const isTeacherCompCheck = u.speaker === 'T' && PAT.comprehensionCheck.test(u.text);
    if (!isTeacherCompCheck && PAT.clarification.test(u.text)) {
      clarification += 1;
      push('clarification_request', u, '聞き返し');
    } else if (PAT.confirmation.test(u.text) && u.speaker === 'T') {
      confirmation += 1;
      push('confirmation_check', u, '確認');
    }
  }
  // 修復エピソード：聞き返しのあとに実際にやりとりが続いたか
  // 「聞き返した」だけでは修復ではない。相手が中身のある発話で応じて初めて数える。
  let repairs = 0;
  for (let i = 0; i < us.length - 2; i += 1) {
    if (us[i].speaker === 'T' && PAT.comprehensionCheck.test(us[i].text)) continue;
    if (!PAT.clarification.test(us[i].text)) continue;
    const win = us.slice(i + 1, i + 4);
    if (win.some((x) => x.speaker !== us[i].speaker && moraCount(x.text) >= 4)) repairs += 1;
  }

  // --- 理解可能なインプット ---
  const teacherMeanMora = teacher.length ? teacherMora / teacher.length : 0;
  let comprehensionChecks = 0;
  let emptyChecks = 0;
  let rephrases = 0;
  for (const u of teacher) {
    if (PAT.emptyCheck.test(u.text.trim())) {
      emptyChecks += 1;
      push('empty_check', u, '内容を問わない確認');
    } else if (PAT.comprehensionCheck.test(u.text)) {
      comprehensionChecks += 1;
      push('comprehension_check', u, '内容を問い返す確認');
    }
    if (PAT.rephrase.test(u.text)) {
      rephrases += 1;
      push('rephrase', u, '言い換え');
    }
    if (moraCount(u.text) > 40) {
      push('long_utterance', u, Math.round(moraCount(u.text)) + 'モーラの長い発話');
    }
  }

  // --- 足場と安心 ---
  const waits = [];
  for (let i = 0; i < us.length - 1; i += 1) {
    if (us[i].speaker !== 'T') continue;
    if (!PAT.question.test(us[i].text)) continue;
    const next = us[i + 1];
    if (next.speaker === 'T') continue;
    const gap = next.t - us[i].t;
    waits.push(gap);
    if (gap < 2) push('short_wait', us[i], '指名から応答まで ' + round(gap, 1) + '秒');
  }
  const acknowledgements = teacher.filter((u) => PAT.acknowledgement.test(u.text)).length;
  let studentInitiated = 0;
  for (let i = 0; i < us.length; i += 1) {
    if (us[i].speaker === 'T') continue;
    const before = us[i - 1];
    if (!before || before.speaker !== 'T' || !PAT.question.test(before.text)) studentInitiated += 1;
  }

  // --- アウトプットの質と変容（OUT。人間評定が主。ここはその補助） ---
  const studentMoras = studentUts.map((u) => moraCount(u.text));
  const studentMeanMora = studentMoras.length ? studentMoras.reduce((a, b) => a + b, 0) / studentMoras.length : 0;
  const longTurns = studentUts.filter((u) => moraCount(u.text) >= 10);
  for (const u of longTurns.slice(0, 4)) {
    push('student_extended_turn', u, Math.round(moraCount(u.text)) + 'モーラの発話');
  }
  // 授業内の変化：最初の1/3 と 最後の1/3 の平均発話長を比べる
  const third = Math.floor(studentUts.length / 3);
  const firstThird = studentMoras.slice(0, third);
  const lastThird = studentMoras.slice(studentMoras.length - third);
  const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const growth = third >= 2 && avg(firstThird) > 0
    ? (avg(lastThird) - avg(firstThird)) / avg(firstThird)
    : null;

  const signals = {
    duration_sec: round(durationSec, 0),
    window_minutes: windowMinutes,
    utterance_count: us.length,
    teacher_utterance_count: teacher.length,
    student_utterance_count: studentUts.length,
    teacher_talk_ratio: totalMora ? round(teacherMora / totalMora, 3) : null,
    teacher_mean_mora: round(teacherMeanMora, 1),
    roster_size: roster.length,
    student_turn_gini: round(gini(turnCounts), 3),
    silent_student_count: silent.length,
    silent_students: silent,
    max_nomination_run: maxRun,
    recast_count: recasts,
    explicit_correction_count: explicit,
    correction_count: corrections,
    uptake_count: uptake,
    uptake_rate: corrections ? round(uptake / corrections, 3) : null,
    clarification_request_count: clarification,
    confirmation_check_count: confirmation,
    repair_episode_count: repairs,
    comprehension_check_per_10min: round(per10(comprehensionChecks), 2),
    empty_check_count: emptyChecks,
    rephrase_rate: teacher.length ? round(rephrases / teacher.length, 3) : 0,
    wait_time_median_sec: round(median(waits), 2),
    acknowledgement_rate: studentUts.length ? round(acknowledgements / studentUts.length, 3) : 0,
    student_initiated_turn_rate: studentUts.length ? round(studentInitiated / studentUts.length, 3) : 0,
    student_mean_mora: round(studentMeanMora, 1),
    student_long_turn_rate: studentUts.length ? round(longTurns.length / studentUts.length, 3) : 0,
    student_mora_growth: growth === null ? null : round(growth, 3),
    turns_by_student: turns,
  };

  return { signals, events: ev.sort((a, b) => a.t - b.t) };
}

module.exports = { analyze };
