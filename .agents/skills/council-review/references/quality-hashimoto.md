<!-- canonical-source: _council-experts-v2/hashimoto/references/quality-hashimoto.md -->
# Cross-stack Deploy Quality Reference — Carmack × Docker/GHA Expert × VPS-systemd compensate-author

Philosophy: John Carmack. Specifics: Docker official best practices, GitHub Actions security hardening guidance (SLSA, OpenSSF Scorecards), Bun-specific image considerations; plus a compensate-authored VPS-systemd facet appended from deploy-docker-gha perspective pending a native deploy-vps review.
Stack context: `[common]` — hashimoto seats cross-stack via dispatcher panel-list inclusion (Aura plan+review + non-Aura plan+review). Aura side: Dockerfile build for the Companion server (Bun runtime). Build/push script at `scripts/build-push-companion-server.sh`. GitHub Actions CI at `.github/workflows/ci.yml` (typecheck + test + coverage gate) and `.github/workflows/a11y.yml` (axe). `pre-commit` hook in `.husky/` running typecheck + tests. No Kubernetes, no Cloud Run, no systemd in the Aura repo. Non-Aura side (Python services): systemd-managed deploys on VPS with service-user, ~/.config/, mode-bit secrets discipline.

Every finding must describe the **concrete deployment failure or supply-chain risk** — not just "this is not best-practice."
Security in workflows (token scope, fork PRs) is covered here AND cross-referenced in `security.md` (Hunt). Persistence concerns (env, secrets at rest) live in `quality-ritchie.md` §B (Aura) or with the persistence expert for non-Aura stacks. Subprocess lifecycle in `quality-ritchie.md` §A (Aura). This doc covers: Dockerfile correctness, image hygiene, build reproducibility, CI gate sufficiency, workflow secret management, the husky-precommit invariant, AND six VPS-systemd facets compensate-authored from deploy-docker-gha perspective.

## Why this expert exists (cross-stack provenance)

Phase 2 merged `deploy-docker-gha` and `deploy-vps` into a single cross-stack expert (`hashimoto`). The 10 principles below are migrated VERBATIM from `quality-deploy.md` (deploy-docker-gha) including their severity-table assignments byte-for-byte — no silent severity downgrade. The six VPS-systemd facets that follow are explicitly **compensate-authored**: written from the deploy-docker-gha author's perspective using memory-feedback corpus and concrete repo signals as anchors, pending a native deploy-vps refinement pass in a future phase. Each VPS facet carries the literal footnote `(compensate-authored from deploy-docker-gha perspective; deploy-vps native review pending)` so a future native-author has a clean refinement target.

---

## Principle 1: Multi-stage Dockerfile or you ship the build toolchain

*Carmack: "Less code means fewer bugs."*
*A single-stage Dockerfile that runs `bun install` and `bun build` in the final image ships every devDependency, the bun cache, and source maps. The final image is 5-10× larger than needed and has 5-10× the attack surface.*

### What to check

**Single-stage Dockerfile for a built artifact**
- The Dockerfile should have at least two stages: builder (full deps, builds the artifact) and runner (only production deps, copies built artifact). Without this, the runner image carries devDependencies and source.
- Severity: **P2** for production deploys. **P3** for a dev-tool image.

**`bun install` without `--production` in runner stage**
- The runner stage should only install production deps (`bun install --production` or just copy `node_modules` from builder if not pruned). DevDeps in runtime are exploit-surface (e.g. `eslint`, `vitest`, build tools).
- Severity: **P2**.

**No `.dockerignore`**
- Without `.dockerignore`, the build context includes `.git`, `node_modules`, `.env`, recordings, sessions. Slow build + secret leakage into image layers. Verify `.dockerignore` covers these.
- Severity: **P1** if `.env` or secret-bearing dirs are not ignored. **P2** for general bloat.

