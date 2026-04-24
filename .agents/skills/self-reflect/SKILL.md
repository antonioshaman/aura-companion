---
name: self-reflect
description: End-of-session reflection that extracts learnings, patterns, gotchas, and decisions into the knowledge base. Run after completing significant work to make future sessions smarter.
user-invokable: true
args:
  - name: scope
    description: What to reflect on — a PR, feature, bug fix, or "session" for general reflection
    required: false
---

Analyze the work done in this session and extract valuable learnings into the knowledge base.

## Process

### 1. Gather Context

Review what happened in this session:

- **Read recent git log** to see what was committed
- **Check git diff** for uncommitted changes
- **Review any test failures** encountered during the session
- **Note any corrections** the user made to your approach

### 2. Identify Learnings

Extract insights across these categories:

| Category | File | What to capture |
|----------|------|----------------|
| **Patterns** | `.agents/knowledge/patterns.jsonl` | Reusable approaches that worked well |
| **Gotchas** | `.agents/knowledge/gotchas.jsonl` | Surprising behaviors, tricky edge cases |
| **Decisions** | `.agents/knowledge/decisions.jsonl` | Architectural choices and their rationale |
| **Anti-patterns** | `.agents/knowledge/anti-patterns.jsonl` | Approaches that failed or caused issues |
| **Codebase facts** | `.agents/knowledge/codebase-facts.jsonl` | New structural knowledge about the repo |
| **API behaviors** | `.agents/knowledge/api-behaviors.jsonl` | Model/tool/API quirks discovered |

### 3. Write Entries

For each learning, append a JSONL entry:

```json
{
  "id": "<category-prefix>-<next-number>",
  "type": "<pattern|gotcha|decision|anti-pattern|codebase-fact|api-behavior>",
  "fact": "Core insight in one sentence",
  "recommendation": "How to apply this in future sessions",
  "confidence": "<high|medium|low>",
  "provenance": [{"source": "<human|agent|review|test-failure>", "reference": "PR #X or file path"}],
  "tags": ["relevant", "tags"],
  "affectedFiles": ["paths/that/this/applies/to"],
  "createdAt": "<ISO timestamp>"
}
```

**Rules:**
- Check for duplicates before writing — update existing entries instead of creating new ones
- Use `high` confidence only for facts verified by tests or explicit user confirmation
- Keep `fact` under 120 characters — it's the headline
- `recommendation` should be actionable — what should an agent DO differently
- `tags` should match file paths or feature areas for filtering by `/prime`

### 4. Prune Stale Entries

If you notice existing entries that are outdated (e.g., a gotcha that was fixed, a decision that was reversed):
- Remove the stale entry
- Or update it with the new information and reset `confidence`

### 5. Report Summary

After reflecting, output a brief summary:

```
## Session Reflection

**Patterns captured:** N new, M updated
**Gotchas found:** N
**Decisions recorded:** N
**Anti-patterns noted:** N

### Key Insights
- [Most important learning]
- [Second most important]
```

## When to Trigger

- After completing a feature or significant bug fix
- After a code review (human or council)
- After encountering surprising behavior
- When the user says "we're done" or "let's wrap up"
- Proactively suggest running `/self-reflect` at natural session endpoints
