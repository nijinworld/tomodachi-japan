'use strict';
// node test/run.js
// 依存なしの最小テスト。ここで守っているのは「事業の約束」です。
// 機能のテストではなく、外してはいけない挙動のテストを優先しています。
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

// 本物の data/ を絶対に触らない。store は RANIUS_DATA_DIR を見る。
const TMP = path.join(__dirname, '.tmp-data');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
process.env.RANIUS_DATA_DIR = TMP;

const restore = () => {
  // 終了時に store が書き戻すので、消すのは exit の直前
  process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));
};

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push(['ok', name]);
  } catch (e) {
    results.push(['NG', `${name}\n     ${e.message}`]);
  }
}
async function testAsync(name, fn) {
  try {
    await fn();
    results.push(['ok', name]);
  } catch (e) {
    results.push(['NG', `${name}\n     ${e.message}`]);
  }
}

const { moraCount, overlap, findPersonalityTerms } = require('../server/lib/ja');
const { analyze } = require('../server/lib/transcript');
const { scoreLesson, computeFingerprint } = require('../server/lib/scoring');
const feedback = require('../server/lib/feedback');
const irr = require('../server/lib/irr');
const cost = require('../server/lib/cost');
const mentorload = require('../server/lib/mentorload');
const survey = require('../server/lib/survey');
const kill = require('../server/lib/kill');
const store = require('../server/lib/store');
const api = require('../server/routes/api');
const auth = require('../server/lib/auth');

// ---- テスト用の人と、その人としてAPIを叩くための道具 ----
const PEOPLE = [
  { id: 'u_a', name: '管理者', role: 'admin' },
  { id: 'u_m', name: 'メンター', role: 'mentor', arm: 'A', teamId: 'tm_x' },
  { id: 'u_f1', name: '先生1', role: 'facilitator', arm: 'A', teamId: 'tm_x' },
  { id: 'u_f2', name: '先生2', role: 'facilitator', arm: 'B', teamId: 'tm_y' },
  { id: 'u_r', name: '評定者', role: 'rater' },
];
for (const person of PEOPLE) store.insert('users', { status: 'active', ...person, ...auth.hashPasscode('test-passcode') });
store.insert('teams', { id: 'tm_x', name: 'X', mentorId: 'u_m', arm: 'A', memberIds: ['u_f1'] });

const as = (uid) => ({ cookie: `ranius_session=${auth.issue(uid)}` });
const call = (method, path, opts = {}) => api.handle({
  method, path, query: opts.query || {}, body: opts.body || {}, headers: opts.as ? as(opts.as) : {},
});
async function expectFail(promise, code, label) {
  let got = null;
  try { await promise; } catch (e) { got = e.code || e.status; }
  assert.strictEqual(got, code, `${label}: ${code} を期待したが ${got}`);
}

// ---- 日本語の数え方 ----
test('モーラ数：がっこう=4（文字数ではない）', () => {
  assert.strictEqual(moraCount('がっこう'), 4);
});
test('モーラ数：拗音の小書きは数えない（きょう=2）', () => {
  assert.strictEqual(moraCount('きょう'), 2);
});
test('言い直しの重なりが取れる', () => {
  assert.ok(overlap('きのう、学校に いきます', 'きのう、学校に いったんだね') > 0.4);
  assert.ok(overlap('きのう、学校に いきます', 'あしたは 雨です') < 0.4);
});

// ---- 書き起こしの分析 ----
const UTT = [
  { t: 5, speaker: 'T', text: 'あかりさん、きのうは なにを しましたか？' },
  { t: 9, speaker: 's1', text: 'きのう、学校に いきます' },
  { t: 12, speaker: 'T', text: 'きのう、学校に いったんだね' },
  { t: 15, speaker: 's1', text: 'きのう、学校に いったんだね' },
  { t: 20, speaker: 'T', text: 'はるとさん、どう おもう？' },
  { t: 21, speaker: 's2', text: 'たのしかったです' },
  { t: 24, speaker: 'T', text: 'わかった？' },
];

