# Raw protocol recordings & eval sidecar

> Moved out of `CLAUDE.md` in P2/A3 (2026-09-28). `CLAUDE.md` links here with one line;
> this file is loaded on demand, not on every session start.

## Raw Protocol Recordings

The server automatically records **all raw protocol messages** (both Claude Code NDJSON and Codex JSON-RPC) to JSONL files. This is useful for debugging, understanding the protocol, and building replay-based tests.

- **Location**: `~/.companion/recordings/` (override with `COMPANION_RECORDINGS_DIR`)
- **Format**: JSONL — one JSON object per line. First line is a header with session metadata, subsequent lines are raw message entries.
- **File naming**: `{sessionId}_{backendType}_{ISO-timestamp}_{randomSuffix}.jsonl`
- **Disable**: set `COMPANION_RECORD=0` or `COMPANION_RECORD=false`
- **Rotation**: automatic cleanup when total lines exceed 1M (configurable via `COMPANION_RECORDINGS_MAX_LINES`)

Each entry captures:
```json
{"ts": 1771153996875, "dir": "in", "raw": "{\"type\":\"system\",...}", "ch": "cli"}
```
- `dir`: `"in"` (received by server) or `"out"` (sent by server)
- `ch`: `"cli"` (Claude Code / Codex process) or `"browser"` (frontend WebSocket)
- `raw`: the exact original string — never re-serialized, preserving the true protocol payload
- `origin` (optional, on `"out"` frames only): provenance of the send. One of `"browser"` (default; field usually omitted on-disk to keep entry size minimal — browser-relayed sends are the common case), `"server:council-wake"` (synthesised by the Council Mode auto-wake dispatcher), or `"server:auto-proceed"` (synthesised by the orchestrator-idle auto-proceed pipeline on idle-timeout). Inbound (`"in"`) frames never carry `origin` — provenance is implicit from the CLI subprocess.

**REST API**:
- `GET /api/recordings` — list all recording files with metadata
- `GET /api/sessions/:id/recording/status` — check if a session is recording + file path
- `POST /api/sessions/:id/recording/start` / `stop` — enable/disable per session

**Code**: `web/server/recorder.ts` (recorder + manager), `web/server/replay.ts` (load & filter utilities).

## Eval Sidecar (opt-in, default OFF)

The Council Eval Harness (`web/evals/`) can score observer recall and re-run the grounding gate hermetically only if it has the grounding gate's **inputs** at review time — the raw pre-grounding findings, the `{delta, carried, dropped}` manifest partition that was the modified set, and the per-path existence answers the gate consulted. The WebSocket recording does not carry these, so an opt-in **eval sidecar** freezes them.

- **Enable**: set `COMPANION_EVAL_SIDECAR=1` (or `=true`). Parsing mirrors the strict, fail-closed family (`isRecordingHubEnabled`) — only the literal `"1"`/`"true"` enable it; any other value (typo, `yes`, `0`) fails CLOSED to OFF. **Production leaves it unset.**
- **Default**: OFF. `maybeEmitEvalSidecar` hard early-returns before any write when the flag is unset, so production never accumulates sidecar artifacts an operator didn't ask for.
- **Location**: `<workspace>/.council/eval/<checkpoint_id>.json`, one file per observer review, written via `writeAtomicJson` (tmp+rename+fsync) with a `EVAL_SIDECAR_MAX_BYTES` cap. `emitted_at` is the **server clock**, never the model's self-reported review time.
- **Isolation**: every failure is swallowed with a structured `council.eval.sidecar.write_failed` (EC-9) log — a sidecar problem can NEVER break the live review fanout. Emitted for new sessions only; no retrofit/backfill of existing groups.
- **Scope**: diagnostics side-channel for the post-hoc Evaluator, NOT a load-bearing live path. The protocol recording is left untouched.

**Code**: `web/server/eval-sidecar.ts` (emitter), `web/evals/schema/eval-artifact.ts` (versioned format), `web/evals/scorers/grounding-rerun.ts` (hermetic rerun oracle). The `eval:replay --ci` script scores only checked-in synthetic fixtures (`web/evals/__fixtures__/`) against `web/evals/ci-baseline.json` with a load-bearing exit code (zero LLM calls).

