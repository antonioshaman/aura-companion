# Council Plan: Upstream Sync 0.90 → 0.95 + Repeatable Future-Sync Tooling

**Scope:** Merge upstream Vibe-Companion `the-companion@v0.90..v0.95` (~30 commits) into Aura `main` as ONE big PR landing as Aura v1.1.x, with parallel investment in branding tooling, drift detector, restart resilience, and a sync workflow doc — so the next sync (0.95→0.96) takes ≤2 hours.

**Context:** Aura is a TypeScript/Bun/Hono/React 19 fork with extensive local divergence — self-learning system (`.agents/knowledge/*.jsonl`, `/prime`/`/learn`/`/self-reflect`), full UI rebrand, four load-bearing local fixes (sidebar `93a205c`, today's state-machine `ready→awaiting_permission`, today's browser keep_alive heartbeat, version stopper `1.0.0`). Hard constraint: per-change "fit assessment" before any upstream chunk lands.

**Boundaries:** No cherry-picking, no push-back to upstream, no auto-merge bot, no directory restructuring during this PR.

**Council dispatched (9 lenses):**
- Carmack (Chair, Merge & Fork Strategy) — 8 recs
- Troy Hunt (Security) — 7 recs
- Martin Fowler (Structure) — 6 recs
- Kent Beck (Testing) — 7 recs
- Simon Willison (LLM/Skills) — 6 recs
- TypeScript/Bun expert (Backend correctness) — 7 recs
- Karri Saarinen (UI quality) — 6 recs
- Vitaly Friedman (UX quality) — 7 recs
- Deploy expert (VPS reality) — 6 recs

51 recs total → consolidated into **15 tasks** below. Cross-refs noted where multiple experts informed a task.

---

## Task Sequence

> **Phasing:** Tasks 1–6 are pre-merge (foundation + safety net). Tasks 7–13 are the merge itself, sequenced by blast-radius (low → high). Tasks 14–15 are future-proofing.

### 1. Branding tooling foundation

| | |
|---|---|
| **Domain** | Fowler × Hunt × Beck × Saarinen — "Branding config as data, not regex" |
| **Cross-ref** | F4 (data-not-script) + H4 (idempotent + skip secrets) + B6 (idempotence test) + S3 (visual-asset audit beyond strings) |
| **Depends on** | — |

Build `branding.config.json` as the single source of truth (replacements list, protected paths, protected line-anchored markers like `// aura-keep-upstream-name`) and a thin executor `scripts/apply-aura-branding.sh` that consumes it. Coverage must include visual assets (favicon, manifest `name`/`short_name`/`theme_color`, `<meta name="theme-color">`, `<title>`, OG images) and explicitly skip `bun.lockb`, `.env*`, `~/.companion/**`, `.agents/knowledge/**`, all `*.jsonl`, `web/server/protocol/`, and the existing recordings directories. Refuse to run with staged changes. Write one test that runs the script twice on a fixture tree and asserts byte-identical output.

---

### 2. Aura surface refactor (minimal seams only)

| | |
|---|---|
| **Domain** | Fowler — "Sprout Function over speculative Adapter; refactor when it makes the next change easier" |
| **Cross-ref** | F1 (Version Provider seam in update-checker), F2 (keep `.agents/` at root, add `aura/` + `docs/aura/`), F3 (named-function seams for hotspots), F5 (CONFLICT_WATCHLIST.md) |
| **Depends on** | — |

For each of the four interleaved hotspots (`ws-bridge.ts` heartbeat, `session-state-machine.ts` transitions, `Sidebar*.tsx`, `update-checker.ts`), pull Aura's added behavior into a named in-file function (`applyAuraKeepAlive`, `auraReconcileSidebar`, `getDisplayedVersion()`, etc.) called from one obvious site. NO plugin system, NO DI container, NO directory moves. Add `aura/CONFLICT_WATCHLIST.md` listing exactly the files where Aura logic interleaves with upstream — referenced from the workflow doc and (later) a CI grep. Carmack explicitly cuts directory restructuring during the merge — that's a separate post-merge PR if it pays off.

---

### 3. Pre-merge regression net

