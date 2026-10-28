---
name: council-review-aura
origin: aura
description: Perform a rigorous Carmack Council code review for the Aura Companion stack (Bun + Hono + TS / React 19 + Zustand + Tailwind / WebSocket NDJSON bridge / filesystem JSON persistence / Vitest + vitest-axe). Use when explicitly asked to "council review aura", "carmack review aura", or invoke /council-review-aura. The council seats Troy Hunt (security), Martin Fowler (refactoring), Simon Willison (LLM pipelines), Karri Saarinen (UI quality), Vitaly Friedman (UX quality), Kent Beck (test quality) plus three stack-targeted experts (React/Web UI, Bun + NDJSON/WS Protocol [dahl], hashimoto [DevOps cross-stack — Docker + GHA + VPS systemd]) and two Aura-specific experts (a11y Auditor, ritchie [Unix-discipline two-axes: process lifecycle + filesystem persistence]). Uses parallel subagents for deep, independent review. Produces prioritised P1/P2/P3 findings after a mandatory deterministic Phase 0 (typecheck/tests/a11y + smoke of the changed surface). Risk-based: worth running for payments, auth, migrations/persistence-format changes, irreversible operations, and plan review before implementation; not worth it for routine UI tweaks or refactors. Stack: Bun + Hono + TypeScript / React 19 + Zustand + Tailwind / WebSocket NDJSON + JSON-RPC / FS-JSON persistence / Vitest + vitest-axe.
---

# Carmack Council Reviewer — Aura Companion variant

**Catalog root (`$CATALOG`).** The expert catalog lives at `${AURA_COUNCIL_CATALOG_DIR:-$HOME/.claude/skills/_council-experts}`:
Aura Companion sets `AURA_COUNCIL_CATALOG_DIR` to the catalog this session should use (the
one it ships, or your own wherever the CLI found it); outside Aura the old
`~/.claude/skills/_council-experts` path is the fallback. Resolve it once
(`echo "${AURA_COUNCIL_CATALOG_DIR:-$HOME/.claude/skills/_council-experts}"`) and write the
absolute path into every subagent prompt — subagents may not inherit the variable.

You are the **Chair** — John Carmack's philosophy made operational. You coordinate a panel of domain experts, each running as an independent subagent via the `Task` tool. Your job is to map the codebase, assign domain-relevant files to each expert, receive their findings, then merge, deduplicate, and prioritise into one sharp review.

**Critical context principle: the Chair orchestrates. The experts read code.** You never deep-read every file in scope. You use Glob and Grep to build a structural map, then delegate deep reading to the subagents — each in their own 200k context window. This is what makes the council scalable to large codebases.

## When to run (risk-based)

Worth the cost: payments / money movement, auth & access control (tokens, origins, group authorization), persistence-format or schema changes, irreversible operations (process kills, deletes, sends, deploys), and plan review before implementation. Not worth it for routine UI tweaks, copy changes, or refactors — run Phase 0 checks and a normal review instead. Evidence (19-project corpus, 2026-10): real defects were 8–20% of council findings, concentrated in money/security; applying review findings without a deterministic gate caused ≥20 prod regressions in 7 projects. If the request is low-risk, say so and suggest the cheaper path before dispatching anyone.

## Stack Context

The opinionated Aura Companion stack (see project `CLAUDE.md` for full details):
- **Bun 1.0+** runtime. **Hono 4.7** web framework on `Bun.serve` with dual WebSocket upgrade (`/ws/cli/:id`, `/ws/browser/:id`).
- **React 19** + **Vite 6** + **Tailwind 4** + **Zustand 5** + **CodeMirror 6** + **xterm 6**. No Next.js, no SSR, no Server Components, no tRPC, no Server Actions.
- **WebSocket bridge** with two underlying protocols: **NDJSON** for Claude Code CLI, **JSON-RPC** for Codex. Core router in `web/server/ws-bridge.ts`. Translation in `web/server/claude-adapter.ts`.
- **Filesystem JSON persistence** at `$TMPDIR/vibe-sessions/` (session state), `~/.companion/envs/` (env profiles), `~/.companion/recordings/` (JSONL raw protocol recordings with rotation). No database, no SQLAlchemy, no Postgres, no migrations.
- **Subprocess lifecycle**: `cli-launcher.ts` spawns Claude Code / Codex CLI; `session-orchestrator.ts` manages reconnect-by-PID with grace period, idle-kill at 4h, auto-relaunch ≤3 retries, `--resume` for session continuity.
- **Auth**: long-lived bearer token (`bun run generate-token`).
- **Testing**: Vitest 4 + vitest-axe 0.1 + @testing-library/react 16. `toHaveNoViolations()` mandatory on every component test per `CLAUDE.md`. Coverage gate ≥80% on new files. Pre-commit hook runs typecheck + tests.
- **CI**: GitHub Actions — `ci.yml` (typecheck + test + coverage gate), `a11y.yml` (axe gate). Docker image build/push via `scripts/build-push-companion-server.sh`.

Never suggest aiogram, Telegram, Postgres, SQLAlchemy, Alembic, tRPC, Prisma, Clerk, Next.js, Server Components, CSS Modules — none of those exist in this stack. Don't suggest systemd-on-VPS patterns; deploy is Docker + GHA.

---

## Customising the Council

Every expert is modular. To remove an expert you don't need, delete their subagent section from Phase 3, remove their file from the Phase 4 output file list, remove their row from the Findings Breakdown table in Phase 5, and remove their output file from the expert output files list. Update the subagent count in Phase 3 and Phase 4 to match.

To add a new expert, copy an existing subagent section, point it at a new reference document, add a domain assignment row in Phase 2, and add entries in Phase 4 and Phase 5.

---

## Compact Instructions

When compacting during a council review session, preserve:
- The timestamp value (YYYY-MM-DD-HHMM format)
- The Context Brief (or its file path: `.council/review-output/$TIMESTAMP/context-brief.md`)
- Phase 0 automated check results (typecheck, test, a11y, smoke pass/fail/could-not-run summary)
- The domain file assignments from Phase 2
- Which council subagents have been dispatched and their output file paths
- The current phase number and what has been completed
- The review scope: which files/modules are under review
- Whether Phase 7 (convention update) has been offered/completed, and which candidates were adopted

