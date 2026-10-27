import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CouncilCheckpointPipeline,
  type CheckpointPipelineGroupMeta,
  type CouncilCheckpointPipelineDeps,
  type CouncilWatcherEntry,
} from "./council-checkpoint-pipeline.js";
import { CheckpointLineSnapshots } from "./observer-line-snapshots.js";
import { ObserverReplyCapture, type ObserverReplyCaptureDeps } from "./observer-reply.js";
import { ObserverReadLedger } from "./observer-read-ledger.js";
import { readCouncilWakeSentinel } from "./council-wake-sentinel.js";
import { companionBus } from "./event-bus.js";
import type { SessionGroupCoordinator } from "./session-group-coordinator.js";
import type { CheckpointPayload } from "./council-types.js";
import { writeAtomicJson } from "./atomic-write.js";
import { log } from "./logger.js";
import { findOwnReviewForCheckpointSync } from "./review-watcher.js";

// P4/C1a: the checkpoint → wake → review pipeline was extracted verbatim from
// session-orchestrator.ts. Its behaviour is pinned end-to-end by the
// orchestrator suite (which still drives it through the orchestrator's
// delegates). These tests pin the NEW seam: the pipeline works with nothing
// but its DI deps — no orchestrator instance — and every dep is resolved at
// call time, not captured at construction.

const GROUP = "grp_pipe";
const OBSERVER = "sess_obs";

interface Harness {
  pipeline: CouncilCheckpointPipeline;
  watchers: Map<string, CouncilWatcherEntry>;
  meta: Map<string, CheckpointPipelineGroupMeta>;
  send: ReturnType<typeof vi.fn>;
  setCoordinator: (c: SessionGroupCoordinator | null) => void;
  setApiLimited: (v: boolean) => void;
  ledger: ObserverReadLedger;
  capture: ObserverReplyCapture;
  cwd: string;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function activeCoordinator(status = "active"): SessionGroupCoordinator {
  return { get: vi.fn(() => ({ sessionGroupId: GROUP, status })), applyEvent: vi.fn() } as unknown as SessionGroupCoordinator;
}

function makeHarness(opts: {
  onObserverAdapterMissing?: (g: string, p: CheckpointPayload) => void;
  captureDeps?: Partial<ObserverReplyCaptureDeps>;
  pipelineDeps?: Partial<CouncilCheckpointPipelineDeps>;
} = {}): Harness {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "council-pipeline-")));
  const watchers = new Map<string, CouncilWatcherEntry>();
  const meta = new Map<string, CheckpointPipelineGroupMeta>();
  let coordinator: SessionGroupCoordinator | null = null;
  let apiLimited = false;
  const send = vi.fn(() => ({ kind: "sent" as const }));
  const ledger = new ObserverReadLedger();
  const replyCapture = new ObserverReplyCapture({
    now: () => new Date(),
    writeReview: () => {},
    findExistingReview: () => null,
    moveAside: () => {},
    resolveCliVersion: () => undefined,
    ...opts.captureDeps,
  });
  const pipeline = new CouncilCheckpointPipeline({
    watchers,
    groupMeta: meta,
    getCoordinator: () => coordinator,
    getWsBridge: () => ({ sendObserverWakeFrame: send }),
    isApiLimitReached: () => apiLimited,
    replyCapture,
    lineSnapshots: new CheckpointLineSnapshots(),
    readLedger: ledger,
    onObserverAdapterMissing: opts.onObserverAdapterMissing,
    ...opts.pipelineDeps,
  });
  watchers.set(GROUP, {
    cwd,
    abort: new AbortController(),
    lastCheckpoint: null,
    previousCheckpoint: null,
    pendingCheckpoint: null,
    supersededCheckpointIds: [],
    pendingReviewDeadline: null,
  });
  meta.set(GROUP, {
    primarySessionId: "sess_orch",
    observerSessionId: OBSERVER,
    pairing: "claude+claude",
    lastCheckpointReceivedAt: null,
  });
  cleanups.push(() => {
    // Disarm the wake→review watchdog so no timer outlives the test.
    const deadline = watchers.get(GROUP)?.pendingReviewDeadline;
    if (deadline) clearTimeout(deadline.timer);
    rmSync(cwd, { recursive: true, force: true });
  });
  return {
    pipeline, watchers, meta, send, cwd, ledger, capture: replyCapture,
    setCoordinator: (c) => { coordinator = c; },
    setApiLimited: (v) => { apiLimited = v; },
  };
}

function checkpoint(
  sequence: number,
  id = `chk_${sequence}`,
  group = GROUP,
  artifactPaths: string[] = [],
): CheckpointPayload {
  return {
    schema_version: 1,
    checkpoint_id: id,
    phase: "council-plan",
    sequence,
    session_group_id: group,
    emitted_at: "2026-01-01T00:00:00Z",
    artifact_paths: artifactPaths,
  } as CheckpointPayload;
}

