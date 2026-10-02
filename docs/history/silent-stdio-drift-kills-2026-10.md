# Silent-stdio drift kills, prod 2026-09-28 → 10-02 (P7/FIX-DRIFT-FALSE-KILLS)

The silent-stdio drift detector (`web/server/silent-stdio-drift-detector.ts`, tick in `session-recovery.ts`) SIGTERMed live Claude sessions **69 times** in the window, for example the supervisor session 27× and snowlevel 19×.

## Method

Every journal line `event=silent_stdio_drift.detected` was matched to the CLI's own jsonl (`~/.claude/projects/*/<cliSessionId>.jsonl`, read-only). For 48 kills it was also matched to the protocol recording (copied out of `~/.companion/recordings`). bun's last frame is `kill − jsonl age − mtimeDeltaMs`.

A kill is **real** when the jsonl holds an `assistant` record newer than bun's last frame, i.e. model output the CLI produced and bun never received. Spot checks against the recordings found no inbound CLI frame in that gap, and the relaunched CLI redid the turn.

## Result

| Class | Kills | Shape |
|---|---|---|
| Real stdout stall | 52 | 1–25 undelivered `assistant` records. Typically 60–130 s of thinking/text/tool_use in the jsonl with zero frames at bun. |
| False | 17 | No model output yet. The session was idle (lag 93 s … 30 051 s, measured from the previous turn's result). A prompt (user or CLI-internal scheduled) was queued 0–14 s before the tick. |

The "long tool call" hypothesis is not supported by the data: no kill happened while a tool was running and the jsonl only grew by non-output records.

23 of the 52 real stalls landed within 180 s of a real stall in another session (e.g. 4 sessions at 2026-09-29 19:00–19:02, 3 at 2026-09-30 06:22–06:23). That points to a server-side cause (bun's read side, or box-wide pressure) rather than one CLI's emitter. This is not fixed here; it is listed as an open question.

## Fix

The kill now also needs evidence. The jsonl tail (last 1 MB, read only once the lag check already fired) must hold at least one `assistant` record newer than bun's last frame and at least 10 s old. Without it the tick logs `silent_stdio_drift.suppressed` (reason `no_undelivered_output`, once per stall) and leaves the CLI alone. `silent_stdio_drift.detected` now carries `undeliveredAssistantRecords`.

Replay of all 69 kills through the gated rule (15 s ticks, jsonl state at each tick):

| | Old rule | Gated rule |
|---|---|---|
| False kills | 17 | 0 |
| Real stalls killed at the same tick (or earlier) | 52 | 48 |
| Real stalls delayed by one tick (output < 10 s old) | — | 4 |

EC-6 replay tests use three of these kills (`web/server/__fixtures__/silent-stdio-drift/`).

An onset-based lag ("count from the first tick that saw the jsonl ahead") was tried and dropped: it removes the false kills too, but delays 34/52 real kills.
