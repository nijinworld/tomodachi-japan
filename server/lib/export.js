'use strict';
// 外部に出すための書き出し（CSV）。
//
// 出す先は2つだけです：
//   1. 外部の統計解析（R / Stata / Python）。12月のA/B検証の本計算はここでやります。
//   2. AEA事前登録に添える集計。
// どちらも「画面で見る数字」ではなく「他人が再計算できる数字」を求めます。
// だからこのモジュールは、集計や丸めをしません。持っている値をそのまま縦に並べます。
//
// 現場は Windows の Excel で開きます。BOM を落とすと日本語が化けます。落とさないこと。
//
// store を require していないのは意図です。db は引数で受け取ります。
// （テストが本物の data/ を読まずに済むため。docs/エンジニア引き継ぎ書.md 5章と同じ考え方）
const { round } = require('./util');

// 観点コード。spec/rubric.ja.json の dimensions と同じ順で並べます。
// 列の順序が版によって入れ替わると、外部の解析スクリプトが黙って壊れるため、ここで固定します。
const DIMENSIONS = ['CI', 'TD', 'CF', 'NM', 'SC', 'OUT'];

// scores_wide に出す信号。全部は出しません。事前登録に書いた主要指標だけです。
const WIDE_SIGNALS = [
  'teacher_talk_ratio',
  'uptake_rate',
  'wait_time_median_sec',
  'student_turn_gini',
  'silent_student_count',
];

// 日付を持っているコレクション。ファイル名の日付を探すときに見ます。
const DATED_COLLECTIONS = [
  'lessons', 'scores', 'ratings', 'mentorLogs', 'surveyResponses',
  'feedbacks', 'incidents', 'clips', 'meetings',
];

// レコードの中で日付が入りうるキー。date が最優先、なければ作成時刻を使います。
const DATE_KEYS = ['date', 'createdAt', 'frozenAt'];

// ---------- CSV ----------

