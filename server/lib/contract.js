'use strict';
// NIJIN 評価契約への変換。
//
// ともだちじゃぱんの採点（書き起こしからの決定的な計算）を、
// Ranius プラットフォームの契約（nijin-observation-input / nijin-evaluation-result）の形に写します。
// 目的は、将来どちらの観察層（Gemini の動画観察 / こちらの書き起こし観察）を使っても、
// 同じ形の評価結果になり、同じ画面で読めるようにすることです。
//
// 契約の不変条件は、向こうの contracts/README.md にあるものをそのまま守ります。
//   1. 軸状態は scored | not_observable | review_required のいずれか
//   2. NA/review の score と level は null
//   3. 5軸すべてが scored のときだけ overall_score を計算する
//   4. confidence < 0.65、根拠不足、重大判断、反証はレビューへ
//   5. measurement（発話比・待ち時間・チャット数など）は採点関数へ入力しない
//   6. 未観察を低得点で補完せず、欠損軸を除いた再重み付けもしない
//   7. 観察層は事実と候補を返すが、最終得点を返さない
//
// ⚠️ 5番が、こちらの採点との最大の違いです。
//    ranius-nihongo の scoring.js は、モーラ数やジニ係数から直接スコアを出しています。
//    この変換を通すと、それらは measurement に落ち、**採点には使われません**。
//    どちらが正しいかは目的で決まります（→ docs/評価契約との関係.md）。
const fs = require('node:fs');
const path = require('node:path');
const { round, sha256 } = require('./util');

const CONTRACT_VERSION = 'nijin-evaluation-result-1.0.0';
const OBSERVATION_VERSION = 'nijin-observation-input-1.0.0';
const RUBRIC_VERSION = 'nijin-nihongo-1.0.0';
const SCORER_VERSION = 'tomodachi-deterministic-scorer-1.0.0';
const CONFIDENCE_THRESHOLD = 0.65;
const LEVEL_TO_SCORE = { 1: 10, 2: 30, 3: 50, 4: 70, 5: 90 };

function loadRubric() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'spec', 'rubric.nihongo-1.0.0.json'), 'utf8'));
}

// ---- こちらの観点コード → 契約の軸キー ----
// TD（発話機会の配分）が入っていないのは、意図的です。
// 発話量・発話比率・ターン数は、契約が「単独で加点・減点しない」と決めているもので、
// measurement へ落とします。こちらの採点で TD が独立した観点になっていたのは、
// 向こうの不変条件5と正面からぶつかります。
const CODE_TO_KEY = {
  SC: 'psychological_safety_and_participation_choice',
  CI: 'comprehensible_input_adjustment',
  NM: 'meaning_negotiation_and_repair',
  CF: 'corrective_feedback_and_uptake',
  OUT: 'output_quality_and_transformation',
};

// ---- 検出器ごとの確からしさ ----
// 「この検出はどのくらい信じてよいか」を、正直に置きます。
// 0.65 未満のものは、それを根拠にした軸が自動で人間レビューに落ちます。
// リキャストと取り込みが低いのは、文字バイグラムの重なりで判定しているためです。
// ここを高く見せると、確かめていないものを確かめたことにしてしまいます。
const EVENT_CONFIDENCE = {
  silent_student: 0.9,          // 発話回数を数えるだけ
  long_utterance: 0.9,          // モーラ数
  short_wait: 0.85,             // 時刻の差
  student_extended_turn: 0.9,   // モーラ数
  explicit_correction: 0.8,     // 「じゃなくて」などの明示的な語
  empty_check: 0.8,             // 「わかった？」の完全一致
  clarification_request: 0.75,  // 決まった言い回し
  comprehension_check: 0.7,
  confirmation_check: 0.65,
  nomination_run: 0.8,
  recast: 0.6,                  // ← 未満。バイグラムの重なりでの推定
  uptake: 0.6,                  // ← 未満。同上
  rephrase: 0.6,                // ← 未満
};

