#!/usr/bin/env bash
# Task 0 (PLAN-aura-gonka-option-d.md) — go/no-go validation of the Gonka chain.
# Verifies, bottom-up: shim reachable -> LiteLLM reachable -> Anthropic->OpenAI
# translation reaches Gonka -> the Claude CLI honors ANTHROPIC_BASE_URL.
#
# Usage:  LITELLM_MASTER_KEY=sk-... ./validate-task0.sh
# Env (with defaults):
#   SHIM_URL=http://127.0.0.1:8080  LITELLM_URL=http://127.0.0.1:4000
#   MODEL=gonka-qwen                LITELLM_MASTER_KEY=<required>
set -uo pipefail

SHIM_URL="${SHIM_URL:-http://127.0.0.1:8080}"
LITELLM_URL="${LITELLM_URL:-http://127.0.0.1:4000}"
MODEL="${MODEL:-gonka-qwen}"
KEY="${LITELLM_MASTER_KEY:-}"
pass() { printf '  \033[32mPASS\033[0m %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAILED=1; }
FAILED=0

echo "== 1. Shim /health =="
if curl -fsS "$SHIM_URL/health" >/dev/null 2>&1; then pass "shim up at $SHIM_URL"; else fail "shim not reachable at $SHIM_URL (start gonka-shim)"; fi

echo "== 2. Bind is loopback-only =="
if command -v ss >/dev/null 2>&1; then
  for p in 8080 4000; do
    line="$(ss -tlnp 2>/dev/null | grep -E "[.:]$p " || true)"
    if [ -z "$line" ]; then echo "  (port $p not listening yet)"; \
    elif echo "$line" | grep -qE '127\.0\.0\.1:'"$p"'|\[::1\]:'"$p"; then pass "port $p bound to loopback"; \
    else fail "port $p is NOT loopback-only: $line"; fi
  done
else echo "  (ss unavailable — skip bind check)"; fi

echo "== 3. LiteLLM liveness =="
if curl -fsS "$LITELLM_URL/health/liveliness" >/dev/null 2>&1; then pass "litellm up at $LITELLM_URL"; else fail "litellm not reachable at $LITELLM_URL"; fi

if [ -z "$KEY" ]; then fail "LITELLM_MASTER_KEY not set — cannot test the authed path"; fi

echo "== 4. Anthropic->OpenAI->Gonka translation (the load-bearing hop) =="
if [ -n "$KEY" ]; then
  body='{"model":"'"$MODEL"'","max_tokens":32,"messages":[{"role":"user","content":"Reply with the single word: pong"}]}'
  resp="$(curl -fsS -X POST "$LITELLM_URL/v1/messages" \
    -H "content-type: application/json" -H "x-api-key: $KEY" -H "anthropic-version: 2023-06-01" \
    -d "$body" 2>/dev/null)"
  if [ -n "$resp" ] && echo "$resp" | grep -qi 'content\|text'; then
    pass "round-trip returned content"; echo "  response (truncated): $(echo "$resp" | head -c 240)"
  else
    fail "no usable response from /v1/messages — check GONKA_* and the endpoint"
  fi
fi

echo
echo "== 5. THE ACTUAL TASK-0 CHECK: run the Claude CLI against this endpoint =="
echo "  Set these and run one tool-using turn:"
echo "    export ANTHROPIC_BASE_URL=$LITELLM_URL"
echo "    export ANTHROPIC_AUTH_TOKEN=\$LITELLM_MASTER_KEY"
echo "    claude --model $MODEL -p 'Read package.json and tell me the version'"
echo "  GO if: the model calls the Read tool and returns the version."
echo "  NO-GO if: the CLI rejects the base URL / never emits a tool call."
echo
if [ "$FAILED" -eq 0 ]; then printf '\033[32mPre-checks passed.\033[0m Proceed to step 5.\n'; else printf '\033[31mPre-checks failed.\033[0m Fix the above before step 5.\n'; exit 1; fi
