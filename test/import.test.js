'use strict';
// node test/import.test.js
// 書き起こしの取り込み（server/lib/import.js）のテスト。
// 守っているのは「外から来た汚いテキストで止まらないこと」と
// 「時刻と日本語が変質しないこと」の2つ。時刻が狂うと所見の根拠が狂う。
const assert = require('node:assert');
const { moraCount } = require('../server/lib/ja');
const { analyze } = require('../server/lib/transcript');
const { parse, applyMapping, toSeconds, detectFormat } = require('../server/lib/import');

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push(['ok', name]);
  } catch (e) {
    results.push(['NG', `${name}\n     ${e.message}`]);
  }
}

// ---- サンプル（各形式の短い実物に近い形） ----

const VTT = `WEBVTT

1
00:00:05.000 --> 00:00:08.000
<v 田中先生>あかりさん、きのうは なにを しましたか？</v>

2
00:00:09.000 --> 00:00:11.500
<v あかり>きのう、学校に いきます</v>

3
00:00:20.000 --> 00:00:23.000
はると: たのしかったです
`;

const SRT = `1
00:00:05,000 --> 00:00:08,000
田中先生: きょうは てんきが いいですね

2
00:01:05,000 --> 00:01:08,000
あかり: はい、いい てんきです
`;

const ZOOM = `00:00:12
田中先生: こんにちは
00:00:20
あかり: こんにちは、先生
00:00:35
はると: せんせい、しつもんが あります
`;

const PLAIN = `00:12 田中先生: きょうは なにを しますか？
[01:05] あかり こうえんに いきました
1:02:03 田中先生: そうですか
`;

const CSV = `t,speaker,text
5,田中先生,はじめましょう
01:05,あかり,はい、おねがいします
`;

const TSV = [
  ['秒', '話者', '内容'],
  ['10', '田中先生', 'これは タブ区切りです'],
  ['1:00', 'あかり', 'わかりました'],
].map((r) => r.join('\t')).join('\n');

// ---- 5形式それぞれをパースできる ----

test('WebVTT を読める（<v 話者名> と 本文冒頭の「話者名:」の両方）', () => {
  const r = parse(VTT);
  assert.strictEqual(r.format, 'webvtt');
  assert.strictEqual(r.utterances.length, 3);
  assert.deepStrictEqual(r.utterances.map((u) => u.speaker), ['田中先生', 'あかり', 'はると']);
  assert.strictEqual(r.utterances[0].t, 5);
  assert.strictEqual(r.utterances[0].endT, 8);
  assert.strictEqual(r.utterances[1].endT, 11.5);
  assert.strictEqual(r.utterances[0].text, 'あかりさん、きのうは なにを しましたか？');
  assert.strictEqual(r.warnings.length, 0);
});

test('SRT を読める（連番＋カンマ区切りのミリ秒）', () => {
  const r = parse(SRT);
  assert.strictEqual(r.format, 'srt');
  assert.strictEqual(r.utterances.length, 2);
  assert.strictEqual(r.utterances[0].speaker, '田中先生');
  assert.strictEqual(r.utterances[1].text, 'はい、いい てんきです');
  assert.strictEqual(r.warnings.length, 0);
});

test('Zoom のテキスト書き起こしを読める（時刻の行＋次行に本文）', () => {
  const r = parse(ZOOM);
  assert.strictEqual(r.format, 'zoom');
  assert.strictEqual(r.utterances.length, 3);
  assert.deepStrictEqual(r.utterances.map((u) => u.t), [12, 20, 35]);
  assert.strictEqual(r.utterances[2].speaker, 'はると');
});

test('Zoom の1行版（12:34:56 話者名: テキスト）も読める', () => {
  const r = parse('01:02:03 田中先生: そうですね\n01:02:30 あかり: はい\n', { format: 'zoom' });
  assert.strictEqual(r.utterances.length, 2);
  assert.strictEqual(r.utterances[0].t, 3723);
  assert.strictEqual(r.utterances[0].speaker, '田中先生');
});

