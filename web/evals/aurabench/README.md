# AuraBench corpus (P5/D1)

Real tasks mined from merged PRs, used by the D2 ablation.

1. `gh pr list --repo antonioshaman/aura-companion --state merged --base main --limit 300 --json number,title,body,mergeCommit > prs.json`
2. `bun run eval:aurabench mine --prs prs.json --out candidates.jsonl` — candidates + `candidates.jsonl.excluded.jsonl` (reason for every rejected PR).
3. `bun run eval:aurabench validate --candidates candidates.jsonl --results results.jsonl --wt-root <scratch>` — hidden tests must pass on the merge commit and fail on its parent. Resumable: PRs that already have a verdict are skipped.
4. Validated candidates become `tasks/*.yaml` (schema: `task.ts`, an additive extension of the golden-task schema; loader: `loader.ts`). Prompts describe the problem and observable contract, never the fix.
5. `bun run eval:aurabench leak --tasks evals/aurabench/tasks` — deterministic prompt check (`leak.ts`): every new identifier/file from the PR diff that the hidden tests reference must be named in the prompt (else the task is unpassable); any other new name is a leak. A second, independent LLM review against the real diff covers semantic hints and under-specification.

The committed corpus and every exclusion (with its reason) are listed in [`CORPUS.md`](CORPUS.md).

Run steps 1–3 outside the repo (scratch dir); only the final `tasks/` are committed.
