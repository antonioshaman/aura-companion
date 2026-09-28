# Aura Knowledge Base

Curated, machine-readable learnings that grow with every session. Read by `/prime` at session start, written by `/learn` mid-session, consolidated by `/self-reflect` at session end, and gardened by `/evolve` over time.

## Layout

```
.agents/knowledge/
├── README.md             # this file
├── patterns.jsonl        # reusable approaches that work well
├── gotchas.jsonl         # surprising behaviours, tricky edge cases
├── decisions.jsonl       # architectural choices with rationale
├── anti-patterns.jsonl   # approaches to avoid
├── codebase-facts.jsonl  # structural knowledge about the repo
├── api-behaviors.jsonl   # model / tool / API quirks
├── usage-state.json      # session clock: number of recorded /prime runs
└── archive/              # retired entries (same store names), never read by /prime
```

One JSON object per line. No comments inside JSONL files — keep all schema docs here.

## Entry schema

```json
{
  "id": "pat-001",
  "type": "pattern",
  "fact": "WebSocket bridge must handle both NDJSON and JSON-RPC",
  "recommendation": "Always test protocol changes against both backends",
  "confidence": "high",
  "provenance": [
    {"source": "codebase", "reference": "web/server/ws-bridge.ts", "date": "2026-04-24"}
  ],
  "tags": ["websocket", "protocol", "dual-backend"],
  "affectedFiles": ["web/server/ws-bridge.ts"],
  "createdAt": "2026-04-24T00:00:00Z",
  "updatedAt": "2026-04-24T00:00:00Z",
  "usageCount": 0,
  "helpfulCount": 0,
  "outdatedReports": 0
}
```

### Fields

| Field             | Required | Notes                                                                                          |
| ----------------- | -------- | ---------------------------------------------------------------------------------------------- |
| `id`              | yes      | Stable, human-readable. Convention: `<type-prefix>-<nnn>`                                      |
| `type`            | yes      | One of: `pattern`, `gotcha`, `decision`, `anti-pattern`, `codebase-fact`, `api-behavior`       |
| `fact`            | yes      | Headline insight, ≤120 chars                                                                   |
| `recommendation`  | yes      | Actionable: what an agent should DO differently next time                                      |
| `confidence`      | yes      | `high` / `medium` / `low` — see table below                                                    |
| `provenance`      | yes      | Array of `{source, reference, date?}` — where this knowledge came from                         |
| `tags`            | yes      | Free-form keywords used by `/prime` to filter by topic                                         |
| `affectedFiles`   | no       | Glob or path list — used by `/prime` to filter by current diff                                 |
| `createdAt`       | yes      | ISO 8601 UTC                                                                                   |
| `updatedAt`       | yes      | ISO 8601 UTC — bumped by `/learn` on re-confirmation, by `/self-reflect` on edits              |
| `usageCount`      | yes      | Times this entry was surfaced by `/prime`. Cheap relevance signal                              |
| `helpfulCount`    | yes      | Times the user/agent confirmed it helped. Bumped by `/learn` re-confirmation                   |
| `outdatedReports` | yes      | Times this entry was flagged stale. `/evolve` prunes when this exceeds re-confirmations        |
| `promoted`        | no       | `true` once `/evolve` promoted it into `CLAUDE.md`; kept for history, exempt from idle pruning |
| `lastSurfacedSession` | no   | Session number (from `usage-state.json`) of the last `/prime` that surfaced it. Set by `kb:record` |
| `lastSurfacedAt`  | no       | ISO time of that surfacing. Set by `kb:record`                                                  |
| `trackedSinceSession` | no   | Session at which idle tracking started for a never-surfaced entry. Set by `kb:record`           |
| `archivedAt` / `archiveReason` | archive only | Set by `kb:prune` when the row moves to `archive/`                         |

### Confidence levels

| Level    | When to use                                                          |
| -------- | -------------------------------------------------------------------- |
| `high`   | Verified by tests, explicit user confirmation, or multiple sources   |
| `medium` | Observed once with clear evidence                                    |
| `low`    | Inferred or suspected — needs confirmation before acting on it       |

## Lifecycle

1. **Session start** — `/prime` reads relevant entries, filtering by branch, modified files, and provided keywords. Surfaces a compact brief, not a dump.
2. **Mid-session** — `/learn <insight>` appends or re-confirms entries without breaking flow. Re-confirmation bumps `helpfulCount` and `updatedAt` instead of creating a duplicate.
3. **Session end** — `/self-reflect` consolidates new learnings, dedupes, and prunes obviously stale entries.
4. **Health & pruning** — mechanical, in `web/scripts/kb-health.ts`:
   - `bun run --cwd web kb:health` — total, used≥1, helpful≥1, promoted, stale, never-surfaced, idle, confidence distribution. Corrupt lines are reported as `file:line`, the rest is still counted, exit code 1.
   - `bun run --cwd web kb:record -- <ids>` — called by `/prime` once per run; bumps `usageCount` on surfaced ids and advances the session clock.
   - `bun run --cwd web kb:prune [--dry-run]` — entries not surfaced for 20 consecutive `/prime` sessions (`--threshold N`) move to `archive/<store>.jsonl` with a reason. Promoted and never-tracked entries are exempt. Nothing is deleted.
5. **Periodic** — `/evolve` audits health, promotes recurring patterns into `CLAUDE.md`, downgrades or removes entries with high `outdatedReports`, and surfaces coverage gaps.

## Conventions

- **Surgical edits.** When updating an entry, bump `updatedAt` and the relevant counter; never silently rewrite history.
- **No duplicates.** Before appending, search by tags + fact-substring. Prefer updating an existing row.
- **Headline first.** `fact` should be skimmable in `/prime` output without expanding `recommendation`.
- **Tag for filterability.** Tags drive `/prime`'s relevance filter — be specific (`websocket` is better than `backend`).
- **Provenance over prose.** A short reference to a PR, file, or commit is more useful than a long explanation.

## Attribution

The JSONL schema, file layout, and lifecycle vocabulary are adapted from [metaswarm](https://github.com/dsifry/metaswarm) (MIT). The skills (`/prime`, `/learn`, `/self-reflect`, `/evolve`) and entry contents are Aura-original.
