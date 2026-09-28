# Council Plan: β — Council Experts Catalog Refactor

**Scope:** Extract 4 dispatcher SKILL.md files' 52 inline subagent prompts (council-plan, council-plan-aura, council-review, council-review-aura) into a shared catalog at `~/.claude/skills/_council-experts/`. Replace inline blocks with named expert lists. First commit byte-identical at the prompt level.

**Boundaries:** No new experts. No content evolution. No runtime registry / plugin loader. AC-5.4 abandon if LOC reduction insufficient.

**Council dispatched:** Fowler (structure), Beck (verifiability), Hunt (security).

---

## Council Convergence

| Axis | Fowler | Beck | Hunt | Resolution |
|---|---|---|---|---|
| 1 — file format | **B** (single MD + frontmatter) | (silent) | (silent — but realpath-bound + ID-regex requirements) | **B with one subdir per expert** for cleaner allowlist + realpath bound |
| 2 — phase framing | 2a (generic + thin wrapper) | **2b** (per-phase files; renderer = `cat`) | (silent) | **2b** — Beck's verifiability case wins; the prompts vary substantially per phase, 2a renderer would need >5 LOC special-casing → AC-5.4 risk per Beck |
| 3 — stack overlay | Frontmatter `stack: common\|aura\|python` resolved at authorship | (silent) | Allowlist enum, no free-form | **Frontmatter enum + load-time validation** |
| 4 — backwards-compat | render-diff harness (4×13=52 cells) | `verify-panels.sh` + 3 grep canaries | MANIFEST.json with sha256 | **render-diff + grep canaries for v1; MANIFEST.json deferred to v2** |

**Net SKILL.md savings forecast:** ~1460 LOC removed across 4 dispatchers. Total SKILL.md after refactor estimate: ~1717 (vs 3177 baseline, 46% reduction).

---

## File layout (chosen)

```
~/.claude/skills/_council-experts/
├── .verify/
│   ├── before.json              # pre-refactor inline-block capture (committed once on refactor branch)
│   ├── verify-panels.sh         # diff harness + render comparison
│   └── render-panel.sh          # the renderer (literally `cat`)
├── .gitignore                   # excludes any *.token, *.env, id_*, .ssh/, credentials*
├── README.md                    # how the catalog works (1 page)
├── hunt/
│   ├── meta.yaml                # name + stack + panels metadata
│   ├── plan.md                  # for council-plan
│   ├── plan-aura.md             # for council-plan-aura
│   ├── review.md                # for council-review
│   ├── review-aura.md           # for council-review-aura
│   └── reference.md             # symlink-free copy of references/security.md
├── fowler/
│   └── ...
└── ... 13 expert dirs total
```

**File-count math:** 13 experts × {meta, plan, plan-aura, review, review-aura, reference} = 78 catalog files. Plus `.verify/`, `.gitignore`, `README.md`.

Not all experts have all 4 phase files — only the experts seated in each dispatcher. Aura-specific experts (subprocess, realtime-ndjson, persistence-fs, etc.) have only `plan-aura.md` + `review-aura.md`. Python-stack experts (postgres-brandur, telegram-ux, etc.) have only `plan.md` + `review.md`. Cross-stack experts (Hunt, Fowler, Beck, Willison, Saarinen, Friedman) have all 4.

---

## Hunt's 7 defences — prioritised

**Wire at first commit (load-bearing):**
- (2) **Strict ID regex** `^[a-z][a-z0-9-]{1,31}$` — applied wherever a consumer SKILL.md names an expert. Lives in the dispatch instructions block per consumer.
- (3) **realpath + bounds-check** — enforced by the Read tool's absolute-path requirement + the catalog dir is at a known absolute path. Doc the pattern.
- (5) **Frontmatter `stack` enum** — `common | aura | python` only. Pre-commit canary checks every `meta.yaml`.
- (6) **`.gitignore` audit** — explicit ignores for `*.env`, `*.token`, `*.key`, `id_*`, `.ssh/`, `credentials*.json`.
- (7) **Mode constraints** — `find _council-experts -type f -exec chmod 644 {} \;` on commit; canary asserts no executable bit.

**Defer to v2 (not load-bearing for first commit):**
- (1) Allowlist of expert IDs — current implementation via SKILL.md text + canary #2 from Beck handles this functionally.
- (4) MANIFEST.json with sha256 — committed catalog files in git already provide auditability via `git log`. Sign + hash adds complexity without v1 threat justification.

