import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CouncilCheckpointPipeline,
  deterministicFindingId,
  type CheckpointPipelineGroupMeta,
  type CouncilWatcherEntry,
} from "./council-checkpoint-pipeline.js";
import { CheckpointLineSnapshots } from "./observer-line-snapshots.js";
import { ObserverReplyCapture } from "./observer-reply.js";
import { ObserverReadLedger } from "./observer-read-ledger.js";
import { companionBus } from "./event-bus.js";
import type { SessionGroupCoordinator } from "./session-group-coordinator.js";
import type { CheckpointPayload, ObserverReviewPayload } from "./council-types.js";
import { parseObserverReviewPayload } from "./council-types.js";
import { writeAtomicJson } from "./atomic-write.js";
import {
  buildObserverReviewFilename,
  buildSecondReviewFilename,
  findOwnReviewForCheckpointSync,
  findReviewForCheckpointSync,
  isGroupScopedReviewFilename,
  isSecondReviewFilename,
  OBSERVER_REVIEW_FILE_PATTERN,
  watchReviews,
} from "./review-watcher.js";
import { ConvergenceTracker } from "./convergence-tracker.js";
import { findCrossReviewerDuplicates, isNearDuplicate } from "./second-review-dedup.js";
import { SecondReviewer, type HeadlessRunResult } from "./second-reviewer.js";
import { addDispute } from "./observer-disputes.js";
import { isBlockingStopFinding } from "./council-auto-proceed-controller.js";
import { collectCheckpointCoverageGaps } from "./checkpoint-coverage.js";
import type { BrowserObserverFinding } from "./session-types.js";

// W15 multi-model review — how a second-opinion review merges into the
// EXISTING council review pipeline:
//  - file naming / watcher acceptance / "observer's own review" readers;
//  - handleCouncilReview treats it as a second opinion (no observer watchdog,
//    attribution per finding, distinct ids, near-duplicate folding);
//  - the convergence rule: a checkpoint is clean only if BOTH were clean;
//  - a STOP from either reviewer holds (banner/auto-proceed predicate).

const GROUP = "grp_0123456789abcdef0123456789abcdef";
const OBSERVER = "sess_obs";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function workspace(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "council-second-review-")));
  mkdirSync(join(dir, ".council", "reviews"), { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), "line1\nrelaunch()\nline3\n");
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function review(over: Partial<ObserverReviewPayload> = {}): ObserverReviewPayload {
  return {
    schema_version: 1,
    observer_wake_payload_version_echo: 1,
    checkpoint_id: "chk_1",
    phase: "council-implement",
    session_group_id: GROUP,
    reviewed_at: "2026-01-01T00:00:00Z",
    observer_provider: "codex",
    observer_model: "gpt-6.1-sol",
    observer_cli_version: "1",
    findings: [],
    ...over,
  } as ObserverReviewPayload;
}

function checkpoint(sequence: number, id = `chk_${sequence}`): CheckpointPayload {
  return {
    schema_version: 1,
    checkpoint_id: id,
    phase: "council-implement",
    sequence,
    session_group_id: GROUP,
    emitted_at: "2026-01-01T00:00:00Z",
    artifact_paths: ["src/a.ts"],
  } as CheckpointPayload;
}

function harness(opts: { onCheckpointAccepted?: (g: string, p: CheckpointPayload, ctx: { cwd: string; previous: CheckpointPayload | null }) => void } = {}) {
  const cwd = workspace();
  const watchers = new Map<string, CouncilWatcherEntry>();
  const meta = new Map<string, CheckpointPipelineGroupMeta>();
  const send = vi.fn(() => ({ kind: "sent" as const }));
  const pipeline = new CouncilCheckpointPipeline({
    watchers,
    groupMeta: meta,
    getCoordinator: () => ({ get: vi.fn(() => ({ sessionGroupId: GROUP, status: "active" })), applyEvent: vi.fn() }) as unknown as SessionGroupCoordinator,
    getWsBridge: () => ({ sendObserverWakeFrame: send }),
    isApiLimitReached: () => false,
    replyCapture: new ObserverReplyCapture({
      now: () => new Date(),
      writeReview: () => {},
      findExistingReview: () => null,
      moveAside: () => {},
      resolveCliVersion: () => undefined,
    }),
    lineSnapshots: new CheckpointLineSnapshots(),
    readLedger: new ObserverReadLedger(),
    ...(opts.onCheckpointAccepted ? { onCheckpointAccepted: opts.onCheckpointAccepted } : {}),
  });
  watchers.set(GROUP, {
    cwd,
    abort: new AbortController(),
    lastCheckpoint: checkpoint(1),
    previousCheckpoint: null,
    pendingCheckpoint: null,
    supersededCheckpointIds: [],
    pendingReviewDeadline: null,
  });
  meta.set(GROUP, { primarySessionId: "sess_orch", observerSessionId: OBSERVER, pairing: "claude+codex", lastCheckpointReceivedAt: null });
  cleanups.push(() => {
    const d = watchers.get(GROUP)?.pendingReviewDeadline;
    if (d) clearTimeout(d.timer);
  });
  const reviews: Array<Record<string, unknown> & { findings: BrowserObserverFinding[] }> = [];
  cleanups.push(companionBus.on("group:review", (e) => { reviews.push(e as never); }));
  return { pipeline, watchers, meta, cwd, send, reviews };
}

