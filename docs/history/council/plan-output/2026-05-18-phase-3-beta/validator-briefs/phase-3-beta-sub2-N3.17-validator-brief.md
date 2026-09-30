# Validator brief — commit N3.17 verify-catalog.sh C7 schema extension for EC-34 wire-format

**Topic:** Extend C7 inline-python schema validator in `_council-experts-v2/.verify/verify-catalog.sh` to allow `meta.yaml` keys `{creator, stack, paired_with?, tension_axis?}` (the latter two optional, shape-validated). Resolves D14↔PICKUP-sub-2 conflict surface per writer-status heartbeat.

**Atomicity:** Standalone commit. No expert content changes. No other gates changed. Existing 16 meta.yaml files (which all ship at 2-key shape) remain green after this extension because optional-field-absent is valid.

## D7 shell-paste evidence (pre-commit)

```
$ wc -l ~/.claude/skills/_council-experts-v2/.verify/verify-catalog.sh
401 verify-catalog.sh
```

(pre-edit; post-edit count will land in commit body)

```
$ grep -n "extra = keys - " ~/.claude/skills/_council-experts-v2/.verify/verify-catalog.sh
128:    extra = keys - {"creator", "stack"}
```

Single allowlist site; edit-surface = lines 127-141 (the inline python `for f in files` validator block in C7).

```
$ ls ~/.claude/skills/_council-experts-v2/ | grep -v ^README | grep -v ^\\. | wc -l
16
```

16 catalog dirs at sub-1 close — matches EXPECTED_COUNT=16 (line 20 of verify-catalog.sh, set at sub-1 N3.16 commit).

```
$ python3 -c "
import yaml, glob, os
for f in sorted(glob.glob(os.path.expanduser('~/.claude/skills/_council-experts-v2/*/meta.yaml'))):
    d = yaml.safe_load(open(f))
    print(os.path.basename(os.path.dirname(f)), sorted(d.keys()))
"
abramov ['creator', 'stack']
beck ['creator', 'stack']
brandur ['creator', 'stack']
colvin ['creator', 'stack']
dahl ['creator', 'stack']
durov ['creator', 'stack']
fowler ['creator', 'stack']
friedman ['creator', 'stack']
hashimoto ['creator', 'stack']
hunt ['creator', 'stack']
lerdorf ['creator', 'stack']
ritchie ['creator', 'stack']
saarinen ['creator', 'stack']
vanrossum ['creator', 'stack']
watson ['creator', 'stack']
willison ['creator', 'stack']
```

All 16 existing entries at 2-key. After extension to allowlist `{creator, stack, paired_with, tension_axis}`, all 16 STILL pass because optional-absent is valid (extra-keys check `keys - allowed_set` empty).

## Edit plan (atomic, inline-python only)

Replace lines 127-130 (current):
```python
    extra = keys - {"creator", "stack"}
    if extra:
        print(f"  ✗ {eid}: extra keys not allowed: {sorted(extra)}"); err = 1
```

With (extension):
```python
    allowed = {"creator", "stack", "paired_with", "tension_axis"}
    extra = keys - allowed
    if extra:
        print(f"  ✗ {eid}: extra keys not allowed: {sorted(extra)}"); err = 1
```

Insert after stack-enum block (after line 137) the per-semantic-category validators per `feedback_validator_per_semantic_category` — paired_with treated as expert ID (same shape as C3); tension_axis treated as short claim with length bound:

```python
    # EC-34 wire-format (Phase 3β sub-2 N3.17): optional pairing fields.
    # paired_with: nullable expert-ID; same shape as C3 (`^[a-z][a-z0-9-]{1,31}$`).
    # tension_axis: nullable short claim; bounded ≤80 chars, no control chars.
    import re as _re
    if "paired_with" in keys:
        pw = d.get("paired_with")
        if pw is not None:
            if not isinstance(pw, str) or not pw.strip():
                print(f"  ✗ {eid}: paired_with must be non-empty string or null"); err = 1
            elif not _re.match(r'^[a-z][a-z0-9-]{1,31}$', pw):
                print(f"  ✗ {eid}: paired_with invalid expert-ID shape: {pw!r}"); err = 1
    if "tension_axis" in keys:
        ta = d.get("tension_axis")
        if ta is not None:
            if not isinstance(ta, str) or not ta.strip():
                print(f"  ✗ {eid}: tension_axis must be non-empty string or null"); err = 1
            elif len(ta) > 80:
                print(f"  ✗ {eid}: tension_axis too long ({len(ta)} chars > 80)"); err = 1
            elif any(ord(c) < 0x20 and c not in '\t' for c in ta):
                print(f"  ✗ {eid}: tension_axis contains control characters"); err = 1
```

Header comment block extension above line 107 (the `=== C7+C8 ===` echo) to document the new wire-format semantics — clarifies what the validator now accepts.

## Empirical claims

1. **Existing 16 meta.yaml remain green** after extension — `creator` + `stack` only is a valid subset of new allowlist; optional-absent fields trip none of the new validation branches.
2. **New 4-key meta.yaml (torvalds + unclebob, N3.18 + N3.21) will pass** the extended C7 — both will ship `paired_with: <ritchie|fowler>` (string, shape-matching) + `tension_axis: <≤80c utf8>` (string, bounded).
3. **5-key+ remains rejected** — any expert adding a 5th key still fails the `extra = keys - allowed` branch.
4. **All other gates unchanged** — C1, C2, C3, C4, C5, C6, C8 (stack-enum), C9, C10, C11, C12 are not touched. Verify-catalog.sh exit-0 contract preserved.
5. **No new dependencies** — `import re as _re` is stdlib; no `pyyaml` or other external import added; runs under same `python3 - <<PY` heredoc envelope.

## Expected validator response

PASS if the post-edit `verify-catalog.sh` exits 0 against the unchanged 16 existing meta.yaml entries AND the python-shape-test (synthetic 4-key meta.yaml constructed in-memory) passes the new branches.

FAIL with specific corrections if (a) extension breaks any existing meta.yaml, (b) shape-validators wrongly accept malformed values, (c) inline `import re` raises in any non-trivial path.

## Self-validation evidence to capture post-edit (in commit body)

- `$ wc -l ~/.claude/skills/_council-experts-v2/.verify/verify-catalog.sh` (line count delta)
- `$ ~/.claude/skills/_council-experts-v2/.verify/verify-catalog.sh` (full run, expect "PASS"-equivalent / exit 0 at C7 + green at all other gates)
- `$ python3 -c "..."` shape-canary: build synthetic 4-key dict matching torvalds, run through the same validator branch logic, assert no err

End of brief.
