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

`cron-turn-on-resume.json` — W3 (2026-10-16): prod recording
2026-10-16T07:02:40Z, session 40f03a1e, CLI 2.1.283, sanitized (cli session
id, cwd, tool list). A `--resume`d CLI that owns a durable cron job dequeued
the cron prompt on startup, before reading the init probe from stdin. bun's
blind 200 ms interrupt (it went out 7.5 s late — the CLI was still loading)
then cancelled the cron turn. `in` frames: `command_lifecycle started` for
the cron's uuid, `system.init`, `status` — the CLI's first stdout burst.
Used by `server/init-probe-reconnect.replay.test.ts` ("cron turn").
