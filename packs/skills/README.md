# packs/skills — skills Aura ships

Laid out exactly like `~/.claude/skills`, so the catalog's own canaries run unchanged.

| Path | What | Source of truth |
|---|---|---|
| `_council-experts/` | Council experts catalog: per-expert phase prompts, `meta.yaml` capability profiles, `selection-engine.md`, and the `.verify/` canary gate | this repo (imported 2026-10-27 from the box's `~/.claude/skills` at commit `682463f`) |
| `council-{plan,review,implement}{,-aura}/` | the six Council dispatcher skills and their `references/` mirrors | this repo |
| `ui-ux-pro-max/`, `taste-skill/` | third-party skills vendored at a pinned commit | upstream; pinned in `vendor-lock.json`, attributed in `THIRD_PARTY_NOTICES.md` |
| `pack.json` | hand-maintained declaration of every top-level entry: kind, origin, Claude/Codex flag | this repo |
| `skills-manifest.json` | GENERATED: every entry with source, licence verdict, compat, ship gate, per-file sha256 | `bun scripts/skill-manifest.ts generate` |

## Checks

```bash
bash packs/skills/_council-experts/.verify/verify-catalog.sh   # catalog canaries (needs python3 + pyyaml)
cd web && bun scripts/vendored-skills.ts check                  # vendored files match their lock + approval
cd web && bun scripts/skill-manifest.ts check                   # skills-manifest.json is fresh; prints what is blocked and why
cd web && bun scripts/council-catalog-drift.ts                  # box ~/.claude/skills vs this tree (transition)
```

The mode canaries (C5, C12) expect files at 644. A checkout made under umask 002
gets group-write on every file (git records only 644/755); `verify-catalog.sh`
says so and prints the `chmod` that fixes it. Clone with umask 022.

The first two run in CI (`ci.yml` → `council-skills`); the drift check needs the box copy and runs there. The engine in `web/scripts/` reads the
catalog through `COUNCIL_CATALOG_DIR` / `COUNCIL_SKILLS_DIR` (`capability-catalog.ts`);
never hardcode the path.

## Editing

- **Any file here:** finish with `cd web && bun scripts/skill-manifest.ts generate`.
- **Catalog or dispatcher file:** edit here, then re-pin the attestation lock
  (`python3 _council-experts/.verify/verify-lock.py --update-attested`) and re-run
  `verify-catalog.sh` until it prints `PASS`. Mirrors are copied from their canonical
  with `.verify/cp-mirrors.py`, never edited by hand.
- **Vendored skill:** never edit in place. Re-vendor from a new upstream commit with
  `git archive`, set the new `upstream.commit`, run `bun scripts/vendored-skills.ts lock`
  (it resets the review to pending, and `check` fails until approved), read the
  upstream diff, then `bun scripts/vendored-skills.ts approve <skill> --basis
  human-read|ai-prereview --reviewer "<name>"`. The approval is bound to that commit
  and those bytes. The host inventories see only literal URLs; `runtimeCapabilities`
  records what scripts can do, and `knownIssues` what Phase B must resolve.

## Manifest, ship gate and ownership

Every top-level dir here must be declared in `pack.json`; `skills-manifest.json` is
generated from it, `vendor-lock.json` and the tree, and CI fails when it is stale.

- **Ship gate (fail closed).** A vendored skill ships only if `vendored-skills check`
  passes it (shippable licence, bytes match the lock, review approved for these
  bytes) and its `knownIssues` list is empty. First-party entries ship under the repo
  licence. A blocked entry stays in the manifest with `ship.reasons`, so the package
  build can say what it left out. Today `ui-ux-pro-max` is blocked by its
  `${CLAUDE_PLUGIN_ROOT}` known issue.
- **Ownership.** Wherever Aura places a copy, it writes `.aura-owned.json` with the
  exact file hashes it wrote. A copy is Aura's only while that marker parses and the
  bytes still match it; anything else (no marker, an edit, an added or removed file,
  a symlink) is the user's and is never overwritten or deleted. Rule and reader:
  `web/server/skill-manifest.ts`.
- **Names.** Lowercase slugs (plus `_council-experts`), compared case-insensitively
  against the user's skills on both the dir name and the SKILL.md `name:`; the
  user's skill always wins.
- **compat.** A `false` Claude/Codex flag carries a note. The council dispatchers are
  `codex: false` until they are run under Codex (they rely on the Task tool).

## Transition (until Phase B of `specs/uiux-agent-enrichment.md`)

Sessions on the operator box still load `~/.claude/skills`, not this tree; nothing
installs `packs/skills` into a user's home yet. Until Phase B does that, port any
box-side catalog edit here. `council-catalog-drift.ts` compares every file;
`back-compat.golden.test.ts` and `fingerprint.test.ts` fail on the box when the
profiles or vocabulary drift apart.

These guarantees hold only if CI blocks merges: `main` requires the `council-skills`,
`quality` and `test (ubuntu-latest)` checks.

## Packaging (npm tarball and Docker image)

- **What ships.** Only entries with `ship.status: "ship"`, and within them only the
  files `skills-manifest.json` lists. Dev-only files never ship, and the manifest does
  not hash them: `.verify/` canary scripts (except `capability-vocabulary.json`, which
  `selection-engine.md` reads), `evals/`, `tests/`, fixtures and `.gitignore`.
  The rule is `excludedReason()` in `web/scripts/skill-manifest.ts`. `generate` prints
  how many files each reason left out.
- **npm.** `prepack` stages the shipped set into `web/packs/skills/` (gitignored), with
  `skills-manifest.json`, `THIRD_PARTY_NOTICES.md` and the repo `LICENSE`. Every byte
  is checked against the manifest. `postpack` removes the staged dir. The server reads
  `<package>/packs/skills` (`defaultPackSource()`); `COMPANION_SKILL_PACK_SOURCE`
  overrides it.
- **Gate.** `bun scripts/skill-pack-build.ts gate <npm-pack.json>` fails closed if:
  - the package is over 15 MB packed;
  - a blocked or excluded file is packed, or a shipped file is missing;
  - a shipped entry's licence is not shippable;
  - the licence or notices file is missing;
  - there are dev-only trees anywhere in the package.

  It names every entry it left out, with the reason.
- **pack-smoke.** `bun scripts/pack-smoke.ts <tgz>` installs the tarball into a clean
  HOME and boots the installed server three times:
  - plain: `--plugin-dir` is in the spawn argv;
  - with a pre-seeded user skill of the same name: that skill is byte-identical
    afterwards and not exposed;
  - with the toolkit off: no `--plugin-dir`.
- **Docker.** The repo-root `Dockerfile` builds the server image from the npm
  tarball. The images are pinned by digest and the CLIs by version, and the image
  has python3 and node. `scripts/docker-smoke.sh` probes it.

CI job `package` runs the gate and pack-smoke; CI job `docker` builds and smokes the image.
