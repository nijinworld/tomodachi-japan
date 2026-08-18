'use strict';
const fs = require('node:fs');
const path = require('node:path');
const store = require('../lib/store');
const { scoreLesson, loadRubric, computeFingerprint } = require('../lib/scoring');
const feedbackLib = require('../lib/feedback');
const irrLib = require('../lib/irr');
const costLib = require('../lib/cost');
const mentorLoadLib = require('../lib/mentorload');
const surveyLib = require('../lib/survey');
const killLib = require('../lib/kill');
const auth = require('../lib/auth');
const exportLib = require('../lib/export');
const importLib = require('../lib/import');
const attendanceLib = require('../lib/attendance');
const reportLib = require('../lib/report');
const contractLib = require('../lib/contract');
const crypto = require('node:crypto');
const { findPersonalityTerms } = require('../lib/ja');
const { id, round, mean, isoDate, weekKey, daysBetween } = require('../lib/util');

const SPEC_DIR = path.join(__dirname, '..', '..', 'spec');
const readSpec = (f) => JSON.parse(fs.readFileSync(path.join(SPEC_DIR, f), 'utf8'));

function fail(status, message, code) {
  const e = new Error(message);
  e.status = status;
  if (code) e.code = code;
  return e;
}
const ok = (body, status) => ({ status: status || 200, body });

const DEFAULT_SETTINGS = {
  wage_minimum: 1200,          // 円/時（②のシナリオ）
  wage_equivalent: 3200,       // 円/時（③のシナリオ。同等スキル職）
  mentor_hourly: 4500,         // 円/時
  staff_hourly: 3000,          // 円/時
  mentor_fte_hours_week: 40,
  enrolled_satisfaction_delta_pt: 0, // NIJINアカデミー在校生。外部の数字なので手で入れる
  demo_mode: true,
  // 子どもの発話を、同意なしに保存しない。実データでは必ず true のままにすること。
  require_consent: true,
  // 書き起こしを何日で消すか。スコアと信号（数値）は残し、子どものことばだけを消す。
  transcript_retention_days: 180,
  last_purge_at: null,
};

function setting(key) {
  const v = store.setting(key, undefined);
  return v === undefined ? DEFAULT_SETTINGS[key] : v;
}

// ---------- モデル版 ----------
function currentModelVersion() {
  const frozen = store.all('modelVersions').filter((m) => m.frozen);
  if (frozen.length) return frozen[frozen.length - 1];
  return null;
}

function draftModelVersion() {
  const fp = computeFingerprint('local-heuristic');
  return { id: 'draft', label: '（未凍結）', frozen: false, ...fp };
}

// ---------- 撤退基準のための指標 ----------
function collectMetrics() {
  const incidents = store.all('incidents').filter((i) => i.status === 'open');
  const logs = store.all('mentorLogs');
  const load = mentorLoadLib.summary(logs, { mentorFteHoursPerWeek: setting('mentor_fte_hours_week') });

  const aiScores = store.all('scores').filter((s) => s.source === 'ai');
  const armMean = (arm) => {
    const v = aiScores.filter((s) => s.arm === arm).map((s) => s.overall);
    return v.length ? mean(v) : null;
  };
  const a = armMean('A');
  const b = armMean('B');

  const ratings = store.all('ratings');
  const irrPairs = buildHumanPairs(ratings);
  const irrReport = irrPairs.length ? irrLib.report(irrPairs) : null;

  const churn = (arm) => {
    const st = store.all('students').filter((s) => s.arm === arm);
    if (!st.length) return null;
    return (st.filter((s) => s.status === 'left').length / st.length) * 100;
  };
  const ca = churn('A');
  const cb = churn('B');

  return {
    open_incident_count: incidents.length,
    mentor_load_ratio_b_over_a: load.ratio_b_over_a,
    quality_ratio_b_over_a: a && b ? round(b / a, 3) : null,
    churn_gap_pt: ca !== null && cb !== null ? round(Math.abs(cb - ca), 2) : null,
    irr_qwk: irrReport ? irrReport.overall.qwk : null,
    enrolled_satisfaction_delta_pt: setting('enrolled_satisfaction_delta_pt'),
  };
}

function killStatus() {
  return killLib.evaluate(collectMetrics());
}

// 人間評定者どうしのペアを作る（同じ授業・同じ観点を、別々の2人が採点したもの）
function buildHumanPairs(ratings) {
  const byLesson = {};
  for (const r of ratings) {
    if (!byLesson[r.lessonId]) byLesson[r.lessonId] = [];
    byLesson[r.lessonId].push(r);
  }
  const pairs = [];
  for (const [lessonId, rs] of Object.entries(byLesson)) {
    const raters = [...new Set(rs.map((r) => r.raterId))];
    if (raters.length < 2) continue;
    const [r1, r2] = raters;
    const a = rs.find((r) => r.raterId === r1);
    const b = rs.find((r) => r.raterId === r2);
    for (const code of Object.keys(a.dims || {})) {
      if (b.dims && b.dims[code] !== undefined) {
        pairs.push({ lessonId, dim: code, a: a.dims[code], b: b.dims[code] });
      }
    }
  }
  return pairs;
}

// ---------- 授業の採点 ----------
function runScoring(lesson, opts = {}) {
  const utterances = store.all('utterances').filter((u) => u.lessonId === lesson.id);
  if (!utterances.length) throw fail(400, 'この授業には書き起こしがありません。先に書き起こしを入れてください。');
  const klass = store.get('classes', lesson.classId);
  const roster = klass ? klass.studentIds : [];
  const mv = opts.modelVersion || currentModelVersion() || draftModelVersion();
  const scored = scoreLesson(utterances, { roster });

  const rec = {
    id: id('sc'),
    lessonId: lesson.id,
    facilitatorId: lesson.facilitatorId,
    classId: lesson.classId,
    arm: lesson.arm,
    date: lesson.date,
    source: 'ai',
    modelVersionId: mv.id,
    modelFingerprint: mv.fingerprint,
    frozen: !!mv.frozen,
    dims: scored.dims,
    overall: scored.overall,
    signals: scored.signals,
    events: scored.events,
    createdAt: new Date().toISOString(),
  };
  // 同じ授業・同じモデル版のスコアは1つだけ持つ（再スコアは置き換え）
  store.remove('scores', (s) => s.lessonId === lesson.id && s.modelVersionId === mv.id && s.source === 'ai');
  store.insert('scores', rec);
  return rec;
}

function facilitatorHistory(facilitatorId, excludeLessonId) {
  return store.all('scores')
    .filter((s) => s.source === 'ai' && s.facilitatorId === facilitatorId && s.lessonId !== excludeLessonId)
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

function makeFeedback(scoreRec) {
  const history = facilitatorHistory(scoreRec.facilitatorId, scoreRec.lessonId);
  const gen = feedbackLib.generate(scoreRec, history);
  const rec = {
    id: id('fb'),
    lessonId: scoreRec.lessonId,
    facilitatorId: scoreRec.facilitatorId,
    arm: scoreRec.arm,
    kind: 'ai',
    modelVersionId: scoreRec.modelVersionId,
    dimension: gen.dimension,
    action_step: gen.action_step,
    body: gen.body,
    evidence: gen.evidence,
    createdAt: new Date().toISOString(),
    acknowledgedAt: null,
    mentorMinutes: 0,
  };
  store.remove('feedbacks', (f) => f.lessonId === scoreRec.lessonId && f.kind === 'ai');
  store.insert('feedbacks', rec);
  return rec;
}

// ---------- ルーティング ----------
const ROUTES = [];
const route = (method, pattern, handler, opts = {}) => ROUTES.push({ method, parts: pattern.split('/').filter(Boolean), handler, opts });

function match(ctx) {
  const parts = ctx.path.split('/').filter(Boolean); // ['api', ...]
  for (const r of ROUTES) {
    if (r.method !== ctx.method) continue;
    if (r.parts.length !== parts.length) continue;
    const params = {};
    let good = true;
    for (let i = 0; i < r.parts.length; i += 1) {
      const p = r.parts[i];
      if (p.startsWith(':')) params[p.slice(1)] = parts[i];
      else if (p !== parts[i]) { good = false; break; }
    }
    if (good) return { r, params };
  }
  return null;
}

async function handle(ctx) {
  const m = match(ctx);
  if (!m) throw fail(404, `そのAPIはありません: ${ctx.method} ${ctx.path}`);

  // 誰であるかは、署名つきクッキーからしか決めない
  ctx.user = auth.currentUser(ctx);
  ctx.userId = ctx.user ? ctx.user.id : null;

  if (!m.r.opts.public) {
    if (!ctx.user) throw fail(401, 'ログインしてください。', 'UNAUTHENTICATED');
    const roles = m.r.opts.roles;
    if (roles && !roles.includes(ctx.user.role)) {
      throw fail(403, `この操作ができるのは ${roles.join(' / ')} です。あなたは ${ctx.user.role} です。`, 'FORBIDDEN');
    }
  }

  // セーフガーディング事案が1件でも開いていたら、全事業を停止する。
  // 見られるのは、状況の確認と事案の記録だけ。
  const ks = killStatus();
  if (ks.halt_all && !m.r.opts.allowWhenHalted) {
    throw fail(423, 'セーフガーディング事案が未クローズです。全機能を停止しています。事案の対応と公表が先です。', 'HALTED');
  }
  return m.r.handler(ctx, m.params);
}

// 子どものことばが見えた回数を残す。
// 「誰がいつ、どの授業の書き起こしを見たか」は、保護者に説明できなければならない。
function logView(ctx, action, target) {
  store.insert('auditLog', {
    id: id('au'), at: new Date().toISOString(), actor: ctx.userId, role: ctx.user ? ctx.user.role : null,
    action, target,
  });
}

// 合言葉のハッシュは、どのAPIからも絶対に出さない。
function publicUser(u) {
  if (!u) return null;
  const { salt, hash, ...rest } = u;
  return { ...rest, has_passcode: !!hash };
}

// 見てよい先生に絞る。ここを通さずに授業やスコアを返さないこと。
function assertCanSeeFacilitator(ctx, facilitatorId) {
  if (!auth.canSeeFacilitator(ctx.user, facilitatorId)) {
    throw fail(403, 'この先生の記録を見る権限がありません。', 'FORBIDDEN');
  }
}

// 見てよいチーム。facilitator は自分の所属だけ（全ユーザーの列挙を防ぐ）
function visibleTeams(ctx) {
  const u = ctx.user;
  const all = store.all('teams');
  if (u.role === 'admin' || u.role === 'staff') return all;
  if (u.role === 'facilitator') return all.filter((t) => t.id === u.teamId);
  if (u.role === 'mentor') return all.filter((t) => t.mentorId === u.id || t.id === u.teamId);
  return [];
}

function scopeLessons(ctx, lessons) {
  const u = ctx.user;
  if (u.role === 'admin') return lessons;
  if (u.role === 'facilitator') return lessons.filter((l) => l.facilitatorId === u.id);
  if (u.role === 'mentor') return lessons.filter((l) => auth.canSeeFacilitator(u, l.facilitatorId));
  return [];
}

// 子どもの表示名。見る権限がない相手には「子ども1」のような記号しか返さない。
function childLabel(ctx, student, index) {
  if (!student) return `子ども${index + 1}`;
  return auth.canSeeChildNames(ctx.user) ? student.name : `子ども${index + 1}`;
}

// ===== メタ =====
route('GET', '/api/health', () => ok({ ok: true, time: new Date().toISOString() }), { allowWhenHalted: true, public: true });

route('GET', '/api/meta', () => {
  const mv = currentModelVersion();
  return ok({
    product: 'Ranius日本語 — ともだちじゃぱん運用システム',
    demo_mode: !!setting('demo_mode'),
    rubric: loadRubric(),
    survey: readSpec('survey.ja.json'),
    evidence: readSpec('evidence.json'),
    killCriteria: readSpec('kill-criteria.json'),
    modelVersion: mv || draftModelVersion(),
    modelVersionFrozen: !!mv,
    settings: Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((k) => [k, setting(k)])),
  });
}, { allowWhenHalted: true });

