#!/usr/bin/env bash
# Smoke-test the Aura server image (PLAN-aura-uiux-agent-enrichment Task 9; CI job
# `docker`). Fails unless the image:
#   - has python3, node, bun, claude and codex on PATH (skill scripts + sessions),
#   - boots and answers /health,
#   - installed the shipped skill pack at boot (~/.companion/skill-pack/current.json),
#   - reports the toolkit as installed, with taste-skill listed, Claude able to take
#     it (--plugin-dir supported) and no missing runtime.
# The container is removed on exit, and its log is printed for diagnosis.
#
#   bash scripts/docker-smoke.sh <image>
set -euo pipefail

IMAGE="${1:?usage: docker-smoke.sh <image>}"
NAME="aura-smoke-$$"
PORT="${SMOKE_PORT:-3456}"
TOKEN="docker-smoke-token-0123456789abcdef"

cleanup() {
  echo "── container log ──" >&2
  docker logs "$NAME" >&2 2>&1 | tail -40 || true
  docker rm -f "$NAME" >/dev/null 2>&1 || true
}

echo "== runtimes"
docker run --rm --entrypoint sh "$IMAGE" -c 'python3 --version && node --version && bun --version && claude --version && codex --version'

echo "== boot"
trap cleanup EXIT
docker run -d --name "$NAME" -p "127.0.0.1:${PORT}:3456" -e COMPANION_AUTH_TOKEN="$TOKEN" "$IMAGE" >/dev/null
for _ in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS "http://127.0.0.1:${PORT}/health"
echo

echo "== skill pack installed at boot"
docker exec "$NAME" sh -c 'test -f "$HOME/.companion/skill-pack/current.json" && cat "$HOME/.companion/skill-pack/current.json"'
echo

echo "== Settings view of the toolkit"
curl -fsS -H "Authorization: Bearer ${TOKEN}" "http://127.0.0.1:${PORT}/api/settings/skill-pack" | python3 -c '
import json, sys
v = json.load(sys.stdin)
assert v.get("installed") is True, v
names = [r["name"] for r in v["rows"]]
assert "taste-skill" in names, names
assert not v.get("claudeUnavailable"), v["claudeUnavailable"]
assert not v.get("missingRuntimes"), v["missingRuntimes"]
provided = [r["name"] for r in v["rows"] if r["claude"]["outcome"] == "provide"]
assert "taste-skill" in provided, provided
print("toolkit OK:", len(names), "entries; Claude gets", ", ".join(provided))
'
echo "docker-smoke OK"
