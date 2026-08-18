'use strict';
// 会議ツールの書き起こし → 内部形式（transcript.js が食える手前まで）。
// ここでは話者IDへの変換をしない。生のラベルのまま返し、
// 「田中先生 = T」「あかり = st_xxx」の対応づけは画面で人が決める。
// 機械が名前から推測すると、間違えたときに誰も気づけないため。
//
// 壊れた行で止まらないこと、同じ入力から必ず同じ結果が出ることを優先している
// （3章「モデル版」の前提。Math.random / Date.now はここでは使わない）。
const { moraCount } = require('./ja');
const { round } = require('./util');

// 話者名が取れなかったときのラベル。空文字にすると画面の対応づけ表から消えてしまう
const UNKNOWN_SPEAKER = '不明';

// 警告が何百件も出ると、かえって読まれない。上限を決めて残りは件数だけ伝える
const WARN_LIMIT = 20;

// ---------------------------------------------------------------- 小道具

function makeWarn() {
  const items = [];
  let omitted = 0;
  return {
    add(msg) {
      if (items.length < WARN_LIMIT) items.push(msg);
      else omitted += 1;
    },
    out() {
      return omitted ? [...items, `ほかにも ${omitted} 件の警告がありました（省略しました）`] : items;
    },
  };
}

// 先頭の BOM（U+FEFF）を落とす。文字コード変換は呼び出し側の仕事だが、
// BOM だけは残っていることが多く、残すと最初の列名や WEBVTT の判定が狂う
function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

// 警告に元の行を引用する。長すぎると一覧が読めなくなるので切る
function snippet(s) {
  const t = String(s === null || s === undefined ? '' : s).trim();
  return t.length > 24 ? `${t.slice(0, 24)}…` : t;
}

// 「>>」は字幕の話者交代記号であって本文ではない。全角空白も普通の空白に潰す
function clean(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/^\s*>>+\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// 記号だけの行（「>>」「----」など）は落とす
function isSymbolOnly(s) {
  return /^[>\-–—=*_・.．\s]*$/.test(s);
}

// <v 話者名> 以外のタグ（<c.colorE5E5E5> や <00:00:01.000> など）は本文ではない
function stripTags(s) {
  return String(s || '').replace(/<\/?[^>]*>/g, '');
}

// 日本語は分かち書きしないので、境界が日本語ならそのまま繋ぐ。
// 空白を入れてもモーラ数は変わらないが、画面に出るのは生の文字列なので見た目を優先する
function joinText(a, b) {
  if (!a) return b;
  if (!b) return a;
  return /[A-Za-z0-9]$/.test(a) && /^[A-Za-z0-9]/.test(b) ? `${a} ${b}` : a + b;
}

// 時刻 → 秒。"01:05" = 65、"00:00:12.500" = 12.5、"12" = 12。読めなければ null。
// 秒に揃えておかないと transcript.js の窓（冒頭15分）が効かない
function toSeconds(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v === null || v === undefined ? '' : v).trim();
  if (!s) return null;
  s = s.replace(/^\[/, '').replace(/\]$/, '').trim();
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s); // 秒の数値そのまま
  const m = s.match(/^(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/);
  if (!m) return null;
  const h = m[1] ? Number(m[1]) : 0;
  const mi = Number(m[2]);
  const se = Number(m[3]);
  if (mi > 59 || se > 59) return null;
  const ms = m[4] ? Number(`${m[4]}00`.slice(0, 3)) : 0;
  return h * 3600 + mi * 60 + se + ms / 1000;
}

// 「話者名: 本文」を割る。文の途中のコロンや URL を話者名と読み違えないようにする
function splitSpeaker(text) {
  const m = String(text || '').match(/^([^:：]{1,24})[:：]\s*([\s\S]*)$/);
  if (!m) return null;
  const label = m[1].trim();
  const rest = m[2].trim();
  if (!label || !rest) return null;
  if (rest.startsWith('//')) return null; // http://... の「http」を話者にしない
  if (/[。、！？!?]/.test(label)) return null; // 文の途中のコロン
  return { speaker: label, text: rest };
}

