# Friedman — UX Quality Review

Scope: `web/src/components/council/ObserverPanel.tsx`, `web/src/observer-panel-state.ts`, `web/src/types.ts`
Also touched for cross-reference: `web/src/components/council/FindingsLog.tsx` (downgrade chip — load-bearing for P9 trust signal).

Five findings. The headline is **P1#1** — the two new ladder states the plan adds (`reviewing-stalled`, `queued-dropped`) ship with **no render branch in `StatusPill`**. The deriver yields them, the panel renders an empty header. The mid-turn-drop UX case Friedman flagged in the plan is regressed below the previous baseline, not solved.

---

## P1#1 — `StatusPill` is non-exhaustive: `reviewing-stalled` and `queued-dropped` render as empty pill

**Files:** `ObserverPanel.tsx` lines 53-139; `observer-panel-state.ts` adds the two new variants; `types.ts` line 198-207 union.

**The defect.** `StatusPill` is a `switch(state.name)` over seven of the nine union members. The two new members from Task 11 — `reviewing-stalled` and `queued-dropped` — have no `case` arm. The switch has no `default` and no `assertNever` exhaustiveness guard. When the deriver yields either state, the switch falls off the end, the function returns `undefined`, and React renders an **empty header row** — no dot, no label, no phase.

**The UX consequence — concrete.**

- `reviewing-stalled` is the load-bearing user signal that auto-wake didn't complete inside the 90s budget. Today it appears in the panel exactly the same as "no header at all" — the user reads "Observer" + provider badges, sees a blank space where the pill belongs, and has no signal that the wake stalled. The very recovery branch the Task 11 plan promotes ("closes the recovery-branch-reachability failure mode where a stuck wake looked the same as a healthy idle pair") is structurally unreachable: the deriver crosses it, the renderer eats it. This is the **identity-binding-placeholder-void** failure mode (recovery branch ships green tests but is unreachable in runtime) at the rendering layer — feedback in memory: `feedback_recovery_branch_reachability.md`.

- `queued-dropped` is even worse on the user's mental model: the server's newest-wins queue dropped a checkpoint, the deriver puts `droppedCheckpointIds` in the state, and the user sees... nothing in the pill. The whole UX premise of the state ("the cycle deliberately skipped coverage, you should know") is decapitated at the renderer.

**Pre-merge severity.** This is shipped behaviour, not a typing miss. Tests in `observer-panel-state.test.ts` lines 152-184 verify the **deriver** emits the right shape. But there's no `ObserverPanel.test.tsx` assertion that the **status pill renders something** for each of the nine states. The Beck reviewer should flag the test gap; from a UX lens the bug ships dark.

**What needs to happen** (UX-shape, not code):

