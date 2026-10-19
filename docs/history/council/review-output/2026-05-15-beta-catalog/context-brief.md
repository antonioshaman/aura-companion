## Context Brief for β Catalog Refactor Planning

**Spec:** `/root/aura-companion/specs/council-experts-catalog.md` (read it — this brief summarises but doesn't replace it).

### Pre-flight status (already done)

- `~/.claude/skills/` was NOT git-versioned (shared across 13+ sibling Claude projects).
- `git init` + baseline commit landed at `~/.claude/skills/.git` (143 files, .gitignore for embedded `self-improvement/` repo). Rollback path established per AC-5.4 abandon clause requirement.

### Baseline measurements (the BAR for AC-5.1)

```
SKILL.md LOC:
  council-implement/SKILL.md        190
  council-implement-aura/SKILL.md   263
  council-plan/SKILL.md             497
  council-plan-aura/SKILL.md        540
  council-review/SKILL.md           858
  council-review-aura/SKILL.md      829
  ──────────────────────────────────────
  TOTAL                            3177 lines
```

Reference dirs: 6 × ~6-13 reference files, with 3× exact-duplicate pattern per stack-variant (council-implement-aura/quality-backend.md === council-plan-aura/quality-backend.md === council-review-aura/quality-backend.md, distinct from the non-aura variants).

### What the refactor must achieve (AC-5.1, hard gate)

`TOTAL of (6 × SKILL.md)` after refactor MUST be **strictly less than 3177**. Counted excluding catalog files. If you cannot find a shape that reduces total SKILL.md LOC, the spec's AC-5.4 ABANDON clause kicks in — leave the inline shape in place.

### What's invariant at first commit

- 13-expert panel for each skill remains byte-identical (no expert added, removed, or content-changed in this commit).
- Each consumer skill's effective dispatch behaviour produces the same prompts to each expert subagent — same wording, same instructions.
- All 6 existing `/council-*` invocations work unchanged from a USER perspective.

### Decision axes (where I want your lens)

**Axis 1 — file format for the catalog.** Plain options:
- **A**: One directory per expert (`_council-experts/hunt/prompt.md` + `_council-experts/hunt/reference.md` + maybe `_council-experts/hunt/meta.yaml`).
- **B**: Single markdown file per expert with frontmatter (`_council-experts/hunt.md` carrying YAML frontmatter for stack-tag + panel-tags; reference embedded OR separately at `_council-experts/hunt.reference.md`).
- **C**: Hybrid — one dir per expert, one file inside.

**Axis 2 — phase-specific prompt framing.** The inline prompts in SKILL.md vary per consumer skill ("you are X advising on a feature that hasn't been built yet" in /council-plan vs "you are X reviewing code for vulnerabilities" in /council-review). Two options:
- **2a**: Catalog stores ONE generic per-expert prompt covering principles + lane. Each consumer SKILL.md owns a short per-phase wrapper sentence prepended at dispatch time. (Catalog smaller; consumer skills carry phase framing.)
- **2b**: Catalog stores THREE phase-variant prompts per expert (`hunt/plan.md` + `hunt/implement.md` + `hunt/review.md`). (Catalog larger; consumer skills become very thin lists.)

**Axis 3 — stack overlay tagging.** Per JS-5: expert is `stack: common | aura | python` in frontmatter. Aura skills dispatch `common + stack:aura`; non-aura skills dispatch `common + stack:python`. Verify this can be expressed without a runtime registry (per 🚫 No plugin loaders).

**Axis 4 — backwards-compat validation.** AC-3.2 says first commit must dispatch byte-identical 13-expert panels. How do we mechanically prove this — diff the rendered prompts? A canary script that compares pre-refactor inline prompts against post-refactor catalog+wrapper assembly?

### Stack disclosure

This is **NOT** Aura-stack work (no Bun, no Hono, no React). The work is editing markdown files under `~/.claude/skills/`. Aura-specific expert lenses (Realtime/NDJSON, React/Web UI, a11y, Saarinen, Friedman, Subprocess, Willison LLM, Backend-TS, Persistence, Deploy) are NOT seated. Tight panel:

- **Fowler** (refactoring/structure — primary) — Axes 1 + 2 + 4
- **Beck** (test quality) — Axis 4 mechanical verification + Axis 2 round-trip
- **Hunt** (security) — new lookup pattern; expert-name-injection attack surface; symbolic-link risk in the catalog dir

### Constraints (do NOT renegotiate in your recommendations)

- 🚫 No runtime registry / plugin loader / dynamic eval — catalog is files, consumers reference by name.
- 🚫 Adding any expert beyond existing 13 in the same PR.
- 🚫 Reshaping expert prompt content — first commit is byte-identical.
- 🚫 Move ALL inline prompts to catalog if result reads LESS clearly than current. Per AC-5.4 ABANDON if simplification can't be met.
- ✅ Update `conventions.md` to name the catalog location.

### What I want from you (3 subagents, parallel)

Each subagent: produce one ~600-word RECOMMENDATION naming
- Concrete choice on each relevant axis (A/B/C, 2a/2b, etc.)
- Reasoning anchored in the spec's AC + your reference doc principles
- ONE finding section per concern + ONE explicit "abandon-trigger" check at the end naming the specific signal that should cancel the refactor

NO code. Markdown only. Reference path locations only.
