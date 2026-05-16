# Council Plan (Aura): Expert References Enrichment — Phase 3α

**Scope:** 14 atomic commits in skills repo (`~/.claude/skills`, master HEAD `fd5b645`) enriching all v2 expert `references/quality-<id>.md` files from user dumps #1 + #3.
**Context:** Phase 2 closed at 2741dd3 + 9e36aa1 + 9428192 (aura-companion). Skills-repo catalog at 14 dirs, C1-C12 + cp-mirrors --check green. Phase 3α extends the existing 3 canonicals (dahl/ritchie/hashimoto) and seeds 11 new canonicals (fowler/beck/hunt/willison + 4 UI + 3 lang/platform) from external sources. Consumed by `/council-implement-aura-v2` with EC-31 per-commit validator pipeline.
**Boundaries:** No Phase 3β new experts, no Phase 3γ chair-side selection, no Phase 3-A implement-*-v2 panel cutover, no Phase 3-C topic-named-refs housekeeping. License/attribution: paraphrase concepts/tone, URLs as pointers, verbatim >50 char triggers explicit MIT/CC-BY attribution.

**Council dispatched:** Chair (Carmack) elected DIRECT synthesis without parallel expert subagent dispatch. Justification: the input spec at HEAD 9428192 is sufficiently concrete (per-expert section templates, B2 canonical-path policy, lock+manifest mechanics all spelled out) that expert subagents would ≥90% restate the spec. Carmack filter: "Don't dispatch unless they'll meaningfully alter the plan." Expert principles attributed per-task below. If during /council-implement-aura-v2 a per-commit decision needs domain push-back, dispatch that expert ad-hoc.

---

## Task Sequence

### Phase 3α₁ — Append-existing (3 commits, ~30k tokens)

#### Task 1. N1 — dahl append §Z

| | |
|---|---|
| **Domain** | dahl × Carmack — Bun/Hono runtime + NDJSON protocol discipline |
| **Strategy** | append-existing |
| **Canonical** | `council-review-aura-v2/references/quality-dahl.md` (B1, existing 481 lines) |
| **Mirrors** | `council-plan-aura-v2/...` + `council-implement-aura-v2/...` (2 existing, preserved per lock manifest) |
| **§Z content** | Sources: bun.sh, hono.dev, nodejs.org/about, github.com/ry. Principles: event-loop discipline, runtime simplicity, async boundary hygiene, NDJSON streaming, websocket fan-out, backpressure awareness, lightweight protocol design. Tone: runtime-focused, anti-bloat, low-latency pragmatism. Anti-patterns: dispatching Node-only API on Bun runtime, mixed sync/async boundary, NDJSON-framing-by-substring-search. |
| **Coverage tokens (≥5)** | `event-loop discipline`, `runtime simplicity`, `lightweight protocol`, `runtime-native performance`, `Bun.sh` (URL pointer) |
| **Lock action** | bump `canonical.sha256` |
| **Depends on** | — (first commit of Phase 3α₁) |

#### Task 2. N2 — ritchie append §Z

| | |
|---|---|
| **Domain** | ritchie × Carmack — Unix process lifecycle + filesystem persistence |
| **Strategy** | append-existing |
| **Canonical** | `council-review-aura-v2/references/quality-ritchie.md` (B1, existing 469 lines) |
| **Mirrors** | `council-plan-aura-v2/...` + `council-implement-aura-v2/...` (2 existing, preserved) |
| **§Z content** | Sources: bell-labs.com/usr/dmr, man7.org/linux/man-pages, pubs.opengroup.org, wikipedia TheCProgrammingLanguage. Principles: unix process lifecycle, stdio discipline, signal semantics, atomic file replacement, append-only logging, replay determinism, filesystem durability, text-stream interoperability. Tone: unix minimalism, composability-first, systems austerity, deterministic engineering. Anti-patterns: non-atomic file replacement, signal-as-control-channel for in-band data, append-without-fsync. |
| **Coverage tokens (≥5)** | `text-stream interoperability`, `composability-first`, `systems austerity`, `deterministic engineering`, `append-only logging` |
| **Lock action** | bump `canonical.sha256` |
| **Depends on** | Task 1 (validates append pattern + lock-bump mechanics on B1) |