// 「[01:05] あかり こうえんに いきました」のように、コロンなしで名前が置かれる形
function splitSpeakerBySpace(text) {
  const m = String(text || '').match(/^(\S{1,16})\s+(.+)$/);
  if (!m) return null;
  if (/[。、！？!?]$/.test(m[1])) return null; // 文末で切れている＝名前ではない
  return { speaker: m[1], text: m[2].trim() };
}

// 行頭の時刻（"00:12" / "[01:05]" / "1:02:03"）と残りに割る
const RE_LINE_TIME = /^\[?\s*(\d{1,3}:\d{1,2}(?::\d{1,2})?(?:[.,]\d{1,3})?)\s*\]?[\s　]*(.*)$/;
// 時刻だけの行（Zoom のテキスト書き起こし）
const RE_TIME_ONLY = /^\[?\s*\d{1,3}:\d{1,2}(?::\d{1,2})?(?:[.,]\d{1,3})?\s*\]?$/;

// ---------------------------------------------------------------- 形式の判定

const HEADER_ALIASES = {
  time: ['t', 'time', '秒', '開始', 'start', 'starttime', '開始時刻', '開始秒', '時刻', 'タイムスタンプ', 'timestamp', 'sec', 'seconds'],
  end: ['end', 'endt', 'endtime', '終了', '終了時刻', 'stop'],
  speaker: ['speaker', '話者', '発言者', '名前', '発言者名', '話者名', 'name', 'who'],
  text: ['text', '発話', '本文', '内容', '発言', '発話内容', 'message', 'utterance', '字幕'],
};