route('GET', '/api/kill-status', () => ok({ ...killStatus(), metrics: collectMetrics() }), { allowWhenHalted: true });

// 書き起こしの保存期間の状況。実データを入れたら、ここを毎月見ること。
route('GET', '/api/retention', () => {
  const days = setting('transcript_retention_days');
  const cutoff = isoDate(Date.now() - days * 86400000);
  const lessons = store.all('lessons');
  const withUtt = new Set(store.all('utterances').map((u) => u.lessonId));
  const overdue = lessons.filter((l) => l.date < cutoff && withUtt.has(l.id));
  const students = store.all('students');
  return ok({
    retention_days: days,
    cutoff,
    lessons_with_transcript: [...withUtt].length,
    lessons_overdue: overdue.length,
    utterances_total: store.all('utterances').length,
    last_purge_at: setting('last_purge_at'),
    require_consent: setting('require_consent'),
    consent: {
      total: students.length,
      recorded: students.filter((x) => x.consent && x.consent.obtainedAt && !x.consent.withdrawnAt).length,
      withdrawn: students.filter((x) => x.consent && x.consent.withdrawnAt).length,
      missing: students.filter((x) => !x.consent || !x.consent.obtainedAt).length,
    },
    note: '消すのは子どものことば（発話と引用）だけです。スコアと信号（数値）は残します。'
      + '実行は node scripts/purge.js。',
  });
}, { roles: ['admin', 'mentor', 'staff'] });

route('PUT', '/api/settings', (ctx) => {
  for (const [k, v] of Object.entries(ctx.body || {})) {
    if (!(k in DEFAULT_SETTINGS)) throw fail(400, `知らない設定: ${k}`);
    store.setSetting(k, v);
  }
  return ok(Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((k) => [k, setting(k)])));
}, { roles: ['admin', 'staff'] });

// ===== ログイン =====
route('GET', '/api/session', (ctx) => ok({
  user: publicUser(ctx.user),
  bootstrap_needed: store.all('users').every((u) => !u.hash),
  roles: auth.ROLES,
}), { public: true, allowWhenHalted: true });

route('POST', '/api/session', (ctx) => {
  const b = ctx.body || {};
  const users = store.all('users');
  const u = users.find((x) => x.id === b.userId) || users.find((x) => x.name === b.userId);
  // 「そのIDは無い」と「合言葉が違う」を区別しない（総当たりの手がかりを与えないため）
  const bad = fail(401, 'ユーザーIDか合言葉が違います。', 'BAD_CREDENTIALS');
  if (!u || !u.hash) throw bad;
  if (u.status === 'disabled') throw fail(403, 'このアカウントは停止されています。', 'DISABLED');
  if (!auth.verifyPasscode(b.passcode || '', u)) {
    store.insert('auditLog', { id: id('au'), at: new Date().toISOString(), actor: u.id, action: 'login.fail', target: null });
    throw bad;
  }
  store.insert('auditLog', { id: id('au'), at: new Date().toISOString(), actor: u.id, action: 'login.ok', target: null });
  return { status: 200, body: { user: publicUser(u) }, cookie: auth.cookieHeader(auth.issue(u.id)) };
}, { public: true, allowWhenHalted: true });

route('DELETE', '/api/session', () => ({ status: 200, body: { ok: true }, cookie: auth.cookieHeader(null) }),
  { public: true, allowWhenHalted: true });

route('POST', '/api/session/passcode', (ctx) => {
  const b = ctx.body || {};
  if (!b.current || !b.next) throw fail(400, 'いまの合言葉と、新しい合言葉の両方が必要です');
  if (String(b.next).length < 8) throw fail(400, '合言葉は8文字以上にしてください');
  if (!auth.verifyPasscode(b.current, ctx.user)) throw fail(401, 'いまの合言葉が違います');
  store.update('users', ctx.user.id, auth.hashPasscode(b.next));
  return ok({ ok: true });
});

// ===== 人・組織 =====
route('GET', '/api/users', (ctx) => {
  let us = store.all('users');
  const me = ctx.user;
  if (me.role === 'facilitator') us = us.filter((u) => u.id === me.id);
  else if (me.role === 'mentor') {
    us = us.filter((u) => u.role !== 'rater'
      && (u.role !== 'facilitator' || auth.canSeeFacilitator(me, u.id) || u.id === me.id));
  }
  if (ctx.query.role) us = us.filter((u) => u.role === ctx.query.role);
  if (ctx.query.arm) us = us.filter((u) => u.arm === ctx.query.arm);
  return ok(us.map(publicUser));
}, { roles: ['admin', 'mentor', 'facilitator', 'staff'] });

route('POST', '/api/users', (ctx) => {
  const b = ctx.body || {};
  if (!b.name || !b.role) throw fail(400, 'name と role は必須です');
  const rec = {
    id: id('u'),
    name: b.name,
    role: b.role, // admin | mentor | facilitator | rater | staff
    arm: b.arm || null,
    teamId: b.teamId || null,
    licensed: !!b.licensed,
    region: b.region || null,
    startedAt: b.startedAt || isoDate(Date.now()),
    readyAt: b.readyAt || null,   // 一人前になった日
    leftAt: b.leftAt || null,
    status: 'active',
    demo: false,
  };
  return ok(publicUser(store.insert('users', rec)), 201);
}, { roles: ['admin'] });

route('PATCH', '/api/users/:id', (ctx, p) => {
  const u = store.get('users', p.id);
  if (!u) throw fail(404, 'その人がいません');
  const allowed = ['name', 'role', 'arm', 'teamId', 'licensed', 'region', 'startedAt', 'readyAt', 'leftAt', 'status'];
  const patch = {};
  for (const [k, v] of Object.entries(ctx.body || {})) {
    if (!allowed.includes(k)) throw fail(400, `変えられない項目です: ${k}`);
    patch[k] = v;
  }
  if (patch.role && !auth.ROLES.includes(patch.role)) throw fail(400, `知らないロール: ${patch.role}`);
  return ok(publicUser(store.update('users', p.id, patch)));
}, { roles: ['admin'] });

route('POST', '/api/users/:id/passcode', (ctx, p) => {
  const u = store.get('users', p.id);
  if (!u) throw fail(404, 'その人がいません');
  const b = ctx.body || {};
  if (!b.passcode || String(b.passcode).length < 8) throw fail(400, '合言葉は8文字以上にしてください');
  store.update('users', p.id, auth.hashPasscode(b.passcode));
  store.insert('auditLog', { id: id('au'), at: new Date().toISOString(), actor: ctx.userId, action: 'passcode.set', target: p.id });
  return ok({ ok: true, note: '本人に口頭で伝え、初回ログイン後に本人が変更してください。' });
}, { roles: ['admin'] });

route('GET', '/api/teams', (ctx) => ok(visibleTeams(ctx).map((t) => ({
  ...t,
  members: t.memberIds.map((mid) => publicUser(store.get('users', mid))).filter(Boolean),
  size_ok: t.memberIds.length >= 4 && t.memberIds.length <= 8,
}))), { roles: ['admin', 'mentor', 'facilitator', 'staff'] });

route('GET', '/api/classes', (ctx) => {
  let cs = store.all('classes');
  if (ctx.user.role === 'facilitator') cs = cs.filter((c) => c.facilitatorId === ctx.user.id);
  else if (ctx.user.role === 'mentor') cs = cs.filter((c) => auth.canSeeFacilitator(ctx.user, c.facilitatorId));
  return ok(cs.map((c) => ({
    ...c,
    facilitator: publicUser(store.get('users', c.facilitatorId)),
    students: c.studentIds.map((sid, i) => {
      const st = store.get('students', sid);
      return st ? { ...st, name: childLabel(ctx, st, i), consent_ok: consentOk(st) } : null;
    }).filter(Boolean),
    over_capacity: c.studentIds.length > (c.capacity || 8),
  })));
}, { roles: ['admin', 'mentor', 'facilitator', 'staff'] });

route('POST', '/api/classes', (ctx) => {
  const b = ctx.body || {};
  if (!b.name || !b.facilitatorId) throw fail(400, 'name と facilitatorId は必須です');
  const f = store.get('users', b.facilitatorId);
  if (!f) throw fail(400, 'その先生がいません');
  const rec = {
    id: id('cl'), name: b.name, facilitatorId: b.facilitatorId, teamId: f.teamId || null,
    arm: b.arm || f.arm || null, capacity: b.capacity || 8, studentIds: [],
    schedule: b.schedule || '', demo: false, createdAt: new Date().toISOString(),
  };
  return ok(store.insert('classes', rec), 201);
}, { roles: ['admin', 'mentor'] });

// 保護者の同意を記録する。同意のない子どもの発話は保存しない（下の取り込みで弾く）。
route('POST', '/api/students/:id/consent', (ctx, p) => {
  const st = store.get('students', p.id);
  if (!st) throw fail(404, 'その子どもがいません');
  const b = ctx.body || {};
  if (!b.obtainedAt) throw fail(400, '同意を得た日（obtainedAt）は必須です');
  if (!b.by) throw fail(400, '誰から得たか（by。保護者の氏名や続柄）は必須です');
  const rec = store.update('students', p.id, {
    consent: {
      obtainedAt: b.obtainedAt,
      by: b.by,
      method: b.method || '書面',
      note: b.note || '',
      recordedBy: ctx.userId,
      recordedAt: new Date().toISOString(),
    },
  });
  store.insert('auditLog', { id: id('au'), at: new Date().toISOString(), actor: ctx.userId, action: 'consent.record', target: p.id });
  return ok(rec);
}, { roles: ['admin', 'mentor'] });