#### Task 3. N3 — hashimoto append §Z

| | |
|---|---|
| **Domain** | hashimoto × Carmack — Infrastructure-as-code + supply-chain reproducibility |
| **Strategy** | append-existing |
| **Canonical** | `_council-experts-v2/hashimoto/references/quality-hashimoto.md` (B2, existing 406 lines) |
| **Mirrors** | 4 (plan-v2 + plan-aura-v2 + review-v2 + review-aura-v2, preserved per lock manifest) |
| **§Z content** | Sources: developer.hashicorp.com {terraform, vagrant, nomad, consul}. Principles: infrastructure as code, immutable infrastructure, deploy reproducibility, secrets-at-rest discipline, supervisor lifecycle awareness, graceful shutdown handling, image build determinism, operational portability. Tone: infrastructure-pragmatic, automation-heavy, deployment-safe, ops-discipline. Anti-patterns: mutable infra, secrets-in-env-var-uncyphered, supervisor-restart-loop without breaker. |
| **Coverage tokens (≥5)** | `image build determinism`, `secrets-at-rest`, `supervisor lifecycle`, `automation-heavy`, `operational portability` |
| **Lock action** | bump `canonical.sha256` |
| **Depends on** | Task 2 (validates B2 append + 4-mirror regen, more complex than B1) |

---

### Phase 3α₂-A — Seed-new domain-neutral (4 commits, ~60k tokens)

#### Task 4. N4 — fowler seed-new

| | |
|---|---|
| **Domain** | fowler × Carmack — Refactoring economics + evolutionary architecture |
| **Strategy** | seed-new-file (B2) |
| **Canonical** | `_council-experts-v2/fowler/references/quality-fowler.md` (NEW) |
| **Mirrors** | 4 (plan-v2 + plan-aura-v2 + review-v2 + review-aura-v2) |
| **§A / §B split** | §A "Refactoring economics" (economic refactoring, deviation amplification, when-to-refactor test) / §B "Architecture evolution" (strangler fig migration, feature toggles, evolutionary architecture, bounded context awareness) / §C "Code smell taxonomy" |
| **Coverage tokens (≥5)** | `economic refactoring`, `strangler fig`, `feature toggle`, `bounded context`, `code smell`, `deviation amplification`, `evolutionary architecture` |
| **Structural anchors** | `## §A Refactoring economics`, `## §B Architecture evolution`, `## §C Code smell taxonomy` |
| **Lock action** | NEW canonical entry + 4 mirror paths |
| **Depends on** | Task 3 (Phase 3α₁ closure validates B2 mechanics before fanning into 11 seed-new) |

#### Task 5. N5 — beck seed-new

| | |
|---|---|
| **Domain** | beck × Carmack — TDD discipline + small safe steps |
| **Strategy** | seed-new-file (B2) |
| **Canonical** | `_council-experts-v2/beck/references/quality-beck.md` (NEW) |
| **Mirrors** | 2 (review-v2 + review-aura-v2) |
| **§A / §B split** | §A "Test-driven discipline" (TDD microcycles, empirical test design, test infect) / §B "Small safe steps" (make-change-easy/easy-change, locality of behavior, optimistic programming) |
| **Coverage tokens (≥5)** | `TDD microcycle`, `empirical test design`, `make the change easy`, `locality of behavior`, `small safe steps`, `optimistic programming` |
| **Structural anchors** | `## §A Test-driven discipline`, `## §B Small safe steps` |
| **Lock action** | NEW canonical entry + 2 mirror paths |
| **Depends on** | Task 4 |

