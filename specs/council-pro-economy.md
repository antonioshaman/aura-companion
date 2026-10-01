# Spec: Council PRO Economy — adaptive, self-learning cost reduction for the Carmack-Council pipelines

**Tier:** Feature
**Problem:** The council pipelines (`council-plan/review/implement` + the RC-2 adaptive advisor engine) were tuned for a Claude MAX subscription. On PRO (tight 5h + weekly limits) the same MAX-era fan-out — up to 11 parallel subagents, each on the top model with a wide context — exhausts the window fast. We need the *same output quality* at a fraction of the token/limit cost, and the system should *learn* where cheap effort is safe rather than relying on hand-guessed constants.
**Context:** RC-2 (in prod) already seats an adaptive **3–11** roster from capability profiles instead of a fixed panel — a first economy layer. This spec adds the larger levers on top: per-seat model tiering, a persistent skip-if-unchanged cache, and data-derived review-depth thresholds — all governed by a non-negotiable quality floor.

---

## Job Stories

### 1. Complexity-tiered, self-learning model selection
**When** the council dispatches its selected seats, **I want** each seat's model chosen adaptively from the task's complexity — the cheapest capable tier for narrow/low-stakes lenses, the top tier for the Chair/synthesis and fail-closed lenses — with the complexity→tier policy **tuned over time from historical run outcomes**, **so I can** spend top-model tokens only where they change the verdict.

- Given a low-complexity, small single-surface change, when a narrow expert (e.g. a11y, lint-style) is dispatched, then it runs on the cheapest capable tier.
- Given the Chair synthesis OR a fail-closed security/LLM lens, when dispatched, then it runs on the top tier regardless of complexity.
- Given ≥ N recorded runs each carrying `(complexity band, seat, tier used, did the finding survive verification)`, when the tier policy recomputes, then a seat whose cheap-tier findings were repeatedly discarded in a complexity band is promoted a tier for that band, and one whose top-tier findings were consistently trivial is eligible for demotion.
- **(negative)** Given the complexity signal is missing or unparseable, when selecting a tier, then the system falls back to the **safe (higher)** tier — never the cheapest — and records the fallback.

### 2. Persistent skip-if-unchanged result cache
**When** I re-run a council pass and a seat's assigned files are unchanged since its last run, **I want** that seat's prior findings reused from a **persistent** cache instead of a re-dispatch, **so I can** avoid paying to re-review unchanged code — across sessions, not just within one.

- Given a seat's assigned file set has a content hash identical to a cached prior run, when the council dispatches, then the seat is skipped and its cached findings are reused and clearly marked "from cache".
- Given any assigned file's content hash differs, when dispatched, then the seat re-runs and its cache entry is refreshed.
- Given a new session runs the council on the same workspace, when valid cache entries from a prior session exist, then they are reused (persistence spans sessions).
- **(negative)** Given a cache entry is older than a staleness bound OR was produced by a different council/skill/engine version, when consulted, then it is invalidated and the seat re-runs.

### 3. Data-derived review-depth thresholds
**When** a change is small or low-risk by *historical* measure, **I want** the council to scale effort down (reduced roster / cheaper tiers / defer), with the thresholds **derived from the recorded run dataset rather than a guessed constant**, **so I can** match review cost to actual risk instead of a magic number.

- Given a diff whose size/risk falls below a threshold **derived from the historical dataset**, when a review is triggered, then a reduced roster runs (still respecting the min-seat and security floor).
- Given the historical dataset grows, when thresholds are recomputed, then they move with the data — no hardcoded size constant is the source of truth.
- **(negative)** Given insufficient historical data to derive a threshold, when deciding depth, then the system runs the **full** roster (never cost-cut on unknown ground) and records the data gap.
- **(negative)** Given the diff touches a security-relevant path, when computing depth, then the security lens is seated regardless of any size threshold.

### 4. Quality-floor guardrail (non-negotiable)
**When** any economy optimization (tier-down, cache-skip, reduced roster, defer) is applied, **I want** a mandatory guardrail that every P1 the full pipeline would surface is still surfaced and every P2 is still attended, **so I can** trust that cost cuts never trade away correctness or security findings.

- Given an optimized run on the guardrail fixture (seeded with known P1s), when it completes, then **100% of those P1s are present** (zero P1 regression).
- Given an optimized run, when it completes, then P2 findings are still surfaced (may be de-emphasized, never silently dropped).
- Given the fail-closed security/LLM lens, when any optimization is considered, then that lens is never dropped, skipped, or tiered below the top model.
- **(negative)** Given an optimization would drop a P1 or the security lens, when the guardrail detects it, then the optimization is refused and the run falls back to full depth, logging the refusal.

---

## Success metrics
- **≥ 50 % reduction** in subagent token cost per council run on median (low/mid-complexity) tasks vs the pre-optimization baseline, measured over a rolling window.
- **Zero P1 regression** on the guardrail fixture — a hard CI gate, not a target.
- Cache-hit rate and per-seat tier are reported per run (observability for the self-learning loop).

## Boundaries
**✅ Always** — pick a cheaper tier / cache-skip / reduce the roster *within the guardrail*; record every cost decision plus its inputs (complexity, tier, diff size, finding survival) into the learning dataset; recompute thresholds and tier policy from that data.
**⚠️ Ask first** — changing what counts as P1/P2 (the guardrail definition); lowering the security-lens tier; changing the persistent-cache location or retention; any change that could drop a finding class.
**🚫 Never** — drop or tier-down the fail-closed security/LLM lens; skip a seat whose files changed; cut depth on a security-relevant path; invent a threshold with no data (must fall back to full); ship a run that regresses a P1.

## Assumptions (confirm / override)
- Per-seat model selection is expressible in the council dispatch (a `model` column in the expert reference table + the Task/Agent `model` param). This requires a council SKILL.md change.
- A persistent cache + run-stats store is available (e.g. under `~/.companion/` or the workspace `.council/`). The self-learning behavior (Stories 1 & 3) **depends on run-stats being recorded** — if that dataset does not yet exist, a data-collection increment must land first (record `(complexity, seat, tier, diff size, finding survival)` per run) before adaptive tiering/thresholds have anything to learn from.
- "Complexity" is a computable signal (diff size + surface count + changed-domain breadth), not a model's self-report.

---

*After implementing, compare results against each acceptance criterion above and list any unmet requirements.*
