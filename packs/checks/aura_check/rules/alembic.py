"""Pack ``python-alembic`` — lessons from auraengine, rapesha_academy, Rapesha_shop_bot."""
from __future__ import annotations

import re
from collections import defaultdict
from typing import Dict, List, Set

from ..core import ERROR, WARN, Context, rule

PACK = "python-alembic"
MAX_REV_LEN = 32  # alembic_version.version_num is VARCHAR(32)

REVISION_RE = re.compile(r"""^revision\s*(?::\s*[^=]+)?=\s*['"]([^'"]+)['"]""", re.M)
COLUMN_RE = re.compile(
    r"""^\s*(\w+)\s*(?::\s*Mapped\[[^\]]*\]+)?\s*=\s*(?:\w+\.)?(Column|mapped_column)\("""
    r"""|^\s*(\w+)\s*:\s*Mapped\["""
)


def is_migration(path: str, text: str) -> bool:
    return path.endswith(".py") and "/versions/" in f"/{path}" and "down_revision" in text


def _revision_line(text: str, rev: str) -> int:
    for i, line in enumerate(text.splitlines(), 1):
        if REVISION_RE.match(line) and rev in line:
            return i
    return 0


@rule(
    id="alembic.revision-id-too-long", pack=PACK, severity=ERROR,
    title="Alembic revision id longer than 32 characters",
    evidence="auraengine f6de1b7 (07-28, 35-char id rolled back the whole DDL transaction on prod; "
             "lesson LRN-20260728-002 written the same day, recurred 8 days later in 2196cdf with 33 chars); "
             "rapesha_academy 55aa561.",
    hint="alembic_version.version_num is VARCHAR(32): shorten the `revision` string (and every "
         "`down_revision` that points at it) to <= 32 chars.",
)
def revision_too_long(ctx: Context):
    for path in ctx.files_with_ext(".py"):
        text = ctx.read(path) or ""
        if not is_migration(path, text):
            continue
        for m in REVISION_RE.finditer(text):
            rev = m.group(1)
            if len(rev) > MAX_REV_LEN:
                yield path, _revision_line(text, rev), (
                    f"revision id is {len(rev)} chars (max {MAX_REV_LEN}): '{rev}'")


@rule(
    id="alembic.revision-id-duplicate", pack=PACK, severity=ERROR,
    title="Duplicate Alembic revision id",
    evidence="Recommended together with the length check by the auraengine analysis (pre-commit "
             "'len(revision) <= 32 and uniqueness', closing f6de1b7 / 2196cdf); parallel agents in "
             "one repo (catalog lesson #5, 7 projects) make colliding hand-written ids likely.",
    hint="Every migration needs a unique `revision`. Regenerate one of them "
         "(`alembic revision -m ...`) and re-point its children's `down_revision`.",
)
def revision_duplicate(ctx: Context):
    touched = [p for p in ctx.files if p.endswith(".py") and is_migration(p, ctx.read(p) or "")]
    if ctx.changed and not touched:
        return
    seen: Dict[str, List[str]] = defaultdict(list)
    for path in ctx.files_with_ext(".py", universe=ctx.all_files):
        text = ctx.read(path) or ""
        if not is_migration(path, text):
            continue
        for m in REVISION_RE.finditer(text):
            seen[m.group(1)].append(path)
    for rev, paths in sorted(seen.items()):
        if len(paths) < 2:
            continue
        for path in paths:
            if ctx.changed and path not in touched:
                continue
            others = ", ".join(p for p in paths if p != path)
            yield path, _revision_line(ctx.read(path) or "", rev), (
                f"revision '{rev}' is also declared in {others}")


def _column_names(lines: List[str]) -> Dict[str, str]:
    out: Dict[str, str] = {}
    for line in lines:
        m = COLUMN_RE.match(line)
        if m:
            out[m.group(1) or m.group(3)] = line.strip()
    return out


@rule(
    id="alembic.model-change-without-migration", pack=PACK, severity=WARN, diff_scoped=True,
    title="ORM column changed without a new migration in the same change",
    evidence="Rapesha_shop_bot `prod_500_undefinedcolumn_alembic_first` (500 on prod after a model edit "
             "shipped before its migration); rapesha_warehouse_bot 2462d31 (create_all does not ALTER, "
             "predicted by review 0926 #6); catalog lesson #4, 8 projects.",
    hint="Changing a model does not change the prod schema. Add `alembic revision --autogenerate` "
         "output to this change (and apply it before the code is deployed), or confirm the schema "
         "already matches.",
)
def model_change_without_migration(ctx: Context):
    if not ctx.changed:
        return
    if not any(p.endswith("alembic.ini") or "/versions/" in f"/{p}" for p in ctx.all_files):
        return  # project does not use Alembic
    new_migration = any(
        fd.is_new and p.endswith(".py") and "/versions/" in f"/{p}"
        for p, fd in ctx.diff.items()
    )
    if new_migration:
        return
    for path, fd in sorted(ctx.diff.items()):
        if not path.endswith(".py") or "/versions/" in f"/{path}":
            continue
        before = _column_names(fd.removed)
        after_lines = {}
        for n, text in fd.added:
            m = COLUMN_RE.match(text)
            if m:
                after_lines[m.group(1) or m.group(3)] = (n, text.strip())
        changed: Set[str] = set()
        for name, (n, text) in after_lines.items():
            if before.get(name) != text:
                changed.add(name)
                kind = "changed" if name in before else "added"
                yield path, n, f"column '{name}' {kind} in the model, but the change has no new migration file"
