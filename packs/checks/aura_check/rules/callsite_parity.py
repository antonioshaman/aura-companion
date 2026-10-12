"""Pack ``call-site-parity`` — a guard added at one call site but not the others.

Catalog lesson #1 (11 projects): changing a contract or guard in one place out
of several. Diff-only and best-effort: it finds ``if`` guards the change adds
in front of an existing call to a function defined in the project, then lists
other call sites of that function that have no similar condition in the few
lines above them. On the last 40 commits of aura-companion it fires once.
"""
from __future__ import annotations

import re
from typing import Dict, List, Set, Tuple

from ..codeutil import JS_EXT, PY_EXT, is_test_path
from ..core import WARN, Context, rule

PACK = "call-site-parity"

PY_GUARD_RE = re.compile(r"^\s*(?:if|elif)\s+(.+?):\s*(?:#.*)?$|^\s*(?:if|elif)\s+(.+?):\s*(?:return|raise|continue)\b")
JS_GUARD_RE = re.compile(r"^\s*(?:\}\s*else\s+)?if\s*\((.+)\)")
CALL_RE = re.compile(r"(?<![\w$])((?:[A-Za-z_$][\w$]*\.)*([A-Za-z_$][\w$]*))\s*\(")
STOP_NAMES = {
    # keywords / builtins / ubiquitous helpers: never a meaningful "sink"
    "if", "elif", "while", "for", "return", "await", "print", "len", "str", "int", "float", "bool", "dict",
    "list", "set", "tuple", "range", "isinstance", "getattr", "setattr", "hasattr", "super", "type",
    "append", "extend", "get", "pop", "update", "items", "keys", "values", "format", "join", "split",
    "strip", "replace", "startswith", "endswith", "lower", "upper", "debug", "info", "warning", "warn",
    "error", "exception", "critical", "log", "push", "map", "filter", "reduce", "then", "catch", "resolve",
    "reject", "parse", "stringify", "toString", "includes", "slice", "Error", "Exception", "ValueError",
    "TypeError", "RuntimeError", "raise", "assert", "function", "switch", "require", "now", "min", "max",
    "any", "all", "sum", "sorted", "abs", "round", "repr", "next", "iter", "open", "callable",
}
WINDOW_AFTER = 6
WINDOW_BEFORE = 8
MAX_SITES = 10  # more unguarded sites than this = a generic helper, the guard is site-specific


def _family(path: str) -> Tuple[str, ...]:
    return PY_EXT if path.endswith(PY_EXT) else JS_EXT


def _guard_tokens(cond: str) -> Set[str]:
    """What makes this guard recognisable at other sites: functions it calls,
    attributes it reads, and numeric limits it compares against."""
    tokens: Set[str] = set()
    for m in CALL_RE.finditer(cond):
        if m.group(2) not in STOP_NAMES:
            tokens.add(m.group(2))
    tokens.update(re.findall(r"\.([A-Za-z_]\w{3,})\b", cond))
    tokens.update(n for n in re.findall(r"\b\d{2,}\b", cond))
    if not tokens:
        tokens.update(w for w in re.findall(r"\b[A-Za-z_]\w{3,}\b", cond)
                      if w not in {"None", "True", "False", "null", "undefined", "this", "self", "true", "false"})
    return tokens


def _is_definition(line: str, name: str) -> bool:
    return bool(re.search(r"\b(def|function|class)\s+" + re.escape(name) + r"\b", line)
                or re.match(r"^\s*(?:public |private |protected |static |async |export )*" + re.escape(name)
                            + r"\s*\([^)]*\)\s*(?::\s*[^{=]+)?\{\s*$", line))


DEF_RES = (
    re.compile(r"^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)", re.M),
    re.compile(r"\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)"),
    re.compile(r"\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>"),
    re.compile(r"^\s*(?:public |private |protected |static |async )*([A-Za-z_$][\w$]*)\s*\([^)]*\)"
               r"\s*(?::\s*[^{=;]+)?\{\s*$", re.M),
)


