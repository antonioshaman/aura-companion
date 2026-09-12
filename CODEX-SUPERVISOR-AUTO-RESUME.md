# Codex Supervisor Auto Resume Report

Generated: 2026-09-12T16:56Z

## Already committed

- `75e2845 fix(server): pause automation on API limits`
- Commit contents:
  - pauses model fallback on `rate_limit` / `out_of_credits` instead of switching model and killing/relaunching;
  - marks the idle auto-proceed manager as API-limited and cancels armed timers;
  - substitutes known-broken `claude-fable-5-1` to `claude-opus-4-8`;
  - adds targeted tests for the API-limit pause behavior and model substitution.

## Current Aura Companion state

- Git HEAD: `75e2845`
- Live server: `bun server/index.ts`, PID `3320793`
- Claude orchestrator session `e3c30725-4b97-49d4-933c-0be3ba19646c`:
  - state: `connected`
  - pid: `3321252`
  - model: `claude-opus-4-8`
  - role: `orchestrator`
- Claude observer session `eaef74e6-ab7d-4a14-a36e-e7f6aa101bf3`:
  - state: `connected`
  - pid: `3321262`
  - model: `claude-opus-4-8`
  - role: `observer`
- Codex supervisor session `59131133-0cca-4c9a-9bcc-749b3501c550`: connected.

No `/relaunch`, no extra Claude messages, no subagents, and no push were performed by this supervisor pass.

## Guarded resume script

Checked `.scheduled/codex-supervise-after-limit-reset-20260912T165200Z.log`.

- The script started at `2026-09-12T16:52:00Z`.
- It saw `five_hour.utilization=0.0` and sent exactly one guarded resume message to Claude orchestrator.
- It waited 30 seconds.
- It measured `usage_delta=0.0`.
- It did **not** detect rapid drain.
- It did **not** call `/kill` for the Claude pair.
- It relaunched and messaged only the Codex supervisor session afterward.

## Usage after launch

Latest usage endpoint check at about `2026-09-12T16:56Z`:

- Orchestrator:
  - `five_hour.utilization`: `5`
  - `five_hour.resets_at`: `2026-09-12T21:50:00.676471+00:00`
  - `seven_day.utilization`: `67`
- Observer:
  - `five_hour.utilization`: `5`
  - `five_hour.resets_at`: `2026-09-12T21:50:00.676471+00:00`
  - `seven_day.utilization`: `67`

This is not a repeat of the earlier 100% rapid drain, but the logs show fresh rate-limit surfaces after resume, so Claude work should be considered stopped for now.

## New cascade / limit evidence

Recent server log evidence:

- Observer hit API limit and the new committed guard paused fallback:
  - `Model fallback paused for API limit | sessionId=eaef74e6-ab7d-4a14-a36e-e7f6aa101bf3 ... reason=rate_limit`
- Orchestrator later hit API limit and the same guard paused fallback:
  - `Model fallback paused for API limit | sessionId=e3c30725-4b97-49d4-933c-0be3ba19646c ... reason=rate_limit`
- No recent `server:auto-proceed` or successful new observer review cascade was found in the checked logs.
- A spawn checkpoint observer wake was sent during server startup before the observer rate-limit pause:
  - `group.observer_wake_dispatched ... checkpointId=spawn-grp_2b61aa2f42b3ea90003cd14569a75ce9 sequence=0`

## Systemic cause analysis

`/council-review-aura` is not available in this Codex session. The available `/council-review` skill would dispatch subagents, which is explicitly forbidden by the supervisor prompt, so I used local code review only.

Likely limit-burning chains reviewed:

- Model fallback:
  - fixed by `75e2845`; `rate_limit` and `out_of_credits` now pause instead of switching models and relaunching.
- AFK auto-proceed:
  - fixed by `75e2845`; a rate limit calls `IdleTimerManager.noteApiLimitReached`, cancels timers, and blocks future fires with `api-limit-reached`.
- Observer wake:
  - residual risk found. Observer wakes are also server-originated Claude prompts, but `dispatchObserverWake` did not check the API-limit circuit breaker. A later checkpoint could wake an already rate-limited observer again.
- Relaunch loop:
  - no fresh post-resume Claude relaunch loop found. Startup did auto-relaunch existing dead backends, but current fresh evidence is rate-limit pause, not relaunch churn.
- Subagents/background agents:
  - no new local subagent launch was performed by Codex; Claude-side guarded prompt explicitly forbade subagents/background agents.

## Safe local fix added after supervisor review

Uncommitted local changes added by this pass:

- `web/server/idle-timer-manager.ts`
  - added `isApiLimitReached(sessionId)` read-only probe.
- `web/server/session-orchestrator.ts`
  - `dispatchObserverWake` now returns `skipped:api_limit_reached` and does not send an observer wake if that observer session previously hit an API limit.
