# RESUME PROMPT — finish the "Sweep orphans" feature

Paste this whole file as the first message in a fresh session. It is self-contained.

## What this is
Implement the remaining tasks of the **manual "Sweep orphans"** feature per the plan
`PLAN-aura-sweep-orphans.md` (on branch `feat/sweep-orphans`). A preview-first UI + server
endpoints that reap ONLY resources this server owns and lost — its own orphaned CLI subprocesses,
archived-leak processes, old+inactive sessions, orphaned per-session timers — never another agent's
process and never the caller's own.

## Where everything is (READ FIRST)
- **Work in the isolated worktree**, NOT the shared prod checkout:
  `cd /home/auracomp/aura-e7-fix` — branch `feat/sweep-orphans` (already off `origin/main`).
  If node_modules is missing: `cd web && ln -s /root/aura-companion/web/node_modules node_modules`.
- **DO NOT touch `/root/aura-companion`** — it is the shared prod checkout, usually sitting on some
  other agent's feature branch with uncommitted WIP. Never `git checkout`/edit there.
- The plan is at `PLAN-aura-sweep-orphans.md` (also copied to `/root/aura-companion/`). Read it.
- Verify at every step: `cd web && bun run typecheck && NODE_ENV=test bunx vitest run server/sweep-orphans.test.ts`

## DONE (committed on feat/sweep-orphans, typechecks, 14 tests green)
- **Task 1** — `web/server/cleanup/reap-pid.ts`: `reapPidWithSentinel(pid, opts)` — the shared
  sentinel-before-sweep + TOCTOU-reverify + SIGTERM-only kill core. Reuses the same discipline as
  `orphan-reaper.ts`. All syscalls behind injectable seams (`kill`/`killCheck`/`readStat`/`readCmdline`/`sleep`/`now`).
- **Tasks 2, 3, 4, 6(token), 7(audit)** — `web/server/sweep-orphans.ts`:
  - `computeSweepCandidates(deps): SweepCandidate[]` — PURE classifier, 4 reasons
    (`orphan | archived-leak | stale-session | orphan-timer`), server-clock evidence, ZERO side
    effects. Self/live/not-server-owned excluded up front as a set-difference + a final safety
    assertion that throws if the caller/server pid or the caller's session slipped in.
    Ownership proof = argvSha256 in the map built from runtime sidecars (`buildOwnedFromSidecars`).
  - `sweepPreviewToken(candidates): string` — deterministic 16-hex hash binding a preview to its set.
  - `executeSweep(candidates, deps): Promise<SweepExecuteResult>` — routes each candidate:
    `orphan` → `reapPidWithSentinel`; `archived-leak`/`stale-session` → `deps.killTrackedSession(sid)`;
    `orphan-timer` → `deps.clearOrphanTimer(id)`. Idempotent, empty-set = safe no-op, per-candidate audit.
  - Key deps to wire (see interfaces `SweepComputeDeps` / `SweepExecuteDeps` in the file):
    `listSessions`, `callerSessionId`, `serverPid`, `sessionsRoot`, `killTrackedSession`,
    `clearOrphanTimer`, `listOrphanTimers`, `audit`, `sentinelRoot`.
- **Tests** — `web/server/sweep-orphans.test.ts` (14, hermetic via injected seams).

## TODO (remaining tasks — implement in this order)