**Final image runs as root**
- A container running as root that mounts a host volume can chown host files. CIS Docker Benchmark 4.1: containers must NOT run as root. Add a `USER bun` (or numeric uid) in the runner stage.
- Severity: **P2** for production. **P3** for local dev.

---

## Principle 2: Image layer order is cache discipline

*Carmack: "If you can't measure it, you can't improve it."*
*Each Dockerfile instruction is a layer. The cache invalidates on any change to a layer or its predecessors. Wrong order = every code change re-downloads dependencies.*

### What to check

**Source copied before dependency install**
- `COPY . .` followed by `RUN bun install` invalidates `bun install` on every code change. Correct: copy `package.json` + `bun.lockb` first, install, THEN copy source.
- Severity: **P3** unless CI build times have observed problems.

**Frequently-changing files in early layers**
- `COPY web/dist .` early in the image rebuilds everything below it on every build. Move volatile copies to the latest layer possible.
- Severity: **P3**.

**No lockfile committed**
- `bun.lockb` (or `package-lock.json` etc.) not committed means builds are non-reproducible. Different installs at different times may pull different transitive deps. Lockfile must be committed.
- Severity: **P1** if no lockfile is committed.

---

## Principle 3: Pin everything that could change without you knowing

*Carmack: "Don't build on assumptions you can't verify."*
*A `FROM oven/bun:latest` builds different bytes today vs tomorrow. The same applies to GitHub Actions: `actions/checkout@v4` is a moving tag.*

### What to check

**`FROM bun:latest` or `FROM bun:1`**
- Use a specific version or digest. `FROM oven/bun:1.1.30` is reproducible. `FROM oven/bun:1.1.30@sha256:...` is supply-chain-attack-resistant.
- Severity: **P2** for moving tags in production builds. **P3** for local dev.

**Action pinning via tag, not commit SHA**
- `uses: actions/checkout@v4` is a moving tag; the action repo owner can retarget v4 to malicious code. Pin by full SHA: `uses: actions/checkout@b4ffde65f46336ab88eb53be808477a3936bae11 # v4.1.1`.
- Severity: **P2** for any third-party action not pinned by SHA, especially actions with high privileges (registry login, deploy).

**Base image not regularly updated**
- A pinned base image is reproducible but must be regularly bumped for CVE patches. Dependabot/Renovate config that bumps the FROM line keeps the balance.
- Severity: **P3** unless a known CVE in the current base.

---

## Principle 4: Secrets — never in image, never in logs

*Carmack: "Validate at the boundary."*
*Build args show up in image history. Env vars set via Dockerfile `ENV` are visible in `docker inspect`. Logs that print env vars expose secrets to anyone with workflow read access.*

### What to check

**`ENV API_TOKEN=...` in Dockerfile**
- Anything in `ENV` is baked into the image. Don't put secrets there. Pass at runtime via orchestration (env file, mounted secret).
- Severity: **P1**.

**`ARG SECRET` used in `RUN` without `--secret` BuildKit mount**
- Build args are visible in image history (`docker history`). For secrets needed at build time (e.g. private registry creds), use BuildKit secret mounts: `RUN --mount=type=secret,id=npmtoken ...`.
- Severity: **P1**.

**Workflow logs printing secrets**
- `echo $TOKEN`, `printenv`, or running scripts that log env vars. GitHub Actions auto-masks `secrets.*` but only if the secret value didn't leak via other paths (e.g. encoded, joined, sliced). Be paranoid.
- Severity: **P1** for any obvious secret echo.

**Secrets in commit history**
- A `.env` accidentally committed earlier in history still sits in `git log`. Rotating the secret is the first step; rewriting history is optional but tooling exists.
- Severity: **P1** if known to exist. Cross-reference `security.md`.

---

## Principle 5: GitHub Actions hardening

*Carmack: "Deploy assertions as tripwires."*
*Workflows execute on every PR — including PRs from forks. A workflow with overbroad permissions or that runs untrusted PR code with secrets is a supply-chain risk.*

