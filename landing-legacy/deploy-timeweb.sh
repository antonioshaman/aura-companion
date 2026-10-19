#!/usr/bin/env bash
# deploy-timeweb.sh — publish landing-legacy/site to auraco.space on the RU Timeweb edge.
#
# Why Timeweb, not Cloudflare: TSPU freezes RU->foreign TCP connections after
# ~16KB, so CSS/images from a CF edge never finish loading for users in Russia
# (see specs/ru-origin-tspu-hosting-v1.md and the global CLAUDE.md rule).
# auraco.space moved off the `auraco` Worker on 2026-10-17. The Worker still
# exists for PREVIEWS only (`bunx wrangler@3 versions upload` -> preview URL);
# never `wrangler deploy` / re-attach the custom domain.
#
# Usage: landing-legacy/deploy-timeweb.sh          (from the repo root or anywhere)
#        DRY_RUN=1 landing-legacy/deploy-timeweb.sh
set -euo pipefail

HOST_ALIAS="${HOST_ALIAS:-rapesha-timeweb}"   # ssh alias for the Timeweb box
RU_IP="91.222.236.11"
# Every RU-facing hostname of the project: the landing AND the app entry
# point (Timeweb reverse proxy -> Aura app over Tailscale).
DOMAINS=(auraco.space www.auraco.space app.auraco.space)
REMOTE_DIR="/var/www/auraco.space"
SITE_DIR="$(cd "$(dirname "$0")" && pwd)/site"

# 1. DNS gate: every RU-facing hostname must resolve at the AUTHORITATIVE NS to
#    the RU IP only (no Cloudflare proxy, no geo-split foreign leg).
NS="$(dig +short NS auraco.space | head -1)"
[[ -n "$NS" ]] || { echo "DNS gate: cannot find NS for auraco.space" >&2; exit 1; }
for d in "${DOMAINS[@]}"; do
  got="$(dig +short A "$d" @"$NS" | sort | tr '\n' ' ' | sed 's/ $//')"
  aaaa="$(dig +short AAAA "$d" @"$NS" | tr '\n' ' ')"
  if [[ "$got" != "$RU_IP" || -n "$aaaa" ]]; then
    echo "DNS gate FAILED: $d -> A='$got' AAAA='$aaaa' at $NS (want A=$RU_IP only, DNS-only, no AAAA)" >&2
    exit 1
  fi
done
echo "DNS gate ok: ${DOMAINS[*]} -> $RU_IP"

# 2. Upload.
[[ -f "$SITE_DIR/index.html" ]] || { echo "missing $SITE_DIR/index.html" >&2; exit 1; }
if [[ "${DRY_RUN:-0}" == "1" ]]; then
  rsync -an --delete --itemize-changes "$SITE_DIR/" "$HOST_ALIAS:$REMOTE_DIR/"
  exit 0
fi
rsync -a --delete "$SITE_DIR/" "$HOST_ALIAS:$REMOTE_DIR/"

# 2b. Fresh release badge data. The page reads same-origin /release.json (a
#     browser fetch to api.github.com would hit the TSPU freeze in Russia);
#     the server side here can reach GitHub, so stamp the latest release.
if rel="$(gh api repos/antonioshaman/aura-companion/releases/latest \
      --jq '{tag: .tag_name, version: (.tag_name | sub("^aura-companion-v"; "")), url: .html_url, published_at: .published_at}' 2>/dev/null)" \
   && [[ "$rel" == *'"version"'* ]]; then
  printf '%s\n' "$rel" | ssh "$HOST_ALIAS" "cat > '$REMOTE_DIR/release.json'"
  echo "release.json: $rel"
else
  echo "release.json: GitHub unreachable, keeping the committed copy" >&2
fi

# 2c. npm downloads for the footer counter: same-origin /downloads.json, for the
#     same TSPU reason. Also refreshed daily from the auracomp crontab.
"$(dirname "$0")/refresh-npm-downloads.sh"

# 3. Verify the live origin serves exactly what we shipped.
want="$(sha256sum "$SITE_DIR/index.html" | cut -d' ' -f1)"
have="$(curl -fsS --resolve "auraco.space:443:$RU_IP" https://auraco.space/ | sha256sum | cut -d' ' -f1)"
[[ "$want" == "$have" ]] || { echo "verify FAILED: live index.html differs from site/index.html" >&2; exit 1; }
code="$(curl -s -o /dev/null -w '%{http_code}' https://auraco.space/)"
[[ "$code" == "200" ]] || { echo "verify FAILED: https://auraco.space/ -> $code" >&2; exit 1; }
echo "deployed: https://auraco.space/ (index sha256 $want)"
