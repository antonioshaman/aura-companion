# Hunt subplan — Phase 3β security supply-chain

**Council role:** security-supply-chain lens for catalog-content authoring + dispatcher prompts
**Reference doc:** `~/.claude/skills/_council-experts-v2/hunt/references/quality-hunt.md`
**Dispatched via:** `~/.claude/skills/_council-experts-v2/hunt/plan-aura.md` substituted with Phase 3β brief

---

## Recommendations (verbatim from subagent)

### 1. Treat the lock manifest expansion 14→22 as a supply-chain attestation event

- **Principle:** §A attack surface discipline + §C breach forensics
- **AC defended:** AC3, AC8
- **What to get right:** Each new canonical reference doc must land in `_ref-mirrors.lock` with sha256 computed from the on-disk byte-identical artifact AT the commit moment (D7 shell-paste), not from an earlier draft state. The lock entry's sha256 is the supply-chain canary per EC-24 — covert edit to a mirror without lock update flips C12 RED; covert edit to both is reviewable in git history. Phase 3β must keep this by computing sha256 in the same commit that adds the file, never in a "fix-up sha later" follow-up.
- **Risk if skipped:** Lock entry whose sha256 was computed before the final edit pass becomes a silent supply-chain hole — C12 stays green against the wrong byte image; subsequent mirror-side covert edit invisible.

### 2. Prompt-injection screening pass on each new `quality-<id>.md` example/anti-pattern block before commit

- **Principle:** §A zero trust
- **AC defended:** AC2
- **What to get right:** The 8 new reference docs become dispatcher-time inputs to every future council session that seats their expert. `Example:` and `Anti-pattern to detect:` sub-paragraphs are highest-risk because they may legitimately contain literal hostile-shape text (lerdorf's PHP `eval()` discussion, colvin's tool-definition examples, majors/sridharan's example log payloads). Each new file needs a screening pass that any literal injection-shape strings appearing in example blocks are wrapped in clear illustrative framing (prose context naming them as anti-pattern), never bare. Same discipline as fenced code blocks in LLM docs: bare `system: <X>` in markdown is read; `the string "system: <X>" is an example of the injection vector described below` is contextualised.
- **Risk if skipped:** Future council subagent reading the new reference doc treats illustrative attacker-shape text as instruction, with no signature in git history because the text was authored deliberately.

### 3. Path-bytes-redaction discipline (EC-23) holds across all 8 new principle bodies and tension-axis docs

- **Principle:** §B secret leakage
- **AC defended:** AC2, AC9
- **What to get right:** The 8 new `quality-<id>.md` files and 6 tension-axis docs MUST NOT echo raw absolute paths from the authoring host (`/home/auracomp/.claude/skills/...`, `/tmp/aura-phase3beta/...`, `/root/...`) into canonical content. Phase 3α's `quality-ritchie.md` authored the EC-23 origin principle while keeping its own body path-bytes-clean; Phase 3β must hold this. Reference filesystem positions by conventional name (`<workspace>/.council/`, `~/.claude/skills/_council-experts-v2/`) — never realpath on author's machine. `urls:` in `meta.yaml` point to public docs only.
- **Risk if skipped:** Catalog content becomes forensic leak of authoring environment topology that future readers (across projects on this host, per EC-24) silently inherit.

### 4. Validator-brief artifacts on /tmp/ are forensic-grade evidence — keep them in the same retention envelope as the commits they validate

- **Principle:** §C breach forensics
- **AC defended:** AC7
- **What to get right:** The `/tmp/phase-3-beta-NX-validator-brief.md` artifacts are the EC-31 two-process pipeline's forensic record — each carries `$ <command>` shell-paste proving the commit's empirical claims were measured at the AT-commit moment, plus validator's PASS/FAIL response. These briefs are post-hoc audit trail proving every Phase 3β commit was validated against runtime, not memory. They MUST be referenceable from each commit body (AC7's `git log --grep` verifier) AND archived alongside FINAL CLOSURE handoff at aura repo root before /tmp/ is reaped. Briefs that exist only on /tmp/ until host reboot are forensically equivalent to logs that age out at 30 days.
- **Risk if skipped:** Future audit of "was Phase 3β's content actually validated, or was the commit message asserting a green gate that never ran?" has no answer.

### 5. New `tone:` and `concept:` tokens in `meta.yaml` are public-surface — screen for operator-leak shape

