// Wire tests for the relay against a running copy: `wrangler dev` (see README.md) or the deployed Worker.
//   RELAY_URL=http://127.0.0.1:8787 node --test test/relay.test.mjs
// They check what web/feed.js and the bots' curl lines rely on. The slow cases (expiry and wipe, line cap, topic burst,
// keepalive, stream end) run only when the server's knobs are small, as with
//   wrangler dev --var RETAIN_SECONDS:8 --var KEEP_LINES:20 --var TOPIC_BURST:30 --var KEEPALIVE_SECONDS:2 --var STREAM_SECONDS:6
//     --var STATS_KEY:local-test-key --var STATS_SAMPLE:1 --var STATS_TEST:1
// with RELAY_STATS_KEY=local-test-key RELAY_STATS_TEST=1 for the stats checks.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const BASE = (process.env.RELAY_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const cfg = await (await fetch(`${BASE}/v1/health`)).json();
const streams = [];
after(() => { for (const s of streams) s.close(); });

const topic = () => 'gbw-t' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
const post = (t, body, method = 'POST') => fetch(`${BASE}/${t}`, { method, body });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function poll(t, since = '12h') {
  const res = await fetch(`${BASE}/${t}/json?poll=1&since=${encodeURIComponent(since)}`, { cache: 'no-store' });
  assert.equal(res.status, 200);
  return (await res.text()).split('\n').filter(Boolean).map((row) => JSON.parse(row));
}
async function until(check, ms = 5000) {
  for (const end = Date.now() + ms; ;) {
    const v = check();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await sleep(25);
  }
}
/** An SSE reader shaped like EventSource: events without an `event:` field are the ones .onmessage sees. */
async function stream(t) {
  const ac = new AbortController();
  const res = await fetch(`${BASE}/${t}/sse`, { signal: ac.signal });
  const s = { res, events: [], ended: false, close: () => ac.abort() };
  streams.push(s);
  (async () => {
    const dec = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        for (let i; (i = buf.indexOf('\n\n')) >= 0; buf = buf.slice(i + 2)) {
          const e = { event: 'message', data: '' };
          for (const line of buf.slice(0, i).split('\n')) {
            const at = line.indexOf(':'), key = line.slice(0, at), val = line.slice(at + 1).replace(/^ /, '');
            if (key === 'event') e.event = val;
            else if (key === 'data') e.data += val;
            else if (key === 'retry') e.retry = Number(val);
          }
          s.events.push(e);
        }
      }
    } catch { /* aborted */ }
    s.ended = true;
  })();
  return s;
}
const messages = (s) => s.events.filter((e) => e.event === 'message' && e.data).map((e) => JSON.parse(e.data));

test('health answers with the relay limits', () => {
  assert.equal(cfg.healthy, true);
  assert.equal(cfg.message_limit, 4096);
});

