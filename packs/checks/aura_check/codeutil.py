"""Tiny, dependency-free helpers for line-oriented code heuristics.

These are deliberately approximate (no real parser): every rule built on them
is a *warn*-level, best-effort check, and each one has a per-line escape hatch
(``aura-check: ignore[rule-id]``).
"""
from __future__ import annotations

import re
from typing import List, Optional, Tuple

PY_EXT = (".py",)
JS_EXT = (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs")
CODE_EXT = PY_EXT + JS_EXT

TEST_PATH_RE = re.compile(
    r"(^|/)(tests?|__tests__|spec|fixtures?)/|(^|/)test_[^/]*\.py$|_test\.py$|\.(test|spec)\.[jt]sx?$"
)


def is_test_path(path: str) -> bool:
    return bool(TEST_PATH_RE.search(path))


def indent_of(line: str) -> int:
    return len(line) - len(line.lstrip(" \t"))


def py_block(lines: List[str], header_idx: int, max_lines: int = 30) -> List[Tuple[int, str]]:
    """Body of the Python block opened at ``lines[header_idx]`` (0-based).
    Returns (0-based index, text) pairs. Handles ``except X: return y`` one-liners."""
    header = lines[header_idx]
    after_colon = header.split(":", 1)[1].strip() if ":" in header else ""
    if after_colon and not after_colon.startswith("#"):
        return [(header_idx, after_colon)]
    base = indent_of(header)
    body: List[Tuple[int, str]] = []
    for j in range(header_idx + 1, min(len(lines), header_idx + 1 + max_lines)):
        text = lines[j]
        if not text.strip():
            continue
        if indent_of(text) <= base:
            break
        body.append((j, text))
    return body


def js_block(lines: List[str], header_idx: int, max_lines: int = 40) -> List[Tuple[int, str]]:
    """Body of the brace block that opens on/after ``lines[header_idx]``."""
    depth = 0
    opened = False
    body: List[Tuple[int, str]] = []
    for j in range(header_idx, min(len(lines), header_idx + max_lines)):
        text = _strip_js_strings(lines[j])
        if not opened:
            k = text.find("{", text.find("catch") + 1 if "catch" in text else 0)
            if k < 0:
                continue
            opened = True
            rest = text[k + 1:]
            depth = 1 + rest.count("{") - rest.count("}")
            if rest.strip():
                body.append((j, rest))
            if depth <= 0:
                break
            continue
        depth += text.count("{") - text.count("}")
        body.append((j, lines[j]))
        if depth <= 0:
            break
    return body


def _strip_js_strings(text: str) -> str:
    return re.sub(r"(['\"`])(?:\\.|(?!\1).)*\1", '""', text)


PY_EXCEPT_RE = re.compile(r"^\s*except\b.*:\s*(#.*)?$|^\s*except\b[^:]*:\s*\S")
JS_CATCH_RE = re.compile(r"\bcatch\b\s*(\(|\{)")


def handler_blocks(lines: List[str], is_py: bool, start: int = 0,
                   end: Optional[int] = None) -> List[Tuple[int, List[Tuple[int, str]]]]:
    """All except/catch handlers between ``start`` and ``end`` (0-based):
    (header index, body)."""
    out = []
    stop = len(lines) if end is None else min(end, len(lines))
    for i in range(start, stop):
        if is_py:
            if PY_EXCEPT_RE.match(lines[i]):
                out.append((i, py_block(lines, i)))
        elif JS_CATCH_RE.search(lines[i]):
            out.append((i, js_block(lines, i)))
    return out


def balanced_call(lines: List[str], idx: int, col: int, max_lines: int = 15) -> str:
    """Text from ``lines[idx][col]`` (an opening paren) to its matching close,
    joined across lines."""
    depth = 0
    buf = []
    for j in range(idx, min(len(lines), idx + max_lines)):
        seg = lines[j][col:] if j == idx else lines[j]
        for ch in seg:
            buf.append(ch)
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
                if depth == 0:
                    return "".join(buf)
        buf.append("\n")
    return "".join(buf)


# -- markup (JSX / HTML) open tags ----------------------------------------
MARKUP_EXT = (".tsx", ".jsx", ".html", ".htm", ".vue", ".svelte")
_TAG_START_RE = re.compile(r"<([a-zA-Z][\w.:-]*)")


class Tag:
    """One opening tag: ``name``, raw attribute text, 1-based ``line`` of the
    ``<``, and character offsets of the tag in the file text."""

    __slots__ = ("name", "attrs", "line", "start", "end", "self_closing")

    def __init__(self, name: str, attrs: str, line: int, start: int, end: int, self_closing: bool):
        self.name, self.attrs, self.line = name, attrs, line
        self.start, self.end, self.self_closing = start, end, self_closing

    def has(self, attr: str) -> bool:
        return re.search(r"(?<![\w:-])" + re.escape(attr) + r"(?![\w:-])", self.top_level(), re.I) is not None

    def value(self, attr: str) -> Optional[str]:
        """Literal value of ``attr``: the string for ``a="x"`` / ``a={"x"}`` /
        ``a={true}``; the raw expression for other ``{...}``; "" when bare."""
        m = re.search(r"(?<![\w:-])" + re.escape(attr) + r"(?![\w:-])\s*(=\s*)?", self.attrs, re.I)
        if not m:
            return None
        rest = self.attrs[m.end():]
        if not m.group(1):
            return ""
        if rest[:1] in "\"'":
            q = rest[0]
            k = rest.find(q, 1)
            return rest[1:k] if k > 0 else rest[1:]
        if rest[:1] == "{":
            depth, i = 0, 0
            for i, ch in enumerate(rest):
                depth += (ch == "{") - (ch == "}")
                if depth == 0:
                    break
            inner = rest[1:i].strip()
            lit = re.fullmatch(r"([\"'`])(.*)\1", inner, re.S)
            return lit.group(2) if lit else inner
        return rest.split()[0] if rest.split() else ""

    def top_level(self) -> str:
        """Attribute text with ``{...}`` expression bodies and string bodies
        blanked, so ``has`` sees attribute names only."""
        out, depth, quote = [], 0, ""
        for ch in self.attrs:
            if quote:
                if ch == quote:
                    quote = ""
                    out.append(ch)
                continue
            if depth == 0 and ch in "\"'":
                quote = ch
                out.append(ch)
                continue
            if ch == "{":
                depth += 1
                out.append(ch if depth == 1 else " ")
                continue
            if ch == "}":
                depth -= 1
                out.append(ch if depth == 0 else " ")
                continue
            out.append(ch if depth == 0 else " ")
        return "".join(out)

    @property
    def spread(self) -> bool:
        return "{..." in self.attrs.replace(" ", "")


def markup_tags(text: str, max_len: int = 4000) -> List[Tag]:
    """Opening tags in JSX/HTML text, approximately. A ``<`` right after an
    identifier character (``Array<T>``, ``a<b``) is a type or a comparison,
    not a tag. Attribute values may hold ``{...}`` with nested braces, strings
    and ``=>``; the tag ends at the first ``>`` outside both."""
    tags: List[Tag] = []
    line_starts = [0] + [i + 1 for i, ch in enumerate(text) if ch == "\n"]
    import bisect
    for m in _TAG_START_RE.finditer(text):
        s = m.start()
        prev = text[s - 1] if s else ""
        if prev and (prev.isalnum() or prev in "_$."):
            continue
        i, depth, quote, n = m.end(), 0, "", len(text)
        limit = min(n, s + max_len)
        end = -1
        while i < limit:
            ch = text[i]
            if quote:
                if ch == "\\":
                    i += 2
                    continue
                if ch == quote:
                    quote = ""
            elif ch in "\"'`" and (depth > 0 or ch != "`"):
                quote = ch
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
            elif ch == ">" and depth == 0:
                end = i
                break
            elif ch == "<" and depth == 0:
                break  # a new tag started: this was not a tag
            i += 1
        if end < 0:
            continue
        attrs = text[m.end():end]
        self_closing = attrs.rstrip().endswith("/")
        line = bisect.bisect_right(line_starts, s)
        tags.append(Tag(m.group(1), attrs.rstrip("/ \n\t"), line, s, end + 1, self_closing))
    return tags


def element_inner(text: str, tag: Tag, max_len: int = 4000) -> Optional[str]:
    """Children of ``tag`` up to its matching close tag, or None if not found."""
    if tag.self_closing:
        return ""
    name = re.escape(tag.name)
    open_re = re.compile(r"<" + name + r"(?=[\s/>])")
    close_re = re.compile(r"</" + name + r"\s*>")
    depth, i, stop = 1, tag.end, min(len(text), tag.end + max_len)
    while i < stop:
        mo, mc = open_re.search(text, i, stop), close_re.search(text, i, stop)
        if not mc:
            return None
        if mo and mo.start() < mc.start():
            depth, i = depth + 1, mo.end()
            continue
        depth, i = depth - 1, mc.end()
        if depth == 0:
            return text[tag.end:mc.start()]
    return None