// 同意の撤回。撤回したら、その子の発話はもう入れられない。
// すでに入っている分は scripts/purge.js --student <id> で消す。
route('POST', '/api/students/:id/consent/withdraw', (ctx, p) => {
  const st = store.get('students', p.id);
  if (!st) throw fail(404, 'その子どもがいません');
  const rec = store.update('students', p.id, {
    consent: { ...(st.consent || {}), withdrawnAt: new Date().toISOString(), withdrawnBy: ctx.userId },
  });
  store.insert('auditLog', { id: id('au'), at: new Date().toISOString(), actor: ctx.userId, action: 'consent.withdraw', target: p.id });
  return ok({
    student: rec,
    note: 'これ以降、この子の発話は取り込めません。すでに入っている分を消すには '
      + 'node scripts/purge.js --student ' + p.id + ' を実行してください。',
  });
}, { roles: ['admin', 'mentor'] });

route('PATCH', '/api/students/:id', (ctx, p) => {
  const st = store.get('students', p.id);
  if (!st) throw fail(404, 'その子どもがいません');
  const b = ctx.body || {};
  const patch = {};
  if (b.status !== undefined) {
    if (!['active', 'left'].includes(b.status)) throw fail(400, 'status は active か left です');
    patch.status = b.status;
    patch.leftAt = b.status === 'left' ? (b.leftAt || isoDate(Date.now())) : null;
  }
  if (b.name !== undefined) patch.name = b.name;
  return ok(store.update('students', p.id, patch));
}, { roles: ['admin', 'mentor'] });

function consentOk(student) {
  if (!setting('require_consent')) return true;
  if (!student) return false;
  const c = student.consent;
  return !!(c && c.obtainedAt && !c.withdrawnAt);
}

route('POST', '/api/classes/:id/students', (ctx, p) => {
  const c = store.get('classes', p.id);
  if (!c) throw fail(404, 'そのクラスがありません');
  const b = ctx.body || {};
  if (!b.name) throw fail(400, 'name は必須です');
  if (c.studentIds.length >= (c.capacity || 8)) {
    throw fail(400, `定員（${c.capacity || 8}人）を超えます。子どもを押し出さないのが方針です。`);
  }
  const st = store.insert('students', {
    id: id('st'), name: b.name, arm: c.arm, classId: c.id,
    joinedAt: b.joinedAt || isoDate(Date.now()), status: 'active', demo: false,
  });
  store.update('classes', c.id, { studentIds: [...c.studentIds, st.id] });
  return ok(st, 201);
}, { roles: ['admin', 'mentor'] });

route('GET', '/api/students', (ctx) => {
  let ss = store.all('students');
  if (ctx.query.arm) ss = ss.filter((s) => s.arm === ctx.query.arm);
  if (ctx.query.classId) ss = ss.filter((s) => s.classId === ctx.query.classId);
  return ok(ss.map((s, i) => ({ ...s, name: childLabel(ctx, s, i) })));
}, { roles: ['admin', 'mentor', 'facilitator', 'staff'] });

// ===== 授業 =====
route('GET', '/api/lessons', (ctx) => {
  // 先生の順位づけは仕様として禁止。ソート指定は受け付けない。
  if (ctx.query.sort) {
    throw fail(403, '授業スコアでの並べ替えは、この製品では提供しません。比較対象は本人の過去だけです（事業計画「やらないと決めていること」）。', 'RANKING_FORBIDDEN');
  }
  if (ctx.user.role === 'rater') {
    throw fail(403, '評定者は授業一覧を見られません。盲検の採点キュー（/api/blind/queue）を使ってください。', 'FORBIDDEN');
  }
  let ls = scopeLessons(ctx, store.all('lessons'));
  if (ctx.query.arm) ls = ls.filter((l) => l.arm === ctx.query.arm);
  if (ctx.query.facilitatorId) ls = ls.filter((l) => l.facilitatorId === ctx.query.facilitatorId);
  if (ctx.query.from) ls = ls.filter((l) => l.date >= ctx.query.from);
  if (ctx.query.to) ls = ls.filter((l) => l.date <= ctx.query.to);
  const scores = store.all('scores').filter((s) => s.source === 'ai');
  return ok(ls
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, Number(ctx.query.limit || 200))
    .map((l) => {
      const sc = scores.find((s) => s.lessonId === l.id);
      return {
        ...l,
        facilitator: (store.get('users', l.facilitatorId) || {}).name || null,
        className: (store.get('classes', l.classId) || {}).name || null,
        scored: !!sc,
        overall: sc ? sc.overall : null,
        dims: sc ? Object.fromEntries(Object.entries(sc.dims).map(([k, v]) => [k, v.level])) : null,
      };
    }));
});

route('GET', '/api/lessons/:id', (ctx, p) => {
  const l = store.get('lessons', p.id);
  if (!l) throw fail(404, '授業がありません');
  if (ctx.user.role === 'rater') {
    throw fail(403, '評定者は授業の詳細を見られません（AIスコアと先生の名前が見えてしまうため）。盲検の採点キューを使ってください。', 'FORBIDDEN');
  }
  assertCanSeeFacilitator(ctx, l.facilitatorId);
  const utterances = store.all('utterances').filter((u) => u.lessonId === l.id).sort((a, b) => a.t - b.t);
  const scores = store.all('scores').filter((s) => s.lessonId === l.id);
  const ratings = store.all('ratings').filter((r) => r.lessonId === l.id);
  const fb = store.all('feedbacks').filter((f) => f.lessonId === l.id);
  const klass = store.get('classes', l.classId);
  logView(ctx, 'lesson.transcript.view', l.id);
  const roster = klass ? klass.studentIds : [];
  const label = {};
  roster.forEach((sid, i) => { label[sid] = childLabel(ctx, store.get('students', sid), i); });
  return ok({
    lesson: l,
    facilitator: publicUser(store.get('users', l.facilitatorId)),
    class: klass,
    students: roster.map((sid, i) => {
      const st = store.get('students', sid);
      return st ? { ...st, name: childLabel(ctx, st, i) } : null;
    }).filter(Boolean),
    speakerLabels: label,
    utterances,
    scores,
    ratings,
    feedbacks: fb,
  });
});

route('POST', '/api/lessons', (ctx) => {
  const b = ctx.body || {};
  if (!b.classId || !b.date) throw fail(400, 'classId と date は必須です');
  const klass = store.get('classes', b.classId);
  if (!klass) throw fail(400, 'そのクラスがありません');
  const rec = {
    id: id('ls'),
    classId: b.classId,
    facilitatorId: b.facilitatorId || klass.facilitatorId,
    arm: b.arm || klass.arm || null,
    date: b.date,
    durationMin: b.durationMin || 45,
    attendance: b.attendance || klass.studentIds.length,
    note: b.note || '',
    demo: false,
    createdAt: new Date().toISOString(),
  };
  store.insert('lessons', rec);
  if (Array.isArray(b.utterances) && b.utterances.length) {
    const us = b.utterances.map((u, i) => ({
      id: id('ut'), lessonId: rec.id, seq: i, t: Number(u.t) || 0, speaker: u.speaker, text: String(u.text || ''),
    }));
    store.insertMany('utterances', us);
  }
  return ok(rec, 201);
}, { roles: ['admin', 'mentor', 'facilitator'] });

route('POST', '/api/lessons/:id/score', (ctx, p) => {
  const l = store.get('lessons', p.id);
  if (!l) throw fail(404, '授業がありません');
  assertCanSeeFacilitator(ctx, l.facilitatorId);
  const sc = runScoring(l);
  let fb = null;
  try {
    fb = makeFeedback(sc);
  } catch (e) {
    if (e.code !== 'PERSONALITY_TERM') throw e;
    throw fail(422, e.message, e.code);
  }
  return ok({ score: sc, feedback: fb }, 201);
});

// 人間評定者による盲検採点。AIスコアも先生の名前も見せない前提の入力。
route('POST', '/api/lessons/:id/ratings', (ctx, p) => {
  const l = store.get('lessons', p.id);
  if (!l) throw fail(404, '授業がありません');
  const b = ctx.body || {};
  if (!b.raterId || !b.dims) throw fail(400, 'raterId と dims は必須です');
  const rubric = loadRubric();
  for (const [code, v] of Object.entries(b.dims)) {
    if (!rubric.dimensions.find((d) => d.code === code)) throw fail(400, `知らない観点: ${code}`);
    if (!Number.isInteger(v) || v < 0 || v > 4) throw fail(400, `${code} は 0〜4 の整数で入れてください`);
  }
  // 評定者は自分の名前でしか入れられない（他人の採点を書き換えられないように）
  if (ctx.user.role === 'rater' && b.raterId !== ctx.user.id) {
    throw fail(403, '自分以外の評定者として保存することはできません。', 'FORBIDDEN');
  }
  store.remove('ratings', (r) => r.lessonId === l.id && r.raterId === b.raterId);
  const rec = {
    id: id('rt'),
    lessonId: l.id,
    raterId: b.raterId,
    blind: b.blind !== false,
    windowMinutes: b.windowMinutes || loadRubric().window.minutes,
    dims: b.dims,
    note: b.note || '',
    createdAt: new Date().toISOString(),
  };
  return ok(store.insert('ratings', rec), 201);
}, { roles: ['admin', 'rater'] });

// ===== ファシリテーター（本人の過去とだけ比べる） =====
route('GET', '/api/facilitators/:id/trend', (ctx, p) => {
  const u = store.get('users', p.id);
  if (!u) throw fail(404, 'その人がいません');
  assertCanSeeFacilitator(ctx, p.id);
  const scores = store.all('scores')
    .filter((s) => s.source === 'ai' && s.facilitatorId === p.id)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const series = scores.map((s) => ({
    lessonId: s.lessonId,
    date: s.date,
    modelVersionId: s.modelVersionId,
    overall: s.overall,
    dims: Object.fromEntries(Object.entries(s.dims).map(([k, v]) => [k, v.level])),
  }));
  const first3 = series.slice(0, 3).map((s) => s.overall);
  const last3 = series.slice(-3).map((s) => s.overall);
  const fbs = store.all('feedbacks').filter((f) => f.facilitatorId === p.id).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return ok({
    facilitator: publicUser(u),
    series,
    comparison: {
      basis: '本人の過去のみ。他のファシリテーターとは比較しません。',
      first3_mean: round(mean(first3), 2),
      last3_mean: round(mean(last3), 2),
      change: first3.length && last3.length ? round(mean(last3) - mean(first3), 2) : null,
    },
    days_since_start: u.startedAt ? daysBetween(u.startedAt, isoDate(Date.now())) : null,
    ready: !!u.readyAt,
    days_to_ready: u.readyAt && u.startedAt ? daysBetween(u.startedAt, u.readyAt) : null,
    feedbacks: fbs.slice(0, 20),
    warning: series.some((s) => s.modelVersionId !== (series[0] || {}).modelVersionId)
      ? '⚠️ この折れ線には複数のモデル版が混ざっています。版をまたいだ比較はできません。再スコアしてください。'
      : null,
  });
});

