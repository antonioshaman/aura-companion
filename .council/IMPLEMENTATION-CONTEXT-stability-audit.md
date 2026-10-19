# Council Implement — Stability Audit Follow-ups (context for observer review)

**Branch:** `fix/stability-audit-followups` · **Range:** commits after `a3e3e83` through HEAD (`cf72f72`).
**Source:** findings from `.council/review-output/2026-09-11-2112/FINAL-REVIEW.md`, each re-verified against LIVE code before acting (the review was substantially stale).

## Findings CLOSED in this series (review these diffs)
- **P2-3** (`2273f19`) — `web/server/claude-adapter.ts`: ported the observer-wake completion backstop from the Codex adapter (`OBSERVER_WAKE_COMPLETION_WATCHDOG_MS = 360_000`). A `result` frame lost/split so it never parses no longer strands `observerTurnState` in-flight forever. Armed on in-flight, cleared on every idle-return (result/detach/transport-close/reattach); on expiry force-releases the slot + emits `observer:turn-done`.
- **P1-1** (`b3d634d`) — `web/server/session-orchestrator.ts`: `scheduleCatchupWakeWhenObserverReady` timeout previously logged WARN and gave up with no sentinel → EC-13 failsafe re-scanned forever (120-cycle no-op loops). Now counts consecutive timeouts per (group,checkpoint); at `OBSERVER_CATCHUP_TIMEOUT_ESCALATION_THRESHOLD = 3` escalates via `coordinator.applyEvent(half_died, observer, wake_send_failed)`. Degraded group is skipped by the scan → loop closes. Reset on successful wake; cleared on teardown.
- **P3-5 + P3-7** (`de58bd2`) — `web/server/routes.ts`: `POST /sessions/:id/processes/system/:pid/kill` would SIGTERM ANY caller pid. Extracted `scanSessionDevProcesses` (shared with the GET listing) and gate the kill on membership; **fail-closed** (500, no kill) if the ownership scan throws. Closes arbitrary-kill + reaper argv-gate bypass.
- **P3-4** (`cf72f72`) — `web/server/cli-launcher.ts`: both Codex kill paths (`shouldSignalPreviousInstancePid`, `restoreFromDisk`) bypassed identity verification. The "future work" comment was stale — `argvMatchesSessionId` already falls back to `argvSha256(tokens) === sidecar.argvSha256` for no-`--sdk-url` sessions, and Codex spawns write that sidecar. Both paths now run `verifyProcessIdentity` (match/unavailable → kill; mismatch/gone → skip). Codex semantics preserved (session ends `exited`, WS port released regardless).
- **P2-4/5/6** (`c56d17e`) — test-only: orchestrator/adapter wiring around silence rotation + the 300s watchdog default (`handleBackendSilent` kill+toast+strike-count, `orchestrator:turn-done` reset, `ClaudeAdapter` arms watchdog at 300000ms).

## Findings NOT changed (verified already-fixed or non-issue — do NOT re-flag)
- P1-2 (parseNDJSON already `.map(trim)`), P1-3 (`onFrame()` already outside parse), P1-4 (`nextModelInChain` already resolves substitutions, #182), P1-6 (call site builds full prompt path), P2-2 (observer wakes never arm the watchdog), P2-7 (Codex substitution guard is intentional — table is Claude-only), P3-1 (no `temperature` sent anywhere), P3-6 (`--resume-session-at` is a message UUID, not a path).

## Verification
- `bun run typecheck`: clean.
- `bun run test`: **7836 passed / 40 skipped / 1 failed**. The single failure is `evals/supply-chain.test.ts` → `bun pm pack --dry-run` EACCES on the read-only `/root/.../package.json` — a known host-environment limitation, NOT caused by these changes.

## Known residual risk / not done
- **P2-1 (deferred):** resume-target-probe before discarding `cliSessionId`. Already mitigated by the 2-strike/5s gate. Both candidate fixes (subprocess `-p ""` probe — an anti-pattern per CLAUDE.md; transcript-existence check — risks looping on a genuinely-bad resume) add risk to the prod recovery path. Flagged as a dedicated follow-up.
- **P1-5 (infra, needs root):** systemd unit PATH excludes `/home/auracomp/.local/bin` → `claude` resolves to stale 2.1.120. Fix = install `scripts/staged-unit-path-dropin.conf` as `path.conf` + daemon-reload. Not applied (awaiting rollout).
- **P3-3 (infra):** prod currently runs as an ORPHANED process (PPID=1) holding :3456; the systemd unit is `failed` because the port-guard `ExecStartPre` aborts while the orphan holds the port. Root cause is the unmanaged orphan, not a guard bug; resolved by re-establishing systemd ownership at rollout.
- Rollout (merge to main + restart) is pending explicit user go-ahead; not performed.
