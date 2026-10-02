# silent-stdio drift replay fixtures

Real prod kills by the silent-stdio drift detector (P7/FIX-DRIFT-FALSE-KILLS,
journal `event=silent_stdio_drift.detected`, 2026-09-28 → 10-02).

Each file holds:

- `bunLastFrameMs`: bun's last inbound CLI frame, derived from the journal line (`kill - jsonl age - mtimeDeltaMs`) and cross-checked against the protocol recording.
- `originalKillAtMs`: when the prod tick killed the CLI.
- `jsonl`: the CLI's own `~/.claude/projects/<slug>/<cliSid>.jsonl` records from 30 s before `bunLastFrameMs` up to the kill. Only `type`, `timestamp`, `operation`, attachment type and content-block types are kept. Message text is dropped.

| File | Shape |
|---|---|
| `false-kill-input-after-idle.json` | idle 7 min, user prompt queued 3 s before the kill, no model output yet |
| `false-kill-scheduled-wake.json` | idle 85 min, CLI-internal scheduled prompt queued 4 s before the kill, no model output yet |
| `real-stdout-stall.json` | 72 s of thinking/text/tool_use/tool_result in the jsonl, zero frames reached bun |