// 養成ファネル（採用率 2% → 15% を追う）
route('GET', '/api/funnel', () => {
  const fs2 = store.all('users').filter((u) => u.role === 'facilitator');
  const byArm = {};
  for (const u of fs2) {
    const arm = u.arm || '-';
    if (!byArm[arm]) byArm[arm] = { started: 0, ready: 0, left: 0, days: [] };
    byArm[arm].started += 1;
    if (u.readyAt) { byArm[arm].ready += 1; byArm[arm].days.push(daysBetween(u.startedAt, u.readyAt)); }
    if (u.leftAt) byArm[arm].left += 1;
  }
  const out = {};
  for (const [arm, v] of Object.entries(byArm)) {
    const ninety = fs2.filter((u) => u.arm === (arm === '-' ? null : arm) && u.readyAt
      && daysBetween(u.readyAt, isoDate(Date.now())) >= 90);
    out[arm] = {
      started: v.started,
      ready: v.ready,
      ready_rate: v.started ? round(v.ready / v.started, 3) : null,
      median_days_to_ready: v.days.length ? v.days.sort((a, b) => a - b)[Math.floor(v.days.length / 2)] : null,
      retention_90d: ninety.length ? round(ninety.filter((u) => !u.leftAt).length / ninety.length, 3) : null,
      retention_90d_n: ninety.length,
    };
  }
  return ok({
    arms: out,
    note: '一人前到達率と90日継続率。どちらも記録が貯まるまでは未測定です。',
  });
}, { roles: ['admin', 'mentor', 'staff'] });

// ===== モデル版 =====
route('GET', '/api/model-versions', () => {
  const list = store.all('modelVersions');
  const draft = draftModelVersion();
  const cur = currentModelVersion();
  return ok({
    versions: list,
    current: cur,
    draft,
    drift: cur ? cur.fingerprint !== draft.fingerprint : true,
    drift_note: cur && cur.fingerprint !== draft.fingerprint
      ? '⚠️ 凍結後に rubric かプロンプトが変わっています。いまのスコアは凍結版と同じではありません。凍結し直して再スコアしてください。'
      : null,
  });
}, { roles: ['admin', 'mentor', 'staff'] });

route('POST', '/api/model-versions/freeze', (ctx) => {
  const b = ctx.body || {};
  const fp = computeFingerprint(b.llm || 'local-heuristic');
  const existing = store.all('modelVersions').find((m) => m.fingerprint === fp.fingerprint);
  if (existing) return ok({ ...existing, note: '同じ内容の版がすでにあります' });
  const rec = {
    id: id('mv'),
    label: b.label || `v${store.all('modelVersions').length + 1}`,
    notes: b.notes || '',
    frozen: true,
    frozenAt: new Date().toISOString(),
    frozenBy: ctx.userId || null,
    ...fp,
  };
  return ok(store.insert('modelVersions', rec), 201);
}, { roles: ['admin'] });

// 1,000授業を凍結版で再スコアする（9月の作業）
route('POST', '/api/rescore', (ctx) => {
  const mv = ctx.body.modelVersionId ? store.get('modelVersions', ctx.body.modelVersionId) : currentModelVersion();
  if (!mv) throw fail(400, '凍結されたモデル版がありません。先に凍結してください。');
  const lessonIds = ctx.body.lessonIds;
  const lessons = store.all('lessons').filter((l) => !lessonIds || lessonIds.includes(l.id));
  let done = 0;
  let skipped = 0;
  for (const l of lessons) {
    try { runScoring(l, { modelVersion: mv }); done += 1; } catch { skipped += 1; }
  }
  store.flush();
  return ok({ modelVersion: mv, rescored: done, skipped, note: '書き起こしのない授業は飛ばしました。' });
}, { roles: ['admin'] });

// ===== IRR =====
route('GET', '/api/irr', () => {
  const ratings = store.all('ratings');
  const pairs = buildHumanPairs(ratings);
  const human = pairs.length ? irrLib.report(pairs) : null;

  // AI と人間の一致（参考値。IRRの目標判定には使わない）
  const aiPairs = [];
  for (const r of ratings) {
    const sc = store.all('scores').find((s) => s.lessonId === r.lessonId && s.source === 'ai');
    if (!sc) continue;
    for (const [code, v] of Object.entries(r.dims || {})) {
      if (sc.dims[code]) aiPairs.push({ lessonId: r.lessonId, dim: code, a: sc.dims[code].level, b: v });
    }
  }
  const ai = aiPairs.length ? irrLib.report(aiPairs) : null;

  const raters = [...new Set(ratings.map((r) => r.raterId))];
  const doubleCoded = Object.entries(
    ratings.reduce((acc, r) => { acc[r.lessonId] = (acc[r.lessonId] || 0) + 1; return acc; }, {}),
  ).filter(([, n]) => n >= 2).length;

  return ok({
    human_vs_human: human,
    ai_vs_human: ai,
    raters: raters.length,
    lessons_rated: new Set(ratings.map((r) => r.lessonId)).size,
    lessons_double_coded: doubleCoded,
    target: 0.65,
    deadline: '2026-10-20',
    evidence_id: 'met_two_raters',
    note: '判定に使うのは human_vs_human です。ai_vs_human は参考値であって、器具の信頼性ではありません。',
  });
}, { roles: ['admin', 'mentor', 'staff'] });

// 器具そのものの健全性。ルーブリックが「効いているか」を見る。
// 因子分析の代わりの、いちばん安い版：分布・天井床・観点どうしの相関。
route('GET', '/api/analysis/instrument', () => {
  const scores = store.all('scores').filter((s) => s.source === 'ai');
  const rubric = loadRubric();
  const codes = rubric.dimensions.map((d) => d.code);
  const raterOf = Object.fromEntries(rubric.dimensions.map((d) => [d.code, d.rater || 'ai']));
  const byCode = {};
  for (const c of codes) byCode[c] = scores.map((s) => (s.dims[c] ? s.dims[c].level : null)).filter((x) => x !== null);

  const sdOf = (v) => {
    if (v.length < 2) return null;
    const m = mean(v);
    return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1));
  };
  const corr = (x, y) => {
    const n = Math.min(x.length, y.length);
    if (n < 3) return null;
    const mx = mean(x.slice(0, n));
    const my = mean(y.slice(0, n));
    let num = 0; let dx = 0; let dy = 0;
    for (let i = 0; i < n; i += 1) {
      num += (x[i] - mx) * (y[i] - my);
      dx += (x[i] - mx) ** 2;
      dy += (y[i] - my) ** 2;
    }
    return dx && dy ? round(num / Math.sqrt(dx * dy), 3) : null;
  };

  const dims = {};
  for (const c of codes) {
    const v = byCode[c];
    const dist = [0, 1, 2, 3, 4].map((lv) => v.filter((x) => x === lv).length);
    const ceiling = v.length ? dist[4] / v.length : 0;
    const floor = v.length ? dist[0] / v.length : 0;
    const flags = [];
    if (ceiling >= 0.6) flags.push('天井効果（6割以上が満点）。この観点は差を見分けられていません。');
    if (floor >= 0.6) flags.push('床効果（6割以上が0）。基準が厳しすぎるか、指標の正規化が合っていません。');
    const s = sdOf(v);
    if (s !== null && s < 0.4) flags.push('ばらつきがほぼありません。観点として機能していません。');
    if (flags.length && raterOf[c] === 'human') {
      flags.push('※ この観点は人間評定が主です。ここに出ているのはAIの補助値なので、張りついていること自体は想定内です。人間の採点で見てください。');
    }
    dims[c] = { n: v.length, mean: round(mean(v), 2), sd: round(s, 2), rater: raterOf[c], distribution: dist, ceiling: round(ceiling, 2), floor: round(floor, 2), flags };
  }

  const correlations = {};
  for (const a of codes) {
    for (const b of codes) {
      if (a >= b) continue;
      const r = corr(byCode[a], byCode[b]);
      correlations[`${a}-${b}`] = r;
      if (r !== null && r >= 0.85) {
        dims[a].flags.push(`${b} とほぼ同じものを測っています（r=${r}）。どちらかは要らないかもしれません。`);
      }
    }
  }

  const issues = Object.entries(dims)
    .filter(([, v]) => v.flags.length && v.rater !== 'human')
    .map(([k, v]) => ({ code: k, flags: v.flags }));
  return ok({
    dims,
    correlations,
    issues,
    healthy: issues.length === 0,
    evidence_id: 'unverified_rubric',
    note: 'これは因子分析ではありません。1,000授業がたまったら、ちゃんとした因子分析と、CLASS/PLATO/MQI とのクロスウォークをやること。',
  });
}, { roles: ['admin', 'mentor', 'staff'] });

// ===== 子どものアンケート =====
route('GET', '/api/surveys', (ctx) => {
  const cycles = {};
  for (const r of store.all('surveyResponses')) {
    const key = `${r.facilitatorId}|${r.cycle}`;
    if (!cycles[key]) cycles[key] = { facilitatorId: r.facilitatorId, cycle: r.cycle, arm: r.arm, responses: [] };
    cycles[key].responses.push(r);
  }
  const meta = store.all('settings').find((s) => s.key === 'survey_cycles');
  const cycleMeta = (meta && meta.value) || {};
  const rows = Object.values(cycles)
    .filter((c) => auth.canSeeFacilitator(ctx.user, c.facilitatorId))
    .filter((c) => !ctx.query.facilitatorId || c.facilitatorId === ctx.query.facilitatorId)
    .sort((a, b) => (a.cycle < b.cycle ? 1 : -1))
    .map((c) => {
      const agg = surveyLib.aggregate(c.responses);
      const prevSet = Object.values(cycles).filter((x) => x.facilitatorId === c.facilitatorId && x.cycle < c.cycle)
        .sort((a, b) => (a.cycle < b.cycle ? 1 : -1))[0];
      const prev = prevSet ? surveyLib.aggregate(prevSet.responses) : null;
      const key = `${c.facilitatorId}|${c.cycle}`;
      return {
        facilitatorId: c.facilitatorId,
        facilitator: (store.get('users', c.facilitatorId) || {}).name || null,
        arm: c.arm,
        cycle: c.cycle,
        aggregate: surveyLib.withDelta(agg, prev),
        design: surveyLib.designCompliance(cycleMeta[key] || {}),
      };
    });
  return ok({ cycles: rows, spec: readSpec('survey.ja.json') });
}, { roles: ['admin', 'mentor', 'facilitator'] });

route('POST', '/api/surveys/responses', (ctx) => {
  const b = ctx.body || {};
  if (!b.facilitatorId || !b.cycle || !b.answers) throw fail(400, 'facilitatorId, cycle, answers は必須です');
  const spec = readSpec('survey.ja.json');
  for (const [code, v] of Object.entries(b.answers)) {
    if (!spec.items.find((i) => i.code === code)) throw fail(400, `知らない項目: ${code}`);
    if (!Number.isInteger(v) || v < 1 || v > 5) throw fail(400, `${code} は 1〜5（頻度尺度）で入れてください`);
  }
  if (b.studentId) {
    throw fail(400, '回答に子どものIDは保存しません。誰が何と答えたかを、こちら側で分からなくするためです。');
  }
  const rec = {
    id: id('sr'),
    facilitatorId: b.facilitatorId,
    classId: b.classId || null,
    studentId: null,
    arm: b.arm || null,
    cycle: b.cycle,
    answers: b.answers,
    createdAt: new Date().toISOString(),
  };
  return ok(store.insert('surveyResponses', rec), 201);
}, { roles: ['admin', 'mentor'] });

