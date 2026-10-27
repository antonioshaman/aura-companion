#!/usr/bin/env bash
# verify-catalog.sh — Beck grep canaries C1–C2, Chair C6 + C13, Fowler semantic
# coverage C10, Willison citation resolution C14, Hunt defences C3–C5, mirror
# attestation C11–C12.
# Exits 0 on all green, 1 on any violation.
#
# Run from anywhere; uses script-relative paths.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
CATALOG="$(dirname "$HERE")"
SKILLS="$(dirname "$CATALOG")"
ERR=0

DISPATCHERS="council-plan council-plan-aura council-review council-review-aura council-implement council-implement-aura"
# RC-2: dispatchers no longer declare a fixed `### Council panel` block — the
# roster is selected adaptively from capability profiles (selection-engine.md),
# so C2 walks the catalog (capability universe), not per-skill panels.

# Every directory holding attested/injected reference docs: the catalog canonicals
# plus each dispatcher's mirrors. C4/C5 previously searched only the catalog, which
# is under a third of the surface.
SEARCH_DIRS="$CATALOG"
for s in $DISPATCHERS; do
  [ -d "$SKILLS/$s/references" ] && SEARCH_DIRS="$SEARCH_DIRS $SKILLS/$s/references"
done

# ── P0: the tree these canaries claim to inspect must actually be there ────────
# Without this, a moved/renamed catalog makes "found no violations" and "could not
# look" indistinguishable, and three canaries report clean against an absent tree.
echo "=== P0: catalog resolves and is non-empty (preflight) ==="
if [ ! -d "$CATALOG" ]; then
  echo "  ✗ catalog directory does not exist: $CATALOG"
  exit 1
fi
N_EXPERTS=$(find "$CATALOG" -mindepth 1 -maxdepth 1 -type d ! -name '.*' | wc -l)
if [ "$N_EXPERTS" -eq 0 ]; then
  echo "  ✗ catalog contains no expert directories: $CATALOG"
  exit 1
fi
echo "  ✓ catalog at $CATALOG — $N_EXPERTS expert directories"

echo "=== C1: no SKILL.md may inline a subagent prompt block (Beck) ==="
C1_SCANNED=0
C1_HITS=""
for s in $DISPATCHERS; do
  f="$SKILLS/$s/SKILL.md"
  [ -f "$f" ] || continue
  C1_SCANNED=$((C1_SCANNED + 1))
  if grep -q "^### Subagent " "$f"; then
    C1_HITS="$C1_HITS$f
"
  fi
done
if [ "$C1_SCANNED" -eq 0 ]; then
  echo "  ✗ no dispatcher SKILL.md files found under $SKILLS — nothing was checked"
  ERR=1
elif [ -n "$C1_HITS" ]; then
  echo "  ✗ inline subagent blocks found in:"
  printf '%s' "$C1_HITS" | sed 's/^/    /'
  ERR=1
else
  echo "  ✓ no inline subagent blocks ($C1_SCANNED dispatchers scanned)"
fi

echo "=== C2: candidate universe = catalog dirs with a capability profile; orphan sweep (RC-2) ==="
# RC-2 deletes the fixed `### Council panel` bullet lists — the roster is selected
# adaptively from each advisor's `capabilities` profile (selection-engine.md), so
# the catalog IS the panel. c2-capability-universe.py adjudicates both directions
# the old inline C2 + C2b did, keyed on capability profiles instead of a bullet
# list: universe non-empty + every member dispatchable (has a phase doc), and every
# catalog dir either seatable or recorded in unseated.allow (no orphans, no stale or
# contradictory allow entries).
if [ ! -f "$HERE/c2-capability-universe.py" ]; then
  echo "  ✗ $HERE/c2-capability-universe.py is missing — cannot verify the candidate universe"
  ERR=1
elif python3 "$HERE/c2-capability-universe.py"; then
  :
else
  ERR=1
fi

echo "=== C6: no dispatcher asserts a fixed panel size (Chair, RC-2 adaptive roster) ==="
if [ ! -f "$HERE/c6-panel-count.py" ]; then
  echo "  ✗ $HERE/c6-panel-count.py is missing — cannot verify panel-size claims"
  ERR=1
else
  # 1 = a surviving fixed-panel-size claim (the roster is adaptive, so any fixed
  # count is provably wrong); 2 = the checker could not look (missing SKILL.md).
  # All six dispatchers are scanned — a fixed count anywhere is a defect.
  # First pin the regex coverage (leak + false-positive directions, hashimoto #2)
  # so a future edit that re-opens either fails here, not silently in production.
  if ! python3 "$HERE/c6-panel-count.py" --selftest; then
    ERR=1
  fi
  if python3 "$HERE/c6-panel-count.py" "$SKILLS" $DISPATCHERS; then
    :
  else
    ERR=1
  fi
fi

echo "=== C10: merged docs still carry each source expert's tokens (Fowler) ==="
if [ ! -f "$HERE/c10-coverage.py" ]; then
  echo "  ✗ $HERE/c10-coverage.py is missing — cannot verify semantic coverage"
  ERR=1
else
  # 1 = a token/anchor/forbidden assertion failed; 2 = the checker could not look
  # (missing or unparseable ground truth, missing search path). Both are failures.
  if python3 "$HERE/c10-coverage.py"; then
    :
  else
    ERR=1
  fi
