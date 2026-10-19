"""Pack ``env`` — .env handling lessons (snowlevel, rapesha_academy, rapesha_warehouse_bot)."""
from __future__ import annotations

import os
import re
import stat
from typing import List

from ..core import ERROR, WARN, Context, rule

PACK = "env"
TEMPLATE_SUFFIXES = (".example", ".sample", ".template", ".dist", ".tmpl", ".defaults")
COMPOSE_RE = re.compile(r"(^|/)(docker-)?compose[\w.-]*\.ya?ml$")
ENV_LINE_RE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=(.*)$")


def is_env_file(path: str) -> bool:
    name = os.path.basename(path)
    return name == ".env" or name.startswith(".env.") or name.endswith(".env") or ".env." in name


def is_template(path: str) -> bool:
    return os.path.basename(path).endswith(TEMPLATE_SUFFIXES)


def on_disk_env_files(ctx: Context) -> List[str]:
    """Env files that exist on disk, tracked or not (they are usually gitignored).
    Looks at the repo root, every directory holding a compose file, and
    directories of tracked env files — no deep walk."""
    dirs = {""}
    for p in ctx.all_files:
        if COMPOSE_RE.search(p) or is_env_file(p):
            dirs.add(os.path.dirname(p))
    for sub in ("backend", "app", "bot", "server", "deploy"):
        dirs.add(sub)
    out = set()
    for d in dirs:
        full = ctx.root / d
        if not full.is_dir():
            continue
        for name in os.listdir(full):
            rel = os.path.join(d, name) if d else name
            if is_env_file(rel) and (ctx.root / rel).is_file():
                out.add(rel)
    return sorted(out)


def _candidate_env_files(ctx: Context) -> List[str]:
    if ctx.changed:
        return [p for p in ctx.files if is_env_file(p)]
    return [p for p in on_disk_env_files(ctx) if not ctx.path_ignored(p)]


@rule(
    id="env.compose-dollar", pack=PACK, severity=WARN,
    title="Unescaped `$` in a .env value read by docker compose",
    evidence="snowlevel: docker compose interpolated `$` inside a .env secret (lesson: write `$$` and "
             "check the secret length inside the container); catalog §6.2 systemd/docker, 6 projects.",
    hint="docker compose interpolates `$NAME` inside .env values. Write a literal dollar as `$$`, "
         "or wrap the whole value in single quotes; then compare the secret length inside the "
         "container (`docker compose exec svc printenv NAME | wc -c`).",
)
def compose_dollar(ctx: Context):
    if not any(COMPOSE_RE.search(p) for p in ctx.all_files):
        return
    for path in _candidate_env_files(ctx):
        for i, line in enumerate(ctx.lines(path), 1):
            if line.lstrip().startswith("#"):
                continue
            m = ENV_LINE_RE.match(line)
            if not m:
                continue
            value = m.group(2).strip()
            if value.startswith("'"):
                continue  # single-quoted: literal for compose
            if value.startswith('"') and value.endswith('"') and len(value) >= 2:
                value = value[1:-1]
            scrubbed = value.replace("$$", "")
            scrubbed = re.sub(r"\$\{[A-Za-z_][A-Za-z0-9_]*(?::?[-?+][^}]*)?\}", "", scrubbed)
            if "$" in scrubbed:
                yield path, i, f"value of {m.group(1)} contains an unescaped `$` (compose will interpolate it)"


@rule(
    id="env.file-tracked", pack=PACK, severity=ERROR,
    title=".env / .env.bak tracked by git",
    evidence="rapesha_academy: an old bot token survived in `.env.bak`; rapesha_warehouse_bot: council "
             "06.05 found a Telethon StringSession in `.env` next to a `.env.bak` (FULL-SYNTHESIS §8).",
    hint="Remove it from the index (`git rm --cached <file>`), add it to .gitignore, rotate every "
         "secret it contained (history keeps them), and commit a `.env.example` with placeholders instead.",
)
def env_tracked(ctx: Context):
    if not ctx.git:
        return
    if ctx.changed:
        candidates = [p for p, fd in ctx.diff.items() if fd.is_new]
    else:
        candidates = sorted(ctx.tracked)
    for path in candidates:
        if is_env_file(path) and not is_template(path) and not ctx.path_ignored(path):
            yield path, 0, "env file is tracked by git"


@rule(
    id="env.file-world-readable", pack=PACK, severity=ERROR,
    title=".env file readable by every local user",
    evidence="rapesha_warehouse_bot `.env` with a Telethon session at mode 644; takopi unit file "
             "644 with an API key (FULL-SYNTHESIS §8 items 4 and 6).",
    hint="`chmod 600 <file>` (owner = the service user). Delete stale copies such as `.env.bak`.",
)
def env_world_readable(ctx: Context):
    for path in _candidate_env_files(ctx):
        if is_template(path):
            continue
        try:
            mode = (ctx.root / path).stat().st_mode
        except OSError:
            continue
        if mode & stat.S_IROTH:
            yield path, 0, f"mode {stat.S_IMODE(mode):o} lets any local user read it"
