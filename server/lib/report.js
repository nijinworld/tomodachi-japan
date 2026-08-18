'use strict';
// 週次サマリを1枚のテキストにする。
//
// 毎週月曜に、メンターと運営が5分で読むためのものです。
// 画面を開かなくても、これだけ見れば「今週なにを見ればいいか」が分かることだけを狙います。
//
// この1枚では、先生の順番を作りません。並べ替えません。比べる言い方もしません
// （引き継ぎ書 5章「先生の順位づけ」＝構造として禁止していること）。
// 出す順は users の登録順に固定しています。名前で並べないのは、
// 日本語の並べ方が環境によって変わるからです（同じ入力から同じ出力が出なくなる）。
//
// 記録がない週は「未測定」と書きます。0とは書きません（mentorload.js と同じ約束）。
// Math.random / Date.now / 引数なしの new Date() は使いません。基準日は opts.asOf だけです。
// 同じ db と同じ asOf からは、必ず同じテキストが出ます。
//
// store は require しません。db は呼び出し側から受け取ります。
const { round, mean, weekKey, daysBetween } = require('./util');
const { findPersonalityTerms } = require('./ja');
const mentorload = require('./mentorload');
const survey = require('./survey');
const kill = require('./kill');

const UNMEASURED = '未測定';

// 出す順を決めるためだけの上限。長い自由記述は途中で切る（1行80文字に収めるため）
const FREE_TEXT_MAX = 38;

// 比べる言い方。自分が書いた行に混ざっていないか、最後に検査する。
// データや仕様ファイルから持ってきた文字列は検査から外す（こちらが書いた言葉ではないため）。
const COMPARISON_TERMS = [
  'より', '最も', 'もっとも', 'トップ', '下位', '上位', 'ランキング', '順位',
  '一番低い', '一番高い', 'に比べ', 'と比べ', '平均以下', '平均以上', '劣', '優れ',
];

const WEEKDAY = ['月', '火', '水', '木', '金', '土', '日'];

// ---------- 小さい道具（すべて opts.asOf 基準。時計を見ない） ----------

function arr(db, key) {
  const v = db && db[key];
  return Array.isArray(v) ? v : [];
}

