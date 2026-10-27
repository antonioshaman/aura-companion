#!/usr/bin/env python3
"""verify-lock.py — C12 sha256 attestation gate over `_ref-mirrors.lock`.

For every entry: recompute the canonical's on-disk sha256 and compare it to the
pinned value, then confirm each mirror hashes to that same pinned value.

Independent of C11 (`cp-mirrors.py --check`, which compares mirrors against the
canonical's *current* bytes). Editing a mirror to inject prompt text therefore
requires a coordinated edit of this lock AND the canonical to stay green.

Coverage floor
--------------
Hashing what the lock happens to list makes the lock its own scope: deleting an
entry removes a file from attestation without failing any check, which is a
bypass that needs no hash at all. Worse, the lock listed 78 files while the
attestation surface held 197 — and the 60 files that are literally dispatched as
subagent prompts were entirely outside it, so the strongest guarantee in the
system was protecting the documents experts cite and not the instructions they
obey.

`SURFACE` below defines that set in code rather than in data. Every file in it
must be attested exactly once (as a mirror-group member or as a standalone
`attested:` entry), and every lock path must exist in it. Adding a prompt file
without a hash now fails; so does deleting a hash for a file still on disk.

Run `verify-lock.py --update-attested` after a legitimate content change: it
rewrites the `attested:` block from the same SURFACE definition this gate reads,
so the generator and the checker cannot drift apart.
"""

from __future__ import annotations

import hashlib
import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    print("  ✗ pyyaml not available — install python3-yaml", file=sys.stderr)
    sys.exit(2)

HERE = Path(__file__).resolve().parent
SKILLS_ROOT = HERE.parent.parent
LOCK = HERE / "_ref-mirrors.lock"


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def resolve_bounded(rel: str) -> Path:
    root = SKILLS_ROOT.resolve()
    p = (SKILLS_ROOT / rel).resolve()
    if p != root and not str(p).startswith(str(root) + "/"):
        raise ValueError(f"path escapes skills root: {rel}")
    return p


DISPATCHERS = [
    "council-plan",
    "council-plan-aura",
    "council-review",
    "council-review-aura",
    "council-implement",
    "council-implement-aura",
]


def surface() -> set[str]:
    """Every file whose bytes a dispatched agent reads or obeys.

    Three groups, all equally load-bearing and previously unequally protected:
      - `_council-experts/**/*.md` — the expert prompts themselves plus their
        canonical reference docs.
      - `<dispatcher>/references/*.md` — the injected mirrors.
      - `<dispatcher>/SKILL.md` — the Chair's own instructions, including the
        dispatch and refusal rules the other two groups depend on.
    """
    root = SKILLS_ROOT.resolve()
    found = {
        str(p.relative_to(root))
        for p in (root / "_council-experts").rglob("*.md")
        if p.is_file()
    }
    for d in DISPATCHERS:
        skill = root / d / "SKILL.md"
        if skill.is_file():
            found.add(str(skill.relative_to(root)))
        refs = root / d / "references"
        if refs.is_dir():
            found |= {
                str(p.relative_to(root)) for p in refs.glob("*.md") if p.is_file()
            }
    return found


def attested_block(paths: list[str]) -> str:
    lines = [
        "",
        "# Standalone attested files — no mirror relationship, one pinned hash each.",
        "# Regenerate with: .verify/verify-lock.py --update-attested",
        "# Do not hand-edit a hash: the point of this block is that a content change",
        "# and its hash bump land in the same reviewable diff.",
        "attested:",
    ]
    for rel in paths:
        lines.append(f"  - path: {rel}")
        lines.append(f"    sha256: {sha256(SKILLS_ROOT / rel)}")
    return "\n".join(lines) + "\n"