// どのイベントが、どの軸の根拠になるか
const KEY_TO_EVENTS = {
  psychological_safety_and_participation_choice: ['short_wait', 'silent_student'],
  comprehensible_input_adjustment: ['long_utterance', 'empty_check', 'comprehension_check', 'rephrase'],
  meaning_negotiation_and_repair: ['clarification_request', 'confirmation_check'],
  corrective_feedback_and_uptake: ['recast', 'explicit_correction', 'uptake'],
  output_quality_and_transformation: ['student_extended_turn'],
};

// こちらの 0〜4 → 契約の 1〜5。
// **level 1 は絶対に出しません。** 契約の level 1 は「学習を狭める働きが確認される」で、
// 書き起こしの統計からは、その事実を立てられないからです。
// こちらの 0（観察できない）は、低得点ではなく not_observable にします（不変条件6）。
function toCandidateLevel(ourLevel) {
  if (ourLevel === 0) return null; // not_observable
  return Math.min(5, ourLevel + 1); // 1→2, 2→3, 3→4, 4→5
}

// ---- 観察入力をつくる ----
// scored: scoring.js の scoreLesson の戻り値
// opts: { analysisId, durationSec, rosterSize }
function toObservationInput(scored, opts = {}) {
  const rubric = opts.rubric || loadRubric();
  const durationSec = opts.durationSec || scored.signals.duration_sec || 900;

  const observations = [];
  const seen = new Set();
  scored.events.forEach((e, i) => {
    const conf = EVENT_CONFIDENCE[e.type];
    if (conf === undefined) return; // 契約に載せない種類のイベントは落とす
    const id = `${e.type}-${i}`;
    if (seen.has(id)) return;
    seen.add(id);
    observations.push({
      id,
      category: e.type,
      start_sec: Math.max(0, Math.round(e.t)),
      end_sec: Math.min(durationSec, Math.round(e.t) + 10),
      // fact は観察事実だけ。解釈を混ぜない（混ぜると、あとで反証できなくなる）
      fact: e.note,
      modalities: ['transcript'],
      confidence: conf,
      // 「働きかけ→応答→変化」が閉じているのは、取り込みが観測できたときだけ
      sequence_complete: e.type === 'uptake',
    });
  });
  const byId = new Map(observations.map((o) => [o.id, o]));

  const candidates = [];
  const notObservable = [];
  for (const dim of rubric.dimensions) {
    const code = Object.keys(CODE_TO_KEY).find((c) => CODE_TO_KEY[c] === dim.key);
    const ours = code ? scored.dims[code] : null;
    const refs = observations.filter((o) => (KEY_TO_EVENTS[dim.key] || []).includes(o.category)).map((o) => o.id);
    const level = ours ? toCandidateLevel(ours.level) : null;

    if (!ours || level === null) {
      notObservable.push({
        dimension_key: dim.key,
        reason: ours
          ? '書き起こしから、この軸の判定に必要な行動が観察できませんでした。'
          : 'この軸は、書き起こしからは観察していません。',
        attempts: 1,
      });
      continue;
    }
    // 人間評定が主の軸は、こちらからは候補を出さない（不変条件7の趣旨）
    if (dim.rater === 'human') {
      notObservable.push({
        dimension_key: dim.key,
        reason: 'この軸は人間評定が主です。書き起こしからの値は補助であり、候補レベルとしては出しません。',
        attempts: 1,
      });
      continue;
    }
    // 参照した根拠のうち、いちばん低い確からしさを採る（低いほうに引きずられるのが正しい）
    const confs = refs.map((r) => byId.get(r).confidence);
    const confidence = confs.length ? Math.min(...confs) : 0.5;
    candidates.push({
      dimension_key: dim.key,
      status_hint: 'scored',
      candidate_level: level,
      confidence: round(confidence, 2),
      explanation: `${dim.label}：書き起こしの信号（${(dim.question || '').slice(0, 24)}…）から算出。指標値 ${ours.value}。`,
      evidence_refs: refs,
      counterevidence_refs: [],
      reason_codes: [`TRANSCRIPT_SIGNAL_${code}`],
      major_judgement: false,
    });
  }

  return {
    schema_version: OBSERVATION_VERSION,
    analysis_id: opts.analysisId || `tj-${sha256(JSON.stringify(scored.signals)).slice(0, 16)}`,
    status: 'completed',
    source: {
      duration_sec: durationSec,
      mime_type: 'text/vtt',
      coverage: { video: 'missing', audio: 'missing', chat: 'missing', artifacts: 'missing' },
    },
    observations,
    dimension_candidates: candidates,
    not_observable: notObservable,
    review_requests: [],
  };
}

