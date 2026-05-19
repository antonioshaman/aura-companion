# Council Plan: Aura Companion documentation rebrand + Council Mode coverage

**Scope:** Single docs PR that rebrands leftover "Vibe-Companion" / "the-companion" surface copy to "Aura Companion" (MIT attribution preserved), documents Council Mode end-to-end, and aligns landing-site hrefs / rel hygiene with the rebrand.

**Context:** Three reader entry points must agree on brand + headline feature: `README.md` (GitHub), `docs/` (Mintlify), `landing/` (marketing). Most target files already exist substantially-complete on this branch — Council Mode guide (134 lines), architecture reference (188 lines), README §Council Mode, and `docs/index.mdx` CardGroup are all present. The remaining work is cross-surface consolidation, LLM-pipeline mental-model legibility, and surgical landing-site cleanup. No code changes beyond a `rel` attribute upgrade in two TSX files.

**Boundaries:** No edits to `CHANGELOG.md`, `web/CHANGELOG.md`, `aura/`, `conventions.md`, `WEBSOCKET_PROTOCOL_REVERSED.md`, `specs/council-mode-paired-sessions.md`, `branding.config.json`, or any file under `web/server/`, `web/src/`, `web/scripts/`. No Russian translation. No migration guide. No release tagging.

**Council dispatched (8 of 12; 4 omitted as domain-irrelevant for a docs PR — Persistence, Realtime, Subprocess, Backend):**

- UX expert — 8 recommendations (reading order, screen states, trust)
- UI expert — 10 recommendations (visual hierarchy, badge/ASCII noise, table density)
- a11y expert — 7 recommendations (alt text, rel hygiene, heading hierarchy, mobile GitHub link)
- Security expert — 6 recommendations (MIT integrity, link hardening, claim accuracy)
- Refactoring expert — 6 recommendations (DRY consolidation, stale tables, skill-count drift)
- Frontend expert — 5 recommendations (minimal-diff discipline, rel hardening, landing scope)
- LLM expert — 10 recommendations (second-opinion framing, grounding worked example, lifecycle, pairing tradeoffs, prompt versioning, restart-replay, failsafe, recordings debug, workspace-bootstrap fallback)
- DevOps expert — 6 recommendations (package-name verification, husky gate respect, docs.json schema validation, screenshot size budget, link pinning, install smoke-test)

---

## Task Sequence

### 1. README rebrand triad — lead with what / why / how-to-enable above the skills inventory

| | |
|---|---|
| **Domain** | UX expert × Carmack — Structure complexity, drive action |
| **Ref** | First-screen reader pattern; three-question test |
| **Depends on** | — |

Reposition README's first screen so the F-pattern reader hits: (1) what Aura Companion is, (2) what Council Mode is (one-paragraph differentiator), (3) one-line "enable on New Session → link to guide". Skills inventory ("29 skills") and design-skill tables move below this triad. Cross-ref: UI expert flagged the four-badge row and the duplicate ASCII diagrams — both compete with the triad for above-the-fold attention; resolved together in Task 2.

---

### 2. README signal-density cleanup — badges, ASCII, duplicate Council Mode block

| | |
|---|---|
| **Domain** | UI expert × Carmack — Noise vs hierarchy |
| **Ref** | Visual rhythm; ASCII as monospace competition with real code |
| **Depends on** | Task 1 |

Compress the four-shield badge row to two (MIT + stars). Drop the second Council Mode ASCII data-flow diagram (the screenshot above it already conveys the same model); the wire-protocol ASCII stays in the architecture reference where it belongs. Trim or remove the 16-line Self-Learning ASCII block. Cross-ref: Refactoring expert (same pattern; ASCII is restatement of guide-content).

---

### 3. README skills-count + install-command truth-up

| | |
|---|---|
| **Domain** | DevOps expert × Carmack — Validate at the boundary |
| **Ref** | Producer-side claim vs consumer-visible truth |
| **Depends on** | Task 1 |