test('取り込み（uptake）を検出する', () => {
  const { signals } = analyze(UTT, { roster: ['s1', 's2', 's3'] });
  assert.strictEqual(signals.correction_count, 1);
  assert.strictEqual(signals.uptake_count, 1);
  assert.strictEqual(signals.uptake_rate, 1);
});

test('発話していない子を検出する', () => {
  const { signals } = analyze(UTT, { roster: ['s1', 's2', 's3'] });
  assert.strictEqual(signals.silent_student_count, 1);
});

test('「わかった？」は内容を問わない確認として数える', () => {
  const { signals } = analyze(UTT, { roster: ['s1', 's2'] });
  assert.strictEqual(signals.empty_check_count, 1);
});

test('「どこがわからない？」は聞き返しではなく理解確認', () => {
  const { signals } = analyze([{ t: 3, speaker: 'T', text: 'どこがわからない？' }], { roster: ['s1'] });
  assert.strictEqual(signals.clarification_request_count, 0);
  assert.ok(signals.comprehension_check_per_10min > 0);
});

test('冒頭15分の外は見ない', () => {
  const { signals } = analyze([...UTT, { t: 1000, speaker: 'T', text: 'これは窓の外です' }], { roster: ['s1'] });
  assert.ok(signals.duration_sec < 900);
});

// ---- 採点 ----
test('採点は決定的（同じ入力から同じスコア）', () => {
  const a = scoreLesson(UTT, { roster: ['s1', 's2', 's3'] });
  const b = scoreLesson(UTT, { roster: ['s1', 's2', 's3'] });
  assert.deepStrictEqual(a.dims, b.dims);
  assert.strictEqual(a.overall, b.overall);
});

test('すべての観点に根拠か信号が付く', () => {
  const s = scoreLesson(UTT, { roster: ['s1', 's2', 's3'] });
  for (const d of Object.values(s.dims)) {
    assert.ok(d.level >= 0 && d.level <= 4, `${d.code} の帯が範囲外`);
    assert.ok(typeof d.value === 'number');
  }
});

test('モデル版の指紋は、rubric を変えたら変わる', () => {
  const fp1 = computeFingerprint('local-heuristic');
  const fp2 = computeFingerprint('gpt-x');
  assert.notStrictEqual(fp1.fingerprint, fp2.fingerprint, 'LLMを変えたら別の版になるはず');
  assert.ok(fp1.rubric_sha256.length === 64);
});

// ---- 事業の約束 ----
test('人格に触れる語を検出する', () => {
  assert.deepStrictEqual(findPersonalityTerms('熱意が足りません'), ['熱意']);
  assert.deepStrictEqual(findPersonalityTerms('07:22 で指名が4回続きました'), []);
});

test('所見は人格ではなく時刻と行動で書かれる', () => {
  const s = scoreLesson(UTT, { roster: ['s1', 's2', 's3'] });
  const f = feedback.generate(s, []);
  assert.strictEqual(findPersonalityTerms(f.body).length, 0);
  assert.ok(f.body.includes('【次の1手】'));
  assert.ok(f.action_step.length > 0);
});

test('所見に人格語が混ざったら例外になる', () => {
  const s = scoreLesson(UTT, { roster: ['s1', 's2', 's3'] });
  const originals = {};
  for (const [code, tpl] of Object.entries(feedback.TEMPLATES)) {
    originals[code] = tpl.action;
    tpl.action = () => 'もっとやる気を出しましょう';
  }
  let threw = false;
  try { feedback.generate(s, []); } catch (e) { threw = e.code === 'PERSONALITY_TERM'; }
  for (const [code, fn] of Object.entries(originals)) feedback.TEMPLATES[code].action = fn;
  assert.ok(threw, '人格語が入った所見は生成できてはいけない');
});

// ---- 指標の計算 ----
test('二次重みつきカッパ：完全一致は1', () => {
  assert.strictEqual(irr.quadraticWeightedKappa([0, 1, 2, 3, 4], [0, 1, 2, 3, 4]), 1);
});
test('二次重みつきカッパ：逆順は負', () => {
  assert.ok(irr.quadraticWeightedKappa([0, 1, 2, 3, 4], [4, 3, 2, 1, 0]) < 0);
});

