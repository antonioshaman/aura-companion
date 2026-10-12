"""Pack ``llm-output`` — raw LLM text leaking to users when JSON parsing fails.

The runtime counterpart is the publish guard in ``packs/checks/snippets/``.
"""
from __future__ import annotations

import re
from typing import Set

from ..codeutil import CODE_EXT, PY_EXT, balanced_call, handler_blocks, is_test_path
from ..core import WARN, Context, rule

PACK = "llm-output"

PARSE_RE = {
    True: re.compile(r"\b(?:json|orjson|ujson|json5)\.loads\s*\("),
    False: re.compile(r"\bJSON\.parse\s*\("),
}
GENERIC_ROOTS = {"self", "this", "cls", "json", "JSON"}
# Only files that talk to an LLM: plain config/JSON passthrough is not this lesson.
LLM_CONTEXT_RE = re.compile(
    r"(?i)(openai|anthropic|\bllm\b|chat\.completions|completion|\bgpt-|claude|gemini|mistral|ollama|"
    r"proxyapi|\bprompt\b|messages\.create|generate_content)")
SAFE_RETURN = re.compile(r"^\s*return\s*(None|null|undefined|\{\s*\}|\[\s*\]|''|\"\"|False|false)?\s*;?\s*$")


def _candidates(arg: str) -> Set[str]:
    """Names that hold the raw text passed to the parser."""
    inner = arg[1:-1] if arg.startswith("(") else arg
    m = re.match(r"\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[[^\]]*\])*)", inner)
    if not m:
        return set()
    chain = m.group(1)
    chain = re.sub(r"\.(strip|trim|lstrip|rstrip|lower|decode)$", "", chain)
    out = {chain}
    root = re.split(r"[.\[]", chain)[0]
    if root not in GENERIC_ROOTS:
        out.add(root)
    return out


def _returns_raw(expr: str, name: str) -> bool:
    """``return raw`` / ``return raw.strip()`` or a literal container/f-string
    that embeds it (``{"soft": raw.strip()}``). A call that transforms the text
    (``return redact(raw)``) is not a raw passthrough."""
    word = r"(?<![\w$.])" + re.escape(name) + r"(?![\w$])"
    if re.fullmatch(re.escape(name) + r"(\.(strip|trim|lstrip|rstrip)\(\))?", expr):
        return True
    if expr[:1] in "{[(" or expr[:2] in ('f"', "f'") or expr[:1] == "`":
        return bool(re.search(word, expr))
    return False


@rule(
    id="llm-output.raw-on-parse-failure", pack=PACK, severity=WARN, diff_scoped=True,
    title="Raw LLM text returned when JSON parsing fails",
    evidence="auraengine 2eb2bf0 ('Added validation to fallback LLM path') added `return {...: body.strip()}` "
             "on JSON error — the opposite of review P1 #8 — and 27 replies with a raw JSON envelope were "
             "published as public comments (05-03..08-01); razumai >=10 markup-leak episodes.",
    hint="On parse failure return nothing (None / raise) and log it; never forward the unparsed model "
         "text. Gate every public write with `assert_publishable()` (packs/checks/snippets).",
)
def raw_on_parse_failure(ctx: Context):
    for path in ctx.files_with_ext(*CODE_EXT):
        is_py = path.endswith(PY_EXT)
        if is_test_path(path) or not LLM_CONTEXT_RE.search(ctx.read(path) or ""):
            continue
        lines = ctx.lines(path)
        for i, line in enumerate(lines):
            m = PARSE_RE[is_py].search(line)
            if not m:
                continue
            arg = balanced_call(lines, i, m.end() - 1)
            names = _candidates(arg)
            if not names:
                continue
            for _hdr, body in handler_blocks(lines, is_py, i + 1, i + 25)[:1]:
                for j, text in body:
                    rm = re.search(r"\breturn\b(.*)", text)
                    if not rm or SAFE_RETURN.match("return" + rm.group(1)):
                        continue
                    expr = rm.group(1).strip().rstrip(";").strip()
                    hit = [n for n in names if _returns_raw(expr, n)]
                    if hit:
                        yield path, j + 1, (
                            f"returns the unparsed text `{sorted(hit, key=len)[0]}` when parsing fails "
                            f"(parse at line {i + 1})")
                        break