describe("CouncilCheckpointPipeline (standalone, DI only)", () => {
  // Happy path through the whole dispatch: checkpoint captured, bus event
  // emitted, wake sent, durable sentinel written, watchdog armed.
  it("dispatches a wake for an active group and records the sentinel + watchdog", () => {
    const h = makeHarness();
    h.setCoordinator(activeCoordinator());
    const seen: string[] = [];
    cleanups.push(companionBus.on("group:checkpoint", (e) => { seen.push(e.checkpointId); }));

    h.pipeline.handleCouncilCheckpoint(GROUP, checkpoint(1));

    expect(seen).toEqual(["chk_1"]);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send.mock.calls[0]![0]).toBe(OBSERVER);
    expect(readCouncilWakeSentinel(h.cwd, GROUP)?.last_woken_checkpoint_id).toBe("chk_1");
    expect(h.watchers.get(GROUP)!.pendingReviewDeadline?.checkpointId).toBe("chk_1");
    expect(h.meta.get(GROUP)!.lastCheckpointReceivedAt).not.toBeNull();
  });

  // Coordinator is created lazily by the orchestrator AFTER the pipeline is
  // built. The getter must be consulted per call, so a degraded status set
  // later still gates the wake (AP-2: state machine is the source of truth).
  it("reads the coordinator at call time, not at construction", () => {
    const h = makeHarness();
    h.setCoordinator(activeCoordinator("degraded"));
    const out = h.pipeline.dispatchObserverWake(GROUP, checkpoint(1));
    expect(out).toEqual({ kind: "skipped", reason: "group_not_active" });
    expect(h.send).not.toHaveBeenCalled();
  });

  // The idle-timer manager can be swapped on the orchestrator after
  // construction; the API-limit gate goes through a closure for that reason.
  it("honours the api-limit dep", () => {
    const h = makeHarness();
    h.setCoordinator(activeCoordinator());
    h.setApiLimited(true);
    const out = h.pipeline.dispatchObserverWake(GROUP, checkpoint(1));
    expect(out).toEqual({ kind: "skipped", reason: "api_limit_reached" });
    expect(h.send).not.toHaveBeenCalled();
  });

  // Busy observer: newest-wins single-slot queue, superseded id recorded,
  // and the drain re-dispatches only the newest checkpoint.
  it("queues while the observer is busy and drains the newest checkpoint", () => {
    const h = makeHarness();
    h.setCoordinator(activeCoordinator());
    h.send.mockReturnValue({ kind: "busy" } as never);
    h.pipeline.handleCouncilCheckpoint(GROUP, checkpoint(1));
    h.pipeline.handleCouncilCheckpoint(GROUP, checkpoint(2));
    const entry = h.watchers.get(GROUP)!;
    expect(entry.pendingCheckpoint?.checkpoint_id).toBe("chk_2");
    expect(entry.supersededCheckpointIds).toEqual(["chk_1"]);

    h.send.mockReturnValue({ kind: "sent" });
    h.pipeline.drainPendingObserverWake(GROUP);
    expect(entry.pendingCheckpoint).toBeNull();
    expect(readCouncilWakeSentinel(h.cwd, GROUP)?.last_woken_checkpoint_id).toBe("chk_2");
  });

  // Cross-tenant guard: a checkpoint (or review) addressed to another group
  // sharing the workspace must not mutate state, wake, or fan out.
  it("rejects foreign-group checkpoints and reviews without side effects", () => {
    const h = makeHarness();
    h.setCoordinator(activeCoordinator());
    const reviews: unknown[] = [];
    cleanups.push(companionBus.on("group:review", (e) => { reviews.push(e); }));

    h.pipeline.handleCouncilCheckpoint(GROUP, checkpoint(1, "chk_x", "grp_other"));
    expect(h.watchers.get(GROUP)!.lastCheckpoint).toBeNull();
    expect(h.send).not.toHaveBeenCalled();

    h.pipeline.handleCouncilReview(GROUP, {
      schema_version: 1,
      observer_wake_payload_version_echo: 1,
      checkpoint_id: "chk_x",
      phase: "council-plan",
      session_group_id: "grp_other",
      reviewed_at: "2026-01-01T00:00:00Z",
      observer_provider: "claude",
      observer_model: "m",
      observer_cli_version: "1",
      findings: [],
    } as never);
    expect(reviews).toHaveLength(0);
  });

  // A review for the armed checkpoint disarms the watchdog and fans out one
  // group:review; lastReviewedCheckpointId is written back into the shared meta.
  it("accepts an own-group review: disarms the watchdog and emits group:review", () => {
    const h = makeHarness();
    h.setCoordinator(activeCoordinator());
    h.pipeline.handleCouncilCheckpoint(GROUP, checkpoint(1));
    const reviews: Array<{ checkpointId: string }> = [];
    cleanups.push(companionBus.on("group:review", (e) => { reviews.push(e); }));

    h.pipeline.handleCouncilReview(GROUP, {
      schema_version: 1,
      observer_wake_payload_version_echo: 1,
      checkpoint_id: "chk_1",
      phase: "council-plan",
      session_group_id: GROUP,
      reviewed_at: "2026-01-01T00:00:00Z",
      observer_provider: "claude",
      observer_model: "m",
      observer_cli_version: "1",
      findings: [],
    } as never);

    expect(reviews.map((r) => r.checkpointId)).toEqual(["chk_1"]);
    expect(h.watchers.get(GROUP)!.pendingReviewDeadline).toBeNull();
    expect(h.meta.get(GROUP)!.lastReviewedCheckpointId).toBe("chk_1");
  });

  // P3/CONV-HONEST: the review event carries the HOST's count of changed
  // files the observer read while answering this checkpoint's wake — fed by
  // the observer's own tool_use frames, never by the review text. Spawn /
  // empty checkpoints report 0 changed files; a review with no reads reports
  // 0 reads; both are later refused by the convergence counter.
  describe("host-observed reads on group:review (CONV-HONEST)", () => {
    function review(checkpointId: string) {
      return {
        schema_version: 1,
        observer_wake_payload_version_echo: 1,
        checkpoint_id: checkpointId,
        phase: "council-plan",
        session_group_id: GROUP,
        reviewed_at: "2026-01-01T00:00:00Z",
        observer_provider: "claude",
        observer_model: "m",
        observer_cli_version: "1",
        findings: [],
      } as never;
    }
    function toolUse(name: string, input: Record<string, unknown>) {
      return { type: "assistant", message: { content: [{ type: "tool_use", id: "t", name, input }] } };
    }
    function capture() {
      const reviews: Array<{ artifactsChanged: number; artifactsRead: number }> = [];
      cleanups.push(companionBus.on("group:review", (e) => { reviews.push(e); }));
      return reviews;
    }

    it("spawn checkpoint (no artifact paths) → 0 changed, 0 read", () => {
      const h = makeHarness();
      h.setCoordinator(activeCoordinator());
      const reviews = capture();
      h.pipeline.handleCouncilCheckpoint(GROUP, checkpoint(1));
      h.pipeline.handleCouncilReview(GROUP, review("chk_1"));
      expect(reviews[0]).toMatchObject({ artifactsChanged: 0, artifactsRead: 0 });
    });

    it("observer that read nothing → changed counted, 0 read", () => {
      const h = makeHarness();
      h.setCoordinator(activeCoordinator());
      const reviews = capture();
      h.pipeline.handleCouncilCheckpoint(GROUP, checkpoint(1, "chk_1", GROUP, ["src/a.ts", "src/b.ts"]));
      // A directory listing is activity, not a read of a changed file.
      h.ledger.onAssistant(OBSERVER, toolUse("Bash", { command: "ls src" }));
      h.pipeline.handleCouncilReview(GROUP, review("chk_1"));
      expect(reviews[0]).toMatchObject({ artifactsChanged: 2, artifactsRead: 0 });
    });

    it("Claude Read and a Codex shell read of changed files are both counted", () => {
      const h = makeHarness();
      h.setCoordinator(activeCoordinator());
      const reviews = capture();
      h.pipeline.handleCouncilCheckpoint(GROUP, checkpoint(1, "chk_1", GROUP, ["src/a.ts", "src/b.ts"]));
      h.ledger.onAssistant(OBSERVER, toolUse("Read", { file_path: join(h.cwd, "src/a.ts") }));
      // Codex commandExecution items arrive as a Bash tool_use.
      h.ledger.onAssistant(OBSERVER, toolUse("Bash", { command: "sed -n '1,80p' src/b.ts" }));
      h.pipeline.handleCouncilReview(GROUP, review("chk_1"));
      expect(reviews[0]).toMatchObject({ artifactsChanged: 2, artifactsRead: 2 });
    });

    it("reads recorded for an older wake do not count for a newer checkpoint", () => {
      const h = makeHarness();
      h.setCoordinator(activeCoordinator());
      const reviews = capture();
      h.pipeline.handleCouncilCheckpoint(GROUP, checkpoint(1, "chk_1", GROUP, ["src/a.ts"]));
      h.ledger.onAssistant(OBSERVER, toolUse("Read", { file_path: "src/a.ts" }));
      h.pipeline.handleCouncilCheckpoint(GROUP, checkpoint(2, "chk_2", GROUP, ["src/a.ts"]));
      h.pipeline.handleCouncilReview(GROUP, review("chk_2"));
      expect(reviews[0]).toMatchObject({ artifactsRead: 0 });
    });
  });

  // P4/OBS-AUTOHEAL: an `adapter_missing` skip is handed to the injected
  // hook (the orchestrator routes it to the scheduler's catch-up poll, which
  // auto-heals the observer). Other skips — e.g. a disconnected socket, which
  // the reconnect path owns — must NOT trigger it.
  it("hands an adapter_missing skip to onObserverAdapterMissing, and only that skip", () => {
    const hook = vi.fn();
    const h = makeHarness({ onObserverAdapterMissing: hook });
    h.setCoordinator(activeCoordinator());
    h.send.mockReturnValueOnce({ kind: "adapter_missing" } as never);
    const outcome = h.pipeline.dispatchObserverWake(GROUP, checkpoint(1));
    expect(outcome).toEqual({ kind: "skipped", reason: "adapter_missing" });
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook.mock.calls[0][0]).toBe(GROUP);
    expect(hook.mock.calls[0][1].checkpoint_id).toBe("chk_1");

    h.send.mockReturnValueOnce({ kind: "socket_disconnected" } as never);
    h.pipeline.dispatchObserverWake(GROUP, checkpoint(2));
    expect(hook).toHaveBeenCalledTimes(1);
  });
});

