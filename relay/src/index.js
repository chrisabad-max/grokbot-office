// Grok Bot relay: our own ntfy-compatible mailbox on Cloudflare, so the dashboard no longer hangs on ntfy.sh's
// 250 messages a day per IP. It speaks the part of ntfy that PROMPT.md and web/feed.js use, plus a cheaper live stream:
//   POST|PUT /<topic>                    the body is one message: UTF-8, at most 4 KB (the bots' curl -d '<json>' FEED)
//   GET /<topic>/json?poll=1&since=<s>   the kept messages, one JSON object per line: {id,time,expires,event,topic,message}
//                                        since = 12h | 30m | all | latest | a unix time | a message id (the ones after it)
//   GET /<topic>/ws                      live messages as WebSocket text frames (same JSON); send "ping", get "pong"
//   GET /<topic>/sse                     the same as Server-Sent Events, for plain ntfy clients (old feed.js with &ntfy=)
//   POST /_beacon, GET /_stats?key=      anonymous usage counts and the private page that shows them (see Stats below)
// One Durable Object per topic keeps the last 12 h (at most 600 lines) in its SQLite. Every live viewer is a
// hibernatable WebSocket on that object, so an open dashboard costs nothing while the bots are quiet: the object sleeps
// and wakes only when a message arrives, and "ping" is answered without waking it. /ws goes straight to the object;
// /sse is fed by a WebSocket the Worker holds, and ends after about 30 min (the free plan's CPU budget per request).
import { DurableObject } from 'cloudflare:workers';