The README claims "29 skills" four times; actual `ls .agents/skills/` is 30. Either pick one canonical statement of the count and remove the duplicates, or replace with prose that doesn't commit to a number. Separately, every `bunx the-companion ...` occurrence across README + `docs/get-started/installation.mdx` + `docs/reference/cli-and-api.mdx` + `docs/deploy/cloud-vm.mdx` + `docs/reference/troubleshooting.mdx` must be reconciled with `web/package.json` (`name: "aura-companion"`, bins: `aura-companion` / `companion` — `the-companion` is not in the bin list). Pick one resolution (rewrite docs to use `bunx aura-companion`, or publish an alias) and apply consistently.

---

### 4. README ↔ guide ↔ reference DRY consolidation — pick canonical homes

| | |
|---|---|
| **Domain** | Refactoring expert × Carmack — Single source of truth |
| **Ref** | Don't Repeat Yourself; published-interface discipline |
| **Depends on** | Tasks 1, 2 |

Designate canonical homes per topic: (a) what Council Mode is + how to enable + UI tour → `docs/guides/council-mode.mdx`; (b) wire protocol + state machine + source map → `docs/reference/council-mode-architecture.mdx`; (c) elevator pitch (≤ 8 lines) → README §Council Mode. README currently restates status-pill names, keyboard shortcuts, grounding behaviour, `fnd_<hex>` dedup — each duplicates the guide. Replace with single-link teasers. Cross-ref: UX expert (cross-link guide ↔ reference bidirectionally — no dead-ends).

---

### 5. `docs/index.mdx` — promote Council Mode to featured slot + image-path consistency

| | |
|---|---|
| **Domain** | UI expert × Carmack — Visual hierarchy mirrors narrative hierarchy |
| **Ref** | Card-grid as state machine for feature discovery |
| **Depends on** | — |

Move Council Mode out of the 2-col CardGroup into a single-column featured Card above the grid (Mintlify's "hero feature + supporting features" pattern). Standardize `<img>` `src` style across README (`docs/screenshots/...`) and `docs/index.mdx` (`./screenshots/...`) — both work in their own context but invite drift; pick one per surface and add a one-line comment. Cross-ref: UX expert (Card description must disambiguate "second observer session" vs generic).

---

### 6. `docs/guides/council-mode.mdx` — structural cleanup (anchored H2s + state-pill list + lead screenshot)

| | |
|---|---|
| **Domain** | UX expert × Carmack — Progressive disclosure with visible triggers |
| **Ref** | Reading order = spec acceptance order |
| **Depends on** | — |

Verify each H2 produces a stable slug Mintlify's right-rail TOC will surface, in exact spec order: *what feature does → enable → pairings → ObserverPanel states → shortcuts → degraded recovery*. Convert the 7-row status-pill table into an ordered list where ordering encodes the priority ladder ("top wins"). Place an ObserverPanel screenshot at the top of the guide as load-bearing (not decorative) UX — `blocker-found` state preferred. Cross-ref: UI expert (table density).

---

### 7. Guide LLM-pipeline framing — observer as fallible second opinion, what it can / cannot do

| | |
|---|---|
| **Domain** | LLM expert × Carmack — Content trust boundaries; know-your-gaps |
| **Ref** | Informed consent for LLM-pipeline UX |
| **Depends on** | Task 6 |

Add an opening "What the observer is — and isn't" paragraph stating LLM fallibility, STOP-as-prompt-to-look (not verdict), user-as-final-judge. Add a dedicated subsection "What the observer can and cannot do" enumerating: can read manifest delta + emit findings + run on next checkpoint; cannot write workspace, reach files outside checkpoint, persist memory across phases, run tests, execute code, see orchestrator conversation. Cross-ref: Security expert — same framing rules out marketing-grade "Council Mode prevents X" claims.

---

### 8. Guide — grounding gate worked example + finding lifecycle + restart-replay determinism

| | |
|---|---|
| **Domain** | LLM expert × Carmack — Make the rule legible by example |
| **Ref** | Concrete over abstract; observability boundaries |
| **Depends on** | Task 7 |

Add a 6-10 line worked example tracing one finding: observer flags `STOP` against an unmodified file → server downgrades to NOTE → BlockerBanner does not fire → finding visible in FindingsLog with DOWNGRADED chip + reason. Add a "Finding lifecycle" subsection with four user-visible states (raised → resolved | downgraded | superseded | archived). Promote restart-replay determinism from a half-sentence in README to a named paragraph: `fnd_<hex>` is deterministic given `(sessionGroupId, checkpointId, observerProvider, findingIndex, evidence_path, claim)`; claim text is NOT deterministic (LLM non-determinism).

---

### 9. Guide — pairing tradeoffs explicit; troubleshooting fixes (bundled-fallback, failsafe wake, recordings debug row)

| | |
|---|---|
| **Domain** | LLM expert × Carmack — Failure-mode honesty |
| **Ref** | Stream lifecycle + observability principles |
| **Depends on** | Task 8 |

Expand the `claude+codex` pairing row's "When to pick" with the correlated-failure-mode argument (two Claudes echo each other's blind spots; Codex surfaces what same-family observers rationalise past) and concrete costs (asymmetric tooling, separate billing, prompt tuned on Claude). Fix the troubleshooting table's first row — ENOENT on `.council/prompts/observer-system.md` does NOT block spawn (bundled fallback fires + WARN log); only EACCES / EISDIR / ELOOP block. Add: (a) failsafe-wake row noting 5-min upper bound on observer latency (EC-13), (b) "observer flagged something suspicious" row anchored on `~/.companion/recordings/` for raw observer output + manifest + grounding-gate decision.

