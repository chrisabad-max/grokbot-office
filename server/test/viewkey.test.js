// Wallpaper view-only key: data/view-key.txt, ?key=<key> on a page -> session cookie + redirect without the key.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import { Auth, COOKIE, loadViewKey } from '../auth.js';

/** Raw request: the path reaches the server untouched (no client-side URL normalisation). */
function raw(port, { method = 'GET', path: p = '/', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

const setCookie = (res) => [].concat(res.headers['set-cookie'] || []).join(', ');   // node gives an array
const cookieOf = (res) => setCookie(res).split(';')[0];

async function boot(extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bothq-vk-'));
  for (const d of ['web', 'assets', 'data']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'web', 'index.html'), '<!doctype html><title>hq</title>');
  fs.writeFileSync(path.join(root, 'web', 'app.js'), 'export {};');
  const app = createApp({
    root, dataDir: path.join(root, 'data'), journalPath: path.join(root, 'data', 'events.jsonl'), host: '127.0.0.1', failDelayMs: 0,
    credentials: { password: 'pw-123', secret: 'a'.repeat(64), source: 'test' }, log: () => {}, ...extra,
  });
  const addr = await app.start({ port: 0 });
  const close = async () => { await app.stop(); fs.rmSync(root, { recursive: true, force: true }); };
  return { app, port: addr.port, root, key: app.viewKey, close };
}

test('view key: generated once (>= 32 hex chars), persisted, reused, garbage replaced', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bothq-vk-file-'));
  try {
    const a = loadViewKey({ dataDir: dir });
    assert.equal(a.generated, true);
    assert.match(a.key, /^[0-9a-f]{32,}$/);
    assert.equal(fs.readFileSync(path.join(dir, 'view-key.txt'), 'utf8').trim(), a.key);
    const b = loadViewKey({ dataDir: dir });
    assert.equal(b.generated, false);
    assert.equal(b.key, a.key);
    fs.writeFileSync(path.join(dir, 'view-key.txt'), 'short\n');
    const c = loadViewKey({ dataDir: dir });
    assert.equal(c.generated, true);
    assert.match(c.key, /^[0-9a-f]{32,}$/);
    assert.notEqual(c.key, a.key);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Auth.checkViewKey: exact match only, never throws on odd input, disabled without a key', () => {
  const on = new Auth({ password: 'p', secret: 's'.repeat(40), viewKey: 'k'.repeat(40) });
  assert.equal(on.checkViewKey('k'.repeat(40)), true);
  assert.equal(on.checkViewKey(' ' + 'k'.repeat(40) + '\n'), true);
  for (const bad of ['', 'k'.repeat(39), 'k'.repeat(41), 'x'.repeat(40), null, undefined, 42, {}, 'k'.repeat(5000)]) {
    assert.equal(on.checkViewKey(bad), false, String(bad).slice(0, 12));
  }
  const off = new Auth({ password: 'p', secret: 's'.repeat(40) });
  assert.equal(off.checkViewKey('anything'), false);
  assert.equal(off.checkViewKey(''), false);
});

test('server creates data/view-key.txt on first start', async () => {
  const s = await boot();
  try {
    assert.match(s.key, /^[0-9a-f]{32,}$/);
    assert.equal(fs.readFileSync(path.join(s.root, 'data', 'view-key.txt'), 'utf8').trim(), s.key);
  } finally { await s.close(); }
});

test('?key= on a page: session cookie + redirect to the same URL without the key', async () => {
  const s = await boot();
  try {
    const r = await raw(s.port, { path: `/?mode=wallpaper&key=${s.key}` });
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, '/?mode=wallpaper');
    assert.match(setCookie(r), new RegExp(`^${COOKIE}=`));
    assert.match(setCookie(r), /HttpOnly/);
    assert.match(setCookie(r), /SameSite=Lax/);
    assert.doesNotMatch(setCookie(r), /Secure/);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.ok(!String(r.headers.location).includes(s.key));
    // the cookie is a real session: pages and the API open with it
    const cookie = cookieOf(r);
    assert.ok(s.app.auth.isAuthed({ headers: { cookie } }));
    assert.equal((await raw(s.port, { path: '/api/state', headers: { cookie } })).status, 200);
    assert.equal((await raw(s.port, { path: '/?mode=wallpaper', headers: { cookie } })).status, 200);
    // without the cookie the same page still needs a login
    assert.equal((await raw(s.port, { path: '/?mode=wallpaper' })).status, 302);
  } finally { await s.close(); }
});

