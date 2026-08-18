'use strict';
// 採点。信号（signals）→ 指標（0..1）→ ルーブリックの帯（0..4）。
//
// 設計上の約束（変えるときは docs/エンジニア引き継ぎ書.md 3章を先に読むこと）：
//   1. 決定的であること。同じ書き起こしと同じ rubric から、必ず同じスコアが出る。
//      LLM はスコアを出さない。LLM が出すのは所見の文面だけ（lib/feedback.js）。
//      理由：12月のA/Bで「モデルを凍結した」と言うには、再現できなければならない。
//   2. スコアには必ず時刻つきの根拠を添える。根拠のないスコアは保存しない。
//   3. ファシリテーター間の順位は作らない。比較対象は本人の過去だけ。
const fs = require('node:fs');
const path = require('node:path');
const { analyze } = require('./transcript');
const { clamp01, round, sha256 } = require('./util');

const SCORER_VERSION = 'heuristic-1.1.0';
const SPEC_DIR = path.join(__dirname, '..', '..', 'spec');

function loadRubric() {
  return JSON.parse(fs.readFileSync(path.join(SPEC_DIR, 'rubric.ja.json'), 'utf8'));
}

function loadPrompt() {
  const p = path.join(__dirname, '..', '..', 'prompts', 'feedback.ja.md');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

// --- 指標。各次元 0..1 ---
const INDICATORS = {
  // 理解可能なインプットの調整
  input_adjustment(s) {
    const len = clamp01((35 - (s.teacher_mean_mora || 0)) / 20);
    const check = clamp01((s.comprehension_check_per_10min || 0) / 3);
    const rephrase = clamp01((s.rephrase_rate || 0) / 0.15);
    const emptyPenalty = Math.min(0.2, (s.empty_check_count || 0) * 0.05);
    return clamp01(0.4 * len + 0.35 * check + 0.25 * rephrase - emptyPenalty);
  },
  // 発話機会の配分
  turn_equity(s) {
    const equity = 1 - (s.student_turn_gini === null ? 1 : s.student_turn_gini);
    const talk = clamp01((0.75 - (s.teacher_talk_ratio === null ? 1 : s.teacher_talk_ratio)) / 0.35);
    const roster = s.roster_size || 1;
    const voiced = 1 - (s.silent_student_count || 0) / roster;
    // 連続指名の減点。効かせすぎると全員が床に張りつくので上限を置く
    const runPenalty = Math.min(0.24, Math.max(0, (s.max_nomination_run || 0) - 2) * 0.08);
    return clamp01(0.45 * equity + 0.3 * talk + 0.25 * voiced - runPenalty);
  },
  // 訂正フィードバックと取り込み
  uptake_rate(s) {
    const c = s.correction_count || 0;
    if (c === 0) return 0;
    const rate = s.uptake_rate === null ? 0 : s.uptake_rate;
    const coverage = clamp01(c / 4);
    return clamp01(0.8 * rate + 0.2 * coverage);
  },
  // 意味交渉
  negotiation_density(s) {
    const dur = Math.max(60, s.duration_sec || 600);
    const per10 = ((s.clarification_request_count || 0) + (s.confirmation_check_count || 0)) / dur * 600;
    // 5回/10分で満点。ここを緩くすると全員が天井に張りつき、観点が効かなくなる
    const density = clamp01(per10 / 5);
    const clarifications = s.clarification_request_count || 0;
    // 聞き返しが1回しかない授業で「修復率100%」を作らない
    const repairShare = clarifications >= 2
      ? clamp01((s.repair_episode_count || 0) / clarifications)
      : clamp01((s.repair_episode_count || 0) / 2);
    return clamp01(0.6 * density + 0.4 * repairShare);
  },
  // アウトプットの質と変容（OUT）。人間評定が主。ここで出す値は補助であって、AIの平均には入れない。
  output_quality(s) {
    const len = clamp01((s.student_mean_mora || 0) / 12);
    const long = clamp01((s.student_long_turn_rate || 0) / 0.35);
    // 授業内の伸び。0%で 0.33、+40%で満点、-20%以下で 0
    const growth = s.student_mora_growth === null || s.student_mora_growth === undefined
      ? 0.33
      : clamp01((s.student_mora_growth + 0.2) / 0.6);
    return clamp01(0.4 * len + 0.35 * long + 0.25 * growth);
  },
  // 足場と安心
  scaffold_safety(s) {
    // 待ち時間は3秒で及第、5秒で満点。受け止めと自発の発話は、それぞれ6割・4割で満点。
    const wait = clamp01(((s.wait_time_median_sec === null ? 0 : s.wait_time_median_sec) - 1.5) / 3.5);
    const ack = clamp01((s.acknowledgement_rate || 0) / 0.6);
    const init = clamp01((s.student_initiated_turn_rate || 0) / 0.4);
    return clamp01(0.4 * wait + 0.35 * ack + 0.25 * init);
  },
};

// 根拠として添えるイベントの種類（次元ごと）
const EVIDENCE_TYPES = {
  CI: ['long_utterance', 'empty_check', 'comprehension_check', 'rephrase'],
  TD: ['silent_student', 'nomination_run'],
  CF: ['recast', 'explicit_correction', 'uptake'],
  NM: ['clarification_request', 'confirmation_check'],
  SC: ['short_wait'],
  OUT: ['student_extended_turn'],
};

function levelFor(dim, value) {
  for (const band of dim.bands) {
    if (value >= band.min) return band.level;
  }
  return 0;
}

// 授業1本を採点する。
// lesson: { id, roster: [studentId] }, utterances: [{t, speaker, text}]
function scoreLesson(utterances, opts = {}) {
  const rubric = opts.rubric || loadRubric();
  const { signals, events } = analyze(utterances, {
    windowMinutes: rubric.window.minutes,
    roster: opts.roster,
  });

  const dims = {};
  for (const d of rubric.dimensions) {
    const fn = INDICATORS[d.indicator];
    if (!fn) throw new Error(`指標の実装がない: ${d.indicator}`);
    const value = fn(signals);
    const level = levelFor(d, value);
    const types = EVIDENCE_TYPES[d.code] || [];
    dims[d.code] = {
      code: d.code,
      name: d.name,
      rater: d.rater || 'ai',
      indicator: d.indicator,
      value: round(value, 3),
      level,
      evidence: events.filter((e) => types.includes(e.type)).slice(0, 6),
    };
  }

  // rater が human の観点は、AIの平均に入れない。
  // AIが測れないものをAIの平均に混ぜると、A/Bの比較が濁る。
  const aiCodes = rubric.dimensions.filter((d) => (d.rater || 'ai') !== 'human').map((d) => d.code);
  const levels = aiCodes.map((c) => dims[c].level);
  const overall = levels.reduce((a, b) => a + b, 0) / levels.length;

  return {
    dims,
    overall: round(overall, 2),
    overall_codes: aiCodes,
    signals,
    events,
    scorer_version: SCORER_VERSION,
  };
}

// --- モデル版（凍結の単位） ---
// LLM ＋ プロンプト ＋ ルーブリック の組。1文字変えたら別の版。
function computeFingerprint(llm) {
  const rubricRaw = fs.readFileSync(path.join(SPEC_DIR, 'rubric.ja.json'), 'utf8');
  const promptRaw = loadPrompt();
  const parts = {
    scorer: SCORER_VERSION,
    llm: llm || 'local-heuristic',
    rubric_sha256: sha256(rubricRaw),
    prompt_sha256: sha256(promptRaw),
  };
  return { ...parts, fingerprint: sha256(JSON.stringify(parts)) };
}

module.exports = { scoreLesson, loadRubric, computeFingerprint, INDICATORS, SCORER_VERSION };