// 返し方の3手順を記録する。ここを記録しないと、効果は d=0.050 側になる。
route('POST', '/api/surveys/steps', (ctx) => {
  const b = ctx.body || {};
  if (!b.facilitatorId || !b.cycle || !b.step) throw fail(400, 'facilitatorId, cycle, step は必須です');
  const allowed = ['returned_at', 'action_declared_at', 'discussed_with_students_at'];
  if (!allowed.includes(b.step)) throw fail(400, `step は ${allowed.join(' / ')} のどれかです`);
  // ここは効果量の根幹（設計あり 0.568 ／ なし 0.050）を判定する記録なので、他人の分は触らせない
  assertCanSeeFacilitator(ctx, b.facilitatorId);
  const cur = store.setting('survey_cycles', {});
  const key = `${b.facilitatorId}|${b.cycle}`;
  const entry = { ...(cur[key] || {}) };
  entry[b.step] = b.at || new Date().toISOString();
  if (b.step === 'action_declared_at' && b.action) entry.action = b.action;
  const next = { ...cur, [key]: entry };
  store.setSetting('survey_cycles', next);
  return ok({ key, entry, design: surveyLib.designCompliance(entry) });
}, { roles: ['admin', 'mentor', 'facilitator'] });

// ===== アンケートの配布リンク =====
// 子どもはログインしません。クラス×サイクルごとに、当てにくいリンクを1本発行します。
// 回答に子どものIDは残しません（誰が何と答えたかを、こちら側で分からなくするため）。
route('GET', '/api/surveys/cycles', (ctx) => {
  let cs = store.all('surveyCycles');
  if (ctx.user.role === 'facilitator') cs = cs.filter((c) => c.facilitatorId === ctx.user.id);
  else if (ctx.user.role === 'mentor') cs = cs.filter((c) => auth.canSeeFacilitator(ctx.user, c.facilitatorId));
  return ok(cs.map((c) => ({
    ...c,
    className: (store.get('classes', c.classId) || {}).name || null,
    responses: store.all('surveyResponses').filter((r) => r.cycleId === c.id).length,
    url: `/survey.html?t=${c.token}`,
  })));
}, { roles: ['admin', 'mentor', 'facilitator'] });

route('POST', '/api/surveys/cycles', (ctx) => {
  const b = ctx.body || {};
  const klass = store.get('classes', b.classId);
  if (!klass) throw fail(400, 'そのクラスがありません');
  if (!b.cycle) throw fail(400, 'cycle（例：2026-C1）は必須です');
  const exists = store.all('surveyCycles').find((c) => c.classId === b.classId && c.cycle === b.cycle);
  if (exists) return ok({ ...exists, url: `/survey.html?t=${exists.token}`, note: 'すでにあるリンクを返しました' });
  const rec = {
    id: id('sy'),
    classId: klass.id,
    facilitatorId: klass.facilitatorId,
    arm: klass.arm,
    cycle: b.cycle,
    token: crypto.randomBytes(12).toString('base64url'),
    open: true,
    createdAt: new Date().toISOString(),
    createdBy: ctx.userId,
  };
  store.insert('surveyCycles', rec);
  return ok({ ...rec, url: `/survey.html?t=${rec.token}` }, 201);
}, { roles: ['admin', 'mentor'] });

route('POST', '/api/surveys/cycles/:id/close', (ctx, p) => {
  const c = store.get('surveyCycles', p.id);
  if (!c) throw fail(404, 'ありません');
  return ok(store.update('surveyCycles', p.id, { open: false }));
}, { roles: ['admin', 'mentor'] });

// ---- ここから下は、子どもが開くページ用（ログインなし） ----
route('GET', '/api/survey/:token', (ctx, p) => {
  const c = store.all('surveyCycles').find((x) => x.token === p.token);
  if (!c) throw fail(404, 'このリンクは使えません。先生に聞いてください。');
  const spec = readSpec('survey.ja.json');
  return ok({
    open: !!c.open,
    cycle: c.cycle,
    className: (store.get('classes', c.classId) || {}).name || '',
    scale: spec.scale,
    items: spec.items.map((i) => ({ code: i.code, text: i.text })),
    note: 'なまえは かきません。せんせいには、みんなの こたえを まとめた かたちでしか つたわりません。',
  });
}, { public: true });

route('POST', '/api/survey/:token', (ctx, p) => {
  const c = store.all('surveyCycles').find((x) => x.token === p.token);
  if (!c) throw fail(404, 'このリンクは使えません。');
  if (!c.open) throw fail(400, 'この アンケートは しめきりました。');
  const spec = readSpec('survey.ja.json');
  const answers = (ctx.body || {}).answers || {};
  const codes = spec.items.map((i) => i.code);
  for (const [code, v] of Object.entries(answers)) {
    if (!codes.includes(code)) throw fail(400, `知らない項目: ${code}`);
    if (!Number.isInteger(v) || v < 1 || v > 5) throw fail(400, `${code} は 1〜5 で えらんでください`);
  }
  // 部分回答を混ぜない（欠けたまま平均に入ると、観点の比較ができなくなる）
  const missing = codes.filter((c2) => answers[c2] === undefined);
  if (missing.length) throw fail(400, `まだ ${missing.length}こ のこっています。`);
  // 連投・転送の歯止め。匿名なので、入ったあとに取り除く手段がない。
  const klass = store.get('classes', c.classId);
  const cap = ((klass && klass.studentIds.length) || 8) + 4;
  const soFar = store.all('surveyResponses').filter((r) => r.cycleId === c.id).length;
  if (soFar >= cap) {
    throw fail(429, 'この アンケートは、もう じゅうぶん あつまりました。ありがとう。', 'SURVEY_FULL');
  }
  store.insert('surveyResponses', {
    id: id('sr'),
    facilitatorId: c.facilitatorId,
    classId: c.classId,
    cycleId: c.id,
    // 誰が答えたかは残さない。これは仕様であって、手抜きではない。
    studentId: null,
    arm: c.arm,
    cycle: c.cycle,
    answers,
    createdAt: new Date().toISOString(),
  });
  return ok({ ok: true, message: 'こたえてくれて ありがとう。' }, 201);
}, { public: true });

// ===== メンターの記録（毎日1行） =====
route('GET', '/api/mentor-load', () => {
  const logs = store.all('mentorLogs');
  const opts = { mentorFteHoursPerWeek: setting('mentor_fte_hours_week') };
  return ok({
    summary: mentorLoadLib.summary(logs, opts),
    weekly: mentorLoadLib.weekly(logs, opts),
    entries: logs.length,
    evidence_id: 'mentor_load',
  });
}, { roles: ['admin', 'mentor', 'staff'] });

route('POST', '/api/mentor-logs', (ctx) => {
  const b = ctx.body || {};
  if (!b.mentorId || !b.facilitatorId || !b.date) throw fail(400, 'mentorId, facilitatorId, date は必須です');
  if (!b.minutes || b.minutes <= 0) throw fail(400, 'minutes（実際にかけた分数）は必須です。ここが空だと単価が出ません。');
  const rec = {
    id: id('ml'),
    mentorId: b.mentorId,
    facilitatorId: b.facilitatorId,
    arm: b.arm || (store.get('users', b.facilitatorId) || {}).arm || null,
    date: b.date,
    week: weekKey(b.date),
    minutes: Number(b.minutes),
    kind: b.kind || 'other',
    note: b.note || '',
    createdAt: new Date().toISOString(),
  };
  return ok(store.insert('mentorLogs', rec), 201);
}, { roles: ['admin', 'mentor'] });

// ===== 費用 =====
route('GET', '/api/cost', () => {
  const items = store.all('costItems');
  const users = store.all('users').filter((u) => u.role === 'facilitator');
  const trained = {};
  for (const u of users) {
    if (!u.readyAt) continue;
    const arm = u.arm || 'A';
    trained[arm] = (trained[arm] || 0) + 1;
  }
  const wages = {
    wage_minimum: setting('wage_minimum'),
    wage_equivalent: setting('wage_equivalent'),
    mentor_hourly: setting('mentor_hourly'),
    staff_hourly: setting('staff_hourly'),
  };
  return ok({ ...costLib.report(items, { wages, facilitatorsTrained: trained }), items, trained, evidence_id: 'cost_per_facilitator' });
}, { roles: ['admin', 'mentor', 'staff'] });

route('POST', '/api/cost-items', (ctx) => {
  const b = ctx.body || {};
  if (!b.label || !b.category) throw fail(400, 'label と category は必須です');
  const rec = {
    id: id('ci'),
    label: b.label,
    category: b.category,
    actor: b.actor || 'staff',
    arm: b.arm || null,
    hours: Number(b.hours || 0),
    jpy: Number(b.jpy || 0),
    qty: Number(b.qty === undefined ? 1 : b.qty),
    note: b.note || '',
  };
  return ok(store.insert('costItems', rec), 201);
}, { roles: ['admin', 'staff'] });

route('DELETE', '/api/cost-items/:id', (ctx, p) => {
  const n = store.remove('costItems', (c) => c.id === p.id);
  if (!n) throw fail(404, 'ありません');
  return ok({ deleted: n });
}, { roles: ['admin', 'staff'] });

// ===== セーフガーディング =====
route('GET', '/api/incidents', () => ok(store.all('incidents')),
  { allowWhenHalted: true, roles: ['admin', 'mentor'] });
// 事案の記録（POST）は、どのロールでもできる。止める判断を、権限で遅らせないため。
// 一方で、事案の中身（GET）は対応する人だけが見る。

route('POST', '/api/incidents', (ctx) => {
  const b = ctx.body || {};
  if (!b.summary) throw fail(400, 'summary は必須です');
  const rec = {
    id: id('inc'),
    date: b.date || isoDate(Date.now()),
    summary: b.summary,
    severity: b.severity || 'high',
    reportedBy: ctx.userId || b.reportedBy || null,
    status: 'open',
    publishedAt: null,
    closedAt: null,
    createdAt: new Date().toISOString(),
  };
  store.insert('incidents', rec);
  store.insert('auditLog', { id: id('au'), at: new Date().toISOString(), actor: ctx.userId, action: 'incident.open', target: rec.id });
  return ok({ incident: rec, effect: '全機能を停止しました。対応と公表が終わるまで再開しません。' }, 201);
}, { allowWhenHalted: true });

route('POST', '/api/incidents/:id/close', (ctx, p) => {
  const inc = store.get('incidents', p.id);
  if (!inc) throw fail(404, 'ありません');
  const b = ctx.body || {};
  if (!b.publishedAt) throw fail(400, '公表日（publishedAt）なしにはクローズできません。公表が条件です。');
  if (!b.resolution) throw fail(400, 'resolution（何をしたか）は必須です');
  store.update('incidents', p.id, { status: 'closed', closedAt: new Date().toISOString(), publishedAt: b.publishedAt, resolution: b.resolution });
  store.insert('auditLog', { id: id('au'), at: new Date().toISOString(), actor: ctx.userId, action: 'incident.close', target: p.id });
  return ok(store.get('incidents', p.id));
}, { allowWhenHalted: true, roles: ['admin'] });

