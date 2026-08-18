'use strict';
// デモデータの生成。
//
// ⚠️ ここで作られる数字は、すべてデモです。実績ではありません。
//    画面にも「デモ」と出ます。スクリーンショットを資料に貼らないでください。
//    （00_はじめに/03_まだ証明していないこと.md ①）
//
// 乱数は固定シードです。何度実行しても同じデータが出ます。
// 実データを入れるときは、このスクリプトを実行しないでください（データを消します）。
const store = require('../server/lib/store');
const { runScoring, makeFeedback } = require('../server/routes/api');
const { id, isoDate, weekKey } = require('../server/lib/util');
const { computeFingerprint } = require('../server/lib/scoring');
const auth = require('../server/lib/auth');

// デモ用の合言葉。**本番では絶対に使わないこと。**
// 実データを入れるときは scripts/set-passcode.js で入れ直してください。
const DEMO_PASSCODE = 'ranius-demo-2026';

// ---- 固定シードの乱数（Math.random は使わない：再現できなくなるため） ----
let seed = 20261218;
function rnd() {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
}
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const chance = (p) => rnd() < p;
const jitter = (base, spread) => base + (rnd() - 0.5) * 2 * spread;

// ---- 語彙 ----
const ERROR_PAIRS = [
  { bad: 'きのう、学校に いきます', good: 'きのう、学校に いったんだね' },
  { bad: 'わたしは ラーメンが すきます', good: 'わたしは ラーメンが すきなんだね' },
  { bad: 'あした、公園で あそんだ', good: 'あした、公園で あそぶんだね' },
  { bad: 'ともだちと 映画を みるでした', good: 'ともだちと 映画を みたんだね' },
  { bad: 'おかあさんが ごはんを つくます', good: 'おかあさんが ごはんを つくるんだね' },
  { bad: 'ぼくは 犬が こわいでした', good: 'ぼくは 犬が こわかったんだね' },
  { bad: 'きょう、しゅくだいを やります した', good: 'きょう、しゅくだいを やったんだね' },
];
const PLAIN_STUDENT = [
  'はい', 'えっと、たぶん そうです', 'ぼくも 同じです',
  'たのしかったです', 'すこし むずかしいです', 'それ、しってる', 'わたしも やりたい',
];
const TEACHER_QUESTIONS = [
  'さん、きのうは なにを しましたか？',
  'さん、どうしてそう おもいましたか？',
  'さん、いまの話、どう おもう？',
  'さん、つづきを 言って ください',
];
const TEACHER_LONG = [
  'いまから みんなで 一つの話を つくります。まず 場面を きめて、それから 人物を きめて、さいごに おわりかたを かんがえます。じゅんばんに いきましょう',
  'きょうの めあては、じぶんの けいけんを 三つの文で つたえることです。はじめに いつ、つぎに どこで、さいごに どう おもったか を 入れて ください',
];
const TEACHER_SHORT = [
  'いいね', 'そうだね', 'なるほど', 'ありがとう', 'よく言えたね',
  'もうすこし 聞かせて',
];
const TEACHER_REPHRASE = [
  'つまり、たのしかったんだね',
  'かんたんに言うと、こういうことかな',
  'べつの言い方を するね。これはね、こういう意味です',
];
const TEACHER_COMP_CHECK = [
  'いまの、じぶんのことばで 言ってみて',
  'どこがわからない？',
  'どういうことか、説明してみて',
];
const TEACHER_EMPTY_CHECK = ['わかった？', 'いいですか？'];
const CLARIFY = ['もういちど 言って', 'どういう意味？', 'いまの、なんて言った？'];

// ---- プロファイル：先生ごとの癖。週を追って少しずつ良くなる ----
function profileFor(kind, week) {
  const g = Math.min(1, week / 10); // 上達
  if (kind === 'licensed') {
    return {
      pLong: 0.16 - 0.05 * g, pEmpty: 0.10 - 0.06 * g, pRephrase: 0.16 + 0.08 * g,
      pCompCheck: 0.16 + 0.08 * g, waitMean: 3.2 + 0.6 * g, pCorrection: 0.55 + 0.1 * g,
      pUptake: 0.45 + 0.15 * g, pClarify: 0.05 + 0.04 * g, silent: chance(0.25) ? 1 : 0,
      skew: 0.25, teacherTurnBias: 0.48,
    };
  }
  // 教員未経験（アームB）。最初は待てない・話しすぎる・全員に回らない
  return {
    pLong: 0.30 - 0.15 * g, pEmpty: 0.26 - 0.16 * g, pRephrase: 0.07 + 0.12 * g,
    pCompCheck: 0.06 + 0.14 * g, waitMean: 1.6 + 1.7 * g, pCorrection: 0.30 + 0.28 * g,
    pUptake: 0.20 + 0.28 * g, pClarify: 0.02 + 0.05 * g, silent: chance(0.55 - 0.35 * g) ? 2 : chance(0.4) ? 1 : 0,
    skew: 0.55 - 0.25 * g, teacherTurnBias: 0.62 - 0.10 * g,
  };
}

