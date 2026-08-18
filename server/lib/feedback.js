'use strict';
// 所見の生成。
// 事実（時刻つき）→ 次の1手（1つだけ）。人格に触れる語が混ざったら生成をやめる。
// 比較対象は本人の過去のみ。他の先生の値はこの関数に渡らない設計にしてある。
const { findPersonalityTerms } = require('./ja');
const { round } = require('./util');

const TEMPLATES = {
  CI: {
    fact: (s, ev) => {
      const long = ev.filter((e) => e.type === 'long_utterance');
      const empty = ev.filter((e) => e.type === 'empty_check');
      const out = [`先生の1発話の長さは平均 ${s.teacher_mean_mora} モーラでした。`];
      if (long.length) out.push(`40モーラを超えた発話が ${long.length} 回ありました（最初は ${long[0].at}）。`);
      if (empty.length) out.push(`「わかった？」で終わる確認が ${empty.length} 回ありました（${empty.map((e) => e.at).join('、')}）。`);
      out.push(`内容を問い返す確認は 10分あたり ${s.comprehension_check_per_10min} 回でした。`);
      return out;
    },
    action: (s, ev) => {
      const empty = ev.filter((e) => e.type === 'empty_check');
      if (empty.length) return '「わかった？」の代わりに「いまの、日本語で言ってみて」を1回だけ使う。';
      if ((s.teacher_mean_mora || 0) > 28) return '説明を1文で切る。2文目を言う前に、子どもに1回渡す。';
      return '通じなかった語を、その場で1回だけ別の言い方に置きかえる。';
    },
  },
  TD: {
    fact: (s, ev) => {
      const silent = ev.filter((e) => e.type === 'silent_student');
      const runs = ev.filter((e) => e.type === 'nomination_run');
      const out = [`先生の話す量は全体の ${Math.round((s.teacher_talk_ratio || 0) * 100)}% でした。`];
      if (silent.length) out.push(`冒頭15分で1回も話していない子が ${silent.length} 人いました。`);
      if (runs.length) out.push(`${runs[0].at} から、同じ子への指名が ${s.max_nomination_run} 回続きました。`);
      out.push(`発話回数の偏り（ジニ係数）は ${s.student_turn_gini} でした。0に近いほど平等です。`);
      return out;
    },
    action: (s, ev) => {
      const silent = ev.filter((e) => e.type === 'silent_student');
      if (silent.length) return `次の授業では、開始5分以内に全員に1回ずつ順番を回す（今回話していない ${silent.length} 人を先に）。`;
      if ((s.max_nomination_run || 0) >= 3) return '同じ子に2回続けて指名しない。2回目の前に、必ず別の子を挟む。';
      return '自分が2文話したら、必ず1回は子どもに渡す。';
    },
  },
  CF: {
    fact: (s, ev) => {
      const out = [];
      if (!s.correction_count) {
        out.push('冒頭15分で、誤りへの訂正（リキャストまたは明示的訂正）は検出されませんでした。');
      } else {
        out.push(`訂正は ${s.correction_count} 回（リキャスト ${s.recast_count} / 明示 ${s.explicit_correction_count}）でした。`);
        out.push(`そのうち、子どもが言い直したのは ${s.uptake_count} 回（取り込み率 ${round((s.uptake_rate || 0) * 100, 0)}%）でした。`);
        const up = ev.filter((e) => e.type === 'uptake');
        if (up.length) out.push(`最初に言い直しが起きたのは ${up[0].at} です。`);
      }
      return out;
    },
    action: (s) => {
      if (!s.correction_count) return '誤りを1つだけ選び、正しい形でさりげなく言い直す（リキャスト）を3回やってみる。';
      if ((s.uptake_rate || 0) < 0.4) return '言い直したあと、1.5秒待って「もう一回言ってみて」を足す（訂正を届いた形にする）。';
      return '今回できていた言い直しを、いちばん静かな子に対しても1回やってみる。';
    },
  },
  NM: {
    fact: (s, ev) => {
      const out = [
        `聞き返しは ${s.clarification_request_count} 回、確認は ${s.confirmation_check_count} 回でした。`,
        `そのうち、やりとりが続いた（修復まで行った）のは ${s.repair_episode_count} 回です。`,
      ];
      const c = ev.filter((e) => e.type === 'clarification_request');
      if (c.length) out.push(`最初の聞き返しは ${c[0].at} でした。`);
      return out;
    },
    action: (s) => {
      if (!s.clarification_request_count) return '通じなかった場面で、先に答えを言わずに「どういう意味？」と1回だけ返す。';
      return '聞き返したあと、子どもが言い直すまで先に説明しない（1回だけ我慢する）。';
    },
  },
  SC: {
    fact: (s, ev) => {
      const short = ev.filter((e) => e.type === 'short_wait');
      const out = [`指名から応答までの待ち時間は、中央値 ${s.wait_time_median_sec} 秒でした。`];
      if (short.length) out.push(`2秒未満で次に進んだ場面が ${short.length} 回ありました（${short.slice(0, 3).map((e) => e.at).join('、')}）。`);
      out.push(`子どもの発話を受け止める反応は ${Math.round((s.acknowledgement_rate || 0) * 100)}% の発話に付いていました。`);
      out.push(`指名されずに自分から話した割合は ${Math.round((s.student_initiated_turn_rate || 0) * 100)}% でした。`);
      return out;
    },
    action: (s, ev) => {
      const short = ev.filter((e) => e.type === 'short_wait');
      if (short.length) return '指名したあと、心の中で3つ数えてから次に行く。1回でいい。';
      return '子どもが言い終わったら、次の質問の前に必ず1回、内容をくり返す。';
    },
  },
};