// ===== アーカイブ（問いつき視聴） =====
route('GET', '/api/clips', (ctx) => {
  // 授業レコードを素で返さない。lessonId から先生やアームに辿れると、盲検が意味を失う。
  const visible = new Set(scopeLessons(ctx, store.all('lessons')).map((l) => l.id));
  return ok(store.all('clips')
    .filter((c) => visible.has(c.lessonId))
    .map((c) => ({
      id: c.id,
      lessonId: c.lessonId,
      tStart: c.tStart,
      tEnd: c.tEnd,
      dimension: c.dimension,
      title: c.title,
      prompt: c.prompt,
      createdAt: c.createdAt,
      views: (c.views || []).length,
      viewed_by_me: (c.views || []).some((v) => v.userId === ctx.userId),
      date: (store.get('lessons', c.lessonId) || {}).date || null,
    })));
}, { roles: ['admin', 'mentor', 'facilitator'] });

route('POST', '/api/clips', (ctx) => {
  const b = ctx.body || {};
  if (!b.lessonId || b.tStart === undefined) throw fail(400, 'lessonId と tStart は必須です');
  if (!b.prompt) {
    throw fail(400, '視聴の問い（prompt）は必須です。問いなしの視聴は、効果が確認されていません（レビューでは77%が構造化視聴ガイドを使用）。');
  }
  const rec = {
    id: id('cl'),
    lessonId: b.lessonId,
    tStart: Number(b.tStart),
    tEnd: Number(b.tEnd || Number(b.tStart) + 30),
    dimension: b.dimension || null,
    title: b.title || '',
    prompt: b.prompt,
    createdAt: new Date().toISOString(),
    views: [],
  };
  return ok(store.insert('clips', rec), 201);
}, { roles: ['admin', 'mentor', 'facilitator'] });

route('POST', '/api/clips/:id/view', (ctx, p) => {
  const c = store.get('clips', p.id);
  if (!c) throw fail(404, 'ありません');
  const b = ctx.body || {};
  if (!b.answer) throw fail(400, '問いへの答え（answer）なしでは視聴を記録しません。自由視聴は効果が未検証です。');
  // 誰が見たかは、名乗りではなくセッションから決める。
  // ここを body 任せにすると、アーカイブの効果分析（教師固定効果）の割り付けが汚れる。
  c.views = c.views || [];
  c.views.push({ userId: ctx.userId, at: new Date().toISOString(), date: b.date || isoDate(Date.now()), answer: b.answer });
  store.update('clips', p.id, { views: c.views });
  return ok({ clip: c });
}, { roles: ['admin', 'mentor', 'facilitator'] });

// アーカイブが効いているかを、費用ゼロで見る：
// 同じ先生の中で「見た週の次の授業スコア」と「見なかった週」を比べる（教師固定効果）。
route('GET', '/api/analysis/archive-effect', () => {
  const scores = store.all('scores').filter((s) => s.source === 'ai');
  const views = [];
  for (const c of store.all('clips')) for (const v of c.views || []) views.push({ userId: v.userId, week: weekKey(v.date) });
  const viewedWeeks = new Set(views.map((v) => `${v.userId}|${v.week}`));

  const byFac = {};
  for (const s of scores) {
    const wk = weekKey(s.date);
    // 前の週に視聴があったか
    const prevWeek = weekKey(isoDate(new Date(`${wk}T00:00:00Z`).getTime() - 7 * 86400000));
    const viewed = viewedWeeks.has(`${s.facilitatorId}|${prevWeek}`);
    if (!byFac[s.facilitatorId]) byFac[s.facilitatorId] = { after_view: [], no_view: [] };
    byFac[s.facilitatorId][viewed ? 'after_view' : 'no_view'].push(s.overall);
  }
  const rows = [];
  for (const [fid, v] of Object.entries(byFac)) {
    if (!v.after_view.length || !v.no_view.length) continue;
    rows.push({
      facilitatorId: fid,
      facilitator: (store.get('users', fid) || {}).name || null,
      after_view_mean: round(mean(v.after_view), 2),
      after_view_n: v.after_view.length,
      no_view_mean: round(mean(v.no_view), 2),
      no_view_n: v.no_view.length,
      within_diff: round(mean(v.after_view) - mean(v.no_view), 2),
    });
  }
  return ok({
    rows,
    mean_within_diff: rows.length ? round(mean(rows.map((r) => r.within_diff)), 3) : null,
    facilitators_compared: rows.length,
    evidence_id: 'archive_library',
    caveat: 'これは因果ではありません。視聴するかどうかは本人が決めています（自己選択）。'
      + '因果を見たいなら、12月のA/Bの各アーム内で「問いつき視聴 vs 自由視聴」をランダム化してください。',
  });
}, { roles: ['admin', 'mentor', 'staff'] });

// ===== 週次のチーム会（フォーマンセル） =====
route('GET', '/api/meetings', (ctx) => {
  const teams = visibleTeams(ctx);
  const ids = new Set(teams.map((t) => t.id));
  return ok(store.all('meetings')
    .filter((m) => ids.has(m.teamId))
    .map((m) => ({ ...m, team: teams.find((t) => t.id === m.teamId) || null })));
}, { roles: ['admin', 'mentor', 'facilitator'] });

route('POST', '/api/meetings', (ctx) => {
  const b = ctx.body || {};
  if (!b.teamId || !b.date) throw fail(400, 'teamId と date は必須です');
  const rec = {
    id: id('mt'),
    teamId: b.teamId,
    date: b.date,
    attendeeIds: b.attendeeIds || [],
    declarations: b.declarations || [], // [{ facilitatorId, action, dimension }]
    note: b.note || '',
    createdAt: new Date().toISOString(),
  };
  for (const d of rec.declarations) {
    const banned = findPersonalityTerms(d.action || '');
    if (banned.length) throw fail(422, `宣言に人格に触れる語が入っています: ${banned.join('、')}。行動と時刻で書いてください。`, 'PERSONALITY_TERM');
  }
  return ok(store.insert('meetings', rec), 201);
}, { roles: ['admin', 'mentor', 'facilitator'] });

// ===== A/B（集計のみ。個人の順位は出さない） =====
route('GET', '/api/analysis/ab', () => {
  const scores = store.all('scores').filter((s) => s.source === 'ai');
  const arms = {};
  for (const arm of ['A', 'B']) {
    const ss = scores.filter((s) => s.arm === arm);
    const facs = new Set(ss.map((s) => s.facilitatorId));
    const dims = {};
    for (const code of loadRubric().dimensions.map((d) => d.code)) {
      const v = ss.map((s) => (s.dims[code] ? s.dims[code].level : null)).filter((x) => x !== null);
      dims[code] = round(mean(v), 2);
    }
    const students = store.all('students').filter((s) => s.arm === arm);
    arms[arm] = {
      lessons_scored: ss.length,
      facilitators: facs.size,
      overall_mean: round(mean(ss.map((s) => s.overall)), 2),
      dims,
      students: students.length,
      churn_pct: students.length ? round((students.filter((s) => s.status === 'left').length / students.length) * 100, 2) : null,
    };
  }
  const a = arms.A.overall_mean;
  const b = arms.B.overall_mean;
  const load = mentorLoadLib.summary(store.all('mentorLogs'), { mentorFteHoursPerWeek: setting('mentor_fte_hours_week') });
  return ok({
    arms,
    quality_ratio_b_over_a: a && b ? round(b / a, 3) : null,
    quality_target: 0.8,
    mentor_load: load,
    churn_gap_pt: arms.A.churn_pct !== null && arms.B.churn_pct !== null ? round(Math.abs(arms.B.churn_pct - arms.A.churn_pct), 2) : null,
    churn_target_pt: 5,
    design_note: 'Bでも4〜8名のチームは削っていません。削ると「関係性を奪ったら壊れた」の証明にしかならないためです。',
    statistical_note: '⚠️ 指導者6名では統計的な効果検証はできません。これはフィージビリティ・スタディです。'
      + '「12月に効果が実証された」とは書けません。',
  });
}, { roles: ['admin', 'mentor', 'staff'] });

// ===== 書き起こしの取り込み =====
// Zoom / Meet / VTT / SRT / CSV を貼り付けて、話者を子どもに対応づけてから授業にする。
// 対応づけはサーバ側でやり直す（画面から送られてきた発話をそのまま信じない）。
route('POST', '/api/import/parse', (ctx) => {
  const b = ctx.body || {};
  if (!b.text || !String(b.text).trim()) throw fail(400, '書き起こしのテキストが空です');
  const parsed = importLib.parse(String(b.text), { format: b.format, mergeGapSec: b.mergeGapSec });
  if (!parsed.utterances.length) {
    throw fail(400, `読み取れる発話がありませんでした（形式の判定: ${parsed.format}）。`
      + '形式を指定して試すか、「MM:SS 話者名: 本文」の形に整えてください。');
  }
  const win = loadRubric().window.minutes * 60;
  return ok({
    format: parsed.format,
    warnings: parsed.warnings,
    speakers: parsed.speakers,
    total: parsed.utterances.length,
    in_window: parsed.utterances.filter((u) => u.t < win).length,
    window_minutes: loadRubric().window.minutes,
    duration_sec: parsed.utterances.length ? Math.round(parsed.utterances[parsed.utterances.length - 1].t) : 0,
    preview: parsed.utterances.slice(0, 40),
  });
}, { roles: ['admin', 'mentor', 'facilitator'] });