| | |
|---|---|
| **Domain** | Beck × Willison — "Make the change easy, then make the easy change. Test before fix." |
| **Cross-ref** | B1 (PR #597 replay fixture), B2 (guard tests on Aura-only files), B3 (sidebar symptom test), W1 (`.agents/knowledge/*.jsonl` byte-equality + JSON-line parse), W3 (skill-name collision detector at startup), W6 (origin frontmatter on every SKILL.md) |
| **Depends on** | — |

Before any upstream chunk lands, capture: (a) a real production recording from `~/.companion/recordings/` that exhibits the "Phase 4 — Read all 9 outputs" 5x bug, frozen as a fixture, with a deterministic test that fails on main and passes after PR #597; (b) guard tests that hash/snapshot the four Aura-only modules (`update-checker.ts`, `ws-bridge.ts`, `session-state-machine.ts`, `Sidebar*`) and fail loudly on uncommunicated change; (c) a symptom-level sidebar test driven through the Zustand store contract (so it survives whichever reconcile implementation wins); (d) a CI step asserting line counts and JSON parsability of all six `.agents/knowledge/*.jsonl` pre/post merge; (e) a startup-time check that warns when two skills register the same trigger name; (f) `origin: aura | upstream | aura-fork-of-upstream` frontmatter on every existing SKILL.md.

---

### 4. Deploy resilience baseline (independent of merge)

| | |
|---|---|
| **Domain** | Deploy expert — "Smallest possible change that prevents the next 'barely got back'" |
| **Cross-ref** | D4 (~30-line restart wrapper), D5 (tighten `/health` or add `/ready`), D6 (cap `bun.log`/recordings/logs disk usage) |
| **Depends on** | — |

Write `scripts/aura-restart.sh` (~30 lines): pidfile-based SIGTERM + 10s wait + SIGKILL fallback, then `setsid nohup env NODE_ENV=production bun server/index.ts >> bun.log 2>&1 &`, then poll `/ready` for up to 30s, exit non-zero on timeout. Add `/ready` (or extend `/health`) to return 200 only when session-store loaded, tailscale-manager finished its restore attempt, and at least one CLI binary path resolved. Cap `bun.log` (currently unbounded — the real disk-fill risk) by truncating on each restart or piping through size-bounded rotation. Set `COMPANION_RECORDINGS_MAX_LINES` explicitly in the launch env. **No systemd unit** — Carmack/Deploy filter: shell script over service manager for one VPS / one maintainer.

---

### 5. Integration branch + supply-chain review + triage protocol

| | |
|---|---|
| **Domain** | Carmack × Hunt — "Treat the branch as disposable. Lockfile is the highest-scrutiny file." |
| **Cross-ref** | C1 (single throwaway integration branch), C2 (chunk-per-commit on integration branch, ONE PR to main), C4 (30-60min upfront triage labeling each commit `clean/overlap/risky/skip`), C8 (3-bucket conflict rule), H1 (lockfile-first review with explicit acceptance bar), H2 (`bun install --ignore-scripts` during review) |
| **Depends on** | Tasks 1, 2, 3 |

Branch `sync/upstream-0.95` off current `main`. Add `upstream` git remote. Spend 30–60 minutes reading all 30 commit subjects + diff-of-diffs and tag each chunk in a one-line table: `clean / overlap / risky / skip+reason`. Don't write paragraphs — the real work is per-chunk. Land each upstream commit as its own commit on the integration branch with message format `sync: <upstream-sha> — <subject> [fit: clean|adapted|skipped+reason]`. Run `bun install --ignore-scripts` during review; only re-enable scripts after the lockfile diff has been reviewed and any new direct/transitive dep audited (publisher reputation, weekly downloads, version pinned). Conflict rule of thumb (apply per file, <1 minute each): (a) Aura-only territory → keep ours; (b) shared infra + upstream is bug-fixing a bug we have → take theirs, re-apply our local fix on top if still needed; (c) both sides changed behavior intentionally → stop, read both diffs, write 2-line note in commit message.

---

### 6. Low-blast-radius merges (pure additions / isolated fixes)

| | |
|---|---|
| **Domain** | Carmack × TS expert × Beck — "Land the boring stuff first. Save the things that can break you for last." |
| **Cross-ref** | C3 (sequence by blast radius), T3 (verify #597 fix is server-side, not client-side merger replacement that conflicts with Aura's `mergeAssistantMessage`), B1 (replay-fixture test gates this) |
| **Depends on** | Task 5 |

Land in this order: PR #597 (streaming dup fix — verify fix mechanism doesn't conflict with Aura's `upsertAssistantMessage`/`mergeAssistantMessage` — if upstream is server-side suppression, ours stays; if client-side dedupe replacement, take theirs but preserve `mergeContentBlocks` for replay-vs-live merge), PR #592 (claude-adapter user echo drop), PR #595 (codex transport disconnect race). The replay-fixture test from Task 3 is the gate — if it doesn't go from red → green after #597 lands, abort.

---

### 7. Overlap-with-Aura merges (sidebar, heartbeat × relaunch, PID race)

| | |
|---|---|
| **Domain** | TS expert × Hunt × Beck — "Two correct units can deadlock at the seams." |
| **Cross-ref** | T2 (heartbeat × #634 composition — ordering matters), T5 (audit #621 sidebar reconcile against `93a205c` — pick whichever is more correct, do not double-apply), T7 (re-validate `--resume` race window after #589 PID recycling), B4 (compose heartbeat + relaunch in one integration test), H6 (WS reconnection paths must re-authenticate, not resume on PID alone — bind 127.0.0.1, per-session nonce) |
| **Depends on** | Task 6 |

Three contentious chunks, each requiring per-file decision: (a) **Sidebar #621 vs `93a205c`** — read both implementations end-to-end; if upstream's reconcile rebuilds the entire client `sdkSessions` list authoritatively, drop our fix; if it patches deltas, our filter fix stays. Verify `web/src/ws.ts:shouldReconnectSession` and `getReconnectCandidates` still align with post-merge sidebar state. (b) **Heartbeat × #634 proactive relaunch** — `startBrowserHeartbeat` is a single global `setInterval`; #634's relaunch decision must read `session.browserSockets.size === 0` and slot inside the existing `handleBrowserClose → idle kill` watchdog flow, NOT spawn a parallel timer; inspect `disconnectTimers` and `idleKillTimers` so it doesn't fire during in-flight CLI reconnect. (c) **PID recycling #589/#605** — verify three invariants: `handleCLIOpen` cancels disconnect timer before `transition("initializing")`, the 15s debounce stays, and `terminated → starting → initializing` step-through still runs for relaunched sessions. Hardening per Hunt: confirm CLI WS bind is `127.0.0.1` only; require a per-session nonce on the CLI WS handshake so a local user can't impersonate the CLI mid-relaunch. Add the integration test from Task 3 covering both timers firing simultaneously.

---

### 8. Protocol & state-machine merges (#613 channels)

| | |
|---|---|
| **Domain** | TS expert × Willison — "Pre-extend exhaustiveness. Pass-through unknowns, don't drop them." |
| **Cross-ref** | T1 (pre-extend VALID_TRANSITIONS for new message kinds), W2 (preserve `default: reportProtocolDrift` in `routeCLIMessage` and the "forward unknown anyway" path in `ws-bridge.ts:1088`), T6 (preserve `keep_alive` discriminant in `BrowserIncomingMessageBase`; ensure heartbeat does NOT consume seq numbers via `broadcastBrowserHeartbeat`'s direct `ws.send`), T4 (hold the line on `idleTimeout: 0` and `sendPings: false` in `index.ts` — reject any upstream PR re-enabling pings on the CLI socket) |
| **Depends on** | Task 7 |

Highest-risk merge. Audit every new message kind from PR #613 against the four transition trigger sites in `ws-bridge.ts` (`session_init`, `status_change`, `result`, `permission_request`); add explicit handlers — even if the handler is just a comment "no transition." If channels protocol introduces `compact_started`-analog or similar, add the corresponding edges to `VALID_TRANSITIONS`. Keep `default: reportProtocolDrift` and the forward-unknown path so new kinds are visible, not swallowed. Confirm `BrowserIncomingMessageBase` still includes `keep_alive` discriminant post-merge, that `ReplayableBrowserIncomingMessage = Exclude<…, { type: "event_replay" }>` doesn't accidentally let `keep_alive` enter `eventBuffer`, and that `broadcastBrowserHeartbeat` continues to use direct `ws.send` (NOT a unified helper that increments `nextEventSeq`). Add a synthetic `channel_*` NDJSON test that asserts: browser receives it, monitor logs drift exactly once, no skill-context message is dropped.

---

### 9. Quarantine inert upstream + adopt sandbox lifecycle

| | |
|---|---|
| **Domain** | Deploy × Hunt — "Merge dead code only when removing it is riskier than ignoring it." |
| **Cross-ref** | D1 (Railway/Postgres/Email gate behind `AURA_FEATURES_*=1` flag, default off; remove `railway.toml`-equivalents), D2 (skip Docker-in-Docker / docker-compose image PRs OR delete `Dockerfile`/`docker-compose.yml` if container-manager doesn't consume them), D3 (verify `container-manager.ts` honors PR #602's preserve-on-idle + 24h timeout, configurable via env for mobile users) |
| **Depends on** | Task 5 |

Walk PR #594, #596, #598 chunks: any code that boots Railway, Resend, or postgres on startup must be guarded behind explicit env flags defaulting OFF. Move `postgres` driver to `optionalDependencies` if kept at all, never import at boot. Add a one-line "inert in Aura" comment at each entry point. PR #602 IS load-bearing for Aura's sandbox sessions — verify the 24h timeout reaches `container-manager.ts` and is configurable via `COMPANION_CONTAINER_IDLE_TIMEOUT` (or similar). If `Dockerfile`/`docker-compose.yml` aren't consumed by anything in production, delete them post-merge to avoid drift-detector noise.

---

### 10. Chat block UI integration (#597 redesign)

| | |
|---|---|
| **Domain** | Saarinen × Friedman × TS expert — "Brand presence in every surface. Five screen states minimum." |
| **Cross-ref** | S1 (lock chat-block palette to `cc-*` tokens; route any new hex/raw-tailwind back through Aura tokens), U1 (five states explicitly seeded in Playground: blank, mid-stream visible cursor/shimmer, stalled-stream affordance after 2s, error from `is_error: true`, ideal), U7 (tone pass on every merged string + mobile-width overflow check + truncation rules: middle-ellipsis paths, end-ellipsis titles, wrap errors) |
| **Depends on** | Task 6 |

After PR #597 lands functionally (Task 6), do the visual integration: diff the new MessageBubble/ToolBlock for hex literals, `bg-zinc-*` / `bg-neutral-*` / `text-slate-*` raw Tailwind, or new CSS variables; route every one back through `cc-primary`, `cc-fg`, `cc-bg`, `cc-muted`. Update the Playground entry to seed five states explicitly — partial-state must be unmistakable from ideal-state (visible cursor or progress affordance) so a stuck stream can never masquerade as a complete one again. Tone-pass every new string ("Failed to start session" → "Session didn't start. Try again?"). Mobile-width overflow check for long model names, session titles, error bodies.

---

### 11. Status region consolidation

| | |
|---|---|
| **Domain** | Friedman × Saarinen × TS expert — "When two indicators tell overlapping stories, users trust neither." |
| **Cross-ref** | U2 (one status region with strict precedence: permission > error > reconnecting > streaming > idle; reconnection copy distinguishes network/server/CLI failure modes), S2 (visual treatment as calm low-chroma chip in `cc-muted`, not warning color), U3 (label post-result permission requests as continuations: "Claude is following up on your last request and needs to run X" with visual tether to prior turn) |
| **Depends on** | Tasks 7, 8 |

Define a single status slot (top of chat column or pinned to composer). Implement the precedence ranking; lower-priority states yield rather than stack. PR #593's reconnection indicator slots in here — never as a sixth peer next to existing `cliConnected` / `streamingStatus` / `connectionStatus` / `sessionStatus` / permission banner. Reconnection copy must be specific: "You appear offline" vs "Reconnecting to Aura" vs "Restarting Claude session". Permission banner copy under the new state-machine + channels-protocol world: anchor every post-`result` permission request to the prior turn so users don't mistake a follow-up for an unsolicited action.

---

### 12. Onboarding + token settings UX

| | |
|---|---|
| **Domain** | Friedman × Saarinen × Hunt × Willison — "Never ask the user what the system can already see; never punish a refresh." |
| **Cross-ref** | U4 (wizard precheck for CLAUDE.md / `.agents/` / prior tokens — "Looks like you're set up. Review or skip?"; persist progress per-step in sessionStorage; multiple-token chooser, not silent overwrite), S4 (restyle wizard with Aura typography ramp + `cc-primary`; rewrite microcopy in Aura voice; keep upstream's flow structure), U5 (token UX: empty / entering with inline validation / saved-with-mask-reveal-copy / error with specific cause / regenerating; destructive-action gate on regenerate and delete; trim whitespace on paste), S5 (single masked-input primitive: monospace, dot-mask, reveal toggle, copy button, secondary regenerate styling, hint in `cc-muted`), H3 (tokens land at `~/.companion/` with file mode `0600`, parent `0700`; redaction denylist in recorder + JSONL writers for `Authorization`, `Bearer`, `access_token`, `refresh_token`, `client_secret`, `sk-ant-`, `sk-`), W4 (onboarding wizard wraps `/prime`, doesn't replace it: wizard finishes → emits "session ready" → `/prime` runs; first-run flag must NOT suppress `/prime` on subsequent sessions) |
| **Depends on** | Tasks 5, 6 |

Highest-stakes UX touch in the merge — five expert lenses converge here. PR #615 wizard must run a precheck against existing Aura state, persist mid-flow, recognize already-set-up users. Visual restyle to Aura tokens. PR #623 token field becomes a reusable primitive (one component, used everywhere a secret is shown). Tokens stored at `~/.companion/` with strict file modes; recorder and JSONL writers gain a redaction denylist BEFORE either subsystem touches new token surface. Self-learning protocol survives: wizard's "first-run done" flag must not suppress `/prime` on later sessions — wire wizard → `/prime` sequentially and document the order in CLAUDE.md.

---

### 13. Recording hub: keyboard-discoverable + redaction + as-eval

| | |
|---|---|
| **Domain** | Saarinen × Hunt × Willison — "Power users earn density; everyone else earns calm. Recordings are evals." |
| **Cross-ref** | S6 (no sidebar entry, no settings link, no badge — command palette + typed `#/recordings` URL only; utilitarian visual register: dense type, monospace timestamps, muted chrome; Playground hidden-route entry for design audit), H7 (recording-hub gated by same local token as REST; redaction pass on write for `sk-`, `ghp_`, `Bearer `, `code=`, `?access_token=`; `COMPANION_RECORD=0` honored by hub; dir mode `0700`, files `0600`), W5 (compose, don't replace — Aura's `~/.companion/recordings/` JSONL stays canonical; hub UI rebrands and reads from same directory; freeze one recording as golden file for skill regression eval: "replay through bridge, run `/prime`, assert N knowledge entries surface") |
| **Depends on** | Tasks 8, 12 |

PR #617's hub UI lands hidden-by-design — keyboard-discoverable only. Crucially: do NOT introduce a parallel recording store. The existing JSONL format under `~/.companion/recordings/` stays canonical (load-bearing for `replay.ts`). The hub reads from there. Add redaction pass on write before merging the hub's surface. Write the "recordings as evals" golden test: pick one recording, replay through bridge, run `/prime`, assert expected knowledge entries surface. That single test becomes the skill regression suite going forward.

---

### 14. Container liveness affordance

| | |
|---|---|
| **Domain** | Friedman — "If a system holds a resource on the user's behalf, the user must be able to see it and end it in one step." |
| **Cross-ref** | U6 (sidebar badge or session-row chip showing "container alive — Xh remaining" with inline Stop; reachable from session list, not buried in settings; first-launch in-app announcement of new 24h default — not via release notes) |
| **Depends on** | Task 9 |

After PR #602 lands the 24h preserve-on-idle behavior, expose container state in the session list. Mobile users will not dig into settings to find it. One-tap kill from the session row. On first launch post-merge, show an in-app one-time toast announcing the new lifecycle policy.

---

### 15. Drift detector + workflow doc + tidy follow-up

| | |
|---|---|
| **Domain** | Carmack × Beck × Hunt — "The simplest thing that tells you the answer is the right thing." |
| **Cross-ref** | C6 (~50-line shell script: fetch upstream tag, diff file lists, hash `package.json` name/version, plaintext report; manual run before each sync; no CI on day one), B7 (mock fetch at the boundary — three tests: dedup, network throws → typed unavailable result, sources disagree with provenance), H5 (read-only oracle: HTTPS GET to `registry.npmjs.org/the-companion`, no auth header, no npm token, hard timeout, JSON shape validator; no code path takes the result and feeds `bun install` / `bun add` / child process), C7 (version semantics — see Risks), B5 (quarantine 6 Opus-regex flakes with `it.skip` + comment; separate follow-up PR fixes the regex) |
| **Depends on** | Tasks 1–14 done |

Write `scripts/aura-drift-check.sh` (~50 lines): fetches upstream tag, diffs file sets vs Aura, hashes key files, writes plaintext report to `~/.companion/upstream-drift.txt` (or surface chosen by maintainer — see External Setup). Three tests at the `fetch` boundary. Write `docs/aura/upstream-sync.md` with: the 5-step workflow (clone → triage → land chunks per the rule of thumb → run branding script → land PR), the conflict watchlist reference, and the version policy comment (see Risks). Quarantine the 6 Opus-regex test flakes with `it.skip` and a one-line cause cite; separate PR fixes them later — Beck's "tidy first?" answer is "not now, not in a 30-commit PR."

---

## Risks & Watchpoints

Awareness items that aren't tasks but would be dangerous to miss during build.

- **Carmack — Sequencing discipline:** If anything goes sideways past the halfway mark of the integration branch, `git branch -D` and start over from `main`. Do NOT try to "salvage" a half-merged branch by reverting commits inside it. The branch is the unit of abort.

- **Carmack — Don't refactor across the merge:** The instinct to move Aura code into `web/server/aura/` etc. as part of this PR is correct *eventually* — but doubles conflict surface during this round. Land the sync first; do a separate surgical move-only PR a week after main is stable, informed by which files actually conflicted.

- **Carmack — Version semantics (DECISION POINT):** The user said 1.1.1; Carmack's reasoning says 1.1.0 is more honest (5 upstream minors landing = at least one minor on our side; calling it a patch lies to the changelog). Also: write a one-line comment in `update-checker.ts` and `package.json` explaining *why* the version is intentionally ahead of upstream so future-you doesn't "fix" it.

- **Fowler — `web/server/protocol/` is read-only from Aura:** Vendored Claude Code SDK contract. Any Aura edit there turns the next SDK bump into a three-way merge against a contract we don't own. Add a CI grep that fails the sync PR if Aura-authored commits modified `web/server/protocol/` without an explicit `protocol-override` label.

- **Willison — `.agents/knowledge/*.jsonl` byte-equality:** Pair with Hunt's recommendation. The branding sed pass + the merge itself must produce zero diff in these six files. If a single line stops parsing as JSON or line counts shrink, the self-learning loop is corrupted silently.

- **TS expert — `keep_alive` seq invariant:** `broadcastBrowserHeartbeat` calls `ws.send` directly to bypass `eventBuffer` and `nextEventSeq`. If any upstream PR routes all outgoing through a single helper that always increments `nextEventSeq`, heartbeats start consuming seq numbers, replay buffer fills with empty frames, and `lastSeqBySession` advances spuriously. Pair with TS expert when reviewing `broadcastToBrowsersFn` post-merge.

- **TS expert — `idleTimeout: 0` / `sendPings: false` are load-bearing:** Bun protocol-level pings kill the CLI socket (the original bug). If any upstream PR re-enables either, REJECT — Aura's application keepalive lives on a different layer.

- **Hunt — Drift detector as an oracle, not a trigger:** The version stopper at `1.0.x > 0.95.0` is a UX guard, not a security control. Confirm no upstream PR introduces an "auto-update" affordance (e.g. from #586/#623 settings) that takes the registry response and feeds it to `bun install`.

- **Beck — The 6 Opus-regex flakes are quarantined, not fixed in this PR:** Mixing tidy-up with merge work makes the merge unreviewable. Separate follow-up PR.

- **Deploy — Upstream Docker work mostly doesn't apply:** Aura runs `nohup bun`. Mark merged-but-inactive code paths with one-line comments so future-you doesn't reactivate them by mistake. PR #602 is the one Docker change that DOES matter for sandbox sessions.

---

## External Setup Required

Actions outside the codebase before implementation can begin.

| # | What | Why | Blocking task |
|---|------|-----|---------------|
| 1 | Add `upstream` git remote: `git remote add upstream https://github.com/The-Vibe-Company/companion.git && git fetch upstream --tags` | Tasks 5–9 require reading upstream tags and individual commits from `v0.90..v0.95` | Task 5 |
| 2 | Decide version: **1.1.0** (Carmack rec — minor reflects 5 upstream minors absorbed) vs **1.1.1** (user's call — patch). Document the choice in `package.json` + `update-checker.ts` comment | The choice affects `package.json`, the version-stopper comment, and the workflow doc's version policy | Task 15 |
| 3 | Decide drift-detector surface: plaintext file `~/.companion/upstream-drift.txt`, GitHub issue creation via `gh` CLI, or a single `bun.log` line. Carmack/Deploy filter: file is cheapest, no new failure mode on a single VPS | Task 15's script implementation depends on the surface choice | Task 15 |
| 4 | (Optional) Decide: do `Dockerfile` and `docker-compose.yml` get deleted post-merge if Aura's prod doesn't consume them? Walk `container-manager.ts` first to confirm | Task 9's quarantine work needs to know which files are inert | Task 9 |

---

## Summary

| # | Task | Domain (primary) | Depends on |
|---|------|------------------|------------|
| 1 | Branding tooling foundation | Fowler × Hunt × Beck × Saarinen | — |
| 2 | Aura surface refactor (minimal seams) | Fowler | — |
| 3 | Pre-merge regression net | Beck × Willison | — |
| 4 | Deploy resilience baseline | Deploy | — |
| 5 | Integration branch + supply-chain + triage | Carmack × Hunt | 1, 2, 3 |
| 6 | Low-blast-radius merges (#597, #592, #595) | Carmack × TS expert × Beck | 5 |
| 7 | Overlap merges (sidebar / heartbeat × #634 / PID #589) | TS expert × Hunt × Beck | 6 |
| 8 | Protocol & state-machine merges (#613) | TS expert × Willison | 7 |
| 9 | Quarantine inert upstream + sandbox lifecycle | Deploy × Hunt | 5 |
| 10 | Chat block UI integration (#597 visual) | Saarinen × Friedman × TS expert | 6 |
| 11 | Status region consolidation | Friedman × Saarinen × TS expert | 7, 8 |
| 12 | Onboarding + token settings UX | Friedman × Saarinen × Hunt × Willison | 5, 6 |
| 13 | Recording hub: hidden + redacted + as-eval | Saarinen × Hunt × Willison | 8, 12 |
| 14 | Container liveness affordance | Friedman | 9 |
| 15 | Drift detector + workflow doc + tidy follow-up | Carmack × Beck × Hunt | 1–14 |

---

## Verdict

The single most important architectural decision in this plan is **Task 2 — minimal named-function seams in the four hotspots BEFORE the merge starts.** Every interleaved spot in `ws-bridge.ts` / `session-state-machine.ts` / `Sidebar*.tsx` / `update-checker.ts` is a future merge conflict. Pulling Aura's added behavior into a single named function each shrinks every conflict from a tangled hunk to a one-line call site. Fowler's economic test passes — this pays off on the next 1–2 syncs, not in 6 months.

The most critical expert lens for this merge is **TS/backend correctness** (Tasks 7 and 8). The state-machine, heartbeat, and channels-protocol surfaces are where silent regressions live; everything else is recoverable. If you start anywhere, start with the **pre-merge regression net (Task 3)** so a regression at any later step is loud, not silent.

Carmack would be direct: **don't write paragraphs of upfront fit assessment.** The real assessment happens *as you land each chunk*, because conflicts only become visible at resolution time. The 30-minute upfront skim is a triage, not a decision document. And: bump to **1.1.0**, not 1.1.1 — but document it either way. Five upstream minors deserves a minor on our side.

Pair recommendation: keep this plan open in a tab while you work. Tasks 5–8 are where things can actually go wrong; the rest is execution.