test('プレーンテキストを読める（MM:SS / [MM:SS] 名前 / H:MM:SS）', () => {
  const r = parse(PLAIN);
  assert.strictEqual(r.format, 'plain');
  assert.strictEqual(r.utterances.length, 3);
  assert.deepStrictEqual(r.utterances.map((u) => u.t), [12, 65, 3723]);
  assert.strictEqual(r.utterances[1].speaker, 'あかり');
  assert.strictEqual(r.utterances[1].text, 'こうえんに いきました');
});

test('CSV を読める', () => {
  const r = parse(CSV);
  assert.strictEqual(r.format, 'csv');
  assert.strictEqual(r.utterances.length, 2);
  assert.deepStrictEqual(r.utterances.map((u) => u.t), [5, 65]);
  assert.strictEqual(r.utterances[1].speaker, 'あかり');
});

test('TSV を読める', () => {
  const r = parse(TSV);
  assert.strictEqual(r.format, 'tsv');
  assert.strictEqual(r.utterances.length, 2);
  assert.deepStrictEqual(r.utterances.map((u) => u.t), [10, 60]);
  assert.strictEqual(r.utterances[0].text, 'これは タブ区切りです');
});

test('形式を自動判定できる', () => {
  assert.strictEqual(detectFormat(VTT), 'webvtt');
  assert.strictEqual(detectFormat(SRT), 'srt');
  assert.strictEqual(detectFormat(ZOOM), 'zoom');
  assert.strictEqual(detectFormat(PLAIN), 'plain');
  assert.strictEqual(detectFormat(CSV), 'csv');
  assert.strictEqual(detectFormat(TSV), 'tsv');
});

// ---- 時刻の正規化 ----

test('時刻が秒になる（01:05 → 65）', () => {
  assert.strictEqual(toSeconds('01:05'), 65);
  assert.strictEqual(toSeconds('1:02:03'), 3723);
  assert.strictEqual(toSeconds('00:00:12.500'), 12.5);
  assert.strictEqual(toSeconds('00:00:12,500'), 12.5);
  assert.strictEqual(toSeconds('[01:05]'), 65);
  assert.strictEqual(toSeconds('90'), 90);
  assert.strictEqual(toSeconds('12.25'), 12.25);
  assert.strictEqual(toSeconds('あ'), null);
  assert.strictEqual(toSeconds(''), null);
});

// ---- 結合 ----

const CHOPPED = `00:10 あかり: きのう
00:12 あかり: 学校に いきました
00:30 あかり: それから こうえんに いきました
`;

test('同一話者の3秒以内の連続発話は1つに結合される', () => {
  const r = parse(CHOPPED);
  assert.strictEqual(r.utterances.length, 2);
  assert.strictEqual(r.utterances[0].text, 'きのう学校に いきました');
  assert.strictEqual(r.utterances[0].t, 10);
  assert.strictEqual(r.utterances[1].t, 30);
});

test('3秒を超えて空いていれば結合しない', () => {
  const r = parse('00:10 あかり: きのう\n00:14 あかり: 学校に いきました\n');
  assert.strictEqual(r.utterances.length, 2);
});

test('話者が違えば近くても結合しない', () => {
  const r = parse('00:10 あかり: はい\n00:11 田中先生: そうですね\n');
  assert.strictEqual(r.utterances.length, 2);
});

test('mergeGapSec で結合の閾値を変えられる', () => {
  assert.strictEqual(parse(CHOPPED, { mergeGapSec: 0 }).utterances.length, 3);
  assert.strictEqual(parse(CHOPPED, { mergeGapSec: 25 }).utterances.length, 1);
});

test('結合の判定は終了時刻を見る（字幕の細切れが繋がる）', () => {
  const vtt = `WEBVTT

00:00:05.000 --> 00:00:08.000
<v 田中先生>きょうは

00:00:09.000 --> 00:00:12.000
<v 田中先生>てんきが いいですね
`;
  const r = parse(vtt);
  assert.strictEqual(r.utterances.length, 1);
  assert.strictEqual(r.utterances[0].text, 'きょうはてんきが いいですね');
  assert.strictEqual(r.utterances[0].endT, 12);
});

// ---- 壊れた入力 ----