// 列名の揺れを吸収する。空白・下線・ハイフンは無視し、英字は小文字に揃える
function normalizeHeader(s) {
  return stripBom(String(s || '')).replace(/["\s_\-　]/g, '').toLowerCase();
}

function headerKind(normalized) {
  for (const [kind, names] of Object.entries(HEADER_ALIASES)) {
    if (names.includes(normalized)) return kind;
  }
  return null;
}

function normalizeFormatName(name) {
  if (!name) return null;
  const n = String(name).trim().toLowerCase();
  if (n === 'vtt' || n === 'webvtt') return 'webvtt';
  if (n === 'srt') return 'srt';
  if (n === 'zoom') return 'zoom';
  if (n === 'csv') return 'csv';
  if (n === 'tsv' || n === 'tab') return 'tsv';
  if (n === 'plain' || n === 'text' || n === 'txt') return 'plain';
  return null;
}

function detectFormat(text) {
  const lines = text.split('\n');
  const nonEmpty = lines.filter((l) => l.trim() !== '');
  if (!nonEmpty.length) return 'plain';

  if (/^WEBVTT/.test(nonEmpty[0].trim())) return 'webvtt';

  if (text.includes('-->')) {
    // SRT はミリ秒がカンマ。連番行が時刻行の直前に来るのも SRT の特徴
    if (/\d[,]\d{1,3}\s*-->/.test(text)) return 'srt';
    if (/^\s*\d+\s*\n\s*\d{1,3}:\d{1,2}/m.test(text)) return 'srt';
    return 'webvtt';
  }

  // 区切り文字つき：ヘッダ行に既知の列名が2つ以上あるときだけ表として扱う。
  // 「00:12 田中先生: こんにちは, げんきですか」を CSV と誤判定しないための条件
  for (const [fmt, delim] of [['tsv', '\t'], ['csv', ',']]) {
    if (!nonEmpty[0].includes(delim)) continue;
    const kinds = nonEmpty[0].split(delim).map((c) => headerKind(normalizeHeader(c)));
    if (kinds.filter(Boolean).length >= 2) return fmt;
  }

  // Zoom：時刻だけの行があり、その後に本文が続く
  for (let i = 0; i < lines.length - 1; i += 1) {
    if (!RE_TIME_ONLY.test(lines[i].trim())) continue;
    if (lines.slice(i + 1, i + 3).some((l) => l.trim() !== '')) return 'zoom';
  }

  return 'plain';
}

// ---------------------------------------------------------------- 形式ごとの読み取り

// WebVTT / SRT。どちらも「時刻の行 + 本文の行」の塊なので、同じ関数で読む
function parseCues(text, warn) {
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (line === '') { i += 1; continue; }
    // ヘッダとメタ情報のブロックは中身ごと飛ばす
    if (/^WEBVTT/.test(line) || /^(NOTE|STYLE|REGION)\b/.test(line)) {
      while (i < lines.length && lines[i].trim() !== '') i += 1;
      continue;
    }
    const startLine = i + 1;
    const block = [];
    while (i < lines.length && lines[i].trim() !== '') { block.push(lines[i]); i += 1; }
    const cue = readCue(block, startLine, warn);
    if (cue) out.push(cue);
  }
  return out;
}

function readCue(block, startLine, warn) {
  const k = block.findIndex((l) => l.includes('-->'));
  if (k < 0) {
    warn.add(`${startLine}行目からのブロックに時刻がありません: 「${snippet(block[0])}」`);
    return null;
  }
  const m = block[k].match(/([0-9:.,]+)\s*-->\s*([0-9:.,]+)/);
  const t = toSeconds(m && m[1]);
  if (t === null) {
    warn.add(`${startLine + k}行目の時刻が読めませんでした: 「${snippet(block[k])}」`);
    return null;
  }
  const endT = toSeconds(m && m[2]);

  let speaker = null;
  let body = '';
  for (const raw of block.slice(k + 1)) {
    const l = raw.trim();
    if (l === '' || isSymbolOnly(l)) continue;
    const v = l.match(/^<v([^>]*)>([\s\S]*)$/);
    if (v) {
      // <v.loud 田中先生> のようにクラスが付くことがある
      const name = v[1].replace(/^(?:\.[^\s.]+)*/, '').trim();
      if (name && !speaker) speaker = name;
      body = joinText(body, clean(stripTags(v[2])));
      continue;
    }
    body = joinText(body, clean(stripTags(l)));
  }
  if (!body) return null; // 本文のない cue は落とす（警告するほどの事ではない）
  if (!speaker) {
    const sp = splitSpeaker(body);
    if (sp) { speaker = sp.speaker; body = sp.text; }
  }
  return { t, endT: endT === null ? undefined : endT, speaker: speaker || UNKNOWN_SPEAKER, text: body };
}

// Zoom のテキスト書き起こし。時刻だけの行＋次行に本文、が基本形。
// 「12:34:56 話者名: テキスト」と1行にまとまっている版も同じ関数で読む
function parseZoom(text, warn) {
  const lines = text.split('\n');
  const out = [];
  let pending = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line === '' || isSymbolOnly(line)) continue;
    if (/^WEBVTT/.test(line)) continue;
    if (/^\d+$/.test(line)) continue; // 連番だけの行

    const range = line.match(/^([0-9:.,]+)\s*-->\s*([0-9:.,]+)$/);
    if (range) {
      pending = { t: toSeconds(range[1]), endT: toSeconds(range[2]) };
      if (pending.t === null) {
        warn.add(`${i + 1}行目の時刻が読めませんでした: 「${snippet(line)}」`);
        pending = null;
      }
      continue;
    }
    if (RE_TIME_ONLY.test(line)) {
      pending = { t: toSeconds(line), endT: null };
      if (pending.t === null) {
        warn.add(`${i + 1}行目の時刻が読めませんでした: 「${snippet(line)}」`);
        pending = null;
      }
      continue;
    }

    if (pending) {
      const u = bodyToUtterance(pending.t, pending.endT, line);
      pending = null;
      if (u) out.push(u);
      continue;
    }

    // 1行にまとまっている版
    const m = line.match(RE_LINE_TIME);
    const t = m ? toSeconds(m[1]) : null;
    if (t === null) {
      warn.add(`${i + 1}行目が読めませんでした: 「${snippet(line)}」`);
      continue;
    }
    const u = bodyToUtterance(t, null, m[2]);
    if (u) out.push(u);
  }
  return out;
}