// ---- 観察入力 → 評価結果（決定的） ----
// 向こうの scoring-engine.js と同じ不変条件で書いています。
function toEvaluationResult(input, opts = {}) {
  const rubric = opts.rubric || loadRubric();
  const byId = new Map(input.observations.map((o) => [o.id, o]));
  const reviews = [];
  const dimensions = [];

  for (const dim of rubric.dimensions) {
    const candidate = input.dimension_candidates.find((c) => c.dimension_key === dim.key);
    const na = input.not_observable.filter((n) => n.dimension_key === dim.key);
    const refs = candidate ? candidate.evidence_refs : [];
    const evidence = refs.map((r) => byId.get(r)).filter(Boolean);
    const local = [];

    const push = (summary, code, severity = 'routine') => {
      local.push({ dimension_key: dim.key, severity, summary, evidence_refs: refs, reason_code: code });
    };

    if (candidate) {
      if (candidate.confidence < CONFIDENCE_THRESHOLD) {
        push(`候補confidence ${candidate.confidence} は0.65未満です。`, 'LOW_CANDIDATE_CONFIDENCE');
      }
      const low = evidence.filter((e) => e.confidence < CONFIDENCE_THRESHOLD);
      if (low.length) push('参照根拠にconfidence 0.65未満の観察があります。', 'LOW_EVIDENCE_CONFIDENCE');
      if ((candidate.counterevidence_refs || []).length) {
        push('反証根拠があるためlevelを人が裁定する必要があります。', 'COUNTEREVIDENCE_REQUIRES_REVIEW');
      }
      // 独立した2場面、または完結した1連鎖
      const sufficient = refs.length >= 2 || evidence.some((e) => e.sequence_complete);
      if (!sufficient) push('独立した2場面または完結した1連鎖の根拠がありません。', 'INSUFFICIENT_EVIDENCE');
      // ルーブリックが「必ず人が見る」と決めている組み合わせ
      for (const rule of (rubric.review_rules.always_review || [])) {
        if (rule.when.includes(dim.key) && rule.when.includes('level が 1') && candidate.candidate_level === 1) {
          push(rule.why, 'RUBRIC_ALWAYS_REVIEW', 'major');
        }
      }
    }

    const confs = [candidate ? candidate.confidence : null, ...evidence.map((e) => e.confidence)]
      .filter((x) => typeof x === 'number');
    const confidence = confs.length ? round(Math.min(...confs), 2) : 0;
    const outEvidence = evidence.map((e) => ({
      observation_id: e.id,
      start_sec: e.start_sec,
      end_sec: e.end_sec,
      fact: e.fact,
      interpretation: candidate ? candidate.explanation : '人間による解釈確認が必要です。',
      modalities: e.modalities,
      confidence: e.confidence,
    }));

    if (local.length) {
      reviews.push(...local);
      dimensions.push({
        key: dim.key, label: dim.label, status: 'review_required', score: null, level: null,
        confidence, evidence: outEvidence,
        reason_codes: [...new Set([...(candidate ? candidate.reason_codes : []), ...local.map((r) => r.reason_code)])],
        not_observable: na.map((n) => n.reason), review_required: true,
      });
      continue;
    }
    if (na.length || !candidate) {
      dimensions.push({
        key: dim.key, label: dim.label, status: 'not_observable', score: null, level: null,
        confidence, evidence: outEvidence,
        reason_codes: candidate ? candidate.reason_codes : [],
        not_observable: na.length ? na.map((n) => n.reason) : ['候補も判定不能理由もありません。'],
        review_required: false,
      });
      continue;
    }
    dimensions.push({
      key: dim.key, label: dim.label, status: 'scored',
      score: LEVEL_TO_SCORE[candidate.candidate_level],
      level: candidate.candidate_level,
      confidence, evidence: outEvidence,
      reason_codes: candidate.reason_codes, not_observable: [], review_required: false,
    });
  }

  // 不変条件3：5軸すべてが scored のときだけ総合点を出す。再重み付けはしない。
  const allScored = dimensions.every((d) => d.status === 'scored');
  let overall = null;
  let overallConfidence = null;
  if (allScored) {
    const weights = Object.fromEntries(rubric.dimensions.map((d) => [d.key, d.weight]));
    const total = dimensions.reduce((a, d) => a + d.score * weights[d.key], 0);
    overall = Math.round(total / 100);
    overallConfidence = round(Math.min(...dimensions.map((d) => d.confidence)), 2);
  }

  const s = opts.signals || {};
  return {
    schema_version: CONTRACT_VERSION,
    rubric_version: RUBRIC_VERSION,
    evaluation_id: opts.evaluationId || `ev-${input.analysis_id}`,
    analysis_id: input.analysis_id,
    status: reviews.length ? 'needs_review' : 'completed',
    overall_score: overall,
    overall_confidence: overallConfidence,
    summary: allScored
      ? 'すべての軸で根拠が揃いました。総合点は各軸の重み付けから計算しています。'
      : `${dimensions.filter((d) => d.status !== 'scored').length}軸が未確定のため、総合点は出していません。`,
    dimensions,
    review_requests: reviews,
    // 不変条件5：ここに置いたものは、採点に一切使われていません
    measurement: {
      teacher_talk_ratio: s.teacher_talk_ratio === undefined ? null : s.teacher_talk_ratio,
      student_talk_ratio: s.teacher_talk_ratio === undefined || s.teacher_talk_ratio === null
        ? null : round(1 - s.teacher_talk_ratio, 3),
      speaker_count_observed: s.roster_size === undefined ? null : s.roster_size - (s.silent_student_count || 0) + 1,
      participation_modes_observed: ['transcript'],
      camera_on_ratio: null,   // 書き起こしからは分かりません
      chat_message_count: null,
      student_to_student_response_chains: null,
      unplanned_learning_turns: null,     // この版では観察していません
      concrete_abstract_cycles: null,     // この版では観察していません
      question_count: s.clarification_request_count === undefined ? null
        : (s.clarification_request_count || 0) + (s.confirmation_check_count || 0),
      median_wait_time_sec: s.wait_time_median_sec === undefined ? null : s.wait_time_median_sec,
    },
    limitations: [
      '映像と音声を見ていません。書き起こしのテキストだけから観察しています。',
      'カメラのオン・オフ、表情、チャット、成果物は観察できていません。',
      'リキャストと取り込みは文字の重なりから推定しており、確からしさは 0.6 です。',
      s.silent_student_count
        ? `冒頭${s.window_minutes || 15}分で発話が記録されなかった子が ${s.silent_student_count} 人います。話していないのか、記録に乗らなかったのかは区別できていません。`
        : null,
    ].filter(Boolean),
    model_metadata: {
      provider: 'tomodachi-japan',
      model: 'transcript-heuristic',
      prompt_version: 'n/a',
      rubric_version: RUBRIC_VERSION,
      scorer_version: SCORER_VERSION,
      contract_version: CONTRACT_VERSION,
    },
  };
}

function evaluate(scored, opts = {}) {
  const rubric = loadRubric();
  const input = toObservationInput(scored, { ...opts, rubric });
  const result = toEvaluationResult(input, { ...opts, rubric, signals: scored.signals });
  return { observation: input, evaluation: result };
}

module.exports = {
  toObservationInput, toEvaluationResult, evaluate, loadRubric,
  CODE_TO_KEY, EVENT_CONFIDENCE, RUBRIC_VERSION, CONFIDENCE_THRESHOLD, LEVEL_TO_SCORE,
};
