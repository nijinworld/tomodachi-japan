'use strict';
// 日本語の発話を数えるための最小限の道具。
// 形態素解析器は使わない（依存を増やすと引き継げなくなるため）。
// ここの近似はすべて未検証。数え方を変えたらモデル版が変わる。

const SMALL_KANA = 'ぁぃぅぇぉゃゅょゎァィゥェォャュョヮ';

// モーラ数。「がっこう」= 4。文字数ではない。
// かな1字=1、拗音の小書き=0、漢字=概算2、英数=0.5 として数える。
function moraCount(text) {
  let n = 0;
  for (const ch of String(text || '')) {
    const c = ch.codePointAt(0);
    if (SMALL_KANA.includes(ch)) continue;
    if ((c >= 0x3040 && c <= 0x309f) || (c >= 0x30a0 && c <= 0x30ff)) n += 1; // かな・カナ
    else if (c >= 0x4e00 && c <= 0x9fff) n += 2; // 漢字（概算）
    else if (/[A-Za-z0-9]/.test(ch)) n += 0.5;
  }
  return n;
}

// 文字バイグラム。言い直し・リキャストの検出に使う
function bigrams(text) {
  const t = String(text || '').replace(/[、。！？!?\s「」]/g, '');
  const out = new Set();
  for (let i = 0; i < t.length - 1; i += 1) out.add(t.slice(i, i + 2));
  if (t.length === 1) out.add(t);
  return out;
}

function overlap(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const g of A) if (B.has(g)) hit += 1;
  return hit / Math.min(A.size, B.size);
}

const PAT = {
  question: /[?？]$|(ますか|ですか|かな|でしょう|どう|なに|なん|どこ|だれ|いつ|どれ|どうして|なぜ)/,
  // 明示的訂正：はっきり直している
  explicitCorrection: /(じゃなくて|ではなく|ちがいます|ちがうよ|正しくは|正しい言い方|こう言います|こう言うんだ)/,
  // 聞き返し（意味交渉の開始）
  // 「えっと」を拾わないように、感嘆の「え」は疑問符つきのときだけ数える。
  // 「どこがわからない？」は聞き返しではなく理解確認なので、呼び出し側で先に判定すること。
  clarification: /(もういちど|もう一度|もういっかい|もう一回|どういう意味|なんて言った|なんて言いました|わかりません|わからないです|えっ?[?？])/,
  // 確認（〜ということ？）
  confirmation: /(ということ|ってこと|で合ってる|ですね[?？]|だね[?？])/,
  // 理解確認。ただし「わかった？」だけの空振りは別に数える
  comprehensionCheck: /(どういうこと|なんて意味|説明してみて|言ってみて|どこがわからない)/,
  emptyCheck: /^(わかった[?？]|わかりましたか[?？]|いいですか[?？]|大丈夫[?？])$/,
  // 受け止め（受容の反応）
  acknowledgement: /(そうだね|そうですね|なるほど|いいね|ありがとう|うんうん|そうか|わかった|よく言えた|言えたね)/,
  // 指名
  nomination: /(さん|くん|ちゃん)[、,]?\s*(どう|なに|言って|お願い|どうぞ|番)/,
  rephrase: /(つまり|べつの言い方|かんたんに言うと|言いかえると|これはね)/,
};

// 人格に触れる語。所見に入っていたら保存を拒否する
// （事業計画「やらないと決めていること」＝性格に触れない）
const PERSONALITY_TERMS = [
  '熱意', 'やる気', '意欲が', '性格', '積極性', '消極的', '向いていない', '向いてない',
  'センス', '努力不足', '真面目', '不真面目', '怠け', '甘え', '人柄',
  '愛情', '情熱', '素質', '天性', '資質', '適性がない',
];

function findPersonalityTerms(text) {
  const t = String(text || '');
  return PERSONALITY_TERMS.filter((w) => t.includes(w));
}

module.exports = { moraCount, bigrams, overlap, PAT, findPersonalityTerms, PERSONALITY_TERMS };
