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

## Project folders (`COMPANION_FS_ALLOWED_BASES`, `COMPANION_PROJECT_DIR_SUDO`)

A new session or council pair whose folder does not exist on the server gets it created before the CLI spawns, and a git repository entered in the folder picker (manual path → "Git repository") is cloned into it (`web/server/project-dir.ts`). Without this the spawn fails as `ENOENT … posix_spawn '<claude binary>'` — Bun reports a missing **cwd** that way. An existing folder is never touched.

- Folders are created only inside the folder-picker allowlist: the service user's home, the server cwd, and the colon-separated `COMPANION_FS_ALLOWED_BASES`.
- When projects live in a directory the service user cannot write (e.g. `/root` with `COMPANION_FS_ALLOWED_BASES=/root`), set `COMPANION_PROJECT_DIR_SUDO=1`: the server then runs `sudo -n install -d -o <service uid> -g <service gid> -- <folder>` (requires passwordless sudo for that command); if the clone then fails, it removes the empty folder with `sudo -n rmdir -- <folder>` so a retry clones again. Without the flag the error names the command to run by hand.
- Private repositories clone with the service user's git credentials; `GIT_TERMINAL_PROMPT=0` makes a missing credential fail fast instead of hanging the create request.

## Package-update restart storms and failed-service recovery

On 2026-10-21, Ubuntu unattended upgrades ran `needrestart` after successive
package batches. It restarted Aura at 06:27:00, :04, :08 and :15 UTC. Surviving
children under `KillMode=process` can still reference old libraries after the
parent restarts, so restarting the parent does not necessarily clear the
`needrestart` finding. The fourth start exceeded the host's three-starts-per-minute
budget. `Restart=always` does not recover a service blocked by `start-limit-hit`;
the server stayed down until its failure budget was explicitly reset.

Install the following host integration from the repository root as root:

```bash
install -d /usr/local/libexec /etc/needrestart/restart.d
install -m 0755 scripts/aura-recover.sh /usr/local/libexec/aura-recover
install -m 0755 scripts/deploy-drop-ins/aura-companion.needrestart /etc/needrestart/restart.d/aura-companion.service
install -m 0644 scripts/deploy-drop-ins/aura-companion-recover.service scripts/deploy-drop-ins/aura-companion-recover.timer scripts/deploy-drop-ins/aura-companion-update-restart.service scripts/deploy-drop-ins/aura-companion-update-restart.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now aura-companion-recover.timer
```

The needrestart-specific hook debounces requests for two minutes instead of
restarting Aura for every package batch. The deferred service is ordered after
`apt-daily-upgrade.service` and uses `try-restart`, so a manually stopped server
stays stopped. Automatic package updates remain enabled. Surviving agents may
still use old libraries until those agents exit; a parent restart cannot update
their loaded code.

An independent recovery timer checks every five minutes after each check finishes.
Only an enabled service in `failed` state has its failure budget reset and is
started again. Active, starting, intentionally stopped, disabled and masked
services are left alone. The original start limit stays in place. This backstop
recovers failed services; it does not diagnose an active process whose HTTP loop
has hung, and it cannot remove provider usage limits.

Check `journalctl -u aura-companion-recover -u aura-companion-update-restart`,
`systemctl list-timers 'aura-companion-*'`, and `curl http://localhost:3456/ready`.
To roll back, disable `aura-companion-recover.timer` and remove the installed
needrestart hook; no application restart is required to install this integration.

## Browser daemon idle shutdown

On a Linux host, Claude and Codex receive a unique browser name
(`AGENT_BROWSER_SESSION=aura-<sessionId>`), the ownership marker
`AURA_BROWSER_SESSION_ID`, and `AGENT_BROWSER_IDLE_TIMEOUT_MS=0`. A browser
owned by a nonarchived session is retained even while the agent waits hours or
days for a usage limit to reset. Both CLI transports use the same policy.

Every minute, `session-browser-cleanup.ts` checks the host user's daemon
pidfiles. It verifies UID, native executable, ownership marker and kernel start
time, then rechecks identity and the owner's archive state before issuing a
graceful `close` for that browser name. Archived owners are eligible; deleted
owners are eligible after a five-minute registration grace. Unmarked or
unreadable processes are left alone. Ownership is rediscovered after an Aura
restart. At most ten closes run per sweep; sweeps do not overlap.

Containers and non-Linux hosts retain a bounded idle timeout because the host
cleaner cannot prove ownership of their daemon sockets. Preservation until
archive currently applies to Linux host sessions only.

`AURA_BROWSER_SESSION_IDLE_TIMEOUT_MS` can explicitly bound Linux host session
browsers. A per-session `AGENT_BROWSER_IDLE_TIMEOUT_MS` override takes precedence;
`0` disables idle shutdown and explicit undefined unsets the variable. Custom
browser names are supported, but sharing a custom name across sessions forfeits
default isolation. The installed agent-browser must support the timeout variable;
Aura does not install or upgrade it.

For the host, install `scripts/deploy-drop-ins/browser-idle-timeout.conf` as
`/etc/systemd/system/aura-companion.service.d/70-browser-idle.conf`, reload systemd
and restart Aura once. This bounds unowned children inheriting the service
environment. Existing daemon environments cannot be changed retroactively;
an already-running unmarked daemon does not acquire ownership from this change.

Where idle shutdown remains enabled, it discards transient tabs/state unless the
caller configured persistence; a later command starts a new daemon. The host's
weekly `/root/scripts/aura-hygiene.sh` no longer kills every matching Chrome
process: it only removes old browser profile directories not referenced by a live
Chrome process. Its unrelated cleanup steps remain in place.
