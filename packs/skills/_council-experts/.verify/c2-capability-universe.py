#!/usr/bin/env python3
"""C2 — the candidate universe is the catalog, keyed on capability profiles (RC-2).

Before RC-2 the panel was a fixed `### Council panel` bullet list in each
dispatcher SKILL.md, and C2 walked panel -> catalog to prove every named seat
resolved to a phase file, while C2b walked catalog -> panel to prove no
directory was an unrecorded orphan. RC-2 deletes the fixed panels: the roster is
selected adaptively by the engine (`selection-engine.md`) from each advisor's
`capabilities` profile, so *the catalog IS the panel*. This canary therefore
stops parsing bullet lists and instead adjudicates the same two directions
against the capability universe:

  1. Candidate universe = catalog dirs whose `meta.yaml` declares a `capabilities`
     mapping (the seatable set the scorer ranks). It must be NON-EMPTY
     (zero-dangling: an empty universe is itself a failure), and every member
     must carry at least one dispatchable phase doc — otherwise a seat the engine
     can rank has nothing for the Chair to read, the exact silent no-op the old
     panel->phase-file check protected against.
  2. Orphan sweep (was C2b): every catalog directory is EITHER in the universe OR
     recorded in `.verify/unseated.allow`. "Inert" must be a recorded decision,
     not a state a directory drifts into. A dir that is both (has capabilities AND
     is allow-listed) is contradictory; an allow entry whose directory is gone is
     stale. Both fail so the list cannot rot.

Token-validity of each profile (closed vocabulary) is C15's job, not this one;
here a "valid capabilities block" means structurally present (a mapping) — the
same seatable predicate `selection-engine.md` and the TS `loadCatalog` use.

Exit 0 all-green, 1 on any violation.
"""
from __future__ import annotations

import os
import sys

try:
    import yaml
except ImportError:
    print("  ✗ python3 `yaml` module unavailable — cannot read capability profiles")
    sys.exit(1)

HERE = os.path.dirname(os.path.abspath(__file__))
CATALOG = os.path.dirname(HERE)
ALLOW = os.path.join(HERE, "unseated.allow")

# The four phase docs any dispatcher can read for a seat. A universe member must
# carry at least one — a dir with a capabilities block but no phase file is
# rankable-but-undispatchable, which is the silent no-op this canary guards.
PHASE_DOCS = ("plan.md", "review.md", "plan-aura.md", "review-aura.md")


def has_capabilities(meta_path: str) -> bool | None:
    """True if meta.yaml declares a `capabilities` mapping, False if it declares
    none, None if the file is unreadable/malformed (a loud failure, not absence)."""
    try:
        doc = yaml.safe_load(open(meta_path))
    except Exception as e:  # noqa: BLE001
        return None
    if not isinstance(doc, dict):
        return None
    caps = doc.get("capabilities")
    if caps is None:
        return False
    return isinstance(caps, dict)


def load_allow() -> set[str]:
    allowed: set[str] = set()
    with open(ALLOW) as fh:
        for line in fh:
            line = line.split("#", 1)[0].strip()
            if line:
                allowed.add(line)
    return allowed


def main() -> int:
    if not os.path.isfile(ALLOW):
        print(f"  ✗ {ALLOW} is missing — cannot distinguish a deliberately-inert seat from an orphan")
        return 1

    dirs = sorted(
        name
        for name in os.listdir(CATALOG)
        if not name.startswith(".") and os.path.isdir(os.path.join(CATALOG, name))
    )
    if not dirs:
        print("  ✗ enumerated 0 catalog directories — the sweep inspected nothing")
        return 1

    allowed = load_allow()
    universe: list[str] = []
    err = 0

    for name in dirs:
        meta = os.path.join(CATALOG, name, "meta.yaml")
        state = None if not os.path.isfile(meta) else has_capabilities(meta)
        if state is None and os.path.isfile(meta):
            print(f"  ✗ {name}: meta.yaml is unreadable/malformed — cannot decide seatability")
            err = 1
            continue
        if state:
            universe.append(name)
            # A universe member must be dispatchable: at least one phase doc.
            if not any(os.path.isfile(os.path.join(CATALOG, name, p)) for p in PHASE_DOCS):
                print(
                    f"  ✗ {name} declares capabilities (rankable) but carries no phase doc "
                    f"({'/'.join(PHASE_DOCS)}) — the Chair would have nothing to dispatch"
                )
                err = 1
            if name in allowed:
                print(f"  ✗ contradictory: '{name}' declares capabilities but is also listed in unseated.allow")
                err = 1
        else:
            # No capabilities block: must be a recorded, deliberate non-seat.
            if name not in allowed:
                print(
                    f"  ✗ orphan: catalog directory '{name}' has no capabilities profile and is not "
                    f"in .verify/unseated.allow — give it a capabilities block (to seat it) or record "
                    f"why it is inert in unseated.allow"
                )
                err = 1

    # Stale allow entry: a recorded decision about a directory that is gone.
    for a in sorted(allowed):
        if not os.path.isdir(os.path.join(CATALOG, a)):
            print(f"  ✗ stale allow-list entry: unseated.allow names '{a}' but {CATALOG}/{a} does not exist")
            err = 1

    if not universe:
        print("  ✗ candidate universe is empty — no catalog dir declares a capabilities profile")
        err = 1

    if err == 0:
        print(
            f"  ✓ {len(dirs)} catalog directories: {len(universe)} seatable (capabilities profile + "
            f"phase doc), {len(allowed)} explicitly unseated, 0 orphans"
        )
    return err


if __name__ == "__main__":
    sys.exit(main())