test('CORS: any origin, preflight included', async () => {
  const t = topic();
  const pre = await fetch(`${BASE}/${t}`, { method: 'OPTIONS', headers: { origin: 'https://bodila51.github.io', 'access-control-request-method': 'POST' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), '*');
  assert.match(pre.headers.get('access-control-allow-methods'), /POST/);
  assert.equal((await post(t, '{"bot":"A","status":"idle"}')).headers.get('access-control-allow-origin'), '*');
});

test('topics must match ^[A-Za-z0-9_-]{6,64}$', async () => {
  for (const t of ['abc12', 'a'.repeat(65), 'bad.topic', 'bad%24topic']) assert.equal((await post(t, '{}')).status, 400, t);
  assert.equal((await post('a'.repeat(64), '{}')).status, 200);
  assert.equal((await post('A_b-9z', '{}')).status, 200);
});

test("publishes the way the bots do: curl -s -d '<json>' FEED, and through stdin", async () => {
  const t = topic(), line = '{"bot":"Grok Bot","status":"working","step":"Reading the news"}';
  const reply = JSON.parse(execFileSync('curl', ['-s', '-d', line, `${BASE}/${t}`], { encoding: 'utf8' }));
  assert.equal(reply.event, 'message');
  assert.equal(reply.topic, t);
  assert.equal(reply.message, line);
  assert.match(reply.id, /^[0-9a-z]{7}[A-Za-z0-9]{5}$/);
  assert.ok(Math.abs(reply.time - Date.now() / 1000) < 60);
  const quoted = `{"bot":"O'Brien","status":"done","step":"Ünïcode ✓"}`;   // the here-document path for names with quotes
  JSON.parse(execFileSync('curl', ['-s', '-d', '@-', `${BASE}/${t}`], { input: quoted, encoding: 'utf8' }));
  assert.deepEqual((await poll(t)).map((m) => m.message), [line, quoted]);
});

test('POST and PUT publish; the reply is the stored message', async () => {
  const t = topic();
  const a = await (await post(t, '{"roster":["A","B"]}')).json();
  const b = await (await post(t, '{"looks":{}}', 'PUT')).json();
  assert.deepEqual(await poll(t), [a, b]);
});

test('4096 bytes pass, 4097 are refused; empty and non-UTF-8 bodies too', async () => {
  const t = topic();
  assert.equal((await post(t, 'x'.repeat(4096))).status, 200);
  const big = await post(t, 'x'.repeat(4097));
  assert.equal(big.status, 413);
  assert.equal((await big.json()).http, 413);
  assert.equal((await post(t, 'é'.repeat(2049))).status, 413);   // 4098 bytes in UTF-8
  assert.equal((await post(t, '')).status, 400);
  assert.equal((await post(t, new Uint8Array([0xff, 0xfe, 0x41]))).status, 400);
  assert.equal((await poll(t)).length, 1);
});

test('poll: newline-delimited JSON in order, with every field ntfy has', async () => {
  const t = topic(), sent = [];
  for (let i = 0; i < 3; i++) sent.push(await (await post(t, `{"bot":"B${i}","status":"idle"}`)).json());
  const res = await fetch(`${BASE}/${t}/json?poll=1&since=12h`, { cache: 'no-store' });
  assert.match(res.headers.get('content-type'), /ndjson/);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  const text = await res.text();
  assert.ok(text.endsWith('\n'));
  const got = text.split('\n').filter(Boolean).map((row) => JSON.parse(row));
  assert.deepEqual(got.map((m) => m.id), sent.map((m) => m.id));
  for (const m of got) {
    assert.deepEqual(Object.keys(m).sort(), ['event', 'expires', 'id', 'message', 'time', 'topic']);
    assert.equal(m.expires, m.time + cfg.retain_seconds);
  }
  assert.ok(sent[0].id < sent[1].id && sent[1].id < sent[2].id, 'ids sort in posting order');
  assert.deepEqual(await poll(topic()), [], 'an unused topic is empty');
});

test('since=<id> returns only what came after; unknown ids fall back to everything', async () => {
  const t = topic(), ids = [];
  for (let i = 0; i < 4; i++) ids.push((await (await post(t, `{"n":${i}}`)).json()).id);
  assert.deepEqual((await poll(t, ids[1])).map((m) => m.id), ids.slice(2));
  assert.deepEqual(await poll(t, ids[3]), []);
  assert.deepEqual((await poll(t, 'abcdefghijkl')).map((m) => m.id), ids, 'an ntfy.sh id');
  assert.deepEqual((await poll(t, ids[1].slice(0, 7) + 'zzzzz')).map((m) => m.id), ids, 'right seq, wrong id');
  assert.deepEqual((await poll(t, 'all')).map((m) => m.id), ids);
  assert.deepEqual((await poll(t, 'latest')).map((m) => m.id), ids.slice(3));
  assert.deepEqual((await poll(t, '1m')).map((m) => m.id), ids);
  assert.deepEqual((await poll(t, String(Math.floor(Date.now() / 1000) + 60))), [], 'a unix time in the future');
});

test('sse: an open event, then every new message as data:, to every viewer', async () => {
  const t = topic(), a = await stream(t), b = await stream(t);
  assert.equal(a.res.status, 200);
  assert.match(a.res.headers.get('content-type'), /^text\/event-stream/);
  assert.equal(a.res.headers.get('access-control-allow-origin'), '*');
  const open = await until(() => a.events.find((e) => e.event === 'open'));
  assert.equal(JSON.parse(open.data).event, 'open');
  await until(() => b.events.find((e) => e.event === 'open'));
  const sent = await (await post(t, '{"bot":"A","status":"working","step":"live"}')).json();
  for (const s of [a, b]) assert.deepEqual(await until(() => messages(s)[0]), sent);
  assert.equal(messages(a).length, 1);
  const other = await (await post(topic(), '{"bot":"elsewhere"}')).json();
  await sleep(300);
  assert.ok(!messages(a).some((m) => m.id === other.id), 'other topics stay out');
});

test('a busy topic gets 429 after its burst, other topics do not', { skip: cfg.topic_burst > 40 && 'TOPIC_BURST is large' }, async () => {
  const t = topic(), codes = [];
  for (let i = 0; i < cfg.topic_burst + 10; i++) codes.push((await post(t, `{"n":${i}}`)).status);
  const ok = codes.filter((c) => c === 200).length;
  assert.ok(ok >= cfg.topic_burst && ok <= cfg.topic_burst + 2, `${ok} accepted`);
  assert.ok(codes.filter((c) => c === 429).length >= 8);
  const refused = await post(t, '{}');
  assert.equal(refused.status, 429);
  assert.equal((await refused.json()).code, 42908);
  assert.equal((await post(topic(), '{}')).status, 200);
});

test('keeps only the newest KEEP_LINES', { skip: (cfg.keep_lines > 30 || cfg.topic_burst < cfg.keep_lines + 5) && 'KEEP_LINES is large' }, async () => {
  const t = topic(), ids = [];
  for (let i = 0; i < cfg.keep_lines + 5; i++) ids.push((await (await post(t, `{"n":${i}}`)).json()).id);
  assert.deepEqual((await poll(t)).map((m) => m.id), ids.slice(5));
  assert.deepEqual((await poll(t, ids[2])).map((m) => m.id), ids.slice(5), 'a dropped id: everything kept');
});

test('forgets after RETAIN_SECONDS, then the alarm wipes the topic; ids stay unique', { skip: cfg.retain_seconds > 15 && 'RETAIN_SECONDS is large' }, async () => {
  const t = topic();
  const a = await (await post(t, '{"n":"old"}')).json();
  await sleep((cfg.retain_seconds + 3) * 1000);
  assert.deepEqual(await poll(t), []);
  const b = await (await post(t, '{"n":"new"}')).json();
  assert.equal(b.id.slice(0, 7), '0000001', 'the wipe restarted the seqs');
  assert.notEqual(b.id, a.id);
  assert.deepEqual((await poll(t, a.id)).map((m) => m.id), [b.id]);
});

/** A browser-style WebSocket on /<topic>/ws, collecting every text frame. */
async function socket(t) {
  const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/${t}/ws`);
  const s = { ws, frames: [], closed: false, close: () => ws.close() };
  streams.push(s);
  ws.onmessage = (e) => s.frames.push(e.data);
  ws.onclose = () => { s.closed = true; };
  await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });
  return s;
}
const frames = (s) => s.frames.filter((f) => f !== 'pong').map((f) => JSON.parse(f));

test('ws: an open frame, then every new message as the same JSON; "ping" gets "pong"', async () => {
  const t = topic(), a = await socket(t), b = await socket(t);
  const open = await until(() => frames(a).find((m) => m.event === 'open'));
  assert.equal(open.topic, t);
  const sent = await (await post(t, '{"bot":"A","status":"working","step":"ws"}')).json();
  for (const s of [a, b]) assert.deepEqual(await until(() => frames(s).find((m) => m.event === 'message')), sent);
  a.ws.send('ping');
  await until(() => a.frames.includes('pong'));
  assert.equal((await fetch(`${BASE}/${t}/ws`)).status, 426, 'a plain GET is refused');
});

// The stats checks need RELAY_STATS_KEY (the server's STATS_KEY); the day-travel one also RELAY_STATS_TEST=1 (STATS_TEST:1).
const KEY = process.env.RELAY_STATS_KEY;
const report = async () => (await fetch(`${BASE}/_stats?key=${encodeURIComponent(KEY)}&format=json`)).json();
const beacon = (body) => fetch(`${BASE}/_beacon`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'text/plain' } });
const dash = () => crypto.randomUUID().replace(/-/g, '').slice(0, 16);
const utcDay = (daysAgo) => new Date(Date.now() - daysAgo * 864e5).toISOString().slice(0, 10);
const opened = (h, more = {}) => beacon({ h, bots: 7, floors: 3, src: 'relay', phone: true, has: { usage: true, routines: true, chat: false, teams: true }, ...more });

const LOCAL_STATS = !!(KEY && process.env.RELAY_STATS_TEST) || 'sends made-up beacons: local only (RELAY_STATS_KEY and RELAY_STATS_TEST)';

test('stats: 404 without the key', async () => {
  for (const q of ['', '?key=', '?key=wrong', '?key=wrong&format=json']) assert.equal((await fetch(`${BASE}/_stats${q}`)).status, 404, q);
});

test('stats: beacons count dashboards by hash only', { skip: LOCAL_STATS !== true && LOCAL_STATS }, async () => {
  const h = dash();
  assert.equal((await opened(h)).status, 204);
  assert.equal((await opened(h)).status, 204, 'a reload');
  for (const junk of [{ h: 'gbw-secret-topic', bots: 1, src: 'relay' }, { h, bots: -1, src: 'relay' }, { h, bots: 1, src: 'x' }, 'not json', { h, secs: 'long' }]) {
    assert.equal((await beacon(junk)).status, 204, 'junk is dropped quietly');
  }
  const r = await report(), w = r.last_7_days;
  assert.ok(r.dashboards.today >= 1 && r.dashboards.new_today >= 1);
  assert.ok(r.dashboards.all_time >= r.dashboards.last_30_days && r.dashboards.last_30_days >= r.dashboards.last_7_days && r.dashboards.last_7_days >= r.dashboards.today);
  assert.ok(w.bots.total >= 7 && w.setup.usage >= 1 && w.setup.teams >= 1 && w.devices.phone >= 1 && w.sources.relay >= 1);
  assert.equal(w.bots.histogram.reduce((a, b) => a + b.n, 0), w.dashboards);
  assert.equal(r.days.length, 30);
  assert.equal(r.days.at(-1).day, utcDay(0));
  assert.ok(!JSON.stringify(r).includes('gbw-'), 'no topic anywhere');
  const html = await fetch(`${BASE}/_stats?key=${encodeURIComponent(KEY)}`);
  assert.match(html.headers.get('content-type'), /text\/html/);
  const text = await html.text();
  for (const part of ['Dashboard stats', '<svg', 'Bots per dashboard', 'How people set it up', 'Free plan today']) assert.ok(text.includes(part), part);
  assert.ok(!/<script|https?:\/\/(?!www\.w3\.org)/i.test(text), 'no scripts, nothing external');
});

test('stats: visit length (20 a day per dashboard), live viewers, free-plan meter', { skip: LOCAL_STATS !== true && LOCAL_STATS }, async () => {
  const h = dash();
  await opened(h, { phone: false });
  const before = (await report()).last_7_days.visits.count;
  for (let i = 0; i < 22; i++) await beacon({ h, secs: 300 });
  await beacon({ h: dash(), secs: 300 });                // a dashboard never seen: not counted
  const r = await report();
  assert.equal(r.last_7_days.visits.count - before, 20);
  assert.ok(r.last_7_days.visits.median_seconds > 0);
  assert.ok(r.last_7_days.devices.desktop >= 1);

  const t = topic(), viewers = async () => (await report()).live_now.viewers;
  const idle = await viewers(), s = await socket(t);
  await until(() => s.frames.length);
  for (let i = 0; i < 40 && (await viewers()) < idle + 1; i++) await sleep(50);
  assert.equal(await viewers(), idle + 1, 'an open dashboard counts');
  s.close();
  for (let i = 0; i < 40 && (await viewers()) > idle; i++) await sleep(50);
  assert.equal(await viewers(), idle, 'and stops counting when it closes');

  const plan = (await report()).free_plan;
  assert.equal(plan.cap, 100000);
  if (plan.sample === 1) assert.ok(plan.est_worker_requests > 40 && plan.est_rows_written >= plan.est_worker_requests / 2, JSON.stringify(plan));
});

test('stats: countries, each dashboard once a day per country; all time by where it was first seen', { skip: LOCAL_STATS !== true && LOCAL_STATS }, async () => {
  const counts = async () => {
    const c = (await report()).countries, at = (list) => Object.fromEntries(list.map((x) => [x.code, x.n]));
    return { week: at(c.last_7_days), ever: at(c.all_time), names: Object.fromEntries(c.last_7_days.map((x) => [x.code, x.name])) };
  };
  const before = await counts(), a = dash(), b = dash();
  await opened(a, { country: 'DE' });
  await opened(a, { country: 'DE' });                    // a reload: still once
  await opened(a, { country: 'FR' });                    // the same dashboard from another country that day
  await opened(b, { country: 'XX' });                    // Cloudflare's "unknown"
  const after = await counts(), d = (k, where = 'week') => (after[where][k] ?? 0) - (before[where][k] ?? 0);
  assert.deepEqual([d('DE'), d('FR'), d('Unknown'), d('XX')], [1, 1, 1, 0]);
  assert.deepEqual([d('DE', 'ever'), d('FR', 'ever'), d('Unknown', 'ever')], [1, 0, 1]);
  assert.equal(after.names.DE, 'Germany');
  const html = await (await fetch(`${BASE}/_stats?key=${encodeURIComponent(KEY)}`)).text();
  assert.ok(html.includes('Countries') && html.includes('🇩🇪 Germany'), 'flag and name on the page');
});

test('stats: closed days are kept for good, per-dashboard rows for 31 days', { skip: LOCAL_STATS !== true && LOCAL_STATS }, async () => {
  const h = dash();
  for (const n of [40, 10, 1]) await opened(h, { day: utcDay(n) });
  await opened(dash(), { day: utcDay(45) });             // seen once, long ago: in all-time only
  const r = await report(), history = new Map(r.history.map((d) => [d.day, d]));
  for (const n of [40, 10, 1]) assert.ok(history.get(utcDay(n))?.dashboards >= 1, `day -${n} kept`);
  assert.ok(history.get(utcDay(40)).new >= 1, 'new on its first day');
  const yesterday = r.days.find((d) => d.day === utcDay(1));
  assert.ok(yesterday.returning >= 1, 'returning after that');
  assert.ok(r.dashboards.all_time > r.dashboards.last_30_days);
});

test('the alarm counts relay messages per day before it wipes a topic', { skip: (cfg.retain_seconds > 15 || !process.env.RELAY_STATS_KEY) && 'needs short RETAIN_SECONDS and RELAY_STATS_KEY' }, async () => {
  const key = encodeURIComponent(process.env.RELAY_STATS_KEY);
  const counted = async () => (await (await fetch(`${BASE}/_stats?key=${key}&format=json`)).json()).relay_messages_all_time;
  const before = await counted(), t = topic();
  for (let i = 0; i < 3; i++) await post(t, `{"n":${i}}`);
  await sleep((cfg.retain_seconds + 3) * 1000);
  assert.ok((await counted()) - before >= 3);
});

test('keepalives arrive and a stream ends by itself, asking for a quick reconnect', { skip: (cfg.keepalive_seconds > 5 || cfg.stream_seconds > 10) && 'long stream knobs' }, async () => {
  const s = await stream(topic());
  await until(() => s.events.find((e) => e.event === 'keepalive'), (cfg.keepalive_seconds + 2) * 1000);
  assert.equal(s.events.find((e) => e.retry)?.retry, 3000);
  await until(() => s.ended, (cfg.stream_seconds * 1.2 + 3) * 1000);
  assert.equal(messages(s).length, 0, 'keepalives never look like messages');
});