const TOPIC_RE = /^[A-Za-z0-9_-]{6,64}$/;
const MAX_MESSAGE = 4096;
const DEFAULTS = {                 // each can be overridden by a var of the same name (wrangler.jsonc "vars", wrangler dev --var)
  RETAIN_SECONDS: 43200,           // keep 12 h, like ntfy.sh
  KEEP_LINES: 600,                 // and at most 600 lines per topic, like the dashboard's own cache
  TOPIC_BURST: 60,                 // a topic may post 60 messages at once,
  TOPIC_REFILL_SECONDS: 5,         // then one more every 5 s (ntfy's per-IP bucket, here per topic)
  MAX_VIEWERS: 50,                 // open live streams per topic
  STREAM_SECONDS: 1800,            // an /sse stream ends after ~30 min and the browser reconnects
  KEEPALIVE_SECONDS: 45,           // like ntfy
  STATS_SAMPLE: 20,                // one request in 20 is tallied (times 20) for the free-plan meter on /_stats
  STATS_TEST: 0,                   // tests only: 1 lets a beacon say which day it is from
};
const FREE_DAILY = 100000;         // Workers Free: requests a day, and rows written a day, per account
const CORS = { 'access-control-allow-origin': '*' };
const SSE_HEADERS = { ...CORS, 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' };
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const SOURCES = new Set(['relay', 'ntfy', 'both', 'none']);
const HAS = ['usage', 'routines', 'chat', 'teams'];
const VISIT_BUCKETS = [10, 30, 60, 120, 300, 600, 1800, 3600, 7200, 14400, 28800, 86400, 604800];   // upper bounds, s
const BOT_BUCKETS = [[0, 0, '0'], [1, 1, '1'], [2, 3, '2–3'], [4, 6, '4–6'], [7, 10, '7–10'], [11, 20, '11–20'], [21, 1e9, '21+']];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url), cfg = settings(env);
    const m = /^\/([^/]+)(?:\/(json|sse|ws))?$/.exec(url.pathname);
    const route = url.pathname === '/_beacon' ? 'beacon' : url.pathname === '/_stats' ? 'stats'
      : m && TOPIC_RE.test(m[1]) ? (m[2] === 'json' ? 'poll' : m[2] || (request.method === 'GET' ? 'other' : 'post')) : 'other';
    if (route !== 'stats' && Math.random() * cfg.STATS_SAMPLE < 1) {                      // the free-plan meter
      ctx.waitUntil(quiet(statsObject(env)?.tally(utcDay(Date.now()), route)));
    }
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...CORS, 'access-control-allow-methods': 'GET, POST, PUT, OPTIONS', 'access-control-allow-headers': '*', 'access-control-max-age': '86400' } });
    }
    if (url.pathname === '/' || url.pathname === '/v1/health') {
      return json({ healthy: true, message_limit: MAX_MESSAGE, retain_seconds: cfg.RETAIN_SECONDS, keep_lines: cfg.KEEP_LINES, topic_burst: cfg.TOPIC_BURST,
        topic_refill_seconds: cfg.TOPIC_REFILL_SECONDS, stream_seconds: cfg.STREAM_SECONDS, keepalive_seconds: cfg.KEEPALIVE_SECONDS });
    }
    const ip = request.headers.get('cf-connecting-ip') || 'local';
    if (route === 'beacon' && request.method === 'POST') return beacon(request, env, cfg, ip);
    if (route === 'stats' && request.method === 'GET') return stats(url, env);
    if (!m) return fail(404, 40401, 'page not found');
    const [, topic, kind] = m;
    if (!TOPIC_RE.test(topic)) return fail(400, 40009, 'invalid topic: 6 to 64 of A-Z a-z 0-9 _ -');
    const stub = env.TOPIC.get(env.TOPIC.idFromName(topic));

    if (!kind && (request.method === 'POST' || request.method === 'PUT')) {
      if (!(await allowed(env.PUBLISH_LIMIT, ip))) return fail(429, 42901, 'limit reached: too many requests from this IP');
      const body = await readCapped(request, MAX_MESSAGE);
      if (!body) return fail(413, 41301, `message too large: at most ${MAX_MESSAGE} bytes`);
      let message = '';
      try { message = new TextDecoder('utf-8', { fatal: true }).decode(body); } catch { /* not UTF-8 */ }
      if (!message) return fail(400, 40010, 'the message must be non-empty UTF-8 text');
      const msg = await stub.publish(topic, message);
      return msg ? json(msg) : fail(429, 42908, 'limit reached: too many messages on this topic');
    }
    if (request.method !== 'GET') return fail(405, 40501, 'method not allowed');
    if (!kind) return fail(404, 40402, 'read with /<topic>/json?poll=1, /<topic>/ws or /<topic>/sse');
    if (!(await allowed(env.READ_LIMIT, ip))) return kind === 'sse' ? retryLater(60) : fail(429, 42901, 'limit reached: too many requests from this IP');
    if (kind === 'json') {                               // always a poll: this relay does not stream /json
      return new Response(await stub.poll(topic, url.searchParams.get('since')), { headers: { ...CORS, 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' } });
    }
    if (kind === 'ws') {                                 // the browser's socket goes straight to the topic's object
      if (request.headers.get('upgrade') !== 'websocket') return fail(426, 42601, 'expected a websocket');
      return stub.fetch(request);
    }
    return live(stub, topic, cfg);
  },
};

/** One topic: its messages in SQLite, its live viewers as hibernatable WebSockets. */
export class Topic extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.cfg = settings(env);
    this.sql = ctx.storage.sql;
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));   // answered while the object sleeps
    this.open();
    this.tokens = this.cfg.TOPIC_BURST;
    this.filled = Date.now();
    this.alarmSet = false;
  }

  /** Make the tables if needed and load where the kept range starts and ends (two rows read). */
  open() {
    this.sql.exec('CREATE TABLE IF NOT EXISTS msgs (seq INTEGER PRIMARY KEY, id TEXT NOT NULL, time INTEGER NOT NULL, message TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL) WITHOUT ROWID');
    const first = this.sql.exec('SELECT seq, time FROM msgs ORDER BY seq LIMIT 1').toArray()[0];
    const last = this.sql.exec('SELECT seq, time FROM msgs ORDER BY seq DESC LIMIT 1').toArray()[0];
    this.lo = first?.seq ?? 0;                           // 0: nothing kept
    this.oldest = first?.time ?? 0;
    this.hi = last?.seq ?? 0;
    this.newest = last?.time ?? 0;
    this.wiped = false;
  }

  /** Store one message and hand it to every live viewer. Null when the topic posts faster than its bucket allows. */
  async publish(topic, message) {
    const now = Date.now();
    this.tokens = Math.min(this.cfg.TOPIC_BURST, this.tokens + (now - this.filled) / (this.cfg.TOPIC_REFILL_SECONDS * 1000));
    this.filled = now;
    if (this.tokens < 1) return null;
    this.tokens -= 1;
    if (this.wiped) this.open();
    const time = Math.max(Math.floor(now / 1000), this.newest), seq = this.hi + 1;
    // The seq up front finds the row for ?since=<id>; the random tail keeps ids unique after a wipe restarts the seqs.
    const id = seq.toString(36).padStart(7, '0') + randomId(5);
    this.sql.exec('INSERT INTO msgs (seq, id, time, message) VALUES (?, ?, ?, ?)', seq, id, time, message);
    if (!this.lo) [this.lo, this.oldest] = [seq, time];
    [this.hi, this.newest] = [seq, time];
    this.prune(time);
    const msg = shape(topic, { id, time, message }, this.cfg), line = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(line); } catch { /* closing */ }
    }
    if (!this.alarmSet) {                                // the alarm counts the topic's messages and wipes it once it goes quiet
      if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(this.expiry());
      this.alarmSet = true;
    }
    return msg;
  }

  /** The kept messages after `since`, as ntfy's newline-delimited JSON. */
  poll(topic, since) {
    if (this.wiped || !this.lo) return '';
    const now = Math.floor(Date.now() / 1000), cutoff = now - this.cfg.RETAIN_SECONDS;
    let from = this.lo, after = cutoff, m;
    since = since || 'all';
    if (since === 'latest') from = this.hi;
    else if ((m = /^(\d+)([smhd])$/.exec(since))) after = Math.max(cutoff, now - m[1] * { s: 1, m: 60, h: 3600, d: 86400 }[m[2]]);
    else if (/^\d{10}$/.test(since)) after = Math.max(cutoff, Number(since));
    else if (/^[0-9a-z]{7}[A-Za-z0-9]{5}$/.test(since)) {
      const seq = parseInt(since.slice(0, 7), 36);
      if (this.sql.exec('SELECT id FROM msgs WHERE seq = ?', seq).toArray()[0]?.id === since) from = seq + 1;
    }
    // since=all, or an id we no longer have (dropped, or one from ntfy.sh): everything kept; the dashboard skips what it has
    let out = '';
    for (const row of this.sql.exec('SELECT id, time, message FROM msgs WHERE seq >= ? AND time >= ? ORDER BY seq', from, after)) {
      out += JSON.stringify(shape(topic, row, this.cfg)) + '\n';
    }
    return out;
  }

  /** Drop what is older than RETAIN_SECONDS or beyond the newest KEEP_LINES. Rows go oldest first, so seqs stay contiguous. */
  prune(now) {
    const cutoff = now - this.cfg.RETAIN_SECONDS;
    const keep = Math.max(this.lo, this.hi - this.cfg.KEEP_LINES + 1);
    if (keep === this.lo && this.oldest >= cutoff) return;
    const first = this.sql.exec('SELECT seq, time FROM msgs WHERE seq >= ? AND time >= ? ORDER BY seq LIMIT 1', keep, cutoff).toArray()[0];
    this.sql.exec('DELETE FROM msgs WHERE seq < ?', first ? first.seq : this.hi + 1);
    this.lo = first?.seq ?? 0;
    this.oldest = first?.time ?? 0;
  }

  expiry() { return (this.newest + this.cfg.RETAIN_SECONDS + 1) * 1000; }   // when everything kept has expired

  /** Fires once the newest message is 12 h old, about twice a day for a busy topic: count, then wipe or look again later. */
  async alarm() {
    this.alarmSet = false;
    if (this.wiped) return;
    const reported = this.sql.exec("SELECT v FROM meta WHERE k = 'reported'").toArray()[0]?.v ?? 0;
    if (this.hi > reported) {                           // seqs count every message, kept or already dropped
      try { await statsObject(this.env)?.addMessages(utcDay(this.newest * 1000), this.hi - reported); } catch { /* stats are optional */ }
    }
    this.prune(Math.floor(Date.now() / 1000));
    if (!this.lo) {                                      // nothing left: free the topic's storage entirely
      await this.ctx.storage.deleteAll();
      this.wiped = true;
      return;
    }
    if (this.hi > reported) this.sql.exec("INSERT INTO meta (k, v) VALUES ('reported', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", this.hi);
    await this.ctx.storage.setAlarm(this.expiry());
    this.alarmSet = true;
  }

  /** A live viewer: a browser on /<topic>/ws, or the Worker feeding /<topic>/sse. It only listens. */
  async fetch(request) {
    if (request.headers.get('upgrade') !== 'websocket') return new Response('expected a websocket', { status: 426 });
    if (this.ctx.getWebSockets().length >= this.cfg.MAX_VIEWERS) return new Response('too many viewers', { status: 429 });
    const [, topic, kind] = /^\/([^/]+)\/(ws|listen)$/.exec(new URL(request.url).pathname) || [];
    const h = topic ? await hash16(topic) : '';
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ h });                  // the topic's hash, for the live count after a wake-up
    if (kind === 'ws') pair[1].send(JSON.stringify({ id: randomId(12), time: Math.floor(Date.now() / 1000), event: 'open', topic }));
    this.viewers(h, this.ctx.getWebSockets().length);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  webSocketMessage() {}                                  // viewers never talk; "ping" is auto-answered

  webSocketClose(ws) {
    try { ws.close(); } catch { /* already closed */ }
    const h = ws.deserializeAttachment()?.h;
    this.viewers(h, this.ctx.getWebSockets().filter((w) => w !== ws && w.readyState === WebSocket.OPEN).length);
  }

  viewers(h, n) {                                        // "live now" on /_stats
    if (h) this.ctx.waitUntil(quiet(statsObject(this.env)?.viewers(h, n)));
  }
}

