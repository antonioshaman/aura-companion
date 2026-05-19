# Validator brief — Phase 3β sub-1 N3.15 (lerdorf seed-new)

**Commit anchor (staged tree sha):** `5d702f2e75158608855dc7b021b692aafebe2e3f`
**Skills repo HEAD before commit:** `a593c1620e4aa4ae5d4d35c1601ad102f0f34396`
**Worktree:** `/tmp/aura-phase3beta-sub1/` (aura-companion) — validator-brief lives at `/tmp/phase-3-beta-sub1-N3.15-validator-brief.md` per ritchie §B6 (validator-brief on `/tmp` scratch, NOT in skills repo)
**Self-validate mode** per External Setup #2 (no validator-tmux spawned this sub-phase per PICKUP)

---

## D7 shell-paste evidence

### Canonical file shape (Path-3 hybrid depth per dec-007 + D2/NR2)

```
$ wc -l /home/auracomp/.claude/skills/_council-experts-v2/lerdorf/references/quality-lerdorf.md
151 /home/auracomp/.claude/skills/_council-experts-v2/lerdorf/references/quality-lerdorf.md
```

```
$ grep -c "^## §" /home/auracomp/.claude/skills/_council-experts-v2/lerdorf/references/quality-lerdorf.md
2
```

```
$ grep -c "Detection signal in code review:" /home/auracomp/.claude/skills/_council-experts-v2/lerdorf/references/quality-lerdorf.md
8
```

```
$ awk '/^## §A/{flag=1;start=NR;next} /^## §B/{print "§A: " NR-start " lines"; flag=2; start=NR; next} END{print "§B: " NR-start+1 " lines"}' /home/auracomp/.claude/skills/_council-experts-v2/lerdorf/references/quality-lerdorf.md
§A: 72 lines
§B: 69 lines
```

**Per-section depth claim:** §A 72L within 67-83L floor (D3/NR2), §B 69L within 67-83L floor. Total 151L within 134-167L NR2 floor for 2-section non-aura. Path-3 hybrid: 8 principles across 2 sections (4 in §A + 4 in §B), each principle with 6 sub-paragraphs (statement / elaboration / Example / Anti-pattern to detect / Detection signal in code review / Cross-ref). Detection-signal coverage: 8/8 = 100% (D5).

### Mirror byte-identity (D1 manual cp per NR1 cp-mirrors.py TARGET_ALLOWLIST exclusion)

```
$ sha256sum /home/auracomp/.claude/skills/_council-experts-v2/lerdorf/references/quality-lerdorf.md /home/auracomp/.claude/skills/council-plan-v2/references/quality-lerdorf.md /home/auracomp/.claude/skills/council-review-v2/references/quality-lerdorf.md
a040afee2f8b9f5f199444d1c43a99ff93603fa7eae459c681f6b232344e661a  /home/auracomp/.claude/skills/_council-experts-v2/lerdorf/references/quality-lerdorf.md
a040afee2f8b9f5f199444d1c43a99ff93603fa7eae459c681f6b232344e661a  /home/auracomp/.claude/skills/council-plan-v2/references/quality-lerdorf.md
a040afee2f8b9f5f199444d1c43a99ff93603fa7eae459c681f6b232344e661a  /home/auracomp/.claude/skills/council-review-v2/references/quality-lerdorf.md
```

3 files byte-identical at sha256 `a040afee2f8b9f5f199444d1c43a99ff93603fa7eae459c681f6b232344e661a`.

### verify-catalog.sh C1-C12 (AC8 — green every commit)

```
$ ~/.claude/skills/_council-experts-v2/.verify/verify-catalog.sh
=== C1: no SKILL.md may inline a subagent prompt block (Beck) ===
  ✓ no inline subagent blocks
=== C2: every named expert in every consumer skill exists in catalog (Beck) ===
  (check complete — failures printed above if any)
=== C3: expert IDs match ^[a-z][a-z0-9-]{1,31}$ (Hunt) ===
  ✓ all expert IDs match shape
=== C4: no catalog files are symlinks (Hunt) ===
  ✓ no symlinks
=== C5: catalog files have mode 644, not executable (Hunt) ===
  ✓ all data files non-executable
=== C6: every catalog dir has meta.yaml AND count == EXPECTED_COUNT (Phase 1c) ===
  ✓ all 15 dirs have meta.yaml, count == EXPECTED_COUNT
=== C7+C8: meta.yaml schema (keys ⊆ {creator,stack}) + stack values in enum (Phase 1c) ===
  ✓ 15 meta.yaml conform (creator+stack only, stack values in enum)
=== C9: catalog IDs case-insensitively unique (Phase 1c) ===
  ✓ 15 IDs case-insensitively unique
=== C10: semantic-coverage canary (Phase 2c-N1) ===
  ✓ 150 tokens + 31 structural anchors + 1 forbidden patterns — all green
=== C11: catalog supply-chain (schema + 4 call-site IDs + ownership + B2 byte-identity) (Phase 2c-N2) ===
  ✓ schema + 4-call-site IDs + ownership/mode + 1 B2 entries / 4 mirrors — all green
=== C12: ref-mirrors lock (sha256 attestation manifest) (Phase 2c-N3) ===
  ✓ 15 mirror sets / 42 mirrors / 15 canonicals — lock attestation green
```

