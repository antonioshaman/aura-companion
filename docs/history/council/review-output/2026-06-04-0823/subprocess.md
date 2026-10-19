# Subprocess Lifecycle Review — PR #91 `feat/dynamic-claude-models`

**Scope:** `web/server/anthropic-models-cache.ts` only. PR introduces no subprocess
changes — concern is the indirect coupling: `BackendModelInfo.value` returned
from the cache becomes the user's `model` selection and ultimately
`--model <id>` argv at the existing `cli-launcher.ts` spawn site.

**Verdict: PASS.** No P1, no P2. Two P3 hardening notes below. Hold-the-line
items from PLAN-aura-dynamic-model-list.md Risks & Watchpoints (Subprocess R1)
were honoured cleanly in implementation.

---

## Hold-the-line verification (PLAN Subprocess R1 + companion guarantees)

**No probe-spawn introduced.** Grepped the file for
`spawn|exec|Bun\.spawn|child_process|--list-models|--version|--help` — the only
matches are:
- Line 39-42: the negative-space header explicitly forbids `claude --list-models`
  and articulates *why* (no PID registry / no idle-kill / no stdio drain). The
  prohibition is documented at the module's discoverability surface, not buried.
- Line 422: a `regex.exec(id)` call — JavaScript regex method, not process exec.

No `import` from `child_process`, no `Bun.spawn`, no fork, no worker_thread. The
"upstream Anthropic decides model validity; CLI spawn-time rejection is the only
runtime check" contract from the plan is preserved structurally. The module's
only external I/O is one HTTPS GET to `api.anthropic.com/v1/models` and
`readFileSync` / `writeAtomicJson` against `~/.companion/anthropic_models_cache.json`.

**No new spawn site.** The new file owns: HTTPS fetch, in-memory cache, disk
cache, parser, sort, label mapping, orchestrator. Zero new process boundaries.
Existing `cli-launcher.ts` spawn path is untouched; the new code feeds its
output forward by writing to the settings-slice surface that already drives the
existing `--model <id>` argv assembly.

**Recording lifecycle unaffected.** No recorder interaction in scope. Hunt R5
(PLAN line 217) covers the orthogonal concern that REST handler output isn't
tee'd into recorder fan-out; that's Hunt's lane, not subprocess.

---

## Findings

### P3 — Trailing-hyphen / leading-character argv hardening of `CLAUDE_MODEL_ID_RE`

**Location:** `anthropic-models-cache.ts:264`

```
const CLAUDE_MODEL_ID_RE = /^claude-[a-z0-9.\-]+$/;
```

**Concrete process-state context.** The matched `id` flows through
`BackendModelInfo.value` → settings-slice → `pickSessionDefaultModel` →
`CreateSessionOpts.model` → at session create, an existing code path lands it as
the discrete argv element following `--model` at the `Bun.spawn` call site in
`cli-launcher.ts`. `Bun.spawn` uses array-form argv (no shell), so the primary
defence is the binary's own getopt — which is exactly the load-bearing
assumption the regex narrows.

The literal `claude-` prefix is the strongest constraint here: it guarantees
the first character can never be `-`, so flag-shaped tokens
(`-c`, `--dangerously-skip-permissions`) are impossible by construction. The
length cap of 128 (line 269) is generous against real ids (~30 chars) and
prevents log-line / EC-9 entry blow-up. Both are appropriate defence-in-depth.

The two narrow edges worth noting (file all P3, do NOT block merge — flagging
only so a future contributor doesn't drift the regex without realising
the contract):

1. **Trailing `-` is matchable.** `^claude-[a-z0-9.\-]+$` allows
   `claude-opus-` to pass. With Bun array argv this is harmless to spawn
   semantics, but a small number of pathological getopt implementations
   treat `-` as a "read from stdin" sentinel when used alone — and a future
   refactor that ever joins argv into a string (e.g. for logging or sandboxed
   re-exec) would expose it. Tightening to require a trailing alphanumeric
   (`^claude-[a-z0-9.\-]*[a-z0-9]$`) costs nothing if you ever revisit.

