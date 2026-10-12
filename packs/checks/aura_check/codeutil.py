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
