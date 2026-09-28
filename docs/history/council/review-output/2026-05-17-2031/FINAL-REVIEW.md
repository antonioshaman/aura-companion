# Council Review: Aura Companion documentation rebrand + Council Mode coverage

**Scope:** Commit `50a9018` — README rebrand, Council Mode guide + architecture reference rewrites, `docs/index.mdx` Council Mode card promotion, `bunx the-companion` → `bunx aura-companion` truth-up across four CLI docs, landing-site `rel="noopener noreferrer"` hardening.
**Context:** A docs-only PR that brings README + Mintlify docs + landing site into alignment with the current product. Most artefacts existed in draft form before the PR; this commit refines them, fixes drift, and surfaces Council Mode as the headline feature. No backend / protocol / persistence / subprocess changes.
**Council dispatched:** 8 of 12 experts (Backend, Persistence, Realtime, Subprocess deliberately skipped — zero files in scope). All returned findings.

**Automated check results:** Typecheck exit 0. Vitest: 247 test files, 6384 passed, 4 skipped, 0 failed. No pre-existing failures encountered.

---

## P1 — Fix Now

### 1. Docs imply orchestrator auto-writes checkpoints; the producer is an explicit POST

| | |
|---|---|
| **File** | `docs/guides/council-mode.mdx:86`, `docs/reference/council-mode-architecture.mdx:55` |
| **Council** | LLM expert × Carmack — Honest description of LLM-shaped surfaces |
| **Ref** | `references/quality-llm.md` → Principle 1 + Principle 10 |

**Finding:** Both docs describe checkpoint emission as a passive thing the orchestrator does ("the orchestrator records a checkpoint", "Written by the orchestrator after each Carmack-Council phase"). The CLI does not write checkpoint files by itself — something (a skill, a hook, an explicit tool call) must `POST /api/sessions/:id/council/checkpoint`. The reference's data-flow ASCII shows the orchestrator CLI writing directly, which is not what happens.

**Consequence:** A user toggles Council Mode, runs a normal session, sees nothing happen on the Observer panel, and concludes the feature is broken. The fallible-observer framing then earns blame the observer doesn't deserve — the inverse of the trust-boundary honesty the rest of the doc establishes.

**Fix:** State plainly in both docs that checkpoints are caller-driven, not automatic. Name the producer endpoint (`POST /api/sessions/:id/council/checkpoint`) and the skills that emit them in practice. Add a troubleshooting row for "ObserverPanel stays on `never-checkpointed-yet` after work landed" → "Nothing called the checkpoint POST. Confirm your orchestrator skill emits checkpoints or POST manually for a smoke test."

---

### 2. Architecture reference cites `EC-13` but the canonical `conventions.md` skips from `EC-12` to `EC-14`

| | |
|---|---|
| **File** | `docs/reference/council-mode-architecture.mdx:125` |
| **Council** | Security expert × Carmack — Audit-trail integrity at the cited authority |
| **Ref** | `references/security.md` → §A attack surface discipline |

**Finding:** The page deliberately defers convention text to `conventions.md` as the canonical authority, then bullets `EC-13: Observer failsafe — recurring 5-minute tick scans .council/checkpoints/...`. The canonical file enumerates `EC-1..EC-12`, then `AP-4` and `EC-14..EC-24`, then `EC-30..EC-33` — `EC-13` is absent. A reader following the explicit invitation to the canonical source hits a dead-end at the cited authority.

**Consequence:** A security claim sourced to a missing convention ID is unauditable; trust in the rest of the EC- citations on this page (EC-1, EC-2, EC-7, EC-8) leaks proportionally. Forensic question with no answer at the cited authority is exactly the doc-rot Hunt's discipline warns against.