fi

echo "=== C13: implement skills carry a usable row for every seat their planner dispatches (Chair) ==="
if [ ! -f "$HERE/c13-implement-parity.py" ]; then
  echo "  ✗ $HERE/c13-implement-parity.py is missing — cannot verify plan→implement parity"
  ERR=1
else
  # 1 = a seat has no usable row, or a row names a missing/malformed doc; 2 = the
  # checker could not look (missing SKILL.md, unfindable table, zero rows/seats).
  if python3 "$HERE/c13-implement-parity.py"; then
    :
  else
    ERR=1
  fi
fi

echo "=== C14: every reference citation is anchored to its dispatcher and resolves (Willison #1) ==="
if [ ! -f "$HERE/c14-citation-resolution.py" ]; then
  echo "  ✗ $HERE/c14-citation-resolution.py is missing — cannot verify citation resolution"
  ERR=1
else
  # 1 = a citation is unanchored, anchored to the wrong stack, or dangles without
  # a marker; 2 = the checker could not look (missing catalog, zero phase files,
  # zero citations extracted). Both are failures; only 0 is green.
  if python3 "$HERE/c14-citation-resolution.py"; then
    :
  else
    ERR=1
  fi
fi

echo "=== C3: expert IDs match ^[a-z][a-z0-9-]{1,31}$ (Hunt) ==="
C3_ERR=0
C3_N=0
# -mindepth/-maxdepth rather than a glob: a glob does not match dotted names, so a
# hidden expert directory was previously exempt from ID-shape checking entirely.
while IFS= read -r d; do
  eid=$(basename "$d")
  [ "$eid" = ".verify" ] && continue
  C3_N=$((C3_N + 1))
  if ! echo "$eid" | grep -qE '^[a-z][a-z0-9-]{1,31}$'; then
    echo "  ✗ invalid expert ID: $eid"
    C3_ERR=1
  fi
done < <(find "$CATALOG" -mindepth 1 -maxdepth 1 -type d)
# Success line lives inside the guard: it used to print unconditionally, so a run
# that reported violations also claimed all IDs matched.
if [ "$C3_ERR" -eq 0 ]; then
  echo "  ✓ all $C3_N expert IDs match shape"
else
  ERR=1
fi

echo "=== C4: no catalog or mirror files are symlinks (Hunt) ==="
SYMLINKS=$(find $SEARCH_DIRS -type l)
if [ $? -ne 0 ]; then
  echo "  ✗ symlink scan failed over: $SEARCH_DIRS"
  ERR=1
elif [ -n "$SYMLINKS" ]; then
  echo "  ✗ symlinks found:"
  echo "$SYMLINKS" | sed 's/^/    /'
  ERR=1
else
  echo "  ✓ no symlinks ($(echo $SEARCH_DIRS | wc -w) directories scanned)"
fi

echo "=== C5: catalog and mirror data files are non-executable and not group/world-writable (Hunt) ==="
BAD_MODE=$(find $SEARCH_DIRS -type f \( -perm -u+x -o -perm -g+x -o -perm -o+x -o -perm -g+w -o -perm -o+w \) ! -name '*.sh' ! -name '*.py')
if [ $? -ne 0 ]; then
  echo "  ✗ mode scan failed over: $SEARCH_DIRS"
  ERR=1
elif [ -n "$BAD_MODE" ]; then
  echo "  ✗ executable or group/world-writable bit on data files:"
  echo "$BAD_MODE" | sed 's/^/    /'
  ERR=1
else
  echo "  ✓ all data files non-executable and not group/world-writable"
fi

echo "=== C11: references/ mirrors are byte-identical to their canonical (Hunt REC-7) ==="
if [ ! -f "$HERE/cp-mirrors.py" ]; then
  echo "  ✗ $HERE/cp-mirrors.py is missing — cannot verify mirror byte-identity"
  ERR=1
elif python3 "$HERE/cp-mirrors.py" --check; then
  :
else
  ERR=1
fi

echo "=== C12: canonical + mirror sha256 match the pinned lock manifest (Hunt REC-7) ==="
if [ ! -f "$HERE/verify-lock.py" ]; then
  echo "  ✗ $HERE/verify-lock.py is missing — cannot verify the lock manifest"
  ERR=1
elif python3 "$HERE/verify-lock.py"; then
  :
else
  ERR=1
fi

echo "=== C15: capability profiles are schema-valid against the closed vocabulary (RC-2, hashimoto D1+D2) ==="
if [ ! -f "$HERE/c15-capabilities.py" ]; then
  echo "  ✗ $HERE/c15-capabilities.py is missing — cannot verify capability profiles"
  ERR=1
elif python3 "$HERE/c15-capabilities.py"; then
  :
else
  ERR=1
fi

# The runner previously communicated its verdict only through the exit status,
# so an operator scanning the transcript for check marks saw a wall of green on a
# failing run. Say it in words.
echo "==="
if [ "$ERR" -eq 0 ]; then
  echo "RESULT: PASS — all canaries green"
else
  echo "RESULT: FAIL — at least one canary reported a violation (see ✗ lines above)"
fi

exit $ERR