### Task 5 — orchestrator methods: enumerate + clear orphaned timers
In `web/server/session-orchestrator.ts` the timer state is:
`keepaliveTimers: Map<sessionId, Timeout>` and `councilWatchers: Map<groupId, CouncilWatcherEntry>`
(holds fs.watch handles + `pendingReviewDeadline.timer`). The global `observerFailsafeTimer` is a
single interval — NOT per-session, do NOT sweep it. The silent-stdio watchdog lives in the adapter
and self-resolves — do NOT sweep it (audit for a stale dead-adapter listener ref in ws-bridge.ts
instead; ritchie §A rec6).
- Add a method that returns `OrphanTimerRef[]` = map entries whose key has NO live session/group in
  the live registry (feeds `computeSweepCandidates`'s `listOrphanTimers`).
- Add a method that clears one orphan timer by id via the SAME teardown the registry uses
  (`stopCouncilWatchers` — it ALSO closes the fs.watch handles, not just the setTimeout) — feeds
  `executeSweep`'s `clearOrphanTimer`. Never a bespoke `clearTimeout`.

### Task 6 — REST endpoints (routes.ts) + tests
Two GLOBAL endpoints (not per-session). Precedent: existing `POST /sessions/:id/kill`,
`GET /sessions/:id/processes/system`. Wire:
- `GET /api/sweep/preview` → build `SweepComputeDeps` (launcher.listSessions, callerSessionId from
  the request/session context if resolvable else null, `process.pid` as serverPid, the sessions dir
  root, orchestrator's `listOrphanTimers`), call `computeSweepCandidates`, return `{ candidates,
  token: sweepPreviewToken(candidates) }`. Response carries ONLY decision-justifying fields
  (pid, reason, evidence, sessionId) — NO full proc dump, NO co-tenant argv (hunt: disclosure surface).
- `POST /api/sweep/execute` → body must echo the `token` from a prior preview; recompute candidates
  server-side, recompute token, REJECT (409/400) if it doesn't match (binds what-was-previewed to
  what-gets-killed; hunt Principle 7 — the confirm token IS the authz for the destructive branch, not
  the bearer). Refuse any client-supplied PID. Apply a short cooldown/idempotency (hunt rec8). Call
  `executeSweep` with `killTrackedSession` = launcher/orchestrator kill, `clearOrphanTimer` =
  orchestrator method, `audit` = append JSONL (reuse `recorder.ts` line discipline; ritchie §B rec2),
  `sentinelRoot` = the reaper's `.reaping/` dir.
- **Task 7 finish**: for archived-leak/stale-session kills, ensure the tracked-kill path writes a
  terminal state to session-store (atomic, force-flushed past the 150ms debounce before the response),
  so boot recovery never reconnects a dead/recycled PID.
- Tests in `routes.test.ts`: preview shape + token; execute rejects a stale/absent token; execute
  never kills the caller/live session; empty preview → execute no-op (AC6).

### Tasks 8 + 9 — frontend Sweep page + confirm dialog + mandated tests
- New lazy Settings-family page (route `page==="sweep"`), pattern = `web/src/components/EnvManager.tsx`
  (local state, `api.ts` only, NO Zustand slice, NO persistence — re-fetch fresh on mount).
- One discriminated-union state machine: `idle|previewing|previewed|confirming|executing|executed|error`
  (TS exhaustiveness switch, not four booleans). Wrap preview+execute in `useTransition`; `isPending`
  disables the trigger (double-click guard). Initialize candidates as `null` (NOT `[]`) so the AC6
  empty state ≠ loading.
- Confirm dialog (portal, `role="dialog"`, aria-label naming the destructive action), **default focus
  to Cancel**, confirm button states the count ("Sweep 7 items"). Result view shows requested / swept
  / skipped as DISTINCT numbers (the server may skip candidates whose identity changed since preview —
  that must be visible, not collapsed into the preview count).
- Mandated `.test.tsx`: render + `toHaveNoViolations()` + a behavioural test proving clicking "Sweep"
  calls execute ZERO times and only the dialog's confirm calls it ONCE.
- `ws.ts` stays the single mutation channel for shared session state — the Sweep result is display-only.

## Hard safety invariants (must survive to the end — these are the whole point)
1. Kill only processes provably spawned by THIS server (argvSha256 in the owned map). Never a bare PID.
2. Never the caller's own session/process; never a live non-archived tracked session. (assert, not filter)
3. SIGTERM-only, re-verify identity immediately before signalling (TOCTOU).
4. Preview→confirm-token→execute; execute never trusts a client PID.
5. Every outcome (killed/skipped-*) → structured EC-9 audit line.

## Finish
- Run full suite: `cd web && bun run typecheck && NODE_ENV=test bunx vitest run`.
- Open ONE PR from `feat/sweep-orphans` → main when complete (engine + routes + frontend + tests).
- Emit the council-implement checkpoint (Phase 4) to the observer: POST the file list to
  `http://localhost:3456/api/sessions/<orchestrator sid>/council/checkpoint` (cwd `/root/aura-companion`,
  role orchestrator) — reuse the group-scoped-filename pipeline already in main.
- DO NOT restart aura-companion; DO NOT touch the shared checkout.

## Context you'll want
- Reconnect fix (surviving-but-deaf sessions) already shipped as #184 (merged) + #185 (parallel agent).
- Group-scoped council checkpoint/review filenames are already live in main (#174).
- Usage-budget note: council fan-outs (`/council-*`) are the biggest 5h-limit burn; the plan was made
  with a MINIMAL 3-expert council for exactly that reason. Don't re-run big councils casually.
