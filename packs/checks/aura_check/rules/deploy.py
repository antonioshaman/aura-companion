"""Pack ``deploy`` — systemd unit and prod-checkout lessons (takopi, aurasoul_coin, aura-companion)."""
from __future__ import annotations

import os
import re
import shlex
import stat
import subprocess
from pathlib import Path
from typing import Iterator, List, Tuple

from ..core import ERROR, WARN, Context, rule

PACK = "deploy"
SECRET_NAME_RE = re.compile(r"(?i)(KEY|TOKEN|SECRET|PASSW(OR)?D|CREDENTIAL|SESSION_STRING)")


def is_unit_file(path: str) -> bool:
    name = os.path.basename(path)
    parent = os.path.basename(os.path.dirname(path))
    return (name.endswith((".service", ".service.in", ".service.j2", ".service.tmpl"))
            or (parent.endswith(".service.d") and name.endswith(".conf")))


def _runtime_units(ctx: Context) -> List[Path]:
    out: List[Path] = []
    for d in ctx.unit_dirs:
        if not d.is_dir():
            continue
        for root, _dirs, files in os.walk(d):
            for name in files:
                p = Path(root) / name
                if is_unit_file(str(p)) and p.is_file() and not p.is_symlink():
                    out.append(p)
    return sorted(out)


def _read(p: Path) -> List[str]:
    try:
        return p.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []


def inline_secrets(lines: List[str]) -> Iterator[Tuple[int, str]]:
    for i, line in enumerate(lines, 1):
        s = line.strip()
        if not s.startswith("Environment="):
            continue
        try:
            parts = shlex.split(s[len("Environment="):])
        except ValueError:
            parts = s[len("Environment="):].split()
        for part in parts:
            if "=" not in part:
                continue
            name, value = part.split("=", 1)
            if SECRET_NAME_RE.search(name) and value and not value.startswith(("$", "%")):
                yield i, name


@rule(
    id="deploy.systemd-inline-secret", pack=PACK, severity=ERROR,
    title="Secret inline in a systemd unit `Environment=`",
    evidence="takopi: OPENAI_API_KEY in `Environment=` of /etc/systemd/system/takopi.service, mode 644 — "
             "readable by every local user and printed by `systemctl show` (FULL-SYNTHESIS §8 item 4).",
    hint="Move it to `EnvironmentFile=/etc/<svc>/env` owned by root, `chmod 600`, then "
         "`systemctl daemon-reload` and rotate the key.",
)
def systemd_inline_secret(ctx: Context):
    for path in ctx.files:
        if is_unit_file(path):
            for n, name in inline_secrets(ctx.lines(path)):
                yield path, n, f"{name} is set inline"
    if ctx.runtime:
        for p in _runtime_units(ctx):
            mode = p.stat().st_mode
            readable = " (unit is world-readable)" if mode & stat.S_IROTH else ""
            for n, name in inline_secrets(_read(p)):
                yield str(p), n, f"{name} is set inline{readable}"


def _git(cwd: str, *args: str) -> Tuple[int, str]:
    proc = subprocess.run(["git", "-C", cwd, *args], capture_output=True, text=True)
    return proc.returncode, proc.stdout.strip()


@rule(
    id="deploy.workdir-not-clean-main", pack=PACK, severity=WARN, runtime_only=True,
    title="Service runs from a git checkout that is not a clean main",
    evidence="aurasoul_coin: prod ran from the working tree (proposed guard `branch == main && clean && "
             "alembic current == head` before restart); aura-companion: the shared prod checkout was switched "
             "to another branch by a parallel agent; catalog lesson #5, 7 projects.",
    hint="Deploy from a dedicated release checkout/worktree on main (or an artifact), never from the tree "
         "agents edit. Before `systemctl restart`: `git branch --show-current` == main and "
         "`git status --porcelain --untracked-files=no` is empty.",
)
def workdir_not_clean_main(ctx: Context):
    for p in _runtime_units(ctx):
        for n, line in enumerate(_read(p), 1):
            s = line.strip()
            if not s.startswith("WorkingDirectory="):
                continue
            wd = s.split("=", 1)[1].strip().lstrip("-")
            if not wd or not os.path.isdir(wd):
                continue
            rc, top = _git(wd, "rev-parse", "--show-toplevel")
            if rc != 0:
                continue
            _, branch = _git(wd, "rev-parse", "--abbrev-ref", "HEAD")
            _, dirty = _git(wd, "status", "--porcelain", "--untracked-files=no")
            problems = []
            if branch not in ctx.main_branches:
                problems.append(f"branch '{branch}'")
            if dirty:
                problems.append(f"{len(dirty.splitlines())} modified tracked file(s)")
            if problems:
                yield str(p), n, f"WorkingDirectory {top} is a git checkout with " + " and ".join(problems)