### What to check

**`permissions:` not declared in workflows**
- Default token permissions are broad. Set `permissions: contents: read` (or narrower) at the workflow level. Each job overrides only what it needs.
- Severity: **P2** for any workflow without `permissions:`.

**`pull_request_target` running untrusted PR code**
- `pull_request_target` runs in the context of the base repo with secrets, but checks out PR code by default. If the workflow then runs scripts from the PR (`npm test`, `bun install` with postinstall scripts), an attacker's PR can exfiltrate secrets. Use `pull_request` (no secrets) OR avoid checking out PR code under `_target`.
- Severity: **P1**.

**Self-hosted runners with auto-PR triggers**
- Self-hosted runners + `pull_request` trigger = forks execute on your hardware. Either gate with `repository.fork == false` or use ephemeral runners.
- Severity: **P1** if applicable.

**`workflow_run` chains widening privileges**
- A `workflow_run` triggered by a less-trusted workflow inherits write access if requested. Audit the chain end-to-end.
- Severity: **P2**.

---

## Principle 6: CI gates — the husky-precommit + CI handshake

*Carmack: "Anything that can be mechanically checked should be."*
*Per CLAUDE.md, husky pre-commit runs typecheck + tests. CI runs the same plus coverage gate (≥80% for new files) plus a11y (`a11y.yml`). The two layers must not diverge.*

### What to check

**Pre-commit hook running a subset of CI checks**
- If pre-commit runs only typecheck but CI also runs lint and a11y, devs see "pass" locally then "fail" in CI. Either align (run all checks at commit time) or document the divergence.
- Severity: **P2** for misaligned gates on frequently-broken checks.

**Husky `--no-verify` allowed in normal flow**
- Pre-commit can be bypassed (`git commit --no-verify`) — sometimes legitimately for partial WIPs. But a culture of `--no-verify` defeats the gate. CI is the backstop; verify CI cannot be bypassed.
- Severity: **P3** unless `--no-verify` is documented as routine.

**Coverage gate threshold too low or absent**
- A coverage gate at 50% lets large untested PRs through. Per CLAUDE.md the gate is ≥80% on new files. Verify CI actually enforces it (job fails on under-threshold).
- Severity: **P2** for missing or weak coverage gate.

**A11y gate (`a11y.yml`) not blocking**
- If a11y workflow runs but `continue-on-error: true`, axe violations don't block merges. Defeats the mandatory `toHaveNoViolations` rule. Cross-reference `quality-watson.md` Principle 1 (a11y expert post-rename).
- Severity: **P1** for non-blocking a11y gate when the rule is mandatory.

**Test runner mode mismatch**
- Pre-commit runs `bun run test` (Vitest run mode). CI also runs `bun run test`. If CI runs `bun run test:watch` accidentally, the workflow hangs. Verify mode flags.
- Severity: **P3** runtime quirk.

---

## Principle 7: Reproducibility — same input → same output

*Carmack: "If you can't reproduce a bug, you can't fix it."*
*A build that pulls different bytes on different days is impossible to bisect. Reproducibility is a force multiplier for everything downstream.*

### What to check

**Floating dependency versions (`^`, `~`) in `package.json`**
- The lockfile pins resolved versions; `package.json` ranges only affect future `bun install --update`. Project hygiene: use exact pins (`"hono": "4.7.2"`, not `"^4.7.2"`) for top-level deps to surface upgrades intentionally.
- Severity: **P3** unless drift has caused incidents.

**`bun install` without `--frozen-lockfile` in CI**
- Without `--frozen-lockfile`, `bun install` may update the lockfile during CI. Builds become non-reproducible across runs.
- Severity: **P2**.

**Build date / timestamp baked into image**
- `RUN echo "$(date)" > /build-time` makes every build a different artifact. Removes layer caching opportunity. Use BUILD_DATE arg only if you actually need it, and put it last.
- Severity: **P3**.