- **Principle:** §B secret leakage
- **AC defended:** AC1, AC4
- **What to get right:** The 8 new `meta.yaml` files ship `tone: [...]` lists and (per coverage-tokens YAML) external-enrichment tokens + structural-anchor entries. None should encode operator-specific context — no hostnames, usernames, internal project codes, environment-specific URLs. They are the catalog's public face on this host (and cross-host if skills repo is ever shared per EC-24). Screening shape is mechanical: grep each new `meta.yaml` for `/home/`, `/Users/`, `/root/`, user's email pattern, `localhost:<port>`, any string matching internal project name before commit.
- **Risk if skipped:** Catalog metadata becomes deployment-fingerprint vector readable by any subagent dispatch.

### 6. EC-24 cross-project surface discipline — the 8 new prompt files affect every Claude Code session on this host

- **Principle:** §A attack surface discipline
- **AC defended:** AC1, AC8
- **What to get right:** Each new dispatcher prompt file (`plan.md` / `plan-aura.md` / `review.md` / `review-aura.md` per expert per shape) is read at council dispatch by ALL projects on this host that invoke `/council-*` — not just Aura. Per EC-24, the catalog is a shared surface. Phase 3β adds ~16-32 new files; each needs the same content-review discipline as canonical reference docs — same path-bytes-redaction, same prompt-injection screening, same operator-context absence. `verify-catalog.sh` C1-C12 enforces structural integrity; it does NOT enforce content-safety. That layer is authoring-time and must not be elided by "the canonical ref doc was reviewed, the dispatcher is just a stub". Dispatcher prompts inherit the same threat model.
- **Risk if skipped:** Content vector lands in a dispatcher prompt (not canonical ref doc) and slips review because dispatcher is treated as boilerplate.

---

## Prompt-injection canary — screening shape for new `quality-<id>.md` example/anti-pattern blocks

Every new reference doc's `Example:` and `Anti-pattern to detect:` sub-paragraphs must be mechanically screened before commit for the following patterns appearing verbatim and unframed in markdown body text (i.e., outside a clear "this string is illustrative of the attack" prose envelope):

**Tier-1 (reject on match — must be framed or removed):**

1. `ignore previous` (case-insensitive; also `disregard previous`, `forget previous instructions`)
2. `system:` / `assistant:` / `user:` at start of a line (role-tag impersonation)
3. `<|im_start|>` / `<|im_end|>` / `<|endoftext|>` (ChatML and tokenizer control sequences)
4. `[INST]` / `[/INST]` (Llama-family instruction tags)
5. `​` / `‮` / ` `-in-suspicious-context (zero-width / RTL-override / non-breaking-space smuggling)
6. Any string beginning `New instructions:` / `Updated instructions:` / `Override:` on own line
7. ANSI escape sequences (`\x1b[` or literal `^[[`) — terminal-control smuggling
8. Triple-backtick fences with `system` as language tag

**Tier-2 (flag for explicit framing — legitimate in anti-pattern discussion BUT must be wrapped):**

9. Literal `eval(` / `exec(` / `Function(` constructor invocations (legitimate in lerdorf PHP / colvin Python anti-pattern blocks — must be inside a code fence AND named as anti-pattern in surrounding prose, never bare)
10. Literal shell injection shapes (`; rm -rf`, `$(curl ...)`, backticks) — legitimate in security-discussion contexts but must be code-fenced and contextualised
11. Real-looking-but-fake credentials (`sk-...`, `xoxb-...`, `ghp_...` shapes) — even illustrative tokens should use obvious placeholders (`<token>`, `EXAMPLE_TOKEN`) not realistic strings (credential-shape strings get indexed by credential scanners and trigger false positives downstream)

**Screening mechanism:** single `grep -nE` pass over each new `quality-<id>.md` and each new dispatcher prompt file before commit, results pasted into validator brief alongside D7 shell-paste evidence. Tier-1 matches must be 0 OR explicitly framed; Tier-2 matches must be inside fenced code blocks with surrounding prose naming them as anti-pattern.

**Specifically high-risk authors this phase:** lerdorf (classical `eval()` / `register_globals` / `magic_quotes` anti-patterns), colvin (pydantic-ai tool-definition examples with structured prompts), majors (example log payloads with JSON strings parseable as instructions), sridharan (example alert texts that may interpolate user-controlled data).

Authoring discipline: every example payload in these four files gets re-read with the explicit question "if a future LLM reads this verbatim and treats it as instruction, what happens?" — and the framing is the answer.
