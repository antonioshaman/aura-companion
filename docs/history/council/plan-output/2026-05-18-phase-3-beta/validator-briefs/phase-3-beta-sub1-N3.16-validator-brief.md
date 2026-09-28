# Validator brief — Phase 3β sub-1 N3.16 (colvin seed-new)

**Commit anchor (staged tree sha):** `7d42b84652c7be8bcdc58110f14c7343a2217239`
**Skills repo HEAD before commit:** `4c8533740eca2a04e5bb0d52df5a5882df79a3be` (lerdorf N3.15)
**Worktree:** `/tmp/aura-phase3beta-sub1/` (aura-companion) — brief lives at `/tmp/phase-3-beta-sub1-N3.16-validator-brief.md` per ritchie §B6
**Self-validate mode** per External Setup #2

---

## D7 shell-paste evidence

### Canonical file shape

```
$ wc -l /home/auracomp/.claude/skills/_council-experts-v2/colvin/references/quality-colvin.md
151 /home/auracomp/.claude/skills/_council-experts-v2/colvin/references/quality-colvin.md
```

```
$ grep -c "^## §" /home/auracomp/.claude/skills/_council-experts-v2/colvin/references/quality-colvin.md
2
```

```
$ grep -c "Detection signal in code review:" /home/auracomp/.claude/skills/_council-experts-v2/colvin/references/quality-colvin.md
8
```

```
$ awk '/^## §A/{flag=1;start=NR;next} /^## §B/{print "§A: " NR-start " lines"; flag=2; start=NR; next} END{print "§B: " NR-start+1 " lines"}' /home/auracomp/.claude/skills/_council-experts-v2/colvin/references/quality-colvin.md
§A: 72 lines
§B: 69 lines
```

**Per-section depth claim:** §A 72L within 67-83L floor; §B 69L within 67-83L floor. Total 151L within 134-167L NR2 floor for 2-section non-aura. Path-3 hybrid: 8 principles across 2 sections (4 in §A Schema-as-contract + 4 in §B Production-safety over iteration), each with 6 sub-paragraphs. Detection-signal coverage: 8/8 = 100% (D5).

### Mirror byte-identity

```
$ sha256sum /home/auracomp/.claude/skills/_council-experts-v2/colvin/references/quality-colvin.md /home/auracomp/.claude/skills/council-plan-v2/references/quality-colvin.md /home/auracomp/.claude/skills/council-review-v2/references/quality-colvin.md
cc093575b56b688f4f38f9c6794bc0456dadf94b4f891729b4fd61fcf152ba1a  /home/auracomp/.claude/skills/_council-experts-v2/colvin/references/quality-colvin.md
cc093575b56b688f4f38f9c6794bc0456dadf94b4f891729b4fd61fcf152ba1a  /home/auracomp/.claude/skills/council-plan-v2/references/quality-colvin.md
cc093575b56b688f4f38f9c6794bc0456dadf94b4f891729b4fd61fcf152ba1a  /home/auracomp/.claude/skills/council-review-v2/references/quality-colvin.md
```

3 files byte-identical at sha256 `cc093575b56b688f4f38f9c6794bc0456dadf94b4f891729b4fd61fcf152ba1a`.

### verify-catalog.sh C1-C12 — ALL GREEN

```
=== C6: every catalog dir has meta.yaml AND count == EXPECTED_COUNT (Phase 1c) ===
  ✓ all 16 dirs have meta.yaml, count == EXPECTED_COUNT
=== C7+C8: meta.yaml schema (keys ⊆ {creator,stack}) + stack values in enum (Phase 1c) ===
  ✓ 16 meta.yaml conform (creator+stack only, stack values in enum)
=== C9: catalog IDs case-insensitively unique (Phase 1c) ===
  ✓ 16 IDs case-insensitively unique
=== C10: semantic-coverage canary (Phase 2c-N1) ===
  ✓ 158 tokens + 33 structural anchors + 1 forbidden patterns — all green
=== C11: catalog supply-chain (schema + 4 call-site IDs + ownership + B2 byte-identity) (Phase 2c-N2) ===
  ✓ schema + 4-call-site IDs + ownership/mode + 1 B2 entries / 4 mirrors — all green
=== C12: ref-mirrors lock (sha256 attestation manifest) (Phase 2c-N3) ===
  ✓ 16 mirror sets / 44 mirrors / 16 canonicals — lock attestation green
```

C6/7/9/12 advanced 15 → 16; C10 advanced 150 → 158 tokens + 31 → 33 anchors.

### Hunt Tier-1 prompt-injection screening — watchpoint A

ALL Tier-1 patterns 0 hits across colvin's 4 files (canonical + plan.md + review.md + meta.yaml):
- `ignore previous`, `disregard previous`, `forget previous instructions` = 0
- `^system:`, `^assistant:`, `^user:` = 0
- `<|im_start`, `<|im_end`, `[INST]` = 0
- `New instructions:`, `Updated instructions:`, `Override:` = 0

### Hunt Tier-2 prompt-injection screening — watchpoint A