describe("second-review file naming and readers", () => {
  // Same-provider pairs (claude observer + claude second opinion) must not
  // collide on one file name.
  it("names the second review distinctly from the observer's, still matching the review pattern", () => {
    const observer = buildObserverReviewFilename("council-implement", "claude", GROUP);
    const second = buildSecondReviewFilename("council-implement", "claude", GROUP);
    expect(second).not.toBe(observer);
    expect(OBSERVER_REVIEW_FILE_PATTERN.test(second)).toBe(true);
    expect(isSecondReviewFilename(second, GROUP)).toBe(true);
    expect(isGroupScopedReviewFilename(second, GROUP)).toBe(false);
    expect(isSecondReviewFilename(observer, GROUP)).toBe(false);
  });

  // Regression guard: a fast second review on disk must NOT read as the
  // observer's answer — otherwise the reply capture stands down
  // (`skipped_existing`) and Gate 0b skips the observer's wake.
  it("the observer's-own-review readers ignore a second review", () => {
    const cwd = workspace();
    const dir = join(cwd, ".council", "reviews");
    writeAtomicJson(join(dir, buildSecondReviewFilename("council-implement", "claude", GROUP)), review({ reviewer_role: "second", observer_provider: "claude" }));
    expect(findOwnReviewForCheckpointSync({ directory: dir, checkpointId: "chk_1", sessionGroupId: GROUP })).toBeNull();
    expect(findReviewForCheckpointSync({ directory: dir, checkpointId: "chk_1" })).toBeNull();
    // Coverage is the observer's coverage: a second opinion alone leaves a gap.
    writeAtomicJson(join(cwd, ".council", "checkpoints", "c.json"), checkpoint(1));
    expect(collectCheckpointCoverageGaps({ cwd, sessionGroupId: GROUP }).map((g) => g.checkpointId)).toEqual(["chk_1"]);
  });

  it("parser keeps reviewer_role=second and rejects unknown roles (EC-5)", () => {
    expect(parseObserverReviewPayload(JSON.stringify(review({ reviewer_role: "second" })))?.reviewer_role).toBe("second");
    expect(parseObserverReviewPayload(JSON.stringify({ ...review(), reviewer_role: "third" }))).toBeNull();
  });

  // The host ingests its own second review directly; the per-group watcher
  // must not deliver the file a second time (double grounding / fan-out).
  it("the group watcher does not deliver the host-ingested second-review file", async () => {
    const cwd = workspace();
    const dir = join(cwd, ".council", "reviews");
    const abort = new AbortController();
    const seen: ObserverReviewPayload[] = [];
    const done = watchReviews({ directory: dir, signal: abort.signal, sessionGroupId: GROUP, debounceMs: 30, onReview: (p) => { seen.push(p); } });
    await new Promise((r) => setTimeout(r, 50));
    writeAtomicJson(join(dir, buildSecondReviewFilename("council-implement", "claude", GROUP)), review({ observer_provider: "claude", reviewer_role: "second" }));
    await new Promise((r) => setTimeout(r, 300));
    writeAtomicJson(join(dir, buildObserverReviewFilename("council-implement", "claude", GROUP)), review({ observer_provider: "claude" }));
    await vi.waitFor(() => expect(seen).toHaveLength(1), { timeout: 3000 });
    await new Promise((r) => setTimeout(r, 100));
    abort.abort();
    await done;
    expect(seen.map((p) => p.reviewer_role ?? "observer")).toEqual(["observer"]);
  });
});

