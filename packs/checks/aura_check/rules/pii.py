"""Pack ``pii`` — personal data in diffs and commit messages (Co-Pilot lesson).

Heuristic and warn-only: it looks at *added* lines (``--changed``) and commit
messages, never at the whole tree, so old fixtures don't re-fire forever.
"""
from __future__ import annotations

import re
from typing import Iterator, List, Tuple

from ..core import WARN, Context, rule

PACK = "pii"

PHONE_RES = [
    # RU: +7 any operator; bare leading 8 only for mobile (89xx) to avoid matching ids.
    re.compile(r"(?<![\w+])(?:\+7|8(?=[\s\-(]*9))[\s\-(]*\d{3}[\s\-)]*\d{3}[\s\-]?\d{2}[\s\-]?\d{2}(?!\d)"),
    # International with explicit '+' and at least one separator.
    re.compile(r"(?<![\w+])\+(?!7)\d{1,3}[\s\-(]+\d{2,4}[\s\-)]*\d{3,4}[\s\-]?\d{2,4}(?:[\s\-]?\d{2,4})?(?!\d)"),
]
DATE_RES = [
    re.compile(r"(?<!\d)(0?[1-9]|[12]\d|3[01])[./](0?[1-9]|1[0-2])[./]((?:19|20)\d{2})(?!\d)"),
    re.compile(r"(?<!\d)((?:19|20)\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(?!\d)"),
    re.compile(r"\bdate\(\s*((?:19|20)\d{2})\s*,\s*\d{1,2}\s*,\s*\d{1,2}\s*\)"),
]
BIRTH_KW = re.compile(r"(?i)(birth|born|\bdob\b|рожд|\bд\.\s?р\.|\bдр\b|день рождения|возраст|\bage\b|\bлет\b)")
NAME_PAIR = re.compile(r"\b[A-ZА-ЯЁ][a-zа-яё]{2,}\s+[A-ZА-ЯЁ][a-zа-яё]{2,}\b")
QUOTED_NAME = re.compile(r"""['"][A-ZА-ЯЁ][a-zа-яё]{2,}(?:\s+[A-ZА-ЯЁ][a-zа-яё]{2,})?['"]""")
# Name-only matches (no birth keyword) are limited to plausible birth years so
# changelog lines like "2026-10-12 Jane Doe" stay quiet.
NAME_ONLY_MAX_YEAR = 2020


def _year(m: re.Match) -> int:
    for g in m.groups():
        if g and len(g) == 4:
            return int(g)
    return 0


def pii_in_line(line: str, context: str = "") -> Iterator[str]:
    for rx in PHONE_RES:
        if rx.search(line):
            yield "phone number"
            break
    for rx in DATE_RES:
        m = rx.search(line)
        if not m:
            continue
        year = _year(m)
        keyword = BIRTH_KW.search(line) or BIRTH_KW.search(context)
        named = NAME_PAIR.search(line) or QUOTED_NAME.search(line)
        if keyword and (named or "birth" in context.lower() or "рожд" in context.lower()):
            yield "date of birth next to a name"
            break
        if named and year <= NAME_ONLY_MAX_YEAR:
            yield "date (plausible birth year) next to a name"
            break


def _scan(lines: List[Tuple[int, str]], context: str) -> Iterator[Tuple[int, str]]:
    for n, line in lines:
        for what in pii_in_line(line, context):
            yield n, what


@rule(
    id="pii.personal-data", pack=PACK, severity=WARN, diff_scoped=True,
    title="Personal data (phone, birth date next to a name) in a diff or commit message",
    evidence="Co-Pilot 11c1f3c: real names and birth dates of children in a commit message and in "
             "tracked `seed_child_birthdates.py`, remote on GitHub (FULL-SYNTHESIS §8 item 5).",
    hint="Use synthetic data (obviously fake names, 2000-01-01) in seeds/fixtures/prompts, keep real "
         "personal data in the database only. Already pushed? Treat as an incident: check repo "
         "visibility and decide on a history rewrite.",
)
def personal_data(ctx: Context):
    if ctx.changed:
        for path, fd in sorted(ctx.diff.items()):
            if ctx.read(path) is None:
                continue
            for n, what in _scan(fd.added, path):
                yield path, n, f"looks like {what}"
    for label, body in ctx.commit_messages:
        lines = list(enumerate(body.splitlines(), 1))
        for n, what in _scan(lines, ""):
            yield label, n, f"looks like {what}"
