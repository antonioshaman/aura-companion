#!/usr/bin/env python3
"""Gate: no live surface may reference an archived process doc without its
docs/history/ prefix (aura-meta-diet P1/C2, extended in FIX-C2-1).

Catches plain names (`PLAN-foo.md`, `PLAN-foo.md:40`), globs
(`HANDOFF-phase-3-α-*-CLOSURE.md`) and brace forms
(`HANDOFF-…-sub-{1,2A}-CLOSURE.md`). A token counts only if it resolves to at
least one file actually archived under docs/history/, so templates
(`PLAN-[feature-slug].md`) and test fixtures (`PLAN-foo.md`) are not flagged.

Paths are listed with core.quotepath=false: default `git ls-files` C-quotes
non-ASCII names (α, β) and they would silently drop out (KB got-054).

Usage: python3 scripts/aura-diet/check-history-refs.py   (exit 1 on any hit)
"""
import fnmatch
import re
import subprocess
import sys

# Surfaces that legitimately carry unprefixed names: the archive itself
# (frozen history), the diet spec (task statement), and .gitignore (patterns
# for new scratch files at the repo root, not references to archived ones),
# and this gate itself (its docstring and ALLOW table quote the names it hunts).
SKIP = ("docs/history/", "specs/aura-meta-diet", ".gitignore", "scripts/aura-diet/check-history-refs.py")
# (path, basename) pairs that name a NEW output file which merely shares its name
# with an archived one. The supervisor writes fresh reports to the repo root
# (gitignored) — new artifacts must never be born inside the archive.
ALLOW = {
    ("scripts/codex-supervise-after-limit-reset.sh", "SESSION-AUTO-RESUME-REPORT.md"),
    ("scripts/codex-supervise-after-limit-reset.sh", "CODEX-SUPERVISOR-AUTO-RESUME.md"),
}
PREFIX = r"(?:HANDOFF|PLAN|CLOSURE|BUG|TASK|SCOPE|SESSION|SWEEP|IMPLEMENTATION|CODEX)-"
STOP = r"[^\s\"'`,)\]{]"
TOKEN = re.compile(r"(?<![A-Za-z0-9_/])(" + PREFIX + STOP + r"*(?:\{[^}\s]*\}" + STOP + r"*)*)")


def ls_files(*paths):
    out = subprocess.run(
        ["git", "-c", "core.quotepath=false", "ls-files", "-z", *paths],
        capture_output=True, text=True, check=True,
    ).stdout
    return [p for p in out.split("\0") if p]


def expand_braces(s):
    m = re.search(r"\{([^{}]*)\}", s)
    if not m:
        return [s]
    return [y for alt in m.group(1).split(",") for y in expand_braces(s[: m.start()] + alt + s[m.end():])]


def archived_matches(token, archived):
    token = re.sub(r"[:.;]+(\d.*)?$", "", token)  # drop `:line` refs and trailing punctuation
    if not token.endswith(".md") and not any(c in token for c in "*{"):
        return []  # bare plan names in prose ("Council Plan PLAN-x Task 3") are identifiers, not paths
    hits = set()
    for pattern in expand_braces(token):
        glob = pattern if pattern.endswith(".md") else pattern + "*"
        hits.update(a for a in archived if fnmatch.fnmatchcase(a, glob))
    return sorted(hits)


def main():
    archived = {p.rsplit("/", 1)[-1] for p in ls_files("docs/history")}
    bad = 0
    for path in ls_files():
        if path.startswith(SKIP):
            continue
        try:
            text = open(path, encoding="utf-8").read()
        except (UnicodeDecodeError, IsADirectoryError, FileNotFoundError):
            continue
        for m in TOKEN.finditer(text):
            if (path, m.group(1)) in ALLOW:
                continue
            if archived_matches(m.group(1), archived):
                line = text.count("\n", 0, m.start()) + 1
                print(f"{path}:{line}: {m.group(1)}")
                bad += 1
    print(f"unprefixed archived-doc refs: {bad} (archived basenames: {len(archived)})")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