#### Task 6. N6 — hunt seed-new

| | |
|---|---|
| **Domain** | hunt × Carmack — Attack surface + credential hygiene |
| **Strategy** | seed-new-file (B2) |
| **Canonical** | `_council-experts-v2/hunt/references/quality-hunt.md` (NEW) |
| **Mirrors** | 4 (plan-v2 + plan-aura-v2 + review-v2 + review-aura-v2) |
| **§A / §B split** | §A "Attack surface discipline" (secure defaults, attack surface reduction, zero trust mindset) / §B "Credential & secret hygiene" (modern password storage, credential stuffing, secret leakage prevention) / §C "Breach forensics" (data breach forensics, breach-oriented thinking) |
| **Coverage tokens (≥5)** | `attack surface reduction`, `secure defaults`, `zero trust`, `modern password storage`, `credential stuffing`, `secret leakage`, `breach forensics` |
| **Structural anchors** | `## §A Attack surface discipline`, `## §B Credential & secret hygiene`, `## §C Breach forensics` |
| **Lock action** | NEW canonical entry + 4 mirror paths |
| **Depends on** | Task 5 |

#### Task 7. N7 — willison seed-new

| | |
|---|---|
| **Domain** | willison × Carmack — Prompt engineering + LLM pipeline ergonomics |
| **Strategy** | seed-new-file (B2) |
| **Canonical** | `_council-experts-v2/willison/references/quality-willison.md` (NEW) |
| **Mirrors** | 4 (plan-v2 + plan-aura-v2 + review-v2 + review-aura-v2) |
| **§A / §B split** | §A "Prompt engineering discipline" (tool-use patterns, structured outputs, prompt injection defense) / §B "Context engineering" (context packing, agent ergonomics, transcript-first debugging, local-first AI workflows) |
| **Coverage tokens (≥5)** | `tool-use patterns`, `structured outputs`, `prompt injection`, `context packing`, `transcript-first debugging`, `agent ergonomics`, `local-first AI` |
| **Structural anchors** | `## §A Prompt engineering discipline`, `## §B Context engineering` |
| **Lock action** | NEW canonical entry + 4 mirror paths |
| **Depends on** | Task 6 (closes 3α₂-A; HANDOFF checkpoint between sub-phases per EC-30/EC-32) |

---

### Phase 3α₂-B — Seed-new UI cluster (4 commits, ~60k tokens)

#### Task 8. N8 — saarinen seed-new

| | |
|---|---|
| **Domain** | saarinen × Carmack — Calm interface + workflow ergonomics |
| **Strategy** | seed-new-file (B2) |
| **Canonical** | `_council-experts-v2/saarinen/references/quality-saarinen.md` (NEW) |
| **Mirrors** | 4 (plan-v2 + plan-aura-v2 + review-v2 + review-aura-v2) |
| **§A / §B split** | §A "Calm interface discipline" (interface calmness, visual hierarchy, aesthetic compression) / §B "Workflow ergonomics" (low-friction workflows, latency perception management, keyboard-first UX, opinionated product polish) |
| **Coverage tokens (≥5)** | `interface calmness`, `visual hierarchy`, `aesthetic compression`, `latency perception`, `keyboard-first`, `low-friction`, `opinionated polish` |
| **Structural anchors** | `## §A Calm interface discipline`, `## §B Workflow ergonomics` |
| **Lock action** | NEW canonical entry + 4 mirror paths |
| **Depends on** | Task 7 |

#### Task 9. N9 — friedman seed-new