test('壊れた行があっても他の行は読める＋warnings に残る', () => {
  const broken = `00:10 田中先生: こんにちは
これは 時刻のない行です
--:-- こわれた時刻の行
00:20 あかり: はい
`;
  const r = parse(broken, { format: 'plain' });
  assert.strictEqual(r.utterances.length, 2);
  assert.strictEqual(r.utterances[0].text, 'こんにちは');
  assert.strictEqual(r.utterances[1].text, 'はい');
  assert.strictEqual(r.warnings.length, 2);
  assert.ok(r.warnings.some((w) => w.includes('2行目')), '2行目の警告がない');
  assert.ok(r.warnings.some((w) => w.includes('3行目')), '3行目の警告がない');
});

test('空行・タイムスタンプだけの行・記号の行は黙って落とす', () => {
  const noisy = '00:10 田中先生: こんにちは\n\n>>\n----\n00:20\n00:30 あかり: はい\n';
  const r = parse(noisy, { format: 'plain' });
  assert.strictEqual(r.utterances.length, 2);
  assert.strictEqual(r.warnings.length, 0, `余計な警告: ${r.warnings.join(' / ')}`);
});

test('CSV の壊れた行だけを落として、行番号を警告に残す', () => {
  const csv = 't,speaker,text\n5,田中先生,はじめましょう\nあ,あかり,こわれた行\n10,はると,よめる行\n';
  const r = parse(csv);
  assert.strictEqual(r.utterances.length, 2);
  assert.ok(r.warnings.some((w) => w.includes('3行目')), r.warnings.join(' / '));
});

test('読めない入力でも例外にならず、警告だけが返る', () => {
  const r = parse('');
  assert.strictEqual(r.utterances.length, 0);
  assert.deepStrictEqual(r.speakers, []);
  assert.ok(r.warnings.some((w) => w.includes('読み取れる発話がありませんでした')));
  assert.doesNotThrow(() => parse(null));
  assert.doesNotThrow(() => parse('ぜんぶ ただの文章です。時刻がありません。'));
});

// ---- CSV の列名の揺れ ----

test('CSV の列名の揺れを吸収する（開始/発言者/発話）', () => {
  const r = parse('開始,発言者,発話\n00:30,田中先生,では はじめます\n45,あかり,はい\n');
  assert.strictEqual(r.utterances.length, 2);
  assert.deepStrictEqual(r.utterances.map((u) => u.t), [30, 45]);
  assert.strictEqual(r.utterances[0].speaker, '田中先生');
});

test('CSV の列名の揺れを吸収する（time/名前/本文、大文字や空白つき）', () => {
  const r = parse('Time, 名前 ,本文\n5,田中先生,はじめましょう\n');
  assert.strictEqual(r.utterances.length, 1);
  assert.strictEqual(r.utterances[0].speaker, '田中先生');
  assert.strictEqual(r.utterances[0].text, 'はじめましょう');
});

test('CSV は列の順番が違っても読める＋引用符の中のカンマを壊さない', () => {
  const r = parse('内容,話者,秒\n"はい、そうです, ときどき",あかり,7\n');
  assert.strictEqual(r.utterances.length, 1);
  assert.strictEqual(r.utterances[0].t, 7);
  assert.strictEqual(r.utterances[0].speaker, 'あかり');
  assert.strictEqual(r.utterances[0].text, 'はい、そうです, ときどき');
});

test('本文の列がない表は、黙って0件にせず警告を出す', () => {
  const r = parse('t,speaker\n5,田中先生\n', { format: 'csv' });
  assert.strictEqual(r.utterances.length, 0);
  assert.ok(r.warnings.some((w) => w.includes('本文の列')));
});

// ---- 話者 ----

test('話者IDへの変換はしない（生のラベルのまま返す）', () => {
  const r = parse(VTT);
  assert.ok(r.utterances.every((u) => u.speaker !== 'T'), '勝手に T に変換してはいけない');
  assert.deepStrictEqual(r.speakers.map((s) => s.label), ['田中先生', 'あかり', 'はると']);
});

