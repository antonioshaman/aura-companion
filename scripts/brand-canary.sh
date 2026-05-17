#!/usr/bin/env bash
# scripts/brand-canary.sh
# Brand-replacement canary for the Aura Companion documentation rebrand.
#
# Enforces spec success metric SM1: "Zero 'Vibe Companion' / 'Vibe-Companion'
# strings outside MIT-attribution lines and branding.config.json's protected
# paths."
#
# Two checks:
#   1) Negative canary: any "Vibe Companion" or "Vibe-Companion" match outside
#      the path-exclude list AND the per-line allowlist = fail.
#   2) Positive canary: the README MIT attribution sentence MUST remain present.
#      Stripping it would breach the upstream MIT license; this promotes that
#      obligation from reviewer-memory to grep-enforced.
#
# Also reports (but does not fail on) landing-only "The-Vibe-Company"
# hrefs — these are a separate spec concern (SM3) and the report makes drift
# visible without coupling the SM1 gate to SM3 noise.
#
# Exit codes:
#   0  SM1 holds; MIT attribution present
#   1  unexpected "Vibe Companion" / "Vibe-Companion" match(es) outside allowlist
#   2  README MIT attribution line missing
#
# Run from any cwd inside the repo:
#   bash scripts/brand-canary.sh

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

# SM1 pattern — strict scope.
PATTERN_SM1='Vibe[ -]Companion'

# SM3 report-only pattern — landing surface only.
PATTERN_SM3='The-Vibe-Company'

# Path excludes for SM1. Mirrors branding.config.json#protectedPaths plus
# upstream-sync archaeology (CHANGELOG-upstream.md, .github CI workflows
# referencing upstream Docker registry paths).
declare -a EXCLUDES=(
  ':(exclude).git'
  ':(exclude)node_modules' ':(exclude)*/node_modules'
  ':(exclude)*/dist' ':(exclude)*/build' ':(exclude)*/coverage'
  ':(exclude)*.lockb' ':(exclude)*.lock' ':(exclude)package-lock.json'
  ':(exclude)bun.log' ':(exclude)*/bun.log'
  ':(exclude)CHANGELOG.md' ':(exclude)web/CHANGELOG.md' ':(exclude)CHANGELOG-upstream.md'
  ':(exclude)release-please-config.json' ':(exclude).release-please-manifest.json'
  ':(exclude)branding.config.json'
  ':(exclude)PLAN-upstream-sync.md' ':(exclude)specs/upstream-sync.md'
  # Specs describing the rebrand legitimately quote the patterns as their
  # subject matter. Excluding the rebrand spec file itself preserves the
  # canary's signal while avoiding a meta-loop.
  ':(exclude)specs/aura-documentation-rebrand.md'
  ':(exclude)aura' ':(exclude)docs/aura'
  ':(exclude).agents'
  ':(exclude).learnings'
  ':(exclude).council'
  ':(exclude)CLAUDE.md'
  ':(exclude)SELF-LEARNING.md'
  ':(exclude)web/CODEX_MAPPING.md'
  ':(exclude)web/scripts/apply-aura-branding.ts'
  ':(exclude)web/scripts/apply-aura-branding.test.ts'
  ':(exclude)web/scripts/aura-drift-check.ts'
  ':(exclude)web/scripts/aura-drift-check.test.ts'
  ':(exclude)web/server/aura-watchlist-guard.test.ts'
  ':(exclude)web/server/aura-knowledge-guard.test.ts'
  ':(exclude)web/server/aura-skill-collision.test.ts'
  ':(exclude)web/server/protocol'
  ':(exclude)web/server/recorder.ts'
  ':(exclude)web/server/recorder.test.ts'
  ':(exclude)web/server/replay.ts'
  ':(exclude)web/server/replay.test.ts'
  ':(exclude)web/server/service.ts'
  ':(exclude)web/server/update-checker.ts'
  ':(exclude)web/server/update-checker.test.ts'
  ':(exclude).github'
  ':(exclude)web/docker'
  ':(exclude)*/__fixtures__' ':(exclude)*/__snapshots__' ':(exclude)*.snap'
  ':(exclude)*.jsonl'
  ':(exclude)*.png' ':(exclude)*.jpg' ':(exclude)*.jpeg'
  ':(exclude)*.gif' ':(exclude)*.ico' ':(exclude)*.webp'
  ':(exclude)*.woff' ':(exclude)*.woff2' ':(exclude)*.ttf' ':(exclude)*.eot'
  ':(exclude)*.mp3' ':(exclude)*.mp4' ':(exclude)*.wav'
  # This canary itself contains the literal patterns it scans for.
  ':(exclude)scripts/brand-canary.sh'
)

# Per-line allowlist for SM1: matches on these specific (file, stable-substring)
# pairs are intentional and allowed. Adding to this list = explicit decision.
declare -a ALLOWLIST=(
  # MIT attribution paragraph in README — required by the upstream license.
  "README.md|Aura Companion is a fork of"
  "README.md|nikolaiklein/Vibe-Companion"
)

raw_matches=$(git grep -nE "$PATTERN_SM1" -- . "${EXCLUDES[@]}" 2>/dev/null || true)

leaked=""
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  allowed=0
  for entry in "${ALLOWLIST[@]}"; do
    f="${entry%%|*}"
    sub="${entry#*|}"
    if [[ "$line" == "$f:"* && "$line" == *"$sub"* ]]; then
      allowed=1
      break
    fi
  done
  if [[ "$allowed" == "0" ]]; then
    leaked+="$line"$'\n'
  fi
done <<< "$raw_matches"

# Positive-presence canary: the README MIT attribution sentence MUST exist.
if ! grep -qF "Aura Companion is a fork of [\`The-Vibe-Company/companion\`]" README.md; then
  echo "CANARY FAIL [positive]: README.md is missing the MIT attribution line." >&2
  echo "  Expected substring: 'Aura Companion is a fork of [\`The-Vibe-Company/companion\`]'" >&2
  exit 2
fi

if [[ -n "$leaked" ]]; then
  count=$(printf '%s' "$leaked" | grep -c '^' || true)
  echo "CANARY FAIL [SM1 negative]: $count unexpected 'Vibe Companion' match(es) outside the allowlist:" >&2
  printf '%s' "$leaked" >&2
  exit 1
fi

# SM3 report-only check: landing-site Nav + Footer must not link to upstream.
sm3_matches=$(git grep -nE "$PATTERN_SM3" -- 'landing/src/components/Nav.tsx' 'landing/src/components/Footer.tsx' 2>/dev/null || true)
if [[ -n "$sm3_matches" ]]; then
  echo "CANARY WARN [SM3 report-only]: landing Nav/Footer still references upstream:" >&2
  printf '%s\n' "$sm3_matches" >&2
fi

echo "CANARY OK [SM1]: no unexpected 'Vibe Companion' strings; MIT attribution present."
