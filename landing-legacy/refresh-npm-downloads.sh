#!/usr/bin/env bash
# refresh-npm-downloads.sh — publish the npm "downloads in the last 30 days" count
# for aura-companion to auraco.space/downloads.json on the RU Timeweb edge.
#
# The landing footer reads it same-origin: a browser fetch to api.npmjs.org would
# hit the TSPU freeze in Russia, while this server can reach npm. Runs from
# deploy-timeweb.sh and daily from the auracomp crontab on the prod box. If npm
# fails or answers nonsense, the live file is left as it is.
#
# Usage: landing-legacy/refresh-npm-downloads.sh
set -euo pipefail

HOST_ALIAS="${HOST_ALIAS:-rapesha-timeweb}"   # ssh alias for the Timeweb box
REMOTE_DIR="/var/www/auraco.space"
PKG="aura-companion"

raw="$(curl -fsS --max-time 20 "https://api.npmjs.org/downloads/point/last-month/$PKG")" || {
  echo "downloads.json: npm unreachable, keeping the live copy" >&2; exit 0; }

# Keep only what the page needs; refuse anything that isn't a sane count.
json="$(printf '%s' "$raw" | python3 -c '
import json, sys
d = json.load(sys.stdin)
n = d.get("downloads")
if not isinstance(n, int) or isinstance(n, bool) or n < 0:
    sys.exit(1)
print(json.dumps(dict(downloads=n, start=d.get("start"), end=d.get("end"), package=d.get("package"))))
')" || { echo "downloads.json: unexpected npm response, keeping the live copy" >&2; exit 0; }

# Write-then-rename so the page never reads a half-written file.
printf '%s\n' "$json" | ssh "$HOST_ALIAS" "cat > '$REMOTE_DIR/downloads.json.tmp' && mv '$REMOTE_DIR/downloads.json.tmp' '$REMOTE_DIR/downloads.json'"
echo "downloads.json: $json"
