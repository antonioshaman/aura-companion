"""Pack ``fallback`` — silent model/provider fallback (Co-Pilot, razumai, auraengine, maya-date)."""
from __future__ import annotations

import re

from ..codeutil import CODE_EXT, PY_EXT, handler_blocks, is_test_path
from ..core import WARN, Context, rule

PACK = "fallback"

SWITCH_RE = re.compile(
    r"""(?ix)
    \b(?:fallback|backup|secondary|alt(?:ernate|ernative)?|default)_?(?:model|provider|llm|client|engine)\b
    | \b(?:model|provider|llm|engine)(?:_name|_id)?\s*[:=]\s*['"][\w.:/\-]+['"]
    | \b(?:self|this)\.(?:model|provider|llm|client)\s*=
    | \b(?:model|provider|llm)(?:_name|_id)?\s*=\s*[A-Za-z_][\w.]*\s*$
    """
)
LOG_RE = re.compile(
    r"(?i)\b(log|logger|logging|log\.\w+|console\.(warn|error|info|log)|warn(ing)?|metrics?\.\w+|"
    r"statsd|sentry|capture_exception|capture_message|report_error|alert)\b\s*[.(]"
)


@rule(
    id="fallback.silent-model-fallback", pack=PACK, severity=WARN, diff_scoped=True,
    title="Model/provider fallback in an error handler without a log call",
    evidence="Co-Pilot 4a66133: a 400 on `temperature` silently re-routed requests to another model, "
             "book rewrites were done by the wrong model until noticed; razumai e0af7ac (dead model id -> "
             "fallback); auraengine fallback to its own feed (d730d9b); maya-date silent algorithm fallback. "
             "Catalog lesson #7, 6 projects.",
    hint="Log the first error at WARN with the original and the fallback model/provider (and bump a "
         "metric) before switching; better, fail loudly when the fallback changes the product contract.",
)
def silent_model_fallback(ctx: Context):
    for path in ctx.files_with_ext(*CODE_EXT):
        if is_test_path(path):
            continue
        is_py = path.endswith(PY_EXT)
        lines = ctx.lines(path)
        for hdr, body in handler_blocks(lines, is_py):
            texts = [t for _, t in body]
            switch = next(((j, t) for j, t in body if SWITCH_RE.search(t)), None)
            if switch is None:
                continue
            if LOG_RE.search(lines[hdr]) or any(LOG_RE.search(t) for t in texts):
                continue
            yield path, switch[0] + 1, (
                f"error handler at line {hdr + 1} switches model/provider without logging the failure")