def update_attested() -> int:
    covered_by_mirrors = set()
    spec = yaml.safe_load(LOCK.read_text())
    for e in spec.get("mirrors") or []:
        covered_by_mirrors.add(e["canonical"]["path"])
        covered_by_mirrors.update(e.get("mirrors", []))

    standalone = sorted(surface() - covered_by_mirrors)
    text = LOCK.read_text()
    marker = "\n# Standalone attested files"
    head = text.split(marker)[0].rstrip("\n") + "\n"
    LOCK.write_text(head + attested_block(standalone))
    print(f"  ✓ attested block rewritten — {len(standalone)} standalone files")
    return 0


def main() -> int:
    spec = yaml.safe_load(LOCK.read_text())
    entries = spec.get("mirrors")
    if not isinstance(entries, list) or not entries:
        print("  ✗ _ref-mirrors.lock: `mirrors` must be a non-empty list")
        return 1

    err = 0
    n_files = 0
    # Paths claimed by the lock, in listing order, so a path attested twice is
    # visible as a duplicate rather than silently collapsing into a set.
    claimed: list[str] = []
    for e in entries:
        target = e.get("target", "<unnamed>")
        canon = e["canonical"]
        pinned = canon["sha256"]
        claimed.append(canon["path"])
        claimed.extend(e.get("mirrors", []))
        try:
            canon_path = resolve_bounded(canon["path"])
        except ValueError as exc:
            print(f"  ✗ {target}: {exc}")
            err = 1
            continue
        if not canon_path.is_file():
            print(f"  ✗ {target}: canonical missing: {canon['path']}")
            err = 1
            continue
        actual = sha256(canon_path)
        n_files += 1
        if actual != pinned:
            print(f"  ✗ {target}: canonical drifted from lock: {canon['path']}")
            print(f"      pinned:  {pinned}")
            print(f"      on-disk: {actual}")
            err = 1
        for rel in e.get("mirrors", []):
            try:
                mp = resolve_bounded(rel)
            except ValueError as exc:
                print(f"  ✗ {target}: {exc}")
                err = 1
                continue
            if not mp.is_file():
                print(f"  ✗ {target}: mirror missing: {rel}")
                err = 1
                continue
            n_files += 1
            got = sha256(mp)
            if got != pinned:
                print(f"  ✗ {target}: mirror does not match pinned canonical: {rel}")
                print(f"      pinned:  {pinned}")
                print(f"      on-disk: {got}")
                err = 1

    for a in spec.get("attested") or []:
        rel = a["path"]
        claimed.append(rel)
        try:
            p = resolve_bounded(rel)
        except ValueError as exc:
            print(f"  ✗ attested: {exc}")
            err = 1
            continue
        if not p.is_file():
            print(f"  ✗ attested file missing: {rel}")
            err = 1
            continue
        n_files += 1
        got = sha256(p)
        if got != a["sha256"]:
            print(f"  ✗ attested file drifted from lock: {rel}")
            print(f"      pinned:  {a['sha256']}")
            print(f"      on-disk: {got}")
            err = 1

    # ── coverage floor ────────────────────────────────────────────────────────
    # Everything above verifies files the lock chose to name. This verifies the
    # choosing: without it, `git rm` on a lock entry is a bypass that costs no
    # hash collision and produces no ✗.
    on_disk = surface()
    claimed_set = set(claimed)
    for rel in sorted(on_disk - claimed_set):
        print(f"  ✗ unattested file in the dispatch surface: {rel}")
        err = 1
    for rel in sorted(claimed_set - on_disk):
        print(f"  ✗ lock attests a path outside the dispatch surface: {rel}")
        err = 1
    if len(claimed) != len(claimed_set):
        seen, dupes = set(), set()
        for rel in claimed:
            (dupes if rel in seen else seen).add(rel)
        for rel in sorted(dupes):
            print(f"  ✗ path attested more than once (ambiguous pinned hash): {rel}")
            err = 1

    if err == 0:
        print(
            f"  ✓ {len(entries)} mirror groups + "
            f"{len(spec.get('attested') or [])} standalone / {n_files} files "
            f"attested against pinned sha256; surface fully covered "
            f"({len(on_disk)} files)"
        )
    return err


if __name__ == "__main__":
    if "--update-attested" in sys.argv[1:]:
        sys.exit(update_attested())
    sys.exit(main())