route('POST', '/api/import/lesson', (ctx) => {
  const b = ctx.body || {};
  if (!b.classId || !b.date) throw fail(400, 'クラスと日付は必須です');
  if (!b.text) throw fail(400, '書き起こしのテキストが必要です');
  if (!b.mapping || !Object.keys(b.mapping).length) throw fail(400, '話者の対応づけがされていません');
  const klass = store.get('classes', b.classId);
  if (!klass) throw fail(400, 'そのクラスがありません');
  assertCanSeeFacilitator(ctx, klass.facilitatorId);

  // 対応先が実在するかを確かめる（存在しないIDで発話が迷子になるのを防ぐ）
  const noConsent = [];
  for (const [label, target] of Object.entries(b.mapping)) {
    if (target === 'T' || target === '' || target === null) continue;
    if (!klass.studentIds.includes(target)) throw fail(400, `「${label}」の対応先がこのクラスの子どもではありません`);
    // 同意のない子どものことばは、そもそも保存しない
    if (!consentOk(store.get('students', target))) noConsent.push(store.get('students', target));
  }
  if (noConsent.length) {
    throw fail(400, `保護者の同意が記録されていない子どもがいます：${noConsent.map((x) => x.name).join('、')}。`
      + '「人とクラス」で同意を記録してから取り込んでください。同意のない発話は保存しません。', 'CONSENT_REQUIRED');
  }
  if (!Object.values(b.mapping).includes('T')) throw fail(400, '先生（T）に対応づけた話者がありません');

  const parsed = importLib.parse(String(b.text), { format: b.format, mergeGapSec: b.mergeGapSec });
  const mapped = importLib.applyMapping(parsed.utterances, b.mapping);
  if (!mapped.utterances.length) throw fail(400, '対応づけの結果、発話が1つも残りませんでした');

  const lesson = store.insert('lessons', {
    id: id('ls'),
    classId: klass.id,
    facilitatorId: klass.facilitatorId,
    arm: klass.arm || null,
    date: b.date,
    durationMin: b.durationMin || 45,
    attendance: b.attendance || klass.studentIds.length,
    note: b.note || '',
    source: parsed.format,
    demo: false,
    createdAt: new Date().toISOString(),
    createdBy: ctx.userId,
  });
  store.insertMany('utterances', mapped.utterances.map((u, i) => ({
    id: id('ut'), lessonId: lesson.id, seq: i, t: u.t, speaker: u.speaker, text: u.text,
  })));

  let score = null;
  let feedback = null;
  try {
    score = runScoring(lesson);
    feedback = makeFeedback(score);
  } catch (e) {
    // 採点に失敗しても授業は残す（あとで採点し直せる）
    store.insert('auditLog', { id: id('au'), at: new Date().toISOString(), actor: ctx.userId, action: 'import.score_failed', target: lesson.id });
  }
  store.flush();
  return ok({
    lesson,
    utterances: mapped.utterances.length,
    warnings: [...parsed.warnings, ...mapped.warnings],
    score,
    feedback,
  }, 201);
}, { roles: ['admin', 'mentor', 'facilitator'] });

// ===== NIJIN 評価契約の形での評価 =====
// 同じ授業を、Ranius プラットフォームの契約（不変条件つき）に通したらどうなるかを返します。
// 画面の 0〜4 表示より厳しく出ます。それが正しい姿です。
route('GET', '/api/lessons/:id/contract', (ctx, p) => {
  const l = store.get('lessons', p.id);
  if (!l) throw fail(404, '授業がありません');
  if (ctx.user.role === 'rater') throw fail(403, '評定者はこの経路を使いません。', 'FORBIDDEN');
  assertCanSeeFacilitator(ctx, l.facilitatorId);
  const utterances = store.all('utterances').filter((u) => u.lessonId === l.id);
  if (!utterances.length) throw fail(400, 'この授業には書き起こしがありません。');
  const klass = store.get('classes', l.classId);
  const scored = scoreLesson(utterances, { roster: klass ? klass.studentIds : [] });
  const { observation, evaluation } = contractLib.evaluate(scored, {
    durationSec: (l.durationMin || 45) * 60,
    analysisId: `ls-${l.id}`,
  });
  logView(ctx, 'lesson.contract.view', l.id);
  return ok({
    evaluation,
    observation_counts: {
      observations: observation.observations.length,
      candidates: observation.dimension_candidates.length,
      not_observable: observation.not_observable.length,
    },
    rubric: contractLib.loadRubric(),
    ours: { overall: scored.overall, dims: Object.fromEntries(Object.entries(scored.dims).map(([k, v]) => [k, v.level])) },
    note: 'こちらの画面表示（0〜4）と、契約の形では結果が違います。契約のほうが厳しく、確かめていないものを点にしません。',
  });
}, { roles: ['admin', 'mentor', 'facilitator'] });

// ===== 本番の準備ができているか =====
// 12月にA/Bを始められる状態か、を機械で確かめる。
// 「たぶん大丈夫」で始めて、あとから「あれが抜けていた」となるのを防ぐためのものです。
route('GET', '/api/readiness', () => {
  const users = store.all('users').filter((u) => u.status !== 'disabled');
  const students = store.all('students');
  const mv = currentModelVersion();
  const draft = draftModelVersion();
  const metrics = collectMetrics();
  const ks = killStatus();

  // バックアップは data/ の外なので、ここで直接見る
  let lastBackup = null;
  try {
    const dir = path.join(__dirname, '..', '..', 'backups');
    const rows = fs.readdirSync(dir).filter((d) => /^\d{4}-\d{2}-\d{2}_/.test(d)).sort();
    lastBackup = rows.length ? rows[rows.length - 1].slice(0, 10) : null;
  } catch { lastBackup = null; }
  const backupAgeDays = lastBackup ? daysBetween(lastBackup, isoDate(Date.now())) : null;

  const demoRecords = ['users', 'students', 'classes', 'lessons', 'clips', 'meetings', 'costItems', 'surveyCycles']
    .reduce((a, c) => a + store.all(c).filter((r) => r.demo).length, 0);

  const checks = [
    {
      id: 'demo_off', label: 'デモ表示が切れている', group: '前提',
      ok: !setting('demo_mode'),
      detail: setting('demo_mode') ? 'いまはデモ表示です。実データを入れる前に「設定」で本番にしてください。' : '本番表示です。',
      how: '設定 → デモ表示 → 本番',
    },
    {
      id: 'demo_clean', label: 'デモデータが残っていない', group: '前提',
      ok: demoRecords === 0,
      detail: demoRecords ? `デモの記録が ${demoRecords} 件あります。実データと混ざります。` : 'デモの記録はありません。',
      how: 'data/ を空にしてから、画面で実データを登録する（seed.js は実行しない）',
    },
    {
      id: 'passcodes', label: '全員に合言葉が設定されている', group: '入る',
      ok: users.every((u) => u.hash),
      detail: `${users.filter((u) => u.hash).length} / ${users.length} 人`,
      how: 'node scripts/set-passcode.js <ID> <合言葉>、または「人とクラス」から',
    },
    {
      id: 'tls', label: 'HTTPS で動いている', group: '入る',
      ok: !!process.env.RANIUS_SECURE_COOKIE,
      detail: process.env.RANIUS_SECURE_COOKIE
        ? 'TLS が有効です。' : 'HTTP です。localhost だけなら可。社外から使うなら証明書が要ります。',
      how: 'certs/key.pem と certs/cert.pem を置く（または RANIUS_TLS_KEY / RANIUS_TLS_CERT）',
      severity: 'warn',
    },
    {
      id: 'consent', label: '全員の保護者の同意が記録されている', group: '子ども',
      ok: students.length > 0 && students.every((s) => s.consent && s.consent.obtainedAt && !s.consent.withdrawnAt),
      detail: students.length
        ? `${students.filter((s) => s.consent && s.consent.obtainedAt && !s.consent.withdrawnAt).length} / ${students.length} 人`
        : '子どもが登録されていません。',
      how: 'docs/保護者への説明.md を配り、「人とクラス」で1人ずつ記録する',
    },
    {
      id: 'consent_required', label: '同意の確認が有効になっている', group: '子ども',
      ok: !!setting('require_consent'),
      detail: setting('require_consent') ? '同意のない子の発話は取り込めません。' : '⚠️ 無効です。実データでは有効にしてください。',
      how: '設定 → 子どものデータ → 同意の確認',
    },
    {
      id: 'retention', label: '保存期間が決まっている', group: '子ども',
      ok: Number(setting('transcript_retention_days')) > 0,
      detail: `${setting('transcript_retention_days')}日`,
      how: '設定 → 書き起こしの保存期間',
    },
    {
      id: 'backup', label: '直近7日以内に控えがある', group: '守る',
      ok: backupAgeDays !== null && backupAgeDays <= 7,
      detail: lastBackup ? `最後の控え ${lastBackup}（${backupAgeDays}日前）` : '控えがありません。',
      how: '毎日の控え.cmd をタスクスケジューラに毎日1回登録する',
    },
    {
      id: 'model_frozen', label: 'モデル版が凍結されている', group: '測る',
      ok: !!mv,
      detail: mv ? `${mv.label}（${mv.frozenAt ? mv.frozenAt.slice(0, 10) : '—'}）` : '凍結された版がありません。',
      how: 'node scripts/freeze-model.js "v1" "何を凍結したか"',
    },
    {
      id: 'model_drift', label: '凍結後にルーブリックが変わっていない', group: '測る',
      ok: !!mv && mv.fingerprint === draft.fingerprint,
      detail: mv && mv.fingerprint !== draft.fingerprint
        ? '⚠️ 凍結後に変わっています。いまのスコアは凍結版と同じではありません。' : '一致しています。',
      how: '凍結し直して、全授業を再スコアする',
    },
    {
      id: 'irr', label: '評価者間一致が .65 に届いている', group: '測る',
      ok: metrics.irr_qwk !== null && metrics.irr_qwk >= 0.65,
      detail: metrics.irr_qwk === null ? '未測定です。' : `いま ${metrics.irr_qwk}（目標 .65／期限 2026-10-20）`,
      how: '外部評定者2名に rater アカウントを渡し、盲検で16本以上を二重コーディングする',
    },
    {
      id: 'mentor_log', label: 'メンターの記録が入り始めている', group: '測る',
      ok: store.all('mentorLogs').length > 0,
      detail: `${store.all('mentorLogs').length} 行`,
      how: '毎日1行。ここが空だと、この事業の全論拠が測れません',
    },
    {
      id: 'cost', label: '費用が3シナリオで出せる', group: '測る',
      ok: store.all('costItems').length > 0 && store.all('users').some((u) => u.role === 'facilitator' && u.readyAt),
      detail: `費用項目 ${store.all('costItems').length} 件／一人前になった人 ${store.all('users').filter((u) => u.readyAt).length} 人`,
      how: '費用の画面で項目を入れ、「人とクラス」で一人前になった日を記録する',
    },
    {
      id: 'kill', label: '撤退基準に触れていない', group: '止める',
      ok: ks.status === 'ok',
      detail: ks.status === 'ok' ? '基準内です。'
        : ks.status === 'halt' ? `⚠️ 全停止中：${ks.halt_reason}`
          : `${ks.tripped.length}件が基準に触れています：${ks.tripped.map((t) => t.label).join('、')}`,
      how: '撤退基準の画面で中身を確認する',
    },
  ];

  const blocking = checks.filter((c) => !c.ok && c.severity !== 'warn');
  return ok({
    ready: blocking.length === 0,
    checks,
    blocking: blocking.map((c) => c.id),
    note: 'これは「始めてよいか」の目安です。ここが全部緑でも、12月のA/Bは6名では統計的な検定になりません。'
      + 'フィージビリティ・スタディであることは変わりません。',
  });
}, { roles: ['admin', 'mentor', 'staff'] });

// ===== 週次サマリ =====
// 毎週月曜に5分で読むためのもの。画面を開かなくても「今週なにを見ればいいか」が分かる形。
route('GET', '/api/report/weekly', (ctx) => {
  const db = {};
  for (const c of store.COLLECTIONS) db[c] = store.all(c);
  db.users = db.users.map(publicUser);
  const audience = ctx.user.role === 'mentor' ? 'mentor' : 'admin';
  let r;
  try {
    r = reportLib.weekly(db, {
      asOf: ctx.query.asOf || isoDate(Date.now()),
      weeks: Number(ctx.query.weeks || 4),
      audience,
      mentorId: audience === 'mentor' ? ctx.userId : undefined,
      mentorFteHoursPerWeek: setting('mentor_fte_hours_week'),
    });
  } catch (e) {
    // 人格語や比較語が混ざったら、サマリを出さない（黙って直さない）
    throw fail(422, `週次サマリを作れませんでした：${e.message}`, e.code || null);
  }
  return ok({ ...r, demo: !!setting('demo_mode') });
}, { roles: ['admin', 'mentor'] });