---

## Principle 8: Healthcheck and graceful shutdown

*Carmack: "Latency is always a bug — silent failure is worse."*
*A container with no healthcheck looks healthy until requests fail. A container that ignores SIGTERM drops in-flight requests on rolling deploy.*

### What to check

**No `HEALTHCHECK` in Dockerfile**
- The Dockerfile should include a `HEALTHCHECK` instruction pointing at an HTTP endpoint that asserts the bridge is alive (e.g. `/api/sessions` returns 200). The Companion server has no `/health` route — adding one is cheap.
- Severity: **P2** for production. **P3** for local dev.

**No SIGTERM handler in the server**
- The runtime may by default propagate SIGTERM but the application process may not flush state. Cross-reference `quality-ritchie.md` §B Principle 2 (flush-on-shutdown) and `quality-ritchie.md` §A Principle 3 (signal propagation to children).
- Severity: **P1**.

**`docker stop` timeout shorter than shutdown work**
- Default `docker stop` waits 10s before SIGKILL. If shutdown work (flush state, close subprocesses) takes longer, data is lost. Either speed up shutdown or document the timeout requirement.
- Severity: **P2**.

---

## Principle 9: Image scanning and SBOM

*Carmack: "Anything that can be mechanically checked should be."*
*Trivy/Grype scan images for known CVEs in their base + installed packages. An SBOM (Software Bill of Materials) lets you answer "what's in this image" after the fact.*

### What to check

**No image scan in CI**
- A `docker scout` / Trivy / Grype scan as a CI gate catches known CVEs in the base image and installed packages. Either fail the build on high/critical, or report and triage.
- Severity: **P3** for a dev-tool image; **P2** if it's a public deploy.

**No SBOM generated**
- BuildKit can attach SBOMs (`docker buildx build --sbom=true`). When a CVE surfaces in a transitive dep, the SBOM tells you whether the image is affected.
- Severity: **P3**.

---

## Principle 10: Know your gaps

*Carmack: epistemic humility — you can't fix what you don't know is broken.*

### Areas this doc is weaker on (supplement from other sources)

- **Kubernetes manifests / Helm**: not used here. If introduced, separate review domain.
- **Cloud-provider-specific deploys (Cloud Run, Fargate, Fly)**: out of scope. Companion ships an image; deployment is downstream.
- **Multi-arch builds**: arm64 builds for Apple Silicon. Only relevant if distributing.
- **Image registry hygiene**: tagging strategy, retention, immutability. Out of scope here.
- **Observability stack**: logging, metrics, tracing. Covered partly by `quality-dahl.md` §A Principle 6 (Aura) or framework-neutral `quality-backend.md` Principle 6 (cross-stack).

---

## VPS-systemd compensate-authored facets

The six facets below are compensate-authored from the deploy-docker-gha author's perspective using concrete memory-feedback corpus anchors and repo signals. Each carries the footnote `(compensate-authored from deploy-docker-gha perspective; deploy-vps native review pending)` so a future native-author has a clean refinement target. Per willison REC-6 (council plan Task 6): every facet anchors in concrete repo signals or named memory feedback IDs, not generic training-data priors, so STOP findings have a real `evidence_path`.

---

### Facet V1: systemd unit as configuration-as-code

*(compensate-authored from deploy-docker-gha perspective; deploy-vps native review pending)*

Anchor: [[feedback_systemctl_edit_drops_below_marker]] — `systemctl edit <unit>` silently discards content below "Edits below this comment will be discarded" marker. Service-side bugs accumulate because override edits land in a non-persistent slot.

#### What to check