**Fix:** Either add `EC-13` to `conventions.md` to close the gap (out of this PR's spec scope, but the right structural fix), or remove the `EC-13` citation from the reference and re-anchor the failsafe paragraph to CLAUDE.md (which does define EC-13). The two-source-of-truth split is the root cause; pick one and link the other to it.

---

## P2 — Fix Soon

### 3. Architecture reference contradicts itself on the observer write boundary

| | |
|---|---|
| **File** | `docs/reference/council-mode-architecture.mdx:140-148` |
| **Council** | Security expert × Carmack — Security-property prose must survive precise reading |
| **Ref** | `references/security.md` → §A attack surface discipline |

**Finding:** Line 142 frames the observer write boundary as "enforced at spawn time, not at runtime", then enumerates three pieces — the third of which (`assertObserverWriteAllowed`) is described as resolving `realpath` and bounds-checking before any write the observer might attempt, i.e., a runtime check.

**Fix:** Replace "enforced at spawn time, not at runtime" with "enforced at two layers: spawn-time argv injection (primary) and a runtime path-resolving guard (defence-in-depth)". The three-piece enumeration that follows is correct; only the topline framing needs to match. Cross-ref: LLM expert's W4 — the guide's "Cannot write" bullet undersells the same defence-in-depth; align both surfaces.

---

### 4. Landing footer is not in `branding.config.json` `protectedPaths` — MIT attribution one rule edit from silent corruption

| | |
|---|---|
| **File** | `branding.config.json` (risk surface in `landing/src/components/Footer.tsx:5-12`) |
| **Council** | Security expert × Carmack — Secure defaults for legally-significant text |
| **Ref** | `references/security.md` → §A attack surface discipline |

**Finding:** The Footer's MIT-attribution URL (`https://github.com/The-Vibe-Company/companion`) is preserved today only because active replacement rules don't substring-match it. A future contributor widening a rule (e.g. case-insensitive `the-companion`) would silently rewrite the attribution URL and break MIT-license obligation. `docs/**` is protected; `landing/**` is not.

**Fix:** Add `landing/src/components/Footer.tsx` (or `landing/**`) to `protectedPaths`. Pair with a one-line CI canary that asserts `The-Vibe-Company/companion` is still substring-present in Footer.tsx; a corrupted attribution then fails CI rather than ships.

---

### 5. `--port` flag documented but ignored by the runtime on foreground / serve paths

| | |
|---|---|
| **File** | `docs/reference/cli-and-api.mdx:26-32`, `docs/get-started/installation.mdx:56-58` |
| **Council** | DevOps expert × Carmack — Documented contract must match runtime |
| **Ref** | `references/quality-deploy.md` → call-site-presence-not-just-symbol-export |

**Finding:** Both files document `aura-companion --port 8080`. `web/bin/cli.ts` parses `--port` only inside the `install` branch; the default / `serve` paths read port from `process.env.PORT` and ignore argv. Pre-existing drift carried forward by the rebrand.

**Fix:** Either document `PORT=8080 aura-companion` in foreground examples and reserve `--port` for `install`, or extend `bin/cli.ts` to honour `--port` on the default + `serve` branches. Current state contradicts itself.

---

### 6. Double-H1 risk: front-matter `title` + in-body `# Heading` on the same page

| | |
|---|---|
| **File** | `docs/index.mdx:1-6`, `docs/guides/council-mode.mdx:1-6`, `docs/reference/council-mode-architecture.mdx:1-6` |
| **Council** | a11y expert × Carmack — Heading hierarchy / WCAG 1.3.1 |
| **Ref** | `references/quality-a11y.md` → Roles and names (Principle 5) |

**Finding:** Each MDX file declares front-matter `title:` AND opens with `# <Title>` in the body. Mintlify renders front-matter as the page H1; the in-body `#` either becomes a second H1 (WCAG 1.3.1 best-practice violation) or is silently demoted (renderer-dependent fragility). Cross-ref: UI expert flagged the same surface as a visual rhythm break — two big titles stacked.

**Fix:** Drop the in-body `# Title` from each `.mdx` file. The front-matter `title:` is the SSOT for the H1 under Mintlify. Verify on the rendered docs site after change.

---

### 7. README ↔ guide DRY violation in the Council Mode lead paragraph

| | |
|---|---|
| **File** | `README.md:21` ↔ `docs/guides/council-mode.mdx:8` |
| **Council** | Refactoring expert × Carmack — DRY across canonical surfaces |
| **Ref** | `references/refactoring.md` → Principle 4 |

**Finding:** The README's "Why Council Mode" paragraph and the guide's lead paragraph are near-verbatim duplicates ("The multi-agent pattern that worked manually in past pipelines — catching a couple of P1 issues per phase that single-author review missed — is reproducible..."). The PR's stated discipline (README = elevator pitch, guide = canonical) is violated at exactly the place that matters most. The fallible-observer disclaimer is also paraphrased in both.

**Fix:** Shorten the README "Why Council Mode" paragraph to one sentence of mechanism + one sentence of value with NO shared phrases with the guide. Delete the fallible-observer disclaimer from the README — that nuance belongs only in the guide where the user can act on it.

---

### 8. README port-number drift between dev and prod

| | |
|---|---|
| **File** | `README.md:64-65, 68-69` |
| **Council** | Refactoring expert × Carmack — Names that lie |
| **Ref** | `references/refactoring.md` → Principle 4 |

**Finding:** The README ASCII data-flow shows `:5174` (browser) + `:3456` (server). CLAUDE.md states dev is `:3457` + `:5174`. The Quick Start tells the user to `bun run dev` and open `:5174`, which is correct — but the architecture diagram then shows `:3456`. A user who follows Quick Start and references the diagram sees a port that won't respond in dev.

**Fix:** Either drop explicit port numbers from the README ASCII diagram (use `:BROWSER` / `:SERVER` and reference the guide), or add a one-line note distinguishing dev (`:3457`) vs prod (`:3456`). Same bullet treatment for line 68.

---

### 9. `docs/index.mdx` Card hierarchy reads as two equal pillars, not featured + grid

| | |
|---|---|
| **File** | `docs/index.mdx:30-61` |
| **Council** | UI expert × Carmack — Visual hierarchy mirrors narrative hierarchy |
| **Ref** | `references/quality-ui.md` → §A visual hierarchy discipline |

**Finding:** Council Mode promoted to `<CardGroup cols={1}>` above `## More features` + `<CardGroup cols={2}>`, but the H2 labels "Featured" vs "More features" are symmetric vocabulary. On Mintlify the featured Card sits visually adjacent to the grid; the eye reads three cards in a column rather than one-featured-then-grid.

**Fix:** Either drop the "Featured" H2 (let the single-card row stand alone above the grid with a visible whitespace gap) OR rename to a directive label like "Start here". Do not leave "Featured" vs "More features" as siblings.

---

### 10. Guide reading order interrupts the action spine with four conceptual sections

| | |
|---|---|
| **File** | `docs/guides/council-mode.mdx:80-114` (sections between "Keyboard shortcuts" and "Degraded mode") |
| **Council** | UX expert × Carmack — Lists drive action |
| **Ref** | `references/quality-ux.md` → Principle 6 |

**Finding:** Spec Story 2 ordering is `what → enable → pairings → states → shortcuts → degraded`. The guide places "How findings get grounded", "Finding lifecycle", "Restart-replay determinism", and "Provider badges" BETWEEN shortcuts and degraded. A reader who came for degraded recovery has to scroll past four conceptual detours.

**Fix:** Move "How findings get grounded" + "Finding lifecycle" + "Restart-replay determinism" + "Provider badges" to AFTER "Degraded mode" (immediately above "Workspace artefacts"). The action-oriented spine (what / enable / pairings / states / shortcuts / degraded) should be uninterrupted; background concepts belong below it.

---

### 11. Prompt-version audit affordance names the fields but not where to read them

| | |
|---|---|
| **File** | `docs/reference/council-mode-architecture.mdx:46-51` |
| **Council** | LLM expert × Carmack — Observability layer must be usable |
| **Ref** | `references/quality-llm.md` → Principle 5 + Principle 6 |

**Finding:** The "Auditing observer behaviour across runs" section enumerates `observerPromptSha256`, `observerPromptSource`, and the `council.observer-prompt.bundled-fallback` WARN log, and explains what each means semantically — but does not say where the user finds them at runtime. Is the sha256 in a REST response? Recording header? UI? Server log? A user asking "why does my workspace prompt seem ignored" reads twice and still doesn't know where to look.

**Fix:** Add one sentence per field naming its surface (recording header line 1; `GET /api/sessions/:id`; WARN log location). If any are not currently surfaced to a user-facing API, that's a separate finding — but the docs should state the truth.

---

### 12. State-pill priority list loses "top wins" semantic for screen-reader users

| | |
|---|---|
| **File** | `docs/guides/council-mode.mdx:60-69` |
| **Council** | a11y expert × Carmack — Ordered-list semantics imply sequence, not priority |
| **Ref** | `references/quality-a11y.md` → Principle 5 |

**Finding:** The PR replaced the state-pill table with an ordered list ("priority ladder — top wins"). The `<ol>` semantic announces "list, 7 items, item 1 of 7, degraded" — a screen-reader user interprets this as ordered sequence (do these in order), not as ranked priority. The "top wins" cue exists only in the prose above the list and is invisible to mid-document anchor navigation.

**Fix:** Either introduce each item with the priority rank as visible content ("Highest: degraded — ...", "Then: blocker-found — ...") so priority is part of announced text, OR switch to a table with explicit "Priority" column + caption. Ranked-not-sequential is the rare case where a table beats a list for accessibility.

---

## P3 — Consider

### 13. Group-id "second factor" overclaims against the actual control

| | |
|---|---|
| **File** | `docs/reference/council-mode-architecture.mdx:173-176` |
| **Council** | Security expert × Carmack — Name the actual control, not an adjacent one |

The doc calls the cryptographic group-id a "second factor". The control is a per-resource authorization scope — useful and adequate — but "2FA" terminology overstates its posture and would become a retraction in any future breach disclosure. Rephrase to "a per-group authorization scope cryptographically bound to the group id, required on every council-scoped REST endpoint."

---

### 14. README "Skill chain" inventory enumerates 19 named skills — the rot surface the "growing" caveat was supposed to close

| | |
|---|---|
| **File** | `README.md:75-106` |
| **Council** | Refactoring expert × Carmack — Will this slow us down? |

The PR removed "29 skills" numeric drift, but the README still inventories 5 + 6 + 18 = 29 named skills inline; actual disk count is 30 (`karpathy` is absent from all three lists). The "growing skill chain" prose only covers counts; the named enumerations remain a maintenance liability. Collapse the three tables to one short paragraph per pillar naming the load-bearing skills (`/prime`, `/council-plan`, `/council-review`) and let `ls .agents/skills/` or the docs nav be authoritative.

---

### 15. Worked grounding-gate example covers only one downgrade branch

| | |
|---|---|
| **File** | `docs/guides/council-mode.mdx:84-95` |
| **Council** | LLM expert × Carmack — Recording-based, full-coverage examples |

The example covers STOP `evidence_path` not in `modifiedFiles` (out-of-delta). The actual gate also downgrades on "missing on disk" — meaningfully different (path WAS in the manifest, but the file got deleted or hallucinated). Users inspecting a `missing on disk` downgrade-reason will second-guess the system because the worked example didn't show this branch. Half a paragraph extends the symmetry.

---

## Summary

| # | Finding | Severity | Council | Fix effort |
|---|---------|----------|---------|------------|
| 1 | Docs imply orchestrator auto-writes checkpoints | P1 | LLM expert | ~15 lines, 2 files |
| 2 | EC-13 cited but absent from conventions.md | P1 | Security expert | 1 line + decide canonical home |
| 3 | "Spawn time, not at runtime" contradicts the bullets it introduces | P2 | Security expert | 1 line |
| 4 | Landing footer not in `protectedPaths` | P2 | Security expert | 1 JSON line + CI canary |
| 5 | `--port` flag documented but not honoured | P2 | DevOps expert | Doc fix OR 5-line cli.ts patch |
| 6 | Double-H1 risk across MDX | P2 | a11y expert | 3 one-line deletions |
| 7 | README ↔ guide lead-paragraph DRY | P2 | Refactoring expert | ~10 lines in README |
| 8 | README port-number drift dev vs prod | P2 | Refactoring expert | 2 lines |
| 9 | "Featured" vs "More features" reads as siblings | P2 | UI expert | 1 H2 rename |
| 10 | Guide action-spine interrupted by 4 conceptual sections | P2 | UX expert | Move 4 sections |
| 11 | Prompt-version audit: fields named but not located | P2 | LLM expert | 3 sentences |
| 12 | State-pill ordered list loses "top wins" for SR | P2 | a11y expert | Reformat list |
| 13 | Group-id "second factor" overclaim | P3 | Security expert | 1 paragraph |
| 14 | README skill-chain enumeration is rot surface | P3 | Refactoring expert | Collapse 3 tables → prose |
| 15 | Worked example missing "missing on disk" branch | P3 | LLM expert | Half a paragraph |

## Verdict

The PR is shipping-quality. Both P1s are documentation-truth gaps, not implementation defects — the docs over-describe what the orchestrator does (silently writes checkpoints) and cite a convention ID (`EC-13`) that doesn't exist at the cited authority. Fix both in a single follow-up commit: add an "How checkpoints are written" subsection to the guide (and a parallel one-paragraph clarification to the reference's data-flow ASCII), and reconcile `EC-13` between `conventions.md` and the reference page. The LLM expert's domain is the most critical right now: this PR is the first surface that codifies the Council Mode mental model for new users, and any drift between the prose model and the runtime contract compounds. The biggest single risk: a new user toggles Council Mode, runs a normal session, sees the panel sit at `never-checkpointed-yet`, and decides the feature is broken — Finding #1 closes that hole. Start there.