describe("handleCouncilReview with a second-opinion review", () => {
  it("does not disarm the observer's wake watchdog nor advance lastReviewedCheckpointId", () => {
    const h = harness();
    h.pipeline.handleCouncilCheckpoint(GROUP, checkpoint(2));
    expect(h.watchers.get(GROUP)!.pendingReviewDeadline?.checkpointId).toBe("chk_2");

    h.pipeline.handleCouncilReview(GROUP, review({ checkpoint_id: "chk_2", reviewer_role: "second", observer_provider: "claude", observer_model: "claude-sonnet-5" }));

    expect(h.watchers.get(GROUP)!.pendingReviewDeadline?.checkpointId).toBe("chk_2");
    expect(h.meta.get(GROUP)!.lastReviewedCheckpointId).toBeUndefined();
    expect(h.reviews).toHaveLength(1);
    expect(h.reviews[0]!.reviewerRole).toBe("second");
    expect(h.reviews[0]!.observerModel).toBe("claude-sonnet-5");
  });

  // A STOP from the second opinion goes through the same grounding and stays
  // a blocking STOP (banner + auto-proceed hold), attributed to its model.
  it("grounds a second-opinion STOP, attributes it per finding and keeps it blocking", () => {
    const h = harness();
    h.pipeline.handleCouncilReview(GROUP, review({
      reviewer_role: "second",
      observer_provider: "claude",
      observer_model: "claude-sonnet-5",
      findings: [{ severity: "STOP", claim: "`relaunch()` has no backoff — crash-loop storm", evidence_path: "src/a.ts", evidence_lines: [2, 2] }],
    }));
    const f = h.reviews[0]!.findings[0]!;
    expect(f.severity).toBe("STOP");
    expect(f.wasDowngraded).toBeUndefined();
    expect(f.reviewer).toEqual({ role: "second", provider: "claude", model: "claude-sonnet-5" });
    expect(isBlockingStopFinding(f)).toBe(true);
  });

  // claude+claude with a claude second opinion: identical findings must still
  // get distinct ids, or the browser would dedup one reviewer away.
  it("gives a same-provider second opinion ids distinct from the observer's", () => {
    const h = harness();
    const finding = { severity: "WARN" as const, claim: "same words", evidence_path: "src/a.ts" };
    h.pipeline.handleCouncilReview(GROUP, review({ observer_provider: "claude", findings: [finding] }));
    h.pipeline.handleCouncilReview(GROUP, review({ observer_provider: "claude", reviewer_role: "second", findings: [finding] }));
    expect(h.reviews[0]!.findings[0]!.id).not.toBe(h.reviews[1]!.findings[0]!.id);
  });

  // Dedupe: the observer already raised the same defect (its review file is
  // on disk and older) → the second opinion's copy points at it and never
  // holds on its own.
  it("folds a near-identical later claim into the other reviewer's finding", () => {
    const h = harness();
    const dir = join(h.cwd, ".council", "reviews");
    const observerFinding = { severity: "STOP" as const, claim: "relaunch() loops forever without any backoff delay", evidence_path: "src/a.ts", evidence_lines: [2, 2] as [number, number] };
    const observerFile = join(dir, buildObserverReviewFilename("council-implement", "codex", GROUP));
    writeAtomicJson(observerFile, review({ findings: [observerFinding] }));
    const past = new Date(Date.now() - 60_000);
    utimesSync(observerFile, past, past);
    // The observer's review was ingested first: its grounded verdict (a real
    // blocking STOP) is frozen and is what the later claim is compared to.
    h.pipeline.handleCouncilReview(GROUP, review({ findings: [observerFinding] }), past.getTime());
    h.reviews.length = 0;
    const observerId = deterministicFindingId({
      sessionGroupId: GROUP, checkpointId: "chk_1", observerProvider: "codex", findingIndex: 0,
      evidencePath: "src/a.ts", claim: observerFinding.claim,
    });

    h.pipeline.handleCouncilReview(GROUP, review({
      reviewer_role: "second",
      observer_provider: "claude",
      findings: [
        { severity: "STOP", claim: "relaunch() loops forever without backoff delay", evidence_path: "src/a.ts", evidence_lines: [2, 2] },
        { severity: "WARN", claim: "a different problem entirely about logging", evidence_path: "src/a.ts" },
      ],
    }), Date.now());

    const [dup, distinct] = h.reviews[0]!.findings;
    expect(dup!.duplicateOf).toBe(observerId);
    expect(isBlockingStopFinding(dup!)).toBe(false);
    expect(distinct!.duplicateOf).toBeUndefined();
  });

  // Observer STOP1 on PR #372: dedupe must compare against the EARLIER
  // finding's final (grounded) verdict, not its raw severity. An earlier STOP
  // without cited lines is weak evidence and does not block; a later STOP
  // with the same words and grounded lines must not be folded into it, or the
  // only real blocker vanishes from the banner and the auto-proceed hold.
  it("never folds a grounded blocking STOP into an earlier non-blocking (weak) STOP", () => {
    const h = harness();
    const dir = join(h.cwd, ".council", "reviews");
    const weakObserver = review({
      findings: [{ severity: "STOP", claim: "relaunch() loops forever without any backoff delay", evidence_path: "src/a.ts" }],
    });
    const observerFile = join(dir, buildObserverReviewFilename("council-implement", "codex", GROUP));
    writeAtomicJson(observerFile, weakObserver);
    const past = new Date(Date.now() - 60_000);
    utimesSync(observerFile, past, past);
    h.pipeline.handleCouncilReview(GROUP, weakObserver, past.getTime());
    const earlier = h.reviews[0]!.findings[0]!;
    expect(earlier.weakEvidence).toBe("no_cited_lines");
    expect(isBlockingStopFinding(earlier)).toBe(false);

    h.pipeline.handleCouncilReview(GROUP, review({
      reviewer_role: "second",
      observer_provider: "claude",
      findings: [{ severity: "STOP", claim: "relaunch() loops forever without backoff delay", evidence_path: "src/a.ts", evidence_lines: [2, 2] }],
    }), Date.now());
    const later = h.reviews[1]!.findings[0]!;
    expect(later.duplicateOf).toBeUndefined();
    expect(isBlockingStopFinding(later)).toBe(true);
  });

  // Observer re-review STOP on 5e38b8a8: the earlier finding's DISPUTED state
  // is part of its final verdict. A STOP the user disputed does not block, so
  // it must not swallow a later grounded STOP that does not itself match the
  // dispute (similar words, no shared backtick anchor).
  it("never folds a blocking STOP into an earlier STOP the user disputed", () => {
    const h = harness();
    const dir = join(h.cwd, ".council", "reviews");
    const earlierClaim = "relaunch loops forever without any backoff delay at all";
    const observerPayload = review({
      findings: [{ severity: "STOP", claim: earlierClaim, evidence_path: "src/a.ts", evidence_lines: [2, 2] }],
    });
    const observerFile = join(dir, buildObserverReviewFilename("council-implement", "codex", GROUP));
    writeAtomicJson(observerFile, observerPayload);
    const past = new Date(Date.now() - 60_000);
    utimesSync(observerFile, past, past);
    h.pipeline.handleCouncilReview(GROUP, observerPayload, past.getTime());
    expect(isBlockingStopFinding(h.reviews[0]!.findings[0]!)).toBe(true);
    // The human disputes the observer's STOP afterwards.
    expect(addDispute(h.cwd, GROUP, { claim: earlierClaim, evidencePath: "src/a.ts", source: "browser_dispute" }).ok).toBe(true);

    h.pipeline.handleCouncilReview(GROUP, review({
      reviewer_role: "second",
      observer_provider: "claude",
      findings: [{ severity: "STOP", claim: "relaunch loops forever without backoff delay", evidence_path: "src/a.ts", evidence_lines: [2, 2] }],
    }), Date.now());
    const later = h.reviews[1]!.findings[0]!;
    expect(later.disputed).toBeUndefined();
    expect(later.duplicateOf).toBeUndefined();
    expect(isBlockingStopFinding(later)).toBe(true);
  });

  it("hands every accepted checkpoint to the second-review hook, after the observer's wake", () => {
    const hook = vi.fn();
    const h = harness({ onCheckpointAccepted: hook });
    h.pipeline.handleCouncilCheckpoint(GROUP, checkpoint(2));
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledWith(GROUP, expect.objectContaining({ checkpoint_id: "chk_2" }), {
      cwd: h.cwd,
      previous: expect.objectContaining({ checkpoint_id: "chk_1" }),
    });
  });

  it("a throwing hook never breaks checkpoint handling", () => {
    const h = harness({ onCheckpointAccepted: vi.fn(() => { throw new Error("boom"); }) });
    expect(() => h.pipeline.handleCouncilCheckpoint(GROUP, checkpoint(2))).not.toThrow();
    expect(h.send).toHaveBeenCalledTimes(1);
  });
});

