'use strict';
// Ranius日本語 — ともだちじゃぱん運用システム
// 依存パッケージゼロ。node server/index.js だけで動く。
// 依存を足したくなったら、docs/エンジニア引き継ぎ書.md 1章を先に読むこと。
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');
const api = require('./routes/api');
const store = require('./lib/store');

const PORT = Number(process.env.PORT || 5173);
const WEB_DIR = path.join(__dirname, '..', 'web');

// TLS。localhost だけで使うなら不要。社内LANや外から使うなら必ず入れること。
//   RANIUS_TLS_KEY / RANIUS_TLS_CERT で指定するか、certs/key.pem と certs/cert.pem を置く。
function tlsOptions() {
  const keyPath = process.env.RANIUS_TLS_KEY || path.join(__dirname, '..', 'certs', 'key.pem');
  const certPath = process.env.RANIUS_TLS_CERT || path.join(__dirname, '..', 'certs', 'cert.pem');
  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) return null;
  return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath), keyPath, certPath };
}
const TLS = tlsOptions();
// クッキーに Secure を付けるかどうかを、auth 側に伝える
process.env.RANIUS_SECURE_COOKIE = TLS ? '1' : '';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  rel = rel.replace(/\.\./g, '');
  const file = path.join(WEB_DIR, rel);
  if (!file.startsWith(WEB_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    // SPA。知らないパスは index.html を返す
    const idx = path.join(WEB_DIR, 'index.html');
    res.writeHead(200, { 'content-type': MIME['.html'] });
    res.end(fs.readFileSync(idx));
    return;
  }
  // キャッシュさせない。ファイルを直したのに画面が変わらない、で時間を溶かさないため。
  res.writeHead(200, {
    'content-type': MIME[path.extname(file)] || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  res.end(fs.readFileSync(file));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 32 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('JSONとして読めません: ' + e.message)); }
    });
    req.on('error', reject);
  });
}

const handler = async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = decodeURIComponent(parsed.pathname);

  if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);

  let body = {};
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
    try {
      body = await readBody(req);
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: e.message }));
      return;
    }
  }

  // 誰であるかはクッキーの署名からしか決めない。
  // ヘッダやクエリで「自分は誰々です」と名乗れる余地を残さないこと。
  const ctx = {
    method: req.method,
    path: pathname,
    query: parsed.query,
    body,
    headers: req.headers,
  };

  try {
    const result = await api.handle(ctx);
    const status = result.status || 200;
    const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
    if (result.cookie !== undefined) headers['set-cookie'] = result.cookie;
    // CSV のような、JSONでない返し方
    if (result.raw) {
      headers['content-type'] = result.contentType || 'text/plain; charset=utf-8';
      if (result.filename) headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`;
      res.writeHead(status, headers);
      res.end(result.raw);
      return;
    }
    res.writeHead(status, headers);
    res.end(JSON.stringify(result.body === undefined ? null : result.body));
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error('[error]', pathname, e);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: e.message, code: e.code || null }));
  }
};

const server = TLS ? https.createServer({ key: TLS.key, cert: TLS.cert }, handler) : http.createServer(handler);

server.listen(PORT, () => {
  const withPasscode = store.all('users').filter((u) => u.hash).length;
  const counts = store.COLLECTIONS
    .map((c) => `${c}:${store.all(c).length}`)
    .filter((s) => !s.endsWith(':0'))
    .join(' ');
  console.log('');
  console.log('  Ranius日本語 — ともだちじゃぱん運用システム');
  console.log(`  ${TLS ? 'https' : 'http'}://localhost:${PORT}${TLS ? '' : '   （TLSなし。社外から使うなら certs/ を置くこと）'}`);
  console.log(`  データ: ${store.DATA_DIR}`);
  console.log(`  ${counts || '（データなし。node scripts/seed.js を先に実行してください）'}`);
  if (!withPasscode) {
    console.log('');
    console.log('  ⚠️ 合言葉が1件も設定されていません。ログインできません。');
    console.log('     node scripts/set-passcode.js <ユーザーID または 名前> <合言葉>');
  }
  console.log('');
});
