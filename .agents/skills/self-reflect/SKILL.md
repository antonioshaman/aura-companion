---
name: self-reflect
origin: aura
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

For each learning, append a JSONL entry. Field order matches `.agents/knowledge/README.md`:

```json
{
  "id": "<category-prefix>-<next-number>",
  "type": "<pattern|gotcha|decision|anti-pattern|codebase-fact|api-behavior>",
  "fact": "Core insight in one sentence",
  "recommendation": "How to apply this in future sessions",
  "confidence": "<high|medium|low>",
  "provenance": [{"source": "<human|agent|review|test-failure>", "reference": "PR #X or file path", "date": "<today>"}],
  "tags": ["relevant", "tags"],
  "affectedFiles": ["paths/that/this/applies/to"],
  "createdAt": "<ISO timestamp>",
  "updatedAt": "<ISO timestamp>",
  "usageCount": 0,
  "helpfulCount": 0,
  "outdatedReports": 0
}
```

**Rules:**
- Check for duplicates before writing — re-confirm existing entries (bump `helpfulCount`, set `updatedAt`) instead of creating new ones
- Use `high` confidence only for facts verified by tests or explicit user confirmation
- Keep `fact` under 120 characters — it's the headline
- `recommendation` should be actionable — what should an agent DO differently
- `tags` should match file paths or feature areas for filtering by `/prime`

### 3b. Cross-Project Propagation (Universal Learnings)

If a learning is **universal** — applies to any project Claude operates on, not just the current cwd — propagate it so future sessions in *other* projects inherit it.

**A learning is universal when it concerns:**
- Claude harness behavior (hooks, tool semantics, background-task hygiene, prompt context, memory rotation)
- Cross-project workflows (git/PR conventions used in all repos, deployment patterns shared across projects)
- Anti-patterns about Claude itself (prompt-injection risk, sycophancy, model quirks)
- Universal tooling rules (pytest/jest/bash quirks that recur)

**A learning is project-specific when it concerns:**
- A single codebase's architecture, names, configs, secrets, deploy scripts
- One team's conventions or one stakeholder's preference
- A bug or fix in particular source code

**How to propagate a universal learning:**

1. **Write the durable memory file** to the current project's memory dir (auto-memory rules apply): `/root/.claude/projects/<project>/memory/feedback_<slug>.md` with frontmatter `type: feedback`.
2. **Add a `universal: true` line** to the frontmatter so future operators can re-detect it.
3. **Copy the same file** into every other active project memory dir under `/root/.claude/projects/`:
   ```bash
   for d in /root/.claude/projects/-root*/memory; do
     [ "$d" != "$SOURCE_DIR" ] && cp "$SOURCE_FILE" "$d/"
   done
   ```
   Skip dirs that don't exist; do not create new project memory dirs that have no MEMORY.md yet.
4. **Update each project's `MEMORY.md`** with a one-line index entry under its Feedback section (or append if no section header exists). Keep the line under 150 chars.
5. **Mirror to Aura Companion's KB** at `/root/aura-companion/.agents/knowledge/` as a jsonl entry (gotcha/anti-pattern/pattern depending on character), so `/prime` surfaces it cross-project.
6. **Verify JSONL** integrity (`pat-004` validation) after appending.

**Do NOT propagate project-specific learnings** — they would pollute other projects' memory dirs. When in doubt, ask the user: «universal или project-specific?».

### 4. Prune Stale Entries

If you notice existing entries that are outdated (e.g., a gotcha that was fixed, a decision that was reversed):
- Bump `outdatedReports` by 1 and set `updatedAt` to now if you're not sure — let `/evolve` decide
- Remove the entry only when the staleness is unambiguous (referenced file gone, contradicted by a newer entry, or `outdatedReports` already exceeds `helpfulCount`)
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