/** Anonymous usage, one object for the whole relay. A dashboard is known only by the first 16 hex of SHA-256(topic),
 *  computed in the browser; no topic, IP or user agent is stored. Kept forever: one row per dashboard (first and last
 *  day seen, for new vs returning and the all-time count) and one aggregate per day. Kept 31 days: one row per dashboard
 *  per day, for 7- and 30-day uniques. Nothing grows per request: a reload updates its row, counters are per day. */
export class Stats extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const sql = this.sql = ctx.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS dashes (h TEXT PRIMARY KEY, first TEXT NOT NULL, last TEXT NOT NULL) WITHOUT ROWID');
    sql.exec(`CREATE TABLE IF NOT EXISTS dash_days (day TEXT NOT NULL, h TEXT NOT NULL, bots INTEGER NOT NULL DEFAULT 0, floors INTEGER NOT NULL DEFAULT 0,
      src TEXT NOT NULL DEFAULT 'none', phone INTEGER NOT NULL DEFAULT 0, desktop INTEGER NOT NULL DEFAULT 0, usage INTEGER NOT NULL DEFAULT 0,
      routines INTEGER NOT NULL DEFAULT 0, chat INTEGER NOT NULL DEFAULT 0, teams INTEGER NOT NULL DEFAULT 0, ends INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, h)) WITHOUT ROWID`);
    sql.exec('CREATE TABLE IF NOT EXISTS days (day TEXT PRIMARY KEY, data TEXT NOT NULL) WITHOUT ROWID');
    sql.exec('CREATE TABLE IF NOT EXISTS visits (day TEXT NOT NULL, b INTEGER NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, b)) WITHOUT ROWID');
    sql.exec('CREATE TABLE IF NOT EXISTS tallies (day TEXT NOT NULL, kind TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, kind)) WITHOUT ROWID');
    sql.exec('CREATE TABLE IF NOT EXISTS msg_day (day TEXT PRIMARY KEY, n INTEGER NOT NULL) WITHOUT ROWID');
    sql.exec('CREATE TABLE IF NOT EXISTS live (h TEXT PRIMARY KEY, n INTEGER NOT NULL, at INTEGER NOT NULL) WITHOUT ROWID');
    sql.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID');
    // Each dashboard once per day per country (two letters or Unknown), 31 days like dash_days.
    sql.exec('CREATE TABLE IF NOT EXISTS dash_countries (day TEXT NOT NULL, country TEXT NOT NULL, h TEXT NOT NULL, PRIMARY KEY (day, country, h)) WITHOUT ROWID');
    const schema = this.meta('schema');
    if (schema !== '3') {
      if (schema !== '2') {                              // carry over the first version's rows
        try { sql.exec('INSERT OR IGNORE INTO dashes (h, first, last) SELECT h, first, last FROM dash'); sql.exec('DROP TABLE dash'); } catch { /* none */ }
        try { sql.exec('INSERT OR IGNORE INTO dash_days (day, h, bots, src) SELECT day, h, bots, src FROM dash_day'); sql.exec('DROP TABLE dash_day'); } catch { /* none */ }
      }
      try { sql.exec('ALTER TABLE dashes ADD COLUMN country TEXT'); } catch { /* there already */ }   // where it was first seen
      this.setMeta('schema', '3');
    }
  }

  meta(k) { return this.sql.exec('SELECT v FROM meta WHERE k = ?', k).toArray()[0]?.v ?? null; }
  setMeta(k, v) { this.sql.exec('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v', k, v); }

  /** A dashboard was opened. A reload with nothing new writes nothing. */
  seen(today, day, h, v) {
    this.settle(today);
    this.sql.exec(`INSERT INTO dashes (h, first, last, country) VALUES (?, ?, ?, ?) ON CONFLICT (h) DO UPDATE
      SET first = min(first, excluded.first), last = max(last, excluded.last), country = coalesce(country, excluded.country)
      WHERE excluded.first < first OR excluded.last > last OR country IS NULL`, h, day, day, v.country);
    this.sql.exec('INSERT OR IGNORE INTO dash_countries (day, country, h) VALUES (?, ?, ?)', day, v.country, h);
    this.sql.exec(`INSERT INTO dash_days (day, h, bots, floors, src, phone, desktop, usage, routines, chat, teams) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (day, h) DO UPDATE SET bots = excluded.bots, floors = excluded.floors, src = excluded.src,
        phone = max(phone, excluded.phone), desktop = max(desktop, excluded.desktop), usage = max(usage, excluded.usage),
        routines = max(routines, excluded.routines), chat = max(chat, excluded.chat), teams = max(teams, excluded.teams)
      WHERE bots != excluded.bots OR floors != excluded.floors OR src != excluded.src OR phone < excluded.phone OR desktop < excluded.desktop
        OR usage < excluded.usage OR routines < excluded.routines OR chat < excluded.chat OR teams < excluded.teams`,
      day, h, v.bots, v.floors, v.src, +v.phone, +!v.phone, ...HAS.map((k) => +v.has[k]));
    const final = this.meta('final');
    if (final && day <= final) this.setMeta('final', addDays(day, -1));   // a late row (tests): count that day again
  }

  /** A visit ended after `secs` seconds. At most 20 per dashboard a day; it must have been seen today or yesterday. */
  ended(today, h, secs) {
    this.settle(today);
    for (const day of [today, addDays(today, -1)]) {
      if (!this.sql.exec('UPDATE dash_days SET ends = ends + 1 WHERE day = ? AND h = ? AND ends < 20 RETURNING ends', day, h).toArray().length) continue;
      const b = VISIT_BUCKETS.findIndex((top) => secs <= top);
      this.sql.exec('INSERT INTO visits (day, b, n) VALUES (?, ?, 1) ON CONFLICT (day, b) DO UPDATE SET n = n + 1', today, b < 0 ? VISIT_BUCKETS.length - 1 : b);
      return;
    }
  }

  tally(day, kind) { this.sql.exec('INSERT INTO tallies (day, kind, n) VALUES (?, ?, 1) ON CONFLICT (day, kind) DO UPDATE SET n = n + 1', day, kind); }

  addMessages(day, n) { this.sql.exec('INSERT INTO msg_day (day, n) VALUES (?, ?) ON CONFLICT (day) DO UPDATE SET n = n + excluded.n', day, n); }

  viewers(h, n) {
    if (n > 0) this.sql.exec('INSERT INTO live (h, n, at) VALUES (?, ?, ?) ON CONFLICT (h) DO UPDATE SET n = excluded.n, at = excluded.at', h, n, Date.now());
    else this.sql.exec('DELETE FROM live WHERE h = ?', h);
  }

  /** Close the days before today: keep each one's aggregate forever, drop per-dashboard rows older than 31 days. */
  settle(today) {
    const final = this.meta('final') ?? '', yesterday = addDays(today, -1);
    if (final >= yesterday) return;
    for (const { day } of this.sql.exec('SELECT DISTINCT day FROM dash_days WHERE day > ? AND day < ?', final, today).toArray()) {
      this.sql.exec('INSERT OR REPLACE INTO days (day, data) VALUES (?, ?)', day, JSON.stringify(this.summary(day, day)));
    }
    this.setMeta('final', yesterday);
    this.sql.exec('DELETE FROM dash_days WHERE day < ?', addDays(today, -30));
    this.sql.exec('DELETE FROM dash_countries WHERE day < ?', addDays(today, -30));
    this.sql.exec('DELETE FROM live WHERE at < ?', Date.now() - 2 * 864e5);   // a count no topic has refreshed for 2 days
  }

  /** The dashboards seen from..to, each once, with its latest numbers (devices: any seen). */
  summary(from, to) {
    const latest = new Map();
    for (const r of this.sql.exec('SELECT dd.*, d.first FROM dash_days dd JOIN dashes d ON d.h = dd.h WHERE dd.day >= ? AND dd.day <= ? ORDER BY dd.day', from, to)) {
      const was = latest.get(r.h);
      latest.set(r.h, was ? { ...r, phone: was.phone | r.phone, desktop: was.desktop | r.desktop } : r);
    }
    const rows = [...latest.values()], count = (f) => rows.filter(f).length;
    const bots = rows.map((r) => r.bots).sort((a, b) => a - b), floors = rows.map((r) => r.floors).sort((a, b) => a - b);
    return {
      dashboards: rows.length, new: count((r) => r.first >= from),
      bots: { median: median(bots), total: bots.reduce((a, b) => a + b, 0), histogram: BOT_BUCKETS.map(([lo, hi, label]) => ({ label, n: bots.filter((b) => b >= lo && b <= hi).length })) },
      floors_median: median(floors),
      sources: Object.fromEntries([...SOURCES].map((s) => [s, count((r) => r.src === s)])),
      devices: { phone: count((r) => r.phone), desktop: count((r) => r.desktop) },
      setup: Object.fromEntries(HAS.map((k) => [k, count((r) => r[k])])),
      countries: Object.fromEntries(this.sql.exec('SELECT country, COUNT(DISTINCT h) AS n FROM dash_countries WHERE day >= ? AND day <= ? GROUP BY country', from, to)
        .toArray().map((r) => [r.country, r.n])),
    };
  }

  report(sample) {
    const now = Date.now(), today = utcDay(now), ago = (n) => addDays(today, -n);
    this.settle(today);
    const one = (q, ...a) => this.sql.exec(q, ...a).one().n;
    const uniques = (from) => one('SELECT COUNT(DISTINCT h) AS n FROM dash_days WHERE day >= ?', from);
    const closed = new Map(this.sql.exec('SELECT day, data FROM days WHERE day >= ?', ago(29)).toArray().map((r) => [r.day, JSON.parse(r.data)]));
    const todays = this.summary(today, today);
    const msgs = new Map(this.sql.exec('SELECT day, n FROM msg_day WHERE day >= ?', ago(29)).toArray().map((r) => [r.day, r.n]));
    const days = [];
    for (let i = 29; i >= 0; i--) {
      const day = ago(i), d = i ? closed.get(day) : todays;
      days.push({ day, dashboards: d?.dashboards ?? 0, new: d?.new ?? 0, returning: (d?.dashboards ?? 0) - (d?.new ?? 0), relay_messages: msgs.get(day) ?? 0 });
    }
    const buckets = new Array(VISIT_BUCKETS.length).fill(0);
    for (const r of this.sql.exec('SELECT b, SUM(n) AS n FROM visits WHERE day >= ? GROUP BY b', ago(6))) buckets[r.b] = r.n;
    const tallies = Object.fromEntries(this.sql.exec('SELECT kind, n FROM tallies WHERE day = ?', today).toArray().map((r) => [r.kind, r.n]));
    const t = (k) => tallies[k] ?? 0, sampled = Object.values(tallies).reduce((a, b) => a + b, 0);
    const live = this.sql.exec('SELECT COALESCE(SUM(n), 0) AS n, COUNT(*) AS topics FROM live WHERE at >= ?', now - 2 * 864e5).one();
    const week = this.summary(ago(6), today);
    const ranked = (counts) => Object.entries(counts).map(([code, n]) => ({ code, name: countryName(code), n })).sort((a, b) => b.n - a.n || (a.name < b.name ? -1 : 1));
    const firstSeen = this.sql.exec("SELECT coalesce(country, 'Unknown') AS c, COUNT(*) AS n FROM dashes GROUP BY c").toArray();
    return {
      generated: new Date(now).toISOString(),
      dashboards: { today: todays.dashboards, new_today: todays.new, last_7_days: uniques(ago(6)), last_30_days: uniques(ago(29)), all_time: one('SELECT COUNT(*) AS n FROM dashes') },
      live_now: { viewers: live.n, dashboards: live.topics },
      last_7_days: { ...week, visits: { count: buckets.reduce((a, b) => a + b, 0), median_seconds: bucketMedian(buckets) } },
      // 7 days: each dashboard once per country it was opened from; all time: the country it was first seen in.
      countries: { last_7_days: ranked(week.countries), all_time: ranked(Object.fromEntries(firstSeen.map((r) => [r.c, r.n]))) },
      days,
      free_plan: { day: today, cap: FREE_DAILY, sample, tallied: tallies, est_worker_requests: sampled * sample,
        // Every message is written once and deleted once; a live viewer writes its count on connect and on close; a beacon ~2 rows.
        est_rows_written: sample * (2 * t('post') + 2 * t('ws') + 2 * t('sse') + 2 * t('beacon')) + sampled },
      relay_messages_all_time: one('SELECT COALESCE(SUM(n), 0) AS n FROM msg_day'),
      history: this.sql.exec('SELECT day, data FROM days ORDER BY day').toArray().map((r) => ({ day: r.day, ...JSON.parse(r.data), relay_messages: msgs.get(r.day) ?? null })),
    };
  }
}

