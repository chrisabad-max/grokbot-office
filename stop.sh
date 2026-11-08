#!/usr/bin/env bash
# Stop everything start.sh started (server, tunnel, demo generator). Safe to run repeatedly.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA="$ROOT/data"

alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }

ours() {
  local cmd
  [ -r "/proc/$1/cmdline" ] || return 0
  cmd="$(tr '\0' ' ' < "/proc/$1/cmdline" 2>/dev/null)"
  case "$cmd" in *"$2"*) return 0 ;; *) return 1 ;; esac
}

stop_one() { # label pidfile pattern
  local label="$1" file="$2" pattern="$3" pid
  if [ ! -f "$file" ]; then echo "$label: not running"; return 0; fi
  pid="$(cat "$file" 2>/dev/null)"
  if alive "$pid" && ours "$pid" "$pattern"; then
    kill "$pid" 2>/dev/null
    for _ in $(seq 1 50); do alive "$pid" || break; sleep 0.1; done
    if alive "$pid"; then kill -9 "$pid" 2>/dev/null; echo "$label: killed (pid $pid)"; else echo "$label: stopped (pid $pid)"; fi
  else
    echo "$label: not running (stale pid file)"
  fi
  rm -f "$file"
}

stop_one "tunnel" "$DATA/tunnel.pid" "cloudflared"
rm -f "$DATA/tunnel-url.txt"
stop_one "demo" "$DATA/demo.pid" "demo.js"
stop_one "server" "$DATA/server.pid" "server.js"
exit 0
