#!/usr/bin/env bash
set -u

API="${AURA_API:-http://127.0.0.1:3456/api}"
ORCH_SESSION_ID="${ORCH_SESSION_ID:-e3c30725-4b97-49d4-933c-0be3ba19646c}"
OBSERVER_SESSION_ID="${OBSERVER_SESSION_ID:-eaef74e6-ab7d-4a14-a36e-e7f6aa101bf3}"
CODEX_SESSION_ID="${CODEX_SESSION_ID:-59131133-0cca-4c9a-9bcc-749b3501c550}"
RAPID_DRAIN_DELTA="${RAPID_DRAIN_DELTA:-5}"
LOG_DIR="${LOG_DIR:-/root/aura-companion/.scheduled}"
LOG_FILE="$LOG_DIR/codex-supervise-after-limit-reset-$(date -u +%Y%m%dT%H%M%SZ).log"

mkdir -p "$LOG_DIR"
exec >>"$LOG_FILE" 2>&1

echo "[$(date -u --iso-8601=seconds)] starting Codex-only delayed supervision"
ORCH_RESUME_SENT=0
CLAUDE_KILLED_FOR_DRAIN=0
USAGE_BEFORE=""
USAGE_AFTER=""

post_json() {
  local path="$1"
  local json="$2"
  curl -sS -X POST "$API$path" \
    -H 'Content-Type: application/json' \
    --data-binary "$json"
}

json_for_content() {
  CONTENT="$1" python3 - <<'PY'
import json
import os
print(json.dumps({"content": os.environ["CONTENT"]}, ensure_ascii=False))
PY
}

relaunch_session() {
  local sid="$1"
  echo "[$(date -u --iso-8601=seconds)] relaunch $sid"
  post_json "/sessions/$sid/relaunch" '{}' || true
  echo
}

kill_session() {
  local sid="$1"
  echo "[$(date -u --iso-8601=seconds)] kill $sid"
  post_json "/sessions/$sid/kill" '{}' || true
  echo
}

send_message() {
  local sid="$1"
  local content="$2"
  local body
  body="$(json_for_content "$content")"
  echo "[$(date -u --iso-8601=seconds)] message $sid"
  post_json "/sessions/$sid/message" "$body" || true
  echo
}

five_hour_utilization() {
  local sid="$1"
  local usage_json
  usage_json="$(curl -sS "$API/sessions/$sid/usage-limits" || true)"
  USAGE_JSON="$usage_json" python3 - <<'PY'
import json
import os
import sys

try:
    data = json.loads(os.environ["USAGE_JSON"])
    print(float(data["five_hour"]["utilization"]))
except Exception as exc:
    print(f"usage-parse-failed: {exc}", file=sys.stderr)
    sys.exit(1)
PY
}

claude_limit_available() {
  local usage_json
  usage_json="$(curl -sS "$API/sessions/$ORCH_SESSION_ID/usage-limits" || true)"
  USAGE_JSON="$usage_json" python3 - <<'PY'
import datetime as dt
import json
import os
import sys

try:
    data = json.loads(os.environ["USAGE_JSON"])
    five = data["five_hour"]
    utilization = float(five["utilization"])
    resets_at_raw = five.get("resets_at")
    now = dt.datetime.now(dt.timezone.utc)
    resets_at = None
    if isinstance(resets_at_raw, str) and resets_at_raw:
        resets_at = dt.datetime.fromisoformat(resets_at_raw.replace("Z", "+00:00"))
except Exception as exc:
    print(f"usage-parse-failed: {exc}")
    sys.exit(1)

print(f"five_hour.utilization={utilization} resets_at={resets_at_raw}")
if utilization >= 95:
    sys.exit(1)
if resets_at is not None and now < resets_at:
    sys.exit(1)
PY
}

ORCH_PROMPT='Продолжай после reset лимита, но в режиме минимального расхода.

Жёсткие ограничения:
- НЕ запускай Task/subagents/background agents.
- НЕ включай auto-proceed и не делай циклы самопродолжения.
- НЕ буди observer и НЕ создавай council checkpoints без крайней необходимости.
- НЕ делай web/network.
- НЕ push.
- Сначала прочитай локальный контекст: git status, HEAD, последние логи around rate_limit, текущий diff.
- Если снова видишь 429/session limit/out of credits — сразу остановись и напиши короткий отчёт, не ретраь и не делай fallback.

Задача:
1. Продолжи только минимально необходимую работу после коммита `75e2845 fix(server): pause automation on API limits`.
2. Доделай безопасные локальные проверки/fixes без fan-out.
3. В конце создай `SESSION-AUTO-RESUME-REPORT.md`: что сделано, какие проверки прошли, что осталось проверить пользователю вечером.

Работай как один агент и экономь лимит.'

CODEX_PROMPT='Ты Codex supervisor после reset окна Claude-лимита.

