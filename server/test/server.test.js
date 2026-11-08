import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createApp, parseArgs } from '../server.js';

/** Raw request: no URL normalisation, so traversal attempts reach the server untouched. */
function raw(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function boot(extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bothq-root-'));
  fs.mkdirSync(path.join(root, 'web'), { recursive: true });
  fs.mkdirSync(path.join(root, 'assets', 'blobs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'web', 'index.html'), '<!doctype html><title>hq</title>');
  fs.writeFileSync(path.join(root, 'web', 'app.js'), 'export {};');
  fs.writeFileSync(path.join(root, 'web', '.hidden'), 'no');
  fs.writeFileSync(path.join(root, 'assets', 'blobs', 'x.glb'), Buffer.from('glTF'));
  fs.writeFileSync(path.join(root, 'data', 'password.txt'), 'SECRET-DO-NOT-LEAK\n');
  const journalPath = path.join(root, 'data', 'events.jsonl');
  fs.writeFileSync(journalPath, '{"bot":"X Writer","group":"X-контент","status":"working","step":"пишу"}\n');
  const app = createApp({
    root, dataDir: path.join(root, 'data'), journalPath, host: '127.0.0.1', failDelayMs: 0,
    credentials: { password: 'pw-123', secret: 'a'.repeat(64), source: 'test' }, log: () => {}, ...extra,
  });
  const addr = await app.start({ port: 0 });
  const cookie = async (pw = 'pw-123') => {
    const r = await raw(addr.port, {
      method: 'POST', path: '/login', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `password=${encodeURIComponent(pw)}`,
    });
    return r;
  };
  const close = async () => { await app.stop(); fs.rmSync(root, { recursive: true, force: true }); };
  return { app, port: addr.port, root, journalPath, cookie, close };
}

test('arg parsing and the --no-auth guard', () => {
  assert.deepEqual(
    (({ dev, port, host, noAuth }) => ({ dev, port, host, noAuth }))(parseArgs(['--dev', '--port', '9000', '--no-auth'], {})),
    { dev: true, port: 9000, host: '127.0.0.1', noAuth: true },
  );
  assert.throws(() => parseArgs(['--bogus'], {}));
  assert.throws(() => createApp({ host: '0.0.0.0', auth: false }), /no-auth/);
});

test('auth gate: pages redirect, api answers 401, healthz is open', async () => {
  const s = await boot();
  try {
    const h = await raw(s.port, { path: '/healthz' });
    assert.equal(h.status, 200);
    const api = await raw(s.port, { path: '/api/state' });
    assert.equal(api.status, 401);
    assert.equal(JSON.parse(api.body).error, 'unauthorized');
    const page = await raw(s.port, { path: '/' });
    assert.equal(page.status, 302);
    assert.equal(page.headers.location, '/login?next=%2F');
    const asset = await raw(s.port, { path: '/assets/blobs/x.glb' });
    assert.equal(asset.status, 302);
    const login = await raw(s.port, { path: '/login' });
    assert.equal(login.status, 200);
    assert.match(login.body.toString(), /Пароль/);
  } finally { await s.close(); }
});

test('login: wrong password 401, rate limit 429, success sets a hardened cookie', async () => {
  const s = await boot();
  try {
    const bad = await s.cookie('nope');
    assert.equal(bad.status, 401);
    assert.match(bad.body.toString(), /Неверный пароль/);
    for (let i = 0; i < 5; i++) await s.cookie('nope');
    const limited = await s.cookie('pw-123');
    assert.equal(limited.status, 429, 'locked even for the right password after too many failures');
    assert.ok(limited.headers['retry-after']);
  } finally { await s.close(); }

  const s2 = await boot();
  try {
    const ok = await s2.cookie();
    assert.equal(ok.status, 303);
    assert.equal(ok.headers.location, '/');
    const sc = ok.headers['set-cookie'][0];
    assert.match(sc, /^bothq_session=/);
    assert.match(sc, /HttpOnly/);
    assert.match(sc, /SameSite=Lax/);
    assert.doesNotMatch(sc, /Secure/);
    const https = await raw(s2.port, {
      method: 'POST', path: '/login', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'x-forwarded-proto': 'https' }, body: 'password=pw-123&next=%2F%2Fevil.example',
    });
    assert.match(https.headers['set-cookie'][0], /; Secure/);
    assert.equal(https.headers.location, '/', 'open redirect is refused');
    const out = await raw(s2.port, { path: '/api/state', headers: { cookie: sc.split(';')[0] } });
    assert.equal(out.status, 200);
    const forged = await raw(s2.port, { path: '/api/state', headers: { cookie: 'bothq_session=99999999999999.abc.def' } });
    assert.equal(forged.status, 401);
  } finally { await s2.close(); }
});

test('/api/state: shape, gzip, since=unchanged, live append < 1.5 s', async () => {
  const s = await boot();
  try {
    const sc = (await s.cookie()).headers['set-cookie'][0].split(';')[0];
    const get = (q = '', headers = {}) => raw(s.port, { path: `/api/state${q}`, headers: { cookie: sc, ...headers } });

    const r = await get();
    assert.equal(r.status, 200);
    assert.match(r.headers['cache-control'], /no-store/);
    const st = JSON.parse(r.body);
    for (const k of ['version', 'now', 'demo', 'summary', 'usage', 'floors', 'bots', 'feed']) assert.ok(k in st, k);
    assert.equal(st.bots['x-writer'].floor, 'x-content');
    assert.equal(st.bots['x-writer'].desk, 1);
    assert.equal(st.floors[0].free_desks, 19);

    const gz = await get('', { 'accept-encoding': 'gzip' });
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.equal(JSON.parse(zlib.gunzipSync(gz.body)).version, st.version);

    const same = await get(`?since=${st.version}`);
    assert.deepEqual(JSON.parse(same.body), { version: st.version, unchanged: true });
    const older = await get(`?since=${st.version - 1}`);
    assert.ok(JSON.parse(older.body).bots);

    const t0 = Date.now();
    fs.appendFileSync(s.journalPath, '{"bot":"X Writer","status":"waiting","step":"жду ответа: публикуем?"}\n');
    let seen = null;
    while (Date.now() - t0 < 1500) {
      const x = JSON.parse((await get(`?since=${st.version}`)).body);
      if (!x.unchanged) { seen = x; break; }
      await new Promise((res) => setTimeout(res, 20));
    }
    assert.ok(seen, 'new line visible within 1.5 s');
    assert.equal(seen.bots['x-writer'].effective_status, 'waiting_user');
    assert.equal(seen.feed[0].step, 'жду ответа: публикуем?');
    assert.ok(seen.version > st.version);
  } finally { await s.close(); }
});

test('static files: MIME, caching, traversal and dotfiles refused, secrets never leak', async () => {
  const s = await boot({ auth: false });
  try {
    const idx = await raw(s.port, { path: '/' });
    assert.equal(idx.status, 200);
    assert.match(idx.headers['content-type'], /text\/html/);
    const js = await raw(s.port, { path: '/app.js' });
    assert.match(js.headers['content-type'], /text\/javascript/);
    const glb = await raw(s.port, { path: '/assets/blobs/x.glb' });
    assert.equal(glb.status, 200);
    assert.equal(glb.headers['content-type'], 'model/gltf-binary');
    assert.equal(glb.headers['cache-control'], 'public, max-age=3600');
    const cond = await raw(s.port, { path: '/assets/blobs/x.glb', headers: { 'if-none-match': glb.headers.etag } });
    assert.equal(cond.status, 304);

    for (const p of [
      '/../data/password.txt', '/..%2fdata/password.txt', '/%2e%2e/data/password.txt', '/assets/../data/password.txt',
      '/assets/%2e%2e/%2e%2e/data/password.txt', '/..%5cdata%5cpassword.txt', '/.hidden', '/assets/blobs/%00', '/data/password.txt',
      '/assets/..%2f..%2fdata%2fpassword.txt',
    ]) {
      const r = await raw(s.port, { path: p });
      assert.ok(r.status === 404 || r.status === 400, `${p} -> ${r.status}`);
      assert.doesNotMatch(r.body.toString(), /SECRET-DO-NOT-LEAK/, p);
    }
    const post = await raw(s.port, { method: 'POST', path: '/app.js' });
    assert.equal(post.status, 405);
    const nf = await raw(s.port, { path: '/nope.png' });
    assert.equal(nf.status, 404);
  } finally { await s.close(); }
});

test('--no-cache: assets revalidate on every load (a local wallpaper picks up edited images)', async () => {
  assert.equal(parseArgs(['--no-cache'], {}).noCache, true);
  const s = await boot({ auth: false, noCache: true });
  try {
    const glb = await raw(s.port, { path: '/assets/blobs/x.glb' });
    assert.equal(glb.headers['cache-control'], 'no-cache');
  } finally { await s.close(); }
});

test('time alone changes the version: working bot turns stuck without any journal write', async () => {
  let now = Date.parse('2026-10-31T12:00:00+02:00');
  const s = await boot({ auth: false, now: () => now });
  try {
    fs.appendFileSync(s.journalPath, `{"t":"${new Date(now).toISOString()}","bot":"Fresh","status":"working","step":"x"}\n`);
    await new Promise((res) => setTimeout(res, 150));
    const a = JSON.parse((await raw(s.port, { path: '/api/state' })).body);
    assert.equal(a.bots.fresh.effective_status, 'working');
    now += 31 * 60e3;
    const b = JSON.parse((await raw(s.port, { path: `/api/state?since=${a.version}` })).body);
    assert.equal(b.unchanged, undefined);
    assert.equal(b.bots.fresh.effective_status, 'stuck');
    assert.equal(b.version, a.version + 1);
  } finally { await s.close(); }
});

test('data/bots.json look is served in /api/state and hot-reloaded', async () => {
  const s = await boot({ auth: false });
  try {
    const get = async () => JSON.parse((await raw(s.port, { path: '/api/state' })).body);
    assert.equal((await get()).bots['x-writer'].look, null);
    fs.writeFileSync(path.join(s.root, 'data', 'bots.json'), JSON.stringify({
      'X Writer': { look: { shape: 'pill', color: '#F59A1B', accessory: 'antenna' } },
    }));
    let st = null;
    for (let i = 0; i < 40 && !st?.bots['x-writer'].look; i++) {
      await new Promise((res) => setTimeout(res, 100));
      st = await get();
    }
    assert.deepEqual(st.bots['x-writer'].look, { shape: 'pill', color: '#F59A1B', accessory: 'antenna' });
    assert.equal(st.bots['x-writer'].avatar, 'x-writer', 'the hand-made avatar lookup is untouched');
    assert.equal(st.bots['x-writer'].has_glb, false, 'no assets/blobs/x-writer.glb in this fixture');
    fs.writeFileSync(path.join(s.root, 'data', 'bots.json'), JSON.stringify({ 'X Writer': { avatar: 'x' } }));
    for (let i = 0; i < 40 && st.bots['x-writer'].avatar !== 'x'; i++) {
      await new Promise((res) => setTimeout(res, 100));
      st = await get();
    }
    assert.equal(st.bots['x-writer'].has_glb, true, 'avatar override points at assets/blobs/x.glb, which exists');
  } finally { await s.close(); }
});