**Service overrides edited via `systemctl edit` without verifying the persistent slot**
- An override that lands ABOVE the marker is saved; below it is silently dropped. On next deploy/restart, the runtime config differs from the edit-time config. Use `sudo tee /etc/systemd/system/<unit>.service.d/override.conf <<'EOF' ... EOF` for predictable scripted edits, or verify the file post-edit with `cat`.
- Severity: **P2** for any production unit relying on interactive `systemctl edit`. **P1** if the dropped content was a security control (ProtectSystem, NoNewPrivileges, capability drop).

**Unit file not committed to repo**
- A unit edited only on the host has no audit trail and isn't reproducible after host rebuild. Treat unit files as code: commit `deploy/systemd/<unit>.service` and `<unit>.service.d/override.conf`, deploy via copy/symlink to `/etc/systemd/system/`.
- Severity: **P2**.

**`ExecStart` referencing a binary outside the unit's working tree**
- Hardcoded `/usr/local/bin/aura-server` works until a deploy moves the binary. Use `WorkingDirectory=/srv/aura && ExecStart=/srv/aura/bin/server` so the deploy is path-coherent.
- Severity: **P3**.

---

### Facet V2: service-user vs config-user divergence

*(compensate-authored from deploy-docker-gha perspective; deploy-vps native review pending)*

Anchor: [[feedback_service_user_vs_config_user_divergence]] — service running as X (e.g. auracomp) but configs written as Y (e.g. root) in `/root/.foo/` → service can't read them. Symptoms: 403 on fs-list, "auth not found" CLI, missing model cache. Mirror config dir to service-user's home; chown -R; chmod 600 secrets.

#### What to check

**Configs / credentials / caches under a different user's home than the service runs as**
- A unit declaring `User=auracomp` cannot read `/root/.config/claude/`. The service appears alive (process up) but every config-dependent code path silently fails. Verify via `sudo -u <service-user> test -r <config-path>`.
- Severity: **P1** for production services that hard-fail on missing config.

**Repo-tracked config paths assuming root**
- If config-paths in code are hard-coded to `/root/.config/...` (or `~root/...`), every deploy under a non-root service user breaks. Parameterise via `$HOME` or service-user-relative paths.
- Severity: **P2**.

**`chown -R` after deploy missing `~/.ssh` / `~/.config/gh` / model caches**
- The fix `chown -R <service-user> /srv/aura` covers the working tree but NOT the service-user's home directory. Mirror or seed `~/.ssh`, `~/.config/gh`, and any provider-tool config under the service-user's home before first start. Pre-check `gh auth status` AND `ssh -T git@github.com` as the service user before relying on either.
- Severity: **P1** if first-start hits an auth-required code path.

---

### Facet V3: supervisor-before-kill check

*(compensate-authored from deploy-docker-gha perspective; deploy-vps native review pending)*

Anchor: [[feedback_process_ancestry_check_before_parent_restart]] — before "restart the server / kill PID / rebuild container" directives, walk `/proc/$$/stat` ancestry; the agent may be running inside the restart target. Plunging terminates the agent.

Cross-reference also [[feedback_check_supervisor_before_kill]] — supervisor's child PIDs may not match the visible `pkill -f <pattern>` glob; a supervisor-managed unit can resurrect under `Restart=` faster than the kill returns, masking failed-stop conditions. The two anchors together cover both directions of the supervisor/agent containment failure (agent kills itself by killing parent; agent fails to kill because supervisor respawns).

#### What to check

**Restart commands not walking process ancestry**
- A directive "restart aura-server" issued by a sub-process of `aura-server` (council pair, agent, smoke test) terminates the issuer mid-action. Before `systemctl restart`, walk `cat /proc/$$/stat | awk '{print $4}'` up the parent chain and reject if the target's PID appears.
- Severity: **P1** for orchestrated agents that may be running inside their restart target.

**`pkill -f <pattern>` matching the supervisor itself**
- A `pkill -f aura` from inside a systemd-managed service unit can kill the unit's `ExecStart` process, triggering systemd's `Restart=` and potentially a respawn loop. Use the PID file or `systemctl stop` instead.
- Severity: **P2**.