// ---- 1授業ぶんの書き起こしを作る ----
// roster は生徒IDの配列。名前は nameOf で引く（IDに名前を埋め込まない＝仮名化のため）
function makeTranscript(roster, prof, nameOf) {
  const us = [];
  let t = 5;
  const active = roster.slice(0, roster.length - prof.silent); // 話さない子を作る
  let lastStudent = null;
  const push = (speaker, text, gap) => { t += gap; us.push({ t: Math.round(t), speaker, text }); };

  push('T', 'おはようございます。きょうも はじめましょう', 0);

  while (t < 15 * 60 - 20) {
    // 指名の偏り
    let s;
    if (lastStudent && chance(prof.skew)) s = lastStudent;
    else s = pick(active);
    lastStudent = s;

    const name = nameOf(s) || 'みんな';
    if (chance(prof.pLong)) push('T', pick(TEACHER_LONG), jitter(6, 2));
    else if (chance(prof.pCompCheck)) push('T', pick(TEACHER_COMP_CHECK), jitter(5, 2));
    else if (chance(prof.pEmpty)) push('T', pick(TEACHER_EMPTY_CHECK), jitter(4, 2));
    else push('T', name + pick(TEACHER_QUESTIONS), jitter(5, 2));

    const wait = Math.max(0.5, jitter(prof.waitMean, 1.4));

    if (chance(prof.pCorrection)) {
      const pair = pick(ERROR_PAIRS);
      push(s, pair.bad, wait);
      if (chance(0.75)) push('T', pair.good, jitter(2.5, 1)); // リキャスト
      else push('T', pair.bad.split('、')[0] + 'じゃなくて、' + pair.good, jitter(2.5, 1)); // 明示的訂正
      if (chance(prof.pUptake)) push(s, pair.good, jitter(2.5, 1)); // 取り込み
    } else {
      push(s, pick(PLAIN_STUDENT), wait);
      if (chance(prof.pRephrase)) push('T', pick(TEACHER_REPHRASE), jitter(2.5, 1));
      else push('T', pick(TEACHER_SHORT), jitter(2, 1));
    }

    if (chance(prof.pClarify)) {
      push('T', pick(CLARIFY), jitter(2.5, 1));
      push(s, pick(PLAIN_STUDENT), jitter(3, 1.5));
    }
    // 自発の発話
    if (chance(0.12)) push(pick(active), pick(PLAIN_STUDENT), jitter(2, 1));
    // 先生が話しすぎる分
    if (chance(prof.teacherTurnBias - 0.4)) push('T', pick(TEACHER_LONG), jitter(4, 2));
  }
  return us;
}

