---
name: evolve
description: Meta-skill that analyzes the knowledge base itself — promotes recurring patterns to CLAUDE.md rules, prunes stale entries, identifies knowledge gaps, and suggests new skills.
user-invokable: true
args:
  - name: mode
    description: "promote" (move KB entries to CLAUDE.md), "prune" (remove stale), "gaps" (find missing knowledge), or "all" (default)
    required: false
---

Analyze and evolve the knowledge base and project configuration. This is the meta-improvement loop.

## Process

### 1. Audit Knowledge Base Health

Read all `.agents/knowledge/*.jsonl` files and compute:

- **Total entries** per category
- **Confidence distribution** (how many high/medium/low)
- **Age distribution** (entries older than 30 days may be stale)
- **Tag coverage** (which areas of the codebase have knowledge, which don't)

### 2. Promote Recurring Patterns (mode: promote)

When a pattern appears 3+ times across sessions or has high confidence with broad impact:

1. Extract the core rule
2. Add it to the appropriate section in `CLAUDE.md`
3. Mark the KB entry as `promoted: true` (keep for history, but no longer surfaced by `/prime`)

**Example promotion:**
- KB entry: "Always test WebSocket changes against both NDJSON and JSON-RPC backends"
- → Becomes a bullet point in CLAUDE.md's Architecture section

### 3. Prune Stale Entries (mode: prune)

An entry is stale when:
- It references a file that no longer exists
- It describes a bug that's been fixed (check git log)
- Its recommendation contradicts a newer entry
- It has `confidence: low` and is older than 14 days without re-confirmation

**Actions:**
- Remove clearly stale entries
- Downgrade confidence on questionable entries
- Flag uncertain entries for human review

### 4. Identify Knowledge Gaps (mode: gaps)

Cross-reference:
- Files in `web/server/` and `web/src/` that have NO knowledge entries tagged to them
- Recent commits that touched areas with no KB coverage
- Test files without corresponding gotchas or patterns

Output a list of suggested areas to investigate.

### 5. Suggest New Skills

If the knowledge base reveals:
- A repeated workflow that takes multiple steps → suggest a new skill to automate it
- A category of gotchas around a specific tool/library → suggest a targeted skill
- A testing pattern used frequently → suggest codifying it as a skill

### 6. Report

```
## Evolution Report

### Knowledge Base Health
- Total entries: N (patterns: X, gotchas: Y, decisions: Z, ...)
- Confidence: H high, M medium, L low
- Coverage: N/M source files have associated knowledge

### Actions Taken
- Promoted N patterns to CLAUDE.md
- Pruned N stale entries
- Downgraded N entries to lower confidence

### Knowledge Gaps
- [area]: no entries covering [specific aspect]

### Suggested Skills
- [skill-name]: [why it would be useful]

*Next evolution recommended: [date]*
```

## When to Run

- After 5+ sessions of accumulated learning
- When the knowledge base exceeds 50 entries
- Monthly as maintenance
- When CLAUDE.md feels out of sync with actual development practices