describe("near-duplicate detection", () => {
  const base = { id: "a", severity: "STOP" as const, claim: "cancel races the turn-done handler and drops the reply", evidence_path: "src/x.ts", evidence_lines: [10, 20] as [number, number] };
  it("same file + overlapping lines + similar words = duplicate", () => {
    expect(isNearDuplicate({ ...base, id: "b", claim: "the cancel races the turn-done handler, dropping the reply" }, base)).toBe(true);
  });
  // A disagreement in severity is information, not a duplicate.
  it("a MORE severe later claim, another file, disjoint lines or different words are not duplicates", () => {
    expect(isNearDuplicate({ ...base, id: "b", severity: "STOP" }, { ...base, severity: "WARN" })).toBe(false);
    expect(isNearDuplicate({ ...base, id: "b", evidence_path: "src/y.ts" }, base)).toBe(false);
    expect(isNearDuplicate({ ...base, id: "b", evidence_lines: [30, 40] }, base)).toBe(false);
    expect(isNearDuplicate({ ...base, id: "b", claim: "missing test for the logger" }, base)).toBe(false);
  });
  // STOP1: a blocking later finding is never folded into a non-blocking one;
  // a non-blocking later finding still folds into a blocking one.
  it("a blocking later finding never folds into a non-blocking earlier one", () => {
    expect(isNearDuplicate({ ...base, id: "b", blocking: true }, { ...base, blocking: false })).toBe(false);
    expect(isNearDuplicate({ ...base, id: "b", blocking: false }, { ...base, blocking: true })).toBe(true);
    expect(isNearDuplicate({ ...base, id: "b", blocking: true }, { ...base, blocking: true })).toBe(true);
  });

  it("each earlier finding absorbs at most one later finding", () => {
    const out = findCrossReviewerDuplicates([{ ...base, id: "b" }, { ...base, id: "c" }], [base]);
    expect(out).toEqual(["a", undefined]);
  });
});