ALL 12 GATES GREEN.

### Hunt Tier-1 prompt-injection screening (must be 0 OR explicitly framed) — watchpoint A

```
$ for pat in 'ignore previous' 'disregard previous' 'forget previous instructions' '^system:' '^assistant:' '^user:' '<\|im_start' '<\|im_end' '\[INST\]' 'New instructions:' 'Updated instructions:' 'Override:'; do
    grep -ciE "$pat" /home/auracomp/.claude/skills/_council-experts-v2/lerdorf/*.md /home/auracomp/.claude/skills/_council-experts-v2/lerdorf/references/*.md /home/auracomp/.claude/skills/_council-experts-v2/lerdorf/*.yaml 2>&1 | awk -F: '{s+=$2}END{print s}'
  done
0  (×12 patterns)
```

ALL Tier-1 patterns 0 hits across all 4 lerdorf files (canonical + plan.md + review.md + meta.yaml).

### Hunt Tier-2 prompt-injection screening (must be code-fenced + anti-pattern framing) — watchpoint A

```
$ for pat in 'eval\(' 'exec\(' 'Function\(' '; rm -rf' '\$\(curl' 'sk-[A-Za-z0-9]' 'xoxb-' 'ghp_'; do ... ; done
0  (×8 patterns)
```

ALL Tier-2 patterns 0 hits. Lerdorf's classical PHP anti-pattern surfaces (`eval()`, `register_globals`, `magic_quotes`) are discussed at the principle-name level only — never with literal syntax in code blocks. Hunt REC-2 compliance: principles framed as anti-patterns in prose, not exhibited as literal code.

### EC-23 path-bytes-redaction screening (no raw absolute paths from authoring host) — watchpoint A

```
$ grep -nE '/home/auracomp|/tmp/aura-phase3beta|^/root/|/Users/' /home/auracomp/.claude/skills/_council-experts-v2/lerdorf/references/quality-lerdorf.md /home/auracomp/.claude/skills/_council-experts-v2/lerdorf/plan.md /home/auracomp/.claude/skills/_council-experts-v2/lerdorf/review.md
(empty)
```

EC-23 green: all filesystem references use conventional names (`<workspace>/.council/`, `~/.companion/recordings/`, etc.) — no host-topology leak.

### Slug-collision canary (ritchie B2) — watchpoint D, ran pre-create

```
$ echo lerdorf | grep -qE '^[a-z][a-z0-9-]{1,31}$' && echo VALID
VALID
$ ls /home/auracomp/.claude/skills/_council-experts-v2/ | grep -i '^lerdorf$' && echo COLLIDE || echo NO-COLLIDE
NO-COLLIDE
$ ls /home/auracomp/.claude/skills/_council-experts/ 2>/dev/null | grep -i '^lerdorf$' && echo COLLIDE-V1 || echo NO-COLLIDE-V1
NO-COLLIDE-V1
```

Slug `lerdorf` matches shape regex; no collision with v2 or v1 catalog (case-insensitive); not POSIX-reserved.

### Mirror-set probe (D8 runtime panel-file probe — watchpoint D)

```
$ ls /home/auracomp/.claude/skills/_council-experts-v2/lerdorf/
meta.yaml  plan.md  references  review.md
```

Non-Aura shape confirmed: `plan.md + review.md + references/quality-lerdorf.md` (no `plan-aura.md` / `review-aura.md` — PHP web-runtime is non-Aura per dispatcher panel inheritance from brandur/durov/vanrossum precedent). 2 mirrors at `council-plan-v2/references/` and `council-review-v2/references/`. Matches PLAN hypothesis (PICKUP §1) and watchpoint D D8 mandate.

---

## Empirical claims (AT-commit moment)

