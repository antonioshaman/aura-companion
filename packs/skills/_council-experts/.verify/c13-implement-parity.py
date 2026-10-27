#!/usr/bin/env python3
"""C13 — the implement skills can act on every seat their planner can dispatch.

What this protects that no other canary does
--------------------------------------------
The implement skills carry a `| Seat | Task Domain | Reference Document |`
reference table: for whatever seat a plan attributes a task to, the Builder's
"read the reference doc — non-negotiable" step looks the doc up here. If a
dispatchable seat has no row (or the row names a doc that does not exist) that
step is a silent no-op, and the implementation log still records the attribution,
so the failure is invisible in the artifact it would show up in.

Before RC-2 the "seats the planner can dispatch" were a fixed `### Council panel`
bullet list. RC-2 deletes the fixed panel: the planner selects adaptively from
the capability universe (`selection-engine.md`), so ANY seatable advisor carrying
the paired planning phase doc can be dispatched. This canary therefore derives
the required-seat set the same way the engine does — universe dirs (a
`capabilities` profile in `meta.yaml`) that carry the plan-phase doc for the
implement skill's stack — instead of parsing a bullet list:

  council-implement       <- seats = universe dirs carrying `plan.md`
  council-implement-aura  <- seats = universe dirs carrying `plan-aura.md`

The invariant is still a SUBSET, not equality: every dispatchable seat must have
a row; extra rows are legitimate (`beck` is review-only, has no `plan-aura.md`,
so it is not required, but a row for it is strictly better than not). A missing
row is the dangerous direction.

Exit 0 all-green, 1 on a parity/existence violation, 2 on an operational failure
(missing SKILL.md, unfindable table header, zero rows or zero seats derived) so
the caller can distinguish "no violations" from "could not look".
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover
    print("  ✗ python3 `yaml` module unavailable — cannot derive the capability universe")
    sys.exit(2)

# (implement skill, planning phase doc whose seatable universe it must serve)
PAIRS = [
    ("council-implement", "plan.md"),
    ("council-implement-aura", "plan-aura.md"),
]

TABLE_HEADER = "| Seat | Task Domain | Reference Document |"
SEAT_REGEX = re.compile(r"^[a-z][a-z0-9-]{1,31}$")
REF_REGEX = re.compile(r"^references/[a-z][a-z0-9_.-]{0,63}\.md$")


class ParityError(Exception):
    """Operational: the check could not be performed. Distinct from a violation."""


def _cells(line: str) -> list[str]:
    return [c.strip() for c in line.strip().strip("|").split("|")]


def _parse_table(path: Path, skill: str) -> list[tuple[str, str]]:
    """Rows of the seat table as (seat, ref). Raises if the table is unfindable.

    Anything bulleted inside the table is a claim this canary must adjudicate —
    a row it cannot parse is reported, never skipped."""
    lines = path.read_text(encoding="utf-8").splitlines()
    try:
        start = next(i for i, ln in enumerate(lines) if ln.strip() == TABLE_HEADER)
    except StopIteration:
        raise ParityError(
            f"{skill}: no reference table found — expected a header line "
            f"{TABLE_HEADER!r}. The table was reworded or removed; parity is "
            f"unverifiable."
        )

    rows: list[tuple[str, str]] = []
    for ln in lines[start + 1 :]:
        if not ln.lstrip().startswith("|"):
            break
        cells = _cells(ln)
        if len(cells) == 3 and set("".join(cells)) <= set("-: "):
            continue  # separator
        if len(cells) != 3:
            raise ParityError(f"{skill}: table row has {len(cells)} cells, expected 3: {ln.strip()!r}")
        rows.append((cells[0].strip("`"), cells[2].strip("`")))
    return rows


def _seatable_universe(catalog: Path, phase_doc: str, skill: str) -> list[str]:
    """Seats the adaptive planner can dispatch for this stack: catalog dirs with a
    `capabilities` mapping in meta.yaml that also carry the planning phase doc.
    Same seatable predicate the engine/scorer and C2 use — no bullet list."""
    seats: list[str] = []
    for d in sorted(p for p in catalog.iterdir() if p.is_dir() and not p.name.startswith(".")):
        meta = d / "meta.yaml"
        if not meta.is_file():
            continue
        try:
            doc = yaml.safe_load(meta.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            raise ParityError(f"{d.name}: meta.yaml is unreadable/malformed — cannot derive the universe for {skill}")
        if not isinstance(doc, dict) or not isinstance(doc.get("capabilities"), dict):
            continue
        if (d / phase_doc).is_file():
            seats.append(d.name)
    return seats


def check_pair(skills_root: Path, catalog: Path, impl: str, phase_doc: str) -> int:
    err = 0
    impl_md = skills_root / impl / "SKILL.md"
    if not impl_md.is_file():
        print(f"  ✗ {impl}: SKILL.md missing at {impl_md}")
        return 2

    try:
        rows = _parse_table(impl_md, impl)
        seats = _seatable_universe(catalog, phase_doc, impl)
    except ParityError as exc:
        print(f"  ✗ {exc}")
        return 2

    # Zero comparisons is not a pass.
    if not rows:
        print(f"  ✗ {impl}: extracted 0 rows from its reference table — extraction is broken or the table is empty")
        return 2
    if not seats:
        print(
            f"  ✗ {impl}: derived 0 seatable advisors carrying {phase_doc} — the capability universe is "
            f"empty or the phase doc is missing everywhere; parity is unverifiable"
        )
        return 2

    table: dict[str, str] = {}
    for seat, ref in rows:
        if not SEAT_REGEX.match(seat):
            print(f"  ✗ {impl}: table row seat is not a valid expert ID: {seat!r}")
            err = max(err, 1)
            continue
        if not REF_REGEX.match(ref):
            print(f"  ✗ {impl}: seat {seat!r} names a malformed reference path: {ref!r}")
            err = max(err, 1)
            continue
        if not (skills_root / impl / ref).is_file():
            print(f"  ✗ {impl}: seat {seat!r} names {ref} but {impl}/{ref} does not exist")
            err = max(err, 1)
            continue
        table[seat] = ref

    for seat in seats:
        if seat not in table:
            print(
                f"  ✗ {impl} must be able to build for {seat!r} (seatable, carries {phase_doc}) but has no "
                f"usable table row for it — the Builder's reference read is a silent no-op for that seat"
            )
            err = max(err, 1)

    if err == 0:
        extra = sorted(set(table) - set(seats))
        note = f" (+{len(extra)} extra: {', '.join(extra)})" if extra else ""
        print(f"  ✓ {impl}: {len(table)} rows cover all {len(set(seats))} seatable {phase_doc} advisors{note}")
    return err


def main() -> int:
    here = Path(__file__).resolve().parent
    catalog = here.parent
    skills_root = catalog.parent
    err = 0
    for impl, phase_doc in PAIRS:
        err = max(err, check_pair(skills_root, catalog, impl, phase_doc))
    return err


if __name__ == "__main__":
    sys.exit(main())