// プレーンテキスト。「MM:SS 話者名: テキスト」「[MM:SS] 話者名 テキスト」「H:MM:SS ...」
function parsePlain(text, warn) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line === '' || isSymbolOnly(line)) continue;
    const m = line.match(RE_LINE_TIME);
    const t = m ? toSeconds(m[1]) : null;
    if (t === null) {
      // 時刻のない行は、どの発話に属するか決められない。黙って繋ぐと根拠の時刻が狂うので落とす
      warn.add(`${i + 1}行目が読めませんでした: 「${snippet(line)}」`);
      continue;
    }
    const u = bodyToUtterance(t, null, m[2]);
    if (u) out.push(u); // 本文が空＝時刻だけの行なので落とす
  }
  return out;
}

// 本文から話者を割り出して1発話にする。コロン形式 → 空白形式 の順に試す
function bodyToUtterance(t, endT, rawBody) {
  const body = clean(rawBody);
  if (!body || isSymbolOnly(body)) return null;
  const sp = splitSpeaker(body) || splitSpeakerBySpace(body);
  return {
    t,
    endT: endT === null || endT === undefined ? undefined : endT,
    speaker: sp ? sp.speaker : UNKNOWN_SPEAKER,
    text: sp ? sp.text : body,
  };
}

// CSV / TSV。引用符つきのセル（中に改行やカンマが入る）も読めるようにしておく
function splitDelimited(text, delim) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuote = false;
  let line = 1;
  let rowLine = 1;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inQuote) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else inQuote = false;
      } else {
        if (c === '\n') line += 1;
        field += c;
      }
      continue;
    }
    if (c === '"' && field === '') { inQuote = true; continue; }
    if (c === delim) { row.push(field); field = ''; continue; }
    if (c === '\n') {
      row.push(field);
      rows.push({ line: rowLine, cells: row });
      row = []; field = ''; line += 1; rowLine = line;
      continue;
    }
    field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push({ line: rowLine, cells: row }); }
  return rows;
}

function parseTable(text, delim, warn) {
  const rows = splitDelimited(text, delim).filter((r) => r.cells.some((c) => c.trim() !== ''));
  if (!rows.length) return [];
  const kinds = rows[0].cells.map((c) => headerKind(normalizeHeader(c)));
  if (!kinds.includes('text')) {
    warn.add('本文の列（text / 発話 / 本文 / 内容）が見つかりませんでした');
    return [];
  }
  if (!kinds.includes('time')) {
    warn.add('時刻の列（t / time / 秒 / 開始 / start）が見つかりませんでした');
    return [];
  }
  const out = [];
  for (const row of rows.slice(1)) {
    const cell = (kind) => {
      const i = kinds.indexOf(kind);
      return i >= 0 && i < row.cells.length ? row.cells[i].trim() : '';
    };
    const body = clean(cell('text'));
    if (!body || isSymbolOnly(body)) continue; // 本文が空の行は落とす（末尾の空行が多いため警告しない）
    const t = toSeconds(cell('time'));
    if (t === null) {
      warn.add(`${row.line}行目の時刻が読めませんでした: 「${snippet(cell('time'))}」`);
      continue;
    }
    const endT = toSeconds(cell('end'));
    let speaker = cell('speaker');
    let textV = body;
    if (!speaker) {
      // 話者の列がない書き出しもある。その場合だけ本文の頭から拾う
      const sp = splitSpeaker(body);
      if (sp) { speaker = sp.speaker; textV = sp.text; }
    }
    out.push({
      t,
      endT: endT === null ? undefined : endT,
      speaker: speaker || UNKNOWN_SPEAKER,
      text: textV,
    });
  }
  return out;
}

// ---------------------------------------------------------------- 結合と集計

