"""Pack ``secrets`` — tokens and keys in tracked files and commit messages.

Findings never print the secret itself (see ``core.mask``).
"""
from __future__ import annotations

import bisect
import math
import re
from collections import Counter
from typing import Iterator, Tuple

from ..core import ERROR, Context, mask, rule

PACK = "secrets"

# (label, regex). Group 1 (if present) is the secret; otherwise the whole match.
TOKEN_PATTERNS = [
    ("npm token", re.compile(r"\bnpm_[A-Za-z0-9]{36}\b")),
    ("Gonka key", re.compile(r"\bgnk-[A-Za-z0-9_\-]{16,}")),
    ("OpenAI/Anthropic-style key", re.compile(r"\bsk-(?:proj-|ant-|or-)?[A-Za-z0-9_\-]{20,}")),
    ("Telegram bot token", re.compile(r"(?<![\w:])\d{8,10}:[A-Za-z0-9_\-]{35}(?![\w\-])")),
    ("private key block", re.compile(r"-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----")),
    ("GitHub token", re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{60,})\b")),
    ("AWS access key id", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("Slack token", re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}")),
]

LITERAL_GATES = {
    "npm token": ("npm_",), "Gonka key": ("gnk-",), "OpenAI/Anthropic-style key": ("sk-",),
    "private key block": ("PRIVATE KEY",), "GitHub token": ("gh", "github_pat_"),
    "AWS access key id": ("AKIA",), "Slack token": ("xox",),
}
# Anchored on the keyword (a leading `[\w.]*` would backtrack at every offset);
# the full variable name is recovered by scanning back in ``_name_at``.
ASSIGN_RE = re.compile(
    r"""(?i)(?:api[_\-]?key|secret|token|passw(?:or)?d|private[_\-]?key|access[_\-]?key|"""
    r"""session[_\-]?string|webhook[_\-]?key)[A-Z0-9_]*['"]?[ \t]*[:=][ \t]*['"]?([A-Za-z0-9+/=_\-.:]{16,})['"]?"""
)
NAME_CHARS = set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-")


def _name_at(text: str, start: int, value_start: int) -> str:
    i = start
    while i > 0 and text[i - 1] in NAME_CHARS:
        i -= 1
    return text[i:value_start].split("=")[0].split(":")[0].strip(" \t'\"")
PLACEHOLDER_RE = re.compile(
    r"(?i)(your|xxxx|example|changeme|change_me|placeholder|dummy|sample|redacted|replace|"
    r"<|\*\*\*|\.\.\.|not[_-]?set|todo|none|null|undefined|process\.env|os\.environ|getenv)"
)


def shannon(s: str) -> float:
    counts = Counter(s)
    return -sum(c / len(s) * math.log2(c / len(s)) for c in counts.values())


FAKE_RE = re.compile(
    r"(?i)(test|fake|mock|dummy|example|sample|placeholder|redact|xxxx|abcdef|abcxyz|0123|1234|"
    r"(?P<ch>.)(?P=ch){5,}|(?P<w>[A-Za-z]{3,})(?P=w){2,})")



def looks_fake(value: str) -> bool:
    """Obviously synthetic values (fixtures, docs). Real tokens are random;
    tests should use values like ``sk-test-...`` / ``...abcdef...`` so they
    stay quiet here — see README "Fixtures"."""
    if FAKE_RE.search(value):
        return True
    words = [w for w in re.split(r"[-_]", value) if len(w) >= 3]
    return sum(w.isalpha() and w.islower() for w in words) >= 2


def find_secrets_in_text(text: str) -> Iterator[Tuple[int, str, str]]:
    """Yield (offset, label, secret) for every secret-looking token in ``text``.
    Runs each regex over the whole text (much faster than per line)."""
    seen = []
    lowered = text.lower()
    for label, rx in TOKEN_PATTERNS:
        gate = LITERAL_GATES.get(label)
        if gate and not any(g in text for g in gate):
            continue  # str.__contains__ is far cheaper than a regex scan
        for m in rx.finditer(text):
            seen.append(m.span())
            if label != "private key block" and looks_fake(m.group(0)):
                continue
            yield m.start(), label, m.group(0)
    if not any(k in lowered for k in ("key", "secret", "token", "passw", "session")):
        return
    for m in ASSIGN_RE.finditer(text):
        value = m.group(1).strip(".:")
        if any(a <= m.start(1) < b for a, b in seen):
            continue
        if "://" in value or looks_fake(value) or PLACEHOLDER_RE.search(value) or \
                PLACEHOLDER_RE.search(text[m.end(1):m.end(1) + 3]):
            continue
        if not (re.search(r"\d", value) and re.search(r"[A-Za-z]", value)):
            continue
        if re.fullmatch(r"[a-z_.]+\d?", value) or re.fullmatch(r"[0-9a-f]{40}", value):
            continue  # dotted identifier / git sha
        if shannon(value) < 3.5:
            continue
        yield m.start(), f"high-entropy value for {_name_at(text, m.start(), m.start(1))}", value


def find_secrets(line: str) -> Iterator[Tuple[str, str]]:
    """Yield (label, secret) for every secret-looking token on ``line``."""
    for _off, label, secret in find_secrets_in_text(line):
        yield label, secret


def _secrets_by_line(text: str) -> Iterator[Tuple[int, str, str]]:
    starts = [0]
    for m in re.finditer("\n", text):
        starts.append(m.end())
    for off, label, secret in find_secrets_in_text(text):
        yield bisect.bisect_right(starts, off), label, secret


@rule(
    id="secrets.in-file", pack=PACK, severity=ERROR,
    title="Secret in a tracked file",
    evidence="takopi: OPENAI key in a 644 systemd unit; rapesha_academy: bot token in `.env.bak`; "
             "snowlevel: a payment secret fragment copied into a memory note; catalog lesson #16, 6 projects.",
    hint="Move the value to an untracked env file (chmod 600) and ROTATE it — git history keeps the old "
         "value. False positive? Add `aura-check: ignore[secrets.in-file]` on that line.",
)
def secret_in_file(ctx: Context):
    for path in ctx.files:
        text = ctx.read(path)
        if text is None:
            continue
        if not ctx.changed:
            for n, label, secret in _secrets_by_line(text):
                yield path, n, f"{label}: {mask(secret)}"
            continue
        for n, line in ctx.scan_lines(path):
            for label, secret in find_secrets(line):
                yield path, n, f"{label}: {mask(secret)}"


@rule(
    id="secrets.in-commit-message", pack=PACK, severity=ERROR,
    title="Secret in a commit message",
    evidence="Same class as secrets.in-file; commit messages are pushed to GitHub and cannot be "
             "redacted without rewriting history (catalog lesson #16).",
    hint="Amend the message before pushing (`git commit --amend`), and rotate the value if it was "
         "ever pushed.",
)
def secret_in_commit_message(ctx: Context):
    for label, body in ctx.commit_messages:
        for n, line in enumerate(body.splitlines(), 1):
            for kind, secret in find_secrets(line):
                yield label, n, f"{kind}: {mask(secret)}"