---

## Findings Breakdown by Expert

| Expert | P1 | P2 | P3 | Total | Key Areas |
|--------|----|----|----|----|-----------|
| Security expert | 1 | 3 | 1 | 5 | Audit-trail drift, defence-in-depth, MIT integrity, control framing |
| Refactoring expert | 0 | 2 | 1 | 3 | DRY between surfaces, port drift, skill enumeration rot |
| Frontend (React/Web UI) | 0 | 0 | 0 | 0 | Minimal-diff verified across 6 anchors; nothing to flag |
| a11y expert | 0 | 2 | 0 | 2 | Double-H1, ordered-list SR semantics |
| UI expert | 0 | 1 | 0 | 1 | Card hierarchy as featured vs sibling |
| UX expert | 0 | 1 | 0 | 1 | Action-spine interrupted by conceptual sections |
| LLM expert | 1 | 2 | 1 | 4 | Checkpoint-emission, prompt-version audit, worked-example coverage |
| DevOps expert | 0 | 1 | 0 | 1 | `--port` flag drift |
| **TOTAL** | **2** | **12** | **3** | **17** | (15 surfaced; 2 absorbed into cross-refs above) |

**Review output written to:** `.council/review-output/2026-05-17-2031/FINAL-REVIEW.md`

**Expert output files:**
- Security: `.council/review-output/2026-05-17-2031/hunt.md`
- Refactoring: `.council/review-output/2026-05-17-2031/fowler.md`
- Frontend: `.council/review-output/2026-05-17-2031/react-ui.md`
- a11y: `.council/review-output/2026-05-17-2031/a11y.md`
- UI: `.council/review-output/2026-05-17-2031/saarinen.md`
- UX: `.council/review-output/2026-05-17-2031/friedman.md`
- LLM: `.council/review-output/2026-05-17-2031/willison.md`
- DevOps: `.council/review-output/2026-05-17-2031/deploy.md`