| | |
|---|---|
| **Domain** | friedman × Carmack — Scanability + decision design |
| **Strategy** | seed-new-file (B2) |
| **Canonical** | `_council-experts-v2/friedman/references/quality-friedman.md` (NEW) |
| **Mirrors** | 4 (plan-v2 + plan-aura-v2 + review-v2 + review-aura-v2) |
| **§A / §B split** | §A "Scanability & decision design" (scanability, dashboards-that-drive-action, progressive disclosure, decision fatigue reduction) / §B "Form & friction UX" (friction-aware UX, form usability, resilient interface patterns, accessibility-integrated UX) |
| **Coverage tokens (≥5)** | `scanability`, `progressive disclosure`, `decision fatigue`, `friction-aware`, `form usability`, `resilient interface`, `dashboards that drive action` |
| **Structural anchors** | `## §A Scanability & decision design`, `## §B Form & friction UX` |
| **Lock action** | NEW canonical entry + 4 mirror paths |
| **Depends on** | Task 8 |

#### Task 10. N10 — watson seed-new

| | |
|---|---|
| **Domain** | watson × Carmack — Assistive-tech compatibility + WCAG operationalization |
| **Strategy** | seed-new-file (B2) |
| **Canonical** | `_council-experts-v2/watson/references/quality-watson.md` (NEW) |
| **Mirrors** | 2 (plan-aura-v2 + review-aura-v2) — aura-only, no non-aura panel cites |
| **§A / §B split** | §A "Assistive technology compatibility" (screen-reader compatibility, semantic HTML, ARIA correctness, assistive technology empathy) / §B "WCAG operationalization" (keyboard navigation, contrast compliance, accessible interaction flows, WCAG operationalization) |
| **Coverage tokens (≥5)** | `screen-reader`, `semantic HTML`, `ARIA correctness`, `keyboard navigation`, `contrast compliance`, `assistive technology`, `WCAG operationalization` |
| **Structural anchors** | `## §A Assistive technology compatibility`, `## §B WCAG operationalization` |
| **Lock action** | NEW canonical entry + 2 mirror paths |
| **Depends on** | Task 9 |

#### Task 11. N11 — abramov seed-new

| | |
|---|---|
| **Domain** | abramov × Carmack — React state discipline + rendering mental models |
| **Strategy** | seed-new-file (B2) |
| **Canonical** | `_council-experts-v2/abramov/references/quality-abramov.md` (NEW) |
| **Mirrors** | 2 (plan-aura-v2 + review-aura-v2) — aura-only |
| **§A / §B split** | §A "React state & effects discipline" (state minimization, effects discipline, server-client boundary clarity, hydration correctness) / §B "Rendering mental models" (composable components, optimistic UI, rendering mental models, synchronization over lifecycle thinking) |
| **Coverage tokens (≥5)** | `state minimization`, `effects discipline`, `server-client boundary`, `hydration correctness`, `optimistic UI`, `synchronization over lifecycle`, `composable components` |
| **Structural anchors** | `## §A React state & effects discipline`, `## §B Rendering mental models` |
| **Lock action** | NEW canonical entry + 2 mirror paths |
| **Depends on** | Task 10 (closes 3α₂-B; HANDOFF checkpoint per EC-30/EC-32) |

---

### Phase 3α₂-C — Seed-new language/platform (3 commits, ~45k tokens)

#### Task 12. N12 — brandur seed-new

| | |
|---|---|
| **Domain** | brandur × Carmack — Migration safety + operational discipline |
| **Strategy** | seed-new-file (B2) |
| **Canonical** | `_council-experts-v2/brandur/references/quality-brandur.md` (NEW) |
| **Mirrors** | 2 (plan-v2 + review-v2) — non-aura |
| **§A / §B split** | §A "Migration safety & integrity" (migration safety, transactional integrity, lock contention awareness, incremental infra evolution) / §B "Operational discipline" (explain-analyze literacy, idempotent jobs, retry-safe systems, operational postgres) |
| **Coverage tokens (≥5)** | `migration safety`, `transactional integrity`, `lock contention`, `explain-analyze`, `idempotent jobs`, `retry-safe`, `operational postgres` |
| **Structural anchors** | `## §A Migration safety & integrity`, `## §B Operational discipline` |
| **Lock action** | NEW canonical entry + 2 mirror paths |
| **Depends on** | Task 11 |

