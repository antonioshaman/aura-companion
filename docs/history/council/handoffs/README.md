# Council Handoffs Archive

This directory archives multi-session context files that previously lived at the repo root:

- `HANDOFF-*.md` — session-to-session handoffs (closure summaries, "next session" notes)
- `PLAN-aura-*.md` — multi-session plans (auto-proceed, observer auto-wake, beta catalog refactor, etc.)
- `BUG-*.md` — bug reports that span multiple sessions
- `TASK-*.md` — task definitions used as input to council planning
- `SESSION-*.md` — pause-state snapshots
- `CLOSURE-council-mode-v2.md` — Council Mode v2 milestone closure
- `CI-CONTEXT.md`, `CLEANUP-AUDIT.md` — accumulated context notes
- `aura-observer-liveness-*.md` — observer liveness directives

These files are **append-only history**. They were authored during specific sessions and reflect state at that point — they may reference defunct branches, closed PRs, or superseded decisions. Treat them as archival; do not link from authoritative docs (`CLAUDE.md`, `README.md`, `docs/`) unless explicitly preserving a historical reference.

For current state, prefer:
- `CLAUDE.md` — authoritative project guide
- `conventions.md` — ratified AP-/EC- conventions
- `specs/` — current architecture specs
- `docs/` — Mintlify-rendered user docs
- `.council/reviews/` — observer review files (active, not archive)
- `.council/review-output/<TIMESTAMP>/` — council review batches (current findings)
