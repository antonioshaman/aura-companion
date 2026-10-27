#!/usr/bin/env python3
"""C10 — semantic-coverage gate over `_phase2-coverage-tokens.yml`.

What this protects that no other canary does
--------------------------------------------
C11/C12 answer "are these bytes the bytes we expect". They are exact and
therefore blind to meaning: a reference doc rewritten from scratch, with its
lock hash regenerated in the same commit, is green everywhere. C10 is the only
check that asserts a doc still SAYS the things its expert was merged to say.

The ground truth is `_phase2-coverage-tokens.yml`: per target, a set of tokens
each sourced from a specific pre-merge expert, plus structural anchors (the
`## §A ...` headings that keep a merged doc navigable). Losing a token means a
merge silently dropped an expert's contribution — the failure mode the Phase 2
merges were designed around, and the reason the token list was captured at
merge time rather than reconstructed afterwards.

Semantics (from the YAML's own header, kept in lockstep with it)
---------------------------------------------------------------
  tokens             — must appear >=1 time across ANY search_path (OR)
  structural_anchors — must appear >=min_count in EACH listed path (AND)
  forbidden          — must appear 0 times in EACH listed path

The OR for tokens is deliberate: a target's search_paths are mirrors of one
document, so a token present in any of them is present in the document. C11
separately proves the mirrors are byte-identical, which is what makes the OR
safe rather than sloppy.

This file was dormant for the whole `-v2` migration: the YAML claimed
"Read by verify-catalog.sh C10" while `grep -c C10 verify-catalog.sh` returned
0, and all 32 of its search paths pointed at a tree that had been deleted. A
gate that names its own consumer is not evidence the consumer exists.

Exit 0 all-green, 1 on any violation, 2 on an operational failure (missing or
unparseable ground truth, missing search path) so the caller can distinguish
"no violations" from "could not look".
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    print("  ✗ pyyaml not available — install python3-yaml", file=sys.stderr)
    sys.exit(2)

HERE = Path(__file__).resolve().parent
SKILLS_ROOT = HERE.parent.parent
TOKENS = HERE / "_phase2-coverage-tokens.yml"

# Path shape for anything this gate is allowed to open. The YAML is data, and
# data that names a file is an instruction to read it: without a shape check,
# `search_paths: [../../../etc/shadow]` is a file-read primitive with a
# hit-count oracle. Bounded again by _resolve_bounded below — shape first so the
# error names the offending entry rather than a resolved absolute path.
REF_PATH_REGEX = re.compile(
    r"^(_council-experts/[a-z][a-z0-9-]{1,31}|council-(plan|review|implement)(-aura)?)"
    r"/references/[a-z][a-z0-9_.-]{0,63}\.md$"
)

# ReDoS-safe regex shape, per the YAML header and Hunt REC-3. Only literals,
# escaped dots, `\w+` placeholders, `|` alternation, `/` and `-`. Every
# quantifier outside `\w+` is rejected: catastrophic backtracking needs nested
# or adjacent quantifiers, and none can be written within this alphabet.
SAFE_REGEX_SHAPE = re.compile(r"^(?:[A-Za-z0-9 _/:-]|\\\.|\\w\+|\|)+$")


class GroundTruthError(Exception):
    pass


def _resolve_bounded(rel: str, where: str) -> Path:
    if not REF_PATH_REGEX.match(rel):
        raise GroundTruthError(f"{where}: path is not an allowed reference doc: {rel!r}")
    root = SKILLS_ROOT.resolve()
    p = (SKILLS_ROOT / rel).resolve()
    if p != root and not str(p).startswith(str(root) + "/"):
        raise GroundTruthError(f"{where}: path escapes skills root: {rel!r}")
    return p


def _matcher(text: str, kind: str, where: str):
    """Return a function counting occurrences of `text` in a document."""
    if kind == "fixed":
        return lambda body: body.count(text)
    if kind == "regex":
        if not SAFE_REGEX_SHAPE.match(text):
            raise GroundTruthError(
                f"{where}: regex is outside the vetted ReDoS-safe shape: {text!r}"
            )
        pat = re.compile(text)
        return lambda body: len(pat.findall(body))
    raise GroundTruthError(f"{where}: unknown kind {kind!r} (expected fixed|regex)")


def _read(rel: str, where: str, cache: dict[str, str]) -> str:
    if rel not in cache:
        p = _resolve_bounded(rel, where)
        if not p.is_file():
            raise GroundTruthError(f"{where}: search path does not exist: {rel}")
        cache[rel] = p.read_text(encoding="utf-8")
    return cache[rel]


def main() -> int:
    if not TOKENS.is_file():
        print(f"  ✗ {TOKENS.name} missing — semantic coverage is unverifiable")
        return 2
    try:
        spec = yaml.safe_load(TOKENS.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError as e:
        print(f"  ✗ {TOKENS.name}: YAML parse error: {e}")
        return 2

    targets = spec.get("targets")
    if not isinstance(targets, dict) or not targets:
        print(f"  ✗ {TOKENS.name}: `targets` is empty — zero comparisons is not a pass")
        return 2

    err = 0
    n_tokens = n_anchors = n_forbidden = 0
    cache: dict[str, str] = {}

    for tid, t in targets.items():
        paths = t.get("search_paths") or []
        if not paths:
            print(f"  ✗ {tid}: declares no search_paths — its tokens check nothing")
            err = max(err, 2)
            continue
        try:
            bodies = {rel: _read(rel, tid, cache) for rel in paths}
        except GroundTruthError as exc:
            print(f"  ✗ {exc}")
            err = max(err, 2)
            continue

        # Anchors: AND across paths — a heading missing from one mirror is a
        # broken document even if its siblings still carry it.
        for a in t.get("structural_anchors") or []:
            try:
                count = _matcher(a["text"], a.get("kind", "fixed"), f"{tid}.anchor")
            except GroundTruthError as exc:
                print(f"  ✗ {exc}")
                err = max(err, 2)
                continue
            need = a.get("min_count", 1)
            for rel, body in bodies.items():
                n_anchors += 1
                got = count(body)
                if got < need:
                    print(
                        f"  ✗ {tid}: anchor {a['text']!r} appears {got}× in {rel} "
                        f"(min_count {need}, source {a.get('source', '?')})"
                    )
                    err = max(err, 1)

        # Tokens: OR across paths.
        for tok in t.get("tokens") or []:
            try:
                count = _matcher(tok["text"], tok.get("kind", "fixed"), f"{tid}.token")
            except GroundTruthError as exc:
                print(f"  ✗ {exc}")
                err = max(err, 2)
                continue
            n_tokens += 1
            if not any(count(body) for body in bodies.values()):
                print(
                    f"  ✗ {tid}: token {tok['text']!r} (source {tok.get('source', '?')}, "
                    f"cluster {tok.get('cluster', '?')}) absent from all "
                    f"{len(bodies)} search paths"
                )
                err = max(err, 1)

    for f in spec.get("forbidden") or []:
        fid = f.get("id", "<unnamed>")
        fpaths = f.get("paths") or []
        if not fpaths:
            print(f"  ✗ forbidden/{fid}: declares no paths — asserts nothing")
            err = max(err, 2)
            continue
        try:
            count = _matcher(f["pattern"], f.get("kind", "fixed"), f"forbidden/{fid}")
        except GroundTruthError as exc:
            print(f"  ✗ {exc}")
            err = max(err, 2)
            continue
        for rel in fpaths:
            try:
                body = _read(rel, f"forbidden/{fid}", cache)
            except GroundTruthError as exc:
                print(f"  ✗ {exc}")
                err = max(err, 2)
                continue
            n_forbidden += 1
            got = count(body)
            if got:
                print(
                    f"  ✗ forbidden/{fid}: pattern {f['pattern']!r} appears "
                    f"{got}× in {rel} (must be 0)"
                )
                err = max(err, 1)

    # Zero-comparison guard. Every other canary in this suite grew one after the
    # same discovery: a selector that matches nothing prints the success line.
    if n_tokens == 0 or n_anchors == 0:
        print(
            f"  ✗ {TOKENS.name}: {n_tokens} token and {n_anchors} anchor "
            f"comparisons — the gate looked at nothing"
        )
        err = max(err, 2)

    if err == 0:
        print(
            f"  ✓ {n_tokens} tokens + {n_anchors} anchor checks across "
            f"{len(targets)} merged docs, {n_forbidden} forbidden-pattern "
            f"assertions — semantic coverage intact"
        )
    return err


if __name__ == "__main__":
    sys.exit(main())
