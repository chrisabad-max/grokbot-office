// Bot HQ server: tails the journal, serves /api/state, the static web app and the password gate.
// Usage: node server/server.js [--dev] [--port 8787] [--host 127.0.0.1] [--journal path] [--no-auth]
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { Journal } from './journal.js';
import { StateStore } from './state.js';
import { Auth, loadCredentials, loadViewKey, loginPage, safeNext, sessionCookie, clearCookie } from './auth.js';
import { createStatic } from './static.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export function parseArgs(argv, env = process.env) {
  const o = {
    dev: false,
    port: Number(env.BOTHQ_PORT) || 8787,
    host: env.BOTHQ_HOST || '127.0.0.1',
    journal: env.BOTHQ_JOURNAL || null,
    noAuth: false,
    demo: null,
    tz: env.BOTHQ_TZ || 'Europe/Sofia',
    dataDir: null,
    noCache: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case '--dev': o.dev = true; break;
      case '--port': o.port = Number(val()); break;
      case '--host': o.host = val(); break;
      case '--journal': o.journal = path.resolve(val()); break;
      case '--no-auth': o.noAuth = true; break;
      case '--demo': o.demo = true; break;
      case '--no-demo': o.demo = false; break;
      case '--tz': o.tz = val(); break;
      case '--data-dir': o.dataDir = path.resolve(val()); break;
      case '--no-cache': o.noCache = true; break;
      case '-h': case '--help': o.help = true; break;
      default: throw new Error(`unknown argument: ${a}`);
    }
  }
  if (!Number.isInteger(o.port) || o.port < 0 || o.port > 65535) throw new Error('invalid --port');
  return o;
}

const HELP = `Bot HQ server
  node server/server.js [--dev] [--port 8787] [--host 127.0.0.1] [--journal path] [--no-auth]
  --dev          journal = ./data/events.jsonl and DEMO badge on
  --demo/--no-demo  force the demo flag
  --no-auth      disable the password gate (only with --host 127.0.0.1)
  --tz ZONE      timezone for timestamps and "today" (default Europe/Sofia)
  --data-dir D   config/credentials directory (default ./data)
  --no-cache     revalidate /assets/ on every load too (a local wallpaper shows edited images after a reload)
Env: BOTHQ_PASSWORD, BOTHQ_PORT, BOTHQ_HOST, BOTHQ_JOURNAL, BOTHQ_TZ
`;

/** Watches a JSON config file by mtime/size; calls onChange(obj|null) on (re)load. */
class JsonConfig {
  constructor(file, onChange, log) {
    this.file = file;
    this.onChange = onChange;
    this.log = log;
    this.sig = null;
  }

  check() {
    let sig = 'missing';
    try {
      const st = fs.statSync(this.file);
      sig = `${st.mtimeMs}:${st.size}`;
    } catch { /* missing */ }
    if (sig === this.sig) return;
    const first = this.sig === null;
    this.sig = sig;
    if (sig === 'missing') {
      if (!first) this.log(`config removed: ${path.basename(this.file)}`);
      this.onChange(null);
      return;
    }
    try {
      this.onChange(JSON.parse(fs.readFileSync(this.file, 'utf8').replace(/^﻿/, '')));
      if (!first) this.log(`config reloaded: ${path.basename(this.file)}`);
    } catch (err) {
      this.log(`config ${path.basename(this.file)} is invalid, keeping previous: ${err.message}`);
    }
  }
}

