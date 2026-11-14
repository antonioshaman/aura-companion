#!/bin/bash
# Re-runnable proof behind PROVEN_STATUS_PROBE_VERSIONS (server/auth-status/provider-probes.ts):
# does `claude auth status` / `codex login status` refresh or write credentials when the
# access token is EXPIRED?  Synthetic credentials only (generated here, never copied), an
# isolated HOME (mktemp -d), no network namespace (bwrap --unshare-net), strace for connect
# attempts and credential-file writes, and a dev/ino/size/mtime/sha snapshot before/after.
# Needs: bwrap, strace. Prints the CLI versions and UNCHANGED/CHANGED; append a version to
# the proven table only when every check is clean.
set -u
H=$(mktemp -d)
trap 'rm -rf "$H"' EXIT
mkdir -p "$H/.claude" "$H/.codex"
NOW=$(date +%s%3N)
b64() { printf '%s' "$1" | base64 -w0 | tr '+/' '-_' | tr -d '='; }
HDR=$(b64 '{"alg":"none","typ":"JWT"}')
EXP=$(( $(date +%s) - 86400*30 ))
CLAIMS=$(b64 "{\"exp\":$EXP,\"email\":\"synthetic@example.invalid\",\"https://api.openai.com/auth\":{\"chatgpt_plan_type\":\"plus\"}}")
printf '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-SYNTHETIC","refreshToken":"sk-ant-ort01-SYNTHETIC","expiresAt":%s,"scopes":["user:inference","user:profile"],"subscriptionType":"pro"}}\n' "$((NOW-86400000))" > "$H/.claude/.credentials.json" # aura-check: ignore[secrets.in-file] synthetic SYNTHETIC tokens, never real
printf '{"auth_mode":"chatgpt","OPENAI_API_KEY":null,"tokens":{"id_token":"%s","access_token":"%s","refresh_token":"SYNTHETIC","account_id":"synthetic"},"last_refresh":"%s"}\n' \
  "$HDR.$CLAIMS.c2ln" "$HDR.$CLAIMS.c2ln" "$(date -u -d '30 days ago' +%Y-%m-%dT%H:%M:%SZ)" > "$H/.codex/auth.json"
echo '{"hasCompletedOnboarding":true}' > "$H/.claude.json"
snap() { for f in "$H/.claude/.credentials.json" "$H/.codex/auth.json"; do echo "$(stat -c '%d %i %s %Y' "$f") $(sha256sum < "$f" | cut -c1-16)"; done; }
BEFORE=$(snap)
echo "claude $(claude --version 2>/dev/null) / codex $(codex --version 2>/dev/null)"
for cmd in "claude auth status" "codex login status"; do
  strace -f -qq -o "$H/trace" -e trace=connect,openat,rename,renameat,renameat2 \
    bwrap --dev-bind / / --unshare-net --setenv HOME "$H" \
      --unsetenv CLAUDE_CODE_OAUTH_TOKEN --unsetenv ANTHROPIC_API_KEY --unsetenv OPENAI_API_KEY --unsetenv CODEX_HOME \
      -- $cmd >/dev/null 2>&1
  echo "== $cmd: exit=$? non-DNS inet connects=$(grep -E 'connect\(.*AF_INET' "$H/trace" | grep -vc 'htons(53)') credential writes=$(grep -cE "(credentials|auth\.json).*O_(WRONLY|RDWR|CREAT)|rename.*(credentials|auth\.json)" "$H/trace")"
done
[ "$BEFORE" = "$(snap)" ] && echo "UNCHANGED" || echo "CHANGED"