/** POST /_beacon. On page load {h, bots, floors, src, phone, has: {usage, routines, chat, teams}}; when the visit ends
 *  {h, secs}. Anything else is dropped without a word. */
async function beacon(request, env, cfg, ip) {
  if (!(await allowed(env.READ_LIMIT, ip))) return new Response(null, { status: 429, headers: CORS });
  try {
    const b = JSON.parse(new TextDecoder().decode((await readCapped(request, 512)) || new Uint8Array(0)));
    const today = utcDay(Date.now()), stats = statsObject(env);
    if (!/^[0-9a-f]{16}$/.test(b?.h)) throw new Error('no hash');
    if ('secs' in b) {
      if (Number.isFinite(b.secs) && b.secs >= 0) await stats.ended(today, b.h, Math.min(Math.round(b.secs), VISIT_BUCKETS.at(-1)));
    } else if (Number.isInteger(b.bots) && b.bots >= 0 && b.bots <= 1000 && SOURCES.has(b.src)) {
      const has = b.has && typeof b.has === 'object' ? b.has : {};
      const day = cfg.STATS_TEST && /^\d{4}-\d\d-\d\d$/.test(b.day) ? b.day : today;   // tests only: a beacon from another day
      // Only the two-letter country Cloudflare sees for the request (never the IP, city or region); tests may name one.
      const seenIn = cfg.STATS_TEST && typeof b.country === 'string' ? b.country : request.cf?.country;
      const country = /^[A-Z]{2}$/.test(seenIn) && seenIn !== 'XX' && seenIn !== 'T1' ? seenIn : 'Unknown';
      await stats.seen(today, day, b.h, { bots: b.bots, floors: Number.isInteger(b.floors) && b.floors >= 0 ? Math.min(b.floors, 100) : 0, src: b.src,
        phone: b.phone === true, has: Object.fromEntries(HAS.map((k) => [k, has[k] === true])), country });
    }
  } catch { /* not ours */ }
  return new Response(null, { status: 204, headers: CORS });
}

