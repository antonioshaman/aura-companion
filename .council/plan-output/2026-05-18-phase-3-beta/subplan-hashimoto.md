# Hashimoto subplan — Phase 3β DevOps cross-stack supply chain

**Council role:** DevOps cross-stack supply-chain lens (Docker + GHA + VPS systemd) — adapted to catalog-as-deployable-artifact
**Reference doc:** `~/.claude/skills/_council-experts-v2/hashimoto/references/quality-hashimoto.md`
**Dispatched via:** `~/.claude/skills/_council-experts-v2/hashimoto/plan-aura.md` substituted with Phase 3β brief

---

## Recommendations (verbatim from subagent)

### 1. Treat `_ref-mirrors.lock` as a supply-chain manifest — append in same atomic commit as canonical

- **Principle:** Principle 7 (Reproducibility) + Principle 3 (Pin everything that could change without you knowing)
- **AC defended:** AC3, AC8
- **What to get right:** Each of the 8 new `quality-<id>.md` canonicals MUST land in the same atomic commit as its `_ref-mirrors.lock` sha256 attestation entry — never a follow-up commit. Phase 3α explicitly rejected the split per D1; Phase 3β inherits that. The lock IS the catalog's `bun.lockb` equivalent: commit where canonical exists but lock doesn't yet pin it is a window where `verify-catalog.sh C12` is red and AC8 fails. Placement order follows Phase 3α's chronological-append-after-existing-entries pattern (NOT alphabetical re-sort) — re-sorting churns diff and obscures per-commit additive shape.
- **Risk if skipped:** Commit lands green-by-narrative but red-by-gate; AC8 violated mid-sub-phase; cascading re-bisect to find split point.

### 2. Run `verify-catalog.sh` as a fail-fast pre-commit gate at the writer-tmux, not only at HANDOFF time