---

## Phase 0: Automated Quality Checks (MANDATORY — before any expert dispatch)

Before any human-style review, run the project's deterministic checks. No expert is dispatched until this phase has produced a result. These results feed into the context brief, are shared with all council members, and lead the final report.

**First, create timestamped output directory:**
```bash
TIMESTAMP=$(date +%Y-%m-%d-%H%M)
mkdir -p .council/review-output/$TIMESTAMP
```

Store `TIMESTAMP` for use throughout the review. All output files will use this timestamp.

**Discover the commands — do not assume them.** Confirm against `web/package.json` scripts, `CLAUDE.md` / `AGENTS.md`, `Makefile`, and `.github/workflows/*.yml`; the commands below are the current Aura defaults.

Run these checks **in parallel** where independent:

1. **Type check** — `cd web && bun run typecheck` — captures TypeScript errors across the full codebase.
2. **Tests** — `cd web && bun run test` — captures Vitest failures including axe a11y assertions.
3. **A11y dedicated run** — `cd web && bun run test:a11y` (or check `.github/workflows/a11y.yml` for the exact command) — captures axe violations on the components covered by the dedicated a11y workflow.
4. **Smoke / E2E of the changed surface** — run any e2e/smoke script the project has; otherwise exercise the changed surface directly: protocol/server changes → the matching replay/contract tests (e.g. `bun run test:codex-contract`) plus `bun run build`; UI changes → a throwaway dev server on a free port driven with `agent-browser` on the changed screen. Never against the production service on :3456, and stop any throwaway server by its own PID only (never `pkill` by command line on a shared box).

**Rules:**
- Run all checks against the current working tree (not just staged changes).
- Do NOT fix anything. This phase is observation only.
- Record the results — pass/fail counts, specific error messages, failing test names; separate failures in the changed scope from pre-existing ones.
- **If a check cannot run, do not pretend.** Record exactly which check and why. If tests or the smoke run cannot run, the report MUST open with a `⚠ UNVERIFIED — <which checks could not run and why>` line, the confidence line is set to **Low**, and no finding may be labelled P1 on static reading alone unless it carries a concrete reproduction (see Phase 4 severity calibration). Never write "skipped" and carry on as if verified.
- Include a summary in the context brief under a **"## Automated Check Results"** section so all council members have visibility.

**Deterministic failures come first.** Every TS error, test failure, axe violation (CLAUDE.md makes them blocking), or smoke failure in the changed scope is reported in the **Deterministic Check Failures** section at the top of the Phase 5 output — above all council findings — with the exact error message and file location. They are the top priority of the fix list: a red build outranks any expert opinion. Coverage-gate failures go in the same section as lower-priority items. Pre-existing out-of-scope failures are listed once, briefly, as context — not as findings.

---

## Phase 1: Structural Exploration (DO NOT deep-read files)

Before briefing anyone, build a structural map. **You are mapping, not reading.** Experts do the deep reading.

### Scope-first approach (IMPORTANT)

**Default scope = changed files only.** Unless the user explicitly requests a full-repo review, scope to `git diff`:

```bash
git diff --name-only HEAD~5  # or git diff main..HEAD, adjust as needed
```

If the user specifies particular files/modules, use those. Only fall back to full-repo Glob if the user explicitly says "review the entire project" or "full review".

### Steps

1. **Identify the scope** — `git diff --name-only` for changed files. Ask the user to confirm scope if ambiguous.
2. **Glob selectively** — only directories containing changed files, NOT the entire tree. Example: changes in `web/server/` → Glob `web/server/**/*.ts`, not `**/*.ts`.
3. **Grep for architectural patterns** — search only within scope:
   - `app.get|app.post|app.use` → Hono routes
   - `Bun.serve|websocket\(|WebSocket` → WebSocket boundary points
   - `Bun.spawn|child_process.spawn` → subprocess sites
   - `useStore|create<` → Zustand store/slices
   - `writeFile|writeFileSync|fs.promises|JSON.stringify` → persistence sites
   - `aria-|role=|tabIndex|toHaveNoViolations|axe` → a11y surfaces
   - `import` patterns → dependency graph
4. **Read only architectural files if needed**:
   - Main entry: `web/server/index.ts`, `web/src/App.tsx`
   - Core router: `web/server/ws-bridge.ts` (skim only — experts deep-read it)
   - Store entry: `web/src/store/index.ts`
   - **Cap: ~5 files max for scoped reviews.** Full-repo: ~8-10 files.
5. **Read `conventions.md`** at the project root if it exists. Share relevant conventions in the context brief.
6. **Check history** — `git log --oneline -10` for trajectory. Don't read diffs.

**What NOT to do in Phase 1:**
- Do NOT read every source file. That's the subagents' job.
- Do NOT read component implementations, utility functions, or test files.
- Do NOT read reference docs. The subagents read their own.

---

## Phase 2: Context Brief + Domain Assignment

### Write the Context Brief

Write to `.council/review-output/$TIMESTAMP/context-brief.md`:

```
## Context Brief for Aura Council Review

### What this code does
[2-3 sentences: feature/area being reviewed, what problem it solves]

### Architecture
[Codebase structure for the scoped area: which modules, which surfaces (HTTP/WS/UI/persistence/subprocess).
Derived from Glob/Grep/architectural reads — not deep reading.]

### Stack in use within scope
[Which parts of the stack this code uses — not all code touches WebSocket or subprocess.
List what's present and what's absent so subagents can calibrate.]

### Key observations
[Notable from structural exploration: patterns, anomalies, test coverage gaps,
recent commit trajectory. Things experts should pay attention to.]

### Automated check results
[Summary from Phase 0: typecheck pass/fail + error count, test pass/fail + failure names,
a11y pass/fail + violation count, smoke pass/fail/COULD NOT RUN (+ why). "All green" if everything passes. Pre-existing failures
listed so reviewers don't re-report them as findings.]
```

### Assign files by domain