// ===== 子どもの様子（出席と沈黙） =====
// これは先生を見るための道具ではありません。**子どもを見るための道具**です。
// 8人のオンラインで3回続けて一度も話していない子は、たいてい次にいなくなります。
// 辞める前に見つけるために作ってあります。戻り値に先生の識別子は入れません。
route('GET', '/api/attendance', (ctx) => {
  const classes = store.all('classes').filter((c) => {
    if (ctx.user.role === 'facilitator') return c.facilitatorId === ctx.user.id;
    if (ctx.user.role === 'mentor') return auth.canSeeFacilitator(ctx.user, c.facilitatorId);
    return true;
  });
  const ids = new Set(classes.map((c) => c.id));
  const db = {
    classes,
    lessons: store.all('lessons').filter((l) => ids.has(l.classId)),
    scores: store.all('scores').filter((s) => ids.has(s.classId)),
    students: store.all('students').filter((s) => ids.has(s.classId)),
  };
  const r = attendanceLib.summarize(db, {
    asOf: ctx.query.asOf || isoDate(Date.now()),
    weeks: Number(ctx.query.weeks || 8),
    classId: ctx.query.classId || undefined,
  });
  // 子どもの表示名は、見てよい人にだけ
  const nameOf = {};
  db.students.forEach((st, i) => { nameOf[st.id] = childLabel(ctx, st, i); });
  const className = Object.fromEntries(classes.map((c) => [c.id, c.name]));
  return ok({
    ...r,
    students: r.students.map((x) => ({ ...x, name: nameOf[x.studentId], className: className[x.classId] })),
    flags: r.flags.map((f) => ({ ...f, name: nameOf[f.studentId], className: className[f.classId] })),
    classes: r.classes.map((c) => ({ ...c, name: className[c.classId] })),
  });
}, { roles: ['admin', 'mentor', 'facilitator'] });

// ===== 監査ログ =====
// 保護者に「誰がいつ見たか」を説明できるようにするためのものです。
route('GET', '/api/audit', (ctx) => {
  const rows = store.all('auditLog').slice().reverse();
  const filtered = ctx.query.action ? rows.filter((r) => r.action === ctx.query.action) : rows;
  const counts = {};
  for (const r of rows) counts[r.action] = (counts[r.action] || 0) + 1;
  return ok({
    total: rows.length,
    counts,
    rows: filtered.slice(0, Number(ctx.query.limit || 200)).map((r) => ({
      ...r,
      actorName: (store.get('users', r.actor) || {}).name || r.actor,
    })),
  });
}, { roles: ['admin'] });

// ===== 書き出し（外部の統計解析・AEA用） =====
// 子どもの名前と識別子は、どのデータセットにも出しません。
route('GET', '/api/export', () => ok({
  datasets: exportLib.datasets(),
  note: 'BOM付きUTF-8のCSVです。Excelでそのまま開けます。子どもの識別子は含みません。',
}), { roles: ['admin', 'staff'] });

route('GET', '/api/export/:id', (ctx, p) => {
  const db = {};
  for (const c of store.COLLECTIONS) db[c] = store.all(c);
  // users には合言葉のハッシュが入っている。書き出し側に生で渡さない。
  db.users = db.users.map(publicUser);
  let built;
  try {
    built = exportLib.build(p.id, db);
  } catch (e) {
    throw fail(400, `書き出せません: ${e.message}`);
  }
  store.insert('auditLog', { id: id('au'), at: new Date().toISOString(), actor: ctx.userId, action: 'export', target: p.id });
  // デモのCSVが R や Stata に渡った時点で、デモである印が消えてしまう。
  // 画面の警告はファイルには付いてこないので、ここで名前と中身の両方に入れる。
  if (setting('demo_mode')) {
    const csv = built.csv.replace(/^\uFEFF/, '');
    return {
      status: 200,
      raw: '\uFEFF# DEMO DATA — このファイルはデモデータです。実績ではありません。分析や資料に使わないでください。\r\n' + csv,
      contentType: 'text/csv; charset=utf-8',
      filename: built.filename.replace(/\.csv$/, '_DEMO.csv'),
    };
  }
  return { status: 200, raw: built.csv, contentType: 'text/csv; charset=utf-8', filename: built.filename };
}, { roles: ['admin', 'staff'] });

// ===== 盲検の採点キュー =====
// 評定者に見せてよいのは「書き起こし」だけ。
// 先生の名前・アーム・AIのスコア・子どもの名前は、この経路では一切返しません。
// ここが漏れると IRR が「AIに引っぱられた一致」になり、測る意味がなくなります。
route('GET', '/api/blind/queue', (ctx) => {
  const mine = new Set(store.all('ratings').filter((r) => r.raterId === ctx.user.id).map((r) => r.lessonId));
  const rows = store.all('lessons')
    .filter((l) => store.all('utterances').some((u) => u.lessonId === l.id))
    .map((l) => {
      const uttCount = store.all('utterances').filter((u) => u.lessonId === l.id && u.t < 900).length;
      const raters = new Set(store.all('ratings').filter((r) => r.lessonId === l.id).map((r) => r.raterId));
      return {
        lessonId: l.id,
        utterances: uttCount,
        rated_by_me: mine.has(l.id),
        rater_count: raters.size,
        // 2人そろっていない授業を先に出す（IRRはペアがないと計算できない）
        priority: raters.size === 1 && !mine.has(l.id) ? 0 : mine.has(l.id) ? 2 : 1,
      };
    })
    .sort((a, b) => a.priority - b.priority || a.lessonId.localeCompare(b.lessonId));
  return ok({
    queue: rows,
    todo: rows.filter((r) => !r.rated_by_me).length,
    done: rows.filter((r) => r.rated_by_me).length,
    window_minutes: loadRubric().window.minutes,
    note: '冒頭15分だけを見て採点してください。全部見る必要はありません（信頼性の約6割が冒頭15分で出ます）。',
  });
}, { roles: ['rater', 'admin'] });

route('GET', '/api/blind/lessons/:id', (ctx, p) => {
  const l = store.get('lessons', p.id);
  if (!l) throw fail(404, '授業がありません');
  const rubric = loadRubric();
  const win = rubric.window.minutes * 60;
  const klass = store.get('classes', l.classId);
  const roster = klass ? klass.studentIds : [];
  const mask = {};
  roster.forEach((sid, i) => { mask[sid] = `子ども${i + 1}`; });
  const utterances = store.all('utterances')
    .filter((u) => u.lessonId === l.id && u.t < win)
    .sort((a, b) => a.t - b.t)
    .map((u) => ({ t: u.t, speaker: u.speaker === 'T' ? '先生' : (mask[u.speaker] || '子ども'), text: u.text }));
  logView(ctx, 'blind.transcript.view', l.id);
  const mineRating = store.all('ratings').find((r) => r.lessonId === l.id && r.raterId === ctx.user.id);
  return ok({
    lessonId: l.id,
    roster_size: roster.length,
    window_minutes: rubric.window.minutes,
    dimensions: rubric.dimensions.map((d) => ({
      code: d.code, name: d.name, question: d.question, observable: d.observable, scale: rubric.scale,
    })),
    utterances,
    my_rating: mineRating ? mineRating.dims : null,
  });
}, { roles: ['rater', 'admin'] });

// ===== 所見 =====
route('GET', '/api/feedbacks', (ctx) => {
  let fbs = store.all('feedbacks').filter((f) => auth.canSeeFacilitator(ctx.user, f.facilitatorId));
  if (ctx.query.facilitatorId) fbs = fbs.filter((f) => f.facilitatorId === ctx.query.facilitatorId);
  return ok(fbs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, Number(ctx.query.limit || 100)));
});

route('POST', '/api/feedbacks', (ctx) => {
  const b = ctx.body || {};
  if (!b.facilitatorId || !b.body) throw fail(400, 'facilitatorId と body は必須です');
  assertCanSeeFacilitator(ctx, b.facilitatorId);
  const banned = findPersonalityTerms(b.body);
  if (banned.length) {
    throw fail(422, `所見に人格に触れる語が入っています: ${banned.join('、')}。「いつ・何が起きたか」で書き直してください。`, 'PERSONALITY_TERM');
  }
  // メンターの所見は、メンターと運営しか作れない。
  // ここを開けると、先生が自分あてに書いた分がメンター記録に入り、
  // 「メンター1人あたりの担当数」＝この事業の全論拠が静かに動いてしまう。
  if (b.kind === 'mentor' && !['admin', 'mentor'].includes(ctx.user.role)) {
    throw fail(403, 'メンターの所見として保存できるのは、メンターと運営だけです。', 'FORBIDDEN');
  }
  const rec = {
    id: id('fb'),
    lessonId: b.lessonId || null,
    facilitatorId: b.facilitatorId,
    arm: (store.get('users', b.facilitatorId) || {}).arm || null,
    kind: b.kind || 'mentor', // mentor | peer | ai
    authorId: ctx.userId,
    dimension: b.dimension || null,
    action_step: b.action_step || null,
    body: b.body,
    mentorMinutes: Number(b.mentorMinutes || 0),
    createdAt: new Date().toISOString(),
  };
  store.insert('feedbacks', rec);
  // メンターが所見に使った時間は、そのまま担当数の分母になる
  if (rec.kind === 'mentor' && rec.mentorMinutes > 0 && rec.authorId && ['admin', 'mentor'].includes(ctx.user.role)) {
    store.insert('mentorLogs', {
      id: id('ml'),
      mentorId: rec.authorId,
      facilitatorId: rec.facilitatorId,
      arm: rec.arm,
      date: isoDate(Date.now()),
      week: weekKey(isoDate(Date.now())),
      minutes: rec.mentorMinutes,
      kind: 'feedback',
      note: '所見の作成（自動記録）',
      createdAt: new Date().toISOString(),
    });
  }
  return ok(rec, 201);
});

route('POST', '/api/feedbacks/:id/ack', (ctx, p) => {
  const f = store.get('feedbacks', p.id);
  if (!f) throw fail(404, 'ありません');
  // 本人（と運営）だけ。IDを総当たりして所見の中身を引き出せないように、戻り値も最小にする。
  if (f.facilitatorId !== ctx.userId && ctx.user.role !== 'admin') {
    throw fail(403, '自分あての所見だけが対象です。', 'FORBIDDEN');
  }
  const rec = store.update('feedbacks', p.id, { acknowledgedAt: new Date().toISOString() });
  return ok({ id: rec.id, acknowledgedAt: rec.acknowledgedAt });
});

module.exports = { handle, collectMetrics, killStatus, currentModelVersion, runScoring, makeFeedback, setting };