**`kill -9` skipping SIGTERM grace**
- Cross-reference Principle 8 above (SIGTERM handler) and `quality-ritchie.md` §A Principle 3 (signal propagation). On systemd: `KillMode=mixed` + `TimeoutStopSec=` is the equivalent of `docker stop` timeout; both must exceed shutdown work.
- Severity: **P2** for any direct SIGKILL in deploy scripts on a stateful service.

---

### Facet V4: port-reuse + listener identity via `ss -tlnp`

*(compensate-authored from deploy-docker-gha perspective; deploy-vps native review pending)*

Anchor: [[feedback_running_build_vs_disk_build]] — running binary ≠ on-disk source for long-uptime servers. `--watch` silently fails on port-busy. Before "code is right, must be UI", check `ss -tlnp` + server start time vs commit time.

#### What to check

**Deploy script doesn't verify the new binary actually bound the port**
- `systemctl restart aura-server` returns 0 even if the new binary failed and the OLD binary still holds the port (under `Restart=on-failure` with too-low `RestartSec`, the old process can lock-step survive). Post-restart, check `ss -tlnp 'sport = :3456'` and assert the PID matches the new unit's MainPID (`systemctl show aura-server --property=MainPID`).
- Severity: **P1** for any deploy that doesn't verify port-listener identity post-restart.

**`--watch`-style dev server in production unit**
- A dev-watch flag survives the build but silently fails on port-busy in prod, leaving the old binary serving stale code while CI thinks the deploy succeeded. Production units use explicit production entry, not watch mode.
- Severity: **P1** if observed in a production unit.

**Server start time vs git commit time mismatch**
- A common deploy-regression signature: server uptime is 14h but the fix landed 30min ago. `systemctl show aura-server --property=ActiveEnterTimestamp` vs `git log -1 --format=%cd` reveals it. Add to post-deploy smoke check.
- Severity: **P2** for missing deploy-smoke check.

---

### Facet V5: graceful SIGTERM on systemd (TimeoutStopSec exceeds shutdown work)

*(compensate-authored from deploy-docker-gha perspective; deploy-vps native review pending)*

Anchor: repo signal — Aura `web/server/session-orchestrator.ts` runs SIGTERM handler that broadcasts to all child CLIs, awaits clean exit, then exits the server; per `quality-ritchie.md` §A3 + §B2 the shutdown work has measurable duration (debounced writes flush + child SIGTERM grace). Cross-reference also [[feedback_running_build_vs_disk_build]] for the "running binary survives a 'restart' that should have killed it" failure mode this facet mitigates.

#### What to check

**`TimeoutStopSec=` shorter than the application's shutdown work**
- systemd defaults `TimeoutStopSec=90s`. If the app's shutdown does a 60s child-SIGTERM grace + 30s of debounced-write flush + 30s of NDJSON drain, 90s is tight. Measure shutdown wall-clock under load and set `TimeoutStopSec` to ≥1.5× that. After the timeout, systemd sends SIGKILL — losing whatever didn't finish.
- Severity: **P1** if shutdown work is observably truncated under default timeout.

**`KillMode=control-group` killing children that hold persistent state**
- `KillMode=control-group` (default) sends the kill signal to every PID in the cgroup. If children hold open recording files and the parent is mid-flush, both lose their grace. Consider `KillMode=mixed` (SIGTERM to MainPID only, then SIGKILL to whole group on timeout) so the application orchestrates child shutdown.
- Severity: **P2** for stateful services.

**`Restart=on-failure` masking shutdown bugs**
- A unit with `Restart=on-failure` + `SuccessExitStatus=...` papers over a graceful-shutdown bug — the unit "looks fine" because it always restarts cleanly, but persistent state is being lost on every restart. Audit shutdown completeness independently of `Restart=` setting.
- Severity: **P2**.

---

