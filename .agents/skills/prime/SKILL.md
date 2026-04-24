---
name: prime
description: Load relevant knowledge from the knowledge base before starting work. Filters by affected files, tags, or work type to avoid context bloat.
user-invokable: true
args:
  - name: focus
    description: What you're about to work on — file paths, feature names, or keywords to filter knowledge
    required: false
---

Load targeted knowledge from `.agents/knowledge/` to inform the current session.

## Process

### 1. Determine Focus Area

If the user provided a `focus` argument, use it. Otherwise, infer from:
- The current git branch name
- Recent git log (last 3-5 commits)
- Any files currently modified (git diff --name-only)

### 2. Load and Filter Knowledge

Read all `.jsonl` files in `.agents/knowledge/`:

```
.agents/knowledge/
├── patterns.jsonl
├── gotchas.jsonl
├── decisions.jsonl
├── anti-patterns.jsonl
├── codebase-facts.jsonl
└── api-behaviors.jsonl
```

For each entry, check relevance by matching:
- `tags` against the focus keywords
- `affectedFiles` against files being modified
- `type` against the work type (e.g., "bug fix" → prioritize gotchas + anti-patterns)

### 3. Prioritize by Relevance

Sort matched entries:
1. **High confidence + direct file match** → Always show
2. **High confidence + tag match** → Show if ≤10 results
3. **Medium confidence + file match** → Show if ≤15 results
4. **Everything else** → Skip (available via direct read if needed)

### 4. Present Knowledge Brief

Output a compact brief:

```
## Knowledge Brief: [focus area]

### Must-Know (directly relevant)
- 🔴 [anti-pattern or gotcha]: ...
- 🟢 [pattern]: ...

### Context (good to know)
- 📐 [decision]: ...
- 📦 [codebase-fact]: ...

### Caution
- ⚠️ [gotcha]: ...

---
*N entries loaded from knowledge base. Last reflection: [date]*
```

**Rules:**
- Keep the brief under 30 lines — this is a primer, not a dump
- Anti-patterns and gotchas come first — preventing mistakes is highest value
- If nothing matches, say so and suggest running `/self-reflect` after this session
- Never load ALL entries — that defeats the purpose

## Auto-Prime

When working on this project, automatically run a lightweight prime at session start:
1. Read the last 3 entries from each knowledge file (most recent)
2. If any are directly relevant to the current branch/task, mention them
3. Otherwise, stay silent — don't clutter the session with irrelevant knowledge
