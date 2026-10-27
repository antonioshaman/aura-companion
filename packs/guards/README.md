# Guards pack — Claude Code hooks for the costliest agent failures

Hooks that act **at the moment of action**: before a risky shell command runs, right after a
deploy, and when the agent is about to say "done". They are based on incidents from 19 real
projects (`aura-diet/corpus-full/FULL-SYNTHESIS.md`, §6.1 lessons 3–6 and 14, §7 recommendations
2–3). The finding behind the format: advice written as prose in a knowledge base or memory file
did not stop repeats (the same mistake came back in 10 projects). Advice built into an executable
check did.

Python 3 standard library only (3.8 or newer), no dependencies. A typical hook run takes about
90 ms. **Fail-open:** if a guard hits an internal error, it prints nothing and exits 0, so a guard
bug never blocks the agent.

| Hook | Event | What it does |
|---|---|---|
| `guards.py pre` | `PreToolUse` (matcher `Bash`) | Returns `permissionDecision: "deny"` or `"ask"` with a reason, or `additionalContext` for a warning. |
| `guards.py post` | `PostToolUse` (matcher `Bash`) | After a deploy-like command, adds a "verify the LIVE system" reminder. |
| `guards.py stop` | `Stop` | "Done needs proof": blocks the stop once (see [`done-needs-proof`](#done-needs-proof)). |
| `guards.py check '<cmd>'` | manual | Prints the decision as JSON. Useful for debugging and for non-Claude agents. |

## Install

```sh
packs/guards/install.sh                          # dry run: prints the merged settings.json, writes nothing
packs/guards/install.sh --apply                  # merges into ~/.claude/settings.json (with a backup)
packs/guards/install.sh --settings ./.claude/settings.json --apply   # project-scoped
packs/guards/install.sh --uninstall --apply      # removes only the guards entries
```

The installer is idempotent. It finds its own entries by the `guards.py` path, keeps every other
hook and setting as it is, and writes `settings.json.bak-guards-<timestamp>` before any change.
It also preserves the file mode, for example 0600. Run it again after moving the repo, because
the hook command contains an absolute path.

## Rules

Rule ids are shown in every message as `[guards:<id>]`.

| id | Decision | Trigger | Evidence |
|---|---|---|---|
| `pkill` | **deny** | `pkill`, `killall`, `kill $(pgrep …)`, `pgrep … \| xargs kill`, including inside `sudo`, `bash -c` and `ssh host '…'` | On the shared Aura prod box a test server runs as the same user with the same argv as prod, so `pkill -f` killed production. Advice given: find the PID with `pgrep -af` / `ps`, check that it is yours, then `kill <PID>`. |
| `force-push` | ask | `git push --force` / `-f` / `--force-with-lease` / `+refspec` / `--delete` / `:ref` | Shared checkouts and branches with parallel agents (7 projects: "parallel agents / shared tree break prod"). |
| `git-reset-hard` | ask | `git reset --hard`, `git clean -f` (not `-n`) | Same: discards other agents' uncommitted work. |
| `rm-rf` | ask | `rm -rf` / `-fr` / `--recursive --force` whose target is not under `/tmp/`, `/var/tmp/` or `$TMPDIR/`, and not a top-level build dir (`node_modules`, `dist`, `build`, `.next`, `coverage`, `target`, `__pycache__`, `*.egg-info`, …). Also asks when targets come from stdin (`xargs rm -rf`). | Irreversible. |
| `sql-destructive` | ask | `DROP TABLE/DATABASE/SCHEMA`, `TRUNCATE`, `DELETE FROM` / `UPDATE … SET` without `WHERE`, sent to `psql`/`sqlite3`/`mysql`/…: in arguments, piped in, from a heredoc, or from `-f`/`<` files. Also `dropdb` and `redis-cli FLUSH*`. | aurasoul_coin 2026-06-15: a run against the PROD database wiped users and the ledger. |
| `alembic-downgrade` | ask | `alembic downgrade` (also through `uv run`/`poetry run`/`python -m`) | Drops schema and data in whichever DB the env points to. |
| `test-db` | ask | `pytest`, `alembic upgrade/downgrade/stamp`, `manage.py migrate/test/flush`, `prisma migrate/db` while the effective DB setting names a DB without a test marker | aurasoul_coin 2026-06-15 (tests against the prod DB wiped users/ledger; fixed afterwards by a `_test` guard, a915589). |
| `service-restart` | ask | `systemctl restart/stop/kill/disable/mask/…`, `service X restart/stop`, `supervisorctl restart/stop`. The reason shows the **local `hostname`**, plus the ssh target if there is one. | aurasoul 10-04: prod was started from a branch without migrations. Restarting the server that hosts the agent killed the agent's own command (exit 137). The reason suggests `systemd-run --on-active=2 …` for self-restarts. |
| `secret-rotation` | ask | Scripts or arguments with names like `rotate_token`/`rotate-secrets`; `gh secret set`, `aws secretsmanager rotate-secret/put-secret-value`, `aws iam create/delete-access-key`, `vault write`/`kv put`, `fly`/`doppler secrets set`, `kubectl create secret`, `wrangler secret put`. Shows the hostname. | warehouse: a token rotated on the wrong host caused a 10-hour outage. |
| `alembic-ssh-env` | warn (allow + context) | `alembic upgrade` inside `ssh host '…'` (or an ssh heredoc) when nothing loads the service env (`set -a; . .env`, `source …env`, `--env-file`, inline `DATABASE_URL=`, `docker …`, `systemd-run`) | auraengine ×3: over bare ssh, alembic used the default URL and migrated a local SQLite file while prod Postgres stayed old. |
| `deploy-verify` | context (PostToolUse) | After `systemctl restart/start/reload`, `docker compose up/restart`, `docker run -d`, `deploy*.sh`/`make deploy`/`npm run deploy`, `git pull/merge/reset` over ssh, `rsync … host:`, `kubectl apply`, `helm upgrade`, `fly deploy`, `pm2 restart`, … Not shown if the same command verifies after deploying (`… && curl …/health`). | "Deployed SUCCESS" without checking the live service was the most common failure class (14 of 19 projects, e.g. b3da13b2 → 17e4705b CSP hotfix). |
| `done-needs-proof` | block once (Stop) | See [below](#done-needs-proof). | Same as `deploy-verify`. |

### `done-needs-proof`

The Stop hook blocks the stop once when all of these hold:

- the current turn ran a deploy-like command;
- the final assistant message claims success (`done`, `deployed`, `shipped`, `fixed`,
  `готово`, `задеплоено`, `развёрнут`, `работает`, …);
- no verification ran after the last deploy. Verification means `curl`/`wget`/httpie,
  `journalctl`, `systemctl status`, `docker ps/logs`, `kubectl get/logs/rollout status`,
  `pm2 status`, `agent-browser`, a `*health*`/`*smoke*` script, or a `WebFetch`/browser tool call.

The current turn starts at the last real user message; tool results do not count as user messages.

The hook stays quiet when:

- the message says plainly that the result is unverified ("NOT verified", "не проверено", …);
- `stop_hook_active` is true. This prevents loops: the agent is asked once, and then it can stop.

### `test-db` heuristic, precisely

DB-looking variables are names matching `DATABASE|DB|DSN|POSTGRES|PG*|SQLALCHEMY|MYSQL|MONGO`. The
hook reads them from these sources, highest precedence first:

1. inline `VAR=… cmd` and earlier `export VAR=…` in the same command;
2. pytest-env `env =` entries in `pytest.ini`/`pyproject.toml`/`setup.cfg`/`tox.ini` (pytest only);
3. the hook's process environment;
4. `<cwd>/.env`. `cd dir && …` in the command moves the lookup to `dir`.

How the database name is found:

- URLs: the path part, for example `postgresql://…/NAME`. Credentials are never echoed.
- `sqlite:///path/NAME.db`: the file name without the extension.
- libpq DSNs: `dbname=NAME`.
- Plain `*NAME`/`PGDATABASE`/`*_DB` values: the value itself.

A name counts as a test DB if one of its `_`/`-`/`.`-separated tokens is `test`, `tests` or
`testing`. So `app_test`, `test_app` and `tests.db` count. `latest_orders` and `contest` do not.

The hook allows the command when:

- any effective DB setting names a test DB (for example a sibling `TEST_DATABASE_URL`);
- the DB is `sqlite :memory:`;
- no DB setting is found at all.

Known blind spots: DB URLs built in `conftest.py`, settings modules, or the remote env of an ssh
command. The check is deliberately best-effort. If it gives a false "ask", disable the rule.

### Parsing notes and false-positive guards

Commands are tokenised with `shlex` and split on `; && || | ( ) &` and newlines. The hook then
unwraps:

- leading `VAR=` assignments;
- the wrappers `sudo`, `env`, `nohup`, `timeout`, `nice`, `setsid`, `xargs`, `systemd-run`, …;
- `bash -c '…'`, `ssh host '…'`, `ssh host <<EOF`, `docker exec CTR …`, `eval`.

Heredoc bodies are only analysed when they feed a shell, ssh or a DB client. Because of that,
these are allowed:

- `cat > x.sql <<EOF … DROP TABLE … EOF`;
- `git commit -F - <<EOF … pkill …`;
- `echo "DROP TABLE"`;
- `grep pkill`;
- `kill 12345`;
- `pgrep -af …`;
- `pytest` against `*_test`.

All of these cases are in the test table.

## Disabling rules

- For one session or machine: set `GUARDS_DISABLE=pkill,rm-rf` in the environment Claude Code
  runs in (for example the `env` block of `settings.json`). The hook reads it from **its own**
  environment. `GUARDS_DISABLE=all` turns the whole pack off.
- For one project: create `<project>/.claude/guards.json` with `{"disable": ["service-restart"]}`.
- To remove everything: `packs/guards/install.sh --uninstall --apply`.

An inline prefix such as `GUARDS_DISABLE=service-restart ssh host 'systemctl restart x'` does
**not** work. The hook checks the command string before it runs, so the prefix never reaches the
hook's environment.

Each `ask`/`deny` reason ends with a footer that starts with `(guards decision: ask.` or
`(guards decision: deny.`. The footer tells the agent to ask the user instead of retrying, points
to "Allow once" in Aura (for `ask` only), and gives the exact `.claude/guards.json` snippet for a
project-level opt-out. The Aura server reads the `(guards decision: …` marker, so keep its wording
stable.

## Allow once (Aura)

In Aura's agent mode the Claude CLI runs with `permissionMode: bypassPermissions`. In that mode an
`ask` from this hook is denied automatically, and the user is never prompted. Aura shows the denial
in the chat as a card with the rule, the reason, the exact command, and two buttons: **Allow once**
and **Dismiss**.

When the user presses **Allow once**, the server:

1. Writes a one-shot entry to `~/.companion/guards-allow/<id>.json`. The directory is 0700 and the
   file is 0600. The entry has `rule`/`rules`, the `commandSha256` of the exact command string the
   server recorded from the agent's `tool_use`, the session `cwd`, `expiresAt` (now + 5 min), a
   `nonce`, and `sig`, an HMAC-SHA256 made with the key in `~/.companion/guards-allow/.hmac-key`.
2. Tells the agent to run exactly that command again.

On the next `pre` call, the hook looks for an entry that matches the command. A matching entry must
be unexpired, have a valid signature, list every `ask` rule the command triggers, have the same
command hash, and have a `cwd` equal to the hook's `cwd` or a parent of it. The hook claims the
entry first: it renames the file atomically, so only one hook can win, and then deletes it. Only
after that does it allow the command. Then:

- The approval is single-use. The next risky command asks again.
- Expired entries are deleted.
- Entries that claim to live longer than 15 minutes are ignored.
- `deny`-level findings (`pkill`) can never be allowed once.

If the key file is missing, no entry is valid.

**What the signature protects, and what it does not.** The agent runs as the same OS user as the
hook and the Aura server. A full guarantee is therefore not possible: an agent that reads
`.hmac-key` on purpose can forge an entry, and it could also edit `.claude/guards.json` or the
hook itself. The signature stops the casual case, where an agent writes a JSON file into
`guards-allow/` to approve itself. Forging an entry takes a deliberate key read. The pack is a
safety net against mistakes, not a sandbox.

This works with Claude Code only. Codex does not run these hooks, so it never shows the card.

## Codex

**This pack works with Claude Code only.** Codex CLI has no equivalent of the
PreToolUse/PostToolUse/Stop hooks, so there is nothing to install there. Its own
approval/sandbox policy is a separate, coarser mechanism. For Codex sessions, add a line to the
project's `AGENTS.md` telling the agent to run
`python3 packs/guards/guards.py check '<command>'` before restarts, migrations, destructive SQL
or rotations, and to stop if the result is `ask`/`deny`. This is advisory only. Unlike the
Claude Code hooks, Codex is not forced to comply.

## Tests

```sh
python3 -m unittest discover -s packs/guards/tests -v
```

The tests cover:

- table-driven allow/ask/deny/warn cases for every rule, with false-positive guards;
- the `test-db` heuristic: inline env, `.env`, `cd`, pytest-env, process env;
- the footer guidance (no misleading inline `GUARDS_DISABLE=` hint);
- Allow once: a matching entry is consumed and a second use asks again; a different command,
  an expired entry, a forged or unsigned entry, a missing key, a deny-level rule, or an entry
  that does not cover every `ask` rule is not honoured. Covers the cwd scope, the rename race,
  and an end-to-end run of the hook;
- the PostToolUse table;
- the Stop hook with synthetic JSONL transcripts;
- end-to-end runs of the hook over stdin/stdout, including fail-open on bad input;
- installer behaviour: dry run, idempotency, preserving foreign hooks, backup and mode,
  uninstall, refusing invalid JSON.

CI runs the suite in the `quality` job.