#### Task 13. N13 — durov seed-new

| | |
|---|---|
| **Domain** | durov × Carmack — Telegram UX + bot reliability |
| **Strategy** | seed-new-file (B2) |
| **Canonical** | `_council-experts-v2/durov/references/quality-durov.md` (NEW) |
| **Mirrors** | 2 (plan-v2 + review-v2) — non-aura |
| **§A / §B split** | §A "Telegram UX patterns" (callback-flow ergonomics, inline keyboard discipline, telegram-native UX, conversational latency awareness) / §B "Bot reliability architecture" (async bot architecture, state-machine navigation, bot reliability patterns, low-friction interactions) |
| **Coverage tokens (≥5)** | `callback-flow`, `inline keyboard`, `telegram-native`, `async bot architecture`, `state-machine navigation`, `bot reliability`, `conversational latency` |
| **Structural anchors** | `## §A Telegram UX patterns`, `## §B Bot reliability architecture` |
| **Lock action** | NEW canonical entry + 2 mirror paths |
| **Depends on** | Task 12 |

#### Task 14. N14 — vanrossum seed-new

| | |
|---|---|
| **Domain** | vanrossum × Carmack — Pythonic clarity + async discipline |
| **Strategy** | seed-new-file (B2) |
| **Canonical** | `_council-experts-v2/vanrossum/references/quality-vanrossum.md` (NEW) |
| **Mirrors** | 2 (plan-v2 + review-v2) — non-aura |
| **§A / §B split** | §A "Pythonic clarity" (explicit over implicit, readability-first APIs, type-aware Python, simple powerful abstractions) / §B "Async & dependency discipline" (async IO boundaries, dependency clarity, pragmatic standard-library usage, maintainable automation) |
| **Coverage tokens (≥5)** | `explicit over implicit`, `readability-first`, `async IO boundaries`, `type-aware Python`, `pragmatic standard-library`, `dependency clarity`, `maintainable automation` |
| **Structural anchors** | `## §A Pythonic clarity`, `## §B Async & dependency discipline` |
| **Lock action** | NEW canonical entry + 2 mirror paths |
| **Depends on** | Task 13 (closes Phase 3α; write HANDOFF-phase-3-α-CLOSURE.md per EC-32) |

---

## EC-30 Token-Budget Probe

**Per-commit cost model:**

| Cost surface | Append-existing | Seed-new-file |
|---|---|---|
| Read spec (228 lines) | ~3k | ~3k |
| Read dump section (~30-50 lines per expert) | ~1k | ~1k |
| Read existing canonical (B1=481/B2=406 lines) | ~5-6k | — |
| Read example seed (one of dahl/ritchie/hashimoto) | — | ~5-6k (reference shape) |
| Per-commit content authoring + write | ~3k | ~6-8k |
| Update _phase2-coverage-tokens.yml (5-10 tokens + maybe anchors) | ~1k | ~1k |
| Update _ref-mirrors.lock (sha256 bump OR new entry) | ~0.5k | ~1k |
| cp-mirrors --apply + --check + verify-catalog C1-C12 | ~2k | ~3k |
| Commit body + push | ~1k | ~1k |
| Validator brief write + report read | ~3-4k | ~4-5k |
| **Per-commit working tokens (estimated)** | **~18-21k** | **~25-30k** |

**Per sub-phase budget:**

| Sub-phase | Commits | Estimate | Within ≤100k? |
|---|---|---|---|
| 3α₁ (append-existing) | 3 (dahl, ritchie, hashimoto) | ~55-65k | ✅ |
| 3α₂-A (domain-neutral seed) | 4 (fowler, beck, hunt, willison) | ~100-120k | ⚠️ borderline; HANDOFF recommended after task 7 |
| 3α₂-B (UI cluster seed) | 4 (saarinen, friedman, watson, abramov) | ~100-120k | ⚠️ borderline; HANDOFF after task 11 |
| 3α₂-C (lang/platform seed) | 3 (brandur, durov, vanrossum) | ~75-90k | ✅ |

