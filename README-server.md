# Bot HQ server

Zero-dependency Node 24 server: tails the bots' journal (`events.jsonl`), derives the live state
(CONTRACT section 4) and serves it to the browser together with the static web app.

## Run

```bash
# production box (Linux): journal /workspace/bot-hq/events.jsonl
./start.sh                       # idempotent; prints the URL
BOTHQ_TUNNEL=1 ./start.sh        # + Cloudflare quick tunnel, URL in data/tunnel-url.txt
./stop.sh                        # stops server, tunnel, demo (idempotent)

# development (any OS): journal ./data/events.jsonl, DEMO badge on
node server/demo.js              # fake bots writing to ./data/events.jsonl (add --fast for 5x speed)
node server/server.js --dev      # http://127.0.0.1:8787
```

`start.sh` writes `data/server.pid`, logs to `data/server.log`, and forwards extra arguments to the server
(`./start.sh --dev`). On the first start it prints the generated password. Its last line is the wallpaper link
(`<tunnel URL if any, else local URL>/?mode=wallpaper&key=<view key>`), see `docs/WALLPAPER.md`.

### Flags

```
node server/server.js [--dev] [--port 8787] [--host 127.0.0.1] [--journal path] [--no-auth]
                      [--demo|--no-demo] [--tz Europe/Sofia] [--data-dir dir] [--no-cache]
```

| Flag | Meaning |
|---|---|
| `--dev` | journal = `./data/events.jsonl`, `demo: true` in the state |
| `--journal` | journal path (default `/workspace/bot-hq/events.jsonl`) |
| `--no-auth` | no password gate; refused unless `--host` is `127.0.0.1` / `localhost` / `::1` |
| `--demo` / `--no-demo` | force the `demo` flag (otherwise: `--dev`, or the newest journal line carries `"demo":true`) |
| `--tz` | timezone for output timestamps and "today" stats (default `Europe/Sofia`) |
| `--no-cache` | `/assets/` answer `no-cache` instead of `max-age=3600`, so a reload shows edited images (the Lively autostart in `lively/` uses it) |

Env (used by `start.sh` too): `BOTHQ_PASSWORD`, `BOTHQ_PORT`, `BOTHQ_HOST`, `BOTHQ_JOURNAL`, `BOTHQ_TZ`, `BOTHQ_TUNNEL=1`.

## Routes

| Route | Notes |
|---|---|
| `GET /api/state[?since=N]` | full state, or `{"version":N,"unchanged":true}`; gzip if accepted, `no-store` |
| `GET /` , `/app.js`, ... | static `web/` (revalidated with ETag) |
| `GET <any page>?key=<view key>` | same session cookie as a password login, then `302` to the same URL without `key` (other query pairs untouched). Wrong key: ignored, normal login redirect. Not for `/api/*` |
| `GET /assets/...` | static `assets/` (`Cache-Control: public, max-age=3600`, `.glb` = `model/gltf-binary`) |
| `GET/POST /login`, `/logout` | password form (Russian), session cookie |
| `GET /healthz` | `ok`, no auth (used by `start.sh`) |

Unauthenticated `/api/*` gets `401 {"error":"unauthorized"}`; pages redirect to `/login?next=...`.

## Files

```
server/server.js   HTTP server, routing, config reload, CLI
server/journal.js  file tail (offset, fs.watch + 1 s stat poll, partial line, truncation, rotation, 5 MB tail on start)
server/state.js    reducer: journal records -> state (ids, floors, desks, effective status, history, feed, usage)
server/auth.js     password/secret files, HMAC session cookie, login rate limit, login page
server/static.js   static files (traversal-safe, MIME, ETag)
server/demo.js     demo event generator for the 15 demo bots
server/test/       node:test suites
data/              runtime only, never commit:
  events.jsonl       dev journal          password.txt   generated once (or env BOTHQ_PASSWORD)
  view-key.txt       wallpaper view-only key, generated once (48 hex chars); delete it + restart to rotate
  secret.key         cookie HMAC secret   server.pid / server.log / tunnel.pid / tunnel.log / tunnel-url.txt
  floors.json        optional floor mapping     bots.json   optional per-bot overrides
```

### Optional config (reloaded within about 1 s of a change)