- **Principle:** Principle 6 (CI gates — husky-precommit + CI handshake) + Principle 8 (Healthcheck — exit-code 0 from the gate IS the catalog's `/health`)
- **AC defended:** AC8, AC7
- **What to get right:** AC8 mandates C1-C12 + cp-mirrors --check green AT EVERY COMMIT. Only mechanical way to guarantee: invoke `verify-catalog.sh` from writer-tmux BEFORE `git commit` lands, not after — same handshake pattern as Aura's husky pre-commit running `typecheck && test`. Non-zero exit = hard stop; do not stash and retry. Validator-brief becomes post-commit smoke (re-run from clean working tree confirming reproducibility), not the only gate. Two-layer discipline mirrors husky-precommit + CI handshake from Principle 6.
- **Risk if skipped:** Drift between writer's belief and gate truth; AC8-violating commit reaches HANDOFF, forcing revert that breaks per-expert atomic-commit narrative.

### 3. Do NOT add a CI shim that runs `verify-catalog.sh` from Aura's GHA — keep EC-31 manual discipline as the gate

- **Principle:** Principle 10 (Know your gaps) + Principle 5 (GHA hardening — don't widen privilege surface)
- **AC defended:** AC8 (defended by NOT scope-creeping), out-of-scope-fence in brief
- **What to get right:** Skills repo lives outside Aura's workflow trust boundary; gates are at `~/.claude/skills/_council-experts-v2/.verify/` and operate on operator's local filesystem state. Wiring a CI shim that clones/symlinks skills repo into Aura's GHA would require granting workflow permissions over a developer's personal `~/.claude/` tree, drag a second `permissions:` block into review, and break Phase 3α empirical pattern of "EC-31 writer+validator hit 14 zero-drift commits manually". HANDOFF-time canary (validator-brief carrying shell-paste of C1-C12 invocation per D7) is the right enforcement layer.
- **Risk if skipped:** Phase 3β scope-creeps into CI workflow PR, attack-surface review pulls in hunt scope, sub-phase token budget blows past EC-30.

### 4. Ship a side-note in `conventions.md` (EC-34/EC-35 amendment) acknowledging NR1 cp-mirrors.py TARGET_ALLOWLIST refactor remains deferred to Phase 3-C

- **Principle:** Principle 7 (Reproducibility) + Principle 10 (Know your gaps) — analog of NOT bumping a transitive dep you know is stale
- **AC defended:** AC5, AC8
- **What to get right:** D1 holds manual cp for new B2 entries because `cp-mirrors.py`'s TARGET_ALLOWLIST blocks new seed-new entries (NR1). Phase 3β grows B2 by 8 expert dirs under that same manual discipline. The conventions.md amendment should carry one-line footnote near EC-34/EC-35: "NR1 cp-mirrors.py TARGET_ALLOWLIST refactor remains deferred to Phase 3-C; Phase 3β honors D1 manual cp." Catalog's equivalent of pinning `package.json` to exact version while documenting "we know we're stale on transitive X". Without footnote, next operator sees C12 green and assumes `cp-mirrors.py` is source of truth — it isn't yet.
- **Risk if skipped:** Phase 3-C author inherits "fix cp-mirrors automation" task with no in-repo trail of why deferred; convention-floor drift between conventions.md and runtime gates.

### 5. Author `quality-majors.md` with native observability lens — do NOT compensate-author from hashimoto perspective

- **Principle:** Principle 10 (Know your gaps — epistemic humility about cross-stack provenance) + Facet V5 cross-reference posture
- **AC defended:** AC2, AC9
- **What to get right:** `quality-hashimoto.md`'s 6 VPS facets are explicitly compensate-authored from deploy-docker-gha author's perspective pending native deploy-vps refinement — that pattern is the right move when no native author exists. For `quality-majors.md`, a native observability-SRE-Google-practice author DOES exist as a conceptual stance (Charity Majors' published corpus). Phase 3β writer should NOT pre-frame majors' principles through hashimoto's immutable-prevention lens — that erases the genuine tension Section F requires. If future native-observability author pass is anticipated, same compensate-author footnote pattern can be reused per-facet — but BASELINE authoring stance for `quality-majors.md` should be debugging-in-prod-first, not prevention-first wearing observability clothing.
- **Risk if skipped:** EC-34 lands with tension-pair table whose `hashimoto ↔ majors` row is fake-orthogonal — both docs say "immutable infra catches things early" and council loses genuine axis of disagreement.

---

## Hashimoto ↔ majors paired-tension framing

The tension is real and load-bearing for EC-34. Crisp split:

**Hashimoto (immutable-prevention / IaC / supply-chain-pinning) wins where:**
- Cost of a deploy failure is asymmetric — rollback is cheap, forward-fix is catastrophic. Banking, payments, compliance-bound systems. You want the badness to be impossible by construction.
- Reproducibility is precondition for trust. A build whose bytes vary day-over-day cannot be promoted from staging to prod; you're shipping different artifact than you tested. Image digest pinning, lockfile-committed, action-pinned-by-SHA, `FROM` digest-pinned — all say "I refuse to operate on inputs I cannot re-derive."
- Multi-operator environments where difference between "production" and "the dev environment" is the cadence of surprise, not the technology. Three operators must produce same plan output from same Terraform module, or operational portability is dead.
- Secrets-at-rest discipline: mode 600, `UMask=0077`, never `--build-arg SECRET=`, never `ENV PASSWORD=`. Contract broken silently and discovered post-incident; prevention is the only honest answer.

**Hashimoto fails where:**
- System is too novel for prevention to enumerate failure modes. You haven't seen the bug yet; pinning everything pins your ignorance into the artifact.
- Cost of prevention exceeds cost of recovery. Spending 6 weeks hardening a 30-day-experiment service is mis-priced.
- Static analysis can only assert what you already thought to assert. Unknown-unknowns slip past every gate.

**Majors (debugging-in-prod / observability-first / wide-events) wins where:**
- System has emergent behavior no pre-deploy gate could catch. Distributed traces, cardinality-explosion bugs, retry-storms, slow-path tail latency — reveal themselves only under production load with production traffic shapes.
- Unknown-unknown surface is dominant risk. You cannot pin against CVE that does not yet have CVE number; you can only observe its symptom and respond.
- Mean-time-to-recovery dominates mean-time-between-failures. If detect-and-fix in 3 minutes, weeks of immutable-infra hardening chasing same incident is mis-priced.
- Org small enough that same person codes and on-calls. "Debugging in prod" is not negligence; it is the feedback loop closing on the author.

**Majors fails where:**
- Observability becomes substitute for engineering rigor. "We'll catch it in honeycomb" is not a deploy discipline; it is a license to ship sloppily and hope.
- Failure mode is destructive on first occurrence. You cannot debug-in-prod a `DROP TABLE` because there is no surviving prod to debug.
- The observability stack itself is the SPOF and has zero prevention layered under it.

**Where they agree (do not let the writer collapse this):** Both reject "test-environment-as-proxy-for-prod" theatre. Hashimoto rejects because test env is not byte-identical; majors rejects because test env has no production traffic shape. Same disease, opposite cures.

**The EC-34 codification value:** A council that seats only hashimoto misses tail-latency cardinality bugs. A council that seats only majors ships secrets in image history. Both seats are non-redundant; that is the structural argument for EC-34 "balance for tension, not stack for coverage."
