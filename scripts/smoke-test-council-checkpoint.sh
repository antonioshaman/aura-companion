#!/usr/bin/env bash
# Smoke test for PR #10 — POST /api/sessions/:id/council/checkpoint
#
# End-to-end verification:
#   1) create a Council pair on /root/aura-companion workspace
#   2) POST a CheckpointPayload to the new producer endpoint
#   3) verify the file landed at .council/checkpoints/<phase>.json
#   4) verify the observer wakes and emits .council/reviews/<phase>-claude-observer.md
#
# Run AFTER `systemctl restart aura-companion` once the new code is on disk.
# Idempotent — safe to re-run (uses a unique phase name per invocation).

set -euo pipefail

API="${API:-http://localhost:3456/api}"
WORKSPACE="${WORKSPACE:-/root/aura-companion}"
PHASE="${PHASE:-smoke-$(date +%s)}"
PAIRING="${PAIRING:-claude+claude}"

echo "==> Smoke test config"
echo "    API       = $API"
echo "    WORKSPACE = $WORKSPACE"
echo "    PHASE     = $PHASE"
echo "    PAIRING   = $PAIRING"
echo

echo "==> Probing API"
if ! curl -fsS "$API/sessions" >/dev/null 2>&1; then
  echo "FAIL: API at $API not responding" >&2
  exit 1
fi

if [ ! -f "$WORKSPACE/.council/prompts/observer-system.md" ]; then
  echo "FAIL: $WORKSPACE/.council/prompts/observer-system.md missing — observer cannot spawn" >&2
  exit 1
fi

echo "==> Creating Council pair (pairing=$PAIRING, cwd=$WORKSPACE)"
CREATE_BODY=$(WORKSPACE="$WORKSPACE" PAIRING="$PAIRING" python3 -c '
import json, os
print(json.dumps({"councilMode":"council","councilPairing":os.environ["PAIRING"],"cwd":os.environ["WORKSPACE"]}))
')
CREATE_RES=$(curl -fsS -X POST "$API/sessions/create" \
  -H "Content-Type: application/json" \
  -d "$CREATE_BODY")

read -r GROUP_ID ORCH_ID OBS_ID <<<"$(CREATE_RES="$CREATE_RES" python3 -c '
import json, os
r = json.loads(os.environ["CREATE_RES"])
print(r.get("sessionGroupId",""), r.get("primary",{}).get("sessionId",""), r.get("observer",{}).get("sessionId",""))
')"
if [ -z "$GROUP_ID" ] || [ "$GROUP_ID" = "null" ]; then
  echo "FAIL: createCouncilGroup did not return sessionGroupId" >&2
  echo "$CREATE_RES" >&2
  exit 1
fi
echo "    GROUP_ID = $GROUP_ID"
echo "    ORCH_ID  = $ORCH_ID"
echo "    OBS_ID   = $OBS_ID"

echo "==> Waiting up to 30s for observer-half WS backend adapter attach (state=connected)"
# Observer is `-p` non-interactive — won't emit `cliSessionId` until it
# receives its first input (the wake frame). So we can't gate on
# cliSessionId here. We CAN gate on state="connected", which the bridge
# flips after the adapter attaches (see ws-bridge.ts `Backend adapter
# attached` log line — it precedes the state flip).
HANDSHAKE_OK="0"
for i in $(seq 1 30); do
  STATE_JSON=$(curl -fsS "$API/sessions/$OBS_ID" 2>/dev/null || true)
  HANDSHAKE_OK=$(STATE_JSON="$STATE_JSON" python3 -c '
import json, os
try:
  r = json.loads(os.environ.get("STATE_JSON","") or "null")
  print("1" if isinstance(r, dict) and r.get("state") == "connected" else "0")
except Exception:
  print("0")
')
  if [ "$HANDSHAKE_OK" = "1" ]; then
    echo "==> Observer state=connected after ${i}s"
    break
  fi
  sleep 1
done
if [ "$HANDSHAKE_OK" != "1" ]; then
  echo "FAIL: observer-half did not reach state=connected within 30s" >&2
  echo "$STATE_JSON" >&2
  exit 1
fi
# Small extra cushion: even after state=connected, the bridge needs a
# tick to register the adapter in its map under load. 2s is well under
# the prior race (adapter attach happened ~1s after spawn in logs).
sleep 2

mkdir -p "$WORKSPACE/.council/test-artifacts"
ART_FILE="$WORKSPACE/.council/test-artifacts/$PHASE.md"
printf 'Smoke artifact for phase %s\nNo real review content — just a path the observer can read.\n' "$PHASE" > "$ART_FILE"

EMITTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
ART_REL=".council/test-artifacts/$PHASE.md"
PAYLOAD=$(PHASE="$PHASE" GROUP_ID="$GROUP_ID" EMITTED_AT="$EMITTED_AT" ART_REL="$ART_REL" python3 -c '
import json, os
print(json.dumps({
  "schema_version": 1,
  "checkpoint_id": "ckpt-" + os.environ["PHASE"],
  "phase": os.environ["PHASE"],
  "sequence": 0,
  "session_group_id": os.environ["GROUP_ID"],
  "emitted_at": os.environ["EMITTED_AT"],
  "artifact_paths": [os.environ["ART_REL"]],
}))
')

echo "==> POST checkpoint"
echo "    payload = $PAYLOAD"
POST_RES=$(curl -fsS -X POST "$API/sessions/$ORCH_ID/council/checkpoint" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD")
echo "    response = $POST_RES"

WRITTEN=$(POST_RES="$POST_RES" python3 -c 'import json,os; print(json.loads(os.environ["POST_RES"]).get("written",""))')
if [ -z "$WRITTEN" ] || [ "$WRITTEN" = "null" ]; then
  echo "FAIL: response missing .written" >&2
  exit 1
fi

if [ ! -f "$WRITTEN" ]; then
  echo "FAIL: response said written=$WRITTEN but file is not on disk" >&2
  exit 1
fi
echo "==> Checkpoint file present: $WRITTEN"

REVIEW="$WORKSPACE/.council/reviews/$PHASE-claude-observer.md"
echo "==> Waiting up to 60s for observer review: $REVIEW"
for i in $(seq 1 60); do
  if [ -f "$REVIEW" ]; then
    echo "==> Observer review appeared after ${i}s"
    echo "    head:"
    head -c 800 "$REVIEW" | sed 's/^/      /'
    echo
    echo "==> SMOKE TEST PASS — orchestrator-half POST -> observer review round-tripped end-to-end"
    echo "GROUP_ID=$GROUP_ID"
    echo "ORCH_ID=$ORCH_ID"
    echo "OBS_ID=$OBS_ID"
    echo "CHECKPOINT=$WRITTEN"
    echo "REVIEW=$REVIEW"
    exit 0
  fi
  sleep 1
done

echo "FAIL: observer review $REVIEW did not appear within 60s" >&2
echo "    Diagnostics:" >&2
echo "    .council/checkpoints/:" >&2
ls -la "$WORKSPACE/.council/checkpoints/" >&2 || true
echo "    .council/reviews/:" >&2
ls -la "$WORKSPACE/.council/reviews/" >&2 || true
echo "    journalctl tail:" >&2
journalctl -u aura-companion -n 50 --no-pager 2>&1 | grep -iE "(observer|wake|checkpoint|group)" >&2 || true
exit 1