// 同じ話者の細切れ（字幕は1文が数 cue に割れる）を1発話に戻す。
// 待ち時間や発話長を数えるとき、細切れのままだと実態より短く見えてしまう
function mergeUtterances(list, gapSec) {
  const out = [];
  for (const u of list) {
    const prev = out[out.length - 1];
    const prevEnd = prev ? (typeof prev.endT === 'number' ? prev.endT : prev.t) : null;
    if (prev && prev.speaker === u.speaker && u.t >= prev.t && u.t - prevEnd <= gapSec) {
      prev.text = joinText(prev.text, u.text);
      const end = typeof u.endT === 'number' ? u.endT : u.t;
      if (typeof prev.endT === 'number' || typeof u.endT === 'number') {
        prev.endT = Math.max(typeof prev.endT === 'number' ? prev.endT : prev.t, end);
      }
      continue;
    }
    out.push({ ...u });
  }
  return out;
}

function summarizeSpeakers(utterances) {
  const map = new Map();
  for (const u of utterances) {
    if (!map.has(u.speaker)) {
      map.set(u.speaker, { label: u.speaker, utterances: 0, totalMora: 0, sampleText: u.text });
    }
    const s = map.get(u.speaker);
    s.utterances += 1;
    s.totalMora += moraCount(u.text);
  }
  return [...map.values()].map((s) => ({ ...s, totalMora: round(s.totalMora, 2) }));
}

// ---------------------------------------------------------------- 公開する関数

// parse(text, opts) → { utterances, speakers, format, warnings }
// opts.format で形式を明示できる。opts.mergeGapSec で結合の閾値（既定3秒）を変えられる
function parse(text, opts = {}) {
  const warn = makeWarn();
  // BOM は先頭の1文字だけ。ここで落とさないと最初の列名や WEBVTT の判定が狂う
  const src = stripBom(String(text === null || text === undefined ? '' : text))
    .replace(/\r\n?/g, '\n');

  let format = normalizeFormatName(opts.format);
  if (opts.format && !format) {
    warn.add(`形式「${snippet(opts.format)}」は知らないので、自動判定に切り替えました`);
  }
  if (!format) format = detectFormat(src);

  let raw;
  if (format === 'webvtt' || format === 'srt') raw = parseCues(src, warn);
  else if (format === 'zoom') raw = parseZoom(src, warn);
  else if (format === 'csv') raw = parseTable(src, ',', warn);
  else if (format === 'tsv') raw = parseTable(src, '\t', warn);
  else raw = parsePlain(src, warn);

  const gapSec = opts.mergeGapSec === null || opts.mergeGapSec === undefined ? 3 : Number(opts.mergeGapSec);
  const sorted = raw.slice().sort((a, b) => a.t - b.t); // 同じ秒の並びは入力順のまま（Node の sort は安定）
  const merged = mergeUtterances(sorted, Number.isFinite(gapSec) ? gapSec : 3);

  const utterances = merged.map((u) => {
    const o = { t: round(u.t, 3), speaker: u.speaker, text: u.text };
    if (typeof u.endT === 'number') o.endT = round(u.endT, 3);
    return o;
  });

  if (!utterances.length) warn.add('読み取れる発話がありませんでした（形式を指定して読み直してください）');

  return { utterances, speakers: summarizeSpeakers(utterances), format, warnings: warn.out() };
}

// 生ラベル → speaker の割り当てを適用して、transcript.js が食える形にする。
// mapping: { '田中先生': 'T', 'あかり': 'st_xxx' }
// 未マップのラベルは落とす。勝手に生徒として数えると、発話配分のジニ係数が狂うため
function applyMapping(utterances, mapping) {
  const warn = makeWarn();
  const map = mapping || {};
  const dropped = new Map();
  const out = [];
  for (const u of utterances || []) {
    const to = Object.prototype.hasOwnProperty.call(map, u.speaker) ? map[u.speaker] : null;
    if (!to) {
      dropped.set(u.speaker, (dropped.get(u.speaker) || 0) + 1);
      continue;
    }
    const o = { t: u.t, speaker: to, text: u.text };
    if (typeof u.endT === 'number') o.endT = u.endT;
    out.push(o);
  }
  for (const [label, n] of dropped) {
    warn.add(`話者「${label}」は対応づけされていないため、${n}件の発話を除きました`);
  }
  return { utterances: out, warnings: warn.out() };
}

module.exports = { parse, applyMapping, toSeconds, detectFormat };