Контекст:
- Claude orchestrator session: e3c30725-4b97-49d4-933c-0be3ba19646c
- Claude observer session: eaef74e6-ab7d-4a14-a36e-e7f6aa101bf3
- Emergency fix уже закоммичен: 75e2845 fix(server): pause automation on API limits
- Этот one-shot script мог отправить ОДНО guarded сообщение в Claude orchestrator, только если usage endpoint показал five_hour.utilization < 95. Проверь лог `.scheduled/codex-supervise-after-limit-reset-*.log`, чтобы понять, ушло ли сообщение.
- Если script увидел быстрый расход Claude 5h usage (>=5 процентных пунктов за 30 секунд или итог >=95%), он уже должен был вызвать `/kill` для orchestrator и observer. Проверь это по логу.
- Пользователь вечером проверит результаты вручную.

Жёсткие запреты:
- НЕ отправляй дополнительные сообщения в Claude sessions.
- НЕ вызывай /relaunch для Claude sessions.
- НЕ запускай subagents/background agents.
- НЕ push.
- НЕ делай дополнительных действий, которые могут вызвать Claude API usage.

Твоя задача:
1. Сразу проверь состояние Aura Companion: git status, HEAD, live server process.
2. Проверь usage endpoint для Claude orchestrator и observer; запиши five_hour.utilization/resets_at.
3. Проверь последние логи за период после delayed resume: Model fallback/rate_limit/Backend silent/auto-proceed/observer wake.
4. Если видишь свежий rate_limit или рост к 100% — считай Claude работу остановленной, не ретраь, напиши отчёт.
5. Если Claude был остановлен из-за быстрого расхода, проведи системный анализ причины. Используй `/council-review-aura`, если он доступен в этой сессии; если нет — используй доступный `/council-review`/локальный code review без вызова Claude. Цель: найти, какие цепочки могли снова жечь лимит (auto-proceed, model fallback, observer wake, subagents, relaunch loop).
6. Внеси только рекомендованные и безопасные локальные правки, которые не требуют Claude API, с targeted tests. Не делай большие рефакторы и не push.
7. Если Claude начал работать нормально, наблюдай локально максимально экономно: читай логи/diff/тесты, но НЕ отправляй дополнительные Claude сообщения.
8. Проверь незакоммиченные файлы и старые артефакты; не удаляй их.
9. Подготовь отчёт `CODEX-SUPERVISOR-AUTO-RESUME.md`:
   - что уже закоммичено;
   - текущее состояние Claude pair;
   - ушло ли guarded resume-сообщение;
   - usage после запуска;
   - был ли rapid-drain kill;
   - есть ли признаки нового каскада/лимита;
   - какие системные причины найдены и какие безопасные правки внесены;
   - можно ли вечером вручную отправить resume в Claude;
   - точная рекомендуемая первая фраза для Claude, если лимит восстановился;
   - что НЕ делать, чтобы не сжечь лимит снова.

Работай экономно и без фан-аута.'

if claude_limit_available; then
  echo "[$(date -u --iso-8601=seconds)] Claude five-hour window looks available; sending exactly one guarded resume message"
  USAGE_BEFORE="$(five_hour_utilization "$ORCH_SESSION_ID" || echo "")"
  echo "[$(date -u --iso-8601=seconds)] usage before Claude resume: ${USAGE_BEFORE:-unknown}"
  send_message "$ORCH_SESSION_ID" "$ORCH_PROMPT"
  ORCH_RESUME_SENT=1
else
  echo "[$(date -u --iso-8601=seconds)] Claude five-hour window still unavailable or unverifiable; NOT touching Claude"
fi

if [ "$ORCH_RESUME_SENT" -eq 1 ]; then
  echo "[$(date -u --iso-8601=seconds)] waiting 30s before Codex supervision"
  sleep 30
  USAGE_AFTER="$(five_hour_utilization "$ORCH_SESSION_ID" || echo "")"
  echo "[$(date -u --iso-8601=seconds)] usage 30s after Claude resume: ${USAGE_AFTER:-unknown}"
  if USAGE_BEFORE="$USAGE_BEFORE" USAGE_AFTER="$USAGE_AFTER" RAPID_DRAIN_DELTA="$RAPID_DRAIN_DELTA" python3 - <<'PY'
import os
import sys

try:
    before = float(os.environ["USAGE_BEFORE"])
    after = float(os.environ["USAGE_AFTER"])
    delta = after - before
except Exception:
    sys.exit(1)

print(f"usage_delta={delta}")
if after >= 95 or delta >= float(os.environ["RAPID_DRAIN_DELTA"]):
    sys.exit(0)
sys.exit(1)
PY
  then
    echo "[$(date -u --iso-8601=seconds)] rapid Claude usage drain detected; killing Claude pair"
    kill_session "$ORCH_SESSION_ID"
    kill_session "$OBSERVER_SESSION_ID"
    CLAUDE_KILLED_FOR_DRAIN=1
  else
    echo "[$(date -u --iso-8601=seconds)] no rapid Claude usage drain detected"
  fi
fi

relaunch_session "$CODEX_SESSION_ID"
sleep 15
send_message "$CODEX_SESSION_ID" "$CODEX_PROMPT"

echo "[$(date -u --iso-8601=seconds)] Codex-only delayed supervision dispatched"