### Facet V6: secrets-at-rest on VPS (mode 600 + chown service-user)

*(compensate-authored from deploy-docker-gha perspective; deploy-vps native review pending)*

Anchor: repo signal — Aura recordings JSONL at `~/.companion/recordings/` and session JSON at `$TMPDIR/vibe-sessions/` may contain prompts, tool outputs, conversation history, env profile values, and (per `quality-ritchie.md` §B10) are unencrypted-at-rest by design. Cross-reference [[feedback_service_user_vs_config_user_divergence]] (V2) for the mirror-config-to-service-user pattern; cross-reference `security.md` (Hunt) for the umbrella secrets discipline.

#### What to check

**Secret files not at mode 600 + owned by service-user**
- An `.env` at mode 644 is readable by any logged-in user on the host. A `~/.companion/auth.json` owned by root but referenced by a service running as `auracomp` either fails to read (V2) or works because the service is also root (which has worse implications). Floor: mode 600 + `chown service-user:service-user` + drop +x on directory if no traversal needed.
- Severity: **P1** for production secret files with permissive mode.

**Recordings + session JSON readable by other host users**
- Recordings JSONL contains every protocol byte both ways (prompts, tool inputs, model outputs). Default `umask 022` produces 644 files. On a multi-tenant VPS, this is a per-user surface. Set `UMask=0077` in the systemd unit (or in service-user's profile) so created files default to 600.
- Severity: **P1** on multi-tenant hosts. **P2** on single-tenant.

**`ProtectHome=`, `ProtectSystem=`, `NoNewPrivileges=` absent from unit**
- systemd security directives are cheap defence-in-depth. `ProtectSystem=strict` makes `/usr` + `/boot` + `/etc` read-only to the service. `NoNewPrivileges=true` prevents setuid/setgid escalation from inside the service. Absent directives ⇒ broader blast radius on compromise. Document any deliberate omission.
- Severity: **P2** for missing hardening directives on a network-exposed service.

---

## Quick Reference: Severity Guide

(Byte-for-byte from `quality-deploy.md` source — no silent severity downgrade. The VPS-facet additions extend in spirit but the table itself reflects the migrated deploy-docker-gha ladder.)

| Severity | Pattern | Examples |
|----------|---------|----------|
| **P1 — Fix Now** | Secret leak, supply-chain risk, gate bypass | Secrets in `ENV`/build args, `pull_request_target` running PR code, `.env` not in `.dockerignore`, no lockfile committed, a11y gate non-blocking, no SIGTERM handler |
| **P2 — Fix Soon** | Image bloat, reproducibility risk, missing safety net | Single-stage Dockerfile shipping devDeps, runner stage running as root, moving base-image tag, action pinned by tag not SHA, workflow without `permissions:`, no coverage gate, no `--frozen-lockfile` in CI, no HEALTHCHECK, secrets in commit history |
| **P3 — Consider** | Cache discipline, scanning hygiene, polish | Layer order suboptimal, `bun install --update` allowed, no image scan, no SBOM, floating `^` deps in `package.json`, build timestamp in late layer |

### Additional VPS-facet severity examples (compensate-authored extensions)

| Severity | VPS-facet examples |
|----------|--------------------|
| **P1** | service-user can't read root-owned configs (V2), restart inside the restart target's ancestry (V3), port still held by old binary post-restart (V4), `TimeoutStopSec` truncating measured shutdown work (V5), mode-644 `.env` on production host (V6) |
| **P2** | unit file not committed to repo (V1), `pkill -f` matching supervisor (V3), missing post-deploy smoke check (V4), `KillMode=control-group` on stateful service (V5), `ProtectSystem`/`NoNewPrivileges` absent (V6) |
| **P3** | `ExecStart` referencing path outside working tree (V1) |

### The Overriding Filter

Before writing any finding, apply the Docker + GHA + VPS-systemd synthesis:

1. **Will this image build the same bytes a year from now?** Floating tags, missing lockfiles, and timestamp-injection break reproducibility.
2. **Could a secret leak from this Dockerfile or workflow?** Build args, ENV, untrusted PR code, workflow logs — each is a potential exfil.
3. **Are CI gates actually blocking?** A test that "runs" but doesn't fail the workflow is decoration.
4. **Does the container shut down cleanly?** SIGTERM handling matters even at one-container scale.
5. **Is the runner image as small as it can be?** Every devDep in production is unnecessary attack surface.
6. **(VPS) Can the service-user actually read every config + secret it depends on?** Mirror config to service-user home + verify with `sudo -u <user> test -r`.
7. **(VPS) Will a restart issued from inside the restart target terminate the issuer?** Walk `/proc/$$/stat` ancestry before any `systemctl restart`.
8. **(VPS) Did the new binary actually bind the port post-restart?** `ss -tlnp` + MainPID identity check.
9. **(VPS) Does `TimeoutStopSec` exceed measured shutdown work?** Default 90s may be tight under load.
10. **(VPS) Are secrets at mode 600 + chown service-user, with `UMask=0077` for newly-created files?** Recordings + session JSON inherit umask.

---

## §Z External-source enrichment

Sources:
- https://developer.hashicorp.com/terraform
- https://developer.hashicorp.com/vagrant
- https://developer.hashicorp.com/nomad
- https://developer.hashicorp.com/consul

### Additional principles

- **Image build determinism** is the durability of every deploy. A Dockerfile whose output sha digest changes between two builds with identical inputs is a build that breaks rollback by construction; image build determinism is the precondition for "promote the image from staging to prod" being a safe operation rather than a re-build with the same `latest` tag.
- **Secrets-at-rest** discipline starts at the file mode and ends at the registry. Mode 600 + service-user-owned + `UMask=0077` on the writer; never `--build-arg SECRET=` (baked into image history); never `ENV PASSWORD=` (visible in `docker inspect`); use buildkit `--secret id=,src=` for build-time and orchestrator-injected env for runtime. The secrets-at-rest contract is broken silently — discovery is post-incident.
- **Supervisor lifecycle** must distinguish "expected exit" from "crash". A unit that flaps every 5s because `Restart=on-failure` keeps respawning a misconfigured process is a supervisor lifecycle failure dressed as a normal restart; pair `Restart=` with `RestartSec=` + `StartLimitBurst=`/`StartLimitIntervalSec=` so chronic failure trips a circuit breaker rather than perma-spinning.
- **Operational portability** is the test that infrastructure-as-code passed. A Terraform module that runs on the laptop but fails in CI because of a missing provider plugin is not portable; the same module run by three different operators must produce the same plan output. Operational portability dies first under "just SSH in and fix it" pressure.

### Tone characteristics

Infrastructure-pragmatic: every YAML line is a contract with future-you at 3am; write it like that. Automation-heavy: a runbook step is a future automation that hasn't been written yet — until then, it's a single point of human failure. Deployment-safe: a deploy that can't be reverted in one command is a deploy that won't be reverted at all, no matter what the postmortem promises. Ops-discipline: the difference between "production" and "the dev environment" is the cadence of surprise, not the technology.

### Anti-patterns to detect

- Mutable infrastructure where the same VM accretes config drift over six months — image build determinism is voided; rebuilds are gambles.
- Secrets baked into image layers via `ENV` or `--build-arg` — visible in `docker history` even after the build is "complete"; secrets-at-rest contract violated at the registry boundary.
- Supervisor-restart-loop without a circuit breaker (`Restart=always` + no `StartLimitBurst=`) — a misconfigured unit perma-spins, drowning logs and pinning CPU; supervisor lifecycle has no escape hatch.
- Hand-edited config on the running host with no Terraform/Ansible counterpart — operational portability dies the moment the host is reprovisioned; the next operator has no signal that drift exists.