**Decision (Carmack chair):** SPLIT into 4 sub-phases with HANDOFF between each. Single-Phase-3α attempt would burn ~330-395k working tokens — well over EC-30 ceiling and into session-compaction risk territory. The 4-way split (3 + 4 + 4 + 3) honors EC-30 per phase, gives 4 natural HANDOFF points for EC-32 closure artifacts, and limits validator-pipeline queue depth to ≤4 unresolved briefs at any time.

**Total Phase 3α projected cost:** ~330-395k working tokens across 4 Claude sessions (4 HANDOFFs between sub-phases).

---

## Plan Commit Boundary Decision

**Decision:** Commit this PLAN file as `docs(plan): Phase 3α council plan output` (N2 commit), separate from /council-implement-aura-v2 dispatch.

**Justification:**
- Mirrors N0 (HANDOFF closure) + N1 (spec) commit pattern — keeps "load-bearing artifact" boundary consistent.
- /council-implement-aura-v2 reads the plan path at execution time; in-memory inline plan would be lost across the inevitable EC-32 HANDOFF between sub-phases.
- Allows validator's N2 brief to reference exact PLAN content at a fixed SHA.
- Aura-companion repo grows by 1 file (~400 lines markdown), no impact on skills-repo gates.

**Alternative considered + rejected:** holding the plan inline as a chat artifact would couple PLAN visibility to the current session — violates EC-32 phase-closure HANDOFF contract.

---

## Risk Register