// ================= 生成 =================
function run() {
  for (const c of store.COLLECTIONS) store.replaceAll(c, []);
  store.setSetting('demo_mode', true);

  const today = new Date('2026-08-18T00:00:00Z');
  const dayOffset = (n) => isoDate(today.getTime() - n * 86400000);

  // --- 人 ---
  const admin = store.insert('users', { id: 'u_admin', name: '運営（デモ）', role: 'admin', arm: null, status: 'active', demo: true });
  const mentorA = store.insert('users', { id: 'u_mentorA', name: 'メンターA（人間中心）', role: 'mentor', arm: 'A', status: 'active', demo: true });
  const mentorB = store.insert('users', { id: 'u_mentorB', name: 'メンターB（AI中心）', role: 'mentor', arm: 'B', status: 'active', demo: true });
  const rater1 = store.insert('users', { id: 'u_rater1', name: '外部評定者1（盲検）', role: 'rater', arm: null, status: 'active', demo: true });
  const rater2 = store.insert('users', { id: 'u_rater2', name: '外部評定者2（盲検）', role: 'rater', arm: null, status: 'active', demo: true });

  const teamA = store.insert('teams', { id: 'tm_A', name: 'チームA（免許あり）', mentorId: mentorA.id, arm: 'A', memberIds: [], demo: true });
  const teamB = store.insert('teams', { id: 'tm_B', name: 'チームB（免許なし・海外在住）', mentorId: mentorB.id, arm: 'B', memberIds: [], demo: true });

  const facs = [];
  const defs = [
    { name: '伊藤（デモ）', arm: 'A', licensed: true, region: '日本' },
    { name: '大野（デモ）', arm: 'A', licensed: true, region: '日本' },
    { name: '木村（デモ）', arm: 'A', licensed: true, region: '日本' },
    { name: '佐藤（デモ）', arm: 'B', licensed: false, region: '米国・カリフォルニア' },
    { name: '田中（デモ）', arm: 'B', licensed: false, region: '米国・テキサス' },
    { name: '中村（デモ）', arm: 'B', licensed: false, region: '米国・ニューヨーク' },
  ];
  for (const d of defs) {
    const u = store.insert('users', {
      id: id('u'), name: d.name, role: 'facilitator', arm: d.arm, licensed: d.licensed, region: d.region,
      teamId: d.arm === 'A' ? teamA.id : teamB.id,
      startedAt: dayOffset(120), readyAt: dayOffset(d.arm === 'A' ? 95 : 78), leftAt: null,
      status: 'active', demo: true,
    });
    facs.push(u);
    (d.arm === 'A' ? teamA : teamB).memberIds.push(u.id);
  }
  store.update('teams', teamA.id, { memberIds: teamA.memberIds });
  store.update('teams', teamB.id, { memberIds: teamB.memberIds });

  // --- デモ用の合言葉（本番では set-passcode.js で入れ直すこと） ---
  for (const u of store.all('users')) store.update('users', u.id, auth.hashPasscode(DEMO_PASSCODE));

  // --- クラスと子ども（8人×6クラス） ---
  const NAMES = ['あかり', 'はると', 'ゆい', 'そうた', 'みお', 'れん', 'さくら', 'ゆうと',
    'ひなた', 'りく', 'あおい', 'かえで', 'しおり', 'たける', 'なぎ', 'ふうた'];
  const classes = [];
  facs.forEach((f, i) => {
    const studentIds = [];
    for (let k = 0; k < 8; k += 1) {
      const nm = NAMES[(i * 8 + k) % NAMES.length] + (i + 1);
      const s = store.insert('students', {
        id: `st_${i}_${k}`, name: nm, arm: f.arm, classId: null,
        joinedAt: dayOffset(70), status: chance(0.08) ? 'left' : 'active', demo: true,
        // デモなので同意済みにしてある。実データでは画面から1人ずつ記録すること。
        consent: { obtainedAt: dayOffset(72), by: '保護者（デモ）', method: '書面', note: '', recordedBy: 'u_admin' },
      });
      studentIds.push(s.id);
    }
    const c = store.insert('classes', {
      id: `cl_${i}`, name: `${f.arm}${i + 1}組（8人）`, facilitatorId: f.id, teamId: f.teamId,
      arm: f.arm, capacity: 8, studentIds, schedule: '週2回・45分', demo: true,
    });
    for (const sid of studentIds) store.update('students', sid, { classId: c.id });
    classes.push(c);
  });

  // --- モデル版を1つ凍結してから採点する（凍結前のスコアを残さない） ---
  const fp = computeFingerprint('local-heuristic');
  const mv = store.insert('modelVersions', {
    id: 'mv_1', label: 'v1（デモ凍結）', notes: '8月に凍結。以降のスコアはすべてこの版。', frozen: true,
    frozenAt: new Date('2026-08-18T09:00:00Z').toISOString(), frozenBy: admin.id, ...fp,
  });

  // --- 授業（8週間 × 週2回 × 6人 = 96本） ---
  const WEEKS = 8;
  const lessons = [];
  for (let w = 0; w < WEEKS; w += 1) {
    for (let d = 0; d < 2; d += 1) {
      classes.forEach((c, ci) => {
        const f = facs[ci];
        const date = dayOffset((WEEKS - w) * 7 - d * 3);
        const lesson = store.insert('lessons', {
          id: id('ls'), classId: c.id, facilitatorId: f.id, arm: f.arm, date,
          durationMin: 45, attendance: 8 - (chance(0.15) ? 1 : 0), note: '', demo: true,
          createdAt: new Date().toISOString(),
        });
        const prof = profileFor(f.licensed ? 'licensed' : 'novice', w);
        const nameOf = (sid) => (store.get('students', sid) || {}).name;
        const us = makeTranscript(c.studentIds, prof, nameOf).map((u, k) => ({
          id: id('ut'), lessonId: lesson.id, seq: k, t: u.t, speaker: u.speaker, text: u.text,
        }));
        store.insertMany('utterances', us);
        lessons.push(lesson);
      });
    }
  }

  // --- 採点と所見 ---
  let scored = 0;
  for (const l of lessons) {
    const sc = runScoring(l, { modelVersion: mv });
    try { makeFeedback(sc); } catch { /* 人格語が混ざったら所見を作らない */ }
    scored += 1;
  }

  // --- 外部評定者2名による盲検二重コーディング（16本） ---
  const sample = lessons.filter((_, i) => i % 6 === 0).slice(0, 16);
  for (const l of sample) {
    const sc = store.all('scores').find((s) => s.lessonId === l.id);
    if (!sc) continue;
    for (const rater of [rater1, rater2]) {
      const dims = {};
      for (const [code, v] of Object.entries(sc.dims)) {
        // 人間はAIとだいたい合うが、ずれる。ここのずれ幅がそのまま IRR になる
        let lv = v.level + (chance(0.30) ? (chance(0.5) ? 1 : -1) : 0);
        dims[code] = Math.max(0, Math.min(4, lv));
      }
      store.insert('ratings', {
        id: id('rt'), lessonId: l.id, raterId: rater.id, blind: true, windowMinutes: 15,
        dims, note: '', createdAt: new Date().toISOString(), demo: true,
      });
    }
  }

  // --- 子どものアンケート（2サイクル）---
  const ITEMS = ['CI1', 'CI2', 'TD1', 'TD2', 'CF1', 'CF2', 'NM1', 'SC1', 'SC2', 'SC3', 'BL1', 'BL2'];
  for (const cycle of ['2026-C1', '2026-C2']) {
    facs.forEach((f, i) => {
      const base = f.licensed ? 4.0 : 3.4 + (cycle === '2026-C2' ? 0.4 : 0);
      const klass = classes[i];
      // 配布リンク（子どもはログインしない）
      const cyc = store.insert('surveyCycles', {
        id: id('sy'), classId: klass.id, facilitatorId: f.id, arm: f.arm, cycle,
        token: `demo-${klass.id}-${cycle}`, open: cycle === '2026-C2',
        createdAt: new Date().toISOString(), createdBy: admin.id, demo: true,
      });
      // 回答には子どものIDを残さない（誰が何と答えたかを、こちら側で分からなくするため）
      for (let r = 0; r < 7; r += 1) {
        const answers = {};
        for (const it of ITEMS) answers[it] = Math.max(1, Math.min(5, Math.round(jitter(base, 0.9))));
        store.insert('surveyResponses', {
          id: id('sr'), facilitatorId: f.id, classId: klass.id, cycleId: cyc.id, studentId: null, arm: f.arm,
          cycle, answers, createdAt: new Date().toISOString(), demo: true,
        });
      }
    });
  }
  // 返し方の3手順。Aは全部やっている。Bは1人だけ抜けている（設計なしの回を見せるため）
  const cycleMeta = {};
  facs.forEach((f, i) => {
    for (const cycle of ['2026-C1', '2026-C2']) {
      const key = `${f.id}|${cycle}`;
      const full = !(f.arm === 'B' && i === 5 && cycle === '2026-C1');
      cycleMeta[key] = {
        returned_at: new Date().toISOString(),
        action_declared_at: full ? new Date().toISOString() : undefined,
        discussed_with_students_at: full ? new Date().toISOString() : undefined,
        action: full ? '指名のあと3つ数えてから次に行く' : undefined,
      };
    }
  });
  store.setSetting('survey_cycles', cycleMeta);

  // --- メンターの記録（毎日1行）---
  // A：人間メンターが1人あたり週45分。B：AIが所見を出し、人間は週12分だけ触る
  for (let w = 0; w < WEEKS; w += 1) {
    for (const f of facs) {
      const isA = f.arm === 'A';
      const mentor = isA ? mentorA : mentorB;
      const date = dayOffset((WEEKS - w) * 7 - 1);
      const minutes = isA ? Math.round(jitter(45, 8)) : Math.round(jitter(12, 4));
      store.insert('mentorLogs', {
        id: id('ml'), mentorId: mentor.id, facilitatorId: f.id, arm: f.arm, date, week: weekKey(date),
        minutes, kind: isA ? 'observation' : 'feedback',
        note: isA ? '授業を見て所見を書いた' : 'AIの所見を確認して、1か所だけ直した',
        createdAt: new Date().toISOString(), demo: true,
      });
    }
  }

  // --- 週次のチーム会（フォーマンセル）---
  for (let w = 0; w < WEEKS; w += 1) {
    for (const team of [teamA, teamB]) {
      const date = dayOffset((WEEKS - w) * 7 - 5);
      store.insert('meetings', {
        id: id('mt'), teamId: team.id, date, attendeeIds: team.memberIds,
        declarations: team.memberIds.map((mid) => ({
          facilitatorId: mid, dimension: pick(['TD', 'SC', 'CF']),
          action: pick([
            '指名したあと3つ数えてから次に行く',
            '開始5分以内に全員に1回ずつ順番を回す',
            '言い直したあと「もう一回言ってみて」を足す',
          ]),
        })),
        note: '', createdAt: new Date().toISOString(), demo: true,
      });
    }
  }

  // --- アーカイブ（問いつきクリップ）---
  const clipSource = lessons.filter((_, i) => i % 11 === 0).slice(0, 8);
  for (const l of clipSource) {
    const sc = store.all('scores').find((s) => s.lessonId === l.id);
    const ev = sc && sc.events.find((e) => ['uptake', 'recast', 'short_wait'].includes(e.type));
    const clip = store.insert('clips', {
      id: id('cl'), lessonId: l.id, tStart: ev ? Math.max(0, ev.t - 10) : 120,
      tEnd: ev ? ev.t + 20 : 150, dimension: ev && ev.type === 'short_wait' ? 'SC' : 'CF',
      title: ev ? `${ev.at} の場面` : '導入の場面',
      prompt: 'この30秒で、子どもが言い直すきっかけになったのは、先生のどの一言ですか。時刻で答えてください。',
      createdAt: new Date().toISOString(), views: [], demo: true,
    });
    for (const f of facs) {
      if (!chance(0.45)) continue;
      clip.views.push({
        userId: f.id, at: new Date().toISOString(), date: l.date,
        answer: '直後の言い直しだと思います。' + (ev ? ev.at : '02:00') + ' あたりです。',
      });
    }
    store.update('clips', clip.id, { views: clip.views });
  }

  // --- 費用（ingredients method）---
  const costItems = [
    { label: '募集広告・スカウト', category: '採用', actor: 'vendor', arm: null, jpy: 180000, qty: 1 },
    { label: '書類・面接（落とした人の分も含む）', category: '採用', actor: 'staff', arm: null, hours: 60, qty: 1, note: '49名落として1名採る分' },
    { label: '事前研修の設計・運営', category: '研修', actor: 'staff', arm: null, hours: 40, qty: 1 },
    { label: '事前研修の受講（本人の時間）', category: '研修', actor: 'facilitator', arm: 'A', hours: 40, qty: 3 },
    { label: '事前研修の受講（本人の時間）', category: '研修', actor: 'facilitator', arm: 'B', hours: 60, qty: 3, note: '未経験のぶん長い' },
    { label: '人間メンターの伴走', category: '伴走', actor: 'mentor', arm: 'A', hours: 6, qty: 3, note: '週45分 × 8週' },
    { label: '人間メンターの確認（AIの所見を直す）', category: '伴走', actor: 'mentor', arm: 'B', hours: 1.6, qty: 3, note: '週12分 × 8週' },
    { label: 'チーム週次（本人の時間）', category: '伴走', actor: 'facilitator', arm: 'A', hours: 8, qty: 3 },
    { label: 'チーム週次（本人の時間）', category: '伴走', actor: 'facilitator', arm: 'B', hours: 8, qty: 3 },
    { label: 'Ranius の運用（サーバ・LLM）', category: 'システム', actor: 'vendor', arm: 'B', jpy: 24000, qty: 1 },
  ];
  for (const c of costItems) store.insert('costItems', { id: id('ci'), qty: 1, hours: 0, jpy: 0, ...c, demo: true });

  store.flush();

  const n = (c) => store.all(c).length;
  console.log('');
  console.log('  デモデータを作りました（⚠️ すべてデモ。実績ではありません）');
  console.log(`  ファシリテーター ${facs.length}名 / クラス ${n('classes')} / 子ども ${n('students')}名`);
  console.log(`  授業 ${n('lessons')}本 / 発話 ${n('utterances')} / スコア ${scored} / 所見 ${n('feedbacks')}`);
  console.log(`  盲検二重コーディング ${sample.length}本 / アンケート ${n('surveyResponses')}件`);
  console.log(`  メンター記録 ${n('mentorLogs')}行 / クリップ ${n('clips')} / 費用項目 ${n('costItems')}`);
  console.log('');
  console.log(`  デモ用のログイン：ユーザーID または 名前 ＋ 合言葉「${DEMO_PASSCODE}」`);
  console.log('    u_admin（運営）／ u_mentorA（メンター）／ 伊藤（デモ）（先生）／ u_rater1（外部評定者）');
  console.log('    ⚠️ 実データを入れる前に node scripts/set-passcode.js で入れ直すこと');
  console.log('');
  console.log('  次: node server/index.js  →  http://localhost:5173');
  console.log('');
}

run();
