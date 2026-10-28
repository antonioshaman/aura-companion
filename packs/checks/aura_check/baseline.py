"""``--baseline``: a strict list of accepted findings, each with a human ruling.

A finding is matched by rule, path and a fingerprint of its line plus the next
one (line numbers drift; text rarely does), up to ``count`` times. Unmatched
findings are reported as usual. In a full scan an entry that matches fewer
findings than its ``count`` is *stale* and fails the run, so a fixed defect
cannot leave an entry that would hide the next one. ``--changed`` scans only
touched files, so absence proves nothing there and the stale check is skipped.

Only true problems can be baselined (``ruling: "true-problem"``): a rule that
fires on correct code is fixed or dropped, never baselined.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Tuple

from . import core

RULINGS = ("true-problem",)
ACTIONS = ("fix-later", "accepted")
REQUIRED = ("rule", "path", "match", "count", "ruling", "action", "reason", "ruledBy", "ruledAt")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
STALE_ID = "baseline.stale-entry"


class BaselineError(ValueError):
    pass


@dataclass
class Entry:
    rule: str
    path: str
    match: str
    count: int
    raw: dict


def fingerprint(ctx: core.Context, f: core.Finding) -> str:
    lines = ctx.lines(f.path)
    if not f.line or f.line > len(lines):
        return ""
    return " | ".join(" ".join(l.split()) for l in lines[f.line - 1:f.line + 1])


def load(path: Path) -> List[Entry]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except OSError as e:
        raise BaselineError(f"cannot read {path}: {e}") from None
    except ValueError as e:
        raise BaselineError(f"{path} is not JSON: {e}") from None
    entries = data.get("entries") if isinstance(data, dict) else None
    if not isinstance(entries, list):
        raise BaselineError(f"{path}: expected an object with an \"entries\" list")
    out: List[Entry] = []
    for i, e in enumerate(entries):
        where = f"{path}: entry {i}"
        if not isinstance(e, dict):
            raise BaselineError(f"{where} is not an object")
        missing = [k for k in REQUIRED if k not in e]
        if missing:
            raise BaselineError(f"{where} lacks {', '.join(missing)}")
        for k in ("rule", "path", "match", "reason", "ruledBy"):
            if not isinstance(e[k], str) or not e[k].strip():
                raise BaselineError(f"{where}: {k} must be a non-empty string")
        if e["ruling"] not in RULINGS:
            raise BaselineError(f"{where}: ruling must be one of {RULINGS} (false positives are fixed in "
                                f"the rule, not baselined)")
        if e["action"] not in ACTIONS:
            raise BaselineError(f"{where}: action must be one of {ACTIONS}")
        if not isinstance(e["ruledAt"], str) or not DATE_RE.match(e["ruledAt"]):
            raise BaselineError(f"{where}: ruledAt must be YYYY-MM-DD")
        if not isinstance(e["count"], int) or isinstance(e["count"], bool) or e["count"] < 1:
            raise BaselineError(f"{where}: count must be a positive integer")
        out.append(Entry(e["rule"], e["path"], " ".join(e["match"].split()), e["count"], e))
    return out


def apply(ctx: core.Context, findings: List[core.Finding], entries: List[Entry],
          selected_rules: set, check_stale: bool) -> Tuple[List[core.Finding], int, List[core.Finding]]:
    """Returns (unmatched findings, number accepted, stale-entry findings)."""
    budget: Dict[Tuple[str, str, str], int] = {}
    for e in entries:
        key = (e.rule, e.path, e.match)
        budget[key] = budget.get(key, 0) + e.count
    left = dict(budget)
    kept: List[core.Finding] = []
    accepted = 0
    for f in sorted(findings, key=lambda f: (f.path, f.line)):
        key = (f.rule_id, f.path, fingerprint(ctx, f))
        if left.get(key, 0) > 0:
            left[key] -= 1
            accepted += 1
        else:
            kept.append(f)
    kept.sort(key=lambda f: (f.severity != core.ERROR, f.path, f.line, f.rule_id))
    stale: List[core.Finding] = []
    if check_stale:
        for (rule, path, match), n in left.items():
            if n > 0 and rule in selected_rules:
                stale.append(core.Finding(
                    STALE_ID, core.ERROR, path, 0,
                    f"STALE baseline entry: {rule} no longer fires {n} more time(s) on `{match}`; "
                    f"remove it (or update it if the code moved)"))
    return kept, accepted, stale