### R1 — License/attribution edge case (verbatim block ≥51 chars)
- **Domain:** hunt × Carmack
- **Trigger:** during content authoring, a paraphrase inadvertently quotes the source verbatim across ≥51 contiguous characters.
- **Detection (mitigation):** add a verify-catalog candidate canary `C13` (out of Phase 3α scope; deferred to Phase 3-C housekeeping) — `grep -E "<verbatim-marker-regex>"` against canonicals. Phase 3α relies on writer discipline + validator brief review.
- **Severity:** medium (legal exposure if MIT/CC-BY content quoted without attribution; low for OWASP since text isn't typically copyrighted material at sentence granularity).

### R2 — C10 token-fabrication (token registered, file doesn't grep-match)
- **Domain:** beck × Carmack — canary ground-truth integrity
- **Trigger:** writer registers token in `_phase2-coverage-tokens.yml` that doesn't literally appear in the file due to paraphrase drift.
- **Detection:** validator brief Story 2 AC: `grep -F "<token>" <file>` MUST return ≥1 match. Validator runs this for EVERY claimed token per commit.
- **Mitigation:** writer runs the same grep before commit; if it fails, fix the file to include the literal token OR remove the token from manifest. Atomic same-commit edit.
- **Severity:** high (C10 ground-truth contract is the canary's whole value; fabrication invalidates the gate).

### R3 — Mirror byte-identity race (apply→commit window)
- **Domain:** ritchie × Carmack — atomic write discipline
- **Trigger:** `cp-mirrors --apply` writes mirrors, then commit captures them, but another process (concurrent writer, file-system noise) modifies a mirror in the window.
- **Mitigation:** Phase 3α runs in single-writer tmux (no parallel writers); `cp-mirrors --check` re-verifies byte-identity AFTER `--apply` and BEFORE `git add`. EC-4 debounce window discipline applies. Validator brief asserts post-commit `cp-mirrors --check` exits 0.
- **Severity:** low (single-writer tmux essentially eliminates race in practice; check-after-apply double-guards).

### R4 — Lock manifest desync (canonical edited without sha256 bump)
- **Domain:** hashimoto × Carmack — supply-chain attestation
- **Trigger:** writer edits canonical but forgets to update `_ref-mirrors.lock` `canonical.sha256` in same commit.
- **Detection:** C12 canary in `verify-catalog.sh` — runs `sha256sum` on canonical, compares against pinned value. Mismatch → ERR=1.
- **Mitigation:** validator brief asserts both digests match; writer's pre-commit checklist explicitly lists "bump lock sha256 after every canonical edit." Append-existing commits MUST update lock; seed-new commits MUST add lock entry.
- **Severity:** high (C12 catches it but only AFTER commit — would force a fixup commit; brief discipline prevents).

### R5 — v1 catalog accidental touch (Phase 0/1 isolation breach)
- **Domain:** fowler × Carmack — bounded-context discipline
- **Trigger:** writer reads/writes `_council-experts/` (v1) during a Phase 3α seed-new commit by typo or fuzzy auto-complete.
- **Detection:** validator brief includes `find _council-experts -name "*.md" -exec md5sum {} \;` baseline → compare against post-commit hash. Any drift → FAIL.
- **Mitigation:** writer's per-commit `git diff --stat HEAD~1 HEAD` MUST show zero `_council-experts/` (without -v2) paths.
- **Severity:** medium (recoverable via revert; but Phase 0/1 isolation pattern is load-bearing).

### R6 — Atomic-per-expert violation (bundling)
- **Domain:** beck × Carmack — small safe steps
- **Trigger:** writer stages files from two `_council-experts-v2/<id>/` dirs in one commit.
- **Detection:** validator brief AC: `git show --stat HEAD | grep -oE "_council-experts-v2/[a-z]+/" | sort -u | wc -l` MUST equal 1.
- **Mitigation:** writer commits one-expert-at-a-time, never stages cross-expert.
- **Severity:** high (EC-31 non-negotiable; bundling makes per-commit validator gate meaningless).

### R7 — EC-30 budget overrun mid-sub-phase
- **Domain:** chair × Carmack — phase discipline
- **Trigger:** unforeseen complexity (e.g., a single expert's dump material requires more authoring effort) pushes a sub-phase over ~100k working tokens before its HANDOFF.
- **Detection:** writer surfaces token-budget telemetry between commits (chat report can note).
- **Mitigation:** chair (writer) can split a sub-phase mid-flight — e.g., 3α₂-A (4 commits) becomes 3α₂-A.1 (2 commits) + 3α₂-A.2 (2 commits) with intermediate HANDOFF. EC-32 closure artifact MUST land before the session compacts.
- **Severity:** medium (recoverable; HANDOFF restoration cost is small).

### R8 — Validator-pipeline deadlock (writer blocked waiting for report)
- **Domain:** chair × Carmack — pipeline liveness
- **Trigger:** validator session terminates / is interrupted / takes too long; writer is stuck PAUSED.
- **Detection:** writer notices >15 min wallclock with no `/tmp/phase-3-α-NN-validator-report.md` landing.
- **Mitigation:** writer surfaces to operator after threshold; operator can re-spawn validator session or directly inspect brief and PASS/FAIL via chat. Brief artifact is self-contained and re-readable.
- **Severity:** low (recoverable; affects throughput not correctness).

### R9 — Mirror set drift between SKILL.md panel-list and lock manifest
- **Domain:** hunt × Carmack — supply-chain canary
- **Trigger:** expert added to panel-list but no corresponding mirror entry in lock; OR lock entry references a path that no panel-list cites.
- **Detection:** C2 (panel→catalog reachability) + C11 (cp-mirrors --check byte-identity) jointly catch most cases. C12 also asserts lock entries exist on disk.
- **Mitigation:** per-commit verification that PLAN-derived mirror-set list MATCHES current SKILL.md panel-list intersection. Recommended: writer re-runs the panel-extraction grep before each seed-new commit to detect upstream panel changes.
- **Severity:** medium (C11/C12 catch on commit; but discovery only at commit time, not at edit time).

---

## External Setup Required

| # | What | Why | Blocking task |
|---|------|-----|---------------|
| 1 | Skills-repo push-gate decision (URL + `git remote add origin`) | Currently `~/.claude/skills` master has no remote. Phase 3α produces 14 commits; if work needs to be visible to other agents/operators, the remote must exist. | Optional; Phase 3α can complete locally and operator can decide post-closure. Out of scope per pickup-prompt. |

---

## Summary

| # | Task | Domain | Strategy | Mirrors | Depends |
|---|------|--------|----------|---------|---------|
| 1 (N1) | dahl append §Z | dahl | append | 2 (existing) | — |
| 2 (N2) | ritchie append §Z | ritchie | append | 2 (existing) | 1 |
| 3 (N3) | hashimoto append §Z | hashimoto | append | 4 (existing) | 2 |
| 4 (N4) | fowler seed-new | fowler | seed-new | 4 | 3 (HANDOFF 3α₁→3α₂-A) |
| 5 (N5) | beck seed-new | beck | seed-new | 2 | 4 |
| 6 (N6) | hunt seed-new | hunt | seed-new | 4 | 5 |
| 7 (N7) | willison seed-new | willison | seed-new | 4 | 6 (HANDOFF 3α₂-A→3α₂-B) |
| 8 (N8) | saarinen seed-new | saarinen | seed-new | 4 | 7 |
| 9 (N9) | friedman seed-new | friedman | seed-new | 4 | 8 |
| 10 (N10) | watson seed-new | watson | seed-new | 2 | 9 |
| 11 (N11) | abramov seed-new | abramov | seed-new | 2 | 10 (HANDOFF 3α₂-B→3α₂-C) |
| 12 (N12) | brandur seed-new | brandur | seed-new | 2 | 11 |
| 13 (N13) | durov seed-new | durov | seed-new | 2 | 12 |
| 14 (N14) | vanrossum seed-new | vanrossum | seed-new | 2 | 13 (Phase 3α CLOSURE HANDOFF per EC-32) |

**Mirror counts** sum: append-existing = 2+2+4 = 8 (already in lock); seed-new = 4+2+4+4+4+4+2+2+2+2+2 = 32 (NEW lock entries). Total lock manifest growth: +11 canonical entries + 32 mirror paths.

**Token registration growth:** 14 × ~6 tokens = ~84 new tokens in `_phase2-coverage-tokens.yml`. Plus 11 × ~2 structural_anchors entries = ~22 new anchors.

---

## Verdict

The most important architectural decision is the **4-way sub-phase split** (3α₁ + 3α₂-A + 3α₂-B + 3α₂-C) with 3 intermediate HANDOFFs. Without this split, a single-session Phase 3α attempt burns ~330-395k working tokens — well past EC-30's 100k ceiling and into session-compaction territory where the validator-pipeline becomes unreliable. The split is mandatory, not optional.

The second-most-important decision is **direct chair synthesis instead of parallel expert dispatch** for this plan. The spec at 9428192 is mechanically concrete (templates, paths, mirror policy all specified) — expert subagents would mostly restate it and burn token budget that's better spent on the 14 actual enrichment commits. If a per-commit author hits a domain decision the spec doesn't cover, dispatch the relevant expert ad-hoc.

**Developer should start at Task 1 (dahl append §Z).** The 3 append-existing commits validate the §Z/lock-bump/mirror-regen pattern on known-good files before any seed-new is attempted. Failing the pattern on append (cheap to recover) is far better than discovering the failure mode mid-3α₂.

**Pair agent recommendation:** none for Phase 3α. The validator-pipeline (writer + reader in parallel tmux) already provides the dual-process gate per EC-31. A council-pair would add observation overhead without altering the mechanical authoring work. Save council-pair dispatch for Phase 3β (genuinely new expert seating, larger architectural decisions).
