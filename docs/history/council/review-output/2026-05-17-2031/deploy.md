# Deploy (Docker + GHA) Review — docs rebrand PR

Reviewer focus per context-brief: `bunx aura-companion` rename truth against `web/package.json` bin; cross-file internal consistency for the six domain files (`docs/get-started/installation.mdx`, `docs/reference/cli-and-api.mdx`, `docs/deploy/cloud-vm.mdx`, `docs/reference/troubleshooting.mdx`, `README.md`, `docs/docs.json`); npm publication smoke; `docs.json` schema + nav-pages-exist canary; Docker-image vs CLI-name disambiguation; supply-chain hygiene on external links; pre-commit gate friction; screenshot size budget.

## Verification summary (no finding required)

- `npm view aura-companion` → `1.4.0` published; `bunx aura-companion` resolves on a fresh host.
- `web/package.json` `bin` → exposes both `aura-companion` and `companion` (NOT `the-companion`); every user-facing CLI doc string under the six domain files now matches.
- Every nav `pages` entry in `docs/docs.json` resolves to an existing `.mdx` (index, get-started/installation, all 8 guides, deploy/cloud-vm, reference/cli-and-api, reference/council-mode-architecture, reference/troubleshooting — 14/14 OK).
- `docs.json` `$schema` `https://mintlify.com/docs.json` → 307 redirect to `https://www.mintlify.com/docs.json` → 200. Schema URL is live.
- Remaining `the-companion` matches outside scope: `docs/aura/upstream-sync.md` (not in `docs.json` nav, won't render on Mintlify), `docs/guides/docker-and-environments.mdx` (Docker image references — deliberately preserved per spec), `CLAUDE.md:116` (project-instructions file, not user-facing docs).
- No new screenshots added by this PR; existing four PNGs were already in `docs/screenshots/`.

---

## P1 findings

None.

The headline rename `bunx the-companion` → `bunx aura-companion` is correctly wired across all six domain files, the npm artefact is live at the documented name, the nav graph has no broken pages, and the schema URL resolves. No P1 deploy-grade defects.

---

## P2 findings

### P2-1 — Docker image vs CLI name disambiguation never stated explicitly to the reader

**File:** `docs/reference/troubleshooting.mdx:78` (and `docs/guides/docker-and-environments.mdx:71,93,103` — sibling file, out-of-scope for this PR but consumes the same convention)

**Severity:** P2

**Principle:** Pinned base image vs `:latest` discipline; reader-side affordance for "this string is intentional, not a missed-rename"

**Finding:** The troubleshooting entry `docker pull the-companion:latest` (line 78) sits in a file that otherwise uses `aura-companion` exclusively for CLI commands. A reader doing a casual scan for missed-renames will flag this as a bug ("you forgot one"). The PR deliberately preserved the Docker image name as a separate published artefact, but nothing in user-facing prose tells the reader this. The same string appears in `docs/guides/docker-and-environments.mdx` lines 71/93/103 (not in this PR's scope but reachable from the same nav).

**Consequence:** Issue tracker noise — every external contributor who notices the asymmetry files a "you missed `the-companion:latest` in troubleshooting" issue. Maintainer time burned on clarifying repeatedly.

**Fix:** Add one inline parenthetical at first appearance ("`the-companion:latest` — the Docker image name, separate from the `aura-companion` CLI package") in `docs/guides/docker-and-environments.mdx` Base image section. Troubleshooting can stay terse since the convention is established upstream of it.

### P2-2 — `--port` flag documented but not honoured on the foreground path

**File:** `docs/reference/cli-and-api.mdx:26-27, 31-32`; `docs/get-started/installation.mdx:56-58`

**Severity:** P2

**Principle:** Documented contract must match runtime behaviour (sibling of `feedback_call_site_presence_not_just_symbol_export.md`)

**Finding:** Both files document `aura-companion --port 8080` as an option for the foreground/default invocation. Per `web/bin/cli.ts` lines 83-90 the `--port` flag is parsed ONLY inside the `install` branch — the default-no-command path (lines 151-156) and `serve` branch (lines 52-56) just import `server/index.ts`, which reads port from `process.env.PORT` (`server/index.ts:57`), never argv. A user running `aura-companion --port 8080` will get the default port silently. Not introduced by this PR (pre-existing drift), but the docs touched in this PR carry the false claim forward.

**Consequence:** Silent misconfig — user expects port 8080, server binds 3456, browser fails to connect, support load.

**Fix:** Either (a) document `PORT=8080 aura-companion` in the foreground examples and reserve `--port` for `install`, or (b) extend `bin/cli.ts` to honour `--port` on the default + `serve` branches before importing `server/index.ts`. Pick one — current state contradicts itself.

### P2-3 — Husky pre-commit hook does not exist on git-worktree clones

**File:** `.husky/pre-commit` (referenced from `CLAUDE.md`; runs `cd web && bun run typecheck && bun run test -- --coverage && bun run build-observer-prompt-bundle && git diff --exit-code`)

**Severity:** P2

**Principle:** Husky-hooks-install-verification (matches `feedback_husky_hooks_install_verification.md`)

**Finding:** The husky pre-commit hook prescribed in `.husky/pre-commit` is not actually installed on this worktree — `.git/hooks/pre-commit` is absent because this is a git worktree (`.git` is a `gitdir:` pointer file to `/root/aura-companion/.git/worktrees/aura-companion-v1-test-4`). Husky's `prepare` script wires hooks at install time on the main repo, but worktree clones inherit nothing. A docs-only commit on a worktree therefore bypasses the gate silently — typecheck+test never runs. (Not a regression introduced by this PR; pre-existing structural issue. But this PR is docs-only and would benefit from the gate being honoured if it existed.)

**Consequence:** False sense of pre-commit safety. CI is the only enforcement floor; if a docs PR ships a YAML/MDX frontmatter break that the editor doesn't catch, it lands in main.

**Fix:** Document the worktree caveat in CLAUDE.md / contribution guide ("on git worktree clones, run `cd web && bun run typecheck && bun run test` manually before committing — husky does not auto-install"), or wire a top-level `make precommit` target that the worktree contributor can run.

### P2-4 — `bunx aura-companion` smoke-test not in the PR's gate path

**File:** any CI workflow under `.github/workflows/` (out-of-scope for the docs-only review but called out per context brief)

**Severity:** P2

**Principle:** "Does the published artefact actually run" — supply-chain canary

**Finding:** Per context-brief: "verify `npm view aura-companion` or note that the smoke-test is a follow-up". Manual verification shows `aura-companion@1.4.0` is published and `bunx aura-companion --help` would resolve. There is no automated post-publish smoke test in this PR that asserts a fresh-host `bunx aura-companion` succeeds. If the next `prepublishOnly` script change drops a file from `web/package.json:files`, the README/installation.mdx claim "Run without installing" silently breaks on fresh installs — type-check + test catch nothing here, because the published-artefact path is never exercised in CI.

**Consequence:** First-time users hit "Cannot find module" with no signal in the project's own CI. Sibling of `feedback_workspace_convention_file_needs_fallback_or_bootstrap.md` for the publish-artefact axis.

**Fix:** Follow-up PR — add a GHA job that, on tag push, runs `bunx aura-companion@<tag> --help` in a clean container and asserts exit 0. Out of scope for a docs PR, but flag it before next minor.

---

## P3 findings

### P3-1 — `council-mode-overview.png` size budget

**File:** `docs/screenshots/council-mode-overview.png` (680KB)

**Severity:** P3

**Principle:** Screenshot binary size budget on docs surface

**Finding:** Three of four screenshots are under 330KB; `council-mode-overview.png` is 680KB — roughly 2× the others. Not added by this PR (already on disk before the rebrand commits), but referenced from `README.md:29` (so it is fetched on every github.com README render) and from `docs/guides/council-mode.mdx`. Mintlify will gzip-transfer, but README on GitHub blob does not — every README pageview pulls the full 680KB.

**Consequence:** Slow first-paint on README for users with constrained connections; Lighthouse score on `docs.aura-companion.sh` (if/when deployed) dragged down.

**Fix:** Re-compress with `pngquant --quality=70-90` or convert to WebP fallback. Target ≤ 300KB. Out-of-scope deferral acceptable.

### P3-2 — `curl | sh` provisioning script unpinned on `cloud-vm.mdx`

**File:** `docs/deploy/cloud-vm.mdx:173, 178, 221, 261`

**Severity:** P3

**Principle:** Supply-chain hygiene; install-time integrity

**Finding:** The provisioning script and follow-on SSH-driven installs use unpinned `curl -fsSL ... | sh` for: Docker (`get.docker.com`), NodeSource setup script (`deb.nodesource.com/setup_22.x`), Bun (`bun.sh/install`), and Tailscale (`tailscale.com/install.sh`). The page does carry a `<Note>` block at lines 366-368 pointing to APT-with-GPG-verification alternatives for Docker / NodeSource / Tailscale — partial mitigation. Bun's installer is the one with no documented signature-verified path on this page.

**Consequence:** Each pipe trusts the TLS chain + DNS + the upstream maintainer's CDN integrity. Single-point compromise of any of those four CDNs propagates to every VM provisioned via this guide.

**Fix:** No-op for this PR (existing prose; the Note block is the convention). For a follow-up: append a Bun-specific verification line to the Note, e.g. "`curl -fsSL https://bun.sh/install | bash` — pin to a release tag with `BUN_INSTALL_VERSION=x.y.z` per Bun's install-script docs".

### P3-3 — `README.md:45` and `docs/get-started/installation.mdx:39` both claim `bun install -g aura-companion` works — no warning that `bun install -g` interacts oddly with PATH

**File:** `README.md:43-45`; `docs/get-started/installation.mdx:36-40`

**Severity:** P3

**Principle:** Match published-artefact ergonomics; first-run UX

**Finding:** `bun install -g aura-companion` works (npm publishes the right artefact, `web/package.json` has both `aura-companion` and `companion` bin entries). But `bun install -g` places binaries under `~/.bun/bin/`, and a fresh Bun install only adds that to PATH if the user re-sourced their shell rc — which the Bun installer prompts for but doesn't guarantee. README/installation.mdx don't mention the `~/.bun/bin` PATH dependency.

**Consequence:** Fresh user installs Bun, immediately runs `bun install -g aura-companion`, then runs `aura-companion` and hits "command not found". Confusion attributed to the rebrand even though it's a Bun PATH-bootstrap issue.

**Fix:** In `docs/get-started/installation.mdx` "Install globally" section (line 36-40), add a one-liner: "After install, ensure `~/.bun/bin` is on your PATH (`export PATH=$HOME/.bun/bin:$PATH` in your shell rc)." `cloud-vm.mdx:223` already does this correctly inline — bring the same line to the local-install path.

### P3-4 — `docs.json` schema URL works but pins to a moving target

**File:** `docs/docs.json:2`

**Severity:** P3

**Principle:** External-link pinning; supply-chain hygiene on docs schema

**Finding:** `$schema: https://mintlify.com/docs.json` resolves (307→200) but is not version-pinned. Mintlify can ship a schema-breaking change at any time and the editor's autocomplete + any local validator that fetches the schema will silently drift. Not unique to this PR; brought up because the PR touched this file and the line warrants future attention.

**Consequence:** Future-Mintlify schema break lands silently. Editor stops auto-completing valid keys, validator starts emitting false errors.

**Fix:** No action required — Mintlify hosts only the latest schema; there's no pinned-version URL convention from them. Track as a known external-dependency risk.
