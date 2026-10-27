#!/usr/bin/env python3
"""C14 — every reference citation is anchored and resolves to exactly one file.

What this protects that no other canary does
--------------------------------------------
C13 asserts that the implement skills' table rows name a document that exists.
Nothing asserted the same for the citation that actually reaches a dispatched
subagent: line 3 or 4 of every `_council-experts/<id>/{plan,plan-aura,review,
review-aura}.md`.

Those citations used to be bare relative paths — `references/quality-llm.md`.
A subagent's working directory is the repository UNDER REVIEW, which has no
`references/` directory, and the catalog file's own sibling `references/` holds
only the creator-named document and never the cited name. So the read succeeded
only by the model searching the skills tree and guessing. Six documents exist
under the same filename in both stack families with materially different content
(`quality-llm.md`, `quality-testing.md`, `quality-ui.md`, `quality-ux.md`,
`refactoring.md`, `security.md`), so the guess decided which severity ladder and
which principle set an expert applied — and the misapplication was invisible in
the output, which cites principle numbers that exist in both documents.

The invariant, in two halves, because either alone is satisfiable while broken:

  1. ANCHORED — the citation must be absolute, not a bare relative path.
  2. CORRECTLY ANCHORED — it must point into the dispatcher that this phase file
     is actually dispatched by, and that file must exist. An absolute path to
     the wrong stack's copy is worse than a bare one: it looks deliberate.

The phase file's own name determines its dispatcher unambiguously, which is what
makes this checkable at all: `plan.md` is only ever read by `/council-plan`,
`review-aura.md` only by `/council-review-aura`.

Incubation seats are exempt ONLY through an explicit in-file marker. A seat that
cites a document which does not exist must say so where a reader of the prompt
will see it (`<!-- ... UNRESOLVED REFERENCE: ... -->`); silence is a violation.
Deleting a dangling citation to make a gate pass would make a seat that cannot
work look ready, which is the failure this catalog's gates exist to prevent.

Exit 0 all-green, 1 on a citation violation, 2 on an operational failure (missing
catalog, zero phase files, zero citations extracted) so the caller can tell "no
violations" from "could not look".
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

# phase filename -> the one dispatcher that reads it
PHASE_DISPATCHER = {
    "plan.md": "council-plan",
    "review.md": "council-review",
    "plan-aura.md": "council-plan-aura",
    "review-aura.md": "council-review-aura",
}

ANCHOR = "~/.claude/skills"
DOC_REGEX = re.compile(r"[a-z][a-z0-9_.-]{0,63}\.md")
# Any citation, anchored or not. The capture is everything from the anchor (if
# present) through the filename, so an unanchored one is caught by the same pass
# that validates an anchored one — a separate "find the bare ones" scan would go
# blind the moment someone invents a third spelling.
CITATION = re.compile(r"(?:(\S*?)/)?references/(" + DOC_REGEX.pattern + r")")
MARKER = "UNRESOLVED REFERENCE"


class ResolutionError(Exception):
    """Operational: the check could not be performed. Distinct from a violation."""


def _phase_files(catalog: Path) -> list[tuple[Path, str, str]]:
    """(path, seat, phase) for every catalog phase file. Raises if there are none."""
    if not catalog.is_dir():
        raise ResolutionError(f"catalog directory does not exist: {catalog}")
    out = []
    for seat_dir in sorted(catalog.iterdir()):
        if not seat_dir.is_dir() or seat_dir.name.startswith("."):
            continue
        for phase in PHASE_DISPATCHER:
            f = seat_dir / phase
            if f.is_file():
                out.append((f, seat_dir.name, phase))
    if not out:
        raise ResolutionError(
            f"no phase files found under {catalog} — extraction is broken or the "
            f"catalog is empty; either way nothing was checked"
        )
    return out


def main() -> int:
    here = Path(__file__).resolve().parent
    catalog = here.parent
    skills = catalog.parent

    try:
        files = _phase_files(catalog)
    except ResolutionError as exc:
        print(f"  ✗ {exc}")
        return 2

    violations: list[str] = []
    exempt: list[str] = []
    checked = 0

    for path, seat, phase in files:
        dispatcher = PHASE_DISPATCHER[phase]
        text = path.read_text(encoding="utf-8")
        marked = MARKER in text
        expected_prefix = f"{ANCHOR}/{dispatcher}"

        for match in CITATION.finditer(text):
            prefix, doc = match.group(1), match.group(2)
            checked += 1
            target = skills / dispatcher / "references" / doc

            if not target.is_file():
                # A citation naming a nonexistent document is a violation UNLESS
                # the file admits it in a marker a human reading the prompt sees.
                if marked:
                    exempt.append(f"{seat}/{phase} → {doc} (marker present)")
                else:
                    violations.append(
                        f"{seat}/{phase} cites '{doc}' but "
                        f"{dispatcher}/references/{doc} does not exist, and the file "
                        f"carries no '{MARKER}' marker"
                    )
                continue

            if prefix is None:
                violations.append(
                    f"{seat}/{phase} cites 'references/{doc}' unanchored — a "
                    f"subagent resolves this by guessing; expected "
                    f"'{expected_prefix}/references/{doc}'"
                )
            elif prefix != expected_prefix:
                violations.append(
                    f"{seat}/{phase} cites '{prefix}/references/{doc}' but this "
                    f"phase is dispatched by {dispatcher} — expected "
                    f"'{expected_prefix}/references/{doc}'"
                )

    # Zero citations across a non-empty file set means the extractor stopped
    # matching the prompt wording, not that the catalog is clean. Without this
    # the gate passes over zero comparisons.
    if checked == 0:
        print(
            f"  ✗ extracted 0 citations from {len(files)} phase files — the "
            f"citation pattern no longer matches the prompt wording; nothing was verified"
        )
        return 2

    if violations:
        print(f"  ✗ {len(violations)} citation violation(s):")
        for v in violations:
            print(f"      {v}")
        return 1

    note = f"; {len(exempt)} exempt via marker" if exempt else ""
    print(
        f"  ✓ {checked} citations across {len(files)} phase files anchored to their "
        f"dispatcher and resolving to exactly one file{note}"
    )
    for e in exempt:
        print(f"      exempt: {e}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