/** GET /_stats?key=<STATS_KEY>: the private page (&format=json for the numbers). 404 for everyone else. */
async function stats(url, env) {
  if (!(await sameSecret(url.searchParams.get('key'), env.STATS_KEY))) return fail(404, 40401, 'page not found');
  const r = await statsObject(env).report(settings(env).STATS_SAMPLE);
  if (url.searchParams.get('format') === 'json') return json(r);
  return new Response(page(r, url.searchParams.get('key')), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex' } });
}

function page(r, key) {
  const n = (v) => Number(v || 0).toLocaleString('en-US'), w = r.last_7_days, of = Math.max(w.dashboards, 1);
  const pct = (v, total = of) => `${Math.round((100 * v) / Math.max(total, 1))}%`;
  const tile = (label, v, sub = '') => `<div class="tile"><span>${label}</span><b>${n(v)}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
  const fill = (p) => (p > 0 ? `max(3px,${Math.min(100, p).toFixed(1)}%)` : '0');
  const row = (label, v, total, tail = n(v)) => `<div class="row"><span>${label}</span><div class="bar"><i style="width:${fill((100 * v) / Math.max(total, 1))}"></i></div><span class="num">${tail}</span></div>`;
  const places = (list, total) => (list.length ? list.slice(0, 15).map((c) => `<div class="row place" title="${esc(c.name)}: ${pct(c.n, total)}">`
    + `<span>${flag(c.code)} ${esc(c.name)}</span><div class="bar"><i style="width:${fill((100 * c.n) / Math.max(total, 1))}"></i></div><span class="num">${n(c.n)}</span></div>`).join('')
    : '<p class="note flush">None yet</p>');
  const histMax = Math.max(...w.bots.histogram.map((b) => b.n), 1);
  const meter = (label, v) => {
    const p = v / r.free_plan.cap, tone = p >= 0.9 ? 'bad' : p >= 0.7 ? 'warn' : '';
    return `<div class="row ${tone}"><span>${label}</span><div class="bar"><i style="width:${fill(100 * p)}"></i></div><span class="num">${Math.round(100 * p)}%</span></div>
      <p class="note">≈ ${n(v)} of ${n(r.free_plan.cap)}</p>`;
  };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><title>Dashboard stats</title>
<style>
:root{--bg:#f5f5f7;--card:#fff;--ink:#1d1d1f;--mute:#6e6e73;--line:#e8e8ed;--accent:#0071e3;--soft:#b9d3f5;--warn:#c25700;--bad:#d70015}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:1000px;margin:0 auto;padding:40px 16px 56px}
h1{font-size:30px;line-height:1.15;font-weight:600;letter-spacing:-.022em;margin:0}
.sub{color:var(--mute);font-size:13px;margin:6px 0 28px}
.tiles{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-bottom:12px}
@media(min-width:760px){.tiles{grid-template-columns:repeat(6,minmax(0,1fr))}}
.tile,.card{background:var(--card);border-radius:18px;padding:16px 18px}
.tile span{display:block;color:var(--mute);font-size:13px}
.tile b{display:block;font-size:32px;font-weight:600;letter-spacing:-.025em;font-variant-numeric:tabular-nums;margin-top:2px}
.tile small{display:block;color:var(--mute);font-size:12px}
.grid{display:grid;gap:12px;grid-template-columns:minmax(0,1fr)}
@media(min-width:760px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.wide{grid-column:1/-1}}
h2{font-size:15px;font-weight:600;letter-spacing:-.01em;margin:0 0 2px}
.card>p.lead{color:var(--mute);font-size:13px;margin:0 0 14px}
.big{font-size:24px;font-weight:600;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.pair{display:flex;gap:28px;margin-bottom:12px}.pair span{display:block;color:var(--mute);font-size:12px}
.row{display:grid;grid-template-columns:96px minmax(0,1fr) 52px;align-items:center;gap:10px;font-size:13px;margin:7px 0}
.bar{height:8px;border-radius:4px;background:var(--line);overflow:hidden}.bar i{display:block;height:100%;background:var(--accent);border-radius:4px}
.row.warn .bar i{background:var(--warn)}.row.bad .bar i{background:var(--bad)}
.num{text-align:right;color:var(--mute);font-variant-numeric:tabular-nums}
.note{color:var(--mute);font-size:12px;margin:-2px 0 10px 106px}.note.flush{margin:6px 0}
.cols{display:grid;gap:14px 32px;grid-template-columns:minmax(0,1fr)}@media(min-width:760px){.cols{grid-template-columns:repeat(2,minmax(0,1fr))}}
h3{font-size:12px;font-weight:600;color:var(--mute);margin:0 0 4px}
.row.place{grid-template-columns:minmax(0,1.5fr) minmax(0,1fr) 44px}.row.place>span:first-child{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
svg{display:block;width:100%;height:150px}
.axis{display:flex;justify-content:space-between;color:var(--mute);font-size:11px;margin-top:6px;font-variant-numeric:tabular-nums}
.legend{display:flex;gap:16px;color:var(--mute);font-size:12px;margin-top:10px}.legend i{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:6px}
footer{color:var(--mute);font-size:12px;margin-top:22px;line-height:1.6}footer a{color:var(--accent);text-decoration:none}
</style></head><body><main>
<h1>Dashboard stats</h1>
<p class="sub">Anonymous counts from the relay. Days are UTC. Updated ${esc(r.generated.slice(11, 16))} UTC.</p>
<section class="tiles">
${tile('Today', r.dashboards.today)}${tile('7 days', r.dashboards.last_7_days)}${tile('30 days', r.dashboards.last_30_days)}
${tile('All time', r.dashboards.all_time)}${tile('New today', r.dashboards.new_today)}${tile('Live now', r.live_now.viewers, `on ${n(r.live_now.dashboards)} dashboard${r.live_now.dashboards === 1 ? '' : 's'}`)}
</section>
<section class="grid">
<div class="card wide"><h2>Dashboards a day</h2><p class="lead">Last 30 days, new and returning</p>
${bars(r.days.map((d) => [d.returning, d.new, `${d.day}: ${d.new} new, ${d.returning} returning`]), r.days[0].day)}
<div class="legend"><span><i style="background:var(--accent)"></i>New</span><span><i style="background:var(--soft)"></i>Returning</span></div></div>
<div class="card"><h2>Bots per dashboard</h2><p class="lead">Dashboards of the last 7 days</p>
<div class="pair"><div><span>Median</span><b class="big">${n(w.bots.median)}</b></div><div><span>Total</span><b class="big">${n(w.bots.total)}</b></div><div><span>Teams (median)</span><b class="big">${n(w.floors_median)}</b></div></div>
${w.bots.histogram.map((b) => row(`${b.label} bot${b.label === '1' ? '' : 's'}`, b.n, histMax)).join('')}</div>
<div class="card"><h2>How people set it up</h2><p class="lead">Share of the last 7 days' dashboards that show…</p>
${row('Usage meter', w.setup.usage, of, pct(w.setup.usage))}${row('Routines', w.setup.routines, of, pct(w.setup.routines))}
${row('Chat links', w.setup.chat, of, pct(w.setup.chat))}${row('Teams', w.setup.teams, of, pct(w.setup.teams))}</div>
<div class="card"><h2>Mailbox</h2><p class="lead">Where each dashboard's lines come from</p>
${row('Relay', w.sources.relay, of, pct(w.sources.relay))}${row('ntfy.sh', w.sources.ntfy, of, pct(w.sources.ntfy))}
${row('Both', w.sources.both, of, pct(w.sources.both))}${row('No lines yet', w.sources.none, of, pct(w.sources.none))}</div>
<div class="card"><h2>Device and time open</h2><p class="lead">Last 7 days</p>
<div class="pair"><div><span>Median visit</span><b class="big">${duration(w.visits.median_seconds)}</b></div><div><span>Visits measured</span><b class="big">${n(w.visits.count)}</b></div></div>
${row('Phone or tablet', w.devices.phone, of, pct(w.devices.phone))}${row('Desktop', w.devices.desktop, of, pct(w.devices.desktop))}</div>
<div class="card wide"><h2>Countries</h2><p class="lead">Where dashboards are opened, from the country Cloudflare sees · top 15</p>
<div class="cols"><div><h3>Last 7 days</h3>${places(r.countries.last_7_days, of)}</div><div><h3>All time · where first seen</h3>${places(r.countries.all_time, r.dashboards.all_time)}</div></div></div>
<div class="card"><h2>Relay messages a day</h2><p class="lead">Counted when each topic checks in, about twice a day · ${n(r.relay_messages_all_time)} all time</p>
${bars(r.days.map((d) => [0, d.relay_messages, `${d.day}: ${d.relay_messages} messages`]), r.days[0].day)}</div>
<div class="card"><h2>Free plan today</h2><p class="lead">Estimated from 1 in ${r.free_plan.sample} requests. At 70% on either, move to Workers Paid ($5 a month).</p>
${meter('Requests', r.free_plan.est_worker_requests)}${meter('Rows written', r.free_plan.est_rows_written)}</div>
</section>
<footer>A dashboard is known only by a hash of its topic, plus the country Cloudflare sees: no topics, IP addresses or user agents are stored. Daily totals are kept for good, per-dashboard days for 31 days.<br>
<a href="?key=${encodeURIComponent(key)}&amp;format=json">JSON</a></footer>
</main></body></html>`;
}

/** Inline SVG stacked bars, one per day: [[base, top, title], …], base in the soft colour, top in the accent. */
function bars(items, firstDay) {
  const max = Math.max(...items.map(([a, b]) => a + b), 1), step = 600 / items.length, w = step * 0.68;
  const rects = items.map(([a, b, title], i) => {
    const x = (i * step + (step - w) / 2).toFixed(1), ha = (140 * a) / max, hb = (140 * b) / max;
    return `<g><title>${esc(title)}</title><rect x="${x}" y="${(150 - ha).toFixed(1)}" width="${w.toFixed(1)}" height="${ha.toFixed(1)}" fill="var(--soft)"/>`
      + `<rect x="${x}" y="${(150 - ha - hb).toFixed(1)}" width="${w.toFixed(1)}" height="${hb.toFixed(1)}" fill="var(--accent)"/></g>`;
  }).join('');
  return `<svg viewBox="0 0 600 150" preserveAspectRatio="none" role="img" aria-label="peak ${max}"><line x1="0" y1="149.5" x2="600" y2="149.5" stroke="var(--line)"/>${rects}</svg>`
    + `<div class="axis"><span>${esc(firstDay.slice(5))}</span><span>peak ${max.toLocaleString('en-US')} a day</span><span>today</span></div>`;
}

const REGIONS = (() => { try { return new Intl.DisplayNames(['en'], { type: 'region' }); } catch { return null; } })();

function countryName(code) {
  if (code === 'Unknown') return 'Unknown';
  try { return REGIONS?.of(code) || code; } catch { return code; }
}

function flag(code) {                                    // two regional-indicator letters make the flag emoji
  return /^[A-Z]{2}$/.test(code) ? String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)) : '🌐';
}

