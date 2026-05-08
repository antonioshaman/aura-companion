#!/usr/bin/env bash
# Aura restart wrapper (Deploy expert D4).
#
# The smallest possible thing that prevents the next "barely got back" event:
# pidfile-tracked SIGTERM with timeout, clean detached restart with stdout/err
# captured, and a /ready poll so we know the new process is actually able to
# serve requests before this script exits.
#
# Why a script not systemd: one VPS, one maintainer, no service-management
# workflow today — a 60-line shell script eliminates the failure mode without
# requiring the maintainer to learn systemd under pressure.
#
# Usage:
#   bash scripts/aura-restart.sh                 # graceful restart
#   bash scripts/aura-restart.sh --status        # show running PID
#   bash scripts/aura-restart.sh --stop          # stop without restart
#
# Env overrides:
#   AURA_PORT      (default 3456)
#   AURA_PIDFILE   (default /root/aura-companion/.aura-server.pid)
#   AURA_LOGFILE   (default /root/aura-companion/web/bun.log)
#   AURA_READY_TIMEOUT_S  (default 30)

set -u

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
PORT="${AURA_PORT:-3456}"
PIDFILE="${AURA_PIDFILE:-$REPO_ROOT/.aura-server.pid}"
LOGFILE="${AURA_LOGFILE:-$REPO_ROOT/web/bun.log}"
READY_TIMEOUT="${AURA_READY_TIMEOUT_S:-30}"

err()  { echo "[aura-restart] ERR: $*" >&2; }
info() { echo "[aura-restart] $*"; }

read_pidfile() {
  [[ -f "$PIDFILE" ]] || return 1
  local pid
  pid=$(cat "$PIDFILE" 2>/dev/null || true)
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null && echo "$pid"
}

stop_running() {
  local pid
  pid=$(read_pidfile || true)
  if [[ -z "${pid:-}" ]]; then
    # Pidfile missing/stale — try to find a bun bound to our port instead.
    pid=$(lsof -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1 || true)
  fi
  if [[ -z "${pid:-}" ]]; then
    info "no running server found (port $PORT free, no pidfile)"
    rm -f "$PIDFILE"
    return 0
  fi
  info "sending SIGTERM to PID $pid"
  kill "$pid" 2>/dev/null || true
  for i in $(seq 1 10); do
    if ! kill -0 "$pid" 2>/dev/null; then
      info "stopped cleanly after ${i}s"
      rm -f "$PIDFILE"
      return 0
    fi
    sleep 1
  done
  err "SIGTERM ignored after 10s — sending SIGKILL"
  kill -9 "$pid" 2>/dev/null || true
  sleep 1
  rm -f "$PIDFILE"
}

start_detached() {
  cd "$REPO_ROOT/web"
  # Truncate the log on each restart to bound disk usage (Deploy D6).
  # The recordings/companion logs rotate themselves; bun.log was unbounded
  # until this wrapper. Anyone needing the previous log should grab it
  # before re-running this script.
  : > "$LOGFILE"

  # `setsid` detaches us from the controlling terminal so the child survives
  # this shell exiting. NODE_ENV=production matches the user's existing
  # invocation pattern.
  setsid env NODE_ENV=production bun server/index.ts >> "$LOGFILE" 2>&1 < /dev/null &
  local new_pid=$!
  disown "$new_pid" 2>/dev/null || true
  echo "$new_pid" > "$PIDFILE"
  info "started PID $new_pid (logs: $LOGFILE)"
}

poll_ready() {
  local url="http://localhost:$PORT/ready"
  local deadline=$(( $(date +%s) + READY_TIMEOUT ))
  local code=""
  while [[ $(date +%s) -lt $deadline ]]; do
    code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 "$url" 2>/dev/null || echo "000")
    if [[ "$code" == "200" ]]; then
      info "/ready returned 200 — server is serviceable"
      return 0
    fi
    sleep 1
  done
  err "/ready did not return 200 within ${READY_TIMEOUT}s (last code: $code)"
  err "tail of log:"
  tail -20 "$LOGFILE" >&2 || true
  return 1
}

cmd_status() {
  local pid
  pid=$(read_pidfile || true)
  if [[ -z "${pid:-}" ]]; then
    info "not running (no live pidfile)"
    return 1
  fi
  info "running PID $pid"
  curl -s --max-time 2 "http://localhost:$PORT/ready" || true
  echo
}

case "${1:-}" in
  --status)
    cmd_status
    exit $?
    ;;
  --stop)
    stop_running
    exit $?
    ;;
  "")
    stop_running
    start_detached
    if ! poll_ready; then
      exit 1
    fi
    info "restart complete"
    ;;
  *)
    err "unknown argument: $1"
    err "usage: $(basename "$0") [--status|--stop]"
    exit 2
    ;;
esac