// scored: scoreLesson の戻り値 / history: 同じ本人の直近スコア配列（新しい順）
function generate(scored, history = []) {
  // 人間評定が主の観点（OUT など）では、AIは所見を書かない。
  // 測れないものについて「次の1手」を出すのは、根拠のない指示になるため。
  const dims = Object.values(scored.dims).filter((d) => (d.rater || 'ai') !== 'human' && TEMPLATES[d.code]);
  // 本人の直近平均との差がいちばん大きい観点を選ぶ（他人とは比べない）
  const withDelta = dims.map((d) => {
    const past = history
      .map((h) => (h.dims && h.dims[d.code] ? h.dims[d.code].level : null))
      .filter((x) => x !== null)
      .slice(0, 3);
    const baseline = past.length ? past.reduce((a, b) => a + b, 0) / past.length : null;
    return { ...d, baseline: baseline === null ? null : round(baseline, 2), delta: baseline === null ? null : round(d.level - baseline, 2) };
  });
  const target = withDelta
    .slice()
    .sort((a, b) => {
      if (a.delta !== null && b.delta !== null) return a.delta - b.delta || a.level - b.level;
      return a.level - b.level;
    })[0];

  const tpl = TEMPLATES[target.code];
  const facts = tpl.fact(scored.signals, target.evidence);
  const action = tpl.action(scored.signals, target.evidence);

  const body = [
    '【見えたこと】',
    ...facts.map((f) => ` ${f}`),
    '',
    '【次の1手】',
    ` ${action}`,
    '',
    '【次に見る観点】',
    ` ${target.code}｜${target.name}：今回 ${target.level}／4` +
      (target.baseline === null ? '（本人の過去データがまだありません）' : `、本人の直近3回の平均 ${target.baseline}`),
    '',
    '※ この所見は未検証の器具によるものです。決めるのはあなたです。週次のチームで1つだけ選んでください。',
  ].join('\n');

  const banned = findPersonalityTerms(body);
  if (banned.length) {
    const err = new Error(`所見に人格に触れる語が含まれている: ${banned.join('、')}`);
    err.code = 'PERSONALITY_TERM';
    throw err;
  }

  return {
    dimension: target.code,
    dimension_name: target.name,
    level: target.level,
    baseline: target.baseline,
    delta: target.delta,
    action_step: action,
    body,
    evidence: target.evidence,
  };
}

module.exports = { generate, TEMPLATES };
