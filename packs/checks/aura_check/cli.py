"""``aura-check`` command line.

Exit codes: 0 = no errors (warnings allowed), 1 = at least one error finding
(or a warning with --strict), 2 = usage / environment problem.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import List, Optional

from . import core


def _packs(values: Optional[List[str]]) -> Optional[List[str]]:
    if not values:
        return None
    out: List[str] = []
    for v in values:
        out.extend(p.strip() for p in v.split(",") if p.strip())
    return out


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="aura-check",
        description="Experience packs: lessons from real projects as deterministic checks.")
    p.add_argument("--pack", action="append", metavar="NAME",
                   help="run only these packs (repeatable or comma-separated); default: all")
    p.add_argument("--changed", action="store_true",
                   help="scan only what the change adds: staged diff (pre-commit), or BASE...HEAD with --base")
    p.add_argument("--base", metavar="REF",
                   help="with --changed: diff and commit messages of BASE...HEAD (CI mode)")
    p.add_argument("--commit-msg-file", metavar="PATH",
                   help="also scan this commit message (commit-msg hook); alone, scans only the message")
    p.add_argument("--runtime", action="store_true",
                   help="also inspect installed systemd units and their working directories")
    p.add_argument("--unit-dir", action="append", metavar="DIR",
                   help="unit directories for --runtime (default /etc/systemd/system, ~/.config/systemd/user)")
    p.add_argument("--main-branch", action="append", metavar="NAME",
                   help="branch names a prod checkout may be on (default main, master)")
    p.add_argument("--root", default=".", help="repository root (default: cwd)")
    p.add_argument("--format", choices=("text", "json"), default="text")
    p.add_argument("--strict", action="store_true", help="exit 1 on warnings too")
    p.add_argument("--list", action="store_true", help="list packs and rules, then exit")
    return p


def list_rules(packs: Optional[List[str]]) -> str:
    out = []
    current = None
    for r in sorted(core.select_rules(packs, runtime=True), key=lambda r: (r.pack, r.id)):
        if r.pack != current:
            current = r.pack
            out.append(f"\n[{r.pack}]")
        flags = []
        if r.diff_scoped:
            flags.append("diff-scoped in --changed")
        if r.runtime_only:
            flags.append("--runtime only")
        extra = f" ({', '.join(flags)})" if flags else ""
        out.append(f"  {r.id:45} {r.severity:5} {r.title}{extra}")
    return "\n".join(out).lstrip("\n")


def render_text(findings: List[core.Finding]) -> str:
    out = []
    for f in findings:
        r = core.rule_by_id(f.rule_id)
        out.append(f"{f.severity.upper():5} {f.rule_id}  {f.location()}\n      {f.message}\n      fix: {r.hint}")
    if findings:
        out.append("\nwhy (evidence from real projects):")
        for rid in sorted({f.rule_id for f in findings}):
            out.append(f"  {rid}: {core.rule_by_id(rid).evidence}")
        errors = sum(f.severity == core.ERROR for f in findings)
        out.append(f"\naura-check: {errors} error(s), {len(findings) - errors} warning(s)")
    return "\n".join(out)


def main(argv: Optional[List[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    packs = _packs(args.pack)
    known = {r.pack for r in core.select_rules(None, runtime=True)}
    if packs:
        unknown = sorted(set(packs) - known)
        if unknown:
            print(f"aura-check: unknown pack(s): {', '.join(unknown)}; known: {', '.join(sorted(known))}",
                  file=sys.stderr)
            return 2
    if args.list:
        print(list_rules(packs))
        return 0
    if args.base and not args.changed:
        print("aura-check: --base requires --changed", file=sys.stderr)
        return 2

    messages = []
    if args.commit_msg_file:
        try:
            body = Path(args.commit_msg_file).read_text(encoding="utf-8", errors="replace")
        except OSError as e:
            print(f"aura-check: cannot read commit message: {e}", file=sys.stderr)
            return 2
        # git puts comment lines (# Please enter...) in the template; drop them.
        body = "\n".join(l for l in body.splitlines() if not l.startswith("#"))
        messages.append(("commit-message:new", body))

    message_only = bool(args.commit_msg_file) and not args.changed
    root = Path(args.root)
    try:
        ctx = core.Context(
            root, changed=args.changed, base=args.base, commit_messages=messages,
            scan_files=not message_only, runtime=args.runtime,
            unit_dirs=[Path(d) for d in args.unit_dir] if args.unit_dir else None,
            main_branches=tuple(args.main_branch) if args.main_branch else ("main", "master"),
        )
    except RuntimeError as e:
        print(f"aura-check: {e}", file=sys.stderr)
        return 2
    findings = core.run(ctx, packs)

    if args.format == "json":
        print(json.dumps([f.__dict__ for f in findings], ensure_ascii=False, indent=2))
    elif findings:
        print(render_text(findings))
    has_error = any(f.severity == core.ERROR for f in findings)
    return 1 if has_error or (args.strict and findings) else 0
