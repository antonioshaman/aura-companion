"""Publish guard: the last check before LLM text becomes public.

Copy this file into your project (stdlib only). Call ``assert_publishable``
right before every public write (post a comment, send a Telegram message,
save a user-visible reply). It rejects text that is obviously *not* a final
answer: a JSON envelope, a fenced code block, or internal keys / tags the
pipeline uses between steps.

Lesson: auraengine published 27 raw JSON envelopes as public comments after a
"fallback" returned the unparsed model output (see docs/experience-packs.md).
"""
from __future__ import annotations

import json
import re
from typing import Iterable, Optional

# Keys your pipeline uses internally; extend per project.
DEFAULT_INTERNAL_KEYS = ("reply", "soft", "hard", "reasoning", "analysis", "thoughts", "tool_call",
                         "function_call", "schema_version", "system", "assistant")
_TAG_RE = re.compile(r"</?(thinking|analysis|reasoning|system|scratchpad|tool_call)\b[^>]*>", re.I)
_FENCE_RE = re.compile(r"^\s*```|```\s*$", re.M)


class UnpublishableText(ValueError):
    """Raised when text must not reach users. ``reason`` is safe to log."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def publish_problem(text: Optional[str], internal_keys: Iterable[str] = DEFAULT_INTERNAL_KEYS) -> Optional[str]:
    """Return why ``text`` must not be published, or None if it looks fine."""
    if text is None or not text.strip():
        return "empty"
    s = text.strip()
    if _FENCE_RE.search(s):
        return "contains a fenced code block"
    if s[0] in "{[" and s[-1] in "}]":
        try:
            json.loads(s)
            return "is a JSON document"
        except ValueError:
            return "looks like (broken) JSON"
    if _TAG_RE.search(s):
        return "contains an internal tag"
    for key in internal_keys:
        if re.search(r"""["']%s["']\s*:""" % re.escape(key), s):
            return f"contains internal key {key!r}"
    return None


def assert_publishable(text: Optional[str], internal_keys: Iterable[str] = DEFAULT_INTERNAL_KEYS) -> str:
    """Return the stripped text, or raise ``UnpublishableText``. Log the reason
    and drop the reply; never "fix" it by publishing the raw text."""
    problem = publish_problem(text, internal_keys)
    if problem:
        raise UnpublishableText(problem)
    return (text or "").strip()
