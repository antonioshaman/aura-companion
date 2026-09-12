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