def _defined_names(ctx: Context, files: List[str]) -> Set[str]:
    """Functions/methods defined in the project: only these are guarded "sinks"
    (``re.search``/``str.strip`` calls are not a contract the project owns)."""
    names: Set[str] = set()
    for f in files:
        text = ctx.read(f) or ""
        for rx in DEF_RES:
            names.update(rx.findall(text))
    return names - STOP_NAMES


@rule(
    id="call-site-parity.guard-missing", pack=PACK, severity=WARN, diff_scoped=True,
    title="Guard added at one call site; other call sites of the same function lack it",
    evidence="om_event_bot: master placement payment only in the bot while masters come from the site — "
             "0 payments ever; Rapesha_shop_bot: fail-open /admin for 4+ months next to an already-fixed "
             "twin; rapesha_academy 555698a -> 0f8246d (poller without tg_id), '1 unit of 4' (~15 h outage); "
             "auraengine publish_* guards. Catalog lesson #1, 11 projects.",
    hint="Apply the same check at every listed call site (or move it into the function itself so callers "
         "cannot skip it). Not the same contract? Add `aura-check: ignore[call-site-parity.guard-missing]`.",
)
def guard_missing(ctx: Context):
    if not ctx.changed:
        return
    universe: Dict[Tuple[str, ...], List[str]] = {}
    defined: Dict[Tuple[str, ...], Set[str]] = {}
    for path, fd in sorted(ctx.diff.items()):
        if fd.is_new or not path.endswith(PY_EXT + JS_EXT) or is_test_path(path):
            continue  # a brand-new file has no "other call sites" history to diverge from
        is_py = path.endswith(PY_EXT)
        fam = _family(path)
        lines = ctx.lines(path)
        added = fd.added_lines
        for n, text in fd.added:
            gm = (PY_GUARD_RE if is_py else JS_GUARD_RE).match(text)
            if not gm:
                continue
            cond = next(g for g in gm.groups() if g)
            tokens = _guard_tokens(cond)
            if not tokens:
                continue
            if fam not in universe:
                universe[fam] = [p for p in ctx.all_files if p.endswith(fam) and not is_test_path(p)]
                defined[fam] = _defined_names(ctx, universe[fam])
            # The lesson is "a guard was put in front of an existing call": the
            # guarded call must be on an unchanged line, to a project function.
            sinks: List[str] = []
            for k in range(n, min(len(lines), n + WINDOW_AFTER)):  # lines after the guard (0-based k = n)
                if (k + 1) in added:
                    continue
                for cm in CALL_RE.finditer(lines[k]):
                    name = cm.group(2)
                    if name in STOP_NAMES or len(name) < 4 or name in tokens or name in sinks:
                        continue
                    if name not in defined[fam] or _is_definition(lines[k], name):
                        continue
                    sinks.append(name)
                if sinks:
                    break  # the first guarded statement is the sink
            for name in sinks[:2]:
                missing = []
                call_rx = re.compile(r"(?<![\w$])(?:[\w$]+\.)*" + re.escape(name) + r"\s*\(")
                for other in universe[fam]:
                    olines = ctx.lines(other)
                    for idx, oline in enumerate(olines):
                        if not call_rx.search(oline) or _is_definition(oline, name):
                            continue
                        if other == path and (n <= idx + 1 <= n + WINDOW_AFTER or (idx + 1) in added):
                            continue
                        window = "\n".join(olines[max(0, idx - WINDOW_BEFORE):idx + 1])
                        if any(re.search(r"(?<![\w$])" + re.escape(t) + r"(?![\w$])", window) for t in tokens):
                            continue
                        missing.append(f"{other}:{idx + 1}")
                if 0 < len(missing) <= MAX_SITES:
                    yield path, n, (
                        f"new guard `{cond.strip()[:60]}` before `{name}()`; {len(missing)} other call site(s) "
                        f"without it: {', '.join(missing)}")