- `reviewing-stalled` pill: warning hue (NOT error — error is reserved for blocker-found; NOT info — info is reserved for in-flight). Label "Review stalled · {phase}". Footer microcopy: "Observer hasn't responded in {N}s — checkpoint may still arrive late". A secondary action affordance ("retry wake") is desirable but out of scope.
- `queued-dropped` pill: muted hue (NOT warning — it's an informational outcome, not a degraded one). Label "Skipped {N} checkpoint{s} · {lastPhase}". The dropped IDs are in `state.droppedCheckpointIds` — surface the count at minimum, ideally with a "show which" affordance that toggles a list. See P2#2.
- Add `default: const _exhaustive: never = state;` so the next ladder addition is a compile error, not a silent render miss.

**Severity: P1.** User-visible regression on the two new ladder states; both states are dark.

---

## P2#2 — `queued-dropped`: acknowledgement without action — user learns "some checkpoint was dropped" not "which one"

**Files:** `observer-panel-state.ts` lines 107-118; `types.ts` line 142, 205.

The deriver carries `droppedCheckpointIds: readonly string[]` into the state. The Friedman plan asked: *"Mid-turn drop case: user writes 5 checkpoints rapid-succession, observer reviews #1, drops #2-5. User sees one review for many checkpoints. UX cost?"* Resolution per context brief: server queue is newest-wins, phase N drops phase N-1.

That solves the *server* invariant. But the *user signal* is still incomplete:

- The IDs are opaque tokens (`chk_dropped_3`, `chk_dropped_4` in the test fixture). A user looking at "skipped 2 checkpoints" cannot tell whether the drops were `council-implement-task-3` (load-bearing) or `manual-test-1` (throwaway).
- There's no path from this state to *which phases were dropped*. The IDs are derived server-side from `(sessionGroupId, checkpointSeq, phase)` but the browser only sees the hex token.

**UX consequence.** The user has acknowledgement ("the system dropped some checkpoints") but no action surface ("here are the phases — re-trigger if you need coverage"). Friedman P9 "trust through reasoning visibility" — when the system tells the user "I skipped some work", it must say which work. Otherwise the user has two equally bad assumptions: (a) ignore the chip and lose coverage they care about, or (b) re-run *everything* to be safe, defeating the purpose of newest-wins.

**What needs to happen.** Either (a) include phase labels in `recentlySupersededCheckpointIds` (server-side change — convert string IDs to `{id, phase}[]`), or (b) populate a `recentlySupersededPhases: string[]` parallel array on `GroupRecord` so the UI can render "Skipped: council-implement-task-3, manual-test-1" instead of opaque hex.

**Severity: P2.** Doesn't break the user's task, but converts a deliberate UX signal into noise the user can't action.

---

## P2#3 — 90s `wakeTimeoutMs` will false-trip on legitimate long reviews (Opus + rich manifest)

**Files:** `observer-panel-state.ts` lines 83-99 (fallback constant); `types.ts` line 133 (wire field).

The deriver bounds `reviewing` by `lastCheckpointAt + wakeTimeoutMs`. Server publishes the value on `group_created`; fallback constant is `90_000` (90s). Past the deadline, state flips to `reviewing-stalled`.

**Why 90s is the wrong default for this product.**

- The observer's prompt asks Opus to read a delta manifest, ground each finding against modified files, and emit structured JSON with version-echo. On the `claude+claude` pairing this is a full Opus turn over arbitrary file content. Typical Opus latency on a 5-10 file manifest with line-bounded reads is **30-180s**, depending on file size and how much thinking the model burns.
- The Carmack-Council phases generate large manifests (review-output dirs span dozens of files). A `council-review` phase manifest is realistically going to push observer turn latency past 90s on Opus.
- The `reviewing-stalled` state is currently the *only* signal differentiating "stuck wake" from "Opus still working". Past 90s the panel says "stalled" even when the review is healthy and 30s from arrival.

**UX consequence.** Healthy long reviews look like stalled wakes. Users learn the signal is unreliable; trust erodes (Friedman P9). The classic *false-positive alert dilution* pattern from memory `feedback_alert_text_symptom_not_cause.md`.

**What needs to happen.**

- Treat 90s as a strict floor on `claude+claude` only when there's a hard product reason. Better: introduce a two-stage signal — "reviewing" for 0-60s (normal), "reviewing-slow" for 60-180s (advisory, low contrast, no warning hue), "reviewing-stalled" past 180s (warning hue, action affordance).
- Or, expose `wakeTimeoutMs` to the user — "Observer reviewing · started 2m ago · timeout in 30s" — so when the stall flips, the user has prior context.
- Whichever path: the fallback constant of 90s is too tight for Opus on rich manifests and should be raised to **180s** at minimum.

**Severity: P2.** Will erode trust in the new state machine within the first week of dogfooding.

---

## P2#4 — `wake_version_mismatch` downgrade renders incorrect rationale chip

**File:** `FindingsLog.tsx` lines 86-98 (DowngradedChip); `types.ts` line 170 (`downgradeReason` union).

The `downgradeReason` union includes `evidence_not_in_modified_set | evidence_missing_on_disk | wake_version_mismatch`. The chip mapping handles two of the three:

```
const human = reason === "evidence_missing_on_disk"
  ? "evidence not on disk"
  : "not in modified files";
```

When `wake_version_mismatch` arrives — meaning the observer's prompt schema-version echo didn't match the server's dispatched payload version, and the server **globally downgraded every finding in that review** — the chip renders **"not in modified files"**. That's an outright false explanation pinned to a server-controlled global downgrade reason.

**UX consequence — concrete.** The CLAUDE.md sketch in scope-brief calls this out directly: *"mismatch → all findings → NOTE + new downgrade reason `wake_version_mismatch`"*. The user reads a row labelled "STOP downgraded — not in modified files" when the actual reason is "observer's response shape didn't match the server's dispatch contract". The user will then:

1. Open the evidence path expecting to see a file the observer flagged outside the manifest — but the file *is* in the manifest.
2. Conclude the validator is broken / paranoid / hallucinating.
3. Lose trust in the downgrade signal as a whole. Friedman P9 — *"every time a user discovers a mistake, it's a small betrayal of trust"*. This isn't even a near-miss; the chip says A when the real reason is C.

**What needs to happen.** Add a third branch:

```
reason === "wake_version_mismatch"  → "observer reply schema mismatch"
reason === "evidence_missing_on_disk" → "evidence not on disk"
reason === "evidence_not_in_modified_set" → "not in modified files"
```

And pin a switch with exhaustiveness check (`never` default) so the next new downgrade reason is a compile error, not a misattribution. This is the same root cause as P1#1 — non-exhaustive switch hiding a structural gap.

**Severity: P2.** Trust-corroding wrong-attribution; technically not user-blocking, but exactly the surface Friedman P9 warns about. Could argue P1 given the false rationale could trigger investigation of innocent code.

---

## P3#5 — `reviewing-stalled` and `queued-dropped` are excluded from the header timestamp slot

**File:** `ObserverPanel.tsx` lines 246-253.

```
{(state.name === "sleeping" || state.name === "reviewing") && (
  <span ...>{formatRelativeTime(state.name === "sleeping" ? state.lastCheckpointAt : state.reviewingSince, ...)}</span>
)}
```

Both new states carry the field the timestamp slot uses (`reviewing-stalled.reviewingSince`, `queued-dropped.lastCheckpointAt`) but the guard excludes them. So in the very state where "how long has this been stalled?" is the user's primary question, the answer is hidden.

**UX consequence.** A stalled review pill without "started 4m ago" is half a signal. The user can't tell if they should wait (legitimate slow review) or intervene (truly stuck). Same on `queued-dropped` — "skipped 2 checkpoints" with no temporal anchor.

**What needs to happen.** Extend the guard to include both new states:

```
const showsTimestamp =
  state.name === "sleeping" ||
  state.name === "reviewing" ||
  state.name === "reviewing-stalled" ||
  state.name === "queued-dropped";
```

with corresponding anchor field extraction per state.

**Severity: P3.** Cosmetic-feeling but compounds with P1#1 — if the pill renders empty AND the timestamp is hidden, the new states are dark in two ways simultaneously.

---

## Non-findings (deliberate)

**On "is 9 states too many?"** No. Friedman P1 — "structure complexity, don't simplify away user value". Each of the 9 states surfaces a distinct user-actionable signal: degraded needs respawn, blocker needs decision, reconnecting needs patience, stalled needs intervention, reviewing needs nothing, queued-dropped needs acknowledgement, spawning needs patience, sleeping needs nothing, never-checkpointed needs onboarding. The Friedman five-screen-states heuristic is about empty/loading/partial/error/ideal — the 9 ladder slots are *modes within "ideal" + "error"*, not a substitute for the five-screen pattern. Trust signal is sufficient *if* P1#1 lands.

**On the deferred observer-tab composer.** Out of scope for these files (composer lives in `Composer.tsx` + `ChatView.tsx` routing). The deferral *was correct* if there's a follow-up — a disabled composer in the observer tab is a small Friedman P5 violation ("disabled buttons are a disastrous design pattern") but it's a contained one because the observer tab is rarely the user's primary surface. Recommendation: lift to a non-finding follow-up issue.

**On "trust through reasoning visibility for wake_version_mismatch."** Covered by P2#4. The deeper trust signal (server emits version-mismatch downgrade → user understands the contract broke) is a P2 surface defect, not absent entirely.

---

## Ladder ordering — does it match user mental model?

**Stated:** degraded > blocker > reconnecting > reviewing-stalled > reviewing > queued-dropped > spawning > sleeping > never-checkpointed.

**Concrete walkthrough of two debatable adjacencies:**

1. **`reviewing-stalled` above `reviewing`** — correct. A stalled in-flight review is a higher-attention signal than a healthy in-flight one. The deriver enforces this with the `now <= expiresAt` check (line 85). Good.

2. **`queued-dropped` below `reviewing` but above `spawning`** — debatable but defensible. A dropped checkpoint is a *historical* signal (the review that came in was clean, but it skipped predecessors); `reviewing` is a *present* signal. Present beats historical. Reasonable. The slot above `spawning` is also right — spawning is purely transient creation, the dropped-checkpoint state is meaningful information about coverage.

3. **`blocker-found` above `reconnecting`** — correct. An existing live STOP is more important than a transient disconnect. If the disconnect persists past the grace window it becomes `degraded`, which beats both.

The ladder is well-considered. P1#1 is a rendering miss, not a derivation miss.
