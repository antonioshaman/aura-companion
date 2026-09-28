#!/usr/bin/env bash
# Autonomous driver for specs/aura-meta-diet.md (see specs/aura-meta-diet/RUNBOOK.md).
#
# Launch once and walk away:
#   nohup setsid /root/aura-companion/scripts/aura-diet/run.sh >/home/auracomp/aura-diet/driver.log 2>&1 &
# Watch:   tail -f /home/auracomp/aura-diet/JOURNAL.md
# Stop:    touch /home/auracomp/aura-diet/STOP
# Result:  /home/auracomp/aura-diet/FINAL-REPORT.md  (+ draft PR diet/main -> main)
#
# Each loop iteration runs one fresh headless `claude -p` that performs one RUNBOOK step.
# Usage/rate limits are handled by sleeping until reset and retrying the same step.
set -uo pipefail

WORK="${AURA_DIET_WORK:-/home/auracomp/aura-diet}"
SRC="/root/aura-companion"                     # prod checkout: read-only source of spec files
REPO="$WORK/repo"
STATE="$WORK/STATE.json"
LOGS="$WORK/logs"
ITER_TIMEOUT="${AURA_DIET_ITER_TIMEOUT:-5h}"
MAX_STALL="${AURA_DIET_MAX_STALL:-4}"          # iterations without STATE change before giving up

mkdir -p "$WORK" "$LOGS"
exec 9>"$WORK/.lock"
flock -n 9 || { echo "another driver is running"; exit 1; }

log() { echo "[$(date -Is)] $*" | tee -a "$WORK/driver-events.log"; }

# --- one-time setup: isolated clone + integration branch -------------------------------
if [ ! -d "$REPO/.git" ]; then
  log "cloning into $REPO"
  git clone git@github.com:antonioshaman/aura-companion.git "$REPO" || exit 1
  git -C "$REPO" checkout -b diet/main origin/main
  mkdir -p "$REPO/specs/aura-meta-diet" "$REPO/scripts/aura-diet"
  cp "$SRC/specs/aura-meta-diet.md" "$REPO/specs/"
  cp "$SRC/specs/aura-meta-diet/RUNBOOK.md" "$REPO/specs/aura-meta-diet/"
  cp "$SRC/scripts/aura-diet/run.sh" "$REPO/scripts/aura-diet/"
  git -C "$REPO" add specs/aura-meta-diet.md specs/aura-meta-diet scripts/aura-diet
  printf 'docs(spec): aura meta-diet + AuraBench spec and runbook\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n' > "$WORK/.msg"
  git -C "$REPO" -c user.name="Anton Shmonin" -c user.email="rufirium@gmail.com" \
    commit --no-verify -F "$WORK/.msg"
  git -C "$REPO" push -u origin diet/main || exit 1
  (cd "$REPO/web" && bun install) || exit 1
fi

if [ ! -f "$STATE" ]; then
  cat >"$STATE" <<'EOF'
{
  "status": "running",
  "current_phase": "P1",
  "phases": {
    "P1": {"status":"pending","steps":{"C2":{},"A1":{},"A2":{}}},
    "P2": {"status":"pending","steps":{"A3":{},"B4":{}}},
    "P3": {"status":"pending","steps":{"B1":{},"B2":{},"B3":{}}},
    "P4": {"status":"pending","steps":{"C1a":{},"C1b":{},"C1c":{},"C1d":{},"C1e":{},"C3":{}}},
    "P5": {"status":"pending","steps":{"D1":{}}},
    "P6": {"status":"pending","steps":{"D2-harness":{},"D2-pilot":{},"D2-full":{},"D3":{},"A3-recheck":{},"FINAL":{}}}
  },
  "metrics": {},
  "bench": {"tasks_valid":0,"cells_total":0,"cells_done":0},
  "updated_at": null
}
EOF
  touch "$WORK/JOURNAL.md" "$WORK/ASK-FIRST.md"
fi