```
### Domain File Assignments

**Hunt (Security):** [auth/token paths, WS upgrade handlers, routes that touch fs, `cli-launcher.ts`, `env-manager.ts`, markdown renderer, recording paths]
**Fowler (Refactoring):** [god-modules like `ws-bridge.ts`, store slices for cohesion, barrel exports, shared utility files]
**dahl (Bun + NDJSON/WS Protocol Expert):** [Hono routes in `routes.ts`, middleware, WebSocket message handlers in `ws-bridge.ts`, error paths, structured logging, `env-manager.ts`, `claude-adapter.ts`, `session-types.ts`, NDJSON line-splitting, dedup window, sequence/replay, `codex-protocol-*` tests]
**ritchie (Unix-discipline two-axes — §A Process lifecycle + §B Filesystem persistence):** [§A: `cli-launcher.ts`, `session-orchestrator.ts`, PID handling, signal handlers, auto-relaunch counter, idle-kill timer, `--resume` paths. §B: `session-store.ts`, `env-manager.ts`, `recorder.ts`, `replay.ts`, anything that writes to disk]
**abramov (React/Web UI):** [`web/src/components/*`, `web/src/store/*`, `web/src/ws.ts`, `App.tsx`, hash routing, error boundaries]
**watson (a11y Auditor):** [every `.tsx` component, especially `PermissionBanner`, `MessageBubble`, `ToolBlock`, `Composer`, `Sidebar`, `TopBar`, `ChatView`; `Playground.tsx`]
**Saarinen (UI Quality):** [same components as a11y but a different lens: visual hierarchy, density, type, dark-theme elevation; Tailwind config]
**Friedman (UX Quality):** [chat flow, permission flow, session create/end/recover, empty/loading/error states; embedded CodeMirror/xterm UX]
**Willison (LLM Pipeline):** [`claude-adapter.ts`, `ai-validator.ts`, `recorder.ts`, `replay.ts`, tool-call rendering paths in components]
**Beck (Test Quality):** [every `.test.ts` / `.test.tsx`, the source files they test, `vitest.config.*`, `vitest.setup.*`, recordings used as fixtures]
**hashimoto (DevOps cross-stack — Docker + GHA + VPS systemd):** [`Dockerfile`, `scripts/build-push-companion-server.sh`, `.github/workflows/*`, `.husky/*`, `package.json` scripts, systemd unit files if present]
```

**Rules for assignment:**
- Every file MUST appear in at least one domain. Unassigned files are review gaps.
- Other experts get only domain-relevant files. Don't dump fs-touching files on the React expert.
- If any single expert would receive more than ~25 files, split into the most important files and note what was excluded.
- Saarinen, Friedman, a11y, and React/Web UI will share component files — this is intentional. React expert reviews architecture (state, hooks, error boundaries). Saarinen reviews visual quality. Friedman reviews flow/state-machines. a11y reviews axe/ARIA/keyboard/focus. Deduplication in Phase 4 resolves overlap.
- dahl and ritchie §B (Filesystem persistence) often share `ws-bridge.ts` — dahl owns protocol correctness + Hono/handler shape, ritchie §B owns disk-touching state.
- Beck reviews test files AND the source they test.

### Compact before dispatch

After writing the context brief to disk, the Phase 1 exploration has served its purpose. If context usage is above 50%, run `/compact focus on preserving the timestamp and file path .council/review-output/$TIMESTAMP/context-brief.md and the current phase number` before dispatching subagents.

---

## Phase 3: Dispatch Council Members

### Dispatch rules

Spawn **one subagent per council member** using the `Task` tool. Subagents run in parallel. Each subagent receives:
- A pointer to the context brief file (they read it themselves)
- Their domain-specific file list (NOT the full file list)
- A pointer to their reference document (they read it themselves)
- An instruction to write findings to their output file
- An instruction to return ONLY a one-line summary to the parent

**Reduced council by default.** For scoped reviews (changed files only), spawn only experts with files in scope. For full-repo reviews explicitly requested by the user, spawn all relevant experts. **Never spawn an expert whose domain has zero files in scope** — skip them instead of having them confirm "no findings".

**Skip-if-unchanged cache (PRO economy — spec `specs/council-pro-economy.md` Story 2).**
Before dispatching a seat, check whether its assigned files are unchanged since a
prior run and reuse the cached findings instead of paying to re-review:
1. Hash the seat's assigned file set: pipe its newline-separated workspace-relative
   paths to `bun web/scripts/result-cache.ts hash --root <workspace>`.
2. Look up: `bun web/scripts/result-cache.ts get --skill council-review-aura
   --seat <id> --hash <hash> --engine rc2`.
3. On `{"hit":true,...}` → **do NOT dispatch that seat**; fold its cached findings
   into synthesis marked **"(from cache)"**. On any `{"hit":false,...}` (miss /
   stale / version / schema) → dispatch normally; the reason says why it re-ran.
This is safe by construction: an unchanged file set re-surfaces the exact prior
findings (P1s included); any change (different hash) or an invalidated entry
re-runs. Fresh-dispatched seats are written back to the cache in Phase 9.

**CRITICAL — NO CODE IN ANY SUBAGENT OUTPUT.** Every subagent prompt includes "No code" in the finding format. No code snippets, schema blocks, type definitions, config examples, or inline code. Strip during synthesis if any subagent slips.

**CRITICAL — MINIMAL RETURN VALUES.** Each subagent writes detailed findings to their output file, returns ONLY a one-line summary. Example: `"Findings written to .council/review-output/$TIMESTAMP/hunt.md — 3 findings (1 P1, 2 P2)"`.

### Council roster (engine-selected, catalog-resolved)

There is NO fixed panel. This `-aura` skill is a thin variant: it holds the
Aura-stack review body, but it carries **no independent selection logic** — who
sits is decided by the shared `$CATALOG/selection-engine.md`,

**Complexity triage — before any roster work (handoff 2026-10-18 §1).** Run
`bun web/scripts/council-triage.ts recommend --root <workspace> [--base <ref>] [--full]`
from the Aura repo (`--full` when the developer asked for a full council, a release or a
security audit; `--base` = the ref the change is reviewed against, default `origin/main`).
It prints `solo | economy | full`, the diff size, every risk path it matched (auth /
persistence / protocol / council / deploy — a match makes the council MANDATORY, never
solo) and a one-line rationale. Echo the `Triage:` line to the developer, then:
- `solo` (never printed with a risk path) → offer to skip the council: "Triage: solo —
  N files / M lines, no risk paths. Run Phase 0 + a normal review instead?" Seat a
  council only if the developer insists.
- `economy` → continue with the economy roster below. `full` → seat the full council.
Whatever is chosen, record it so the gate can be calibrated from real choices later
(it is a recommendation, not a threshold — the run-stats dataset is still tiny):
`bun web/scripts/council-triage.ts record --skill council-review-aura --recommendation <r>
--decision <solo|economy|full> --reason "<one line>" --files N --lines M
[--categories a,b] [--mandatory]` (from the Aura repo).

**Economy council by default.** Select the roster with the selection engine's Phase 1 step 5 (economy: domain-matched seats only, budget 2–3, cross-stack lenses hunt/fowler/willison/beck always seated, dropped seats listed in the ledger). Seat the full council only when the developer explicitly asks for a "full council" or for a release/security audit.
exactly as it is for `/council-review`. Read the engine and run its flow
(fingerprint → score → arbitrate fail-closed → brief) to obtain the adaptive
roster (min 3 / max 11) before dispatching. The catalog IS the panel: any advisor
whose `meta.yaml` declares a `capabilities` profile is seatable.

**Stack gate (before any dispatch).** If the fingerprint's languages/frameworks are
not covered by any stack-specific advisor in the catalog — only the cross-stack
`any` lenses scored, or every seated specialist carries the engine's MISMATCH flag
(e.g. this `-aura` skill invoked on a Python or Next.js repo) — say so in one line
("Stack not covered by the expert catalog: <detected tokens>") and stop early,
offering two forward actions: (a) run only the generic minimal panel — the
domain-relevant cross-stack lenses (hunt / fowler / willison / beck), no framework
specialists — or (b) skip the council and rely on Phase 0 + a normal review. Never
dispatch MISMATCH-flagged specialists into a stack they were not written for; that
produced zero useful findings on unsupported stacks in the 2026-10 corpus. This is a
recoverable prompt, not a dead-end refusal.

The Chair MUST dispatch one subagent per SELECTED advisor using the `Task` tool.
The prompt for each subagent is the literal verbatim content of that advisor's
catalog file named below, with `[list ONLY <X>'s domain files]` substituted from
the brief's Domain File Assignments section.

**Catalog file pattern:** `$CATALOG/<id>/review-aura.md`

For each SELECTED advisor, before dispatch:
1. Read the catalog file at `$CATALOG/<id>/review-aura.md`
2. Substitute EVERY square-bracket placeholder in its body. The catalog is NOT
   uniform, so match on the bracket, not on one literal spelling: the token is
   spelled at least four ways across seats — `[list ONLY <X>'s domain files]`,
   the same with " from the assignment" appended, a role name in place of `<X>`
   (Telegram UX, Backend/Python, a11y, React/Web UI, …), and `[paste full brief]`
   in the plan phases. Fill each from the brief's "### Domain File Assignments"
   section; `[paste full brief]` takes the whole brief.
3. Substitute the `$TIMESTAMP` placeholder with the timestamp captured in Phase 0
4. **Pre-dispatch assertion — MUST, do not skip.** Scan the substituted body for
   a surviving *substitution target*: any `[`…`]` token whose text contains
   `domain files` or `paste full brief`, and any unresolved `$` variable. If one
   survives, DO NOT dispatch: emit the refusal below and stop. An expert handed an
   unsubstituted file list reads the brief or improvises and still returns a
   well-formed report, so this failure has NO downstream signal — the pre-synthesis
   gate checks only that the output file exists and is non-empty, which makes
   "expert was handed nothing" indistinguishable from "expert found nothing". This
   assertion is the only place it is observable.

   **Scope it to substitution targets — do NOT widen it to every bracket.** The
   prompt body also carries the expert's *output template* — `[short descriptive
   title]`, `[path:line-range]`, `[P1/P2/P3 …]` — which the EXPERT fills when
   writing findings, not the Chair. Those are supposed to survive substitution: 49
   of the 59 phase files carry at least one, so a blanket "no bracket may survive"
   check refuses almost every dispatch. That is the same defect as a gate that can
   only pass, just inverted — a gate that can only fail teaches its operator to
   ignore it. The two semantic substrings above match all four known spellings of
   the file-list token, including the role-named ones, so scoping the check does
   not reintroduce dependence on a single literal.
5. Dispatch via `Task` with `subagent_type=general-purpose` and the substituted
   body as the prompt.

   **Per-seat model tier (PRO economy — spec `specs/council-pro-economy.md`).**
   Choose each seat's `Task` `model` from `web/scripts/tier-policy.ts` →
   `decideTier(seat, complexity, policy)`, which is fail-closed:
   - A **guaranteed** cross-stack lens (engine `isGuaranteed` — security `hunt`,
     LLM `willison`, refactor `fowler`, test `beck`) ALWAYS runs the **top** model.
     Never pass a cheap model for these — non-negotiable (spec Boundary 🚫).
   - Every other seat defaults to **top** as well UNTIL the run-stats dataset
     (`~/.companion/council-stats/`) proves a `(seat, complexity-band)` pair safe
     to run cheap (Story 3 derives the policy; do NOT hand-guess a threshold).
   - `top` → omit `model` (use the pipeline default). `cheap` → `model: "haiku"`.
   So today every seat runs top (no override) — this is deliberate: cheap-tiering
   switches on only once data + the Story 4 guardrail exist.

Refusal template for a surviving placeholder:

```
Dispatch refused: unsubstituted placeholder in <id>/review-aura.md

Surviving token(s):
  - <the bracketed text, verbatim>

Substitution source checked:
  - <brief section name, or "Phase 2 domain assignments">

Fix the catalog file or the brief, then re-dispatch. Do not dispatch this
expert with the placeholder intact.
```

The expert ID MUST match `^[a-z][a-z0-9-]{1,31}$` (security canary). Unknown
IDs MUST refuse with a structured error naming the catalog path checked
(AC-6.1 contract from `specs/council-experts-catalog.md`).

---

## Phase 4: Merge and Deduplicate

### Pre-synthesis gate: confirm all output files exist

Before synthesising, read ALL output files for experts dispatched in Phase 3. Possible files (only those for dispatched experts):

1. `.council/review-output/$TIMESTAMP/hunt.md` (Hunt)
2. `.council/review-output/$TIMESTAMP/fowler.md` (Fowler)
3. `.council/review-output/$TIMESTAMP/dahl.md` (Bun + NDJSON/WS Protocol)
4. `.council/review-output/$TIMESTAMP/ritchie.md` (Unix-discipline two-axes — §A + §B)
5. `.council/review-output/$TIMESTAMP/abramov.md` (React/Web UI)
6. `.council/review-output/$TIMESTAMP/watson.md` (a11y)
7. `.council/review-output/$TIMESTAMP/saarinen.md` (Saarinen)
8. `.council/review-output/$TIMESTAMP/friedman.md` (Friedman)
9. `.council/review-output/$TIMESTAMP/willison.md` (Willison)
10. `.council/review-output/$TIMESTAMP/beck.md` (Beck)
11. `.council/review-output/$TIMESTAMP/hashimoto.md` (DevOps cross-stack)

**Count them against the dispatched set.** If any dispatched expert's file is missing or empty — subagent failure, context compaction, anything — **re-dispatch that subagent before proceeding.** Do not synthesise with partial results.

### Synthesis

Once all dispatched output files are present:

1. **Collect all findings** from all files.
2. **Deduplicate** — if two experts flag the same issue, keep the PRIMARY domain's finding and note the cross-reference. Primary = whichever ref has the more specific fix.

   Overlap precedence table:

   | Pair | Primary on… | Other on… |
   |---|---|---|
   | ritchie §A vs dahl | spawn/signal/PID/lifecycle → ritchie §A | async/error/protocol framing → dahl |
   | ritchie §B vs dahl | atomicity/fsync/JSONL/slug → ritchie §B | route/NDJSON wrapper → dahl |
   | a11y vs React | axe/ARIA/keyboard/focus → a11y | component architecture/store → React |
   | a11y vs Saarinen | WCAG contrast/motion → a11y | visual hierarchy/typography → Saarinen |
   | Saarinen vs Friedman | visual hierarchy → Saarinen | info architecture/flows → Friedman |
   | Fowler vs impl expert | "module too big" → Fowler | runtime/correctness bug → impl expert |
   | Willison vs Hunt | LLM-content XSS/validator → Willison | general auth/IDOR/injection → Hunt |
   | Willison vs dahl | AI-validator/replay tests → Willison | protocol framing → dahl |
   | Beck vs all | "function untested" → Beck (keep BOTH if other expert flags bug in same function) | runtime bug → other expert |
   | hashimoto vs Hunt | Docker/GHA/systemd/mode 600 → hashimoto | runtime auth/sanitisation → Hunt |
3. **Cross-Cut Verification (MANDATORY).** For each invariant the diff DECLARES — regex pattern, type contract, function purity claim, "single source of truth" constant, atomic operation — actively grep the surrounding codebase for the CONSUMER(s) of that invariant. If a consumer's actual behavior contradicts the declared invariant, that is a cross-cut P1 (cross-module contract violation). Examples:
   - Diff defines `^g_<id>$` validator but production mints `grp_<32hex>` ids → grep `group-authorization.ts` for `GROUP_ID_PATTERN`; mismatch → P1.
   - Diff declares `transition(state, event)` "pure" but calls `Date.now()` inside → grep the body itself for `Date.now()` / `Math.random()` / `Math.now()` → impurity contradicts the doc → P1.
   - Diff adds `application.seq` field but the bridge does `{ ...msg, seq }` → grep `ws-bridge*.ts` for `seq` overwrite → field shadowing → P1.
   - Diff says "fail-closed on absent X" but consumer code does `?.optional()` chaining → consumer fails-open → P1.
   These contract violations are P1 only when they meet the step-5 calibration (a concrete scenario in current code reaching money/security/data loss/user-visible break); otherwise P2.
   This step catches the architectural defects that flagged the v1 review's depth advantage in A/B test #3. Without it the review only sees what's in the diff window; with it the review sees how the diff's invariants land in production.
4. **Resolve severity conflicts** — Chair decides based on "concrete cost in THIS codebase at THIS scale."
5. **Apply the Carmack filter and calibrate severity** (re-grade every expert's label — do not inherit it):
   - "Is this actually a problem in THIS codebase, or is the subagent pattern-matching?"
   - "What's the concrete consequence if this isn't fixed?"
   - "Would Carmack care about this, or is it bikeshedding?"
   - **P1** only for a defect with a concrete reproduction or exploit path in the CURRENT code — `file:line` plus a step-by-step scenario (input/state → wrong outcome) — that causes money loss, a security breach, data loss/corruption, or a user-visible break. No reproduction → not P1.
   - **Never P1:** missing or weak tests, missing docs, style, naming, conventions, "consider refactoring", hypothetical future scale — P2 at most (usually P3). (Deterministic failures are not graded here — they lead the report in their own section.)
6. **No quota, no padding.** Report only defects you can substantiate from the code. There is no target count and no cap to fill — zero findings is a valid, reportable outcome ("No substantiated defects found"). Drop any finding you cannot tie to specific code and a concrete consequence, however many that leaves.
7. **Number findings sequentially** across all severity levels (1, 2, 3... not restarting per section).

---

## Phase 5: Output

**Before writing: strip all code from your synthesis.** If any subagent wrote code snippets despite the instruction not to — do not carry them into the review. Translate everything to plain English.

Use this exact format. Structure and attribution are non-negotiable.

```
# Council Review (Aura): [module/file name]

**Scope:** [what was reviewed — files, module, full codebase]
**Context:** [2-3 sentences: what this code does, how it fits, what matters most]
**Council dispatched:** [list which subagents ran and which returned findings vs "no findings"]
**Deterministic checks:** [typecheck / tests / a11y / smoke — pass / fail / COULD NOT RUN (why)]
**Confidence:** [High — all checks ran | Medium — some ran | Low — tests or smoke could not run]

[If any check could not run, the FIRST line of the report above the title is: ⚠ UNVERIFIED — <which checks, why>]

---

## Deterministic Check Failures (fix first)

[TS errors, test failures, axe violations, smoke failures in the changed scope — exact message + file:line. Then coverage-gate failures. "None" if green. Pre-existing out-of-scope failures: one line of context, not findings.]

---

## P1 — Fix Now

[Only defects with a concrete reproduction/exploit path affecting money, security, data loss, or a user-visible break. "None" is a valid section body.]

### 1. [Title]

| | |
|---|---|
| **File** | `path/to/file.ts:line-range` |
| **Council** | [Expert] × Carmack — [Principle name from their reference doc] |
| **Ref** | `references/[filename].md` → Principle N |

**Finding:** [1-2 sentences. What's wrong — specific to THIS codebase.]

**Reproduction:** [Concrete scenario in current code: input/state → steps → wrong outcome. Required for P1.]

**Consequence:** [1 sentence. What breaks, leaks, corrupts.]

**Fix:** [1-2 sentences. The intended behaviour after the fix, then what to change and where — stated so the applier can check the diff does THIS and not its opposite. Name the test that should fail before the fix. No code snippets.]

---

## P2 — Fix Soon

### 2. [Title]

| | |
|---|---|
| **File** | `path/to/file.ts:line-range` |
| **Council** | [Expert] × Carmack — [Principle name] |
| **Ref** | `references/[filename].md` → Principle N |

**Finding:**
**Fix:**

---

## P3 — Consider

### 3. [Title]

| | |
|---|---|
| **File** | `path/to/file.ts:line-range` |
| **Council** | [Expert] × Carmack — [Principle name] |

[What could be better and why. One paragraph max.]

---

## Summary

| # | Finding | Severity | Council | Fix effort |
|---|---------|----------|---------|------------|
| 1 | [Short title] | P1 | [Expert] | [~lines or time] |

## Verdict

[One paragraph: overall assessment. Is this code shipping-quality? What's the single most important thing to address? Name the council member whose domain is most critical for this codebase right now. Carmack would be direct — be direct.]

---

## Findings Breakdown by Expert

| Expert | P1 | P2 | P3 | Total | Key Areas |
|--------|----|----|----|----|-----------|
| Hunt (Security) | [N] | [N] | [N] | [N] | [1-2 words per area] |
| Fowler (Refactoring) | [N] | [N] | [N] | [N] | [...] |
| dahl (Bun + NDJSON/WS Protocol) | [N] | [N] | [N] | [N] | [...] |
| ritchie (Unix-discipline §A Process + §B Persistence) | [N] | [N] | [N] | [N] | [...] |
| abramov (React/Web UI) | [N] | [N] | [N] | [N] | [...] |
| watson (a11y Auditor) | [N] | [N] | [N] | [N] | [...] |
| Saarinen (UI Quality) | [N] | [N] | [N] | [N] | [...] |
| Friedman (UX Quality) | [N] | [N] | [N] | [N] | [...] |
| Willison (LLM Pipeline) | [N] | [N] | [N] | [N] | [...] |
| Beck (Test Quality) | [N] | [N] | [N] | [N] | [...] |
| hashimoto (DevOps cross-stack) | [N] | [N] | [N] | [N] | [...] |
| **TOTAL** | **[N]** | **[N]** | **[N]** | **[N]** | |

**Review output written to:** `.council/review-output/$TIMESTAMP/FINAL-REVIEW.md`

**Expert output files (only those dispatched):**
- Hunt: `.council/review-output/$TIMESTAMP/hunt.md`
- Fowler: `.council/review-output/$TIMESTAMP/fowler.md`
- dahl (Bun + NDJSON/WS): `.council/review-output/$TIMESTAMP/dahl.md`
- ritchie (Unix-discipline two-axes): `.council/review-output/$TIMESTAMP/ritchie.md`
- abramov (React/Web UI): `.council/review-output/$TIMESTAMP/abramov.md`
- watson (a11y): `.council/review-output/$TIMESTAMP/watson.md`
- Saarinen: `.council/review-output/$TIMESTAMP/saarinen.md`
- Friedman: `.council/review-output/$TIMESTAMP/friedman.md`
- Willison: `.council/review-output/$TIMESTAMP/willison.md`
- Beck: `.council/review-output/$TIMESTAMP/beck.md`
- hashimoto (DevOps cross-stack): `.council/review-output/$TIMESTAMP/hashimoto.md`
```

**Attribution rules:**
- Every finding MUST have a `Council` row naming the expert and the specific principle from their reference doc.
- If a finding spans two domains, name the PRIMARY domain and note: "Cross-ref: [other expert] also flagged this."
- The Summary table is mandatory — gives the user a scannable triage list.
- P3 findings omit the `Ref` row and `Consequence` section — keep them tight.
- The "Council dispatched" line in the header shows coverage.
- The Findings Breakdown table at the end is mandatory.

---

## Voice and Style

**Absolute rules:**
- **NO code snippets in the review output.** Describe what to change in plain English.
- **Keep findings brief.** Finding: 1-2 sentences. Consequence: 1 sentence. Fix: 1-2 sentences. P3s: one paragraph max.

The Chair channels these Carmack principles:
- **Simplicity over cleverness** — "The best code is no code. The second best is simple code."
- **Understand before opining** — Never "this looks like it might..." — know what the code does or say you need more context.
- **Concrete over abstract** — "This will hang the bridge when X" not "consider error handling."
- **No sycophancy** — Don't open with "great code overall!" If great, say so at the end. If not, say that too.
- **Fix, don't just flag** — Every finding includes a specific fix.
- **Economic, not aesthetic** — "Will this slow us down?" If not, lower severity or skip.
- **Teach, don't just flag** — Make the developer never want to write that pattern again.

---

## Phase 5.5: P1 Self-Block Gate (MANDATORY before Phase 6/7/8)

After writing FINAL-REVIEW.md, count P1 findings whose `File` row points to a path in the implementation log's "Ready for Review" list — i.e. P1s caused BY this implementation cycle (not pre-existing).

If count > 0:
1. **DO NOT** proceed to Phase 7 (conventions) or Phase 8 (checkpoint emit).
2. Present the P1 list in the conversational summary with this header:
   > "## REVIEW BLOCKED — N self-introduced P1 finding(s)"
3. Offer three explicit options to the operator:
   - a) **"fix now"** — loop back to `/council-implement-aura` with the P1 list as input, under the fix discipline below. This is the ONE allowed fix-pass round: if the re-review of that fix pass finds new P1s in the fixes themselves, do not offer "fix now" again — stop and report to the human.
   - b) **"accept"** — operator types `accept-p1-<short-rationale>`; review proceeds, the acceptance text is appended to FINAL-REVIEW.md verbatim under a new `## Accepted P1s (rationale)` section
   - c) **"defer"** — file a follow-up `TASK-<slug>.md` in repo root with the P1 details, then proceed

No fourth path. Silent proceed-with-known-P1 is forbidden — shipping a self-acknowledged regression is the worst failure mode of the review pipeline.

The shape mirrors the Plan Phase 2 hard gate: both interrupts already exist — replicate the discipline at the review boundary.

---

## Phase 6: Conversational Summary (MANDATORY)

After writing FINAL-REVIEW.md, present a summary table in the conversation. Do NOT just say "review complete."

```
## Council Review Complete (Aura) — [N] Findings

[⚠ UNVERIFIED — <checks that could not run> (only if any) · Confidence: High/Medium/Low]
**Deterministic checks:** [pass / N failures — listed first in the report]

| # | Finding | Severity | Expert | Fix Effort |
|---|---------|----------|--------|------------|
| 1 | [Short title] | P1 | [Expert] | [estimate] |
| 2 | [Short title] | P2 | [Expert] | [estimate] |
| ... | ... | ... | ... | ... |

**Totals:** [N] P1, [N] P2, [N] P3

**Start with:** [1-2 sentence triage recommendation — which finding to fix first and why]

**Full review:** `.council/review-output/$TIMESTAMP/FINAL-REVIEW.md`
```

This table is NON-NEGOTIABLE. Every council review session ends with this table. With zero findings it is replaced by "No substantiated defects found" plus the deterministic-check line — do not invent findings to fill it.

### Applying findings (fix discipline — for whoever applies this review)

This review fixes nothing itself. Whoever applies it (developer, `/council-implement-aura`, a fixing agent) MUST follow this for every applied fix — fixes applied from reviews without it caused ≥20 prod regressions across 7 projects (2026-10 corpus), including fixes that did the opposite of the recommendation:
1. **Cite the finding** — the finding number (or "Deterministic #") in the commit/log.
2. **Restate and confirm** — restate the recommended behaviour in one sentence, then re-read the diff and confirm it implements THAT behaviour, not its inverse (check guard polarity, allow vs deny, include vs exclude, fail-open vs fail-closed).
3. **Failing test first** — add a Vitest test that fails on the current code and passes after the fix. If no such test can be written, the fix is not applied as P1 work; record why.
4. **Re-run Phase 0** — typecheck, tests, a11y and the smoke run, after the fixes.
5. **One fix-pass review, max.** At most one review round over the fix pass. If that round finds new P1s in the fixes themselves, STOP — no further fix/review loop; report the new P1s to the human and let them decide.

Apply deterministic failures first, then P1s. P2/P3 are not applied in the same pass unless the human asks.

---

## Phase 7: Convention Update (only if signal exists)

After Phase 6, scan P1/P2 findings for any pattern that reveals a NEW project invariant not already in `conventions.md`. If none qualify, SKIP this phase entirely — do not nag the operator.

If candidate(s) exist (max 3 per session):

1. Present ONE-line candidates inline:
   ```
   Convention candidate: <one-line statement> — from [Expert] finding #N. Append as [AP-N | EC-N]?
   ```
2. If operator approves (e.g. `yes`, `1,3`, `EC-N`), append to `conventions.md`:
   - `### AP-N: <title>` / `### EC-N: <title>` followed by `**Pattern/Convention:** <statement>` + `**Origin:** [Expert] — Council Review [TIMESTAMP]` + (for EC) `**Principle:** \`references/<file>.md\` → Principle N`
3. If operator says `none` or silent: skip silently. Do not push back.

**Rules:**
- Skip Phase 7 entirely if no P1/P2 surfaced a general invariant. A 1-finding review or all-P3 review NEVER produces conventions.
- Max 3 candidates per session — quality over quantity.
- Sequential numbering: continue from highest existing AP-N / EC-N. Read `conventions.md` first; skip duplicates.
- P3 findings never become conventions.

---

## Phase 8: Emit Council Checkpoint (auto)

**Purpose.** When this skill runs inside an Aura Companion Council pair, this phase tells the observer half "the orchestrator just finished reviewing — here is the review file, cross-check it." The observer wakes within ~1 second of the checkpoint POST and emits its independent review to `<workspace>/.council/reviews/council-review-<provider>-observer.md`. Without this step the council loop never closes — the observer remains in "Awaiting first checkpoint" forever.

The value: the orchestrator-run council review and the observer-run independent review come from different model contexts. Disagreement between them is itself signal.

**Skip this phase entirely** if any of these are true:
- `http://localhost:3456/api/sessions` does not respond (you are not inside the Aura Companion UI).
- No session in the response matches the current workspace + orchestrator role.
- The `POST .../council/checkpoint` returns 409 — that response IS the silent-skip signal.

### Steps

1. **Probe the API.** Run `curl -fsS http://localhost:3456/api/sessions`. Non-zero exit or empty → skip the entire phase.

2. **Discover the orchestrator session id.** Filter the response array for the entry matching ALL of:
   - `state == "connected"`
   - `cwd == <current workspace cwd>` (the cwd you reviewed under)
   - `sessionGroupRole == "orchestrator"`
   - newest `createdAt` if more than one match

   Zero matches → silent skip. One match → capture `sessionId` (= `ORCH_SID`) and `sessionGroupId` (= `GROUP_ID`).

3. **Compute next sequence.** List `<workspace>/.council/checkpoints/*.json`. Read each file's `sequence` field. `next_sequence = max(...) + 1`, or `0` if the directory is empty or absent.

4. **Build CheckpointPayload.**

   ```json
   {
     "schema_version": 1,
     "checkpoint_id": "council-review-<seq>-<8-hex-random>",
     "phase": "council-review",
     "sequence": <next_sequence>,
     "session_group_id": "<GROUP_ID>",
     "emitted_at": "<UTC ISO 8601 T-form, no fractional seconds>",
     "artifact_paths": [".council/review-output/<TIMESTAMP>/FINAL-REVIEW.md"]
   }
   ```

   `artifact_paths` should be the single FINAL-REVIEW.md path from Phase 5, workspace-relative. The observer's job here is meta-review — does the orchestrator's review hold up?

5. **POST.** Use the Bash tool:

   ```bash
   curl -fsS -X POST \
     "http://localhost:3456/api/sessions/$ORCH_SID/council/checkpoint" \
     -H "Content-Type: application/json" \
     -d "$PAYLOAD"
   ```

   Expected 200 with `{"ok": true, "written": "...", ...}`.

6. **On non-200:**
   - **409** ("Session is not part of an active council group"): silent skip, not an error.
   - **400 / 403 / 500**: surface the raw response body to the user, do not retry.

7. **Do not wait** for the observer's review. The 200 response IS the success signal for this phase; the observer's review lands asynchronously in the Aura UI's ObserverPanel.

---

## Phase 9: Record run-stats (PRO economy self-learning, auto)

**Purpose.** Append one row per council run to the persistent run-stats dataset
(`web/scripts/run-stats.ts` → `~/.companion/council-stats/`). This is the
foundation the adaptive economy levers learn from (spec `specs/council-pro-economy.md`
Stories 1 & 3): it records `(complexity, seat, model tier, diff size, did each
finding survive)`. Recording ONLY — it changes nothing about the review just done,
so it can never drop a finding or tier-down a lens.

**Skip silently** if the workspace is not a git repo, or `web/scripts/run-stats.ts`
is absent (non-Aura checkout).

### Steps

1. **Complexity vector.** From the reviewed scope:
   - `diffFiles` + `diffLines`: `git diff --numstat <base>...HEAD` (or the staged/working
     scope you reviewed) — count changed files and summed added+deleted lines.
   - `surfaceCount`: number of distinct fingerprint `surfaces` the change touches
     (from the Phase 0/selection fingerprint).
   - `domainBreadth`: number of distinct council domains across the seated roster.

2. **Seats.** For every SEATED advisor from Phase 3, build one entry:
   - `seatId`: the advisor id.
   - `guaranteed`: `true` iff the engine marked it a fail-closed cross-stack lens
     (`isGuaranteed` — `hunt`/`willison`/`fowler`/`beck` when domain-relevant).
   - `tier` + `model`: what you actually dispatched (Phase 3 step 5). Today `"top"`
     / the default model for every seat.
   - `findings`: one entry per finding that seat contributed to the FINAL synthesis
     (Phase 5), `{id, priority: "P1"|"P2"|"P3", survived: true}`. A raw finding the
     Chair dropped during dedup is `survived: false` (record it if you tracked it).

3. **Record.** Pipe the JSON to the CLI (skip silently on any error):

   ```bash
   echo "$STATS_JSON" | bun web/scripts/run-stats.ts record
   ```

   Payload shape:
   ```json
   {
     "skill": "council-review-aura",
     "engineVersion": "rc2",
     "complexity": {"diffFiles": <n>, "diffLines": <n>, "surfaceCount": <n>, "domainBreadth": <n>},
     "seats": [{"seatId": "hunt", "guaranteed": true, "tier": "top", "model": "<default>", "findings": [{"id": "<fnd>", "priority": "P1", "survived": true}]}]
   }
   ```

   Expected `{"ok": true, "runId": "...", "path": "..."}`. On error: log one line and
   move on — a stats-write failure must never break the review.

4. **Write back the result cache (skip-if-unchanged, spec Story 2).** For each seat
   that was **freshly dispatched** this run (i.e. NOT reused from cache in Phase 3),
   store its findings keyed by the same file-set hash you computed in Phase 3, so the
   next unchanged re-run reuses them:

   ```bash
   echo "$CACHE_JSON" | bun web/scripts/result-cache.ts put
   ```

   Payload per seat:
   ```json
   {"skill": "council-review-aura", "engineVersion": "rc2", "seatId": "hunt", "filesHash": "<hash from Phase 3>", "findings": [{"id": "<fnd>", "priority": "P1", "summary": "<one-line finding>"}]}
   ```

   Skip silently on any error — a cache-write failure must never break the review.

## Addendum (2026-10-28) — rendered-UI accessibility scan (Phase 0, step 5)

Source: aura, wcag-22

When the change touches UI (`.tsx`/`.css` under `web/src/`, `web/index.html`, `landing/`, `platform/src/`), Phase 0 also scans the rendered UI. It is a deterministic check like the others, and it runs before any seat is dispatched.

1. Start a throwaway dev server on a free loopback port. Never use the production service on :3456, and stop the throwaway server by its own PID.
2. Pick the states the diff touches: the route of every changed screen, and `#/playground` for message/chat components (CLAUDE.md keeps every such component there).
3. Run the scanner:
   ```bash
   cd web && bun scripts/a11y-scan.ts --url "http://127.0.0.1:<port>/#/<route>" [--url …] \
     --out "../.council/review-output/$TIMESTAMP/a11y-scan"
   ```
   It scans light and dark themes at a 375×812 viewport with the WCAG 2.0–2.2 A/AA rules. axe-core is pinned in `web/package.json` and loaded from `node_modules` at run time; never copy it anywhere. Only loopback URLs are accepted. Where the host blocks Chrome's sandbox, the skip reason says so; retry with `--browser-args=--no-sandbox`.
4. Exit codes: `0` pass, `1` fail, `3` skipped, `2` usage error. The status is the `status` field of `a11y-scan.json`. Quote it; never set it or upgrade it yourself:
   - `fail`: copy every row (rule id, selector, WCAG criterion, state) into **Deterministic Check Failures**.
   - `skipped`: open the report with `⚠ UNVERIFIED — rendered a11y scan skipped: <reason>` and set the confidence to Low. A skipped scan is never a pass.
   - `pass`: write "axe found no violations on N states". Never write "accessible": axe covers roughly a third of WCAG.
   - "Needs manual check" rows (axe `incomplete`) are open items, not passes.
5. In the Phase 5 output, the **Deterministic checks** line adds `rendered a11y: pass | fail (N) | skipped (<reason>)`. Paste the artifact's "What axe cannot see (not verified)" checklist under the a11y findings. Tick a line only with evidence from this review (a keyboard walk, a screen-reader pass), and name that evidence.
6. Put the artifact path (`.council/review-output/$TIMESTAMP/a11y-scan/a11y-scan.md`) in the context brief for watson.
