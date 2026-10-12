# aura-check — experience packs

Lessons from 19 real projects, turned into deterministic checks. A lesson written as
prose in memory or a knowledge base did not change agent behaviour (the same failure
recurred in 10 projects after it was written down); a lesson embedded in a check that
runs inside the normal process did. `aura-check` is that check: a pre-commit / CI tool
that prints a 1–3 line "why" only when it fires.

- Python 3.8+ standard library only. No install step, no network.
- Works on any repository (git or plain directory), any stack.
- Each rule has an `id`, a severity, **evidence** (project + commit/incident it comes
  from) and a **fix hint**.

Background and the lesson → check loop: [docs/experience-packs.md](../../docs/experience-packs.md).

## Usage

```bash
packs/checks/bin/aura-check                 # full scan of tracked files
packs/checks/bin/aura-check --changed       # only what the staged diff adds (pre-commit)
packs/checks/bin/aura-check --changed --base origin/main   # PR diff + its commit messages (CI)
packs/checks/bin/aura-check --commit-msg-file .git/COMMIT_EDITMSG  # commit-msg hook
packs/checks/bin/aura-check --pack secrets,env              # only these packs
packs/checks/bin/aura-check --runtime       # + installed systemd units and their checkouts
packs/checks/bin/aura-check --list          # packs and rules
```

| Option | Meaning |
|---|---|
| `--pack NAME[,NAME]` | Run only these packs (repeatable). Default: all. |
| `--changed` | Scan only lines the change adds: the staged diff, or `BASE...HEAD` with `--base`. Diff-scoped rules drop findings on untouched lines. |
| `--base REF` | With `--changed`: CI mode, also scans every commit message in `REF..HEAD`. |
| `--commit-msg-file PATH` | Scan a commit message. Alone (without `--changed`) it scans only the message. |
| `--runtime` | Also read `/etc/systemd/system` and `~/.config/systemd/user` (override with `--unit-dir`). |
| `--main-branch NAME` | Branch names a prod checkout may be on (default `main`, `master`). |
| `--format json` | Machine-readable findings. |
| `--strict` | Warnings fail too. |

**Exit codes:** `0` no errors (warnings allowed) · `1` at least one error (or any finding
with `--strict`) · `2` usage / environment problem (unknown pack, `--changed` outside git…).

Secrets are never printed: findings show a 4-character prefix and the length.

## Packs and rules

| Pack | Rule | Level | Catches |
|---|---|---|---|
| `python-alembic` | `alembic.revision-id-too-long` | error | `revision` > 32 chars (`alembic_version.version_num` is `VARCHAR(32)`; the DDL transaction rolls back on prod) |
| | `alembic.revision-id-duplicate` | error | two migrations with the same `revision` |
| | `alembic.model-change-without-migration` | warn | a `Column`/`mapped_column`/`Mapped[...]` line added or changed with no new file under `versions/` (`--changed` only) |
| `env` | `env.compose-dollar` | warn | unescaped `$` in a `.env` value next to a compose file |
| | `env.file-tracked` | error | `.env`, `.env.bak`, `bot/.env`… tracked by git (`*.example`/`.sample`/`.template` are fine) |
| | `env.file-world-readable` | error | an env file on disk with the "other" read bit (`644`) |
| `secrets` | `secrets.in-file` | error | `npm_…`, `gnk-…`, `sk-…`, Telegram bot tokens, private key blocks, GitHub/AWS/Slack tokens, `*KEY/SECRET/TOKEN/PASSWORD = <high-entropy>` |
| | `secrets.in-commit-message` | error | the same in commit messages |
| `pii` | `pii.personal-data` | warn | phone numbers; birth dates next to a name — in added lines and commit messages only |
| `llm-output` | `llm-output.raw-on-parse-failure` | warn | `json.loads`/`JSON.parse` whose `except`/`catch` returns the unparsed text (bare or wrapped) in a file that talks to an LLM |
| `fallback` | `fallback.silent-model-fallback` | warn | an error handler that switches model/provider with no log/metric call |
| `deploy` | `deploy.systemd-inline-secret` | error | `Environment=…KEY/TOKEN/SECRET…=` in a unit (repo files; installed units with `--runtime`) |
| | `deploy.workdir-not-clean-main` | warn | `--runtime`: a unit's `WorkingDirectory` is a git checkout not on main, or with modified tracked files |
| `telegram-miniapp` | `telegram.miniapp-url-unversioned` | warn | Web App / menu button URL with no `?v=`/`/<sha>/` cache-buster |
| | `telegram.fsm-swallows-commands` | warn | aiogram `@router.message(SomeState)` with no filter excluding commands (best effort) |
| `call-site-parity` | `call-site-parity.guard-missing` | warn | the diff adds an `if` guard in front of an existing call to a project function; its other call sites (≤ 10 — more means a generic helper) have no matching condition (`--changed` only) |