2. **`.` is permitted.** No current Anthropic id uses a literal dot (today's
   shape is `claude-opus-4-7` / `claude-opus-4-8-20260415`). Allowing `.` is
   reasonable forward-headroom for variants like `claude-4.5`, but it widens
   the alphabet that the binary's parser must reject for any non-model
   purpose. Worth a one-line code comment naming this as a deliberate
   breadth, not an unbounded-by-omission.

**Recommendation:** P3 — accept as-is for ship; add a one-line code comment
on the regex stating the trailing-hyphen and `.` admission are deliberate, so a
future tighten-by-default contributor doesn't silently change the contract.
Update the regex only if/when the constraint actually matters at a downstream
call site.

---

### P3 — Defence-in-depth: the regex placement is correct; document the chain

**Location:** `anthropic-models-cache.ts:341-349`

The regex + bounded-length check are applied at the EC-5 parser boundary
(`parseAnthropicModelsResponse`) — before the value ever lands in
`BackendModelInfo`, before it reaches the cache, before it reaches the store,
before it reaches argv. That's the right placement.

The PLAN's `Subprocess R1` text concentrated on "no probe-spawn"; it didn't
spell out *where* the bounded-token discipline should live for the
upstream-to-argv flow. The implementation lands it at the parser boundary — the
earliest point where bytes are typed-by-construction — which is the only place
that survives EC-22 / EC-6 replay regression and prevents downstream
re-validation drift (per `feedback_validator_per_semantic_category.md` from the
project memory: one `isBoundedString` for IDs vs claims hides bugs; splitting by
semantic category is the durable shape).

**Recommendation:** P3 — add a JSDoc cross-reference on `BackendModelInfo.value`
(line ~181) naming the downstream consumer ("this string lands as a discrete
argv element following `--model` in `cli-launcher.ts`"). The bounds are
correct; the call-site documentation gap is the only thing left. Consistent
with `feedback_call_site_presence_not_just_symbol_export.md` — symbol exported
+ bounded ≠ documented at the consumer.

---

## What I checked and found clean (no finding)

- **No `Bun.spawn` / `child_process` import or call** in the new file.
- **No new exit handler, no new SIGTERM/SIGKILL path** — module owns no
  subprocess.
- **No PID storage, no PID-based identity check** — module owns no subprocess.
- **No idle-timer, no auto-relaunch counter** — module owns no subprocess.
- **No recording-file open/close** — module owns no recorder coupling. The
  Hunt R5 regression test in Task 7 (key never leaks to recordings) is the
  orthogonal guarantee; subprocess lane is unaffected.
- **AbortController hygiene** (`fetchAnthropicModelsRaw`, lines 599-694) is
  out of subprocess scope (HTTP timer, not process timer), but in passing:
  `clearTimeout(timeoutHandle)` in `finally` is correctly placed and the
  body-drain on every branch is consistent with subprocess-pipe-drain idioms
  applied to HTTP socket pool — same family of resource-lifecycle discipline,
  correctly implemented.
- **No `detached: true`**, no `unref()`, no orphan-class creation.
- **Negative-space documentation** (lines 28-42) explicitly enumerates four
  things this module deliberately doesn't do, with rationale. This is the
  structurally-correct way to surface "we are NOT a subprocess module" — it
  inoculates against drift-by-refactor (a future contributor reading the file
  sees the prohibition before they reach for `Bun.spawn`).

---

## Overriding-filter pass

1. **Does this code know which process it's talking to?** — N/A, no subprocess.
2. **Are signals propagated?** — N/A, no subprocess.
3. **Is auto-relaunch bounded?** — N/A, no subprocess; HTTP retries are not
   spawned, and single-flight discipline (Hunt R4) is correctly delete-in-finally.
4. **Are zombies reaped and stdio drained?** — N/A for processes; HTTP body
   drain on every branch (Backend P5) is correctly implemented.
5. **Do recordings cover the full lifetime?** — N/A, module doesn't write to
   recordings.

The indirect concern — "value lands as argv at the existing spawn site" — is
guarded by `CLAUDE_MODEL_ID_RE` + `MODEL_ID_MAX_LEN` + `isBoundedSafeString`
at the EC-5 parser boundary. Defence is correct; two P3 polish notes above.

**Ship.**