test('?key= keeps the path and every other query pair byte-for-byte, wherever the key sits', async () => {
  const s = await boot();
  try {
    let r = await raw(s.port, { path: `/?key=${s.key}&mode=wallpaper&time=22:30&floor=x-content&cycle=60` });
    assert.equal(r.headers.location, '/?mode=wallpaper&time=22:30&floor=x-content&cycle=60');
    r = await raw(s.port, { path: `/?mode=wallpaper&key=${s.key}&cycle=60` });
    assert.equal(r.headers.location, '/?mode=wallpaper&cycle=60');
    r = await raw(s.port, { path: `/app.js?key=${s.key}` });
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, '/app.js');
    assert.ok(r.headers['set-cookie']);
    r = await raw(s.port, { path: `/?key=${s.key}&key=${s.key}` });
    assert.equal(r.headers.location, '/');
    // HEAD works like GET
    r = await raw(s.port, { method: 'HEAD', path: `/?key=${s.key}` });
    assert.equal(r.status, 302);
    assert.ok(r.headers['set-cookie']);
  } finally { await s.close(); }
});

test('?key= works through the https tunnel: Secure cookie', async () => {
  const s = await boot();
  try {
    const r = await raw(s.port, { path: `/?mode=wallpaper&key=${s.key}`, headers: { 'x-forwarded-proto': 'https' } });
    assert.equal(r.status, 302);
    assert.match(setCookie(r), /; Secure/);
  } finally { await s.close(); }
});

test('wrong key = normal login flow, no cookie; the wrong key is not echoed into the login redirect', async () => {
  const s = await boot();
  try {
    const wrong = [
      'nope', '', s.key.slice(0, -1), `${s.key}0`, s.key.toUpperCase(), 'x'.repeat(5000), s.key.slice(0, 31),
    ];
    for (const k of wrong) {
      const r = await raw(s.port, { path: `/?mode=wallpaper&key=${k}` });
      assert.equal(r.status, 302, `key "${k.slice(0, 12)}"`);
      assert.equal(r.headers['set-cookie'], undefined);
      assert.equal(r.headers.location, '/login?next=%2F%3Fmode%3Dwallpaper');
    }
    const page = await raw(s.port, { path: '/login?next=%2F%3Fmode%3Dwallpaper' });
    assert.equal(page.status, 200);
    assert.match(page.body.toString(), /Пароль/);
    // the API never takes a key
    const api = await raw(s.port, { path: `/api/state?key=${s.key}` });
    assert.equal(api.status, 401);
    assert.equal(api.headers['set-cookie'], undefined);
    // neither does POST
    const post = await raw(s.port, { method: 'POST', path: `/login?key=${s.key}` });
    assert.equal(post.headers['set-cookie'], undefined);
  } finally { await s.close(); }
});

test('?key= cannot be turned into an open redirect', async () => {
  const s = await boot();
  try {
    for (const p of [`/..//evil.example/?key=${s.key}`, `//evil.example/?key=${s.key}`, `/\\evil.example/?key=${s.key}`, `/%2F%2Fevil.example/?key=${s.key}`]) {
      const r = await raw(s.port, { path: p });
      assert.equal(r.status, 302, p);
      const loc = String(r.headers.location);
      assert.ok(loc.startsWith('/') && !loc.startsWith('//') && !loc.includes('\\'), `${p} -> ${loc}`);
    }
  } finally { await s.close(); }
});

test('an existing session plus a valid key still redirects to the clean URL', async () => {
  const s = await boot();
  try {
    const first = await raw(s.port, { path: `/?key=${s.key}` });
    const r = await raw(s.port, { path: `/?mode=wallpaper&key=${s.key}`, headers: { cookie: cookieOf(first) } });
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, '/?mode=wallpaper');
  } finally { await s.close(); }
});

test('--no-auth: no key handling at all', async () => {
  const s = await boot({ auth: false });
  try {
    assert.equal(s.key, null);
    assert.equal(fs.existsSync(path.join(s.root, 'data', 'view-key.txt')), false);
    const r = await raw(s.port, { path: '/?mode=wallpaper&key=whatever' });
    assert.equal(r.status, 200);
    assert.equal(r.headers['set-cookie'], undefined);
  } finally { await s.close(); }
});

test('an explicit viewKey option wins over the file', async () => {
  const s = await boot({ viewKey: 'f'.repeat(40) });
  try {
    assert.equal(s.key, 'f'.repeat(40));
    const r = await raw(s.port, { path: `/?key=${'f'.repeat(40)}` });
    assert.equal(r.status, 302);
    assert.ok(r.headers['set-cookie']);
  } finally { await s.close(); }
});