describe("convergence: a checkpoint is clean only if both reviewers were clean", () => {
  function tracker() {
    const t = new ConvergenceTracker({ isFrozen: () => false, getThreshold: () => 2 });
    t.attach();
    cleanups.push(() => t.detach());
    const events: Array<{ transition: string; cycleNumber: number; notCountedReason?: string }> = [];
    cleanups.push(companionBus.on("group:convergence", (e) => { if (e.sessionGroupId === GROUP) events.push(e); }));
    return { t, events };
  }
  const clean = (checkpointId: string, reviewerRole?: "second") =>
    companionBus.emit("group:review", {
      sessionGroupId: GROUP, checkpointId, phase: "council-implement", findings: [], downgrades: [],
      observerModel: "m", observerProvider: reviewerRole ? "claude" : "codex", artifactsChanged: 1, artifactsRead: 1,
      ...(reviewerRole ? { reviewerRole } : {}),
    });
  const stop = (checkpointId: string, reviewerRole?: "second") =>
    companionBus.emit("group:review", {
      sessionGroupId: GROUP, checkpointId, phase: "council-implement",
      findings: [{ id: `f_${checkpointId}_${reviewerRole ?? "o"}`, severity: "STOP", claim: "x", evidence_path: "src/a.ts" }],
      downgrades: [], observerModel: "m", observerProvider: reviewerRole ? "claude" : "codex", artifactsChanged: 1, artifactsRead: 1,
      ...(reviewerRole ? { reviewerRole } : {}),
    });
  const dispatched = (checkpointId: string) =>
    companionBus.emit("group:second-review", { sessionGroupId: GROUP, checkpointId, status: "dispatched", backend: "claude", model: "sonnet" });
  const missing = (checkpointId: string) =>
    companionBus.emit("group:second-review", { sessionGroupId: GROUP, checkpointId, status: "missing", backend: "claude", model: "sonnet", reason: "timeout" });

  it("observer clean first is held until the second opinion is clean too, then folds once", () => {
    const { t, events } = tracker();
    dispatched("c1");
    clean("c1");
    expect(t.getState(GROUP)?.cleanCycleCount ?? 0).toBe(0);
    expect(events.at(-1)).toMatchObject({ transition: "not-counted", notCountedReason: "awaiting_second_review" });
    clean("c1", "second");
    expect(t.getState(GROUP)!.cleanCycleCount).toBe(1);
    expect(events.at(-1)).toMatchObject({ transition: "cycle-progress", cycleNumber: 1 });
  });

  it("second opinion clean first, observer clean second → one clean cycle", () => {
    const { t } = tracker();
    dispatched("c1");
    clean("c1", "second");
    expect(t.getState(GROUP)?.cleanCycleCount ?? 0).toBe(0);
    clean("c1");
    expect(t.getState(GROUP)!.cleanCycleCount).toBe(1);
  });

  it("a second-opinion STOP resets the streak and the observer's clean review does not count", () => {
    const { t, events } = tracker();
    clean("c0");
    expect(t.getState(GROUP)!.cleanCycleCount).toBe(1);
    dispatched("c1");
    stop("c1", "second");
    expect(t.getState(GROUP)!.cleanCycleCount).toBe(0);
    clean("c1");
    expect(t.getState(GROUP)!.cleanCycleCount).toBe(0);
    expect(events.at(-1)).toMatchObject({ transition: "not-counted", notCountedReason: "second_review_blocked" });
  });

  it("an owed second opinion that fails leaves the checkpoint not counted", () => {
    const { t, events } = tracker();
    dispatched("c1");
    clean("c1");
    missing("c1");
    expect(t.getState(GROUP)?.cleanCycleCount ?? 0).toBe(0);
    expect(events.at(-1)).toMatchObject({ transition: "not-counted", notCountedReason: "second_review_missing" });
  });

  // No second opinion configured for the checkpoint → unchanged behaviour.
  it("without a dispatched second opinion the observer's clean review folds as before", () => {
    const { t } = tracker();
    clean("c1");
    expect(t.getState(GROUP)!.cleanCycleCount).toBe(1);
  });

  // Observer STOP2 on PR #372: a checkpoint QUEUED behind a running second
  // review is already owed a second verdict. Scenario: A running → B queued →
  // observer's clean review of B → B superseded by C. The streak must not grow.
  it("a queued second review holds the observer's clean review; superseding it leaves it not counted", async () => {
    const { t, events } = tracker();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const cwd = workspace();
    const reviewer = new SecondReviewer({
      getConfig: () => ({ reviewer: "auto", scope: "all" }),
      loadSystemPrompt: () => "<!-- observer-system-prompt v1 -->\nprompt",
      resolveBinary: (n) => `/bin/${n}`,
      buildEnv: () => ({}),
      run: async (): Promise<HeadlessRunResult> => {
        await gate;
        return { exitCode: null, stdout: "", stderr: "", timedOut: true, aborted: false };
      },
      writeReview: () => {},
      ingestReview: () => {},
      isBackendLimited: () => false,
      isGroupLive: () => true,
      emit: (e) => companionBus.emit("group:second-review", e),
      now: () => Date.now(),
      makeScratchFile: () => ({ path: join(cwd, "s.txt"), cleanup: () => {} }),
      readScratchFile: () => null,
    });
    const ctx = { cwd, observerBackend: "codex" as const, previous: null };
    const a = reviewer.onCheckpoint(GROUP, checkpoint(1, "A"), ctx);
    expect(a.kind).toBe("dispatched");
    expect(reviewer.onCheckpoint(GROUP, checkpoint(2, "B"), ctx)).toEqual({ kind: "queued" });

    clean("B");
    expect(t.getState(GROUP)?.cleanCycleCount ?? 0).toBe(0);
    expect(events.at(-1)).toMatchObject({ transition: "not-counted", notCountedReason: "awaiting_second_review" });

    expect(reviewer.onCheckpoint(GROUP, checkpoint(3, "C"), ctx)).toEqual({ kind: "queued" });
    expect(t.getState(GROUP)?.cleanCycleCount ?? 0).toBe(0);
    expect(events.at(-1)).toMatchObject({ transition: "not-counted", notCountedReason: "second_review_missing" });
    reviewer.forgetGroup(GROUP);
    release();
    await (a as { done: Promise<void> }).done;
  });

  it("an observer STOP still resets immediately while the second opinion is pending", () => {
    const { t } = tracker();
    clean("c0");
    dispatched("c1");
    stop("c1");
    expect(t.getState(GROUP)!.cleanCycleCount).toBe(0);
  });
});
