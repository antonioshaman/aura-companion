# `.learnings/` → knowledge base migration (P1/A1)

Step **P1/A1** of `specs/aura-meta-diet.md` ("one learning system"). Before it, the repo had
two competing learning stores: `.agents/knowledge/*.jsonl` (written by `/learn`,
`/self-reflect`) and `.learnings/*.md` (written by the `self-improvement` skill, nudged on
every prompt by an out-of-repo `UserPromptSubmit` hook). After it, `/learn` is the only
capture path and the KB the only store.

## Source

`.learnings/` was gitignored, so the only copy lived in the production checkout. It was
**copied read-only** (the prod checkout was not modified) and archived verbatim in
`docs/history/learnings/`, with two redactions for a public repo: the prod host IP, and the
file path + zone id of a Cloudflare credential. The redacted facts are operator-local and do
not belong in a public KB either.

| File | Entries |
|---|---|
| `LEARNINGS.md` | 1 (`LRN-20260605-001`) |
| `session-2026-06-10.md` | 3 sections |
| `session-2026-06-11.md` | 4 sections |
| `.agents/skills/self-improvement/.learnings/{LEARNINGS,ERRORS,FEATURE_REQUESTS}.md` (tracked, inside the skill) | 0 — header-only templates |

## Verdict per entry

Provenance on every migrated KB row: `{"source": "migration", "reference": "migrated-from:.learnings/<file>#<heading>", "date": <original date>}`.
Duplicates were checked against all six KB files by keyword and by reading the candidate rows.

| # | Source (`<file>#<heading>`) | Verdict | KB id / reason |
|---|---|---|---|
| 1 | `LEARNINGS.md#LRN-20260605-001` (N-factor verifier, partial anchor → `T \| null` degraded mode) | **Migrated** | `pat-032`. Related to `fact-007` (argv-token matching) but not covered by it. |
| 2 | `session-2026-06-10.md#OOM: vite build on prod box killed the live service` | **Migrated** (main lesson) | `anti-007` — never build on the prod box while the service cgroup is live. |
| 2a | ↳ "`KillMode=process` worked — children survived the restart" | Duplicate | Already a documented rule in `CLAUDE.md` → *Production deployment*, and `got-034` covers the cgroup side-effect. |
| 2b | ↳ "stats proxy is `/api/stats/global`, not `/stats/global`" | Duplicate | `got-027` and `fact-012` already name `/api/stats/global` as the proxy and the upstream Worker path separately. |
| 3 | `session-2026-06-10.md#Recovering a lost-source deployed site from the CF edge cache` | **Migrated** | `pat-033` (confidence medium — observed once). |
| 4 | `session-2026-06-10.md#www -> apex redirect on Cloudflare via API, no worker needed` | **Migrated** (technique) | `api-015`. |
| 4a | ↳ "Token note" (which credential file holds which CF scopes) + "credential hygiene" line | Discarded | Operator-local secret metadata; not appropriate in a public repo KB. Stays in the operator's private memory. |
| 5 | `session-2026-06-11.md#FIX-LATER: session create with non-existent project folder → misleading ENOENT` | **Migrated** | `got-055`. Re-verified on `diet/main`: `buildClaudeSpawnCommand` still passes `info.cwd` to `Bun.spawn` unchecked (old line refs 1204/1212 → now ~1643/1691), so the bug is still open. |
| 6 | `session-2026-06-11.md#DONE: PTY-terminal resource-reclamation plan fully implemented` | Discarded (status log) | A completion report, not reusable knowledge. Its durable facts are already in the KB (`fact-007` argv matcher, `fact-008` PTY reaper/sidecar) and in the code and tests themselves. |
| 7 | `session-2026-06-11.md#GOTCHA: argvSha256 writer/reader asymmetry via trailing-NUL empty token` | Duplicate | `got-017` (same root cause, same fix, same pinning test). |
| 8 | `session-2026-06-11.md#GOTCHA: god-module file-level coverage-gate cascade` | Duplicate | `got-018` (same remedy: exclude-list with justification). |

**Totals:** 11 items (8 top-level + 3 sub-lessons) → **5 migrated**, **4 duplicates**,
**2 discarded** with reasons. Nothing dropped without a line in this table.

## Skill removal

- Deleted `.agents/skills/self-improvement/` (SKILL.md, scripts, openclaw hook, templates).
  No symlinks pointed at it (`.claude/skills/` only links the impeccable design skills) and
  `skills-lock.json` never listed it.
- `web/server/canonical-sequence.ts`: the Council orchestrator sequence goes from 9 to 8 steps
  (`/self-improvement` removed; deep-equality test updated, no test case removed).
- Mentions removed from `README.md`, `CLAUDE.md` (intro line), both `landing-legacy` pages,
  and the canonical-sequence lists in three `specs/` and `.council/abtest/v2-bidir-plan.md`
  (each carries an "Amended … A1" note).

## Deliberately kept

- `.gitignore` still ignores `.learnings/` — the out-of-repo hook may keep writing there
  until the operator retires it; ignoring prevents an accidental commit.
- `web/scripts/marker-fs.ts` keeps `.learnings` in `SKIP_SUBDIRS`: it scans *user* projects,
  which may still contain such a directory. It is a skip rule, not a write instruction.
- `pat-006`: its provenance names the old `self-improvement` scripts as the incident —
  history, not an instruction.

## KB edits besides the new rows

- `pat-008` recommended a cross-project write-allow glob for `/root/*/.learnings/**`
  alongside auto-memory and the KB. That example was dropped (`updatedAt` bumped, provenance
  appended) — keeping it would still advertise `.learnings/` as a sanctioned write target.

## Outside the repo (not changed)

The global Claude Code settings still register `aura-self-improve-activator.sh`
(`UserPromptSubmit`), which `exec`s `/root/aura-companion/.agents/skills/self-improvement/scripts/activator.sh`.
Once this change reaches the prod checkout, that target disappears. The settings patch
is queued for the operator in the diet's ASK-FIRST list and was **not** applied.