// BENCH-H: group-less observer review files + host-stamped observer model.
describe("CouncilCheckpointPipeline — group-less reviews and host model (BENCH-H)", () => {
  const ownReview = (overrides: Record<string, unknown> = {}) => ({
    schema_version: 1,
    checkpoint_id: "chk_1",
    phase: "council-plan",
    session_group_id: GROUP,
    reviewed_at: "2026-01-01T00:00:00Z",
    observer_provider: "codex",
    observer_model: "gpt-5-codex",
    observer_cli_version: "1",
    findings: [],
    ...overrides,
  });
  const codexFrame = (text: string) => ({
    type: "assistant",
    message: { content: [{ type: "text", text }], model: "gpt-5.5" },
  });
  function captureReviews() {
    const reviews: Array<{ checkpointId: string; observerModel: string }> = [];
    cleanups.push(companionBus.on("group:review", (e) => { reviews.push(e); }));
    return reviews;
  }
  function spyWarn() {
    const spy = vi.spyOn(log, "warn");
    cleanups.push(() => spy.mockRestore());
    return () => spy.mock.calls.map((c) => c[2] as Record<string, unknown> | undefined);
  }

  // An observer-written file's self-reported model loses to the model the
  // observer session's own frames carried; the mismatch is a structured
  // EC-9-shaped event (event + sessionGroupId + sessionId + role).
  it("stamps the host-observed model over the file's self-report and logs the mismatch", () => {
    const h = makeHarness();
    h.setCoordinator(activeCoordinator());
    const reviews = captureReviews();
    const warns = spyWarn();
    h.pipeline.handleCouncilCheckpoint(GROUP, checkpoint(1));
    h.capture.onAssistant(OBSERVER, codexFrame("reading"));
    h.pipeline.handleCouncilReview(GROUP, ownReview() as never);
    expect(reviews.map((r) => r.observerModel)).toEqual(["gpt-5.5"]);
    expect(warns()).toContainEqual(expect.objectContaining({
      event: "council.review.observer_model_mismatch",
      sessionGroupId: GROUP,
      sessionId: OBSERVER,
      role: "observer",
      reportedModel: "gpt-5-codex",
      hostModel: "gpt-5.5",
    }));
  });

  // No host fact (no frame observed, e.g. recovered after a restart): the
  // file's value stands and nothing is logged — never invent a model.
  it("keeps the file's model when the host observed none", () => {
    const h = makeHarness();
    h.setCoordinator(activeCoordinator());
    const reviews = captureReviews();
    const warns = spyWarn();
    h.pipeline.handleCouncilReview(GROUP, ownReview() as never);
    expect(reviews.map((r) => r.observerModel)).toEqual(["gpt-5-codex"]);
    expect(warns().some((d) => d?.event === "council.review.observer_model_mismatch")).toBe(false);
  });

  // End-to-end through the pipeline seam with production-equivalent capture
  // deps: a codex observer writes `council-plan-codex-observer.md` (no group
  // segment) and replies with prose. finalizeObserverReply adopts it under
  // the canonical name and logs a structured adoption + model-mismatch event.
  it("finalizeObserverReply adopts a group-less codex file and logs it structurally", () => {
    const h = makeHarness({
      captureDeps: {
        writeReview: (path, payload) => writeAtomicJson(path, payload),
        findExistingReview: (directory, checkpointId, sessionGroupId) =>
          findOwnReviewForCheckpointSync({ directory, checkpointId, sessionGroupId }),
        moveAside: (directory, file, asideName) => renameSync(join(directory, file), join(directory, asideName)),
      },
    });
    h.meta.get(GROUP)!.pairing = "claude+codex";
    h.setCoordinator(activeCoordinator());
    const warns = spyWarn();
    h.pipeline.handleCouncilCheckpoint(GROUP, checkpoint(1));
    const reviewsDir = join(h.cwd, ".council", "reviews");
    mkdirSync(reviewsDir, { recursive: true });
    writeFileSync(join(reviewsDir, "council-plan-codex-observer.md"), JSON.stringify(ownReview()));
    h.capture.onAssistant(OBSERVER, codexFrame("Review written."));
    h.pipeline.finalizeObserverReply(GROUP, OBSERVER);

    const canonical = `council-plan-${GROUP}-codex-observer.md`;
    expect(JSON.parse(readFileSync(join(reviewsDir, canonical), "utf-8"))).toMatchObject({
      session_group_id: GROUP, checkpoint_id: "chk_1", observer_model: "gpt-5.5",
    });
    expect(existsSync(join(reviewsDir, "council-plan-codex-observer.md"))).toBe(false);
    expect(warns()).toContainEqual(expect.objectContaining({
      event: "council.observer_reply.groupless_review_adopted",
      sessionGroupId: GROUP, sessionId: OBSERVER, role: "observer",
      file: canonical, sourceFile: "council-plan-codex-observer.md",
    }));
    expect(warns()).toContainEqual(expect.objectContaining({
      event: "council.review.observer_model_mismatch", source: "groupless_file",
      sessionGroupId: GROUP, sessionId: OBSERVER, role: "observer",
    }));
  });

  // Deadline rescan: a neighbour's same-checkpoint review listed first by
  // readdir must not mask our own review on disk (it used to degrade the group
  // with `foreign_group_review` while our review sat next to it).
  it("deadline rescan recovers our own review even when a foreign one sorts first", () => {
    const h = makeHarness();
    const coordinator = activeCoordinator();
    h.setCoordinator(coordinator);
    const reviews = captureReviews();
    h.pipeline.handleCouncilCheckpoint(GROUP, checkpoint(1));
    const reviewsDir = join(h.cwd, ".council", "reviews");
    mkdirSync(reviewsDir, { recursive: true });
    // readdir order is filesystem-defined; several foreign names written
    // AFTER ours put a foreign file before ours in practice (verified: this
    // test fails against the first-match rescan on ext4). The assertion
    // holds for ANY order — that order-independence is the fix.
    writeFileSync(join(reviewsDir, `council-plan-${GROUP}-codex-observer.md`), JSON.stringify(ownReview()));
    for (const p of ["aaa", "mmm", "zzz", "council-plan"]) {
      writeFileSync(join(reviewsDir, `${p}-grp_other-codex-observer.md`), JSON.stringify(ownReview({ session_group_id: "grp_other" })));
    }
    h.pipeline.handleReviewDeadlineExpired(GROUP, "chk_1");
    expect(reviews.map((r) => r.checkpointId)).toEqual(["chk_1"]);
    expect(coordinator.applyEvent).not.toHaveBeenCalled();
  });

  // Observed live (grp_879b81b6, 2026-10-15): a checkpoint REDELIVERY found
  // the review from the PREVIOUS delivery on disk (written 13:58, wake
  // dispatched 15:04) and "recovered" it as the answer to the new wake. A
  // review whose file mtime predates the watchdog arming cannot be a reply
  // to this wake — ignore it and degrade with the honest reason.
  it("deadline rescan ignores a review that predates the wake and degrades the group", () => {
    const h = makeHarness();
    const coordinator = activeCoordinator();
    h.setCoordinator(coordinator);
    const reviews = captureReviews();
    const warns = spyWarn();
    // Review from a previous delivery of the same checkpoint id, 60s old.
    // It is a tooling refusal (OBSERVER-BLOCKED) — not an answer, so the
    // redelivered wake still fires (observer rigor: a real review on disk
    // would suppress the redelivery altogether, see `already_reviewed`).
    const reviewsDir = join(h.cwd, ".council", "reviews");
    mkdirSync(reviewsDir, { recursive: true });
    const file = join(reviewsDir, `council-plan-${GROUP}-codex-observer.md`);
    writeFileSync(file, JSON.stringify(ownReview({
      findings: [{ severity: "INFO", claim: "OBSERVER-BLOCKED: shell: bwrap: Operation not permitted", evidence_path: "a.ts" }],
    })));
    const past = new Date(Date.now() - 60_000);
    utimesSync(file, past, past);
    // Redelivered wake arms the watchdog NOW; the stale file predates it.
    h.pipeline.handleCouncilCheckpoint(GROUP, checkpoint(1));
    h.pipeline.handleReviewDeadlineExpired(GROUP, "chk_1");
    expect(reviews).toHaveLength(0);
    expect(coordinator.applyEvent).toHaveBeenCalledWith(GROUP, expect.objectContaining({
      type: "half_died",
      role: "observer",
      reason: "wake_produced_no_review",
    }));
    expect(warns()).toContainEqual(expect.objectContaining({
      event: "council.review.stale_review_ignored_at_deadline",
      sessionGroupId: GROUP,
      checkpointId: "chk_1",
    }));
  });

  // Observer review of this very change (checkpoint 149, STOP): the LIVE
  // handler path had the same blindness as the rescan — a delayed/replayed
  // watcher callback carrying the PREVIOUS delivery's review file would
  // disarm the fresh wake's watchdog and fan the old findings out. The
  // freshness guard must run BEFORE any mutation.
  it("handleCouncilReview rejects a review whose mtime predates the armed wake (stale replay)", () => {
    const h = makeHarness();
    const coordinator = activeCoordinator();
    h.setCoordinator(coordinator);
    const reviews = captureReviews();
    const warns = spyWarn();
    h.pipeline.handleCouncilCheckpoint(GROUP, checkpoint(1));
    // Replayed watcher event: file mtime 60s BEFORE the wake armed.
    h.pipeline.handleCouncilReview(GROUP, ownReview() as never, Date.now() - 60_000);
    expect(reviews).toHaveLength(0);
    // Watchdog stays armed — the fresh wake is still owed its review.
    expect(h.watchers.get(GROUP)!.pendingReviewDeadline?.checkpointId).toBe("chk_1");
    expect(warns()).toContainEqual(expect.objectContaining({
      event: "council.review.stale_review_ignored",
      sessionGroupId: GROUP,
      checkpointId: "chk_1",
    }));
    // A fresh review for the same checkpoint is then accepted normally.
    h.pipeline.handleCouncilReview(GROUP, ownReview() as never, Date.now());
    expect(reviews.map((r) => r.checkpointId)).toEqual(["chk_1"]);
    expect(h.watchers.get(GROUP)!.pendingReviewDeadline).toBeNull();
  });
});


