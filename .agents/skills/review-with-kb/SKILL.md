---
name: review-with-kb
description: Code review that cross-references changes against the knowledge base — catches known gotchas, validates compliance with recorded decisions, and flags anti-pattern violations.
user-invokable: true
args:
  - name: target
    description: Branch, PR number, or "staged" for staged changes (default is staged)
    required: false
---

Review code changes using accumulated project knowledge as a checklist.

## Process

### 1. Get the Diff

Based on the `target` argument:
- `staged` (default) → `git diff --cached`
- Branch name → `git diff main...<branch>`
- PR number → `gh pr diff <number>`

### 2. Load Relevant Knowledge

For each file in the diff:
1. Find all KB entries where `affectedFiles` includes this file
2. Find all KB entries where `tags` match the file's directory or feature area
3. Prioritize: anti-patterns first, then gotchas, then patterns

### 3. Cross-Reference Review

For each changed file, check against loaded knowledge:

**Anti-pattern violations:**
- Does any change match a known anti-pattern? Flag with 🔴
- Include the original KB entry's recommendation

**Gotcha awareness:**
- Are there known gotchas for this area? Flag with ⚠️
- Even if the change looks fine, surface the gotcha as a reminder

**Decision compliance:**
- Does the change respect recorded architectural decisions? Flag violations with 📐
- E.g., "Zustand state must be session-scoped" → check new state isn't global

**Pattern adherence:**
- Does the change follow established patterns? Suggest improvements with 🟢
- E.g., "Every component needs .test.tsx" → check if test was added

### 4. Standard Review (beyond KB)

Also check for:
- TypeScript type safety
- Error handling completeness
- Accessibility (for components)
- Test coverage
- Security concerns (XSS, injection)

### 5. Output

```
## KB-Informed Code Review

### Files Reviewed
- `path/to/file.ts` — N KB entries matched

### Findings

🔴 **Anti-pattern violation** in `file.ts:42`
> [What was found]
> KB: [original anti-pattern entry]
> Fix: [recommendation]

⚠️ **Known gotcha** for `area`
> [Gotcha description]
> Applies because: [why this change is affected]

📐 **Decision check** — [decision name]
> Status: ✅ Compliant / ❌ Violation
> [Details]

🟢 **Pattern suggestion** for `file.ts`
> [Established pattern that could improve this code]

### Summary
- Anti-pattern violations: N
- Gotcha warnings: N
- Decision compliance: N/N passed
- Pattern suggestions: N
- New learnings to capture: N (run /learn to save)
```

### 6. Capture New Learnings

If the review reveals something new (a gotcha not in the KB, a pattern worth recording):
- Suggest running `/learn` to capture it
- Or auto-capture if confidence is high
