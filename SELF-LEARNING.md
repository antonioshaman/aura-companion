# Self-Learning System Guide

Aura Companion includes a file-based knowledge system that gets smarter with every development session. This guide explains how it works and how to get the most out of it.

## Overview

The system has three layers:

```
┌─────────────────────────────────────────────┐
│  CLAUDE.md          Promoted rules          │  ← Permanent project wisdom
├─────────────────────────────────────────────┤
│  .agents/knowledge/ JSONL knowledge base    │  ← Growing session-by-session
├���────────────────────────────────────────────┤
│  5 skills           Learning loop           │  ← Capture → Store → Load → Apply
└───────��─────────────────────────────────────┘
```

Knowledge flows upward: insights captured during work accumulate in the knowledge base, and the best patterns eventually get promoted to CLAUDE.md rules.

## The Knowledge Base

Lives in `.agents/knowledge/` as 6 JSONL files:

### patterns.jsonl
Reusable approaches that work well. Example:
```json
{"id": "pat-001", "type": "pattern", "fact": "WebSocket bridge must handle both NDJSON and JSON-RPC protocols", "recommendation": "Always test protocol changes against both backends"}
```

### gotchas.jsonl
Surprising behaviors and tricky edge cases. These are the highest-value entries — they prevent you from stepping on the same rake twice.

### decisions.jsonl
Architectural choices and their rationale. When you (or a new contributor) wonder "why is it done this way?", the answer is here.

### anti-patterns.jsonl
Approaches that failed or caused problems. Explicit "don't do this" rules.

### codebase-facts.jsonl
Structural knowledge about the repository — what lives where, how things connect.

### api-behaviors.jsonl
Model, tool, and API quirks discovered through experience.

## Entry Format

Every entry follows this schema:

```json
{
  "id": "pat-001",
  "type": "pattern|gotcha|decision|anti-pattern|codebase-fact|api-behavior",
  "fact": "Core insight in one sentence (under 120 chars)",
  "recommendation": "What to DO about it — actionable guidance",
  "confidence": "high|medium|low",
  "provenance": [
    {"source": "human|agent|review|test-failure", "reference": "PR #X or file path"}
  ],
  "tags": ["websocket", "protocol", "testing"],
  "affectedFiles": ["web/server/ws-bridge.ts"],
  "createdAt": "2026-04-24T00:00:00Z"
}
```

**Confidence levels:**
- `high` — verified by tests, confirmed by user, or observed multiple times
- `medium` — observed once, seems reliable
- `low` — suspected but not yet confirmed

## The 5 Skills

### /prime — Load Knowledge Before Work

Run at session start or when switching context.

```
/prime websocket
/prime web/server/ws-bridge.ts
/prime               # auto-detects from branch name and modified files
```

What it does:
1. Determines your focus area (from args, branch, or git diff)
2. Filters knowledge entries by matching tags and affected files
3. Presents a compact brief: anti-patterns first, then gotchas, then patterns
4. Keeps it under 30 lines — it's a primer, not a data dump

### /learn — Quick Capture Mid-Session

Don't break your flow. Capture an insight instantly.

```
/learn the recorder auto-rotates at 1M lines
/learn don't use window.location for routing, use hash routing
/learn Zustand store must be session-scoped, never global
```

What it does:
1. Parses your insight and auto-classifies it (pattern, gotcha, anti-pattern, etc.)
2. Checks for duplicates — updates existing entries instead of creating new ones
3. Appends to the right JSONL file
4. Confirms in one line and lets you keep working

**Auto-learn triggers** (the skill suggests learning automatically when):
- A test fails for a non-obvious reason
- The user corrects the agent's approach
- An undocumented API behavior is discovered
- A code review reveals a missed pattern

### /self-reflect — End-of-Session Reflection

The most important skill. Run it when you're done with significant work.

```
/self-reflect
/self-reflect PR #42
/self-reflect session
```

What it does:
1. Reviews git log and diffs from the session
2. Identifies learnings across all 6 categories
3. Writes new entries and updates existing ones
4. Prunes stale entries (fixed bugs, reversed decisions)
5. Reports a summary of what was captured

### /evolve — Meta-Improvement