---

## Beck's verification — 3 grep canaries (literal patterns)

Will live as a single `verify-catalog.sh` script in `_council-experts/.verify/`:

```bash
# C1: no SKILL.md may inline a subagent prompt block
rg --type md -l '^### Subagent \d+:' ~/.claude/skills/council-*/SKILL.md
# Expected: zero matches.

# C2: every named expert in every consumer SKILL.md exists in the catalog
for skill in ~/.claude/skills/council-{plan,plan-aura,review,review-aura}/SKILL.md; do
  phase=$(basename $(dirname $skill))
  rg '^- \w' "$skill" --no-line-number | sed 's/^- //' | while read id; do
    test -f ~/.claude/skills/_council-experts/$id/$phase.md || echo "MISSING: $skill expert=$id phase=$phase"
  done
done

# C3: no orphan catalog entries
for dir in ~/.claude/skills/_council-experts/*/; do
  id=$(basename "$dir")
  [ "$id" = ".verify" ] && continue
  rg -q "^- $id$" ~/.claude/skills/council-*/SKILL.md || echo "ORPHAN: $id"
done
```

---

## Task Sequence

| # | Task | Domain | Depends on | Abandon-trigger |
|---|---|---|---|---|
| 1 | Create `_council-experts/` skeleton + `.verify/` + `.gitignore` + `README.md` | Fowler | — | — |
| 2 | **Pilot**: extract `council-review-aura`'s 13 inline blocks to catalog files. Convert SKILL.md to thin shape. | Fowler+Beck | 1 | If SKILL.md LOC drop < 200 → ABANDON whole refactor |
| 3 | Capture `before.json` from git HEAD~1 of all 4 dispatchers | Beck | 1 | — |
| 4 | Apply same extraction to `council-review`, `council-plan`, `council-plan-aura` | Fowler | 2 (pilot success) | If cumulative SKILL.md total ≥ 2900 → ABANDON per Fowler |
| 5 | Build + run `verify-panels.sh` — must exit 0 on 4×13 cells | Beck | 4 | If renderer needs > 5 LOC of logic → ABANDON per Beck |
| 6 | Add Hunt's defences 2/3/5/6/7 (regex, mode, .gitignore, stack enum canary) | Hunt | 5 | — |
| 7 | Update `conventions.md` (Aura repo) with new convention: "experts named, not inlined" | Fowler | 6 | — |
| 8 | Commit to `~/.claude/skills/.git` + push (if remote configured) | — | 7 | — |

---

## Risks & Watchpoints

- **Phase-variant cardinality**: 13 experts × 4 phase files = 52 catalog files in worst case. Many experts don't span all 4 phases (Aura-specific experts only appear in `plan-aura` + `review-aura`). Actual file count likely ~40.
- **Reference doc consolidation**: each consumer skill's `references/` dir currently has 3× duplicates per stack-variant per topic. The catalog's per-expert `reference.md` can be a single copy. References can stay in legacy `references/` for one cycle; consumers point at both, deprecate legacy in a follow-up.
- **Self-improvement embedded git**: already gitignored at baseline commit. Don't touch.
- **Aura repo coupling**: `conventions.md` lives in `/root/aura-companion/`, NOT in `~/.claude/skills/`. The catalog-location convention needs to land in both repos' docs, OR conventions.md says "see ~/.claude/skills/_council-experts/README.md as the canonical".

---

## Verdict

The refactor is feasible and pays for itself per Fowler's economic test (46% SKILL.md reduction). The Axis 2 disagreement (2a vs 2b) resolved in Beck's favour — verifiability dominates LOC purity when AC-3.2 (byte-identical) is a hard gate. Hunt's 5 first-commit defences are cheap; MANIFEST.json defers to v2.

**Pilot in Task 2 is the critical milestone.** If `council-review-aura/SKILL.md` doesn't drop ≥ 200 LOC after extraction, abandon the whole refactor per AC-5.4 — the duplication wasn't actually as big as forecast, and the spec's "no-op outcome is honored" clause activates.

**Estimated wallclock: 1-2 hours** for full Phase 1-8 execution. Each task is ≤30 minutes. The longest is Task 4 (extracting 39 remaining inline blocks across 3 SKILL.md files).