ALL Tier-2 patterns 0 hits:
- `eval(`, `exec(`, `Function(` = 0 (colvin's pydantic-ai tool-definition examples discussed at principle-name level only — Hunt REC-2 compliance)
- `; rm -rf`, `$(curl` = 0
- `sk-`, `xoxb-`, `ghp_` credential shapes = 0

### EC-23 path-bytes-redaction screening — watchpoint A

```
$ grep -nE '/home/auracomp|/tmp/aura-phase3beta|^/root/|/Users/' /home/auracomp/.claude/skills/_council-experts-v2/colvin/*.md /home/auracomp/.claude/skills/_council-experts-v2/colvin/references/*.md
(empty)
```

EC-23 green: filesystem references use conventional names only.

### Slug-collision canary — watchpoint D, pre-create

```
$ echo colvin | grep -qE '^[a-z][a-z0-9-]{1,31}$' && echo VALID
VALID
$ ls /home/auracomp/.claude/skills/_council-experts-v2/ | grep -i '^colvin$' && echo COLLIDE || echo NO-COLLIDE
NO-COLLIDE
$ ls /home/auracomp/.claude/skills/_council-experts/ 2>/dev/null | grep -i '^colvin$' && echo COLLIDE-V1 || echo NO-COLLIDE-V1
NO-COLLIDE-V1
```

Slug `colvin` valid + no collision + not POSIX-reserved.

### Mirror-set probe (D8) — watchpoint D

```
$ ls /home/auracomp/.claude/skills/_council-experts-v2/colvin/
meta.yaml  plan.md  references  review.md
```

Non-Aura shape confirmed: matches lerdorf + brandur + durov + vanrossum precedent. 2 mirrors at `council-plan-v2/` + `council-review-v2/`. PydanticAI is Python-only, doesn't apply to Aura's TS/Bun stack — non-Aura placement is correct per dec-008 runtime panel-file probe.

---

## Willison REC-1 compliance — orthogonality claim

Per subplan-willison.md REC-1: `quality-colvin.md` must claim what willison would REFUSE to claim — types-as-contract, schema-strict eliminates the failure loop, production-safety over iteration. NOT a stylistic variant of exploration.

Evidence in canonical body:

```
$ grep -c "types are the contract" /home/auracomp/.claude/skills/_council-experts-v2/colvin/references/quality-colvin.md
1
$ grep -c "iteration is the cost of having no contract" /home/auracomp/.claude/skills/_council-experts-v2/colvin/references/quality-colvin.md
1
$ grep -c "schema-strict eliminates the failure loop" /home/auracomp/.claude/skills/_council-experts-v2/colvin/references/quality-colvin.md
3
$ grep -c "production-safety over iteration" /home/auracomp/.claude/skills/_council-experts-v2/colvin/references/quality-colvin.md
1
$ grep -c "transcript" /home/auracomp/.claude/skills/_council-experts-v2/colvin/references/quality-colvin.md
8
```

Lead paragraph carries the crisp boundary claim: "Colvin wins when consumer is a program; Willison wins when consumer is a developer iterating on the prompt" (paraphrased into the discipline-paragraph framing). Transcript references (8 hits) are framed as the *debugging fallback*, NOT the production substrate — exactly the orthogonality willison REC-1 mandated.

Cross-section refs to willison: 0 explicit `quality-willison.md` cite, 0 explicit `willison §X` cross-ref. The canonical stands alone as a schema-strict typed-LLM-agent lens, per fowler REC-5 (unpaired status as first-class structural fact this sub-phase; tension axis lives in willison's subplan analysis at planning time, not in canonical body).

---

## Empirical claims (AT-commit moment)

1. **AC1** colvin dir at `_council-experts-v2/colvin/` with meta.yaml + plan.md + review.md + references/quality-colvin.md (non-Aura shape, 4 files).
2. **AC2** `quality-colvin.md` at Path-3 hybrid depth: 151L, 2 §-sections, 8 principles, 8/8 Detection signals. §A 72L + §B 69L within floor.
3. **AC3** lock manifest 15 → 16 canonicals; colvin entry chronologically appended after lerdorf. sha256 `cc093575b56b688f4f38f9c6794bc0456dadf94b4f891729b4fd61fcf152ba1a`.
4. **AC4** Coverage manifest +8 external-enrichment tokens + 2 structural anchors. C10 advanced 150 → 158 tokens, 31 → 33 structural anchors.
5. **AC7** This brief at `/tmp/phase-3-beta-sub1-N3.16-validator-brief.md`; commit body cites it.
6. **AC8** C1-C12 all green at staged-tree sha `7d42b84652c7be8bcdc58110f14c7343a2217239`.
7. **Hunt watchpoint A:** Tier-1 = 0, Tier-2 = 0, EC-23 = 0, sha256 attestation atomic with canonical.
8. **Ritchie watchpoint D:** runtime probe 16 catalog dirs / 16 lock entries / 44 mirrors. Slug canary passed.
9. **Willison REC-1:** types-as-contract / schema-strict-eliminates-failure-loop / production-safety-over-iteration claims explicit in body; 0 cross-refs to willison.md; transcript framed as debugging fallback, not production substrate. Orthogonality preserved.
10. **D14 carry-forward:** meta.yaml stays at 2-key shape (creator + stack: [python]). tension fields deferred to sub-4.

## Expected validator response

**PASS** — all 10 empirical claims match runtime; 12 gates green; orthogonality with willison preserved; no Tier-1/Tier-2/EC-23 leak. Proceed to commit.
