# AuraBench corpus (P5/D1)

Real tasks mined from merged PRs, used by the D2 ablation.

1. `gh pr list --repo antonioshaman/aura-companion --state merged --base main --limit 300 --json number,title,body,mergeCommit > prs.json`
2. `bun run eval:aurabench mine --prs prs.json --out candidates.jsonl` — candidates + `candidates.jsonl.excluded.jsonl` (reason for every rejected PR).
3. `bun run eval:aurabench validate --candidates candidates.jsonl --results results.jsonl --wt-root <scratch>` — hidden tests must pass on the merge commit and fail on its parent. Resumable: PRs that already have a verdict are skipped.
4. Validated candidates become `tasks/*.yaml` (schema: `task.ts`, an additive extension of the golden-task schema; loader: `loader.ts`).

Run steps 1–3 outside the repo (scratch dir); only the final `tasks/` are committed.