test('speakers に件数・モーラ合計・最初の発話が入る', () => {
  const r = parse(PLAIN);
  const t = r.speakers.find((s) => s.label === '田中先生');
  assert.strictEqual(t.utterances, 2);
  assert.strictEqual(t.sampleText, 'きょうは なにを しますか？');
  assert.strictEqual(t.totalMora, moraCount('きょうは なにを しますか？') + moraCount('そうですか'));
});

test('話者名が取れない行は「不明」として残す（落とさない）', () => {
  const r = parse('00:10 こんにちは。\n', { format: 'plain' });
  assert.strictEqual(r.utterances.length, 1);
  assert.strictEqual(r.utterances[0].speaker, '不明');
});

// ---- 日本語と BOM ----

test('日本語のテキストが壊れない（モーラ数が変わらない）', () => {
  const src = 'きのう、学校に いきました';
  const r = parse(`00:10 あかり: ${src}\n`);
  assert.strictEqual(r.utterances[0].text, src);
  assert.strictEqual(moraCount(r.utterances[0].text), moraCount(src));
});

test('結合してもモーラ数の合計が変わらない', () => {
  const a = 'きのう';
  const b = '学校に いきました';
  const r = parse(`00:10 あかり: ${a}\n00:12 あかり: ${b}\n`);
  assert.strictEqual(r.utterances.length, 1);
  assert.strictEqual(moraCount(r.utterances[0].text), moraCount(a) + moraCount(b));
});

test('先頭の BOM を取り除く', () => {
  const bom = String.fromCharCode(0xfeff);
  const r = parse(bom + CSV);
  assert.strictEqual(r.format, 'csv');
  assert.strictEqual(r.utterances.length, 2);
  assert.strictEqual(r.utterances[0].speaker, '田中先生');
});

test('同じ入力からは必ず同じ結果が出る', () => {
  assert.strictEqual(JSON.stringify(parse(VTT)), JSON.stringify(parse(VTT)));
});

// ---- applyMapping ----

test('applyMapping：割り当てたラベルが speaker になる', () => {
  const r = parse(VTT);
  const m = applyMapping(r.utterances, { 田中先生: 'T', あかり: 'st_1', はると: 'st_2' });
  assert.deepStrictEqual(m.utterances.map((u) => u.speaker), ['T', 'st_1', 'st_2']);
  assert.strictEqual(m.utterances[0].t, 5);
  assert.strictEqual(m.utterances[0].text, 'あかりさん、きのうは なにを しましたか？');
  assert.strictEqual(m.warnings.length, 0);
});

test('applyMapping：未マップの話者は落とし、warnings に残す', () => {
  const r = parse(VTT);
  const m = applyMapping(r.utterances, { 田中先生: 'T', あかり: 'st_1' });
  assert.strictEqual(m.utterances.length, 2);
  assert.ok(m.utterances.every((u) => u.speaker !== 'はると'));
  assert.strictEqual(m.warnings.length, 1);
  assert.ok(m.warnings[0].includes('はると'), m.warnings[0]);
  assert.ok(m.warnings[0].includes('1件'), m.warnings[0]);
});

test('applyMapping：mapping が空なら全部落ちる（勝手に生徒扱いしない）', () => {
  const r = parse(VTT);
  const m = applyMapping(r.utterances, {});
  assert.strictEqual(m.utterances.length, 0);
  assert.strictEqual(m.warnings.length, 3);
});

test('applyMapping の結果を transcript.analyze がそのまま読める', () => {
  const r = parse(VTT);
  const m = applyMapping(r.utterances, { 田中先生: 'T', あかり: 'st_1', はると: 'st_2' });
  const { signals } = analyze(m.utterances, { roster: ['st_1', 'st_2'] });
  assert.strictEqual(signals.utterance_count, 3);
  assert.strictEqual(signals.teacher_utterance_count, 1);
  assert.strictEqual(signals.student_utterance_count, 2);
  assert.strictEqual(signals.silent_student_count, 0);
});

// ---- 結果 ----
const ng = results.filter((r) => r[0] === 'NG');
console.log('');
for (const [s, name] of results) console.log(`  ${s === 'ok' ? '  ok' : '  NG'}  ${name}`);
console.log('');
console.log(`  ${results.length - ng.length} / ${results.length} 通過`);
console.log('');
process.exit(ng.length ? 1 : 0);