`data/bots.json` - per bot, keyed by bot name or id:
```json
{"X Writer": {"floor": "x-content", "chat_url": "grokbot://app/v1/agent?id=...", "avatar": "x-writer", "color": "#2F6BFF"}}
```
Optional `look` per bot (generated avatar, see `docs/AVATARS.md`): `{"look": {"shape": "hexagon", "color": "#1E86FC", "accessory": "glasses"}}`.
Validated field by field: unknown shape -> `null`, colour must be `#RRGGBB` (else `null`), unknown accessory -> `none`;
a look with neither a usable shape nor a usable colour becomes `null`. Served as `bots[id].look`; when no explicit
`color` is set, `look.color` also becomes the bot colour. `bots[id].has_glb` tells the browser whether
`assets/blobs/<avatar>.glb` exists, so it never probes (and 404s) for hand-made models that are not there.
`data/floors.json` - bot -> floor, optionally with floor names and order. Either form works:
```json
{"X Writer": "x-content", "Some Bot": "Новый отдел"}
{"floors": [{"id": "ops", "name": "Операции"}], "bots": {"Some Bot": "ops"}}
```
Floor of a bot: `bots.json` floor, else `floors.json`, else its `group`, else `general` ("Общий этаж").
Max 20 bots per floor, the 21st goes to `<id>-2` ("<name> · 2"). Desk numbers are assigned in order of
first sight and stay stable while the server runs (after a restart they are rebuilt from the journal tail).

## Journal behaviour

- Reads the last 5 MB on start, then follows by byte offset. Partial last line is buffered. Truncation
  (`size < offset`) and rotation (inode change, old file drained first) re-read the new file; events already
  seen are not applied twice.
- Lines over 4 KB are skipped (`meta.too_long`), non-JSON lines are counted in `meta.parse_errors`.
- Status synonyms: `waiting` -> `waiting_user`, `failed` -> `error`, `finished` -> `done` (and a few more);
  an unknown status becomes `working` if a `step` is present.
- `effective_status`: `stuck` = working and silent for over 30 min; `done` shows for 60 s, then `idle`;
  silent for over 3 h = `idle`. A 1 s timer re-evaluates this, so `version` changes when only time passed.
- `version` starts at the unix time of the server start (so a restart never reuses a client's `since`) and
  increases by one per real change.

## Security notes

Password in `data/password.txt` (mode 600) or env; session cookie is `HttpOnly; SameSite=Lax`, `Secure`
when `x-forwarded-proto: https` (cloudflared sets it), signed with `data/secret.key`, valid 30 days;
changing the password logs everyone out. Login is limited to 6 failures per 10 minutes per client IP
(behind the tunnel the IP comes from `cf-connecting-ip`). Dotfiles and anything outside `web/` / `assets/`
are never served. Keep the server on `127.0.0.1` and publish it only through the tunnel.

### View-only key (wallpaper links)

Lively Wallpaper cannot type a password, so `data/view-key.txt` holds a random key (at least 32 chars, generated on
the first start with auth on). Opening any page with `?key=<key>` signs the browser in exactly like the login form
(same HttpOnly session cookie, 30 days; `Secure` behind the https tunnel) and redirects to the same URL without the
key, so it does not stay in the address bar. The comparison is constant-time. The key opens the dashboard
(read-only, the app has no write endpoints); treat the link like a password. Rotate: delete the file and restart.

## Installing cloudflared (for `BOTHQ_TUNNEL=1`)

Quick tunnels need no Cloudflare account. Get the binary from GitHub releases and either put it in `PATH`
or in `bin/cloudflared` next to `start.sh`:

```bash
mkdir -p bin
# x86_64:
curl -fL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o bin/cloudflared
# ARM64: .../cloudflared-linux-arm64
chmod +x bin/cloudflared
./bin/cloudflared --version
```

`BOTHQ_TUNNEL=1 ./start.sh` then runs `cloudflared tunnel --no-autoupdate --url http://127.0.0.1:8787`,
parses the `https://*.trycloudflare.com` address from its log and writes it to `data/tunnel-url.txt`.
The address changes on every tunnel start. Quick tunnels do not support SSE, which is why the browser polls.

## Tests

```bash
node --test server/test/
```

(`server/test/index.js` pulls in the three suites; on Node 22+ a bare directory is not expanded, plain
`node --test` also works but runs each suite twice.)
