# Ritchie subplan — Phase 3β process lifecycle + FS persistence

**Council role:** Unix-discipline two-axes lens (§A Process lifecycle + §B Filesystem persistence) for the writer/validator pipeline + catalog filesystem surface
**Reference doc:** `~/.claude/skills/council-plan-aura-v2/references/quality-ritchie.md` (B1 mirror — canonical lives at dispatcher level per Phase 3α D4 / dec-008)
**Dispatched via:** `~/.claude/skills/_council-experts-v2/ritchie/plan-aura.md` substituted with Phase 3β brief

---

## §A Process lifecycle recommendations (verbatim)

### A1. Serialize writer-tmux access to `_ref-mirrors.lock` and `_phase2-coverage-tokens.yml` across the 5 writer sessions

- **Principle:** A2 (PID identity, never trust concurrent attachment) + A7 (resource lifecycle is visible or leaked), applied to writer-tmux-as-process model
- **AC defended:** AC3, AC4, AC8
- **What to get right:** Phase 3α empirics show 5 writer sessions across 14 commits — strictly serial. Phase 3β across ~22 commits × 4 sub-phases must preserve "exactly one writer-tmux holds editing rights at a time". HANDOFF artifact is the only handoff token between writer sessions; reader-validator-tmux must NEVER hold a write lock on canonical paths. Operationally: each writer session reads prior CLOSURE, confirms predecessor's tmux detached/terminated, opens own editing window. Reader-validator-tmux is read-only on skills repo and writer-side tree.
- **Risk if skipped:** Two writer-tmuxes concurrently appending to `_ref-mirrors.lock` produce interleaved YAML lines past PIPE_BUF (>4KB) → C12 sha256 mismatch → commit rejected mid-sub-phase with no atomic rollback story.

### A2. Validator-brief artifact must be written atomically and read only after writer signals completion

- **Principle:** A2 (grace period + identity confirmation) + A8 (recording subscriber attaches BEFORE first message)
- **AC defended:** AC7
- **What to get right:** `/tmp/phase-3-beta-NX-validator-brief.md` is the sole filesystem-mediated message between writer and reader. Two failure modes to prevent: (a) reader polls path while writer mid-`Write`-tool flushing brief — sees half-flushed body, returns false-FAIL; (b) reader processes brief from previous commit writer didn't overwrite atomically. Writer should produce brief via tmp-write + rename within `/tmp/` filesystem; brief's first line should carry commit-anchored sentinel (e.g. `# Validator brief — commit <sha-of-staged-tree-or-N3.XX-tag>`) so reader confirms identity before evaluating. Reader polls for sentinel presence, not file mtime.
- **Risk if skipped:** False-FAIL responses confuse writer into re-running a green commit, OR false-PASS from stale brief data lets a broken commit through.

### A3. Writer and validator share zero in-memory state — every handoff is a file

- **Principle:** A3 (signals are not messages) + Z external-source append-only logging
- **AC defended:** AC7, AC8
- **What to get right:** No shared env var, no shared Claude session continuity, no tmux send-keys cross-pane chatter bypassing filesystem. Two processes communicate exclusively through `/tmp/phase-3-beta-NX-validator-brief.md` (writer→reader) and reader's reply at `/tmp/phase-3-beta-NX-validator-reply.md` (reader→writer). Preserves replay determinism per pat-018 — Phase 3γ archaeologist can reconstruct entire decision trail from briefs alone. If state leaks via tmux scroll-buffer, durable record is incomplete.
- **Risk if skipped:** Phase 3γ cannot reconstruct why N3.17 was rejected vs N3.18 accepted; archaeology requires both sides of conversation as files.

---

## §B Filesystem persistence recommendations (verbatim)

### B1. Use atomic tmp+fsync+rename for every edit of `_ref-mirrors.lock`, `_phase2-coverage-tokens.yml`, and `conventions.md`

