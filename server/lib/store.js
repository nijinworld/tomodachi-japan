'use strict';
// 依存ゼロの JSON ストア。
// 規模（授業 数千 / 発話 数十万）ではこれで足りる。足りなくなったら
// docs/エンジニア引き継ぎ書.md 8章「データベースに移すとき」を読むこと。
const fs = require('node:fs');
const path = require('node:path');

// テストは RANIUS_DATA_DIR で別の場所を指す。本番データを踏まないため。
const DATA_DIR = process.env.RANIUS_DATA_DIR
  ? path.resolve(process.env.RANIUS_DATA_DIR)
  : path.join(__dirname, '..', '..', 'data');

const COLLECTIONS = [
  'users', 'teams', 'classes', 'students', 'lessons', 'utterances',
  'scores', 'modelVersions', 'surveyResponses', 'feedbacks', 'mentorLogs',
  'costItems', 'incidents', 'clips', 'meetings', 'ratings', 'settings', 'auditLog',
  'surveyCycles',
];

const db = {};

function file(name) {
  return path.join(DATA_DIR, `${name}.json`);
}

function load() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const c of COLLECTIONS) {
    try {
      db[c] = JSON.parse(fs.readFileSync(file(c), 'utf8'));
    } catch {
      db[c] = [];
    }
    if (!Array.isArray(db[c])) db[c] = [];
  }
}

const dirty = new Set();
let timer = null;

function persist(name) {
  const tmp = `${file(name)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db[name], null, name === 'utterances' ? 0 : 2), 'utf8');
  fs.renameSync(tmp, file(name));
}

function flush() {
  for (const name of dirty) persist(name);
  dirty.clear();
  timer = null;
}

function touch(name) {
  dirty.add(name);
  if (!timer) timer = setTimeout(flush, 200);
}

function all(name) {
  return db[name] || [];
}

function find(name, pred) {
  return all(name).filter(pred);
}

function get(name, idValue) {
  return all(name).find((r) => r.id === idValue) || null;
}

function insert(name, rec) {
  db[name].push(rec);
  touch(name);
  return rec;
}

function insertMany(name, recs) {
  db[name].push(...recs);
  touch(name);
  return recs;
}

function update(name, idValue, patch) {
  const rec = get(name, idValue);
  if (!rec) return null;
  Object.assign(rec, patch);
  touch(name);
  return rec;
}

function remove(name, pred) {
  const before = db[name].length;
  db[name] = db[name].filter((r) => !pred(r));
  if (db[name].length !== before) touch(name);
  return before - db[name].length;
}

function replaceAll(name, recs) {
  db[name] = recs;
  touch(name);
}

function setting(key, fallback) {
  const s = all('settings').find((r) => r.key === key);
  return s ? s.value : fallback;
}

function setSetting(key, value) {
  const s = all('settings').find((r) => r.key === key);
  if (s) {
    s.value = value;
  } else {
    db.settings.push({ id: `set_${key}`, key, value });
  }
  touch('settings');
  return value;
}

load();
process.on('exit', flush);

module.exports = { db, all, find, get, insert, insertMany, update, remove, replaceAll, setting, setSetting, flush, load, DATA_DIR, COLLECTIONS };
