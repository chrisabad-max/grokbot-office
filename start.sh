#!/usr/bin/env bash
# Start the Bot HQ server (and optionally a Cloudflare quick tunnel). Safe to run repeatedly.
#
#   ./start.sh [server flags]        e.g. ./start.sh --dev
#
# Env: BOTHQ_PORT (8787)  BOTHQ_HOST (127.0.0.1)  BOTHQ_JOURNAL  BOTHQ_PASSWORD  BOTHQ_TZ
#      BOTHQ_TUNNEL=1  also start `cloudflared` and publish its https URL in data/tunnel-url.txt
# The last lines printed are the wallpaper links for Lively Wallpaper: …/face/?key=<data/view-key.txt> (Grok Bot face)
# and …/?mode=wallpaper&key=… (the office).
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA="$ROOT/data"
PORT="${BOTHQ_PORT:-8787}"
HOST="${BOTHQ_HOST:-127.0.0.1}"
CHECK_HOST="$HOST"
[ "$CHECK_HOST" = "0.0.0.0" ] && CHECK_HOST="127.0.0.1"
SERVER_PID="$DATA/server.pid"
TUNNEL_PID="$DATA/tunnel.pid"
LOG="$DATA/server.log"
TUNNEL_LOG="$DATA/tunnel.log"
TUNNEL_URL_FILE="$DATA/tunnel-url.txt"

mkdir -p "$DATA"

alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }

# true if the pid's command line (when /proc is available) matches the pattern
ours() {
  local cmd
  [ -r "/proc/$1/cmdline" ] || return 0
  cmd="$(tr '\0' ' ' < "/proc/$1/cmdline" 2>/dev/null)"
  case "$cmd" in *"$2"*) return 0 ;; *) return 1 ;; esac
}

answers() {
  node -e 'const h=require("http");h.get({host:process.argv[1],port:+process.argv[2],path:"/healthz",timeout:1500},r=>{r.resume();process.exit(r.statusCode===200?0:1)}).on("error",()=>process.exit(1)).on("timeout",function(){this.destroy();process.exit(1)})' "$CHECK_HOST" "$PORT"
}

command -v node >/dev/null 2>&1 || { echo "node not found in PATH (Node 24 required)" >&2; exit 1; }

url="http://$CHECK_HOST:$PORT"
had_password=0
[ -f "$DATA/password.txt" ] && had_password=1

# ---------- server ----------
pid=""
[ -f "$SERVER_PID" ] && pid="$(cat "$SERVER_PID" 2>/dev/null)"
if alive "$pid" && ours "$pid" "server.js" && answers; then
  echo "Bot HQ is already running (pid $pid): $url"
elif answers; then
  echo "Something already answers on $url (no pid file); leaving it alone: $url"
else
  if alive "$pid" && ours "$pid" "server.js"; then
    echo "stale server process $pid is not answering, restarting"
    kill "$pid" 2>/dev/null; sleep 1; kill -9 "$pid" 2>/dev/null
  fi
  rm -f "$SERVER_PID"
  nohup node "$ROOT/server/server.js" --port "$PORT" --host "$HOST" "$@" >> "$LOG" 2>&1 &
  pid=$!
  echo "$pid" > "$SERVER_PID"
  disown "$pid" 2>/dev/null || true
  ok=0
  for _ in $(seq 1 50); do
    if ! alive "$pid"; then break; fi
    if answers; then ok=1; break; fi
    sleep 0.2
  done
  if [ "$ok" != 1 ]; then
    echo "server failed to start; last log lines:" >&2
    tail -n 15 "$LOG" >&2
    rm -f "$SERVER_PID"
    exit 1
  fi
  echo "Bot HQ started (pid $pid): $url"
  echo "log: $LOG"
  if [ "$had_password" = 0 ] && [ -f "$DATA/password.txt" ]; then
    echo "first start - generated password: $(cat "$DATA/password.txt")  (kept in data/password.txt)"
  fi
fi

# ---------- tunnel (optional) ----------
if [ "${BOTHQ_TUNNEL:-0}" = "1" ]; then
  cf="$(command -v cloudflared 2>/dev/null || true)"
  [ -z "$cf" ] && [ -x "$ROOT/bin/cloudflared" ] && cf="$ROOT/bin/cloudflared"
  if [ -z "$cf" ]; then
    echo "BOTHQ_TUNNEL=1 but cloudflared was not found (see README-server.md); tunnel skipped" >&2
  else
    tpid=""
    [ -f "$TUNNEL_PID" ] && tpid="$(cat "$TUNNEL_PID" 2>/dev/null)"
    if alive "$tpid" && ours "$tpid" "cloudflared" && [ -s "$TUNNEL_URL_FILE" ]; then
      echo "Tunnel already running (pid $tpid): $(cat "$TUNNEL_URL_FILE")"
    else
      if alive "$tpid" && ours "$tpid" "cloudflared"; then kill "$tpid" 2>/dev/null; sleep 1; fi
      rm -f "$TUNNEL_PID" "$TUNNEL_URL_FILE"
      : > "$TUNNEL_LOG"
      nohup "$cf" tunnel --no-autoupdate --url "http://$CHECK_HOST:$PORT" >> "$TUNNEL_LOG" 2>&1 &
      tpid=$!
      echo "$tpid" > "$TUNNEL_PID"
      disown "$tpid" 2>/dev/null || true
      turl=""
      for _ in $(seq 1 100); do
        turl="$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | head -n 1)"
        [ -n "$turl" ] && break
        alive "$tpid" || break
        sleep 0.3
      done
      if [ -n "$turl" ]; then
        echo "$turl" > "$TUNNEL_URL_FILE"
        echo "Tunnel: $turl"
      else
        echo "tunnel did not report a URL; see $TUNNEL_LOG" >&2
      fi
    fi
  fi
fi

# ---------- wallpaper link (Lively Wallpaper): the view-only key signs the browser in, no password to type ----------
base="$url"
if [ "${BOTHQ_TUNNEL:-0}" = "1" ] && [ -s "$TUNNEL_URL_FILE" ] && alive "$(cat "$TUNNEL_PID" 2>/dev/null)"; then
  base="$(tr -d '[:space:]' < "$TUNNEL_URL_FILE")"      # the https tunnel address, only while the tunnel process is alive
fi
vkey=""
[ -s "$DATA/view-key.txt" ] && vkey="$(tr -d '[:space:]' < "$DATA/view-key.txt")"
if [ -n "$vkey" ]; then
  echo "Ссылка для обоев (офис): $base/?mode=wallpaper&key=$vkey"
  echo "Ссылка для обоев (Grok Bot): $base/face/?key=$vkey"
else
  echo "Ссылка для обоев: $base/?mode=wallpaper  (ключа нет: data/view-key.txt создаётся при старте сервера; перезапусти ./stop.sh && ./start.sh)"
fi
exit 0