test('費用：受講者時間を0円で置くと安く見える', () => {
  const items = [{ label: '研修', category: '研修', actor: 'facilitator', arm: 'B', hours: 40, qty: 1 }];
  const r = cost.report(items, { wages: { wage_minimum: 1000, wage_equivalent: 3000 }, facilitatorsTrained: { A: 1, B: 1 } });
  assert.strictEqual(r.scenarios.zero.arms.B.cost_per_facilitator, 0);
  assert.strictEqual(r.scenarios.minimum.arms.B.cost_per_facilitator, 40000);
  assert.strictEqual(r.scenarios.equivalent.arms.B.cost_per_facilitator, 120000);
});

test('メンター担当数：記録がなければ 0 ではなく未測定', () => {
  const r = mentorload.summary([]);
  assert.strictEqual(r.measured, false);
  assert.strictEqual(r.ratio_b_over_a, null);
});

test('アンケート：回答が4件未満なら集計を返さない', () => {
  const few = [1, 2, 3].map(() => ({ answers: { CI1: 4 } }));
  assert.strictEqual(survey.aggregate(few).suppressed, true);
});

test('アンケート：返し方の3手順が揃って初めて d=0.568 側', () => {
  assert.strictEqual(survey.designCompliance({ returned_at: 'x' }).expected_d, 0.05);
  assert.strictEqual(survey.designCompliance({
    returned_at: 'x', action_declared_at: 'y', discussed_with_students_at: 'z',
  }).expected_d, 0.568);
});

test('撤退基準：セーフガーディング1件で全停止', () => {
  const r = kill.evaluate({ open_incident_count: 1 });
  assert.strictEqual(r.halt_all, true);
});
test('撤退基準：測っていない指標は「触れていない」に数えない', () => {
  const r = kill.evaluate({ open_incident_count: 0 });
  assert.strictEqual(r.halt_all, false);
  assert.ok(r.unmeasured.includes('mentor_load_ratio'.replace('mentor_load_ratio', 'mentor_load_ratio')) || r.unmeasured.length > 0);
});

