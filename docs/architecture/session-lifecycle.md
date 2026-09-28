# Session lifecycle

> Moved out of `CLAUDE.md` in P2/A3 (2026-09-28). `CLAUDE.md` links here with one line;
> this file is loaded on demand, not on every session start.


Sessions persist to disk and survive server restarts. What happens to the *process* on
restart depends on the transport:

- **WS transport** — live CLI processes are detected by PID and given a grace period to
  reconnect their WebSocket. If they don't, they're killed and relaunched with `--resume`.
- **stdio transport (default)** — the pipes died with the previous server process, so a
  surviving PID can never talk to the new server. Boot recovery verifies identity (see
  below) and SIGTERMs it rather than leaving a session that looks alive but is deaf. The
  record keeps `cliSessionId`, so the next message relaunches with `--resume` and the
  conversation continues where it stopped.

**Process identity** (`process-identity.ts`) anchors on the `--sdk-url <sessionId>` argv
token for WS sessions. stdio argv carries no sessionId at all, so the spawn-time sidecar's
`argvSha256` is the equivalent anchor — without it a healthy stdio CLI reads as `mismatch`
and the orphan-reaper kills it.