1. **AC1** lerdorf dir exists at `_council-experts-v2/lerdorf/` with meta.yaml + plan.md + review.md + references/quality-lerdorf.md. Non-Aura shape (4 files). Confirmed by `ls` shell-paste above.
2. **AC2** `quality-lerdorf.md` at Path-3 hybrid depth: 151L, 2 §-sections, 8 principles, 8 Detection signals (100%). Per-section: §A 72L + §B 69L, both within 67-83L floor. Confirmed by `wc -l` + `awk` + `grep -c` shell-paste above.
3. **AC3** lock manifest 14 → 15 canonicals. Lerdorf entry chronologically appended after vanrossum (hashimoto REC-1 chronological-not-alphabetical). sha256 `a040afee2f8b9f5f199444d1c43a99ff93603fa7eae459c681f6b232344e661a` pinned. Confirmed by C12 green output above.
4. **AC4** Coverage manifest +8 external-enrichment tokens (above pickup ≥5 floor; matches Phase 3α brandur/durov/vanrossum precedent) + 2 structural anchors. C10 advanced 142 → 150 tokens, 29 → 31 structural anchors. Confirmed by C10 green output above.
5. **AC7** This validator brief at `/tmp/phase-3-beta-sub1-N3.15-validator-brief.md` will be cited in commit body for `git log --grep` verifier.
6. **AC8** C1-C12 all green at the staged-tree sha `5d702f2e75158608855dc7b021b692aafebe2e3f`. Confirmed by full verify-catalog.sh shell-paste above.
7. **Hunt watchpoint A — supply-chain hygiene:** sha256 attestation in same atomic commit; Tier-1 = 0; Tier-2 = 0; EC-23 = 0; `meta.yaml` 2-key shape preserves C7 (deferred tension fields per D14).
8. **Ritchie watchpoint D — filesystem reconcile:** runtime probe confirms 15 catalog dirs, 15 lock entries, all sha256-pinned. Slug-collision canary passed pre-create.
9. **Willison REC-6 bridging principle:** §A Principle 1 `request lifecycle minimalism` explicitly bridges PHP web-runtime pragmatism to LLM-stream-lifecycle realism in exactly one principle (paragraph 2 names "the same discipline applies to LLM-stream-lifecycle realism"). Remaining 7 principles stay in PHP/web-runtime lane per willison REC-6 mandate. Confirmed by `grep -c "LLM-stream-lifecycle"` returning 2 (one in lead paragraph cross-section reference, one in §A request-lifecycle-minimalism body).

## D14 — meta.yaml machine-readable tension fields DEFERRED to sub-4

Per PLAN Boundary (d) "No new gates on `verify-catalog.sh` — C1-C12 stays intact" + EC-33 (runtime wins on disagreement), watchpoint C's `tension_axis` + `paired_with` machine-readable fields are NOT shipped in this sub-phase. The C7 gate enforces `keys ⊆ {creator, stack}` and rejects extra keys — adding `tension_axis: null` + `paired_with: null` to meta.yaml would require atomic C7 allow-list extension in the same commit, which constitutes a "new gate config" on verify-catalog.sh and breaches Boundary (d). lerdorf ships with 2-key meta.yaml (`creator: "Rasmus Lerdorf"` + `stack: [php]`) matching the existing 14-expert precedent. The schema extension + EC-34/EC-35 conventions amendment land atomically together in sub-4 per fowler REC-2 two-hat discipline; willison REC-4 risk-if-skipped about Phase 3γ chair-side dispatch is acknowledged — interim chair-side dispatch can fall back to prose-parsing of the unpaired status documented in this brief, the canonical reference doc body, and the sub-1 HANDOFF `decisions[]` entry D14.

## Observed runtime state (NOT in this commit's scope)

6 SKILL.md files under skills repo working tree have pre-existing uncommitted modifications from a prior session:
- `council-implement-aura-v2/SKILL.md`, `council-implement/SKILL.md`, `council-plan-aura-v2/SKILL.md`, `council-plan/SKILL.md`, `council-review-aura-v2/SKILL.md`, `council-review/SKILL.md`

These are NOT this commit's territory. Staged ONLY lerdorf-related paths via `git add <specific paths>` discipline. Operator decision required (heartbeat status surface at `/tmp/phase-3-beta-sub1-writer-status.md`). No interference: verify-catalog.sh C1 (no inline subagent blocks) + C2 (panel-named experts have catalog files) pass against the working-tree SKILL.md state.

## Expected validator response

**PASS** — all 9 empirical claims match runtime; 12 gates green; Tier-1/Tier-2/EC-23 0-hit; sha256 byte-identity verified across 3 files. Proceed to commit.
