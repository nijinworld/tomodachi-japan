'use strict';
const crypto = require('node:crypto');

function sha256(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

let counter = 0;
function id(prefix) {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36).padStart(2, '0')}`;
}

function round(n, d = 3) {
  if (n === null || n === undefined || Number.isNaN(n)) return null;
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

function mean(xs) {
  const v = xs.filter((x) => typeof x === 'number' && !Number.isNaN(x));
  if (!v.length) return null;
  return v.reduce((a, b) => a + b, 0) / v.length;
}

function sd(xs) {
  const v = xs.filter((x) => typeof x === 'number' && !Number.isNaN(x));
  if (v.length < 2) return null;
  const m = mean(v);
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1));
}

// ジニ係数。0=完全に平等、1=完全に偏っている
function gini(xs) {
  const v = xs.filter((x) => typeof x === 'number' && x >= 0).sort((a, b) => a - b);
  const n = v.length;
  if (n === 0) return null;
  const total = v.reduce((a, b) => a + b, 0);
  if (total === 0) return 1; // 誰も話していない = 最悪の偏り扱い
  let cum = 0;
  for (let i = 0; i < n; i += 1) cum += (2 * (i + 1) - n - 1) * v[i];
  return cum / (n * total);
}

function median(xs) {
  const v = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

function clamp01(x) {
  if (x === null || Number.isNaN(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

// 秒 -> "MM:SS"。所見は必ず時刻つきで書くため、どこでも使う
function ts(sec) {
  const s = Math.max(0, Math.round(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function isoDate(d) {
  return new Date(d).toISOString().slice(0, 10);
}

function weekKey(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7; // 月曜=0
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}

module.exports = { sha256, id, round, mean, sd, gini, median, clamp01, ts, isoDate, weekKey, daysBetween };
