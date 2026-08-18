'use strict';
// メンター1人あたりの担当ファシリテーター数。
//
// これがこの事業の全論拠です。他の指標はすべてこれに従属します。
// だから、推定しません。毎日1行の記録（mentorLogs）からしか計算しません。
// 記録がない週は「未測定」と出します。0とは書きません。
const { round, weekKey } = require('./util');

// logs: [{ id, mentorId, facilitatorId, date, minutes, kind, arm }]
// kind: 'observation'（授業を見た）| 'feedback'（所見を返した）| 'meeting'（チーム会）| 'other'
function weekly(logs, opts = {}) {
  const fteHours = opts.mentorFteHoursPerWeek || 40;
  const byWeek = {};
  for (const l of logs) {
    const wk = weekKey(l.date);
    if (!byWeek[wk]) byWeek[wk] = {};
    const key = `${l.arm || '-'}|${l.mentorId}`;
    if (!byWeek[wk][key]) {
      byWeek[wk][key] = { week: wk, arm: l.arm || null, mentorId: l.mentorId, facilitators: new Set(), minutes: 0, entries: 0 };
    }
    const rec = byWeek[wk][key];
    rec.facilitators.add(l.facilitatorId);
    rec.minutes += l.minutes || 0;
    rec.entries += 1;
  }

  const rows = [];
  for (const wk of Object.keys(byWeek).sort()) {
    for (const rec of Object.values(byWeek[wk])) {
      const hours = rec.minutes / 60;
      const n = rec.facilitators.size;
      rows.push({
        week: rec.week,
        arm: rec.arm,
        mentorId: rec.mentorId,
        facilitators: n,
        hours: round(hours, 2),
        minutes_per_facilitator: n ? round(rec.minutes / n, 1) : null,
        // 1.0 FTE に換算したときの担当可能人数。実測時間からの外挿であることを忘れないこと
        load_at_1fte: hours > 0 ? round(n * (fteHours / hours), 1) : null,
        entries: rec.entries,
      });
    }
  }
  return rows;
}

function summary(logs, opts = {}) {
  const rows = weekly(logs, opts);
  if (!rows.length) {
    return {
      measured: false,
      note: '記録がありません。メンターの毎日1行が入るまで、この数字は出しません（0ではなく未測定です）。',
      arms: {},
      ratio_b_over_a: null,
    };
  }
  const arms = {};
  for (const r of rows) {
    const arm = r.arm || '-';
    if (!arms[arm]) arms[arm] = { weeks: 0, facilitatorsSum: 0, hoursSum: 0, loadSum: 0, loadN: 0, mentors: new Set() };
    const a = arms[arm];
    a.weeks += 1;
    a.facilitatorsSum += r.facilitators;
    a.hoursSum += r.hours;
    a.mentors.add(r.mentorId);
    if (r.load_at_1fte !== null) { a.loadSum += r.load_at_1fte; a.loadN += 1; }
  }
  const out = {};
  for (const [arm, a] of Object.entries(arms)) {
    out[arm] = {
      mentor_weeks: a.weeks,
      mentors: a.mentors.size,
      mean_facilitators_per_mentor_week: round(a.facilitatorsSum / a.weeks, 2),
      mean_hours_per_mentor_week: round(a.hoursSum / a.weeks, 2),
      mean_load_at_1fte: a.loadN ? round(a.loadSum / a.loadN, 1) : null,
    };
  }
  const A = out.A ? out.A.mean_load_at_1fte : null;
  const B = out.B ? out.B.mean_load_at_1fte : null;
  return {
    measured: true,
    arms: out,
    ratio_b_over_a: A && B ? round(B / A, 2) : null,
    target_ratio: 3.0,
    note: 'load_at_1fte は実測時間から 1.0 FTE に外挿した値です。実測ではありません。外挿であることを画面にも書くこと。',
    evidence_id: 'mentor_load',
  };
}

module.exports = { weekly, summary };