// ---- API の禁止事項 ----
(async () => {
  await testAsync('API：ログインしていないと401', async () => {
    await expectFail(call('GET', '/api/lessons'), 'UNAUTHENTICATED', '未ログイン');
  });

  await testAsync('API：先生の順位づけは403', async () => {
    await expectFail(call('GET', '/api/lessons', { as: 'u_a', query: { sort: 'overall' } }), 'RANKING_FORBIDDEN', '順位');
  });

  await testAsync('API：評定者は授業一覧も詳細も見られない', async () => {
    await expectFail(call('GET', '/api/lessons', { as: 'u_r' }), 'FORBIDDEN', '一覧');
  });

  await testAsync('アーム：先生には見せない（運営とメンターには見せる）', async () => {
    store.insert('lessons', { id: 'ls_arm', classId: 'cl_t', facilitatorId: 'u_f1', arm: 'B', date: '2026-08-05', attendance: 8 });
    const mine = await call('GET', '/api/lessons', { as: 'u_f1' });
    assert.ok(!JSON.stringify(mine.body).includes('"arm"'), '先生の画面にアームを出さない');
    const sess = await call('GET', '/api/session', { as: 'u_f1' });
    assert.strictEqual(sess.body.user.arm, undefined, 'ログイン情報にもアームを入れない');
    const admin = await call('GET', '/api/lessons', { as: 'u_a' });
    assert.ok(JSON.stringify(admin.body).includes('"arm"'), '運営には見せる');
    const mentor = await call('GET', '/api/lessons', { as: 'u_m' });
    assert.ok(JSON.stringify(mentor.body).includes('"arm"'), 'メンターには見せる');
  });

  await testAsync('API：先生は自分の授業しか見えない', async () => {
    store.insert('classes', { id: 'cl_t', name: 'T組', facilitatorId: 'u_f1', arm: 'A', capacity: 8, studentIds: ['st_t1'] });
    store.insert('students', { id: 'st_t1', name: 'ひみつの名前', classId: 'cl_t', arm: 'A', status: 'active' });
    store.insert('lessons', { id: 'ls_t', classId: 'cl_t', facilitatorId: 'u_f1', arm: 'A', date: '2026-08-01', attendance: 8 });
    const mine = await call('GET', '/api/lessons', { as: 'u_f1' });
    assert.ok(mine.body.some((l) => l.id === 'ls_t'), '自分の授業は見える');
    const other = await call('GET', '/api/lessons', { as: 'u_f2' });
    assert.ok(!other.body.some((l) => l.id === 'ls_t'), '他人の授業は見えてはいけない');
    await expectFail(call('GET', '/api/lessons/ls_t', { as: 'u_f2' }), 'FORBIDDEN', '他人の授業詳細');
  });

  await testAsync('API：合言葉のハッシュはどこからも出ない', async () => {
    const r = await call('GET', '/api/users', { as: 'u_a' });
    const json = JSON.stringify(r.body);
    assert.ok(!json.includes('"hash"'), 'hash が漏れている');
    assert.ok(!json.includes('"salt"'), 'salt が漏れている');
  });

  await testAsync('API：子どもの名前は評定者に見えない', async () => {
    const q = await call('GET', '/api/blind/queue', { as: 'u_r' });
    assert.ok(Array.isArray(q.body.queue));
    const detail = await call('GET', '/api/blind/lessons/ls_t', { as: 'u_r' });
    const json = JSON.stringify(detail.body);
    assert.ok(!json.includes('ひみつの名前'), '子どもの名前が漏れている');
    assert.ok(!json.includes('u_f1'), '先生のIDが漏れている');
    assert.ok(!json.includes('"arm"'), 'アームが漏れている');
  });

  await testAsync('API：評定者は他人の名前で採点を保存できない', async () => {
    // 契約の5軸・1〜5で送る（旧い 0〜4 の観点ではない）
    const dims = {
      psychological_safety_and_participation_choice: 3,
      dialogic_co_construction: 3,
      productive_departure_and_response: 3,
      concrete_abstract_cycle: 3,
      output_quality_and_transformation: 3,
    };
    await expectFail(
      call('POST', '/api/lessons/ls_t/ratings', { as: 'u_r', body: { raterId: 'u_a', dims } }),
      'FORBIDDEN', 'なりすまし',
    );
  });

  await testAsync('採点：軸を1つでも落としたら保存できない', async () => {
    await expectFail(
      call('POST', '/api/lessons/ls_t/ratings', {
        as: 'u_r',
        body: { raterId: 'u_r', dims: { psychological_safety_and_participation_choice: 3 } },
      }),
      400, '未入力',
    );
  });

  await testAsync('採点：判定不能は低い点ではなく、別に記録される', async () => {
    const r = await call('POST', '/api/lessons/ls_t/ratings', {
      as: 'u_r',
      body: {
        raterId: 'u_r',
        dims: { psychological_safety_and_participation_choice: 4, dialogic_co_construction: 3 },
        na: ['productive_departure_and_response', 'concrete_abstract_cycle', 'output_quality_and_transformation'],
      },
    });
    assert.strictEqual(r.body.rubricVersion, 'nijin-nihongo-1.0.0', '版を必ず残す');
    assert.strictEqual(r.body.na.length, 3);
    assert.ok(r.body.dims.productive_departure_and_response === undefined, '判定不能に点を入れない');
  });

  await testAsync('採点：0 は使えない（判定不能は na で表す）', async () => {
    await expectFail(
      call('POST', '/api/lessons/ls_t/ratings', {
        as: 'u_r',
        body: {
          raterId: 'u_r',
          dims: {
            psychological_safety_and_participation_choice: 0,
            dialogic_co_construction: 3,
            productive_departure_and_response: 3,
            concrete_abstract_cycle: 3,
            output_quality_and_transformation: 3,
          },
        },
      }),
      400, '0は不可',
    );
  });

  await testAsync('API：アンケートの回答に子どものIDが残らない', async () => {
    const cyc = await call('POST', '/api/surveys/cycles', { as: 'u_a', body: { classId: 'cl_t', cycle: '2026-T1' } });
    const token = cyc.body.token;
    const form = await api.handle({ method: 'GET', path: `/api/survey/${token}`, query: {}, body: {}, headers: {} });
    assert.ok(form.body.items.length > 0, '項目が返る');
    const spec0 = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'spec', 'survey.ja.json'), 'utf8'));
    const all = {};
    for (const it of spec0.items) all[it.code] = 4;
    await api.handle({ method: 'POST', path: `/api/survey/${token}`, query: {}, body: { answers: all }, headers: {} });
    const saved = store.all('surveyResponses').find((r) => r.cycleId === cyc.body.id);
    assert.strictEqual(saved.studentId, null, '回答に studentId を残してはいけない');
  });

  await testAsync('API：人格語を含む所見は422', async () => {
    await expectFail(
      call('POST', '/api/feedbacks', { as: 'u_a', body: { facilitatorId: 'u_f1', body: 'やる気が足りません' } }),
      'PERSONALITY_TERM', '人格語',
    );
  });

  await testAsync('API：問いのないクリップは作れない', async () => {
    await expectFail(call('POST', '/api/clips', { as: 'u_a', body: { lessonId: 'x', tStart: 0 } }), 400, '問いなし');
  });

  // ---- 監査で見つかった穴。ふさいだことを固定する ----
  await testAsync('監査：評定者はクリップから先生やアームに辿れない', async () => {
    await expectFail(call('GET', '/api/clips', { as: 'u_r' }), 'FORBIDDEN', 'クリップ');
    await expectFail(call('GET', '/api/meetings', { as: 'u_r' }), 'FORBIDDEN', '週次');
    await expectFail(call('GET', '/api/incidents', { as: 'u_r' }), 'FORBIDDEN', '事案');
  });

  await testAsync('監査：クリップ一覧に授業レコードを素で載せない', async () => {
    store.insert('clips', {
      id: 'cl_t', lessonId: 'ls_t', tStart: 0, tEnd: 30, title: 'x',
      prompt: 'この30秒で何が起きましたか', views: [], createdAt: 'x',
    });
    const r = await call('GET', '/api/clips', { as: 'u_f1' });
    const json = JSON.stringify(r.body);
    assert.ok(!json.includes('facilitatorId'), '先生IDが漏れている');
    assert.ok(!json.includes('"arm"'), 'アームが漏れている');
  });

  await testAsync('監査：他人あての所見は ack できない（本文も返さない）', async () => {
    const fb = store.insert('feedbacks', {
      id: 'fb_t', facilitatorId: 'u_f1', arm: 'A', kind: 'ai', body: '【見えたこと】ひみつの本文', createdAt: 'x',
    });
    await expectFail(call('POST', `/api/feedbacks/${fb.id}/ack`, { as: 'u_f2' }), 'FORBIDDEN', '他人の所見');
    const okRes = await call('POST', `/api/feedbacks/${fb.id}/ack`, { as: 'u_f1' });
    assert.ok(!JSON.stringify(okRes.body).includes('ひみつの本文'), '所見の本文を返してはいけない');
  });

  await testAsync('監査：先生は他の先生のアンケートを見られない', async () => {
    store.insert('surveyResponses', {
      id: 'sr_t', facilitatorId: 'u_f2', classId: null, cycleId: null, studentId: null,
      arm: 'B', cycle: '2026-T9', answers: { CI1: 4, CI2: 4, TD1: 4, TD2: 4 }, createdAt: 'x',
    });
    const r = await call('GET', '/api/surveys', { as: 'u_f1' });
    assert.ok(!r.body.cycles.some((c) => c.facilitatorId === 'u_f2'), '他人のサイクルが見えている');
  });

  await testAsync('監査：先生は他人の「返し方」を記録できない', async () => {
    await expectFail(
      call('POST', '/api/surveys/steps', { as: 'u_f1', body: { facilitatorId: 'u_f2', cycle: '2026-T9', step: 'returned_at' } }),
      'FORBIDDEN', '他人の手順',
    );
  });

  await testAsync('監査：先生はチーム一覧から全員を列挙できない', async () => {
    const r = await call('GET', '/api/teams', { as: 'u_f1' });
    const json = JSON.stringify(r.body);
    assert.ok(!json.includes('u_f2'), '他チームの人が見えている');
  });

  await testAsync('監査：先生はメンターの所見を自作できない（担当数が動くため）', async () => {
    await expectFail(
      call('POST', '/api/feedbacks', { as: 'u_f1', body: { facilitatorId: 'u_f1', body: '00:10 に指名した', kind: 'mentor', mentorMinutes: 600 } }),
      'FORBIDDEN', 'メンター所見の自作',
    );
    assert.ok(!store.all('mentorLogs').some((m) => m.mentorId === 'u_f1'), 'メンター記録に入ってはいけない');
  });

  await testAsync('監査：クリップの視聴は名乗りではなくセッションで記録する', async () => {
    await call('POST', '/api/clips/cl_t/view', { as: 'u_f1', body: { userId: 'u_f2', answer: '02:14 の言い直しです' } });
    const clip = store.get('clips', 'cl_t');
    assert.strictEqual(clip.views[0].userId, 'u_f1', 'body の userId を信じてはいけない');
  });

  await testAsync('監査：手入力のアンケート回答にも子どものIDを残さない', async () => {
    await expectFail(
      call('POST', '/api/surveys/responses', { as: 'u_a', body: { facilitatorId: 'u_f1', cycle: '2026-T8', answers: { CI1: 4 }, studentId: 'st_t1' } }),
      400, '手入力のstudentId',
    );
  });

  await testAsync('監査：子ども用アンケートは全項目必須で、上限がある', async () => {
    const cyc = await call('POST', '/api/surveys/cycles', { as: 'u_a', body: { classId: 'cl_t', cycle: '2026-T7' } });
    const token = cyc.body.token;
    const post = (answers) => api.handle({ method: 'POST', path: `/api/survey/${token}`, query: {}, body: { answers }, headers: {} });
    await expectFail(post({ CI1: 4 }), 400, '部分回答');
    const spec = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'spec', 'survey.ja.json'), 'utf8'));
    const full = {};
    for (const it of spec.items) full[it.code] = 4;
    // 名簿1人 + 4 = 5件まで
    for (let i = 0; i < 5; i += 1) await post(full);
    await expectFail(post(full), 'SURVEY_FULL', '上限');
  });

  await testAsync('監査：全角のクッキーで 500 にならない', async () => {
    let status = null;
    try {
      await api.handle({
        method: 'GET', path: '/api/lessons', query: {}, body: {},
        headers: { cookie: `ranius_session=u_a.9999999999999.${'あ'.repeat(32)}` },
      });
    } catch (e) { status = e.status; }
    assert.strictEqual(status, 401, '401 で返すこと（500 にしない）');
  });

  // ---- 子どものデータの扱い ----
  await testAsync('同意：同意のない子どもの発話は取り込めない', async () => {
    const text = '00:00:05 先生: なにを しましたか？\n00:00:09 あかり: こうえんに いきました\n';
    const mapping = { 先生: 'T', あかり: 'st_t1' };
    await expectFail(
      call('POST', '/api/import/lesson', { as: 'u_a', body: { classId: 'cl_t', date: '2026-08-01', text, mapping } }),
      'CONSENT_REQUIRED', '同意なしの取り込み',
    );
  });

  await testAsync('同意：記録すれば取り込め、撤回すればまた止まる', async () => {
    const text = '00:00:05 先生: なにを しましたか？\n00:00:09 あかり: こうえんに いきました\n';
    const mapping = { 先生: 'T', あかり: 'st_t1' };
    await call('POST', '/api/students/st_t1/consent', {
      as: 'u_a', body: { obtainedAt: '2026-07-01', by: '保護者', method: '書面' },
    });
    const r = await call('POST', '/api/import/lesson', { as: 'u_a', body: { classId: 'cl_t', date: '2026-08-01', text, mapping } });
    assert.ok(r.body.lesson.id, '取り込めること');

    await call('POST', '/api/students/st_t1/consent/withdraw', { as: 'u_a', body: {} });
    await expectFail(
      call('POST', '/api/import/lesson', { as: 'u_a', body: { classId: 'cl_t', date: '2026-08-02', text, mapping } }),
      'CONSENT_REQUIRED', '撤回後',
    );
    // 後片付け（あとのテストが同意ありを前提にするため）
    await call('POST', '/api/students/st_t1/consent', {
      as: 'u_a', body: { obtainedAt: '2026-07-01', by: '保護者', method: '書面' },
    });
  });

  await testAsync('記録：書き起こしを開いたら閲覧の記録が残る', async () => {
    const before = store.all('auditLog').filter((x) => x.action === 'lesson.transcript.view').length;
    await call('GET', '/api/lessons/ls_t', { as: 'u_f1' });
    const after = store.all('auditLog').filter((x) => x.action === 'lesson.transcript.view').length;
    assert.strictEqual(after, before + 1, '閲覧が記録されること');
    const last = store.all('auditLog').filter((x) => x.action === 'lesson.transcript.view').pop();
    assert.strictEqual(last.actor, 'u_f1');
  });

  await testAsync('保存期間：状況が数えられている', async () => {
    const r = await call('GET', '/api/retention', { as: 'u_a' });
    assert.ok(r.body.retention_days > 0);
    assert.strictEqual(r.body.require_consent, true, '既定で同意の確認は有効');
    assert.ok(r.body.consent.total >= 1);
  });

  await testAsync('在籍：退会にすると leftAt が入る', async () => {
    const r = await call('PATCH', '/api/students/st_t1', { as: 'u_a', body: { status: 'left' } });
    assert.strictEqual(r.body.status, 'left');
    assert.ok(r.body.leftAt, '退会日が入ること');
    await call('PATCH', '/api/students/st_t1', { as: 'u_a', body: { status: 'active' } });
    assert.strictEqual(store.get('students', 'st_t1').leftAt, null, '戻したら消えること');
  });

  await testAsync('監査ログ：運営しか見られない', async () => {
    await expectFail(call('GET', '/api/audit', { as: 'u_m' }), 'FORBIDDEN', 'メンター');
    const r = await call('GET', '/api/audit', { as: 'u_a' });
    assert.ok(r.body.total > 0);
  });

  await testAsync('API：事案を1件記録すると全機能が止まる', async () => {
    await call('POST', '/api/incidents', { as: 'u_f1', body: { summary: 'テスト事案' } });
    await expectFail(call('GET', '/api/lessons', { as: 'u_a' }), 'HALTED', '停止');
  });

  await testAsync('API：公表日なしに事案はクローズできない', async () => {
    const inc = store.all('incidents')[0];
    await expectFail(call('POST', `/api/incidents/${inc.id}/close`, { as: 'u_a', body: { resolution: 'x' } }), 400, 'クローズ');
  });

  await testAsync('認証：合言葉が違えばログインできない', async () => {
    await expectFail(
      api.handle({ method: 'POST', path: '/api/session', query: {}, body: { userId: 'u_a', passcode: 'まちがい' }, headers: {} }),
      'BAD_CREDENTIALS', 'ログイン失敗',
    );
    const okRes = await api.handle({
      method: 'POST', path: '/api/session', query: {}, body: { userId: 'u_a', passcode: 'test-passcode' }, headers: {},
    });
    assert.ok(okRes.cookie && okRes.cookie.includes('HttpOnly'), 'HttpOnly のクッキーを返すこと');
    assert.ok(!JSON.stringify(okRes.body).includes('hash'), 'ハッシュを返してはいけない');
  });

  await testAsync('認証：偽造したセッションは通らない', async () => {
    await expectFail(
      api.handle({ method: 'GET', path: '/api/lessons', query: {}, body: {}, headers: { cookie: 'ranius_session=u_a.9999999999999.deadbeef' } }),
      'UNAUTHENTICATED', '偽造',
    );
  });

  // ---- 結果 ----
  restore();
  const ng = results.filter((r) => r[0] === 'NG');
  console.log('');
  for (const [s, name] of results) console.log(`  ${s === 'ok' ? '  ok' : '  NG'}  ${name}`);
  console.log('');
  console.log(`  ${results.length - ng.length} / ${results.length} 通過`);
  console.log('');
  process.exit(ng.length ? 1 : 0);
})();
