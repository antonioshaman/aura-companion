import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CouncilCheckpointPipeline,
  type CheckpointPipelineGroupMeta,
  type CouncilWatcherEntry,
} from "./council-checkpoint-pipeline.js";
import { CheckpointLineSnapshots } from "./observer-line-snapshots.js";
import { ObserverReplyCapture } from "./observer-reply.js";
import { ObserverReadLedger } from "./observer-read-ledger.js";
import { readCouncilWakeSentinel } from "./council-wake-sentinel.js";
import { companionBus } from "./event-bus.js";
import type { SessionGroupCoordinator } from "./session-group-coordinator.js";
import type { CheckpointPayload } from "./council-types.js";

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
  cwd: string;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function activeCoordinator(status = "active"): SessionGroupCoordinator {
  return { get: vi.fn(() => ({ sessionGroupId: GROUP, status })), applyEvent: vi.fn() } as unknown as SessionGroupCoordinator;
}

function makeHarness(): Harness {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "council-pipeline-")));
  const watchers = new Map<string, CouncilWatcherEntry>();
  const meta = new Map<string, CheckpointPipelineGroupMeta>();
  let coordinator: SessionGroupCoordinator | null = null;
  let apiLimited = false;
  const send = vi.fn(() => ({ kind: "sent" as const }));
  const ledger = new ObserverReadLedger();
  const pipeline = new CouncilCheckpointPipeline({
    watchers,
    groupMeta: meta,
    getCoordinator: () => coordinator,
    getWsBridge: () => ({ sendObserverWakeFrame: send }),
    isApiLimitReached: () => apiLimited,
    replyCapture: new ObserverReplyCapture({
      now: () => new Date(),
      writeReview: () => {},
      findExistingReview: () => null,
      resolveCliVersion: () => undefined,
    }),
    lineSnapshots: new CheckpointLineSnapshots(),
    readLedger: ledger,
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
    pipeline, watchers, meta, send, cwd, ledger,
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
});