// ── Observer rigor (2026-10-16) ──────────────────────────────────────────────
describe("CouncilCheckpointPipeline — observer rigor", () => {
  function spyInfo() {
    const spy = vi.spyOn(log, "info");
    cleanups.push(() => spy.mockRestore());
    return () => spy.mock.calls.map((c) => c[2] as Record<string, unknown>);
  }
  function writeOwnReview(cwd: string, checkpointId: string, findings: unknown[] = [], mtime?: Date) {
    const dir = join(cwd, ".council", "reviews");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `council-plan-${GROUP}-claude-observer.md`);
    writeFileSync(file, JSON.stringify({
      schema_version: 1, checkpoint_id: checkpointId, phase: "council-plan", session_group_id: GROUP,
      reviewed_at: "2026-10-15T10:00:00Z", observer_provider: "claude", observer_model: "m", observer_cli_version: "1",
      observer_wake_payload_version_echo: 1, findings,
    }));
    if (mtime) utimesSync(file, mtime, mtime);
  }

  // Prod 2026-10-13..16: the sentinel is cleared on every degrade/exit, so
  // each restart re-woke checkpoints 146/153 although their reviews were on
  // disk. The review file is the durable proof of "answered".
  it("does not wake for a checkpoint whose fresh review is already on disk (already_reviewed)", () => {
    const h = makeHarness();
    h.setCoordinator(activeCoordinator());
    writeOwnReview(h.cwd, "chk_1");
    const infos = spyInfo();
    const out = h.pipeline.dispatchObserverWake(GROUP, checkpoint(1));
    expect(out).toEqual({ kind: "skipped", reason: "already_reviewed" });
    expect(h.send).not.toHaveBeenCalled();
    expect(infos()).toContainEqual(expect.objectContaining({ event: "group.observer_wake_skipped", reason: "already_reviewed", checkpointId: "chk_1" }));
  });

  it("a review older than the checkpoint's emission, or a tooling refusal, does not count as reviewed", () => {
    const h = makeHarness();
    h.setCoordinator(activeCoordinator());
    // mtime a day before emitted_at (2026-01-01) → stale.
    writeOwnReview(h.cwd, "chk_1", [], new Date("2025-12-31T00:00:00Z"));
    expect(h.pipeline.dispatchObserverWake(GROUP, checkpoint(1))).toMatchObject({ kind: "dispatched" });

    const h2 = makeHarness();
    h2.setCoordinator(activeCoordinator());
    writeOwnReview(h2.cwd, "chk_1", [{ severity: "INFO", claim: "OBSERVER-BLOCKED: bwrap: Operation not permitted", evidence_path: "a.ts" }]);
    expect(h2.pipeline.dispatchObserverWake(GROUP, checkpoint(1))).toMatchObject({ kind: "dispatched" });
  });

  // Concurrent deliveries of the same checkpoint (catch-up + failsafe + a
  // re-arm after the sentinel was cleared) must not run two reviews at once.
  it("a second wake for the checkpoint already in flight is skipped (wake_in_flight)", () => {
    const h = makeHarness();
    h.setCoordinator(activeCoordinator());
    expect(h.pipeline.dispatchObserverWake(GROUP, checkpoint(1))).toMatchObject({ kind: "dispatched" });
    // The durable sentinel is gone (degrade cleared it) — only the in-flight gate is left.
    rmSync(join(h.cwd, ".council", "state"), { recursive: true, force: true });
    expect(h.pipeline.dispatchObserverWake(GROUP, checkpoint(1))).toEqual({ kind: "skipped", reason: "wake_in_flight" });
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  // Prod 2026-10-15: a liveness probe's prose reply surfaced on the findings
  // channel. A wake dispatched while the probe's turn runs would capture the
  // probe's prose as its reply — it is queued and drained afterwards.
  it("queues the wake behind a running liveness probe and drains it after", () => {
    let probing = true;
    const h = makeHarness({ pipelineDeps: { isObserverProbeInFlight: () => probing } });
    h.setCoordinator(activeCoordinator());
    expect(h.pipeline.dispatchObserverWake(GROUP, checkpoint(1))).toEqual({ kind: "skipped", reason: "probe_in_flight" });
    expect(h.send).not.toHaveBeenCalled();
    expect(h.watchers.get(GROUP)!.pendingCheckpoint?.checkpoint_id).toBe("chk_1");
    probing = false;
    h.pipeline.drainPendingObserverWake(GROUP);
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it("a wake turn that ends with probe prose is a probe_turn: watchdog disarmed, no review", () => {
    const h = makeHarness();
    h.setCoordinator(activeCoordinator());
    const reviews: unknown[] = [];
    cleanups.push(companionBus.on("group:review", (e) => { reviews.push(e); }));
    h.pipeline.dispatchObserverWake(GROUP, checkpoint(1));
    h.capture.noteProbe(OBSERVER);
    h.capture.onAssistant(OBSERVER, { type: "assistant", message: { content: [{ type: "text", text: "Я Observer, независимый ревьюер Council." }] } });
    h.pipeline.finalizeObserverReply(GROUP, OBSERVER);
    expect(h.watchers.get(GROUP)!.pendingReviewDeadline).toBeNull();
    expect(reviews).toHaveLength(0);
  });

  // Prod 2026-10-13..16: Russian-speaking user, English claims.
  it("names the claim language in the wake when the resolver returns one", () => {
    const h = makeHarness({ pipelineDeps: { resolveClaimLanguage: () => "ru" } });
    h.setCoordinator(activeCoordinator());
    h.pipeline.dispatchObserverWake(GROUP, checkpoint(1));
    const body = h.send.mock.calls[0]![1] as string;
    expect(body).toContain("Write every `claim` in Russian (русский)");
    expect(body).toContain("verbatim");
  });

  it("omits the language line without a resolver verdict, and a throwing resolver never blocks the wake", () => {
    const h = makeHarness({ pipelineDeps: { resolveClaimLanguage: () => { throw new Error("boom"); } } });
    h.setCoordinator(activeCoordinator());
    expect(h.pipeline.dispatchObserverWake(GROUP, checkpoint(1))).toMatchObject({ kind: "dispatched" });
    expect(h.send.mock.calls[0]![1] as string).not.toContain("Write every `claim` in");
  });

  it("group:review carries the host's `unverified` verdict", () => {
    const h = makeHarness();
    h.setCoordinator(activeCoordinator());
    const reviews: Array<{ verification?: string }> = [];
    cleanups.push(companionBus.on("group:review", (e) => { reviews.push(e); }));
    h.pipeline.handleCouncilCheckpoint(GROUP, checkpoint(1, "chk_1", GROUP, ["docs/plan.md"]));
    h.pipeline.handleCouncilReview(GROUP, {
      schema_version: 1, checkpoint_id: "chk_1", phase: "council-plan", session_group_id: GROUP,
      reviewed_at: "2026-10-15T10:00:00Z", observer_provider: "claude", observer_model: "m", observer_cli_version: "1",
      observer_wake_payload_version_echo: 1, findings: [], host_verification: "unverified",
    } as never, Date.now());
    expect(reviews).toEqual([expect.objectContaining({ verification: "unverified" })]);
  });
});

// ─── W14: unanswered wake → redelivery + auto-heal hand-off ──────────────────
//
// Prod 2026-10-16 (grp_879b81b6): checkpoint 158's wake was accepted but never
// answered; at the review deadline the pair degraded and NOTHING re-queued
// 158 or asked for a relaunch. Checkpoint 159 then arrived while degraded and
// was dropped (`group_not_active`). These tests pin the pipeline side of the
// fix: the owed checkpoint is re-queued, the orchestrator is told to heal, a
// checkpoint arriving while degraded is kept, and a silent-wake report from
// the adapter converges on the same path.
describe("W14 unanswered observer wake", () => {
  const CP158 = "council-review-158-pr366-drift-reply-delivery";
  const CP159 = "council-review-159-pr366-drift-reply-delivery-retry";

  function dispatched(onUnanswered = vi.fn()) {
    const h = makeHarness({ pipelineDeps: { onObserverWakeUnanswered: onUnanswered } });
    const coord = activeCoordinator();
    h.setCoordinator(coord);
    h.pipeline.handleCouncilCheckpoint(GROUP, checkpoint(158, CP158));
    expect(h.watchers.get(GROUP)!.pendingReviewDeadline?.checkpointId).toBe(CP158);
    return { h, coord, onUnanswered };
  }

  // (b) deadline expiry with no review on disk: degrade as before, PLUS the
  // owed checkpoint goes back into the pending slot and the orchestrator is
  // asked to auto-heal the observer.
  it("re-queues the owed checkpoint and requests auto-heal when the review deadline expires", () => {
    const { h, coord, onUnanswered } = dispatched();
    h.pipeline.handleReviewDeadlineExpired(GROUP, CP158);
    expect(coord.applyEvent).toHaveBeenCalledWith(GROUP, { type: "half_died", role: "observer", reason: "wake_produced_no_review" });
    expect(h.watchers.get(GROUP)!.pendingCheckpoint?.checkpoint_id).toBe(CP158);
    // Same-id re-queue is not a supersede.
    expect(h.watchers.get(GROUP)!.supersededCheckpointIds).toEqual([]);
    expect(onUnanswered).toHaveBeenCalledWith(GROUP, OBSERVER, CP158);
  });

  // (a)/(b) the adapter reported the wake turn silent: degrade with the
  // honest reason now (not `wake_send_failed`), disarm the deadline so it
  // cannot fire a second verdict, re-queue and request auto-heal.
  it("routes an adapter silent-wake report to wake_produced_no_review + redelivery", () => {
    const { h, coord, onUnanswered } = dispatched();
    h.pipeline.degradeObserverWakeFailure(GROUP, OBSERVER, "observer wake silent for 120s", "async", "silent");
    expect(coord.applyEvent).toHaveBeenCalledWith(GROUP, { type: "half_died", role: "observer", reason: "wake_produced_no_review" });
    expect(h.watchers.get(GROUP)!.pendingReviewDeadline).toBeNull();
    expect(h.watchers.get(GROUP)!.pendingCheckpoint?.checkpoint_id).toBe(CP158);
    expect(onUnanswered).toHaveBeenCalledWith(GROUP, OBSERVER, CP158);
  });

  // A plain send failure keeps its old meaning and does NOT trigger the
  // unanswered-wake recovery (the transport-close path owns that case).
  it("keeps wake_send_failed semantics for a send failure", () => {
    const { h, coord, onUnanswered } = dispatched();
    h.pipeline.degradeObserverWakeFailure(GROUP, OBSERVER, "Transport closed", "async");
    expect(coord.applyEvent).toHaveBeenCalledWith(GROUP, { type: "half_died", role: "observer", reason: "wake_send_failed" });
    expect(onUnanswered).not.toHaveBeenCalled();
  });

  // (c) prod 12:09:55 — checkpoint 159 arrived while the pair was degraded and
  // was dropped. Now it is kept (newest-wins) for the recovery drain.
  it("queues a checkpoint that arrives while the pair is degraded instead of dropping it", () => {
    const h = makeHarness();
    h.setCoordinator(activeCoordinator("degraded"));
    const out = h.pipeline.handleCouncilCheckpoint(GROUP, checkpoint(159, CP159));
    void out;
    expect(h.send).not.toHaveBeenCalled();
    expect(h.watchers.get(GROUP)!.pendingCheckpoint?.checkpoint_id).toBe(CP159);
    // Recovery: the pair is active again → the drain delivers 159.
    h.setCoordinator(activeCoordinator("active"));
    h.pipeline.drainPendingObserverWake(GROUP);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.watchers.get(GROUP)!.pendingCheckpoint).toBeNull();
  });

  // Archived pairs are gone for good — still dropped.
  it("still drops a checkpoint for an archived pair", () => {
    const h = makeHarness();
    h.setCoordinator(activeCoordinator("archived"));
    h.pipeline.dispatchObserverWake(GROUP, checkpoint(159, CP159));
    expect(h.watchers.get(GROUP)!.pendingCheckpoint).toBeNull();
  });

  // (a) the codex fresh-thread retry gets a full review window: the deadline
  // for the same checkpoint restarts instead of degrading mid-retry.
  it("re-arms the review deadline for a wake retry", () => {
    vi.useFakeTimers();
    try {
      const { h, coord } = dispatched();
      vi.advanceTimersByTime(200_000);
      h.pipeline.rearmReviewDeadlineForRetry(GROUP);
      vi.advanceTimersByTime(200_000); // 400s after the first delivery
      expect(coord.applyEvent).not.toHaveBeenCalled();
      expect(h.watchers.get(GROUP)!.pendingReviewDeadline?.checkpointId).toBe(CP158);
      vi.advanceTimersByTime(101_000); // >300s after the retry
      expect(coord.applyEvent).toHaveBeenCalledWith(GROUP, { type: "half_died", role: "observer", reason: "wake_produced_no_review" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("CouncilCheckpointPipeline — council budget guard", () => {
  // Budget guard: once the pair crossed its token budget, a checkpoint must
  // NOT wake the observer (automatic spend), but must not be lost either —
  // it waits in the newest-wins pending slot until a human continues.
  it("queues instead of waking while the budget is exceeded, and drains after continue", () => {
    let exceeded = true;
    const h = makeHarness({ pipelineDeps: { isBudgetExceeded: () => exceeded } });
    h.setCoordinator(activeCoordinator());

    const outcome = h.pipeline.dispatchObserverWake(GROUP, checkpoint(1));
    expect(outcome).toEqual({ kind: "skipped", reason: "budget_exceeded" });
    expect(h.send).not.toHaveBeenCalled();
    expect(h.watchers.get(GROUP)!.pendingCheckpoint?.checkpoint_id).toBe("chk_1");

    // A second checkpoint while paused supersedes the first (newest-wins).
    h.pipeline.dispatchObserverWake(GROUP, checkpoint(2));
    expect(h.watchers.get(GROUP)!.pendingCheckpoint?.checkpoint_id).toBe("chk_2");

    // Continue → the drain delivers the newest checkpoint.
    exceeded = false;
    h.pipeline.drainPendingObserverWake(GROUP);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.watchers.get(GROUP)!.pendingCheckpoint).toBeNull();
  });

  // The guard sits after the lifecycle gates: an archived/unknown group still
  // drops (nothing to resume), so a paused-then-archived pair leaks nothing.
  it("does not queue for a group that is not active or degraded", () => {
    const h = makeHarness({ pipelineDeps: { isBudgetExceeded: () => true } });
    h.setCoordinator(activeCoordinator("archived"));
    const outcome = h.pipeline.dispatchObserverWake(GROUP, checkpoint(1));
    expect(outcome).toEqual({ kind: "skipped", reason: "group_not_active" });
    expect(h.watchers.get(GROUP)!.pendingCheckpoint).toBeNull();
  });

  // EC-9: the skip is one structured line with group, session and role.
  it("logs the skip as an EC-9 structured line", () => {
    const info = vi.spyOn(log, "info");
    cleanups.push(() => info.mockRestore());
    const h = makeHarness({ pipelineDeps: { isBudgetExceeded: () => true } });
    h.setCoordinator(activeCoordinator());
    h.pipeline.dispatchObserverWake(GROUP, checkpoint(1));
    const call = info.mock.calls.find((c) => (c[2] as { reason?: string } | undefined)?.reason === "budget_exceeded");
    expect(call?.[2]).toMatchObject({
      event: "group.observer_wake_skipped",
      sessionGroupId: GROUP,
      sessionId: OBSERVER,
      role: "observer",
      queued: true,
    });
  });
});