function isDateStr(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

// ISO日時でも日付でも、先頭10文字を日付として扱う
function dayOf(v) {
  return typeof v === 'string' && v.length >= 10 ? v.slice(0, 10) : null;
}

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function weekdayOf(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  return WEEKDAY[(d.getUTCDay() + 6) % 7];
}

function inWeek(dateStr, week) {
  const d = dayOf(dateStr);
  return !!d && isDateStr(d) && weekKey(d) === week;
}

// 今週を含めず、その手前の n 週ぶんのキー
function previousWeeks(week, n) {
  const out = [];
  for (let i = n; i >= 1; i -= 1) out.push(weekKey(addDays(week, -7 * i)));
  return out;
}

function fmt(n) {
  return n === null || n === undefined ? UNMEASURED : String(n);
}

// 帯（0〜4）の平均。2.0 を「2」と書くと測っていないように見えるので、桁を落とさない
function fmtBand(n) {
  return typeof n === 'number' && !Number.isNaN(n) ? n.toFixed(1) : UNMEASURED;
}

// ---------- 書き手（自分の言葉と、外から来た言葉を分けて持つ） ----------

function makeWriter() {
  const foreign = [];
  // データや仕様から来た文字列。比べる言い方の検査からは外すが、人格語の検査には残す
  const q = (s, max = FREE_TEXT_MAX) => {
    let t = String(s === null || s === undefined ? '' : s).replace(/\s+/g, ' ').trim();
    if (t.length > max) t = `${t.slice(0, max)}…`;
    if (t) foreign.push(t);
    return t;
  };
  return { q, foreign };
}

// ---------- 名前と並び順 ----------

function buildPeople(db) {
  const byId = new Map();
  const order = new Map();
  const users = arr(db, 'users');
  for (let i = 0; i < users.length; i += 1) {
    const u = users[i];
    if (!u || !u.id) continue;
    byId.set(u.id, u);
    order.set(u.id, i);
  }
  return { byId, order };
}

function nameOf(people, id) {
  const u = people.byId.get(id);
  return (u && u.name) || id || '（名前なし）';
}

// 登録順。users にいない人は、あとから出てきた順に後ろへ回す
function sortByRegistration(ids, people) {
  const seen = [];
  for (const id of ids) if (!seen.includes(id)) seen.push(id);
  const rank = new Map();
  seen.forEach((id, i) => rank.set(id, people.order.has(id) ? people.order.get(id) : 10000 + i));
  return seen.slice().sort((a, b) => rank.get(a) - rank.get(b));
}

// ---------- 書き起こしが入っている授業 ----------

// db に utterances があればそれを使う。無ければ AIスコアの有無で代用する
// （scoreLesson は書き起こしが無いと動かないため、AIスコアがある＝書き起こしが入っている）
function transcribedLessonIds(db) {
  const utt = arr(db, 'utterances');
  if (utt.length) return new Set(utt.map((u) => u.lessonId));
  return new Set(arr(db, 'scores').filter((s) => s.source === 'ai').map((s) => s.lessonId));
}

// ---------- 担当の範囲（mentor 向けに絞る） ----------

function chargesOf(db, mentorId) {
  const set = new Set();
  for (const l of arr(db, 'mentorLogs')) {
    if (l && l.mentorId === mentorId && l.facilitatorId) set.add(l.facilitatorId);
  }
  for (const t of arr(db, 'teams')) {
    if (t && t.mentorId === mentorId) for (const m of t.memberIds || []) set.add(m);
  }
  const me = arr(db, 'users').find((u) => u && u.id === mentorId);
  if (me && me.teamId) {
    for (const u of arr(db, 'users')) {
      if (u && u.role === 'facilitator' && u.teamId === me.teamId) set.add(u.id);
    }
  }
  return set;
}

// ---------- 各節 ----------

function sectionLessons(ctx) {
  const { db, week, q, inScope } = ctx;
  const lessons = arr(db, 'lessons').filter((l) => l && inScope(l.facilitatorId) && inWeek(l.date, week));
  const lines = [];
  if (!lessons.length) {
    lines.push(`- 授業：${UNMEASURED}（この週の授業の記録がありません）`);
    lines.push(`- 採点：${UNMEASURED}`);
    lines.push(`- 書き起こしが入っていない授業：${UNMEASURED}`);
    ctx.warnings.push('この週の授業の記録がありません（未測定）');
    return { title: '今週の記録', lines };
  }
  const ids = new Set(lessons.map((l) => l.id));
  const scored = arr(db, 'scores').filter((s) => s && s.source === 'ai' && ids.has(s.lessonId));
  const scoredLessons = new Set(scored.map((s) => s.lessonId));
  const withTranscript = transcribedLessonIds(db);
  const missing = lessons.filter((l) => !withTranscript.has(l.id));

  lines.push(`- 授業：${lessons.length}本`);
  lines.push(`- 採点：${scoredLessons.size}本（AIスコアが入っている授業の数）`);
  lines.push(`- 書き起こしが入っていない授業：${missing.length}本`);
  if (missing.length) {
    const names = missing.slice(0, 5).map((l) => q(l.id, 24));
    lines.push(`    ・${names.join('／')}${missing.length > 5 ? ' ほか' : ''}`);
    lines.push('    書き起こしが入るまで、この授業は採点も所見も出ません。');
  }
  return { title: '今週の記録', lines };
}

function sectionMentorLoad(ctx) {
  const { db, week, weeksBack, q, people, opts } = ctx;
  const all = arr(db, 'mentorLogs').filter((l) => l && (!opts.mentorId || l.mentorId === opts.mentorId));
  const thisWeek = all.filter((l) => inWeek(l.date, week));
  const lines = [];
  const fteOpt = { mentorFteHoursPerWeek: opts.mentorFteHoursPerWeek };

  if (!thisWeek.length) {
    lines.push(`- 今週の担当人数：${UNMEASURED}`);
    lines.push(`- 今週の時間：${UNMEASURED}`);
    lines.push('    メンターの毎日1行が入っていません。0ではなく未測定です。');
    lines.push('    ここが入らないかぎり、この事業の中心の数字は出ません。');
    ctx.warnings.push('この週のメンターの記録がありません（未測定）');
  } else {
    const rows = mentorload.weekly(thisWeek, fteOpt).filter((r) => r.week === week);
    const ids = sortByRegistration(rows.map((r) => r.mentorId), people);
    for (const mid of ids) {
      for (const r of rows.filter((x) => x.mentorId === mid)) {
        const load = r.load_at_1fte === null ? UNMEASURED : `${r.load_at_1fte}人`;
        lines.push(`- ${q(nameOf(people, mid), 20)}：${r.arm ? `アーム${q(r.arm, 4)}／` : ''}`
          + `担当${r.facilitators}人／${r.hours}時間／1.0FTE換算 ${load}`);
      }
    }
    lines.push('    1.0FTE換算は実測時間からの外挿です。実測ではありません。');
  }

  // 比較のための、直近の週（今週は含めない）
  const past = all.filter((l) => isDateStr(dayOf(l.date)) && weeksBack.includes(weekKey(dayOf(l.date))));
  const sum = mentorload.summary(past, fteOpt);
  if (!sum.measured) {
    lines.push(`- 直近${weeksBack.length}週：${UNMEASURED}`);
  } else {
    for (const arm of Object.keys(sum.arms).sort()) {
      const a = sum.arms[arm];
      lines.push(`- 直近${weeksBack.length}週・アーム${q(arm, 4)}：1メンター週あたり `
        + `担当${a.mean_facilitators_per_mentor_week}人／${a.mean_hours_per_mentor_week}時間`);
    }
    if (sum.ratio_b_over_a !== null) {
      lines.push(`    アームB÷アームA（1.0FTE換算）：${sum.ratio_b_over_a}（目安 ${sum.target_ratio}）`);
    }
  }
  return { title: 'メンターの記録', lines };
}

function sectionFacilitators(ctx) {
  const { db, week, q, people, inScope } = ctx;
  const lessons = arr(db, 'lessons').filter((l) => l && inScope(l.facilitatorId));
  const scores = arr(db, 'scores').filter((s) => s && s.source === 'ai' && inScope(s.facilitatorId));

  const candidates = arr(db, 'users')
    .filter((u) => u && u.role === 'facilitator' && u.status !== 'left' && inScope(u.id))
    .map((u) => u.id)
    .concat(lessons.filter((l) => inWeek(l.date, week)).map((l) => l.facilitatorId));
  const ids = sortByRegistration(candidates.filter(Boolean), people);

  const lines = [];
  if (!ids.length) {
    lines.push(`- 先生の記録：${UNMEASURED}`);
    return { title: '先生ごとの一行（登録順。並べ替えていません）', lines };
  }

  for (const fid of ids) {
    const label = `${q(nameOf(people, fid), 20)}さん`;
    const mine = lessons.filter((l) => l.facilitatorId === fid && inWeek(l.date, week));
    if (!mine.length) {
      lines.push(`- ${label}：今週の授業の記録はありません（${UNMEASURED}）`);
      continue;
    }
    const week_ = scores.filter((s) => s.facilitatorId === fid && inWeek(s.date, week));
    if (!week_.length) {
      lines.push(`- ${label}：今週${mine.length}本／採点はまだ入っていません（${UNMEASURED}）`);
      continue;
    }
    const overall = round(mean(week_.map((s) => s.overall).filter((v) => typeof v === 'number')), 1);

    // 本人の直近3回（今週より手前の、自分のスコアだけ）。他の人とは比べない
    const before = scores
      .filter((s) => s.facilitatorId === fid && dayOf(s.date) && dayOf(s.date) < week)
      .sort((a, b) => (dayOf(a.date) < dayOf(b.date) ? 1 : dayOf(a.date) > dayOf(b.date) ? -1 : (a.id < b.id ? 1 : -1)))
      .slice(0, 3);
    const own = before.length
      ? `本人の直近${before.length}回 ${fmtBand(round(mean(before.map((s) => s.overall).filter((v) => typeof v === 'number')), 1))}`
      : `本人の過去のデータは${UNMEASURED}`;

    // いちばん低い観点。人が採点する観点（rater: human）はAIの平均に入れないので、ここでも見ない
    const byDim = new Map();
    for (const s of week_) {
      for (const [code, d] of Object.entries(s.dims || {})) {
        if (!d || (d.rater || 'ai') === 'human') continue;
        if (typeof d.level !== 'number') continue;
        if (!byDim.has(code)) byDim.set(code, []);
        byDim.get(code).push(d.level);
      }
    }
    let low = UNMEASURED;
    if (byDim.size) {
      const means = [...byDim.entries()].map(([code, vs]) => [code, mean(vs)]);
      const min = Math.min(...means.map((m) => m[1]));
      low = means.filter((m) => m[1] === min).map((m) => q(m[0], 6)).join('・');
    }
    lines.push(`- ${label}：今週${mine.length}本／5観点の平均 ${fmtBand(overall)}`
      + `（${own}）／いちばん低い観点 ${low}`);
  }
  lines.push('    この節は登録順です。先生どうしを並べていません。');
  return { title: '先生ごとの一行（登録順。並べ替えていません）', lines };
}

function sectionSurvey(ctx) {
  const { db, q, people, inScope } = ctx;
  const responses = arr(db, 'surveyResponses').filter((r) => r && inScope(r.facilitatorId));
  const lines = [];
  if (!responses.length) {
    lines.push(`- アンケート：${UNMEASURED}（回答の記録がありません）`);
    return { title: '返し方が止まっているアンケート', lines };
  }
  const metaRec = arr(db, 'settings').find((s) => s && s.key === 'survey_cycles');
  const meta = (metaRec && metaRec.value) || {};

  const cycles = new Map();
  for (const r of responses) {
    const key = `${r.facilitatorId}|${r.cycle}`;
    if (!cycles.has(key)) cycles.set(key, { key, facilitatorId: r.facilitatorId, cycle: r.cycle, n: 0 });
    cycles.get(key).n += 1;
  }
  const ordered = [...cycles.values()].sort((a, b) => {
    if (a.cycle !== b.cycle) return a.cycle < b.cycle ? -1 : 1;
    const ai = people.order.has(a.facilitatorId) ? people.order.get(a.facilitatorId) : 10000;
    const bi = people.order.has(b.facilitatorId) ? people.order.get(b.facilitatorId) : 10000;
    if (ai !== bi) return ai - bi;
    return a.key < b.key ? -1 : 1;
  });

  let stuck = 0;
  for (const c of ordered) {
    const design = survey.designCompliance(meta[c.key] || {});
    if (design.compliant) continue;
    stuck += 1;
    const missing = design.steps.filter((s) => !s.ok);
    lines.push(`- ${q(nameOf(people, c.facilitatorId), 20)}さんの ${q(c.cycle, 12)}`
      + `（回答${c.n}件）：3手順のうち${missing.length}つが欠けています`);
    for (const s of missing) lines.push(`    ・${q(s.label, 44)}`);
  }
  if (!stuck) {
    lines.push(`- 止まっているものはありません（${ordered.length}件すべて3手順そろっています）`);
  } else {
    lines.push(`    ${stuck}件／${ordered.length}件。効果のほとんどは「返し方」に載っています。`);
    lines.push('    ここを飛ばすと、アンケートを取った意味がほぼ消えます。');
    ctx.warnings.push(`返し方の3手順が欠けているアンケートが ${stuck}件あります`);
  }
  return { title: '返し方が止まっているアンケート', lines };
}

function sectionDeclarations(ctx) {
  const { db, week, q, people, inScope } = ctx;
  const meetings = arr(db, 'meetings').filter((m) => m && inWeek(m.date, week));
  const lines = [];
  if (!meetings.length) {
    lines.push(`- 今週のチーム会の記録：${UNMEASURED}`);
    return { title: '今週の宣言', lines };
  }
  const rows = [];
  for (const m of meetings) {
    for (const d of m.declarations || []) {
      if (!d || !inScope(d.facilitatorId)) continue;
      rows.push({ ...d, date: dayOf(m.date), meetingId: m.id });
    }
  }
  if (!rows.length) {
    lines.push(`- 宣言の記録：${UNMEASURED}（チーム会はありましたが、宣言が入っていません）`);
    return { title: '今週の宣言', lines };
  }
  const ids = sortByRegistration(rows.map((r) => r.facilitatorId), people);
  for (const fid of ids) {
    for (const r of rows.filter((x) => x.facilitatorId === fid)) {
      const dim = r.dimension ? `${q(r.dimension, 6)}｜` : '';
      lines.push(`- ${q(nameOf(people, fid), 20)}さん：${dim}${q(r.action, FREE_TEXT_MAX)}`);
    }
  }
  lines.push('    宣言は1人1つです。来週の一行は、この宣言を見てから書いてください。');
  return { title: '今週の宣言', lines };
}

function sectionStuck(ctx) {
  const { db, asOf, q, inScope } = ctx;
  const lines = [];
  const withTranscript = transcribedLessonIds(db);
  const lessons = arr(db, 'lessons').filter((l) => l && inScope(l.facilitatorId));

  // 90日以上、書き起こしが入っていないクラス
  const classes = arr(db, 'classes').filter((c) => c && inScope(c.facilitatorId));
  const stale = [];
  let noLessonClasses = 0;
  for (const c of classes) {
    const mine = lessons.filter((l) => l.classId === c.id);
    if (!mine.length) { noLessonClasses += 1; continue; }
    const dates = mine.filter((l) => withTranscript.has(l.id)).map((l) => dayOf(l.date)).filter(Boolean).sort();
    const last = dates.length ? dates[dates.length - 1] : null;
    if (!last) { stale.push({ c, last: null, days: null }); continue; }
    const days = daysBetween(last, asOf);
    if (days >= 90) stale.push({ c, last, days });
  }
  if (!classes.length) {
    lines.push(`- 書き起こしが止まっているクラス：${UNMEASURED}（クラスの記録がありません）`);
  } else if (!stale.length) {
    lines.push('- 90日以上、書き起こしが入っていないクラス：0件');
  } else {
    lines.push(`- 90日以上、書き起こしが入っていないクラス：${stale.length}件`);
    for (const s of stale.slice(0, 8)) {
      lines.push(s.last
        ? `    ・${q(s.c.name || s.c.id, 22)}：最後は ${s.last}（${s.days}日前）`
        : `    ・${q(s.c.name || s.c.id, 22)}：一度も入っていません`);
    }
    if (stale.length > 8) lines.push(`    ・ほか ${stale.length - 8}件`);
  }
  if (noLessonClasses) lines.push(`    授業の記録が1本もないクラスが ${noLessonClasses}件（${UNMEASURED}）`);

  // 所見が未読のまま7日以上
  const feedbacks = arr(db, 'feedbacks').filter((f) => f && inScope(f.facilitatorId));
  if (!feedbacks.length) {
    lines.push(`- 未読のままの所見：${UNMEASURED}（所見の記録がありません）`);
  } else {
    const limit = addDays(asOf, -7);
    const unread = feedbacks
      .filter((f) => !f.acknowledgedAt && dayOf(f.createdAt) && dayOf(f.createdAt) <= limit)
      .sort((a, b) => (dayOf(a.createdAt) < dayOf(b.createdAt) ? -1 : 1));
    if (!unread.length) {
      lines.push('- 所見が未読のまま7日以上：0件');
    } else {
      lines.push(`- 所見が未読のまま7日以上：${unread.length}件`
        + `（いちばん古いのは ${dayOf(unread[0].createdAt)}）`);
      ctx.warnings.push(`未読のままの所見が ${unread.length}件あります`);
    }
  }

  // 視聴の問いに答えていないクリップ
  const clips = arr(db, 'clips');
  if (!clips.length) {
    lines.push(`- アーカイブのクリップ：${UNMEASURED}（クリップの記録がありません）`);
  } else {
    let views = 0;
    let blanks = 0;
    const clipHits = [];
    for (const c of clips) {
      const vs = (c.views || []).filter((v) => v && (!ctx.scoped || inScope(v.userId)));
      views += vs.length;
      const bad = vs.filter((v) => !String(v.answer || '').trim()).length;
      if (bad) { blanks += bad; clipHits.push({ c, bad }); }
    }
    if (!clipHits.length) {
      lines.push(`- 視聴の問いに答えていないクリップ：0件（視聴${views}件）`);
    } else {
      lines.push(`- 視聴の問いに答えていないクリップ：${clipHits.length}件`
        + `（答えのない視聴 ${blanks}件／視聴${views}件）`);
      for (const h of clipHits.slice(0, 5)) {
        lines.push(`    ・${q(h.c.title || h.c.id, 22)}：${h.bad}件`);
      }
      ctx.warnings.push(`問いに答えていない視聴が ${blanks}件あります`);
    }
  }
  return { title: '止まっているもの', lines };
}

// 撤退基準に渡す数字。db から出せるものだけを出す。出せないものは undefined のままにする
// （kill.js が undefined を「未測定」として扱うため。ここで 0 を入れてはいけない）
function collectMetrics(db) {
  const m = {};
  const incidents = db && db.incidents;
  if (Array.isArray(incidents)) m.open_incident_count = incidents.filter((i) => i && i.status === 'open').length;

  const logs = arr(db, 'mentorLogs');
  if (logs.length) {
    const load = mentorload.summary(logs);
    if (load.measured && load.ratio_b_over_a !== null) m.mentor_load_ratio_b_over_a = load.ratio_b_over_a;
  }

  const ai = arr(db, 'scores').filter((s) => s && s.source === 'ai');
  const armMean = (arm) => {
    const v = ai.filter((s) => s.arm === arm).map((s) => s.overall).filter((x) => typeof x === 'number');
    return v.length ? mean(v) : null;
  };
  const a = armMean('A');
  const b = armMean('B');
  if (a && b) m.quality_ratio_b_over_a = round(b / a, 3);

  const churn = (arm) => {
    const st = arr(db, 'students').filter((s) => s && s.arm === arm);
    if (!st.length) return null;
    return (st.filter((s) => s.status === 'left').length / st.length) * 100;
  };
  const ca = churn('A');
  const cb = churn('B');
  if (ca !== null && cb !== null) m.churn_gap_pt = round(Math.abs(cb - ca), 2);

  for (const s of arr(db, 'settings')) {
    if (!s || !s.key) continue;
    if (s.key === 'hire_rate_pct' || s.key === 'enrolled_satisfaction_delta_pt') m[s.key] = s.value;
  }
  return m;
}

function sectionKill(ctx) {
  const { db, q } = ctx;
  const lines = [];
  let res = null;
  try {
    res = kill.evaluate(collectMetrics(db));
  } catch (e) {
    lines.push(`- 撤退基準：${UNMEASURED}（基準の読み込みに失敗しました）`);
    ctx.warnings.push('撤退基準の判定ができませんでした');
    return { title: '撤退基準', lines };
  }
  if (res.halt_all) {
    lines.push('- 全事業の停止に当たる基準に触れています。');
    lines.push(`    ・${q(res.halt_reason, 44)}`);
    ctx.warnings.push('停止に当たる撤退基準に触れています');
  }
  for (const r of res.tripped) {
    lines.push(`- 触れています：${q(r.label, 26)}（いまの値 ${fmt(r.value)}／基準 ${q(r.rule, 26)}）`);
    lines.push(`    ・やること：${q(r.action, 40)}`);
    ctx.warnings.push(`撤退基準に触れています：${r.id}`);
  }
  if (!res.tripped.length) lines.push('- 触れている基準：0件');

  const unmeasured = res.results.filter((r) => !r.measured);
  if (unmeasured.length) {
    lines.push(`- ${UNMEASURED}：${unmeasured.length}件（判定できません。0ではありません）`);
    for (const r of unmeasured) lines.push(`    ・${q(r.label, 30)}`);
  }
  const quiet = res.results.length - res.tripped.length - unmeasured.length;
  if (quiet > 0) lines.push(`- そのほか ${quiet}件は基準に触れていません。`);
  return { title: '撤退基準', lines };
}

// ---------- 本体 ----------

function weekly(db, opts = {}) {
  const source = db || {};
  const asOf = opts.asOf;
  if (!isDateStr(asOf)) {
    const err = new Error('opts.asOf は YYYY-MM-DD で必ず渡してください（時計を見ないため）');
    err.code = 'ASOF_REQUIRED';
    throw err;
  }
  const audience = opts.audience === 'mentor' ? 'mentor' : 'admin';
  const nWeeks = Number.isInteger(opts.weeks) && opts.weeks > 0 ? opts.weeks : 4;
  const week = weekKey(asOf);
  const weekEnd = addDays(week, 6);
  const warnings = [];
  const { q, foreign } = makeWriter();
  const people = buildPeople(source);

  // mentor の1枚は、自分の担当分だけに絞る。担当が分からないときは広げない（引き継ぎ書 6.2）
  let charges = null;
  if (audience === 'mentor' && opts.mentorId) {
    charges = chargesOf(source, opts.mentorId);
    if (!charges.size) warnings.push('担当の先生を特定できませんでした（mentorLogs / teams に記録がありません）');
  }
  const inScope = (fid) => !charges || (!!fid && charges.has(fid));

  const ctx = {
    db: source,
    opts: { ...opts, weeks: nWeeks },
    asOf,
    week,
    weeksBack: previousWeeks(week, nWeeks),
    warnings,
    q,
    people,
    inScope,
    scoped: !!charges,
  };

  const sections = [
    sectionLessons(ctx),
    sectionMentorLoad(ctx),
    sectionFacilitators(ctx),
    sectionSurvey(ctx),
    sectionDeclarations(ctx),
    sectionStuck(ctx),
    sectionKill(ctx),
  ];

  const head = [
    '週次サマリ｜ともだちじゃぱん',
    `対象週 ${week}（${weekdayOf(week)}）〜 ${weekEnd}（${weekdayOf(weekEnd)}）／基準日 ${asOf}`,
    `宛先 ${audience === 'mentor' ? 'メンター' : '運営'}`
      + (charges ? `（担当 ${charges.size}人ぶん）` : '')
      + `／比較に使った過去 ${nWeeks}週`,
    '先生を並べ替えていません。記録がないところは「未測定」と書いています。',
  ];

  const body = [];
  for (const s of sections) {
    body.push('');
    body.push(`## ${s.title}`);
    for (const line of s.lines) body.push(line);
  }
  const text = `${head.join('\n')}\n${body.join('\n')}\n`;

  // 自分の出力を検査する。まず人格に触れる語（引き継ぎ書 5章）。
  // データから来た文字列も対象にする。宣言や所見に混ざっていたら、その場で止める。
  const personality = findPersonalityTerms(text);
  if (personality.length) {
    const err = new Error(`週次サマリに人格に触れる語が入っています: ${personality.join('、')}。`
      + '行動と時刻で書き直してください。');
    err.code = 'PERSONALITY_TERM';
    err.terms = personality;
    throw err;
  }

  // つぎに、比べる言い方。こちらが書いた行だけを見る（データの文言は外す）
  let probe = text;
  for (const f of foreign) if (f) probe = probe.split(f).join('');
  const compared = COMPARISON_TERMS.filter((w) => probe.includes(w));
  if (compared.length) {
    const err = new Error(`週次サマリに比べる言い方が入っています: ${compared.join('、')}。`
      + '先生の順番は作りません。');
    err.code = 'COMPARISON_TERM';
    err.terms = compared;
    throw err;
  }

  return { text, sections, week, warnings };
}

module.exports = { weekly };