export function createApp(opts = {}) {
  const root = opts.root || ROOT;
  const dataDir = opts.dataDir || path.join(root, 'data');
  const log = opts.log || ((m) => console.log(`[${new Date().toISOString()}] ${m}`));
  const host = opts.host || '127.0.0.1';
  const useAuth = opts.auth !== false;
  const failDelayMs = opts.failDelayMs ?? 400;
  if (!useAuth && !LOOPBACK_HOSTS.has(host)) throw new Error('--no-auth is only allowed with --host 127.0.0.1');

  const journalPath = opts.journalPath || path.join(dataDir, 'events.jsonl');
  // Which hand-made blobs exist (assets/blobs/<id>.glb), re-read at most every 5 s: lets the browser skip GLB probes that would 404.
  const blobDir = path.join(root, 'assets', 'blobs');
  let glbIds = null, glbAt = 0;
  const hasAvatar = (id) => {
    const t = Date.now();
    if (!glbIds || t - glbAt > 5000) {
      try { glbIds = new Set(fs.readdirSync(blobDir).filter((f) => f.endsWith('.glb')).map((f) => f.slice(0, -4))); } catch { glbIds = new Set(); }
      glbAt = t;
    }
    return glbIds.has(id);
  };
  const store = new StateStore({ now: opts.now, tz: opts.tz, demo: !!opts.demo, hasAvatar });

  let creds = null;
  let auth = null;
  let viewKey = null;
  if (useAuth) {
    creds = opts.credentials || loadCredentials({ dataDir });
    viewKey = opts.viewKey ? { key: opts.viewKey, generated: false, file: null } : loadViewKey({ dataDir });
    auth = new Auth({ password: creds.password, secret: creds.secret, viewKey: viewKey.key, now: opts.now });
  }

  const statics = createStatic([
    { prefix: '/', dir: path.join(root, 'web'), cache: 'no-cache' },
    { prefix: '/assets/', dir: path.join(root, 'assets'), cache: opts.noCache ? 'no-cache' : 'public, max-age=3600' },
  ]);

  const configs = [
    new JsonConfig(path.join(dataDir, 'floors.json'), (o) => store.setFloorsConfig(o), log),
    new JsonConfig(path.join(dataDir, 'bots.json'), (o) => store.setBotsConfig(o), log),
  ];
  for (const c of configs) c.check();

  const journal = new Journal(journalPath, {
    stats: store.meta,
    log,
    pollMs: opts.pollMs,
    tailBytes: opts.tailBytes,
    onRecords: (records, info) => {
      store.applyBatch(records, info);
      if (!info.initial) store.commit();
    },
  });

  // ---------- response helpers ----------

  const baseHeaders = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
  };

  function send(res, status, type, body, extra = {}) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    res.writeHead(status, { ...baseHeaders, 'Content-Type': type, 'Content-Length': buf.length, ...extra });
    res.end(buf);
  }
  const sendJson = (res, status, obj, extra) => send(res, status, 'application/json; charset=utf-8', JSON.stringify(obj), { 'Cache-Control': 'no-store', ...extra });
  const redirect = (res, status, location, extra = {}) => {
    res.writeHead(status, { ...baseHeaders, Location: location, 'Cache-Control': 'no-store', 'Content-Length': 0, ...extra });
    res.end();
  };

  const isHttps = (req) => String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';

  function clientIp(req) {
    const remote = req.socket.remoteAddress || '';
    if (remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1') {
      const h = req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0];
      if (h) return String(h).trim().slice(0, 64);
    }
    return remote;
  }

  function readBody(req, limit = 4096) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  // ---------- /api/state ----------

  let body = { state: null, json: null, gz: null };

  function handleState(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' }, { Allow: 'GET, HEAD' });
    store.tick();
    const since = url.searchParams.get('since');
    if (since !== null && since !== '' && Number(since) === store.version) {
      return sendJson(res, 200, { version: store.version, unchanged: true });
    }
    const state = store.snapshot();
    if (body.state !== state) body = { state, json: Buffer.from(JSON.stringify(state)), gz: null };
    const headers = { 'Cache-Control': 'no-store', Vary: 'Accept-Encoding' };
    let out = body.json;
    if (/\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
      body.gz ??= zlib.gzipSync(body.json, { level: 6 });
      out = body.gz;
      headers['Content-Encoding'] = 'gzip';
    }
    return send(res, 200, 'application/json; charset=utf-8', req.method === 'HEAD' ? Buffer.alloc(0) : out, { ...headers, 'Content-Length': out.length });
  }

  // ---------- /login ----------

  async function handleLogin(req, res, url) {
    if (!useAuth) return redirect(res, 302, '/');
    const secure = isHttps(req);
    if (req.method === 'GET' || req.method === 'HEAD') {
      const next = safeNext(url.searchParams.get('next') || '/');
      if (auth.isAuthed(req)) return redirect(res, 302, next);
      return send(res, 200, 'text/html; charset=utf-8', loginPage({ next }), { 'Cache-Control': 'no-store' });
    }
    if (req.method !== 'POST') return send(res, 405, 'text/plain; charset=utf-8', 'Method Not Allowed', { Allow: 'GET, HEAD, POST' });

    const ip = clientIp(req);
    let form;
    try {
      form = new URLSearchParams(await readBody(req));
    } catch {
      return send(res, 413, 'text/plain; charset=utf-8', 'Payload Too Large');
    }
    const next = safeNext(form.get('next') || '/');
    const limit = auth.rateCheck(ip);
    if (!limit.ok) {
      const mins = Math.max(1, Math.ceil(limit.retryAfter / 60));
      return send(res, 429, 'text/html; charset=utf-8', loginPage({ error: `Слишком много попыток. Попробуй через ${mins} мин.`, next }), {
        'Cache-Control': 'no-store', 'Retry-After': String(limit.retryAfter),
      });
    }
    if (!auth.checkPassword(form.get('password'))) {
      auth.recordFail(ip);
      if (failDelayMs) await new Promise((r) => setTimeout(r, failDelayMs)); // slow down guessing
      return send(res, 401, 'text/html; charset=utf-8', loginPage({ error: 'Неверный пароль', next }), { 'Cache-Control': 'no-store' });
    }
    auth.recordSuccess(ip);
    return redirect(res, 303, next, { 'Set-Cookie': sessionCookie(auth.issue(), { secure }) });
  }

  // ---------- view-only key (wallpaper links) ----------

  /** The query string without any `key=` pair; every other pair stays byte-for-byte as the client sent it. */
  function queryWithoutKey(search) {
    const kept = search.replace(/^\?/, '').split('&').filter((kv) => kv && !/^key(=|$)/.test(kv));
    return kept.length ? `?${kept.join('&')}` : '';
  }

  // ---------- routing ----------

  async function onRequest(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return send(res, 400, 'text/plain; charset=utf-8', 'Bad Request');
    }
    const p = url.pathname;

    if (p === '/healthz') return send(res, 200, 'text/plain; charset=utf-8', 'ok', { 'Cache-Control': 'no-store' });

    // ?key=<view key> on any page: same session cookie as a password login, then the same URL without the key.
    // A wrong key is ignored (falls through to the normal gate / login page). Never for the API.
    if (useAuth && url.searchParams.has('key') && p !== '/logout' && !p.startsWith('/api/') && (req.method === 'GET' || req.method === 'HEAD')) {
      if (auth.checkViewKey(url.searchParams.get('key'))) {
        return redirect(res, 302, safeNext(p + queryWithoutKey(url.search)), { 'Set-Cookie': sessionCookie(auth.issue(), { secure: isHttps(req) }) });
      }
    }

    if (p === '/login') return handleLogin(req, res, url);
    if (p === '/logout') {
      return redirect(res, 302, useAuth ? '/login' : '/', useAuth ? { 'Set-Cookie': clearCookie({ secure: isHttps(req) }) } : {});
    }

    if (useAuth && !auth.isAuthed(req)) {
      if (p.startsWith('/api/')) return sendJson(res, 401, { error: 'unauthorized' });
      return redirect(res, 302, `/login?next=${encodeURIComponent(safeNext(p + queryWithoutKey(url.search)))}`);
    }

    if (p === '/api/state') return handleState(req, res, url);
    if (p.startsWith('/api/')) return sendJson(res, 404, { error: 'not found' });

    if (statics.handle(req, res, p)) return undefined;
    return send(res, 404, 'text/plain; charset=utf-8', 'Not found');
  }

  const server = http.createServer((req, res) => {
    onRequest(req, res).catch((err) => {
      log(`request error: ${err.stack || err}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      else res.destroy();
    });
  });
  server.on('clientError', (_err, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); else socket.destroy(); });

  let ticker = null;

  return {
    server, store, journal, auth, creds, journalPath, dataDir,
    viewKey: viewKey ? viewKey.key : null,
    start({ port = 8787 } = {}) {
      journal.start({ watch: opts.watch !== false });
      store.commit();
      ticker = setInterval(() => {
        for (const c of configs) c.check();
        store.tick();
      }, 1000);
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve(server.address());
        });
      });
    },
    stop() {
      if (ticker) clearInterval(ticker);
      journal.stop();
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err.message}\n\n${HELP}`);
    process.exit(2);
  }
  if (args.help) { console.log(HELP); return; }

  const dataDir = args.dataDir || path.join(ROOT, 'data');
  const journalPath = args.journal || (args.dev ? path.join(dataDir, 'events.jsonl') : '/workspace/bot-hq/events.jsonl');
  let app;
  try {
    app = createApp({
      root: ROOT, dataDir, journalPath, host: args.host, auth: !args.noAuth, tz: args.tz,
      demo: args.demo ?? args.dev, noCache: args.noCache,
    });
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }

  let addr;
  try {
    addr = await app.start({ port: args.port });
  } catch (err) {
    console.error(err.code === 'EADDRINUSE' ? `port ${args.port} is already in use` : `cannot listen: ${err.message}`);
    process.exit(1);
  }

  const shown = addr.family === 'IPv6' ? `[${addr.address}]` : addr.address;
  console.log(`Bot HQ listening on http://${shown}:${addr.port}`);
  console.log(`journal: ${app.journalPath}`);
  console.log(`auth: ${args.noAuth ? 'OFF (loopback only)' : `on, password from ${app.creds.source}`}`);
  if (app.viewKey) console.log(`wallpaper view key: ${path.join(dataDir, 'view-key.txt')}`);
  if (app.creds?.generated) {
    console.log('----------------------------------------------');
    console.log(`NEW PASSWORD (saved to ${path.join(dataDir, 'password.txt')}): ${app.creds.password}`);
    console.log('----------------------------------------------');
  }

  let closing = false;
  const shutdown = (sig) => {
    if (closing) return;
    closing = true;
    console.log(`${sig} received, shutting down`);
    const t = setTimeout(() => process.exit(0), 2000);
    t.unref();
    app.stop().then(() => process.exit(0));
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => shutdown(sig));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