function duration(s) {
  if (!s) return '–';
  if (s < 90) return `${Math.round(s)} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  return `${(s / 3600).toFixed(s < 36000 ? 1 : 0)} h`;
}

/** The median of a histogram over VISIT_BUCKETS, read linearly inside its bucket. */
function bucketMedian(buckets) {
  const total = buckets.reduce((a, b) => a + b, 0);
  let seen = 0;
  for (let i = 0; i < buckets.length; i++) {
    if (seen + buckets[i] >= total / 2 && buckets[i]) {
      const lo = i ? VISIT_BUCKETS[i - 1] : 0;
      return Math.round(lo + ((VISIT_BUCKETS[i] - lo) * (total / 2 - seen)) / buckets[i]);
    }
    seen += buckets[i];
  }
  return 0;
}

function median(sorted) { return sorted.length ? sorted[(sorted.length - 1) >> 1] : 0; }

async function sameSecret(given, secret) {
  if (!given || !secret) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(given)), crypto.subtle.digest('SHA-256', enc.encode(secret))]);
  return crypto.subtle.timingSafeEqual(a, b);            // equal-length digests: a constant-time compare
}

/** The browser's event stream, fed by a WebSocket to the topic's object. */
async function live(stub, topic, cfg) {
  const up = await stub.fetch(`https://relay/${encodeURIComponent(topic)}/listen`, { headers: { upgrade: 'websocket' } });
  const ws = up.webSocket;
  if (!ws) return retryLater(60);                        // the topic has MAX_VIEWERS streams open already
  ws.accept();
  const { readable, writable } = new TransformStream();
  const out = writable.getWriter(), enc = new TextEncoder();
  let open = true;
  const send = (text) => { if (open) out.write(enc.encode(text)).catch(stop); };
  const event = (name) => `event: ${name}\ndata: ${JSON.stringify({ id: randomId(12), time: Math.floor(Date.now() / 1000), event: name, topic })}\n\n`;
  const keepalive = setInterval(() => send(event('keepalive')), cfg.KEEPALIVE_SECONDS * 1000);
  const end = setTimeout(stop, cfg.STREAM_SECONDS * (0.85 + Math.random() * 0.3) * 1000);   // spread the reconnects
  function stop() {
    if (!open) return;
    open = false;
    clearInterval(keepalive);
    clearTimeout(end);
    try { ws.close(1000); } catch { /* already closed */ }
    out.close().catch(() => {});
  }
  ws.addEventListener('message', (e) => send(`data: ${e.data}\n\n`));
  ws.addEventListener('close', stop);
  ws.addEventListener('error', stop);
  send(`retry: 3000\n\n${event('open')}`);               // named events never reach EventSource.onmessage, as with ntfy
  return new Response(readable, { headers: SSE_HEADERS });
}

