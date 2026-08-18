'use strict';
// 認証とロール。
//
// 子どもの発話が入るシステムなので、ここは飾りではありません。
// ただし作りは最小限にしてあります（依存を足さないため）：
//   ・合言葉は scrypt でハッシュして保存する。平文はどこにも残さない
//   ・セッションは署名つきクッキー（HttpOnly）。サーバ側に状態を持たない
//   ・秘密鍵は初回起動時に生成して data/settings.json に置く
//
// 外部に公開する場合は、この上に HTTPS と、できれば二要素を足してください。
// いまの想定は「社内の端末から localhost、または社内ネットワーク」です。
const crypto = require('node:crypto');
const store = require('./store');

const SESSION_HOURS = 12;

// ---- 合言葉 ----
function hashPasscode(passcode, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(passcode), s, 32).toString('hex');
  return { salt: s, hash };
}

function verifyPasscode(passcode, user) {
  if (!user || !user.salt || !user.hash) return false;
  const { hash } = hashPasscode(passcode, user.salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(user.hash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ---- セッション ----
function secret() {
  let s = store.setting('session_secret', null);
  if (!s) {
    s = crypto.randomBytes(32).toString('hex');
    store.setSetting('session_secret', s);
  }
  return s;
}

function sign(payload) {
  return crypto.createHmac('sha256', secret()).update(payload).digest('hex').slice(0, 32);
}

function issue(userId, hours = SESSION_HOURS) {
  const exp = Date.now() + hours * 3600 * 1000;
  const payload = `${userId}.${exp}`;
  return `${payload}.${sign(payload)}`;
}

function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [userId, exp, mac] = parts;
  // 先に形を確かめる。ここを通さないと、全角文字のクッキーで
  // timingSafeEqual が「バイト長が違う」で例外を投げ、401 ではなく 500 になる。
  if (!/^[0-9a-f]{32}$/.test(mac)) return null;
  const expected = sign(`${userId}.${exp}`);
  if (!crypto.timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(expected, 'hex'))) return null;
  if (Number(exp) < Date.now()) return null;
  return userId;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookieHeader(token, hours = SESSION_HOURS) {
  // TLS で動いているときだけ Secure を付ける（localhost の http でも動くようにするため）
  const secure = process.env.RANIUS_SECURE_COOKIE ? '; Secure' : '';
  if (token === null) return `ranius_session=; Path=/; HttpOnly; SameSite=Strict${secure}; Max-Age=0`;
  return `ranius_session=${token}; Path=/; HttpOnly; SameSite=Strict${secure}; Max-Age=${hours * 3600}`;
}

// ---- ロール ----
// admin       … 全部
// mentor      … 担当の先生の授業・所見・記録。子どもの名前は見える
// facilitator … 自分の授業と自分の所見だけ。他の先生のものは見えない
// rater       … 盲検の採点キューだけ。名前もAIスコアもアームも見えない
// staff       … 費用・設定などの事務。授業の中身は見ない
const ROLES = ['admin', 'mentor', 'facilitator', 'rater', 'staff'];

function currentUser(ctx) {
  const cookies = parseCookies(ctx.headers && ctx.headers.cookie);
  const userId = verify(cookies.ranius_session);
  if (!userId) return null;
  const u = store.get('users', userId);
  if (!u || u.status === 'disabled') return null;
  return u;
}

// 誰がどの先生を見てよいか
function canSeeFacilitator(user, facilitatorId) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.role === 'facilitator') return user.id === facilitatorId;
  if (user.role === 'mentor') {
    const target = store.get('users', facilitatorId);
    if (!target) return false;
    // 同じチーム、または同じアームのメンター
    if (target.teamId && target.teamId === user.teamId) return true;
    const team = store.all('teams').find((t) => t.id === target.teamId);
    return !!(team && team.mentorId === user.id);
  }
  return false; // rater は名前で辿れてはいけない
}

// 子どもの名前を見てよいか（rater には絶対に見せない）
function canSeeChildNames(user) {
  return !!user && ['admin', 'mentor', 'facilitator'].includes(user.role);
}

module.exports = {
  hashPasscode, verifyPasscode, issue, verify, parseCookies, cookieHeader,
  currentUser, canSeeFacilitator, canSeeChildNames, ROLES, SESSION_HOURS,
};
