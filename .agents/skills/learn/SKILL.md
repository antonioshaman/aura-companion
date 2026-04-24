---
name: learn
description: Quick-capture a learning during a session without interrupting flow. Appends to the knowledge base immediately.
user-invokable: true
args:
  - name: insight
    description: What was learned — the agent classifies and stores it automatically
    required: true
---

Capture a learning right now, mid-session, without breaking flow.

## Process

### 1. Parse the Insight

From the user's input or the current context, determine:
- **Type**: Is this a pattern, gotcha, decision, anti-pattern, codebase-fact, or api-behavior?
- **Confidence**: Did we verify this (high), observe it (medium), or suspect it (low)?
- **Tags**: What files, features, or areas does this relate to?

### 2. Check for Duplicates

Read the target `.jsonl` file and check if a similar entry already exists:
- If yes → update the existing entry (bump confidence if re-confirmed, update recommendation)
- If no → append a new entry

### 3. Write Entry

Append to the appropriate file in `.agents/knowledge/`:

```json
{
  "id": "<type-prefix>-<next-number>",
  "type": "<detected-type>",
  "fact": "<concise insight>",
  "recommendation": "<what to do about it>",
  "confidence": "<detected-confidence>",
  "provenance": [{"source": "<human|agent|test-failure>", "reference": "<context>"}],
  "tags": ["<relevant>", "<tags>"],
  "affectedFiles": ["<paths>"],
  "createdAt": "<now ISO>"
}
```

### 4. Confirm

Output a one-liner:

```
📝 Learned: [fact] → saved to [category] (confidence: [level])
```

Then continue with whatever you were doing.

## Examples

User says: `/learn the recorder auto-rotates at 1M lines`
→ Saves as codebase-fact with tags `["recorder", "rotation"]`

User says: `/learn don't use window.location for routing, use hash routing`
→ Saves as anti-pattern with tags `["routing", "frontend"]`

Agent encounters unexpected behavior during work:
→ Auto-captures as gotcha with `source: "agent"`

## Auto-Learn Triggers

During normal work, automatically capture learnings when:
- A test fails for a non-obvious reason
- The user corrects your approach ("no, don't do it that way")
- You discover an undocumented API behavior
- A code review reveals a missed pattern
- You find something that contradicts an existing knowledge entry