/** A stream that ends at once and asks the browser to come back later (EventSource gives up for good on a 429). */
function retryLater(seconds) {
  return new Response(`retry: ${seconds * 1000}\n\n`, { headers: SSE_HEADERS });
}

function settings(env) {
  const s = {};
  for (const [k, v] of Object.entries(DEFAULTS)) s[k] = Number(env?.[k]) > 0 ? Number(env[k]) : v;
  return s;
}

function statsObject(env) { return env.STATS?.get(env.STATS.idFromName('all')); }

function quiet(p) { return Promise.resolve(p).catch(() => {}); }   // stats are optional: never let them fail a request

async function hash16(topic) {                          // the same hash the dashboard's beacon sends
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(topic)));
  return [...digest.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function shape(topic, { id, time, message }, cfg) {
  return { id, time, expires: time + cfg.RETAIN_SECONDS, event: 'message', topic, message };
}

function utcDay(ms) { return new Date(ms).toISOString().slice(0, 10); }

function addDays(day, n) { return utcDay(Date.parse(`${day}T00:00:00Z`) + n * 864e5); }

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }

async function allowed(limiter, key) {
  if (!limiter) return true;
  try { return (await limiter.limit({ key })).success; } catch { return true; }   // a broken limiter must not take the relay down
}

/** The request body, or null when it is longer than `max` bytes (read no further than that). */
async function readCapped(request, max) {
  if (Number(request.headers.get('content-length')) > max) return null;
  if (!request.body) return new Uint8Array(0);
  const parts = [];
  let n = 0;
  for await (const part of request.body) {
    n += part.byteLength;
    if (n > max) return null;
    parts.push(part);
  }
  const out = new Uint8Array(n);
  n = 0;
  for (const part of parts) { out.set(part, n); n += part.byteLength; }
  return out;
}

function randomId(n) {
  let s = '';
  for (const b of crypto.getRandomValues(new Uint8Array(n))) s += ALNUM[b % ALNUM.length];
  return s;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body) + '\n', { status, headers: { ...CORS, 'content-type': 'application/json' } });
}

function fail(status, code, error) {
  return json({ code, http: status, error }, status);
}