Run monthly or when the knowledge base exceeds 50 entries.

```
/evolve
/evolve promote     # only promote patterns to CLAUDE.md
/evolve prune       # only clean up stale entries
/evolve gaps        # only find knowledge gaps
```

What it does:
1. Audits knowledge base health (entry count, confidence distribution, coverage)
2. **Promotes** recurring high-confidence patterns to CLAUDE.md rules
3. **Prunes** stale entries (references deleted files, fixed bugs)
4. **Identifies gaps** (source files with no associated knowledge)
5. **Suggests new skills** based on repeated workflows

### /review-with-kb — Knowledge-Informed Code Review

Run before creating a PR.

```
/review-with-kb
/review-with-kb staged
/review-with-kb feat/new-feature
```

What it does:
1. Gets the diff (staged changes, branch diff, or PR diff)
2. Loads relevant knowledge entries for each changed file
3. Cross-references changes against:
   - Known anti-patterns (flags violations)
   - Known gotchas (surfaces warnings)
   - Architectural decisions (checks compliance)
   - Established patterns (suggests improvements)
4. Reports findings with KB entry references

## Workflow: Putting It All Together

### Daily Development

```
1. Start session
   └── /prime                    # What should I know before working?

2. Work on feature
   └── /learn <insight>          # Capture anything surprising as you go

3. Ready for review
   └── /review-with-kb           # Does this match what we know?

4. Done for the day
   └── /self-reflect             # What did we learn?
```

### Monthly Maintenance

```
/evolve all
```

This promotes mature patterns, cleans up stale knowledge, and identifies blind spots.

### Onboarding a New Contributor

```
/prime all    # Show everything we know about this project
```

The knowledge base acts as institutional memory — things the README doesn't cover.

## How It Gets Better Over Time

**Session 1-5**: Knowledge base is sparse. `/prime` returns little. `/learn` and `/self-reflect` are doing the heavy lifting — building up the initial corpus.

**Session 5-15**: Patterns start emerging. `/prime` becomes genuinely useful. Gotchas save you from real mistakes. The system starts paying for itself.

**Session 15-30**: `/evolve` promotes the first patterns to CLAUDE.md. The knowledge base starts influencing how the project is documented. New contributors benefit from accumulated wisdom.

**Session 30+**: The system is self-sustaining. Knowledge flows through the full cycle: capture → store → load → apply → reflect → evolve. Stale entries get pruned. The project has living documentation that grows with the codebase.

## Customizing for Your Project

### Starting Fresh

Delete the starter entries and begin accumulating your own:

```bash
# Clear starter knowledge
echo "" > .agents/knowledge/patterns.jsonl
echo "" > .agents/knowledge/gotchas.jsonl
echo "" > .agents/knowledge/decisions.jsonl
echo "" > .agents/knowledge/anti-patterns.jsonl
echo "" > .agents/knowledge/codebase-facts.jsonl
echo "" > .agents/knowledge/api-behaviors.jsonl
```

Then start coding. Use `/learn` and `/self-reflect` — the knowledge base will grow naturally.

### Adding Custom Categories

Create a new `.jsonl` file in `.agents/knowledge/` with a descriptive name. The skills will automatically pick it up. Update the `type` field in entries to match your category name.

### Writing Custom Skills

Add a `SKILL.md` file to `.agents/skills/<skill-name>/`. Follow the format of existing skills — YAML frontmatter with `name`, `description`, `user-invokable: true`, and markdown instructions.

## Philosophy

This system is inspired by:

- **[metaswarm](https://github.com/dsifry/metaswarm)** — self-reflect workflow and JSONL knowledge base format
- **[ChristopherA's seed prompt](https://gist.github.com/ChristopherA/fd2985551e765a86f4fbb24080263a2f)** — bootstrap approach to self-improving Claude Code
- **[Vibe-Companion](https://github.com/nikolaiklein/Vibe-Companion)** — the web UI foundation

The core idea: **files outlast sessions**. Claude Code doesn't persist memory between sessions, but files do. Every insight written to `.agents/knowledge/` survives and informs future work. The skills are just the machinery that makes capture and retrieval effortless.
