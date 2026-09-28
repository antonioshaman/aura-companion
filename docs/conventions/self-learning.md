# Self-learning system

> Moved out of `CLAUDE.md` in P2/A3 (2026-09-28). `CLAUDE.md` links here with one line;
> this file is loaded on demand, not on every session start.


This project uses a file-based knowledge system that improves with every session. The knowledge base lives in `.agents/knowledge/` and accumulates patterns, gotchas, decisions, and anti-patterns discovered during development.

## Knowledge Base

```
.agents/knowledge/
├── patterns.jsonl        # Reusable approaches that work well
├── gotchas.jsonl         # Surprising behaviors and tricky edge cases
├── decisions.jsonl       # Architectural choices and rationale
├── anti-patterns.jsonl   # Approaches to avoid
├── codebase-facts.jsonl  # Structural knowledge about the repo
└── api-behaviors.jsonl   # Model/tool/API quirks
```

Each file contains one JSON object per line (JSONL format) with: `id`, `type`, `fact`, `recommendation`, `confidence`, `provenance`, `tags`, `affectedFiles`, `createdAt`.

## Skills

- `/prime [focus]` — Load relevant knowledge before starting work. Auto-filters by branch, modified files, or provided keywords. Run at session start.
- `/learn <insight>` — Quick-capture a learning mid-session without breaking flow. Auto-classifies and appends to the right knowledge file.
- `/self-reflect [scope]` — End-of-session reflection. Reviews what happened, extracts learnings, prunes stale entries. Run after completing significant work.

## Self-Learning Protocol

1. **Session start**: Automatically scan the last 3 entries from each knowledge file. If any are relevant to the current branch/task, surface them.
2. **During work**: When you encounter surprising behavior, test failures, or user corrections — capture them immediately via `/learn`.
3. **Session end**: Run `/self-reflect` to consolidate learnings. This is the most important step — it closes the feedback loop.

## Evolution

The knowledge base grows organically. Over time:
- Recurring gotchas → get promoted to patterns or CLAUDE.md rules
- Low-confidence entries that get re-confirmed → get bumped to high confidence
- Stale entries (fixed bugs, reversed decisions) → get pruned during `/self-reflect`
- Cross-cutting patterns → may spawn new skills


## Lifecycle tooling

- `bun run --cwd web kb:health` — lifecycle report (used / helpful / promoted / stale / never-surfaced / idle); corrupt lines reported with `file:line`, exit 1.
- `bun run --cwd web kb:record -- <id>…` — called by `/prime` step 5; persists usage counters and the session clock in `.agents/knowledge/usage-state.json`.
- `bun run --cwd web kb:prune [--dry-run]` — moves entries idle for 20 consecutive sessions to `.agents/knowledge/archive/` (never deletes; promoted entries exempt).