`aura-check --list` prints the same table from the code; the evidence for each rule is
printed under every report.

The code heuristics (`llm-output`, `fallback`, `telegram-miniapp`, `call-site-parity`) are
line-based approximations, deliberately warn-level, and skip test files.

### Suppressing a finding

- One line: add `aura-check: ignore[rule.id]` in a comment on that line
  (`aura-check: ignore` without a list ignores all rules on the line).
- Paths: a `.aura-check-ignore` file in the repo root, one entry per line:
  `<glob>` (all rules) or `<rule-id> <glob>`; `#` starts a comment.

## Install

### Plain git hooks

```bash
# from the repository you want to protect; adjust the path to this directory
ln -s /path/to/packs/checks/bin/aura-check ~/.local/bin/aura-check
ln -s /path/to/packs/checks/hooks/pre-commit .git/hooks/pre-commit   # aura-check --changed
ln -s /path/to/packs/checks/hooks/commit-msg .git/hooks/commit-msg   # secrets/pii in the message
```

With husky, add a line to `.husky/pre-commit`: `path/to/packs/checks/bin/aura-check --changed`.

### pre-commit framework

```yaml
# .pre-commit-config.yaml
repos:
  - repo: local
    hooks:
      - id: aura-check
        name: aura-check (experience packs)
        entry: /path/to/packs/checks/bin/aura-check --changed
        language: system
        pass_filenames: false
      - id: aura-check-msg
        name: aura-check commit message
        entry: /path/to/packs/checks/bin/aura-check --pack secrets,pii --commit-msg-file
        language: system
        stages: [commit-msg]
```

### GitHub Actions

```yaml
jobs:
  aura-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }          # --base needs history
      - uses: actions/checkout@v4
        with: { repository: antonioshaman/aura-companion, path: .aura, sparse-checkout: packs/checks }
      - run: .aura/packs/checks/bin/aura-check --changed --base "origin/${{ github.base_ref }}"
        if: github.event_name == 'pull_request'
      - run: .aura/packs/checks/bin/aura-check   # push to main: full scan
        if: github.event_name == 'push'
```

### On the prod box

```bash
sudo aura-check --runtime --pack deploy,env --root /opt/myservice
```

`--runtime` is read-only: it reads unit files and runs `git status` in their working
directories.

## LLM publish guard (runtime counterpart of `llm-output`)

A static check only finds the obvious "return the raw text" shape. The runtime guard
closes the class: call it immediately before every public write.

- Python: [`snippets/publish_guard.py`](snippets/publish_guard.py) — `assert_publishable(text)`
- TypeScript: [`snippets/publishGuard.ts`](snippets/publishGuard.ts) — `assertPublishable(text)`

Both reject empty text, JSON documents (valid or broken), fenced code blocks, internal
tags (`<thinking>`, `<analysis>`…) and internal keys (`"reply":`, `"schema_version":`…;
pass your own list). Copy the file; on rejection log the reason and drop the reply.

```python
from publish_guard import UnpublishableText, assert_publishable

try:
    await bot.send_message(chat_id, assert_publishable(reply))
except UnpublishableText as e:
    log.warning("llm reply not published: %s", e.reason)
```

## Development

```bash
cd packs/checks
python3 -m unittest discover -s tests -t .
```

Each rule has positive and negative fixtures in `tests/`. Fixture secrets are generated
at runtime from a seeded PRNG, so no token-shaped literal lives in the tree. Adding a
rule: write it in `aura_check/rules/<pack>.py` with `@rule(id=…, pack=…, severity=…,
title=…, evidence=…, hint=…)`, import the module in `rules/__init__.py`, add tests, and
add a row to the table above.