PROMPT="Ты — автономный исполнитель. Человека нет, вопросов не задавай.
Прочитай $REPO/specs/aura-meta-diet/RUNBOOK.md (протокол) и $REPO/specs/aura-meta-diet.md (ACs).
Состояние: $STATE. Журнал: $WORK/JOURNAL.md. Очередь для человека: $WORK/ASK-FIRST.md.
Выполни РОВНО ОДИН следующий шаг по §1 RUNBOOK, с верификацией, коммитом/PR в diet/main,
обновлением STATE.json и JOURNAL.md. Всё запрещённое/требующее человека — в ASK-FIRST.md.
Если все шаги done или blocked — выполни FINAL (если ещё не) и поставь STATE.status."

stall=0
iter=0
while :; do
  [ -f "$WORK/STOP" ] && { log "STOP file found, exiting"; exit 0; }
  status=$(python3 -c "import json;print(json.load(open('$STATE'))['status'])" 2>/dev/null || echo broken)
  case "$status" in
    done)    log "STATE done — see $WORK/FINAL-REPORT.md"; exit 0 ;;
    stalled) log "STATE stalled — see ASK-FIRST.md"; exit 2 ;;
    broken)  log "STATE.json unreadable — stopping for human"; exit 3 ;;
  esac

  # D2-full runs for days: the driver executes the idempotent bench runner itself
  # (command recorded by the executor in STATE.bench.runner_cmd after D2-pilot),
  # then hands back to a claude iteration to verify and mark the step done.
  runner=$(python3 - "$STATE" <<'PY'
import json,sys
s=json.load(open(sys.argv[1])); b=s.get("bench",{})
st=s["phases"]["P6"]["steps"].get("D2-full",{}).get("status")
if st=="in_progress" and b.get("runner_cmd") and b.get("cells_done",0)<b.get("cells_total",1):
    print(b["runner_cmd"])
PY
)
  if [ -n "$runner" ]; then
    log "bench runner: $runner"
    (cd "$REPO" && nice -n 10 bash -c "$runner") >>"$LOGS/bench-runner.log" 2>&1
    log "bench runner exit=$?"
  fi

  iter=$((iter+1))
  before=$(sha256sum "$STATE" | cut -d' ' -f1)
  out="$LOGS/iter-$(printf %04d $iter)-$(date +%Y%m%dT%H%M%S).jsonl"
  log "iteration $iter start ($out)"

  # Unset AURA_* so tests see clean env (see memory: AURA_*_TIMEOUT_MS pollutes adapter tests).
  unset_args=$(env | grep -oE '^AURA_[A-Z_]+' | grep -v '^AURA_DIET_' | sed 's/^/-u /' | tr '\n' ' ')
  (cd "$REPO" && env $unset_args NODE_OPTIONS=--max-old-space-size=2560 \
     timeout "$ITER_TIMEOUT" nice -n 5 claude -p "$PROMPT" \
       --dangerously-skip-permissions --output-format stream-json --verbose) >"$out" 2>&1
  rc=$?
  log "iteration $iter exit=$rc"

  # Usage / rate limit → sleep until reset (epoch in "limit reached|<epoch>" if present), else 30 min.
  if tail -c 4000 "$out" | grep -qiE 'usage limit|rate.?limit|limit reached|overloaded|429'; then
    reset=$(grep -oE 'limit reached\|[0-9]{10}' "$out" | tail -1 | cut -d'|' -f2)
    now=$(date +%s)
    if [ -n "${reset:-}" ] && [ "$reset" -gt "$now" ]; then wait_s=$((reset-now+120)); else wait_s=1800; fi
    log "limit hit, sleeping ${wait_s}s"
    sleep "$wait_s"
    continue
  fi

  after=$(sha256sum "$STATE" | cut -d' ' -f1)
  if [ "$before" = "$after" ]; then
    stall=$((stall+1))
    log "no STATE change (stall $stall/$MAX_STALL)"
    if [ "$stall" -ge "$MAX_STALL" ]; then
      python3 - "$STATE" <<'PY'
import json,sys,datetime
p=sys.argv[1]; s=json.load(open(p)); s["status"]="stalled"
s["updated_at"]=datetime.datetime.utcnow().isoformat()+"Z"; json.dump(s,open(p,"w"),indent=2)
PY
      echo "- $(date -Is) driver: $MAX_STALL итераций без прогресса, остановлено. Логи: $LOGS" >>"$WORK/ASK-FIRST.md"
      log "stalled"; exit 2
    fi
    sleep 300
  else
    stall=0
    sleep 30
  fi
done
