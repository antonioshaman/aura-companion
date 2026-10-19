# Production deployment

> Moved out of `CLAUDE.md` in P2/A3 (2026-09-28). `CLAUDE.md` links here with one line;
> this file is loaded on demand, not on every session start.

> **Correction (P2/A3):** item 1 below was written for the legacy WS transport. Under the
> default **stdio** transport the child's pipes die with the bun parent, so a surviving
> `claude` process cannot reconnect — boot recovery SIGTERMs it and the next message
> relaunches it with `--resume` (see [session-lifecycle.md](session-lifecycle.md)).
> `KillMode=process` is still required: the embedded-terminal reaper's boot-reconcile pass
> depends on it (`docs/deploy/vps-systemd.mdx`), and the conversation continues via `--resume`.
> The same stale "reconnect" wording in `vps-systemd.mdx` lines 15/74 is not fixed here.


For self-hosting on a Linux VPS or any non-loopback origin, two things matter beyond the dev setup:

1. **Run under a systemd unit with `KillMode=process`** — see [`docs/deploy/vps-systemd.mdx`](../deploy/vps-systemd.mdx) for a minimal recipe. `KillMode=process` ensures that when the bun parent is restarted, the long-lived `claude` / `codex` child subprocesses survive and reconnect over the local WebSocket; without it every restart kills in-flight agent work.

2. **Set `COMPANION_ALLOWED_ORIGIN`** to the exact origin (`scheme://host:port`, no trailing slash) the browser will use. Localhost dev origins (`http://localhost:5173`, `http://localhost:5174`) are always allowed; everything else — public IP, LAN host, tailscale `*.ts.net`, reverse-proxy domain — must appear in the comma-separated value, or the WS upgrade is rejected and the UI surfaces `Connection timeout` after `Session started`. The gate is enforced in `web/server/middleware/origin-allowlist.ts` and applied to `/ws/browser`, `/ws/terminal`, `/ws/novnc`. CLI subprocess WS (`/ws/cli/:id`) is exempt because it always comes from loopback.

If a user reports timeouts at the last step of session creation while earlier steps (`Environment resolved` / `Fetch complete` / `Session started`) report green, the first canary is the producer-side fanout count in periodic `[diagnostics]` log lines: `browsers=0` with active sessions means the Origin allowlist is rejecting the UI, not a subprocess problem.