---

### 10. `docs/reference/council-mode-architecture.mdx` — link `conventions.md` (drop stale table); mark Source map snapshot-as-of

| | |
|---|---|
| **Domain** | Refactoring expert × Carmack — Remove published interface born stale |
| **Ref** | DRY across canonical sources |
| **Depends on** | — |

Delete the 22-line in-page convention-floor table (lists AP-1..3 + EC-1..9; canonical `conventions.md` is already at AP-1..4 + EC-1..32). Replace with one paragraph + link: "Council Mode is constrained by AP-/EC- conventions in `conventions.md` — reviewers MUST NOT re-flag these." For the Source-map table, prepend a one-line snapshot caveat ("Snapshot as of `<commit-sha>` — `git grep` is authoritative.") or delete entirely since the prose above already cites load-bearing files inline at the point they matter.

---

### 11. Reference — prompt versioning audit affordance + factual accuracy of security-property prose

| | |
|---|---|
| **Domain** | LLM expert × Security expert — Observability + documentation-as-trust-boundary |
| **Ref** | Prompt-SHA + provenance stamping; pull invariants from code |
| **Depends on** | Task 10 |

Expand the `observer-system.md` subsection to explain why `<!-- observer-system-prompt v1 -->` + `observerPromptSha256` + `observerPromptSource: "workspace" | "bundled"` matter to a user reading findings (same hash → comparable findings; different hash → expect drift; WARN log `council.observer-prompt.bundled-fallback` indicates substitution). Lock the existing observer-write-boundary / grounding-gate / group-authorization prose against `web/server/observer-write-policy.ts` / `observer-grounding.ts` / `group-authorization.ts` and the corresponding `EC-` invariants — paraphrase via convention IDs, not free prose. Cross-ref: Security expert — do not introduce "Council Mode prevents X" framing anywhere (creates disclosure obligation; spec's "Ask first" on attribution-line edits applies to security-claim edits with equal force).

---

### 12. `docs/docs.json` — schema validation + nav grouping + pages-exist canary

| | |
|---|---|
| **Domain** | DevOps expert × Carmack — Mechanically check what can be checked |
| **Ref** | Pre-merge validation; SSOT for sidebar |
| **Depends on** | Tasks 6, 10 |

Verify each entry in `docs.json` `pages` arrays has a matching `.mdx` file on disk (mechanical loop). Confirm `$schema` URL still validates the current file. Ensure Council Mode guide lives under "Guides" group and architecture reference under "Reference" group — not as siblings in a flat nav (UX expert: respect expertise levels). Guide must precede reference visually within its group.

---

### 13. Landing `Nav.tsx` + `Footer.tsx` — `rel="noopener noreferrer"` hardening; preserve MIT attribution text

| | |
|---|---|
| **Domain** | Frontend expert × Security expert — Diff-minimality + secure defaults |
| **Ref** | Three's-a-pattern for `target="_blank"`; MIT credit obligation |
| **Depends on** | — |

Upgrade `rel="noopener"` → `rel="noopener noreferrer"` on all six `target="_blank"` anchors in `Nav.tsx` (2) + `Footer.tsx` (4). Do NOT remove or reword the MIT attribution text in Footer L4-13 — spec's 🚫 Never rule and "ask first" rule both apply. Acceptance criterion "no remaining upstream `The-Vibe-Company` URLs on landing" is in tension with MIT obligation; resolve by keeping the attribution prose intact (legally required) while ensuring no NAVIGATION links target upstream. Cross-ref: UX expert (Footer attribution should be one calm paragraph, not a link chain).

---

### 14. Screenshot polish — alt text rewrite, width=100%, image-path consistency, optional pngquant

| | |
|---|---|
| **Domain** | a11y expert × UI expert — Equivalent purpose for non-text content |
| **Ref** | WCAG 1.1.1 alt as purpose, not inventory |
| **Depends on** | Task 5 |

Rewrite alt strings on the three load-bearing screenshots (`aura-companion-hero.png`, `council-mode-overview.png`, `council-mode-anatomy.png`) from component-inventory style ("ProviderBadges, BlockerBanner with STOP, DegradedBanner, FindingsLog ...") to ≤125-char one-sentence purpose ("Council Mode shows orchestrator chat alongside the observer panel surfacing a STOP finding."). Apply `width="100%"` to body screenshots in MDX. Optional: run new PNGs through pngquant before commit (≤200 KB each; docs/screenshots/ soft cap ~3 MB). Capture ObserverPanel screenshot via `agent-browser` for the PR body separately.

---

### 15. Cross-surface brand + claim audit + husky pre-commit gates

| | |
|---|---|
| **Domain** | Security expert × DevOps expert — Final validation at boundaries |
| **Ref** | Mechanical canaries before merge |
| **Depends on** | All prior tasks |

Run mechanical grep canaries: (a) `grep -rni "vibe.companion\|the-companion" README.md docs/ landing/src/` — only matches must be MIT-attribution text and `branding.config.json` `keepUpstreamMarker` opt-outs; (b) zero "Council Mode prevents X" / "secure against X" framing across user-facing copy (Hunt R5); (c) no broken cross-doc anchors (anchor-level links removed in favour of page-level per Refactoring expert R6). Run `cd web && bun run typecheck && bun run test` to satisfy husky pre-commit. Verify the `bunx aura-companion --version` smoke path against `npm view aura-companion version`.

---

## Risks & Watchpoints

- **Refactoring expert — Anchor stability:** Consolidating restatement into links (Tasks 4, 11) only pays off if anchors are stable. Prefer page-level links over `#anchor` deep links when the heading might be renamed. Bookmarked deep links rot silently.
- **LLM expert — Documentation drift from code invariants:** The reference's security-property prose (Task 11) must paraphrase via convention IDs (EC-1, EC-7, EC-2), not free language. The next code refactor could quietly invalidate a free paragraph but cannot invalidate a convention citation without also updating `conventions.md` — which is the gate.
- **Security expert — Marketing-grade security claims:** Drafting Council Mode copy is the moment to write "Council Mode helps you catch X" not "Council Mode prevents X." The latter creates an asymmetric disclosure obligation the first bypass report turns into a CVE.
- **a11y expert — Double-H1 risk in MDX:** Both `.mdx` files have YAML front-matter `title:` AND a body `# Heading`. Mintlify config determines which renders; double-H1 is a WCAG 1.3.1 failure. Manual verification step before merge.
- **DevOps expert — Husky gate friction on docs commits:** The pre-commit runs full typecheck + tests + bundle canary on every commit, including pure docs. Resist adding path-filter bypass — the bundle-drift gate (`build-observer-prompt-bundle && git diff --exit-code`) is load-bearing.
- **UX expert — Story 2 reading-order regression:** The guide's H2 order is the spec acceptance contract. Reorganizing for prose flow without preserving the exact spec order can quietly break acceptance.
- **DevOps expert — `bunx the-companion` mismatch:** The current docs assume a package binary that does not exist in `web/package.json`. Task 3 must resolve this — silent install failure for every new user is a P1-grade docs defect.
- **Refactoring expert — Skill count off-by-one:** Disk truth is 30; README claims 29 four times. Trust on the front page erodes fast when readers `ls` and find a different count.

---

## External Setup Required

| # | What | Why | Blocking task |
|---|------|-----|---------------|
| 1 | Confirm npm publish strategy for the `bunx` command name (rename in docs, or publish `the-companion` alias) | Docs vs `package.json` bin mismatch; current install path is broken | Task 3 |
| 2 | Capture an ObserverPanel screenshot via `agent-browser` in `blocker-found` or `reviewing` state | Spec mandates an embedded screenshot in PR body | Task 14 |
| 3 | Verify Mintlify deploy webhook fires on push-to-main (no GHA gate) and `docs.json` schema URL still resolves | Mintlify build is the only gate; happens downstream of merge | Task 12 |

---

## Summary

| # | Task | Domain | Depends on |
|---|------|--------|------------|
| 1 | README rebrand triad — lead with Council Mode | UX expert | — |
| 2 | README signal-density cleanup (badges, ASCII) | UI expert | 1 |
| 3 | README skills-count + `bunx` command truth-up | DevOps expert | 1 |
| 4 | README ↔ guide ↔ reference DRY consolidation | Refactoring expert | 1, 2 |
| 5 | `docs/index.mdx` Council Mode card promotion | UI expert | — |
| 6 | Guide structural cleanup (anchored H2s + state list) | UX expert | — |
| 7 | Guide LLM-pipeline framing (fallible observer) | LLM expert | 6 |
| 8 | Guide grounding worked example + lifecycle + determinism | LLM expert | 7 |
| 9 | Guide pairing tradeoffs + troubleshooting fixes | LLM expert | 8 |
| 10 | Reference — link `conventions.md`; Source-map caveat | Refactoring expert | — |
| 11 | Reference — prompt versioning audit + claim accuracy | LLM × Security expert | 10 |
| 12 | `docs.json` schema validation + nav grouping | DevOps expert | 6, 10 |
| 13 | Landing `rel` hardening; preserve MIT attribution | Frontend × Security expert | — |
| 14 | Screenshot polish (alt + width + paths) | a11y × UI expert | 5 |
| 15 | Brand + claim audit + husky gates | Security × DevOps expert | all prior |

## Verdict

The most important architectural decision in this plan is **picking the canonical home for each Council Mode fact and reducing the other two surfaces to teaser-plus-link** (Task 4). Three independent experts (Refactoring, UX, LLM) flagged the same drift surface from different angles: a fact stated in README + guide + reference is a fact that will rot in two places the next time anything changes. The LLM expert's domain is the most critical for user trust — the observer's mental model (fallible second opinion, grounded findings, restart-replay determinism) is what separates Council Mode from "AI says X, deal with it." If a pair agent (observer) is especially valuable during build, **Saarinen's UI lane** is the one to keep close: the README's three ASCII blocks vs the screenshots is the decision most likely to ship in a state nobody is happy with if left until the polish pass. Start with Task 1 — every later task depends on the README's first screen having repositioned the product.
