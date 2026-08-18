'use strict';
/* Ranius日本語 — 画面。
   守っていること：
     ・先生どうしを並べない。順位を出さない。
     ・数字には必ずエビデンスのバッジを付ける。未検証は未検証と書く。
     ・デモデータのときは、画面の上に常にそう出す。 */

const $ = (sel, el = document) => el.querySelector(sel);
const main = $('#main');
let META = null;
let ME = null;

// ---------- 通信 ----------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !opts.noRedirect) {
    ME = null;
    renderLogin('セッションが切れました。もう一度ログインしてください。');
    throw new Error(data.error || 'ログインが必要です');
  }
  if (!res.ok) {
    const err = new Error(data.error || `${res.status}`);
    err.code = data.code;
    err.status = res.status;
    throw err;
  }
  return data;
}

// ---------- 表示の部品 ----------
const esc = (s) => String(s === null || s === undefined ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const n = (v, d = '—') => (v === null || v === undefined || Number.isNaN(v) ? d : v);
const pct = (v) => (v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`);
const yen = (v) => (v === null || v === undefined ? '—' : `¥${Math.round(v).toLocaleString('ja-JP')}`);

function evBadge(evidenceId) {
  if (!META || !evidenceId) return '';
  const item = META.evidence.items[evidenceId];
  if (!item) return '';
  const label = { verified: '検証済み', unverified: '未検証', none: 'エビデンスなし', internal: '自社値' }[item.level];
  return `<span class="badge ${item.level}" title="${esc(item.claim)}／${esc(item.source)}">${label}</span>`;
}

function arm(a) {
  if (!a) return '';
  return `<span class="badge arm${a}">${a}</span>`;
}

function levels(lv, max = 4) {
  let out = '<span class="lv">';
  for (let i = 1; i <= max; i += 1) {
    const cls = i <= lv ? `on ${lv <= 1 ? 'bad' : lv <= 2 ? 'low' : ''}` : '';
    out += `<i class="${cls}"></i>`;
  }
  return `${out}</span>`;
}

function kpi(lab, val, sub, opts = {}) {
  const na = val === '—' || val === null || val === undefined;
  return `<div class="kpi${na ? ' na' : ''}">
    <div class="lab">${lab} ${opts.evidence ? evBadge(opts.evidence) : ''}</div>
    <div class="val${opts.small ? ' small' : ''}">${na ? '未測定' : val}</div>
    <div class="sub">${sub || ''}</div></div>`;
}

function table(cols, rows) {
  return `<table><thead><tr>${cols.map((c) => `<th${c.num ? ' class="num"' : ''}>${c.label}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${cols.map((c) => `<td${c.num ? ' class="num"' : ''}>${r[c.key] === undefined ? '' : r[c.key]}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

function sparkline(values, w = 220, h = 40) {
  if (!values.length) return '<span class="muted">データなし</span>';
  const min = 0; const max = 4;
  const dx = values.length > 1 ? w / (values.length - 1) : 0;
  const pts = values.map((v, i) => `${(i * dx).toFixed(1)},${(h - ((v - min) / (max - min)) * h).toFixed(1)}`);
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <polyline fill="none" stroke="#1f5fd8" stroke-width="2" points="${pts.join(' ')}"/>
    ${values.map((v, i) => `<circle cx="${(i * dx).toFixed(1)}" cy="${(h - ((v - min) / (max - min)) * h).toFixed(1)}" r="2.2" fill="#1f5fd8"/>`).join('')}
  </svg>`;
}

// ---------- ログイン ----------
async function renderLogin(message) {
  const sess = await api('/api/session', { noRedirect: true }).catch(() => ({}));
  document.querySelector('.side').hidden = true;
  main.innerHTML = `<div style="max-width:380px;margin:8vh auto">
    <h1>Ranius日本語</h1>
    <p class="muted">ともだちじゃぱん 運用システム</p>
    ${message ? `<div class="callout warn">${esc(message)}</div>` : ''}
    ${sess.bootstrap_needed ? `<div class="callout bad">
      合言葉がまだ1件も設定されていません。サーバの入っている端末で、次を実行してください。<br>
      <code>node scripts/set-passcode.js --list</code><br>
      <code>node scripts/set-passcode.js &lt;ID&gt; &lt;合言葉&gt;</code></div>` : ''}
    <div class="card">
      <label>ユーザーID または 名前<input id="uid" autocomplete="username" style="width:100%"></label>
      <label>合言葉<input id="pass" type="password" autocomplete="current-password" style="width:100%"></label>
      <div class="row" style="margin-top:12px"><button class="primary" id="login">ログイン</button></div>
      <div id="lmsg"></div>
    </div>
    <p class="note">このシステムには子どもの発話が入ります。共有端末では、使い終わったら必ずログアウトしてください。</p>
  </div>`;
  const submit = async () => {
    const btn = $('#login');
    btn.disabled = true;
    try {
      await api('/api/session', { method: 'POST', noRedirect: true, body: { userId: $('#uid').value.trim(), passcode: $('#pass').value } });
      location.reload();
    } catch (e) {
      $('#lmsg').innerHTML = `<div class="err">${esc(e.message)}</div>`;
      btn.disabled = false;
    }
  };
  $('#login').onclick = submit;
  $('#pass').onkeydown = (e) => { if (e.key === 'Enter') submit(); };
  $('#uid').focus();
}

// ---------- 画面 ----------
const views = {};

views[''] = async function home() {
  if (ME.role === 'facilitator') return facilitatorHome();
  if (ME.role === 'staff') return staffHome();
  const [ks, ab, load, irr, funnel, inst] = await Promise.all([
    api('/api/kill-status'), api('/api/analysis/ab'), api('/api/mentor-load'),
    api('/api/irr'), api('/api/funnel'), api('/api/analysis/instrument'),
  ]);
  const m = ks.metrics;
  const tripped = ks.tripped.filter((t) => t.action !== 'halt_all');

  return `<h1>今週</h1>
  <p class="muted">この事業の律速は「メンター1人あたりの担当可能人数」です。他の数字はすべてこれに従属します。</p>

  ${tripped.length ? `<div class="callout warn"><b>撤退基準に触れています（${tripped.length}件）</b><br>
    ${tripped.map((t) => `・${esc(t.label)}：${esc(t.rule)}（いま ${n(t.value)}）`).join('<br>')}
    <br><a href="#/kill">→ 撤退基準を見る</a></div>` : ''}

  <div class="grid g4">
    ${kpi('メンター1人あたりの担当数（B/A）', m.mentor_load_ratio_b_over_a === null ? '—' : `${m.mentor_load_ratio_b_over_a}倍`,
      '目標 3倍以上／1.0FTE換算', { evidence: 'mentor_load' })}
    ${kpi('B群の授業の質（A比）', m.quality_ratio_b_over_a === null ? '—' : pct(m.quality_ratio_b_over_a), '目標 80%以上', { evidence: 'unverified_rubric' })}
    ${kpi('評価者間一致（人間2名）', m.irr_qwk === null ? '—' : m.irr_qwk, '当社の実測／目標 .65・期限 2026-10-20', { evidence: 'irr_measured' })}
    ${kpi('ファシリテーター1名の養成コスト', '—', '③のシナリオが埋まるまで出しません', { evidence: 'cost_per_facilitator' })}
  </div>

  <h2>いま測れていること</h2>
  <div class="grid g3">
    <div class="card"><h3>授業の記録</h3>
      <div style="font-size:22px;font-weight:800">${ab.arms.A.lessons_scored + ab.arms.B.lessons_scored} 本</div>
      <div class="muted" style="font-size:12px">A ${ab.arms.A.lessons_scored} ／ B ${ab.arms.B.lessons_scored}。冒頭15分を採点しています ${evBadge('met_first15')}</div>
      <div style="margin-top:8px"><a href="#/lessons">→ 授業を見る</a></div>
    </div>
    <div class="card"><h3>メンターの記録</h3>
      <div style="font-size:22px;font-weight:800">${load.entries} 行</div>
      <div class="muted" style="font-size:12px">${load.summary.measured ? '記録から計算しています（推定していません）' : '記録がありません。ここが空だと単価が出ません'}</div>
      <div style="margin-top:8px"><a href="#/mentor">→ 記録する</a></div>
    </div>
    <div class="card"><h3>盲検の二重コーディング</h3>
      <div style="font-size:22px;font-weight:800">${irr.lessons_double_coded} 本</div>
      <div class="muted" style="font-size:12px">評定者 ${irr.raters}名。目標 .65 まで ${irr.human_vs_human ? (0.65 - irr.human_vs_human.overall.qwk > 0 ? `あと ${(0.65 - irr.human_vs_human.overall.qwk).toFixed(3)}` : '到達') : '—'}</div>
      <div style="margin-top:8px"><a href="#/irr">→ IRRを見る</a></div>
    </div>
  </div>

  <h2>まだ測れていないこと</h2>
  <div class="card">
    <p class="muted" style="font-size:12.5px">下は「0」ではなく「未測定」です。混ぜないでください。</p>
    ${table([{ label: '項目', key: 'k' }, { label: '状態', key: 'v' }, { label: 'いつ埋まるか', key: 'w' }], [
      { k: 'ファシリテーター1名の完全負荷養成コスト', v: '未測定 ' + evBadge('cost_per_facilitator'), w: '費用の画面で3シナリオを入れる' },
      { k: 'AIコーチが指導の質を上げるか', v: '世界に検証例なし ' + evBadge('ai_coaching_rct'), w: '12月のA/B（ただし6名では検定不可）' },
      { k: 'AI場面スタディの効果', v: '公表エビデンスなし ' + evBadge('scenario_study'), w: '実配置後の授業スコアと突合するまで不明' },
      { k: 'ルーブリックの妥当性', v: '未検証 ' + evBadge('unverified_rubric'), w: '1,000授業で因子分析＋クロスウォーク' },
      { k: 'アーカイブが先生を伸ばすか', v: '未検証 ' + evBadge('archive_library'), w: '教師固定効果でまず見る（費用ゼロ）' },
    ])}
  </div>

  <h2>器具の状態</h2>
  ${inst.healthy
    ? '<div class="callout ok">AIが採点する観点は、いまのところ差を見分けられています。</div>'
    : `<div class="callout warn"><b>観点のうち ${inst.issues.length} 個に問題があります。</b><br>
      ${inst.issues.map((i) => `・${i.code}：${esc(i.flags[0])}`).join('<br>')}
      <br><a href="#/instrument">→ 器具の健全性を見る</a></div>`}

  <h2>養成ファネル</h2>
  <div class="card">
    ${table([{ label: 'アーム', key: 'arm' }, { label: '開始', key: 's', num: true }, { label: '一人前', key: 'r', num: true },
      { label: '到達率', key: 'rr', num: true }, { label: '中央値（日）', key: 'd', num: true }, { label: '90日継続', key: 'c', num: true }],
    Object.entries(funnel.arms).map(([k, v]) => ({
      arm: arm(k) + ' ' + k, s: v.started, r: v.ready, rr: v.ready_rate === null ? '—' : pct(v.ready_rate),
      d: n(v.median_days_to_ready), c: v.retention_90d === null ? `未測定（n=${v.retention_90d_n}）` : pct(v.retention_90d),
    })))}
    <div class="note">${esc(funnel.note)}</div>
  </div>`;
};

// 先生本人の「今週」。他の先生の数字は1つも出さない。
async function facilitatorHome() {
  const [trend, surveys, meetings, ks] = await Promise.all([
    api(`/api/facilitators/${ME.id}/trend`),
    api(`/api/surveys?facilitatorId=${ME.id}`).catch(() => ({ cycles: [] })),
    api('/api/meetings').catch(() => []),
    api('/api/kill-status'),
  ]);
  const last = trend.feedbacks[0];
  const cyc = surveys.cycles[0];
  const myDecl = meetings
    .filter((m) => (m.declarations || []).some((d) => d.facilitatorId === ME.id))
    .sort((a, b) => (a.date < b.date ? 1 : -1))[0];
  const decl = myDecl ? (myDecl.declarations.find((d) => d.facilitatorId === ME.id) || {}) : null;

  return `<h1>${esc(ME.name)} さんの今週</h1>
  <p class="muted">ここに出るのは、あなた自身の記録だけです。他の先生とは比べません。</p>
  ${ks.status === 'halt' ? `<div class="callout bad">全機能が停止中です：${esc(ks.halt_reason)}</div>` : ''}

  <div class="grid g3">
    ${kpi('採点した授業', `${trend.series.length}本`, 'AIが採点できる観点のみ平均に含む')}
    ${kpi('直近3回の平均', n(trend.comparison.last3_mean), `最初の3回は ${n(trend.comparison.first3_mean)}`)}
    ${kpi('あなたの中での変化', trend.comparison.change === null ? '—' : (trend.comparison.change > 0 ? `+${trend.comparison.change}` : trend.comparison.change), '本人の過去との差だけ')}
  </div>

  <h2>いちばん新しい所見</h2>
  ${last ? `<div class="card"><div class="pre">${esc(last.body || '')}</div>
    <div class="row" style="margin-top:10px">
      ${last.acknowledgedAt ? '<span class="badge verified">読みました</span>' : `<button class="primary" data-ack="${last.id}">読んだ</button>`}
      <a href="#/lesson/${last.lessonId}">→ この授業を開く</a>
    </div></div>`
    : '<div class="card muted">まだ所見がありません。授業の書き起こしが取り込まれると出ます。</div>'}

  <h2>今週やると決めたこと</h2>
  <div class="card">
    ${decl ? `<div style="font-size:15px">「${esc(decl.action)}」</div>
      <div class="muted" style="font-size:12px">${myDecl.date} のチームで宣言（観点 ${decl.dimension || '—'}）</div>`
    : '<span class="muted">まだ宣言がありません。週次のチームで、次の1手を1つだけ選んでください。</span>'}
    <div class="note">3つ選ぶと0個実行されます。1つにしてください。</div>
  </div>

  <h2>子どものアンケート</h2>
  ${cyc ? `<div class="card">
    ${cyc.aggregate.suppressed ? `<div class="callout warn">${esc(cyc.aggregate.note)}</div>`
    : `<div class="grid g4">${Object.entries(cyc.aggregate.dims).map(([k, v]) => kpi(k, v.mean,
      v.delta === null || v.delta === undefined ? `${cyc.cycle}` : `前回比 ${v.delta > 0 ? '+' : ''}${v.delta}`)).join('')}</div>`}
    <div style="margin-top:10px">${cyc.design.steps.map((st) => `<div>${st.ok ? '✅' : '⬜️'} ${esc(st.label)}</div>`).join('')}</div>
    <div class="callout ${cyc.design.compliant ? 'ok' : 'warn'}">${esc(cyc.design.note)}</div>
    <a href="#/surveys">→ アンケートの画面へ</a>
  </div>` : '<div class="card muted">まだ回答がありません。</div>'}

  <h2>推移（あなたの過去とだけ）</h2>
  <div class="card">${sparkline(trend.series.map((x) => x.overall), 420, 60)}
    <div class="note">縦軸は 0〜4。</div>
    <a href="#/facilitator/${ME.id}">→ 観点ごとに見る</a></div>`;
}

async function staffHome() {
  const [cost, load, ks] = await Promise.all([api('/api/cost'), api('/api/mentor-load'), api('/api/kill-status')]);
  const eq = cost.scenarios.equivalent;
  return `<h1>今週（事務）</h1>
  ${ks.tripped.length ? `<div class="callout warn">撤退基準に${ks.tripped.length}件触れています。<a href="#/kill">→ 見る</a></div>` : ''}
  <div class="grid g3">
    ${kpi('費用項目', `${cost.items.length}件`, '3シナリオで計算しています')}
    ${kpi('③でのB/A', n(eq.b_over_a), esc(eq.verdict))}
    ${kpi('メンター記録', `${load.entries}行`, load.summary.measured ? '実測から計算中' : '記録がありません')}
  </div>
  <div class="callout">${esc(cost.headline)}</div>
  <p><a href="#/cost">→ 費用</a>　<a href="#/export">→ 書き出し</a>　<a href="#/settings">→ 設定</a></p>`;
}

// ---------- 盲検の採点（評定者はこの画面しか使えない） ----------
views.blind = async function blind(lessonId) {
  if (lessonId) return blindLesson(lessonId);
  const q = await api('/api/blind/queue');
  return `<h1>盲検の採点</h1>
  <p class="muted">${esc(q.note)}</p>
  <div class="callout">先生の名前・アーム・AIのスコアは表示されません。<b>それが目的です。</b>
    ここが漏れると、評価者間一致が「AIに引っぱられた一致」になり、測る意味がなくなります。</div>
  <div class="grid g3">
    ${kpi('残り', `${q.todo}本`, 'あなたがまだ採点していない授業')}
    ${kpi('採点済み', `${q.done}本`, '')}
    ${kpi('見る範囲', `冒頭${q.window_minutes}分`, '全部見る必要はありません')}
  </div>
  <div class="card">${table([{ label: '授業', key: 'l' }, { label: '発話数', key: 'u', num: true },
    { label: '評定者', key: 'r', num: true }, { label: '', key: 'a' }],
  q.queue.slice(0, 80).map((r) => ({
    l: `<code>${esc(r.lessonId)}</code>${r.priority === 0 ? ' <span class="badge unverified">もう1人ぶん待ち</span>' : ''}`,
    u: r.utterances, r: r.rater_count,
    a: r.rated_by_me ? '<span class="badge verified">採点済み</span>' : `<a href="#/blind/${r.lessonId}">採点する</a>`,
  })))}</div>`;
};

async function blindLesson(lessonId) {
  const d = await api(`/api/blind/lessons/${lessonId}`);
  return `<h1>採点（盲検）</h1>
  <p class="muted"><code>${esc(d.lessonId)}</code>／名簿 ${d.roster_size}人／冒頭${d.window_minutes}分</p>
  <a href="#/blind">← 一覧にもどる</a>
  <h2>観点</h2>
  <div class="card">
    ${d.dimensions.map((dim) => `<div style="margin-bottom:14px">
      <b>${dim.code}｜${esc(dim.name)}</b>
      <div class="muted" style="font-size:12px">${esc(dim.question)}</div>
      <ul class="muted" style="font-size:12px;margin:4px 0 6px">${dim.observable.map((o) => `<li>${esc(o)}</li>`).join('')}</ul>
      <div class="row">${[0, 1, 2, 3, 4].map((v) => `<label style="margin:0"><input type="radio" name="d_${dim.code}" value="${v}"
        ${d.my_rating && d.my_rating[dim.code] === v ? 'checked' : ''}> ${v}</label>`).join('')}</div>
    </div>`).join('')}
    <div class="row"><button class="primary" id="saveBlind">保存する</button>
      <span class="muted">0＝観察できない／4＝一貫して成立</span></div>
    <div id="bmsg"></div>
  </div>
  <h2>書き起こし</h2>
  <div class="utt">${d.utterances.map((u) => `<div class="${u.speaker === '先生' ? 't' : ''}">
    <span class="who">${String(Math.floor(u.t / 60)).padStart(2, '0')}:${String(Math.round(u.t) % 60).padStart(2, '0')} ${esc(u.speaker)}</span>${esc(u.text)}</div>`).join('')}</div>`;
}

// ---------- 書き起こしの取り込み ----------
views.import = async function importView() {
  const classes = await api('/api/classes');
  return `<h1>書き起こしの取り込み</h1>
  <p class="muted">Zoom / Google Meet / WebVTT / SRT / CSV を、そのまま貼り付けてください。形式は自動で判定します。</p>
  <div class="card">
    <div class="row">
      <label style="margin:0">クラス<select id="cls">${classes.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label>
      <label style="margin:0">授業の日<input type="date" id="date" value="${new Date().toISOString().slice(0, 10)}"></label>
      <label style="margin:0">形式<select id="fmt"><option value="">自動</option>
        <option value="webvtt">WebVTT</option><option value="srt">SRT</option><option value="zoom">Zoom</option>
        <option value="plain">プレーン</option><option value="csv">CSV</option><option value="tsv">TSV</option></select></label>
    </div>
    <label>書き起こし<textarea id="text" style="min-height:180px" placeholder="00:00:05.000 --> 00:00:09.000&#10;山田先生: あかりさん、きのうは なにを しましたか？"></textarea></label>
    <div class="row"><button class="primary" id="parse">読み込む</button></div>
    <div id="pmsg"></div>
  </div>
  <div id="mapArea"></div>`;
};

// ---------- 人とクラス（管理） ----------
views.people = async function people() {
  const [users, classes, teams] = await Promise.all([api('/api/users'), api('/api/classes'), api('/api/teams')]);
  const roleLabel = { admin: '運営', mentor: 'メンター', facilitator: '先生', rater: '外部評定者', staff: '事務' };
  return `<h1>人とクラス</h1>
  <h2>人（${users.length}）</h2>
  <div class="card">
    ${table([{ label: '名前', key: 'n' }, { label: 'ID', key: 'i' }, { label: 'ロール', key: 'r' }, { label: 'アーム', key: 'a' },
      { label: '免許', key: 'l' }, { label: '合言葉', key: 'p' }, { label: '', key: 'x' }],
    users.map((u) => ({
      n: esc(u.name), i: `<code>${esc(u.id)}</code>`, r: roleLabel[u.role] || u.role, a: arm(u.arm),
      l: u.role === 'facilitator' ? (u.licensed ? 'あり' : 'なし') : '',
      p: u.has_passcode ? '<span class="badge verified">設定済</span>' : '<span class="badge none">未設定</span>',
      x: `<button data-pass="${u.id}">合言葉を設定</button>`
        + (u.role === 'facilitator' ? ` <button data-ready="${u.id}">${u.readyAt ? '一人前 ' + u.readyAt : '一人前になった日'}</button>`
          + ` <button data-leave="${u.id}">${u.leftAt ? '離任 ' + u.leftAt : '離任'}</button>` : ''),
    })))}
  </div>
  <div class="card">
    <h3>人を足す</h3>
    <div class="row">
      <label style="margin:0">名前<input id="nName" placeholder="山田"></label>
      <label style="margin:0">ロール<select id="nRole">${Object.entries(roleLabel).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
      <label style="margin:0">アーム<select id="nArm"><option value="">—</option><option value="A">A</option><option value="B">B</option></select></label>
      <label style="margin:0">チーム<select id="nTeam"><option value="">—</option>${teams.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select></label>
      <label style="margin:0">教員免許<select id="nLic"><option value="false">なし</option><option value="true">あり</option></select></label>
      <button class="primary" id="addUser">追加</button>
    </div>
    <div id="umsg"></div>
  </div>

  <h2>クラス（${classes.length}）</h2>
  <div class="grid g2">${classes.map((c) => `<div class="card">
    <div class="row" style="justify-content:space-between"><b>${esc(c.name)}</b>${arm(c.arm)}</div>
    <div class="muted" style="font-size:12px">先生：${esc(c.facilitator ? c.facilitator.name : '—')}／${c.studentIds.length}／${c.capacity}人
      ${c.over_capacity ? '<span class="badge none">定員超過</span>' : ''}</div>
    <div style="margin-top:6px">${c.students.length ? c.students.map((st) => `<div class="row" style="gap:6px;font-size:12.5px;margin:2px 0">
      <span style="flex:1">${esc(st.name)}${st.status === 'left' ? ' <span class="badge">退会</span>' : ''}</span>
      ${st.consent_ok ? '<span class="badge verified">同意あり</span>'
    : `<span class="badge none">同意なし</span><button data-consent="${st.id}" style="font-size:10.5px;padding:1px 6px">記録</button>`}
      ${st.status === 'left' ? `<button data-rejoin="${st.id}" style="font-size:10.5px;padding:1px 6px">在籍に戻す</button>`
    : `<button data-left="${st.id}" style="font-size:10.5px;padding:1px 6px">退会</button>`}
    </div>`).join('') : '<span class="muted">まだ子どもがいません</span>'}</div>
    <div class="row" style="margin-top:8px">
      <input data-child="${c.id}" placeholder="子どもの名前" style="width:140px">
      <button data-addchild="${c.id}">子どもを足す</button>
    </div>
  </div>`).join('')}</div>
  <div class="card">
    <h3>クラスを足す</h3>
    <div class="row">
      <label style="margin:0">名前<input id="cName" placeholder="A1組"></label>
      <label style="margin:0">先生<select id="cFac">${users.filter((u) => u.role === 'facilitator').map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}</select></label>
      <label style="margin:0">定員<input type="number" id="cCap" value="8" style="width:70px"></label>
      <button class="primary" id="addClass">追加</button>
    </div>
    <div id="cmsg"></div>
  </div>`;
};

// ---------- チームの週次（フォーマンセル） ----------
views.meetings = async function meetings() {
  const [ms, teams] = await Promise.all([api('/api/meetings'), api('/api/teams')]);
  return `<h1>チームの週次</h1>
  <p class="muted">4〜8名で集まり、<b>次の1手を1つだけ</b>宣言する場です。ここの記録が、アンケートの「返し方」の手順2になります。</p>
  <div class="card">
    <h3>記録する</h3>
    <div class="row">
      <label style="margin:0">チーム<select id="team">${teams.map((t) => `<option value="${t.id}" data-members='${JSON.stringify(t.members.map((m) => ({ id: m.id, name: m.name })))}'>${esc(t.name)}（${t.memberIds.length}名）${t.size_ok ? '' : ' ⚠️4〜8名の外'}</option>`).join('')}</select></label>
      <label style="margin:0">日付<input type="date" id="mdate" value="${new Date().toISOString().slice(0, 10)}"></label>
    </div>
    <div id="declArea"></div>
    <div class="row" style="margin-top:10px"><button class="primary" id="saveMeeting">保存</button></div>
    <div class="note">人格に触れる語（「やる気」など）が入っていると保存できません。行動と時刻で書いてください。</div>
    <div id="mmsg"></div>
  </div>
  <h2>これまで</h2>
  <div class="card">${ms.length ? table([{ label: '日', key: 'd' }, { label: 'チーム', key: 't' }, { label: '出席', key: 'a', num: true }, { label: '宣言', key: 'x' }],
    ms.sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 30).map((m) => ({
      d: m.date, t: esc(m.team ? m.team.name : ''), a: (m.attendeeIds || []).length,
      x: (m.declarations || []).map((x) => `<div>${esc(x.dimension || '')}：${esc(x.action)}</div>`).join('') || '—',
    }))) : '<span class="muted">まだありません</span>'}</div>`;
};

// ---------- 本番の準備 ----------
views.readiness = async function readiness() {
  const r = await api('/api/readiness');
  const groups = {};
  for (const c of r.checks) (groups[c.group] = groups[c.group] || []).push(c);
  const done = r.checks.filter((c) => c.ok).length;
  return `<h1>本番の準備</h1>
  <p class="muted">実データで始められる状態かどうかを、機械で確かめています。
    「たぶん大丈夫」で始めて、あとから抜けに気づくのを防ぐための画面です。</p>
  <div class="callout ${r.ready ? 'ok' : 'warn'}">
    <b>${r.ready ? '始められます。' : `あと ${r.blocking.length} 件そろっていません。`}</b>
    　${done} / ${r.checks.length} 件が満たされています。</div>
  ${Object.entries(groups).map(([g, list]) => `<h2>${esc(g)}</h2>
    <div class="card">${list.map((c) => `<div style="padding:8px 0;border-bottom:1px solid #f0f2f4">
      <div class="row" style="justify-content:space-between">
        <b>${c.ok ? '✅' : c.severity === 'warn' ? '⚠️' : '⬜️'} ${esc(c.label)}</b>
        <span class="muted" style="font-size:12px">${esc(c.detail)}</span>
      </div>
      ${c.ok ? '' : `<div class="muted" style="font-size:12px;margin-top:2px">→ ${esc(c.how)}</div>`}
    </div>`).join('')}</div>`).join('')}
  <div class="callout warn">${esc(r.note)}</div>`;
};

// ---------- 週次サマリ ----------
views.report = async function report() {
  const today = new Date().toISOString().slice(0, 10);
  const asOf = (location.hash.split('?')[1] || '').replace('asOf=', '') || today;
  let r;
  try {
    r = await api(`/api/report/weekly?asOf=${encodeURIComponent(asOf)}`);
  } catch (e) {
    return `<h1>週次サマリ</h1><div class="callout bad">${esc(e.message)}</div>
      <p class="muted">人格に触れる語や、先生どうしを比べる語が混ざっていると、サマリは作られません。
      チームの宣言を書き直してから、もう一度開いてください。</p>`;
  }
  return `<h1>週次サマリ</h1>
  <p class="muted">毎週月曜に5分で読むためのものです。${r.demo ? '<b>いまはデモデータです。</b>' : ''}</p>
  <div class="row">
    <label style="margin:0">基準日<input type="date" id="asOf" value="${esc(asOf)}"></label>
    <button class="primary" id="reload">この日で作る</button>
    <button id="copy">全部コピー</button>
  </div>
  ${r.warnings && r.warnings.length ? `<div class="callout warn">${r.warnings.map(esc).join('<br>')}</div>` : ''}
  <div class="card" style="margin-top:12px"><div class="pre" id="body">${esc(r.text)}</div></div>
  <div class="note">この文面は、そのままチームに貼れます。先生を並べ替えていません。記録がないところは「未測定」と書いてあります。</div>`;
};

// ---------- 子どもの様子 ----------
views.children = async function children() {
  const r = await api('/api/attendance');
  const kindLabel = {
    silent_streak: '来ているのに話していない',
    absent_streak: '続けて休んでいる',
    low_voice: '発話がとても少ない',
  };
  const kindNote = {
    silent_streak: '出席した直近3回、一度も発話が数えられていません。',
    absent_streak: '直近3回続けて欠席しています。',
    low_voice: '期間全体で、話した回が4分の1に届いていません。',
  };
  const byKind = {};
  for (const f of r.flags) (byKind[f.kind] = byKind[f.kind] || []).push(f);

  return `<h1>子どもの様子</h1>
  <div class="callout"><b>これは先生を評価する画面ではありません。</b>
    8人のオンラインで3回続けて一度も話していない子は、たいてい次にいなくなります。
    辞める前に気づくための画面です。<b>先生の名前は出しません。</b></div>

  ${r.flags.length ? Object.entries(byKind).map(([kind, list]) => `<h2>${kindLabel[kind]}（${list.length}人）</h2>
    <div class="card">
      <p class="muted" style="font-size:12.5px">${kindNote[kind]}</p>
      ${table([{ label: '子ども', key: 'n' }, { label: 'クラス', key: 'c' }, { label: 'いつから', key: 's' }, { label: '中身', key: 'd' }],
    list.map((f) => ({ n: `<b>${esc(f.name)}</b>`, c: esc(f.className || ''), s: f.since || '—', d: esc(f.detail || '') })))}
    </div>`).join('')
    : '<div class="callout ok">いま気になる子は出ていません。<br>'
      + '<span class="muted">これは「静かな子がいない」という意味ではありません。判定に足るデータが無いだけのこともあります。下の表を見てください。</span></div>'}

  <h2>クラスごと</h2>
  <div class="card">${table([{ label: 'クラス', key: 'c' }, { label: '授業', key: 's', num: true },
    { label: '平均の出席', key: 'a', num: true }, { label: '一度も話していない子', key: 'q', num: true }, { label: '気になる子', key: 'f', num: true }],
  r.classes.map((c) => ({ c: esc(c.name || c.classId), s: c.sessions, a: n(c.meanAttendance), q: c.silentChildren, f: c.flaggedChildren })))}</div>

  <h2>子どもごと</h2>
  <div class="card">${table([{ label: '子ども', key: 'n' }, { label: 'クラス', key: 'c' },
    { label: '出席', key: 'a', num: true }, { label: '話した回', key: 'sp', num: true },
    { label: '発話の割合', key: 'r', num: true }, { label: '連続で無言', key: 'st', num: true }, { label: '', key: 'f' }],
  r.students.map((x) => ({
    n: esc(x.name), c: esc(x.className || ''),
    a: `${x.attended}/${x.sessions}`,
    sp: `${x.spokeSessions}/${x.spokeKnownSessions === undefined ? x.attended : x.spokeKnownSessions}`,
    r: x.spokeRate === null || x.spokeRate === undefined ? '不明' : pct(x.spokeRate),
    st: x.silentStreak || 0,
    f: (x.flags || []).map((k) => `<span class="badge none">${kindLabel[k]}</span>`).join(' '),
  })))}
    <div class="note">「話した回」の分母は、発話が数えられた回だけです（採点されていない授業は分母に入れません）。
      <b>不明を「話していない」に寄せない</b>ためです。</div>
  </div>

  ${r.warnings && r.warnings.length ? `<h2>この集計の弱いところ</h2>
  <div class="card"><p class="muted" style="font-size:12.5px">推測で埋めた部分です。実データでは出席をそのまま記録してください。</p>
    ${r.warnings.slice(0, 8).map((w) => `<div style="font-size:12.5px">・${esc(w)}</div>`).join('')}
    ${r.warnings.length > 8 ? `<div class="muted" style="font-size:12px">ほか ${r.warnings.length - 8} 件</div>` : ''}
  </div>` : ''}`;
};

// ---------- 保存と閲覧の記録 ----------
views.records = async function records() {
  const canAudit = ME.role === 'admin';
  const [r, audit] = await Promise.all([
    api('/api/retention'),
    canAudit ? api('/api/audit?limit=60') : Promise.resolve(null),
  ]);
  const cons = r.consent;
  return `<h1>保存と閲覧の記録</h1>
  <p class="muted">子どものことばを、いつまで持ち、誰が見たか。保護者に説明できる状態を保つための画面です。</p>

  <h2>保護者の同意</h2>
  <div class="grid g4">
    ${kpi('同意あり', `${cons.recorded}人`, `全 ${cons.total}人`)}
    ${kpi('未記録', `${cons.missing}人`, cons.missing ? '⚠️ この子の発話は取り込めません' : '—')}
    ${kpi('撤回', `${cons.withdrawn}人`, cons.withdrawn ? 'purge が必要です' : '—')}
    ${kpi('同意の確認', r.require_consent ? '有効' : '<b style="color:#b3261e">無効</b>', r.require_consent ? '同意なしの取り込みを止めます' : '⚠️ 実データでは有効にすること')}
  </div>
  ${cons.missing ? '<div class="callout warn">同意が記録されていない子どもがいます。「人とクラス」で記録してください。'
    + '記録するまで、その子が話している授業は取り込めません。</div>' : ''}

  <h2>書き起こしの保存期間</h2>
  <div class="grid g4">
    ${kpi('保存期間', `${r.retention_days}日`, `${r.cutoff} より前が対象`)}
    ${kpi('書き起こしのある授業', `${r.lessons_with_transcript}本`, `発話 ${r.utterances_total.toLocaleString('ja-JP')}件`)}
    ${kpi('期限を過ぎた授業', `${r.lessons_overdue}本`, r.lessons_overdue ? '⚠️ 消す時期です' : '—')}
    ${kpi('最後に消した日', r.last_purge_at ? r.last_purge_at.slice(0, 10) : '—', '')}
  </div>
  <div class="callout">${esc(r.note)}</div>
  <div class="card">
    <h3>消し方</h3>
    <div class="pre">node scripts/purge.js --dry-run     # 何が消えるか見る
node scripts/purge.js               # 消す
node scripts/purge.js --student &lt;ID&gt;  # 同意を撤回した子のことばだけ消す</div>
    <div class="note">画面からは実行しません。消したものは戻せないので、意図して端末で叩く形にしています。</div>
  </div>

  ${canAudit ? `<h2>閲覧の記録</h2>
  <div class="card">
    <div class="row" style="gap:14px;margin-bottom:10px">${Object.entries(audit.counts).sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([k, v]) => `<span class="muted" style="font-size:12px"><b>${v}</b> ${esc(k)}</span>`).join('')}</div>
    ${table([{ label: '日時', key: 't' }, { label: '誰が', key: 'w' }, { label: '何を', key: 'a' }, { label: '対象', key: 'g' }],
    audit.rows.map((x) => ({
      t: x.at.slice(0, 16).replace('T', ' '), w: esc(x.actorName || '—'),
      a: esc(x.action), g: `<code>${esc(x.target || '')}</code>${x.detail ? ` <span class="muted">${esc(x.detail)}</span>` : ''}`,
    })))}
    <div class="note">全 ${audit.total} 件のうち新しい60件。書き起こしを開いた記録（lesson.transcript.view / blind.transcript.view）と、
      書き出し・合言葉の変更・事案・同意が残ります。</div>
  </div>` : ''}`;
};

// ---------- 書き出し ----------
views.export = async function exportView() {
  const e = await api('/api/export');
  return `<h1>書き出し</h1>
  <p class="muted">${esc(e.note)}</p>
  <div class="callout">外部の統計解析（R / Stata / Python）と、AEA事前登録に添える集計のためのものです。
    <b>子どもの名前と識別子は、どのファイルにも入りません。</b></div>
  <div class="grid g2">${e.datasets.map((d) => `<div class="card">
    <b>${esc(d.label)}</b> <code>${esc(d.id)}</code>
    <div class="muted" style="font-size:12px">${esc(d.description || '')}</div>
    <div class="muted" style="font-size:11.5px;margin-top:6px">列：${d.columns.map((c) => esc(c.label || c.key)).join('、')}</div>
    <div style="margin-top:8px"><a href="/api/export/${d.id}" download><button>CSVを保存</button></a></div>
  </div>`).join('')}</div>`;
};

views.lessons = async function lessons() {
  const list = await api('/api/lessons?limit=120');
  const codes = META.rubric.dimensions.map((d) => d.code);
  return `<h1>授業と採点</h1>
  <p class="muted">冒頭15分だけを採点しています（全体の約6割の信頼性 ${evBadge('met_first15')}。45分の授業なら観察時間は約1/3で済む＝当社の運用上の計算）。
    <b>先生どうしの並べ替えはできません。</b>比較対象は本人の過去だけです。</p>
  <div class="card">
  ${table([
    { label: '日付', key: 'date' }, { label: 'クラス', key: 'cls' }, { label: '先生', key: 'fac' }, { label: 'アーム', key: 'arm' },
    ...codes.map((c) => ({ label: c, key: c })), { label: '平均', key: 'ov', num: true }, { label: '', key: 'act' },
  ], list.map((l) => {
    const r = { date: l.date, cls: esc(l.className), fac: esc(l.facilitator), arm: arm(l.arm), ov: l.overall === null ? '—' : l.overall.toFixed(2), act: `<a href="#/lesson/${l.id}">開く</a>` };
    for (const c of codes) r[c] = l.dims ? levels(l.dims[c]) : '—';
    return r;
  }))}
  </div>`;
};

views.lesson = async function lesson(id) {
  const d = await api(`/api/lessons/${id}`);
  const sc = d.scores.find((s) => s.source === 'ai');
  const fb = d.feedbacks.find((f) => f.kind === 'ai');
  const rubric = META.rubric;

  const dimCards = sc ? rubric.dimensions.map((rd) => {
    const v = sc.dims[rd.code];
    return `<div class="card">
      <div class="row" style="justify-content:space-between">
        <b>${rd.code}｜${esc(rd.name)}${v.rater === 'human' ? ' <span class="badge unverified">人間評定が主</span>' : ''}</b>
        <span>${levels(v.level)} <b>${v.level}</b>/4</span>
      </div>
      ${v.rater === 'human' ? `<div class="muted" style="font-size:11.5px">${esc(rd.rater_note || '')}</div>` : ''}
      <div class="muted" style="font-size:12px">${esc(rd.question)}（指標 ${v.indicator} = ${v.value}）</div>
      <div class="tl">${v.evidence.length
        ? v.evidence.map((e) => `<div><span class="at">${e.at}</span>${esc(e.note)}
            <button data-clip-at="${e.t}" data-clip-dim="${rd.code}" style="font-size:10.5px;padding:1px 6px;margin-left:4px">切り出す</button>
            ${e.text ? `<br><span class="muted">「${esc(e.text)}」</span>` : ''}</div>`).join('')
        : `<div class="muted">気になる場面は検出されませんでした。この観点で数えた値：<br>
            ${rd.signals.map((sg) => `${esc(sg)} = <b>${n(sc.signals[sg])}</b>`).join('／')}</div>`}</div>
    </div>`;
  }).join('') : '<div class="callout warn">まだ採点されていません。</div>';

  const s = sc ? sc.signals : null;
  return `<h1>${esc(d.class ? d.class.name : '')} ／ ${d.lesson.date} ${arm(d.lesson.arm)}</h1>
  <p class="muted">先生：${esc(d.facilitator ? d.facilitator.name : '')}　出席 ${d.lesson.attendance}人
    モデル版 <code>${sc ? esc(sc.modelVersionId) : '—'}</code> ${sc && sc.frozen ? '<span class="badge verified">凍結済み</span>' : '<span class="badge unverified">未凍結</span>'}</p>
  <div class="row"><button class="primary" id="rescore">この授業を採点し直す</button>
    <a href="#/facilitator/${d.lesson.facilitatorId}"><button>この先生の推移</button></a>
    <button id="toggleClip">この授業から30秒を切り出す</button></div>
  <div id="msg"></div>
  <div class="card" id="clipForm" hidden>
    <h3>アーカイブに残す</h3>
    <p class="muted" style="font-size:12.5px">見る人への<b>問い</b>が要ります。問いのない視聴は、効果が確認されていません。</p>
    <div class="row">
      <label style="margin:0">見出し<input id="clTitle" placeholder="07:22 の場面" style="width:150px"></label>
      <label style="margin:0">開始（秒）<input type="number" id="clStart" value="0" style="width:90px"></label>
      <label style="margin:0">長さ（秒）<input type="number" id="clLen" value="30" style="width:80px"></label>
      <label style="margin:0">観点<select id="clDim"><option value="">—</option>
        ${META.rubric.dimensions.map((x) => `<option value="${x.code}">${x.code}｜${esc(x.name)}</option>`).join('')}</select></label>
    </div>
    <label>見る人への問い<textarea id="clPrompt" style="min-height:56px"
      placeholder="この30秒で、子どもが言い直すきっかけになったのは、先生のどの一言ですか。時刻で答えてください。"></textarea></label>
    <div class="row"><button class="primary" id="saveClip">アーカイブに入れる</button></div>
    <div id="clmsg"></div>
  </div>

  <h2>観点と根拠</h2>
  <div class="grid g2">${dimCards}</div>

  ${s ? `<h2>数えた値（signals）</h2><div class="card">
    <div class="grid g4">
      ${kpi('先生の話す量', pct(s.teacher_talk_ratio), 'モーラ比', {})}
      ${kpi('1発話の長さ', `${s.teacher_mean_mora}`, 'モーラ（平均）', {})}
      ${kpi('待ち時間', `${n(s.wait_time_median_sec)}秒`, '指名→応答の中央値', {})}
      ${kpi('取り込み率', s.uptake_rate === null ? '—' : pct(s.uptake_rate), `訂正 ${s.correction_count}回中 ${s.uptake_count}回`, { evidence: 'unverified_rubric' })}
      ${kpi('発話の偏り', `${n(s.student_turn_gini)}`, 'ジニ係数。0が平等', {})}
      ${kpi('話していない子', `${s.silent_student_count}人`, `名簿 ${s.roster_size}人`, {})}
      ${kpi('聞き返し・確認', `${s.clarification_request_count + s.confirmation_check_count}回`, `うち修復まで ${s.repair_episode_count}回`, {})}
      ${kpi('「わかった？」', `${s.empty_check_count}回`, '内容を問わない確認', {})}
    </div></div>` : ''}

  <h2>NIJIN 評価契約の形</h2>
  <div class="card" id="contractBox">
    <p class="muted" style="font-size:12.5px">同じ授業を、Ranius プラットフォームの契約（不変条件つき）に通した結果です。
      上の 0〜4 表示より厳しく出ます。<b>対外説明にはこちらを使ってください。</b></p>
    <button id="loadContract">契約の形で見る</button>
    <div id="contractOut"></div>
  </div>

  ${fb ? `<h2>AIの所見</h2><div class="card"><div class="pre">${esc(fb.body)}</div>
    <div class="note">人格に触れる語が入っていたら、システムは保存を拒否します。</div></div>` : ''}

  ${ME.role === 'admin' ? `<h2>盲検の採点（外部評定者）</h2>
  <div class="card">
    <p class="muted" style="font-size:12.5px">代理入力用です。評定者本人は「盲検の採点」画面から入れてください
      （この画面には先生の名前とAIのスコアが出ているため、評定者には開かせません）。</p>
    <div class="row">
      <select id="rater">${(await api('/api/users?role=rater')).map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}</select>
      ${rubric.dimensions.map((rd) => `<label style="margin:0">${rd.code}
        <select data-dim="${rd.code}">${[0, 1, 2, 3, 4].map((i) => `<option>${i}</option>`).join('')}</select></label>`).join('')}
      <button class="primary" id="saveRating">保存</button>
    </div>
    <div id="rmsg"></div>
    ${d.ratings.length ? table([{ label: '評定者', key: 'r' }, { label: '観点', key: 'd' }, { label: '入力日', key: 't' }],
    d.ratings.map((r) => ({ r: esc(r.raterId), d: Object.entries(r.dims).map(([k, v]) => `${k}:${v}`).join(' / '), t: r.createdAt.slice(0, 10) }))) : ''}
  </div>` : `${d.ratings.length ? `<h2>盲検の採点</h2><div class="card">
    <span class="muted">外部評定者 ${new Set(d.ratings.map((r) => r.raterId)).size}名が採点済みです（中身は見えません）。</span></div>` : ''}`}

  <h2>書き起こし（冒頭15分）</h2>
  <div class="utt">${d.utterances.filter((u) => u.t < 900).map((u) => `<div class="${u.speaker === 'T' ? 't' : ''}">
    <span class="who">${String(Math.floor(u.t / 60)).padStart(2, '0')}:${String(Math.round(u.t) % 60).padStart(2, '0')} ${u.speaker === 'T' ? '先生' : esc((d.speakerLabels || {})[u.speaker] || u.speaker)}</span>${esc(u.text)}</div>`).join('')}</div>`;
};

views.facilitators = async function facilitators() {
  const us = await api('/api/users?role=facilitator');
  return `<h1>先生（ファシリテーター）</h1>
  <div class="callout">この画面には順位も平均比較もありません。ひとりずつ、本人の過去とだけ比べます。</div>
  <div class="grid g3">${us.map((u) => `<div class="card">
    <div class="row" style="justify-content:space-between"><b>${esc(u.name)}</b>${arm(u.arm)}</div>
    <div class="muted" style="font-size:12px">${u.licensed ? '教員免許あり' : '教員免許なし'}／${esc(u.region || '')}</div>
    <div style="margin-top:8px"><a href="#/facilitator/${u.id}">→ 推移を見る</a></div>
  </div>`).join('')}</div>`;
};

views.facilitator = async function facilitator(id) {
  const t = await api(`/api/facilitators/${id}/trend`);
  const codes = META.rubric.dimensions.map((d) => d.code);
  const series = t.series;
  return `<h1>${esc(t.facilitator.name)} ${arm(t.facilitator.arm)}</h1>
  <p class="muted">${t.comparison.basis}</p>
  ${t.warning ? `<div class="callout bad">${esc(t.warning)}</div>` : ''}
  <div class="grid g4">
    ${kpi('採点した授業', `${series.length}本`, 'AIが採点できる観点のみ平均に含む')}
    ${kpi('最初の3回の平均', n(t.comparison.first3_mean), '5観点の平均（0〜4）')}
    ${kpi('直近3回の平均', n(t.comparison.last3_mean), '5観点の平均（0〜4）')}
    ${kpi('変化', t.comparison.change === null ? '—' : (t.comparison.change > 0 ? `+${t.comparison.change}` : t.comparison.change), '本人の中での差')}
  </div>
  <h2>推移</h2>
  <div class="card">
    <div class="row" style="gap:20px;align-items:flex-start">
      <div><div class="muted" style="font-size:12px">平均（0〜4）</div>${sparkline(series.map((s) => s.overall), 420, 60)}</div>
      ${codes.map((c) => `<div><div class="muted" style="font-size:12px">${c}</div>${sparkline(series.map((s) => s.dims[c]), 130, 44)}</div>`).join('')}
    </div>
    <div class="note">縦軸は 0〜4。モデル版が混ざると比較できません。混ざったら再スコアしてください。</div>
  </div>
  <h2>所見の履歴</h2>
  <div class="card">${t.feedbacks.length ? table([{ label: '日', key: 'd' }, { label: '観点', key: 'c' }, { label: '次の1手', key: 'a' }, { label: '種類', key: 'k' }],
    t.feedbacks.map((f) => ({ d: f.createdAt.slice(0, 10), c: f.dimension || '—', a: esc(f.action_step || ''), k: f.kind === 'ai' ? 'AI' : '人' }))) : '<span class="muted">まだありません</span>'}</div>`;
};

views.surveys = async function surveys() {
  const canDistribute = ['admin', 'mentor'].includes(ME.role);
  const [s, cycles, classes] = await Promise.all([
    api('/api/surveys'),
    api('/api/surveys/cycles'),
    canDistribute ? api('/api/classes') : Promise.resolve([]),
  ]);
  const rules = s.spec.design_rationale.rules;
  return `<h1>子どものアンケート</h1>
  <p class="muted">効果 d=0.27 ${evBadge('student_survey')}。ただし効果のほぼ全部は「返し方」に載っています：
    設計あり <b>d=0.568</b>／なし <b>d=0.050</b> ${evBadge('student_survey_design')}</p>
  <div class="card"><h3>この設計で守っていること</h3>
    ${rules.map((r) => `<div>・${esc(r.rule)}${r.d_with ? `（${r.d_with}${r.d_without !== null && r.d_without !== undefined ? ` vs ${r.d_without}` : ''}）` : ''}</div>`).join('')}
  </div>

  <h2>配布リンク</h2>
  <div class="card">
    <p class="muted" style="font-size:12.5px">子どもはログインしません。このリンクを渡すだけです。
      <b>誰が何と答えたかは、システムにも残りません。</b></p>
    ${canDistribute ? `<div class="row">
      <label style="margin:0">クラス<select id="scls">${classes.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label>
      <label style="margin:0">回<input id="scycle" placeholder="2026-C3" style="width:120px"></label>
      <button class="primary" id="mkCycle">リンクを作る</button>
    </div><div id="cycmsg"></div>` : ''}
    ${cycles.length ? table([{ label: 'クラス', key: 'c' }, { label: '回', key: 'y' }, { label: '回答', key: 'n', num: true },
      { label: 'リンク', key: 'u' }, { label: '', key: 'x' }],
    cycles.map((c) => ({
      c: esc(c.className || ''), y: esc(c.cycle), n: c.responses,
      u: c.open ? `<a href="${c.url}" target="_blank">開く</a> <button data-copy="${esc(c.url)}">コピー</button>`
        : '<span class="muted">締め切り済み</span>',
      x: c.open && canDistribute ? `<button data-close="${c.id}">締め切る</button>` : '',
    }))) : '<span class="muted">まだリンクがありません。</span>'}
  </div>
  ${s.cycles.map((c) => `<h2>${esc(c.facilitator)} ${arm(c.arm)}｜${c.cycle}</h2>
    <div class="card">
      ${c.aggregate.suppressed
    ? `<div class="callout warn">${esc(c.aggregate.note)}（回答 ${c.aggregate.n}件）</div>`
    : `<div class="grid g4">${Object.entries(c.aggregate.dims).map(([k, v]) => kpi(k, v.mean,
      v.delta === null || v.delta === undefined ? `回答 ${c.aggregate.n}件` : `前回比 ${v.delta > 0 ? '+' : ''}${v.delta}`)).join('')}</div>
      ${(c.aggregate.belonging || []).map((b) => `<div class="callout" style="margin-top:10px">
        <b>${esc(b.label)}：${b.mean}</b> <span class="badge">点数化しない</span><br>
        <span class="muted">${esc(b.note)}</span></div>`).join('')}`}
      <h3>返し方（この3つが揃って初めて効きます）</h3>
      ${c.design.steps.map((st) => `<div class="row" style="gap:8px;margin:3px 0">
        <span>${st.ok ? '✅' : '⬜️'}</span><span style="flex:1">${esc(st.label)}</span>
        ${st.ok ? '' : `<button data-step="${st.key}" data-fac="${c.facilitatorId}" data-cycle="${esc(c.cycle)}">できた</button>`}
      </div>`).join('')}
      <div class="callout ${c.design.compliant ? 'ok' : 'warn'}">${esc(c.design.note)}</div>
    </div>`).join('')}`;
};

views.mentor = async function mentor() {
  const [ml, users] = await Promise.all([api('/api/mentor-load'), api('/api/users')]);
  const mentors = users.filter((u) => u.role === 'mentor');
  const facs = users.filter((u) => u.role === 'facilitator');
  const s = ml.summary;
  return `<h1>メンターの記録</h1>
  <p class="muted">この事業の全論拠です。推定しません。毎日1行の記録からしか計算しません ${evBadge('mentor_load')}</p>
  ${!s.measured ? `<div class="callout warn">${esc(s.note)}</div>` : `
  <div class="grid g3">
    ${Object.entries(s.arms).map(([k, v]) => kpi(`アーム${k}：1人が支えている人数`, `${v.mean_facilitators_per_mentor_week}人`,
    `週あたり ${v.mean_hours_per_mentor_week}時間 → 1.0FTE換算で ${n(v.mean_load_at_1fte)}人`, { evidence: 'mentor_load' })).join('')}
    ${kpi('B / A', s.ratio_b_over_a === null ? '—' : `${s.ratio_b_over_a}倍`, `目標 ${s.target_ratio}倍以上`, { evidence: 'mentor_load' })}
  </div>
  <div class="callout warn">${esc(s.note)}</div>`}

  <h2>記録する（1行）</h2>
  <div class="card">
    <div class="row">
      <label style="margin:0">メンター<select id="m">${mentors.map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}</select></label>
      <label style="margin:0">ファシリテーター<select id="f">${facs.map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}</select></label>
      <label style="margin:0">日付<input type="date" id="date" value="${new Date().toISOString().slice(0, 10)}"></label>
      <label style="margin:0">分<input type="number" id="min" value="30" style="width:80px"></label>
      <label style="margin:0">種類<select id="kind">
        <option value="observation">授業を見た</option><option value="feedback">所見を返した</option>
        <option value="meeting">チーム会</option><option value="other">その他</option></select></label>
      <button class="primary" id="save">記録する</button>
    </div>
    <div id="msg"></div>
  </div>

  <h2>週ごと</h2>
  <div class="card">${table([{ label: '週', key: 'w' }, { label: 'アーム', key: 'a' }, { label: 'メンター', key: 'm' },
    { label: '担当人数', key: 'f', num: true }, { label: '時間', key: 'h', num: true },
    { label: '1人あたり(分)', key: 'p', num: true }, { label: '1.0FTE換算', key: 'l', num: true }],
  ml.weekly.slice(-40).reverse().map((r) => ({
    w: r.week, a: arm(r.arm), m: esc((users.find((u) => u.id === r.mentorId) || {}).name || r.mentorId),
    f: r.facilitators, h: r.hours, p: n(r.minutes_per_facilitator), l: n(r.load_at_1fte),
  })))}</div>`;
};

views.irr = async function irrView() {
  const r = await api('/api/irr');
  const hv = r.human_vs_human;
  return `<h1>評価者間一致（IRR）</h1>
  <p class="muted">目標 .65。<b>当社の実測はまだありません</b>（下の数字はいま入っている採点から計算したものです）。<br>
    目標の根拠：MET Project では評定者2名 × 授業2本で .67 ${evBadge('met_two_raters')}。期限 ${r.deadline}。</p>
  ${!hv ? '<div class="callout warn">まだ二重コーディングがありません。授業の画面から、別々の評定者2名で入れてください。</div>' : `
  <div class="grid g4">
    ${kpi('二次重みつきカッパ', hv.overall.qwk, `n=${hv.overall.n_ratings}（授業 ${hv.overall.n_lessons}本）`, { evidence: 'irr_measured' })}
    ${kpi('完全一致', pct(hv.overall.exact), '同じ数字を付けた割合')}
    ${kpi('±1一致', pct(hv.overall.adjacent), '1段階以内')}
    ${kpi('ICC(2,1)', hv.overall.icc, '連続値としての一致')}
  </div>
  <div class="callout ${hv.passes ? 'ok' : 'warn'}">${hv.passes
    ? '目標 .65 に届いています。ここから先は、ルーブリックの妥当性（何を測っているか）の問題になります。'
    : `目標 .65 に届いていません（いま ${hv.overall.qwk}）。${esc(hv.note)}`}</div>
  <h2>観点ごと</h2>
  <div class="card">${table([{ label: '観点', key: 'c' }, { label: 'n', key: 'n', num: true }, { label: 'QWK', key: 'q', num: true },
    { label: '完全一致', key: 'e', num: true }, { label: '±1', key: 'a', num: true }, { label: 'ICC', key: 'i', num: true }],
  Object.entries(hv.dims).map(([k, v]) => ({ c: k, n: v.n, q: v.qwk, e: pct(v.exact), a: pct(v.adjacent), i: n(v.icc) })))}</div>`}
  ${r.ai_vs_human ? `<h2>参考：AIと人間の一致</h2>
  <div class="card"><div class="grid g4">
    ${kpi('QWK', r.ai_vs_human.overall.qwk, 'AI vs 人間')}
    ${kpi('±1一致', pct(r.ai_vs_human.overall.adjacent), '')}
  </div><div class="note">${esc(r.note)}</div></div>` : ''}`;
};

views.instrument = async function instrument() {
  const r = await api('/api/analysis/instrument');
  return `<h1>器具の健全性</h1>
  <p class="muted">ルーブリックが「差を見分けられているか」を見ます ${evBadge('unverified_rubric')}</p>
  ${r.healthy ? '<div class="callout ok">いまのところ、AIが採点する観点は機能しています。</div>'
    : `<div class="callout warn"><b>問題のある観点があります。</b>観点が天井や床に張りついていると、A/Bで差が出ません。</div>`}
  <div class="grid g2">${Object.entries(r.dims).map(([code, v]) => {
    const rd = META.rubric.dimensions.find((d) => d.code === code);
    const maxc = Math.max(...v.distribution, 1);
    return `<div class="card">
      <div class="row" style="justify-content:space-between"><b>${code}｜${esc(rd.name)}${v.rater === 'human' ? ' <span class="badge">人間評定が主</span>' : ''}</b>
        <span class="muted">平均 ${v.mean}／SD ${n(v.sd)}</span></div>
      <div style="margin:10px 0">${v.distribution.map((c, i) => `<div class="row" style="gap:8px">
        <span class="muted" style="width:14px">${i}</span>
        <div class="bar" style="flex:1"><span style="width:${(c / maxc) * 100}%"></span></div>
        <span class="mono muted" style="width:34px;text-align:right">${c}</span></div>`).join('')}</div>
      ${v.flags.length ? v.flags.map((f) => `<div class="callout warn" style="margin:6px 0">${esc(f)}</div>`).join('') : '<div class="muted" style="font-size:12px">問題なし</div>'}
    </div>`;
  }).join('')}</div>
  <h2>観点どうしの相関</h2>
  <div class="card">
    ${table([{ label: '組', key: 'p' }, { label: 'r', key: 'r', num: true }, { label: '読み方', key: 'm' }],
    Object.entries(r.correlations).map(([k, v]) => ({
      p: k, r: n(v), m: v === null ? '計算できません' : v >= 0.85 ? '同じものを測っている疑い' : v >= 0.6 ? '関連あり' : '別のものを測っている',
    })))}
    <div class="note">${esc(r.note)}</div>
  </div>`;
};

views.cost = async function cost() {
  const c = await api('/api/cost');
  const scen = ['zero', 'minimum', 'equivalent'];
  return `<h1>費用（ingredients method）</h1>
  <p class="muted">ファシリテーターの時間を3通りで置いて、3つとも出します。①だけを出すのは禁止です。</p>
  <div class="callout ${c.scenarios.equivalent.b_over_a !== null && c.scenarios.equivalent.b_over_a < 1 ? 'ok' : 'warn'}">
    <b>${esc(c.headline)}</b></div>
  <div class="grid g3">${scen.map((k) => {
    const s = c.scenarios[k];
    return `<div class="card"><h3>${esc(s.label)}</h3>
      ${['A', 'B'].map((a) => s.arms[a] ? `<div class="row" style="justify-content:space-between">
        <span>${arm(a)} 1名あたり ${evBadge('cost_per_facilitator')}</span><b>${yen(s.arms[a].cost_per_facilitator)}</b></div>
        <div class="muted" style="font-size:11.5px">総額 ${yen(s.arms[a].total)}／養成 ${s.arms[a].trained}名</div>` : '').join('')}
      <div style="margin-top:8px;font-size:12.5px">B/A = <b>${n(s.b_over_a)}</b><br><span class="muted">${esc(s.verdict)}</span></div>
    </div>`;
  }).join('')}</div>

  <h2>内訳（③ 同等スキル職の賃金）</h2>
  <div class="card">${table([{ label: 'アーム', key: 'a' }, { label: '直接支出', key: 'd', num: true }, { label: '時間の費用', key: 't', num: true },
    { label: '共通費の按分', key: 's', num: true }, { label: '合計', key: 'x', num: true }, { label: '1名あたり', key: 'p', num: true }],
  Object.entries(c.scenarios.equivalent.arms).map(([k, v]) => ({
    a: arm(k) + ' ' + k, d: yen(v.direct), t: yen(v.time_cost), s: yen(v.shared_from_common), x: yen(v.total), p: `<b>${yen(v.cost_per_facilitator)}</b>`,
  })))}</div>

  <h2>費用項目</h2>
  <div class="card">
    ${table([{ label: '項目', key: 'l' }, { label: '区分', key: 'c' }, { label: '誰の', key: 'a' }, { label: 'アーム', key: 'r' },
      { label: '時間', key: 'h', num: true }, { label: '直接支出', key: 'j', num: true }, { label: '数', key: 'q', num: true },
      { label: '', key: 'd' }],
    c.items.map((i) => ({
      l: esc(i.label) + (i.note ? `<br><span class="muted" style="font-size:11px">${esc(i.note)}</span>` : ''),
      c: i.category, a: { facilitator: 'ファシリテーター', mentor: 'メンター', staff: '運営', vendor: '外部' }[i.actor] || i.actor,
      r: i.arm ? arm(i.arm) : '共通', h: i.hours || '', j: i.jpy ? yen(i.jpy) : '', q: i.qty,
      d: `<button data-delcost="${i.id}">消す</button>`,
    })))}
    <div class="note">賃金の設定は「設定」の画面で変えられます（いま：最低賃金 ${yen(c.wages.wage_minimum)}/時、同等職 ${yen(c.wages.wage_equivalent)}/時、メンター ${yen(c.wages.mentor_hourly)}/時）。</div>
  </div>
  <div class="card">
    <h3>費用項目を足す</h3>
    <p class="muted" style="font-size:12.5px">「誰の時間か」を必ず選んでください。ファシリテーターの時間だけが、3シナリオで振られます。</p>
    <div class="row">
      <label style="margin:0">項目<input id="ciLabel" placeholder="事前研修の受講" style="width:170px"></label>
      <label style="margin:0">区分<select id="ciCat">${['採用', '研修', '伴走', 'システム', 'その他'].map((x) => `<option>${x}</option>`).join('')}</select></label>
      <label style="margin:0">誰の時間<select id="ciActor">
        <option value="facilitator">ファシリテーター</option><option value="mentor">メンター</option>
        <option value="staff">運営</option><option value="vendor">外部（直接支出のみ）</option></select></label>
      <label style="margin:0">アーム<select id="ciArm"><option value="">共通</option><option value="A">A</option><option value="B">B</option></select></label>
      <label style="margin:0">時間<input type="number" id="ciHours" value="0" style="width:80px"></label>
      <label style="margin:0">直接支出（円）<input type="number" id="ciJpy" value="0" style="width:110px"></label>
      <label style="margin:0">人数・回数<input type="number" id="ciQty" value="1" style="width:80px"></label>
      <button class="primary" id="addCost">足す</button>
    </div>
    <div id="costmsg"></div>
  </div>`;
};

views.ab = async function ab() {
  const r = await api('/api/analysis/ab');
  const codes = META.rubric.dimensions.map((d) => d.code);
  return `<h1>A/B（12月のフィージビリティ・スタディ）</h1>
  <div class="callout warn">${esc(r.statistical_note)}</div>
  <div class="grid g3">
    ${kpi('B群の質（A比）', r.quality_ratio_b_over_a === null ? '—' : pct(r.quality_ratio_b_over_a), `目標 ${pct(r.quality_target)}以上`, { evidence: 'unverified_rubric' })}
    ${kpi('メンター担当数（B/A）', r.mentor_load.ratio_b_over_a === null ? '—' : `${r.mentor_load.ratio_b_over_a}倍`, '目標 3倍以上', { evidence: 'mentor_load' })}
    ${kpi('解約率の差', r.churn_gap_pt === null ? '—' : `${r.churn_gap_pt}pt`, `目標 ${r.churn_target_pt}pt以内`, { evidence: 'churn_measured' })}
  </div>
  <h2>アームの比較（集計のみ。個人は出しません）</h2>
  <div class="card">${table([{ label: '', key: 'k' }, { label: 'アームA（免許あり・人間メンター）', key: 'A' }, { label: 'アームB（免許なし・AIメンター）', key: 'B' }],
    [
      { k: '採点した授業', A: r.arms.A.lessons_scored, B: r.arms.B.lessons_scored },
      { k: 'ファシリテーター', A: `${r.arms.A.facilitators}名`, B: `${r.arms.B.facilitators}名` },
      { k: '5観点の平均', A: `<b>${n(r.arms.A.overall_mean)}</b>`, B: `<b>${n(r.arms.B.overall_mean)}</b>` },
      ...codes.map((c) => ({ k: `　${c}`, A: n(r.arms.A.dims[c]), B: n(r.arms.B.dims[c]) })),
      { k: '子ども', A: `${r.arms.A.students}名`, B: `${r.arms.B.students}名` },
      { k: '解約率', A: r.arms.A.churn_pct === null ? '—' : `${r.arms.A.churn_pct}%`, B: r.arms.B.churn_pct === null ? '—' : `${r.arms.B.churn_pct}%` },
    ])}
    <div class="callout">${esc(r.design_note)}</div>
  </div>`;
};

views.archive = async function archive() {
  // 効果の分析は、先生本人には出しません。
  // 「自分の視聴が評価に使われている」と読めてしまい、視聴そのものが歪むためです。
  const canSeeEffect = ['admin', 'mentor', 'staff'].includes(ME.role);
  const [clips, eff] = await Promise.all([
    api('/api/clips'),
    canSeeEffect ? api('/api/analysis/archive-effect') : Promise.resolve(null),
  ]);
  return `<h1>アーカイブ</h1>
  <p class="muted">NIJIN の先生ヒアリング（2026/8）でいちばん高く評価された機能です。ただし効果は未検証です ${evBadge('archive_library')}。
    このシステムでは<b>問いなしの視聴を記録しません</b>
    （系統的レビューでは35研究中77%が構造化視聴ガイドを使っており、プロンプトの性質が重要とされているため）。</p>
  ${eff ? `<h2>いま言えること</h2>
  <div class="card">
    ${eff.rows.length ? `${table([{ label: '先生', key: 'f' }, { label: '見た週の次', key: 'a', num: true }, { label: '見なかった週', key: 'b', num: true }, { label: '差（本人の中）', key: 'd', num: true }],
    eff.rows.map((x) => ({ f: esc(x.facilitator), a: `${x.after_view_mean}（n=${x.after_view_n}）`, b: `${x.no_view_mean}（n=${x.no_view_n}）`, d: `<b>${x.within_diff > 0 ? '+' : ''}${x.within_diff}</b>` })))}
    <div style="margin-top:8px">平均の差：<b>${n(eff.mean_within_diff)}</b>（${eff.facilitators_compared}名で比較）</div>` : '<span class="muted">比較できるデータがまだありません。</span>'}
    <div class="callout warn">${esc(eff.caveat)}</div>
  </div>` : ''}
  <h2>クリップ（30秒＋問い）</h2>
  <div class="grid g2">${clips.map((c) => `<div class="card">
    <b>${esc(c.title)}</b> <span class="badge">${c.dimension || '—'}</span>
    <div class="muted" style="font-size:12px">${c.tStart}秒〜${c.tEnd}秒／視聴 ${c.views}件
      ${c.viewed_by_me ? '<span class="badge verified">見ました</span>' : ''}</div>
    <div class="callout" style="margin-top:8px">問い：${esc(c.prompt)}</div>
    <label>あなたの答え<textarea data-ans="${c.id}" style="min-height:52px" placeholder="02:14 の言い直しだと思います"></textarea></label>
    <div class="row"><button data-view="${c.id}">見た（答えを送る）</button>
      <a href="#/lesson/${c.lessonId}">→ もとの授業</a></div>
    <div id="vmsg_${c.id}"></div>
  </div>`).join('')}</div>`;
};

views.kill = async function kill() {
  // 事案の中身は、対応する人だけが見る。記録は誰でもできる。
  const canSeeIncidents = ['admin', 'mentor'].includes(ME.role);
  const [ks, incidents] = await Promise.all([
    api('/api/kill-status'),
    canSeeIncidents ? api('/api/incidents') : Promise.resolve([]),
  ]);
  return `<h1>撤退基準・セーフガーディング</h1>
  <p class="muted">判断の前に基準を書いておくためのものです。基準は <code>spec/kill-criteria.json</code> にあります。</p>
  <div class="callout ${ks.status === 'ok' ? 'ok' : ks.status === 'halt' ? 'bad' : 'warn'}">
    状態：<b>${ks.status === 'ok' ? '基準内' : ks.status === 'halt' ? '全停止中' : `${ks.tripped.length}件が基準に触れています`}</b>
    ${ks.unmeasured.length ? `<br>未測定：${ks.unmeasured.join('、')}` : ''}</div>
  <div class="card">${table([{ label: '', key: 's' }, { label: '項目', key: 'l' }, { label: '基準', key: 'r' }, { label: 'いま', key: 'v', num: true }, { label: '触れたら', key: 'a' }],
    ks.results.map((r) => ({
      s: !r.measured ? '<span class="badge">未測定</span>' : r.tripped ? '<span class="badge none">触れている</span>' : '<span class="badge verified">基準内</span>',
      l: `<b>${esc(r.label)}</b>${r.deadline ? `<br><span class="muted" style="font-size:11px">期限 ${r.deadline}</span>` : ''}`,
      r: esc(r.rule), v: r.measured ? `${r.value}<span class="muted"> / ${r.threshold}</span>` : '—',
      a: { halt_all: '全事業を停止して公表', halt_experiment: '実験を停止', rewrite_core_claim: '中核主張を書き換え', fix_instrument: '器具を直す' }[r.action] || r.action,
    })))}</div>

  <h2>セーフガーディング事案</h2>
  <div class="callout bad">1件でも発生したら、全事業を止めて公表します。事業リスクではなく事業終了要因として扱います。</div>
  <div class="card">
    <label>何が起きたか（記録すると、その場で全機能が停止します）</label>
    <textarea id="sum" placeholder="いつ・どこで・誰に・何が起きたか。憶測は書かない。"></textarea>
    <div class="row" style="margin-top:8px"><button class="danger" id="report">事案として記録し、全機能を停止する</button></div>
    <div id="msg"></div>
    ${incidents.length ? table([{ label: '日', key: 'd' }, { label: '内容', key: 's' }, { label: '状態', key: 't' }, { label: '公表', key: 'p' }],
    incidents.map((i) => ({ d: i.date, s: esc(i.summary), t: i.status === 'open' ? '<b style="color:#b3261e">対応中</b>' : 'クローズ', p: i.publishedAt || '—' }))) : '<div class="note">記録はありません。</div>'}
  </div>`;
};

views.model = async function model() {
  const mv = await api('/api/model-versions');
  return `<h1>モデル版</h1>
  <p class="muted">モデル版 ＝ LLM ＋ プロンプト ＋ ルーブリック の組。<b>1文字変えたら別の版</b>です。
    版が違うスコアは、混ぜて比べられません。</p>
  ${mv.drift_note ? `<div class="callout bad">${esc(mv.drift_note)}</div>` : '<div class="callout ok">いまのファイルは、凍結された版と一致しています。</div>'}
  <div class="card">${table([{ label: '版', key: 'l' }, { label: '指紋', key: 'f' }, { label: 'ルーブリック', key: 'r' }, { label: 'プロンプト', key: 'p' }, { label: '凍結日', key: 'd' }],
    mv.versions.map((v) => ({
      l: `<b>${esc(v.label)}</b><br><span class="muted" style="font-size:11px">${esc(v.id)}</span>`,
      f: `<code>${v.fingerprint.slice(0, 12)}</code>`, r: `<code>${v.rubric_sha256.slice(0, 8)}</code>`,
      p: `<code>${v.prompt_sha256.slice(0, 8)}</code>`, d: v.frozenAt ? v.frozenAt.slice(0, 10) : '—',
    })))}</div>
  <div class="card">
    <div class="row">
      <label style="margin:0">ラベル<input id="label" placeholder="v2"></label>
      <button class="primary" id="freeze">いまの内容を凍結する</button>
      <button id="rescore">凍結版で全授業を再スコアする</button>
    </div>
    <div id="msg"></div>
    <div class="note">いまのファイルの指紋：<code>${mv.draft.fingerprint.slice(0, 12)}</code>（scorer ${esc(mv.draft.scorer)}）</div>
  </div>`;
};

views.settings = async function settings() {
  const s = META.settings;
  return `<h1>設定</h1>
  <div class="card">
    <h3>賃金（費用の3シナリオで使います）</h3>
    <div class="row">
      <label style="margin:0">最低賃金（円/時）<input type="number" id="wage_minimum" value="${s.wage_minimum}"></label>
      <label style="margin:0">同等スキル職（円/時）<input type="number" id="wage_equivalent" value="${s.wage_equivalent}"></label>
      <label style="margin:0">メンター（円/時）<input type="number" id="mentor_hourly" value="${s.mentor_hourly}"></label>
      <label style="margin:0">運営（円/時）<input type="number" id="staff_hourly" value="${s.staff_hourly}"></label>
    </div>
    <h3>その他</h3>
    <div class="row">
      <label style="margin:0">メンターの週あたり時間（1.0FTE）<input type="number" id="mentor_fte_hours_week" value="${s.mentor_fte_hours_week}"></label>
      <label style="margin:0">在校生の満足度の変化（pt）<input type="number" id="enrolled_satisfaction_delta_pt" value="${s.enrolled_satisfaction_delta_pt}"></label>
      <label style="margin:0">デモ表示<select id="demo_mode"><option value="true" ${s.demo_mode ? 'selected' : ''}>デモ</option><option value="false" ${!s.demo_mode ? 'selected' : ''}>本番</option></select></label>
    </div>
    <h3>子どものデータ</h3>
    <div class="row">
      <label style="margin:0">同意の確認<select id="require_consent">
        <option value="true" ${s.require_consent ? 'selected' : ''}>する（推奨）</option>
        <option value="false" ${!s.require_consent ? 'selected' : ''}>しない</option></select></label>
      <label style="margin:0">書き起こしの保存期間（日）<input type="number" id="transcript_retention_days" value="${s.transcript_retention_days}"></label>
    </div>
    <div class="row" style="margin-top:12px"><button class="primary" id="save">保存</button></div>
    <div id="msg"></div>
  </div>
  <div class="card"><h3>この製品が構造としてやらないこと</h3>
    <div>・ファシリテーターの順位を作らない（API がソート指定を 403 で拒否します）</div>
    <div>・人格に触れる語を含む所見を保存しない（422 で拒否します）</div>
    <div>・問いのないアーカイブ視聴を記録しない</div>
    <div>・回答が4件未満のアンケートを先生に返さない</div>
    <div>・セーフガーディング事案が開いている間は、全機能を止める</div>
  </div>`;
};

// ---------- 画面のあとに動かすもの ----------
const after = {
  lesson(id) {
    const lc = $('#loadContract');
    if (lc) {
      lc.onclick = async () => {
        lc.disabled = true;
        $('#contractOut').innerHTML = '<div class="muted">計算中…</div>';
        try {
          const c = await api(`/api/lessons/${id}/contract`);
          const e = c.evaluation;
          const label = { scored: '確定', not_observable: '判定不能', review_required: '人間確認まち' };
          const cls = { scored: 'verified', not_observable: '', review_required: 'unverified' };
          $('#contractOut').innerHTML = `
            <div class="grid g3" style="margin-top:10px">
              ${kpi('状態', e.status === 'completed' ? '確定' : '人間確認まち', `レビュー要求 ${e.review_requests.length}件`)}
              ${kpi('総合点', e.overall_score === null ? '出さない' : e.overall_score,
    e.overall_score === null ? '1軸でも未確定なら出しません' : '5軸すべて確定')}
              ${kpi('こちらの画面表示', c.ours.overall, '0〜4の平均（参考）')}
            </div>
            <div style="margin-top:10px">${e.dimensions.map((d) => `<div style="padding:7px 0;border-bottom:1px solid #f0f2f4">
              <div class="row" style="justify-content:space-between">
                <b>${esc(d.label)}</b>
                <span><span class="badge ${cls[d.status]}">${label[d.status]}</span>
                  ${d.level ? ` level ${d.level}／score ${d.score}` : ''}
                  <span class="muted" style="font-size:11.5px">確からしさ ${d.confidence}</span></span>
              </div>
              ${d.reason_codes.length ? `<div class="muted" style="font-size:11.5px">${d.reason_codes.map(esc).join(' / ')}</div>` : ''}
              ${d.not_observable.length ? `<div class="muted" style="font-size:11.5px">${d.not_observable.map(esc).join(' ')}</div>` : ''}
            </div>`).join('')}</div>
            <h3>この評価が見ていないもの</h3>
            ${e.limitations.map((x) => `<div style="font-size:12.5px">・${esc(x)}</div>`).join('')}
            <div class="callout warn" style="margin-top:10px">${esc(c.note)}</div>
            <div class="note">ルーブリック版 <code>${esc(e.model_metadata.rubric_version)}</code>／
              採点器 <code>${esc(e.model_metadata.scorer_version)}</code>／
              観察 ${c.observation_counts.observations}件・候補 ${c.observation_counts.candidates}軸</div>`;
        } catch (err) {
          $('#contractOut').innerHTML = `<div class="err">${esc(err.message)}</div>`;
          lc.disabled = false;
        }
      };
    }
    const toggle = $('#toggleClip');
    if (toggle) toggle.onclick = () => { $('#clipForm').hidden = !$('#clipForm').hidden; };
    document.querySelectorAll('[data-clip-at]').forEach((b) => {
      b.onclick = () => {
        $('#clipForm').hidden = false;
        const t = Math.max(0, Number(b.dataset.clipAt) - 10);
        $('#clStart').value = t;
        $('#clDim').value = b.dataset.clipDim;
        $('#clTitle').value = `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')} の場面`;
        $('#clipForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
      };
    });
    const saveClip = $('#saveClip');
    if (saveClip) {
      saveClip.onclick = async () => {
        const tStart = Number($('#clStart').value);
        try {
          await api('/api/clips', {
            method: 'POST',
            body: {
              lessonId: id, tStart, tEnd: tStart + Number($('#clLen').value),
              dimension: $('#clDim').value || null, title: $('#clTitle').value.trim(), prompt: $('#clPrompt').value.trim(),
            },
          });
          location.hash = '#/archive';
        } catch (e) { $('#clmsg').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
      };
    }
    const rescore = $('#rescore');
    if (rescore) {
      rescore.onclick = async () => {
        rescore.disabled = true;
        try { await api(`/api/lessons/${id}/score`, { method: 'POST' }); render(); } catch (e) { $('#msg').innerHTML = `<div class="err">${esc(e.message)}</div>`; rescore.disabled = false; }
      };
    }
    const save = $('#saveRating');
    if (save) {
      save.onclick = async () => {
        const dims = {};
        document.querySelectorAll('[data-dim]').forEach((el) => { dims[el.dataset.dim] = Number(el.value); });
        try {
          await api(`/api/lessons/${id}/ratings`, { method: 'POST', body: { raterId: $('#rater').value, dims, blind: true } });
          render();
        } catch (e) { $('#rmsg').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
      };
    }
  },
  mentor() {
    $('#save').onclick = async () => {
      try {
        await api('/api/mentor-logs', {
          method: 'POST',
          body: { mentorId: $('#m').value, facilitatorId: $('#f').value, date: $('#date').value, minutes: Number($('#min').value), kind: $('#kind').value },
        });
        render();
      } catch (e) { $('#msg').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
    };
  },
  kill() {
    $('#report').onclick = async () => {
      const summary = $('#sum').value.trim();
      if (!summary) { $('#msg').innerHTML = '<div class="err">内容を書いてください。</div>'; return; }
      if (!window.confirm('記録すると、全機能が停止します。よろしいですか。')) return;
      try { await api('/api/incidents', { method: 'POST', body: { summary } }); location.reload(); } catch (e) { $('#msg').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
    };
  },
  model() {
    $('#freeze').onclick = async () => {
      try { await api('/api/model-versions/freeze', { method: 'POST', body: { label: $('#label').value || undefined } }); render(); } catch (e) { $('#msg').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
    };
    $('#rescore').onclick = async () => {
      $('#msg').innerHTML = '<div class="muted">再スコア中…</div>';
      try { const r = await api('/api/rescore', { method: 'POST', body: {} }); $('#msg').innerHTML = `<div class="ok-msg">${r.rescored}本を再スコアしました（${r.skipped}本は書き起こしなし）。</div>`; } catch (e) { $('#msg').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
    };
  },
  settings() {
    $('#save').onclick = async () => {
      const body = {};
      for (const k of ['wage_minimum', 'wage_equivalent', 'mentor_hourly', 'staff_hourly', 'mentor_fte_hours_week',
        'enrolled_satisfaction_delta_pt', 'transcript_retention_days']) {
        body[k] = Number($(`#${k}`).value);
      }
      body.demo_mode = $('#demo_mode').value === 'true';
      body.require_consent = $('#require_consent').value === 'true';
      try { await api('/api/settings', { method: 'PUT', body }); META = await api('/api/meta'); render(); } catch (e) { $('#msg').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
    };
  },
};

Object.assign(after, {
  report() {
    $('#reload').onclick = () => { location.hash = `#/report?asOf=${$('#asOf').value}`; render(); };
    $('#copy').onclick = async () => {
      const text = $('#body').textContent;
      try { await navigator.clipboard.writeText(text); $('#copy').textContent = 'コピーしました'; } catch { window.prompt('これをコピーしてください', text); }
    };
  },

  archive() {
    document.querySelectorAll('[data-view]').forEach((b) => {
      b.onclick = async () => {
        const ta = document.querySelector(`[data-ans="${b.dataset.view}"]`);
        if (!ta.value.trim()) {
          document.querySelector(`#vmsg_${b.dataset.view}`).innerHTML = '<div class="err">問いに答えてから送ってください。</div>';
          return;
        }
        try {
          await api(`/api/clips/${b.dataset.view}/view`, { method: 'POST', body: { answer: ta.value.trim() } });
          render();
        } catch (e) { document.querySelector(`#vmsg_${b.dataset.view}`).innerHTML = `<div class="err">${esc(e.message)}</div>`; }
      };
    });
  },

  cost() {
    const add = $('#addCost');
    if (add) {
      add.onclick = async () => {
        try {
          await api('/api/cost-items', {
            method: 'POST',
            body: {
              label: $('#ciLabel').value.trim(), category: $('#ciCat').value, actor: $('#ciActor').value,
              arm: $('#ciArm').value || null, hours: Number($('#ciHours').value), jpy: Number($('#ciJpy').value),
              qty: Number($('#ciQty').value),
            },
          });
          render();
        } catch (e) { $('#costmsg').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
      };
    }
    document.querySelectorAll('[data-delcost]').forEach((b) => {
      b.onclick = async () => {
        if (!window.confirm('この費用項目を消しますか。')) return;
        try { await api(`/api/cost-items/${b.dataset.delcost}`, { method: 'DELETE' }); render(); } catch (e) { window.alert(e.message); }
      };
    });
  },

  surveys() {
    const mk = $('#mkCycle');
    if (mk) {
      mk.onclick = async () => {
        try {
          await api('/api/surveys/cycles', { method: 'POST', body: { classId: $('#scls').value, cycle: $('#scycle').value.trim() } });
          render();
        } catch (e) { $('#cycmsg').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
      };
    }
    document.querySelectorAll('[data-copy]').forEach((b) => {
      b.onclick = async () => {
        const url = location.origin + b.dataset.copy;
        try { await navigator.clipboard.writeText(url); b.textContent = 'コピーしました'; } catch { window.prompt('このリンクを渡してください', url); }
      };
    });
    document.querySelectorAll('[data-close]').forEach((b) => {
      b.onclick = async () => {
        if (!window.confirm('締め切ると、子どもは回答できなくなります。')) return;
        await api(`/api/surveys/cycles/${b.dataset.close}/close`, { method: 'POST' });
        render();
      };
    });
    document.querySelectorAll('[data-step]').forEach((b) => {
      b.onclick = async () => {
        const body = { facilitatorId: b.dataset.fac, cycle: b.dataset.cycle, step: b.dataset.step };
        if (b.dataset.step === 'action_declared_at') {
          const a = window.prompt('チームで宣言した「次の1手」を書いてください（行動で）');
          if (!a) return;
          body.action = a;
        }
        try { await api('/api/surveys/steps', { method: 'POST', body }); render(); } catch (e) { window.alert(e.message); }
      };
    });
  },

  ''() {
    document.querySelectorAll('[data-ack]').forEach((b) => {
      b.onclick = async () => { await api(`/api/feedbacks/${b.dataset.ack}/ack`, { method: 'POST' }); render(); };
    });
  },

  blind(lessonId) {
    const save = $('#saveBlind');
    if (!save) return;
    save.onclick = async () => {
      const dims = {};
      let missing = false;
      for (const dim of META.rubric.dimensions) {
        const el = document.querySelector(`input[name="d_${dim.code}"]:checked`);
        if (!el) { missing = true; break; }
        dims[dim.code] = Number(el.value);
      }
      if (missing) { $('#bmsg').innerHTML = '<div class="err">すべての観点に点を付けてください。</div>'; return; }
      try {
        await api(`/api/lessons/${lessonId}/ratings`, { method: 'POST', body: { raterId: ME.id, dims, blind: true } });
        location.hash = '#/blind';
      } catch (e) { $('#bmsg').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
    };
  },

  import() {
    let parsed = null;
    $('#parse').onclick = async () => {
      $('#pmsg').innerHTML = '<div class="muted">読み込み中…</div>';
      $('#mapArea').innerHTML = '';
      try {
        parsed = await api('/api/import/parse', { method: 'POST', body: { text: $('#text').value, format: $('#fmt').value || undefined } });
      } catch (e) { $('#pmsg').innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
      $('#pmsg').innerHTML = `<div class="ok-msg">形式：${esc(parsed.format)}／発話 ${parsed.total}件（冒頭${parsed.window_minutes}分に ${parsed.in_window}件）</div>`
        + (parsed.warnings.length ? `<div class="callout warn">読めなかった行が ${parsed.warnings.length} 件あります：<br>${parsed.warnings.slice(0, 5).map(esc).join('<br>')}</div>` : '');

      const klass = (await api('/api/classes')).find((c) => c.id === $('#cls').value);
      const opts = (sel) => `<option value="">（この話者は取り込まない）</option><option value="T"${sel === 'T' ? ' selected' : ''}>先生</option>`
        + klass.students.map((st) => `<option value="${st.id}">${esc(st.name)}</option>`).join('');
      // いちばん話している人を先生として初期選択にする（あとで直せる）
      const top = parsed.speakers.slice().sort((a, b) => b.totalMora - a.totalMora)[0];
      $('#mapArea').innerHTML = `<div class="card"><h3>話者を対応づける</h3>
        <p class="muted" style="font-size:12.5px">名前は保存されません。ここで選んだ子どもに紐づけて保存します。</p>
        ${parsed.speakers.map((sp) => `<div class="row" style="margin:6px 0">
          <div style="width:220px"><b>${esc(sp.label)}</b> <span class="muted">（${sp.utterances}発話）</span></div>
          <select data-map="${esc(sp.label)}">${opts(top && sp.label === top.label ? 'T' : '')}</select>
          <span class="muted" style="font-size:11.5px">「${esc((sp.sampleText || '').slice(0, 28))}」</span>
        </div>`).join('')}
        <div class="row" style="margin-top:10px"><button class="primary" id="doImport">この内容で授業をつくる</button></div>
        <div id="imsg"></div></div>`;

      $('#doImport').onclick = async () => {
        const mapping = {};
        document.querySelectorAll('[data-map]').forEach((el) => { if (el.value) mapping[el.dataset.map] = el.value; });
        $('#imsg').innerHTML = '<div class="muted">取り込み中…</div>';
        try {
          const r = await api('/api/import/lesson', {
            method: 'POST',
            body: { classId: $('#cls').value, date: $('#date').value, text: $('#text').value, format: $('#fmt').value || undefined, mapping },
          });
          location.hash = `#/lesson/${r.lesson.id}`;
        } catch (e) { $('#imsg').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
      };
    };
  },

  people() {
    $('#addUser').onclick = async () => {
      try {
        await api('/api/users', {
          method: 'POST',
          body: {
            name: $('#nName').value.trim(), role: $('#nRole').value, arm: $('#nArm').value || null,
            teamId: $('#nTeam').value || null, licensed: $('#nLic').value === 'true',
          },
        });
        render();
      } catch (e) { $('#umsg').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
    };
    $('#addClass').onclick = async () => {
      try {
        await api('/api/classes', {
          method: 'POST',
          body: { name: $('#cName').value.trim(), facilitatorId: $('#cFac').value, capacity: Number($('#cCap').value) },
        });
        render();
      } catch (e) { $('#cmsg').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
    };
    document.querySelectorAll('[data-addchild]').forEach((b) => {
      b.onclick = async () => {
        const input = document.querySelector(`[data-child="${b.dataset.addchild}"]`);
        if (!input.value.trim()) return;
        try {
          await api(`/api/classes/${b.dataset.addchild}/students`, { method: 'POST', body: { name: input.value.trim() } });
          render();
        } catch (e) { window.alert(e.message); }
      };
    });
    document.querySelectorAll('[data-consent]').forEach((b) => {
      b.onclick = async () => {
        const by = window.prompt('誰から同意を得ましたか（保護者の氏名や続柄）');
        if (!by) return;
        const obtainedAt = window.prompt('同意を得た日（YYYY-MM-DD）', new Date().toISOString().slice(0, 10));
        if (!obtainedAt) return;
        const method = window.prompt('方法（書面／メール／口頭 など）', '書面') || '書面';
        try {
          await api(`/api/students/${b.dataset.consent}/consent`, { method: 'POST', body: { by, obtainedAt, method } });
          render();
        } catch (e) { window.alert(e.message); }
      };
    });
    document.querySelectorAll('[data-left]').forEach((b) => {
      b.onclick = async () => {
        if (!window.confirm('この子を退会にしますか。解約率の集計に入ります。')) return;
        await api(`/api/students/${b.dataset.left}`, { method: 'PATCH', body: { status: 'left' } });
        render();
      };
    });
    document.querySelectorAll('[data-rejoin]').forEach((b) => {
      b.onclick = async () => {
        await api(`/api/students/${b.dataset.rejoin}`, { method: 'PATCH', body: { status: 'active' } });
        render();
      };
    });
    document.querySelectorAll('[data-ready]').forEach((b) => {
      b.onclick = async () => {
        const d = window.prompt('一人前になった日（YYYY-MM-DD）。空にすると取り消します。', new Date().toISOString().slice(0, 10));
        if (d === null) return;
        await api(`/api/users/${b.dataset.ready}`, { method: 'PATCH', body: { readyAt: d || null } });
        render();
      };
    });
    document.querySelectorAll('[data-leave]').forEach((b) => {
      b.onclick = async () => {
        const d = window.prompt('離任した日（YYYY-MM-DD）。空にすると取り消します。', new Date().toISOString().slice(0, 10));
        if (d === null) return;
        await api(`/api/users/${b.dataset.leave}`, { method: 'PATCH', body: { leftAt: d || null } });
        render();
      };
    });
    document.querySelectorAll('[data-pass]').forEach((b) => {
      b.onclick = async () => {
        const pc = window.prompt('合言葉（8文字以上）。本人には口頭で伝え、初回ログイン後に変更してもらってください。');
        if (!pc) return;
        try {
          await api(`/api/users/${b.dataset.pass}/passcode`, { method: 'POST', body: { passcode: pc } });
          render();
        } catch (e) { window.alert(e.message); }
      };
    });
  },

  meetings() {
    const drawMembers = () => {
      const opt = $('#team').selectedOptions[0];
      const members = JSON.parse(opt.dataset.members || '[]');
      $('#declArea').innerHTML = members.length
        ? members.map((m) => `<div class="row" style="margin:6px 0">
            <div style="width:150px">${esc(m.name)}</div>
            <select data-dim="${m.id}"><option value="">観点</option>${META.rubric.dimensions.map((d) => `<option value="${d.code}">${d.code}｜${esc(d.name)}</option>`).join('')}</select>
            <input data-action="${m.id}" placeholder="次の1手（行動で書く）" style="flex:1;min-width:240px">
          </div>`).join('')
        : '<div class="muted">このチームにメンバーがいません。</div>';
    };
    $('#team').onchange = drawMembers;
    drawMembers();
    $('#saveMeeting').onclick = async () => {
      const declarations = [];
      const attendeeIds = [];
      document.querySelectorAll('[data-action]').forEach((el) => {
        attendeeIds.push(el.dataset.action);
        if (el.value.trim()) {
          declarations.push({
            facilitatorId: el.dataset.action,
            action: el.value.trim(),
            dimension: (document.querySelector(`[data-dim="${el.dataset.action}"]`) || {}).value || null,
          });
        }
      });
      try {
        await api('/api/meetings', { method: 'POST', body: { teamId: $('#team').value, date: $('#mdate').value, attendeeIds, declarations } });
        render();
      } catch (e) { $('#mmsg').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
    };
  },
});

// ---------- ルーティング ----------
function applyNav() {
  document.querySelectorAll('[data-roles]').forEach((el) => {
    el.hidden = !el.dataset.roles.split(',').includes(ME.role);
  });
  const roleLabel = { admin: '運営', mentor: 'メンター', facilitator: '先生', rater: '外部評定者', staff: '事務' };
  $('#me').innerHTML = `<div style="color:#c8cdd6">${esc(ME.name)}</div>
    <div>${roleLabel[ME.role] || ME.role}${ME.arm ? `／アーム${ME.arm}` : ''}</div>
    <div class="row" style="margin-top:6px;gap:6px">
      <button id="logout" style="font-size:11px;padding:3px 8px">ログアウト</button>
      <button id="chpass" style="font-size:11px;padding:3px 8px">合言葉を変更</button>
    </div>`;
  $('#logout').onclick = async () => { await api('/api/session', { method: 'DELETE', noRedirect: true }); location.reload(); };
  $('#chpass').onclick = async () => {
    const cur = window.prompt('いまの合言葉');
    if (!cur) return;
    const next = window.prompt('新しい合言葉（8文字以上）');
    if (!next) return;
    try {
      await api('/api/session/passcode', { method: 'POST', body: { current: cur, next } });
      window.alert('変えました。');
    } catch (e) { window.alert(e.message); }
  };
}

async function render() {
  const hash = location.hash.replace(/^#\/?/, '').split('?')[0];
  const [name, param] = hash.split('/');
  const key = name || '';
  document.querySelectorAll('[data-nav]').forEach((a) => {
    a.classList.toggle('on', a.getAttribute('href') === `#/${key}` || (key === '' && a.getAttribute('href') === '#/'));
  });
  const view = views[key];
  if (!view) { main.innerHTML = '<h1>ありません</h1>'; return; }
  main.innerHTML = '<div class="loading">読み込み中…</div>';
  try {
    main.innerHTML = await view(param);
    if (after[key]) after[key](param);
    window.scrollTo(0, 0);
  } catch (e) {
    main.innerHTML = `<h1>読み込めませんでした</h1><div class="callout bad">${esc(e.message)}</div>`;
  }
}

(async function boot() {
  let sess;
  try {
    sess = await api('/api/session', { noRedirect: true });
  } catch (e) {
    main.innerHTML = `<div class="callout bad">サーバに繋がりません：${esc(e.message)}</div>`;
    return;
  }
  if (!sess.user) { await renderLogin(); return; }
  ME = sess.user;
  document.querySelector('.side').hidden = false;

  META = await api('/api/meta');
  if (META.demo_mode) $('#demo').hidden = false;
  applyNav();

  const ks = await api('/api/kill-status');
  if (ks.halt_all) {
    const el = $('#halt');
    el.hidden = false;
    el.textContent = `全機能を停止しています：${ks.halt_reason}。対応と公表が終わるまで再開しません。`;
  }

  // 評定者は盲検の採点しか使えない
  if (ME.role === 'rater' && !location.hash.startsWith('#/blind') && !location.hash.startsWith('#/kill')) {
    location.hash = '#/blind';
  }
  window.addEventListener('hashchange', render);
  render();
}());
