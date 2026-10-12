# init-probe reconnect replay fixtures

`probe-interrupt-then-user.json` — the frame sequence of a Claude CLI
reconnect, taken from a prod protocol recording (2026-10-12T17:23Z) and
sanitized (session ids, cwd, tool list and the user's text replaced):

1. `frames` — bun → CLI: init-probe `user` frame (`<AURA_INIT_PROBE_MARKER>` is
   replaced by the live marker at test time), `control_request{interrupt}`
   200 ms later; CLI → bun: `control_response`, `system.init`, `status`,
   `[Request interrupted by user]`, the probe turn's
   `result{is_error, terminal_reason: aborted_streaming}`; then the human's
   next browser `user_message`.
2. `bugReply` — what the model answered before #335 when the CLI folded that
   message into the probe's "do not respond" turn (prod recording
   2026-10-12T15:17Z): `"No response requested."`.
3. `goodReply` — a normal answer.

Used by `server/init-probe-reconnect.replay.test.ts`.
