# Grok Bot relay

Our own mailbox for the dashboard on Cloudflare Workers, so it no longer depends on ntfy.sh's 250 messages a day per
IP. Bots keep posting exactly as before, `curl -s -d '<json>' https://<host>/<topic>`; only the host changes.

| Request | What it does |
|---|---|
| `POST /<topic>` (or `PUT`) | The body is one message: UTF-8, at most 4,096 bytes (413 above). |
| `GET /<topic>/json?poll=1&since=12h` | The kept messages as newline-delimited JSON `{id,time,expires,event:"message",topic,message}`. `since` also takes `<id>` (the ones after it), `30m`, `all`, `latest`, a unix time. An id the relay no longer has returns everything kept. |
| `GET /<topic>/ws` | Live: one WebSocket text frame per message (the same JSON), an `open` frame first. Send `ping`, get `pong`. This is what the patched dashboard uses. |
| `GET /<topic>/sse` | Live, ntfy-style: `data: <json>` per message, `open`/`keepalive` as named events. For plain ntfy clients. |
| `POST /_beacon` | From the dashboard: `{h, bots, floors, src, phone, has}` when it opens, `{h, secs}` when the visit ends (see Privacy). |
| `GET /_stats?key=<STATS_KEY>` | The private stats page; add `&format=json` for the numbers. 404 without the right key. |
| `GET /v1/health` | `{"healthy":true, ...the limits}` |

Topics match `^[A-Za-z0-9_-]{6,64}$`; CORS is `*`. One Durable Object (SQLite) per topic keeps the last 12 h, at most
600 lines, and is wiped (storage freed) 12 h after its last message. Every live viewer is a hibernatable WebSocket on
that object: while the bots are quiet the object sleeps, costs no duration, and answers `ping` without waking up. The
`/sse` stream is fed the same way through the Worker and ends after about 30 min (the free plan's 10 ms of CPU per
request), then the browser reconnects and catches up.

Limits: per topic, 60 messages at once, then one every 5 s (429 after that). Per IP, 300 posts and 120 reads a minute
per Cloudflare location; high on purpose, because Grok Bot sends every user's curl from a few shared IPs. Per topic,
at most 50 live viewers. All knobs are at the top of `src/index.js`.

## Deploy (in your own terminal)

```powershell
cd C:\Users\Asus\Desktop\bot-hq\relay
npx wrangler@4 login
npx wrangler@4 deploy
npx wrangler@4 secret put STATS_KEY
```

1. `npx wrangler@4` downloads Wrangler, Cloudflare's CLI, once. To skip the download, use the copy already on this PC:
   `node C:\Users\Asus\rea-home\node_modules\wrangler\bin\wrangler.js` in place of `npx wrangler@4`.
2. `login` opens the browser: sign in to Cloudflare there and allow Wrangler.
3. `deploy` publishes the Worker at its public address, `https://relay.0xcodila.com` (the custom-domain route in
   `wrangler.jsonc`; keep that entry). The `workers.dev` address keeps working too. If npm fails on a certificate
   error, set `$env:NODE_OPTIONS="--use-system-ca"` first.
4. `secret put` asks for the stats password; type a long random one. Your stats page is then
   `https://relay.0xcodila.com/_stats?key=<that password>`.

Check the live relay (11 tests pass; the 5 slow ones and the 3 that send made-up beacons are skipped there, so your
stats stay clean):

```powershell
$env:RELAY_URL="https://relay.0xcodila.com"; node --test test/relay.test.mjs
```

Local run with small knobs, so all 20 tests run (`STATS_TEST` lets a test beacon claim another day and country; never
set it live):

```powershell
npx wrangler@4 dev --var RETAIN_SECONDS:8 --var KEEP_LINES:20 --var TOPIC_BURST:30 --var KEEPALIVE_SECONDS:2 --var STREAM_SECONDS:6 --var STATS_KEY:local-test-key --var STATS_SAMPLE:1 --var STATS_TEST:1
$env:RELAY_URL="http://127.0.0.1:8787"; $env:RELAY_STATS_KEY="local-test-key"; $env:RELAY_STATS_TEST="1"; node --test test/relay.test.mjs
```

## The stats page