- **Principle:** B1 (atomic rename or it didn't happen) + B9 (same-filesystem tmp)
- **AC defended:** AC3, AC4, AC5, AC8
- **What to get right:** Each of these three files gets edited 8+ times across Phase 3β. Bare editor save during OOM kill or accidental SIGINT mid-flush leaves file truncated; next pre-commit `verify-catalog.sh C10/C12` fails. Mitigation isn't to change tooling — markdown/YAML edits via `Edit` and `Write` are already atomic — it's to enforce that writer treats post-edit `git diff` + `verify-catalog.sh` as durability gate. NEVER `git add` + `git commit` without re-running `verify-catalog.sh` between edit and commit.
- **Risk if skipped:** Truncated YAML lock manifest passes casual grep (one entry happens intact) but fails sha256 verification post-push; Phase 3γ inherits broken supply-chain canary.

### B2. Reject slug collisions and bound new `<id>` slugs against case-insensitive filesystems

- **Principle:** B6 (slug + path validation) + EC-24 council-experts-catalog discipline
- **AC defended:** AC1
- **What to get right:** Pre-create canary for each of 8 IDs: lerdorf, colvin, torvalds, unclebob, evans, hickey, majors, sridharan. (a) Confirm matches `^[a-z][a-z0-9-]{1,31}$` — all do. (b) Confirm none collide with existing 14 v2 or v1 catalog slugs when lowercased (case-insensitive on macOS HFS+/APFS). (c) Confirm none POSIX reserved. Canary runs once at sub-phase-1 PLAN-commit time, before any directory creation, fails loudly.
- **Risk if skipped:** Case-insensitive contributor cloning skills repo onto macOS HFS+ silently merges `Evans` with future `evans`; commit looks green on Linux CI, blows up on macOS.

### B3. Ship per-commit attestation as JSONL sidecar for Phase 3γ chair-side replay

- **Principle:** B4 (append-only JSONL with `\n` discipline) + B7 (replay determinism) + Z append-only logging
- **AC defended:** AC7 (plus forward-compat for Phase 3γ)
- **What to get right:** HANDOFFs are markdown by EC-32 convention and that stays. But validator-brief pipeline already produces 22 atomic (brief → validator → commit) tuples; if not captured machine-parseably, Phase 3γ chair-side dispatch must re-parse markdown. Author sidecar at `.council/plan-output/2026-05-18-phase-3-beta/commit-attestations.jsonl` containing one line per atomic commit: `{commit_sha, expert_id, brief_path, validator_pass_sha, ts_iso}`. Append-only, `\n`-terminated, no in-place edits. Durable evidence of EC-31 compliance per commit; survives prose drift. Validator brief is WHAT-was-asked; this file is WHAT-was-confirmed.
- **Risk if skipped:** Phase 3γ must scrape 22 markdown briefs to reconstruct attestation chain — text-stream interoperability lost.

### B4. Stamp `<!-- handoff-schema: v1 -->` marker on Phase 3β HANDOFFs

- **Principle:** B8 (JSON shape evolution)
- **AC defended:** AC6
- **What to get right:** Phase 3α HANDOFFs shipped without schema-version stamp. Phase 3β should NOT match legacy shape — introduce `<!-- handoff-schema: v1 -->` as first line below `# HANDOFF` H1 on all 5 Phase 3β HANDOFFs. Non-breaking for Phase 3α readers (HTML comment); signals intent for Phase 3γ. Phase 3γ can then ship v2 with mandatory fields declared as YAML frontmatter, migrate-or-reject gate. Marker is cheap insurance — costs one line, gives fixed point for archaeology.
- **Risk if skipped:** Phase 3γ HANDOFFs evolve with no detector for "old-shape or new-shape" → silent-default-on-load hits council.

### B5. Reconcile from filesystem on every sub-phase pickup, not from Claude memory

- **Principle:** B3 (sentinel rows applied to files) + EC-33 (runtime wins) + pat-018
- **AC defended:** AC6, AC8
- **What to get right:** Each new writer session at sub-phase pickup MUST run reconciliation pass before authoring: `ls ~/.claude/skills/_council-experts-v2/`, `wc -l _ref-mirrors.lock`, `git log --oneline` on skills repo since Phase 3α HEAD, `cat HANDOFF-phase-3-β-sub-(N-1)-CLOSURE.md`. Disagreement between HANDOFF prose and runtime → runtime wins per EC-33. FS-watcher-event-only-needs-init-scan idiom applied to multi-session work: inheritor cannot trust in-memory replay of predecessor's claims; must re-scan durable surface. HANDOFF's `commits[]` is predecessor's CLAIM; `git log` is truth.
- **Risk if skipped:** Sub-phase pickup that trusts HANDOFF prose missing a late-landed commit re-authors that work or conflicts with it.

### B6. Validator-brief and HANDOFF artifacts live under aura-repo working tree, not in the skills repo

- **Principle:** B6 (path-resolution before validation) + B9 (cross-filesystem rename) + v1-catalog-isolation invariant
- **AC defended:** AC1, AC8
- **What to get right:** Skills repo and aura repo are TWO distinct working trees on potentially distinct filesystems. Validator-briefs and per-commit attestation belong to aura repo's `.council/plan-output/.../` AND `/tmp/` scratch dir — NEVER under `~/.claude/skills/_council-experts-v2/` (gated by `verify-catalog.sh`, only accepts canonical artifacts). Any rename from `/tmp/` to either repo crosses filesystems if `/tmp` is tmpfs and `~/` is ext4 — copy+unlink, not atomic. Mitigation: keep `/tmp/phase-3-beta-NX-validator-brief.md` as scratch only; durable per-commit attestation written into aura repo working tree (same FS as git index) before commit lands.
- **Risk if skipped:** Validator-brief accidentally cp'd into `~/.claude/skills/_council-experts-v2/` trips non-allowlisted-path canary; OR attestation file written cross-FS left half-flushed when writer-tmux killed.

---

## Torvalds-tension framing

The Section F axis "Linux pragmatism ↔ Unix purity" is real and load-bearing — `quality-torvalds.md` must be authorable as a genuine counterweight, not stylistic variant.

**Where Ritchie (Unix purity) wins:**
- Atomic-rename discipline. tmp+fsync+rename is not negotiable; only POSIX-atomic durability primitive on local FS. Torvalds himself enforces this in kernel writeback paths. There is no Linux-pragmatic "good-enough alternative" — half-written state IS corruption.
- Composability-first interfaces. NDJSON wire format, JSONL recordings, append-only attestation — contract that lets `grep | awk | sort` compose across decades. Torvalds-pragmatism agrees here; `git` itself is built on this.
- Schema versioning. Ritchie wants `schemaVersion: 1` markers because file formats outlive code revisions. Torvalds wouldn't dispute this for stable interfaces (kernel ABI) but would push back on it for internal scratch files.

**Where Torvalds (Linux pragmatism) wins:**
- "Don't break userspace." Ritchie's principle B8 (version every schema) is correct in abstract but Torvalds points out: existing reader handling missing fields gracefully is BETTER than strict-version-gate reader rejecting v0 files. Backward-compat-by-tolerance beats backward-compat-by-version-stamping for files already in the wild. Ritchie's recommendation to stamp Phase 3β HANDOFFs with `<!-- handoff-schema: v1 -->` is correct; Torvalds extends with "v1 reader MUST treat absent-marker as v0, not malformed".
- "Show me the code." Ritchie traffics in principles; Torvalds demands concrete failing trace and minimal patch. For Phase 3β specifically: Ritchie's slug-collision canary is HYPOTHETICAL on case-insensitive FS — Torvalds demands either (a) reproduce on macOS or (b) drop to P3. Ritchie's recommendation correct as future-hardening; Torvalds-pragmatism would severity-cap.
- Pragmatism on `/tmp` semantics. Ritchie flags B9 (tmpfs wiped on reboot) but Torvalds says: for writer-validator scratch pipeline intentionally ephemeral within single editing session, tmpfs is RIGHT choice — durability non-goal, speed and isolation are goals. Force-fitting `~/.companion/` discipline onto `/tmp/phase-3-beta-*-validator-brief.md` is over-engineering for ephemeral artifacts.

**Where each lens fails:**
- Ritchie fails when abstraction layer is wrong. Atomic-rename guarantees rename is atomic; does NOT guarantee SEMANTICS of new file are correct. Perfectly-atomically-renamed `_ref-mirrors.lock` with wrong sha256 entries is still broken. Ritchie's lens covers FS layer; correctness above FS needs Fowler/Beck.
- Torvalds fails when failure-mode is rare-but-catastrophic. "Show me the code" rejects future-hardening for cases that haven't burned us yet — but case-sensitive vs case-insensitive FS collision IS a structural defect class, just dormant until first macOS contributor lands. Ritchie's epistemic-humility framing (B10 "know your gaps") is the right corrective.

**The authentic tension `quality-torvalds.md` must encode:** Ritchie defends invariants the kernel enforces (atomic-rename, fsync, path-realpath); Torvalds defends invariants the kernel allows you to skip when you've measured that skipping is safe. Both are Unix-discipline; they differ on where "discipline" ends and "ceremony" begins.