- `web/server/session-orchestrator.test.ts`
  - added regression test proving an API-limited observer is not woken.

Verification:

- `cd web && bun run typecheck` passed.
- `cd web && bun run test -- server/session-orchestrator.test.ts server/idle-timer-manager.test.ts` passed: 265 tests.

Important: I did **not** restart the live server after this new local fix, because a restart can relaunch/reconnect Claude processes and potentially cause more Claude API usage. The fix is verified locally, but it is not loaded into the currently running server process until a deliberate restart/deploy.

## Dirty/untracked files observed

I did not delete any old artifacts.

- Modified:
  - `.agents/knowledge/gotchas.jsonl`
  - `web/server/idle-timer-manager.ts`
  - `web/server/session-orchestrator.ts`
  - `web/server/session-orchestrator.test.ts`
- Untracked:
  - `.scheduled/`
  - `SESSION-AUTO-RESUME-REPORT.md`
  - `SESSION-REPORT-2026-09-08.md`
  - `scripts/codex-supervise-after-limit-reset.sh`
  - `specs/DECISION-176-vs-177-stability.md`
  - `web/.council/`
  - `CODEX-SUPERVISOR-AUTO-RESUME.md`

## Can the user manually resume Claude tonight?

Yes, but only after checking the usage endpoint first. If `five_hour.utilization` is comfortably below 95 and `locked_reason` is null, a manual resume is reasonable. If it is close to 95 or rate-limited again, do not send anything to Claude.

Because both Claude halves have already emitted fresh rate-limit events, resume should be one short orchestrator-only message. Do not wake observer manually.

Recommended first phrase for Claude orchestrator:

```text
Resume cautiously from the last state. Do not start subagents, do not use council/observer checkpoints, do not auto-proceed, do not relaunch sessions, and stop immediately if you see any rate_limit/session-limit/out_of_credits signal. First, summarize what is already done and what remains, then wait for my confirmation before making changes.
```

## What not to do

- Do not send repeated "continue" messages.
- Do not use Council Mode observer until the new observer-wake API-limit gate is loaded by a deliberate server restart/deploy.
- Do not run `/relaunch` on the Claude sessions while usage is uncertain.
- Do not enable auto-proceed/AFK continuation for this pair.
- Do not start subagents/background agents in Claude.
- Do not push until the user reviews the local diff and decides whether to commit the new guard.

## Follow-up monitoring after Haiku batch review

Updated: `2026-09-12T19:16Z`

- The user manually launched the remaining review work in Claude on Haiku 4.5.
- Codex did not send any extra observer/orchestrator messages.
- A synthesized final review was produced locally at `.council/review-output/2026-09-11-2112/FINAL-REVIEW.md`.
- The Claude-side session report was updated at `SESSION-AUTO-RESUME-REPORT.md` and says the review completed in batch mode with 21 findings.
- Observed usage stayed bounded during the run:
  - about `8%` at `19:07Z`;
  - about `10%` at `19:09Z` and `19:11Z`;
  - about `11%` at `19:13Z`.
- No fresh rapid-drain kill was observed.
- Because the orchestrator already produced the final synthesis, sending a separate observer synthesis request would duplicate work and spend more Claude limit.

## Additional safe local fixes from the final review

Implemented locally, without Claude API usage:

- `web/server/ws-bridge-cli-ingest.ts`
  - `parseNDJSON` now trims each NDJSON line before `JSON.parse`.
- `web/server/claude-adapter.ts`
  - the silent-stdio watchdog now records liveness when any non-empty CLI line arrives, even if that line later fails JSON parsing.
- `web/server/model-fallback-chain.ts`
  - fallback selection now skips targets that would be substituted back to another model at spawn time, closing the `claude-opus-4-8 -> claude-opus-4-7 -> claude-opus-4-8` loop.
- `web/server/ws-bridge-cli-ingest.test.ts`
  - added a whitespace-trim regression test.
- `web/server/model-fallback-chain.test.ts`
  - updated fallback expectations and added a regression test for the substitution loop.

Verification:

- `cd web && bun run test -- server/ws-bridge-cli-ingest.test.ts server/claude-adapter.test.ts server/model-fallback-chain.test.ts` passed: 174 tests.
- `cd web && bun run typecheck` passed.

Note: I reviewed the final review's P1 observer-prompt-loader claim against current code and did not apply that patch. The active spawn path already constructs `.council/prompts/observer-system.md` before calling `resolveObserverSystemPrompt`, so changing the resolver based only on that finding would be riskier than leaving it for a focused follow-up.

## Final Claude pair supervision after stability follow-ups

Updated: `2026-09-12T20:20Z`

Active pair observed after the user restarted follow-up work:

- Orchestrator: `de1c233f-8840-4d15-855a-a8574b96bc2d`, live pid `3356910`, model `claude-opus-4-8`.
- Observer: `fe1b650d-6f6e-45f8-8e55-bcda8fb5b9f5`, live pid `3356975`, model `claude-opus-4-8`.
- Branch: `fix/stability-audit-followups`.
- HEAD: `cf72f72 fix(security): verify Codex process identity before SIGTERM (P3-4)`.

Committed by the Claude orchestrator after `a3e3e83`:

- `2273f19 fix(council): backstop timer for stranded observer wake turn (P2-3)`
- `b3d634d fix(council): escalate stuck catch-up wake to degraded instead of looping (P1-1)`
- `de58bd2 fix(security): restrict system-process kill to the session's own dev processes (P3-5/P3-7)`
- `c56d17e test(council): cover silence-rotation + watchdog wiring gaps (P2-4/P2-5/P2-6)`
- `cf72f72 fix(security): verify Codex process identity before SIGTERM (P3-4)`

The final observer command was sent only after the main fix series appeared complete and the worktree was otherwise clean. It asked the orchestrator to emit a checkpoint for all commits after `a3e3e83`, wait for observer review, and avoid new fixes, subagents, push, relaunch, or auto-proceed.

Observer review result:

- Review file: `.council/reviews/council-implement-grp_40bce3c046c0e6fd6c2f62264ac52cdc-claude-observer.md`
- Checkpoint: `council-implement-23-03dae29a`
- Findings: `1 INFO`, `0 WARN`, `0 STOP`
- Downgrades: none.
- High-confidence observer conclusion: all four closed findings were independently verified against live code; no correctness or contract defect was found.

Usage at the final check:

- Orchestrator usage endpoint: `five_hour.utilization=45`, `resets_at=2026-09-12T21:50:00.266010+00:00`, `locked_reason=null`.
- Observer usage endpoint: `five_hour.utilization=45`, `resets_at=2026-09-12T21:50:00.266010+00:00`, `locked_reason=null`.
- No fresh rapid-drain kill was observed during this final supervision pass.

Verification reported by the Claude orchestrator:

- `cd web && bun run typecheck` passed.
- Full test suite reported `7836 passed`, `1 skipped-family`, and `1 failure` in `evals/supply-chain.test.ts` / pack-exclusion guard. The orchestrator investigated it as an environment/systemd stale-state issue rather than a branch regression; this should still be rechecked before merge.

Current local artifacts:

- Untracked: `.council/IMPLEMENTATION-CONTEXT-stability-audit.md`
- No push was performed.

Recommended next manual Claude phrase, only if usage is still healthy:

```text
Observer review is in with 0 STOP and 0 WARN. Do not start new fixes, subagents, relaunches, or observer checkpoints. Give me the final concise handoff: commits made, tests run, known residual risk, and exact next manual steps.
```

Do not ask Claude to continue implementation unless a human first reviews the remaining full-suite failure and decides it is actually related to this branch.

## Codex takeover after orchestrator stopped responding

Updated: `2026-09-12T20:39Z`

After the observer review landed, the Claude orchestrator did not produce a final handoff. A single short final-handoff message was sent to the orchestrator API and the recording shows the user frame was delivered to the CLI, but no subsequent `status: requesting`, `assistant`, or `result` frame appeared. The process still reports `connected`, so this looks like a live-but-deaf/stuck CLI bridge rather than an unfinished implementation turn.

No further Claude messages were sent.

Latest observed Claude usage after that attempt:

- `five_hour.utilization=53`
- `resets_at=2026-09-12T21:50:00.982415+00:00`
- `locked_reason=null`

Codex completed the remaining local verification without Claude:

- `cd web && bun run typecheck` passed.
- `cd web && bun run test -- server/claude-adapter.test.ts server/session-orchestrator.test.ts server/routes.test.ts server/cli-launcher.test.ts` passed: `708 passed`.
- `cd web && bun run test -- evals/supply-chain.test.ts` still has the single known failure in the pack-exclusion guard. Root cause is local ownership: current user is `auracomp`, but `web/package.json` is `root:root` with mode `644`, so `bun pm pack --dry-run` aborts with `EACCES` before it can enumerate tarball contents. The `web/` directory itself is writable.

Current git status after Codex takeover:

- Modified: `CODEX-SUPERVISOR-AUTO-RESUME.md`
- Untracked: `.council/IMPLEMENTATION-CONTEXT-stability-audit.md`
- Ignored runtime council files remain ignored and were not deleted.

Recommended manual close-out:

1. Commit the updated report/context if you want the session artifacts preserved.
2. Fix local ownership before full-suite/pack guard validation: make `web/package.json` writable by the working user or run the pack-exclusion guard in the intended CI/package environment.
3. Review the five stability commits and observer verdict, then merge/restart deliberately. Do not rely on the currently stuck Claude pair for more work.