`/_stats?key=…`: dashboards opened today, in 7 and 30 days and all time, new today, and live now (open viewer sockets,
reported by each topic when one connects or closes). Below: 30 days of new vs returning dashboards, bots per dashboard,
how fully people set up the prompt (usage meter, routines, chat links, teams), relay vs ntfy.sh, phone vs desktop, the
median visit, countries (top 15 for 7 days and all time; two-letter code only, XX/T1/missing as Unknown), relay
messages a day, and today's free-plan meter (Worker requests and rows written, estimated from one
request in 20) against the 100,000-a-day cap. Days are UTC.

Kept forever: one row per dashboard (its hash, first and last day seen, the country first seen in) and one aggregate per
day, with each country's count. Kept 31 days: one row per dashboard per day, and per dashboard, day and country. Counters are per day (visit lengths in 13 buckets, request tallies); a reload updates its row,
and at most 20 visit ends count per dashboard a day, so nothing grows with the number of requests.

## What the plans carry

**The quotas are per Cloudflare account, shared by everyone who uses the relay**, not per user. Free plan, reset daily at
00:00 UTC: 100,000 Worker requests, 100,000 Durable Object requests, 100,000 SQLite rows written, 5 million rows read,
13,000 GB-s of Durable Object duration, 5 GB storage.

One active user here: about 150 messages a day (10 bots' statuses, the daily roster, looks, teams, chat links and
routines, 4 usage lines) and one dashboard open all day.

| Per day | Free quota (account) | One active user | Users that fit |
|---|---|---|---|
| Worker requests | 100,000 | ~160 (150 posts + ~10 for the dashboard: history, socket, catch-ups, beacon) | ~600 |
| Durable Object requests | 100,000 | ~165–235 (the top end if each `ping` counts as 1/20 of a request) | ~425–600 |
| SQLite rows written | 100,000 | ~300 (each message is written once and deleted once) | **~330** |
| SQLite rows read | 5,000,000 | ~1,500 | ~3,000 |
| Durable Object duration | 13,000 GB-s | ~0.3 GB-s (asleep between messages) | ~40,000 |

- **Free: about 330 active users a day, about 50,000 relay messages.** Past that, Cloudflare refuses requests (error 1027)
  or writes for everyone until 00:00 UTC.
- People who only watch (or whose bots still post to ntfy.sh) cost the relay ~10 Worker and 10–80 DO requests a day
  each: the free plan carries roughly 1,200–10,000 of them on top.
- Users still on ntfy.sh cost nothing for their posts: those go to ntfy.sh.
- **Workers Paid, $5 a month**: no daily cap. Included each month: 10 million Worker requests, 1 million DO requests
  ($0.15 per million after), 50 million rows written ($1 per million after). About $6 a month at 1,000 active users a
  day, about $65–70 at 10,000 (most of it rows written). Viewers cost cents.

## Privacy

The dashboard sends two anonymous beacons per visit: on open, the first 16 hex characters of the SHA-256 of the topic,
the number of bots and teams, which mailbox the lines came from, phone or not, and which parts of the prompt are set up,
and the country Cloudflare sees for the request (never the IP); on leaving, how long it was open. The relay stores no topic, IP address or user agent, and the stats page is behind a
secret key.

## Switching from ntfy.sh

Why: ntfy.sh lets an anonymous IP post 250 messages a day (rolling 24 h) and 60 requests at once, then one per 5 s.
If Grok Bot posts from shared IPs, two active users per IP use up the 250, and a few users' 08:00 routines in the same
minute empty the 60-request bucket. Readers are fine: each browser has its own IP. To see whether the IPs are shared, ask
a bot to run `curl -s https://ntfy.sh/v1/account` and report `stats.messages`: far more than your own bots posted today
means the IP is shared.

1. Deploy (above). Done: the relay answers at `relay.0xcodila.com`.
2. Apply `feed.patch` to `web/feed.js` (see `feed-patch.md`) and publish the site (done in 55ecf77). From then on every dashboard link
   `#<topic>` reads both ntfy.sh and the relay. Nobody has to change anything; old users keep working on ntfy.sh.
3. Post `PROMPT-relay.md` as the new prompt: the same text, only the FEED host in step 1 changed.
4. For old users who hit ntfy's limit: post the text in `UPGRADE.md`. It keeps their topic, so their dashboard link and
   Lively wallpaper stay as they are.
5. Before the new prompt goes out, `landing/index.html` (the "did your bot post yet" check) and `web/face/face.js` must
   read the relay too; they read only ntfy.sh today.
6. If more than ~250 people use it daily, switch the Cloudflare account to Workers Paid before the free cap hits.