// 1つの値をCSVの1セルにする。
// null / undefined は空文字（0 と区別できなくなるため、0 を入れてはいけない）。
function cell(v) {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'string' ? v : String(v);
  // , " 改行（CR も LF も）が入っていたら囲む。囲んだ中の " は "" に倍化する。
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// 汎用CSV。BOM付きUTF-8、改行は CRLF（RFC 4180。Excel と R の既定に合わせる）。
// columns: [{ key, label }]
function toCsv(rows, columns) {
  const cols = columns || [];
  const lines = [cols.map((c) => cell(c.label === undefined ? c.key : c.label)).join(',')];
  for (const r of rows || []) {
    lines.push(cols.map((c) => cell(r ? r[c.key] : null)).join(','));
  }
  // 末尾にも改行を置く。置かないと R の read.csv が incomplete final line の警告を出す。
  return `\ufeff${lines.join('\r\n')}\r\n`;
}

// ---------- 小道具 ----------

const list = (db, name) => (db && Array.isArray(db[name]) ? db[name] : []);

// 真偽値は true/false の文字列で出す。0/1 にすると欠測と区別できなくなるため。
const bool = (v) => (v === true ? 'true' : 'false');

// "YYYY-MM-DD" として使える形だけ拾い、いちばん新しいものを返す。
// ISO の文字列は辞書順＝時系列順なので、比較に Date を作る必要はありません。
// キーは DATE_KEYS の順に見て、見つかった時点で打ち切ります。観測日（date）があるなら
// それを使い、無いとき（評定やアンケート）だけ作成時刻に落とすためです。
// 混ぜると、種まきをやり直しただけでファイル名が動いてしまいます。
function latestDate(records) {
  for (const k of DATE_KEYS) {
    let best = null;
    for (const r of records) {
      if (!r || typeof r !== 'object') continue;
      const v = r[k];
      if (typeof v !== 'string' || v.length < 10) continue;
      const d = v.slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
      if (best === null || d > best) best = d;
    }
    if (best !== null) return best;
  }
  return null;
}

// 項目コードから観点コードを取る（CI1 -> CI、BL2 -> BL）。
// spec/survey.ja.json を読まずに済ませているのは、この関数が接尾の数字を落とすだけで足りるためです。
const itemDimension = (code) => String(code || '').replace(/\d+$/, '');

// 人間評定者どうしのペア。同じ授業を2名以上が採点したものだけを対象にします。
// 評定者IDを並べ替えてから先頭2名を取ります（入力の並び順で a と b が入れ替わらないため）。
function humanPairs(ratings) {
  const byLesson = new Map();
  for (const r of ratings) {
    if (!r || !r.lessonId || !r.raterId) continue;
    if (!byLesson.has(r.lessonId)) byLesson.set(r.lessonId, []);
    byLesson.get(r.lessonId).push(r);
  }
  const out = [];
  for (const [lessonId, rs] of byLesson) {
    const raterIds = [...new Set(rs.map((r) => r.raterId))].sort();
    if (raterIds.length < 2) continue; // 1名しか採点していない授業は一致を測れない
    const a = rs.find((r) => r.raterId === raterIds[0]);
    const b = rs.find((r) => r.raterId === raterIds[1]);
    for (const code of DIMENSIONS) {
      const la = a.dims ? a.dims[code] : undefined;
      const lb = b.dims ? b.dims[code] : undefined;
      if (typeof la !== 'number' || typeof lb !== 'number') continue;
      out.push({
        lesson_id: lessonId,
        dimension: code,
        rater_a: raterIds[0],
        level_a: la,
        rater_b: raterIds[1],
        level_b: lb,
        diff: la - lb, // 符号つき。外部でカッパを再計算するときに向きが要るため
      });
    }
  }
  return out;
}

// ---------- データセット ----------

const DEFS = [
  {
    id: 'scores_long',
    label: '観点スコア（縦持ち）',
    description: '1行 = 1授業1観点。混合効果モデルにそのまま入る形。',
    sources: ['scores'],
    columns: [
      { key: 'lesson_id', label: 'lesson_id' },
      { key: 'date', label: 'date' },
      { key: 'arm', label: 'arm' },
      { key: 'facilitator_id', label: 'facilitator_id' },
      { key: 'class_id', label: 'class_id' },
      { key: 'model_version_id', label: 'model_version_id' },
      { key: 'dimension', label: 'dimension' },
      { key: 'level', label: 'level' },
      { key: 'indicator_value', label: 'indicator_value' },
      { key: 'rater', label: 'rater' },
    ],
    rows(db) {
      const out = [];
      for (const s of list(db, 'scores')) {
        const dims = s.dims || {};
        for (const code of DIMENSIONS) {
          const d = dims[code];
          if (!d) continue;
          out.push({
            lesson_id: s.lessonId,
            date: s.date,
            arm: s.arm,
            facilitator_id: s.facilitatorId,
            class_id: s.classId,
            model_version_id: s.modelVersionId,
            dimension: code,
            level: d.level,
            indicator_value: round(d.value, 4),
            // OUT だけ human。AIの平均（overall）に入っていないので、解析でも分けて扱うこと。
            rater: d.rater,
          });
        }
      }
      return out;
    },
  },
  {
    id: 'scores_wide',
    label: '観点スコア（横持ち）',
    description: '1行 = 1授業。観点を列に展開し、主要な信号を添えたもの。',
    sources: ['scores'],
    columns: [
      { key: 'lesson_id', label: 'lesson_id' },
      { key: 'date', label: 'date' },
      { key: 'arm', label: 'arm' },
      { key: 'facilitator_id', label: 'facilitator_id' },
      { key: 'class_id', label: 'class_id' },
      { key: 'model_version_id', label: 'model_version_id' },
      ...DIMENSIONS.map((c) => ({ key: c, label: c })),
      { key: 'overall', label: 'overall' },
      ...WIDE_SIGNALS.map((s) => ({ key: s, label: s })),
    ],
    rows(db) {
      return list(db, 'scores').map((s) => {
        const dims = s.dims || {};
        const signals = s.signals || {};
        const row = {
          lesson_id: s.lessonId,
          date: s.date,
          arm: s.arm,
          facilitator_id: s.facilitatorId,
          class_id: s.classId,
          model_version_id: s.modelVersionId,
          overall: s.overall,
        };
        for (const code of DIMENSIONS) row[code] = dims[code] ? dims[code].level : null;
        for (const k of WIDE_SIGNALS) row[k] = signals[k] === undefined ? null : signals[k];
        return row;
      });
    },
  },
  {
    id: 'mentor_logs',
    label: 'メンター記録',
    description: '1行 = 1記録。A/Bのメンター負荷（時間）を外部で比べるため。',
    sources: ['mentorLogs'],
    columns: [
      { key: 'date', label: 'date' },
      { key: 'week', label: 'week' },
      { key: 'mentor_id', label: 'mentor_id' },
      { key: 'facilitator_id', label: 'facilitator_id' },
      { key: 'arm', label: 'arm' },
      { key: 'minutes', label: 'minutes' },
      { key: 'kind', label: 'kind' },
    ],
    rows(db) {
      return list(db, 'mentorLogs').map((m) => ({
        date: m.date,
        week: m.week,
        mentor_id: m.mentorId,
        facilitator_id: m.facilitatorId,
        arm: m.arm,
        minutes: m.minutes,
        kind: m.kind,
      }));
    },
  },
  {
    id: 'ratings',
    label: '人間評定',
    description: '1行 = 評定者×授業×観点。盲検かどうかを列に残す。',
    sources: ['ratings'],
    columns: [
      { key: 'lesson_id', label: 'lesson_id' },
      { key: 'rater_id', label: 'rater_id' },
      { key: 'blind', label: 'blind' },
      { key: 'dimension', label: 'dimension' },
      { key: 'level', label: 'level' },
      { key: 'created_at', label: 'created_at' },
    ],
    rows(db) {
      const out = [];
      for (const r of list(db, 'ratings')) {
        const dims = r.dims || {};
        for (const code of DIMENSIONS) {
          if (dims[code] === undefined) continue;
          out.push({
            lesson_id: r.lessonId,
            rater_id: r.raterId,
            blind: bool(r.blind !== false),
            dimension: code,
            level: dims[code],
            created_at: r.createdAt,
          });
        }
      }
      return out;
    },
  },
  {
    id: 'irr_pairs',
    label: '評価者間一致のペア',
    description: '1行 = 授業×観点。2名が採点した授業だけ。外部でカッパを再計算するため。',
    sources: ['ratings'],
    columns: [
      { key: 'lesson_id', label: 'lesson_id' },
      { key: 'dimension', label: 'dimension' },
      { key: 'rater_a', label: 'rater_a' },
      { key: 'level_a', label: 'level_a' },
      { key: 'rater_b', label: 'rater_b' },
      { key: 'level_b', label: 'level_b' },
      { key: 'diff', label: 'diff' },
    ],
    rows(db) {
      return humanPairs(list(db, 'ratings'));
    },
  },
  {
    id: 'survey_responses',
    label: '子どもアンケート（項目別）',
    description: '1行 = 回答者×項目。子どもの識別子は出さず、サイクル内の連番だけを付ける。',
    sources: ['surveyResponses'],
    columns: [
      { key: 'cycle', label: 'cycle' },
      { key: 'respondent_index', label: 'respondent_index' },
      { key: 'facilitator_id', label: 'facilitator_id' },
      { key: 'class_id', label: 'class_id' },
      { key: 'arm', label: 'arm' },
      { key: 'item_code', label: 'item_code' },
      { key: 'dimension', label: 'dimension' },
      { key: 'value', label: 'value' },
    ],
    rows(db) {
      // 仮名化はここが最後の砦です。studentId には子どもの名前が入っています（"st_0_0|あかり1"）。
      // 外に出す行に studentId を触れさせないこと。連番はサイクルごとに振り直すので、
      // サイクルをまたいで同じ子を追うことはできません（追えないほうが正しい）。
      const seq = new Map();
      const out = [];
      for (const r of list(db, 'surveyResponses')) {
        const cycle = r.cycle === undefined || r.cycle === null ? '' : String(r.cycle);
        const n = (seq.get(cycle) || 0) + 1;
        seq.set(cycle, n);
        for (const [code, value] of Object.entries(r.answers || {})) {
          out.push({
            cycle: r.cycle,
            respondent_index: n,
            facilitator_id: r.facilitatorId,
            class_id: r.classId,
            arm: r.arm,
            item_code: code,
            dimension: itemDimension(code),
            value,
          });
        }
      }
      return out;
    },
  },
  {
    id: 'cost_items',
    label: '費用の明細',
    description: '1行 = 1明細。時間はそのまま出す（賃率を掛けるのは外部の仕事）。',
    sources: ['costItems'],
    columns: [
      { key: 'category', label: 'category' },
      { key: 'actor', label: 'actor' },
      { key: 'arm', label: 'arm' },
      { key: 'label', label: 'label' },
      { key: 'hours', label: 'hours' },
      { key: 'jpy', label: 'jpy' },
      { key: 'qty', label: 'qty' },
      { key: 'note', label: 'note' },
    ],
    rows(db) {
      return list(db, 'costItems').map((c) => ({
        category: c.category,
        actor: c.actor,
        arm: c.arm,
        label: c.label,
        hours: c.hours,
        jpy: c.jpy,
        qty: c.qty,
        note: c.note,
      }));
    },
  },
  {
    id: 'lessons',
    label: '授業',
    description: '1行 = 1授業。採点済みかどうかを列に持つ（欠測の理由を外部で数えるため）。',
    sources: ['lessons'],
    columns: [
      { key: 'lesson_id', label: 'lesson_id' },
      { key: 'date', label: 'date' },
      { key: 'class_id', label: 'class_id' },
      { key: 'facilitator_id', label: 'facilitator_id' },
      { key: 'arm', label: 'arm' },
      { key: 'duration_min', label: 'duration_min' },
      { key: 'attendance', label: 'attendance' },
      { key: 'scored', label: 'scored' },
    ],
    rows(db) {
      const scored = new Set(list(db, 'scores').map((s) => s.lessonId));
      return list(db, 'lessons').map((l) => ({
        lesson_id: l.id,
        date: l.date,
        class_id: l.classId,
        facilitator_id: l.facilitatorId,
        arm: l.arm,
        duration_min: l.durationMin,
        attendance: l.attendance,
        scored: bool(scored.has(l.id)),
      }));
    },
  },
];

// ---------- 表に出す口 ----------

// 一覧。画面のプルダウンと、docs/運用手順.md の書き出し手順が、これを唯一の出どころにします。
function datasets() {
  return DEFS.map((d) => ({
    id: d.id,
    label: d.label,
    description: d.description,
    columns: d.columns.map((c) => ({ ...c })),
  }));
}

// ファイル名の日付。Date.now() は使いません。同じデータからは必ず同じ名前が出ること。
// そのデータセットに日付がないとき（費用の明細など）は、db 全体のいちばん新しい日付を借ります。
function stamp(db, def) {
  const own = latestDate(def.sources.flatMap((name) => list(db, name)));
  if (own) return own;
  const any = latestDate(DATED_COLLECTIONS.flatMap((name) => list(db, name)));
  return any || 'nodata';
}

// build('scores_long', db) -> { filename, csv, rows }
// db は { scores: [], lessons: [], ... } の素のオブジェクト。store は渡しません。
function build(id, db) {
  const def = DEFS.find((d) => d.id === id);
  if (!def) {
    const e = new Error(`知らないデータセット: ${id}`);
    e.status = 400;
    e.code = 'UNKNOWN_DATASET';
    throw e;
  }
  const source = db || {};
  const rows = def.rows(source);
  return {
    filename: `ranius_${def.id}_${stamp(source, def)}.csv`,
    csv: toCsv(rows, def.columns),
    rows,
  };
}

module.exports = { toCsv, datasets, build, DIMENSIONS };
