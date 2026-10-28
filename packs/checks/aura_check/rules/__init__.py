"""Importing this package registers every rule with ``core.RULES``."""
from . import (  # noqa: F401
    alembic,
    callsite_parity,
    deploy,
    env,
    fallback,
    llm_output,
    pii,
    secrets,
    telegram,
    uiux,
)
