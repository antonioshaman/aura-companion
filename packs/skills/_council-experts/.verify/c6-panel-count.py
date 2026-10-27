#!/usr/bin/env python3
"""C6 — no dispatcher may assert a FIXED panel size (RC-2, adaptive roster).

Before RC-2 the panel was a fixed `### Council panel` bullet list and C6 proved
any stated size ("the 13-expert panel", "spawn all nine") equalled that list, so
the prose could not drift from the data. RC-2 deletes the fixed list: the roster
is selected adaptively per workspace (min 3 / max 11, see `selection-engine.md`),
so there is NO fixed size for a claim to agree with. A hardcoded panel count is
now *provably wrong* — it names a number the engine will not honour.

This canary therefore inverts: it scans every dispatcher SKILL.md and FAILS on
any surviving fixed-panel-size claim. Zero claims = green. Rewording a stated
count into the adaptive framing ("the engine seats between 3 and 11 advisors",
"spawn every selected expert") is the fix. Guardrail phrasing (`min 3`, `max 11`)
is deliberately NOT matched — it is a bound, not a fixed panel size.

Exit 0 all-green, 1 on a surviving fixed-count claim, 2 on an operational
failure (missing file) so the caller can tell "no violations" from "could not
look".
"""

import re
import sys
from pathlib import Path

WORDS = {
    "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7,
    "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12,
    "thirteen": 13, "fourteen": 14, "fifteen": 15, "sixteen": 16,
}
NUM = r"(\d{1,2}|" + "|".join(WORDS) + r")"

# A fixed-panel-size claim: a statement about how many seats the council HAS, not
# a bound on how many to dispatch. The patterns cover the phrasings a fixed count
# actually takes (hashimoto #2 closed the leaks): "N-expert panel", "panel (N
# experts", "N domain experts", "panel of N", "N-member[ panel]", "seats [exactly]
# N", and "spawn/wait for all N".
CLAIM_PATTERNS = [
    re.compile(rf"\b{NUM}-expert panel\b", re.I),
    re.compile(rf"\bpanel \(\s*{NUM} experts\b", re.I),
    re.compile(rf"\b{NUM} domain experts\b", re.I),
    re.compile(rf"\bpanel of {NUM}\b", re.I),
    re.compile(rf"\b{NUM}-member\b", re.I),
    re.compile(rf"\bseats?\s+(?:exactly\s+)?{NUM}\b", re.I),
    re.compile(rf"\bspawn all {NUM}\b", re.I),
    re.compile(rf"\bwait for all {NUM}\b", re.I),
]
ALL_N = re.compile(rf"\ball {NUM}\b", re.I)
# `\ball N` is gated on a SEAT-context line so "run all three checks in parallel"
# (the Phase-0 toolchain) and "address all 3 recommendations from the synthesis"
# (a count of FINDINGS, not seats — hashimoto #2 false-positive) are not misread as
# a seat count. Only seat nouns qualify — NOT dispatch/synthesis/finding/recommendation.
PANEL_CONTEXT = re.compile(
    r"\bexperts?\b|\bsubagents?\b|\bcouncil members?\b|\bpanel\b|\bseats?\b|\badvisors?\b",
    re.I,
)


def to_int(token: str) -> int:
    return int(token) if token.isdigit() else WORDS[token.lower()]


def fixed_claims(text: str):
    for pat in CLAIM_PATTERNS:
        for m in pat.finditer(text):
            yield m.group(0)
    for line in text.splitlines():
        if not PANEL_CONTEXT.search(line):
            continue
        for m in ALL_N.finditer(line):
            yield m.group(0)


# Mechanically-pinned coverage for the two leak directions hashimoto #2 found, so a
# future regex edit that re-opens either fails loudly. Positive strings MUST match a
# fixed count; negative strings MUST NOT (seat vs finding disambiguation).
_SELFTEST_POSITIVE = [
    "a 9-expert panel",
    "the panel (7 experts)",
    "9 domain experts",
    "this council seats exactly seven advisors",
    "a panel of nine members",
    "the seven-member panel reviews in parallel",
    "spawn all nine subagents",
]
_SELFTEST_NEGATIVE = [
    "the Builder must address all 3 recommendations from the synthesis",
    "run all three checks in parallel",
    "the roster seats between min 3 and max 11 advisors",
]


def _selftest() -> int:
    bad = 0
    for s in _SELFTEST_POSITIVE:
        if not list(fixed_claims(s)):
            print(f"  ✗ C6 self-test: expected a fixed-count match but got none: {s!r}")
            bad = 1
    for s in _SELFTEST_NEGATIVE:
        hits = list(fixed_claims(s))
        if hits:
            print(f"  ✗ C6 self-test: false positive on benign prose {s!r} → {hits}")
            bad = 1
    if bad == 0:
        print("  ✓ C6 self-test: leak + false-positive coverage pinned")
    return bad


def main(argv: list[str]) -> int:
    if len(argv) >= 2 and argv[1] == "--selftest":
        return _selftest()
    skills_root = Path(argv[1])
    dispatchers = argv[2:]
    if not dispatchers:
        print("  ✗ C6 invoked with no dispatchers to check")
        return 2

    err = 0
    checked = 0
    for slug in dispatchers:
        path = skills_root / slug / "SKILL.md"
        if not path.is_file():
            print(f"  ✗ {slug}: SKILL.md missing at {path}")
            err = max(err, 2)
            continue
        checked += 1
        for phrase in fixed_claims(path.read_text(encoding="utf-8")):
            print(
                f'  ✗ {slug}: states a fixed panel size ("{phrase}") — the roster is '
                f"adaptive (min 3 / max 11); reword to the engine's framing"
            )
            err = max(err, 1)
    if err == 0:
        print(f"  ✓ {checked} dispatchers carry no fixed panel-size claim (roster is adaptive)")
    return err


if __name__ == "__main__":
    sys.exit(main(sys.argv))
