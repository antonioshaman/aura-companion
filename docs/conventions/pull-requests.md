# Pull requests & Linear issues

> Moved out of `CLAUDE.md` in P2/A3 (2026-09-28). `CLAUDE.md` links here with one line;
> this file is loaded on demand, not on every session start.

## Pull Requests

When submitting a pull request:
- use commitizen to format the commit message and the PR title
- Add a screenshot of the changes in the PR description if it's a visual change
- Explain simply what the PR does and why it's needed
- Tell me if the code was reviewed by a human or simply generated directly by an AI. 
- The `Co-Authored-By` commit trailer MUST be version-less — use `Co-Authored-By: Claude <noreply@anthropic.com>`. Never append a model version (e.g. "Opus 4.7"): the harness default hardcodes a stale version that does not track the running model.

## Linear Issues

When creating or updating Linear issues:
- do not use commitizen-style titles in Linear
- use clear product-style titles that describe user value/outcome

### How To Open A PR With GitHub CLI

Use this flow from the repository root:

```bash
# 1) Create a branch
git checkout -b fix/short-description (commitizen)

# 2) Commit using commitizen format
git add <files>
git commit -m "fix(scope): short summary" (commitizen)

# 3) Push and set upstream
git push -u origin fix/short-description

# 4) Create PR (title should follow commitizen style)
gh pr create --base main --head fix/short-description --title "fix(scope): short summary"
```

For multi-line PR descriptions, prefer a body file to avoid shell quoting issues:

```bash
cat > /tmp/pr_body.md <<'EOF'
## Summary
- what changed

## Why
- why this is needed

## Testing
- what was run

## Review provenance
- Implemented by AI agent / Human
- Human review: yes/no
EOF

gh pr edit --body-file /tmp/pr_body.md
```

