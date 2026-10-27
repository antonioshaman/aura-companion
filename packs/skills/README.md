# packs/skills — skills Aura ships

Laid out exactly like `~/.claude/skills`, so the catalog's own canaries run unchanged.

| Path | What | Source of truth |
|---|---|---|
| `_council-experts/` | Council experts catalog: per-expert phase prompts, `meta.yaml` capability profiles, `selection-engine.md`, and the `.verify/` canary gate | this repo (imported 2026-10-27 from the box's `~/.claude/skills` at commit `682463f`) |
| `council-{plan,review,implement}{,-aura}/` | the six Council dispatcher skills and their `references/` mirrors | this repo |
| `ui-ux-pro-max/`, `taste-skill/` | third-party skills vendored at a pinned commit | upstream; pinned in `vendor-lock.json`, attributed in `THIRD_PARTY_NOTICES.md` |

## Checks

```bash
bash packs/skills/_council-experts/.verify/verify-catalog.sh   # catalog canaries (needs python3 + pyyaml)
cd web && bun scripts/vendored-skills.ts check                  # vendored files match their lock
```

Both run in CI (`ci.yml` → `council-skills`). The engine in `web/scripts/` reads the
catalog through `COUNCIL_CATALOG_DIR` / `COUNCIL_SKILLS_DIR` (`capability-catalog.ts`);
never hardcode the path.

## Editing

- **Catalog or dispatcher file:** edit here, then re-pin the attestation lock
  (`python3 _council-experts/.verify/verify-lock.py --update-attested`) and re-run
  `verify-catalog.sh` until it prints `PASS`. Mirrors are copied from their canonical
  with `.verify/cp-mirrors.py`, never edited by hand.
- **Vendored skill:** never edit in place. Re-vendor from a new upstream commit with
  `git archive`, run `bun scripts/vendored-skills.ts lock`, and have a person review
  the upstream diff: the hash gate proves bytes, not intent.

## Transition (until Phase B of `specs/uiux-agent-enrichment.md`)

Sessions on the operator box still load `~/.claude/skills`, not this tree; nothing
installs `packs/skills` into a user's home yet. Until Phase B does that, port any
box-side catalog edit here — `back-compat.golden.test.ts` and `fingerprint.test.ts`
fail on the box when the two copies' profiles or vocabulary drift apart.
