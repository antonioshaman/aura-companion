import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexAdapter, type ICodexTransport } from "./codex-adapter.js";
import { companionBus } from "./event-bus.js";
import { OBSERVER_WAKE_SILENCE_MS } from "./observer-wake-silence.js";
import { HELD_TIMEOUT_MULTIPLIER } from "./silent-stdio-watchdog.js";

/**
 * W14 — codex observer wake that is accepted and then goes silent.
 *
 * Built from the real prod frame sequence (recording
 * 17fbf63f-…_codex_2026-10-16T06-13-36.365Z_712a9b.jsonl, ts 1792152063139):
 *
 *   out  turn/start   {threadId:"01a14017-fae8-7e60-be83-18ae14fbd020", input:[wake]}
 *   in   {"id":12,"result":{"turn":{"id":"01a14496-4cab-7051-8b5f-425fd74c1b1f",
 *          "status":"inProgress",…}}}
 *   …nothing else for 13 minutes (the app-server's own log shows it emitted
 *   turn/started … turn/completed by 12:01:30 — the frames never arrived).
 *
 * Before W14 the adapter just waited: the review deadline degraded the pair at
 * +5 min, the completion watchdog released the slot at +6 min, and nobody
 * retried. These tests pin the new behaviour: after OBSERVER_WAKE_SILENCE_MS
 * without a frame the adapter interrupts the silent turn, opens a FRESH
 * thread and re-sends the same wake; a second silence (or a deaf transport
 * that cannot even start a thread) is reported as `observer:wake-failed`
 * with reason `silent`, which the orchestrator turns into degrade + auto-heal.
 */

const SILENT_THREAD = "01a14017-fae8-7e60-be83-18ae14fbd020";
const SILENT_TURN = "01a14496-4cab-7051-8b5f-425fd74c1b1f";
/** The exact turn/start reply prod received (only the turn id/status matter). */
const PROD_TURN_START_REPLY = {
  turn: {
    id: SILENT_TURN,
    rootTurnId: SILENT_TURN,
    items: [],
    itemsView: "notLoaded",
    status: "inProgress",
    error: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
  },
};
const WAKE = "# Council Checkpoint — council-review\n\nA new checkpoint has arrived. (council-review-158-pr366-drift-reply-delivery)";

interface PendingCall {
  method: string;
  params: Record<string, unknown>;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

/** Minimal ICodexTransport: every call() stays pending until the test settles it. */
function mockTransport() {
  let onNote: ((method: string, params: Record<string, unknown>) => void) | null = null;
  const calls: PendingCall[] = [];
  const transport: ICodexTransport = {
    call: vi.fn((method: string, params: Record<string, unknown> = {}) =>
      new Promise((resolve, reject) => { calls.push({ method, params, resolve, reject }); })),
    notify: vi.fn(async () => {}),
    respond: vi.fn(async () => {}),
    onNotification: vi.fn((h) => { onNote = h; }),
    onRequest: vi.fn(),
    onRawIncoming: vi.fn(),
    onRawOutgoing: vi.fn(),
    onParseError: vi.fn(),
    isConnected: vi.fn(() => true),
  };
  const last = (method: string) => [...calls].reverse().find((c) => c.method === method);
  return {
    transport,
    calls,
    last,
    /** Settle the newest pending call of `method`. */
    resolve(method: string, result: unknown) {
      const c = last(method);
      if (!c) throw new Error(`no ${method} call`);
      c.resolve(result);
    },
    reject(method: string, err: Error) {
      const c = last(method);
      if (!c) throw new Error(`no ${method} call`);
      c.reject(err);
    },
    push(method: string, params: Record<string, unknown>) {
      onNote?.(method, params);
    },
    count: (method: string) => calls.filter((c) => c.method === method).length,
  };
}

/** Let promise continuations run without moving the fake clock. */
const flush = () => vi.advanceTimersByTimeAsync(0);

async function initObserver() {
  const t = mockTransport();
  const adapter = new CodexAdapter(t.transport, "obs-17fbf63f", {
    model: "gpt-6.1-sol",
    cwd: "/tmp",
    threadId: SILENT_THREAD,
  });
  const metas: Array<{ cliSessionId?: string }> = [];
  adapter.onSessionMeta((m) => metas.push(m));
  await flush();
  t.resolve("initialize", { userAgent: "codex" });
  await flush();
  t.resolve("thread/resume", { thread: { id: SILENT_THREAD } });
  await flush();
  const rl = t.last("account/rateLimits/read");
  rl?.resolve({});
  await flush();
  return { t, adapter, metas };
}

describe("codex observer wake silence (W14)", () => {
  const offs: Array<() => void> = [];
  const wakeFailed: Array<{ sessionId: string; error: string; reason?: string }> = [];
  const retried: Array<{ previousThreadId: string | null; threadId: string }> = [];
  const turnDone: Array<{ sessionId: string }> = [];

  beforeEach(() => {
    vi.useFakeTimers();
    wakeFailed.length = 0;
    retried.length = 0;
    turnDone.length = 0;
    offs.push(companionBus.on("observer:wake-failed", (e) => { wakeFailed.push(e); }));
    offs.push(companionBus.on("observer:wake-retried", (e) => { retried.push(e); }));
    offs.push(companionBus.on("observer:turn-done", (e) => { turnDone.push(e); }));
  });
  afterEach(() => {
    while (offs.length) offs.pop()!();
    vi.useRealTimers();
  });

  // The prod sequence: accepted (inProgress) then nothing. Silence verdict →
  // turn/interrupt for the silent turn → thread/start (fresh) → the SAME wake
  // re-sent on the fresh thread, and the new thread is persisted as the
  // session's resume target.
  it("interrupts the silent turn and re-sends the same wake on a fresh thread", async () => {
    const { t, adapter, metas } = await initObserver();
    expect(adapter.sendUserFrameFromServer(WAKE)).toEqual({ kind: "sent" });
    await flush();
    t.resolve("turn/start", PROD_TURN_START_REPLY);
    await flush();

    // Just inside the window: nothing happens yet.
    await vi.advanceTimersByTimeAsync(OBSERVER_WAKE_SILENCE_MS - 1_000);
    expect(t.count("turn/interrupt")).toBe(0);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.last("turn/interrupt")?.params).toEqual({ threadId: SILENT_THREAD, turnId: SILENT_TURN });
    t.resolve("turn/interrupt", {});
    await flush();

    const freshStart = t.last("thread/start");
    expect(freshStart).toBeDefined();
    expect(freshStart!.params.model).toBe("gpt-6.1-sol");
    t.resolve("thread/start", { thread: { id: "thr_fresh" } });
    await flush();

    expect(retried).toEqual([
      expect.objectContaining({ previousThreadId: SILENT_THREAD, threadId: "thr_fresh" }),
    ]);
    expect(metas.at(-1)?.cliSessionId).toBe("thr_fresh");
    const resend = t.last("turn/start")!;
    expect(resend.params.threadId).toBe("thr_fresh");
    expect(JSON.stringify(resend.params.input)).toContain("council-review-158-pr366-drift-reply-delivery");
    expect(t.count("turn/start")).toBe(2);
    // The slot is still held for the retry; nothing was reported as failed.
    expect(adapter.sendUserFrameFromServer("next")).toEqual({ kind: "busy" });
    expect(wakeFailed).toHaveLength(0);

    // The retry answers normally → slot released through the usual path.
    t.resolve("turn/start", { turn: { id: "turn_retry", status: "inProgress" } });
    await flush();
    t.push("turn/started", { threadId: "thr_fresh", turn: { id: "turn_retry" } });
    t.push("turn/completed", { threadId: "thr_fresh", turn: { id: "turn_retry", status: "completed" } });
    await flush();
    expect(turnDone).toEqual([{ sessionId: "obs-17fbf63f" }]);
    expect(adapter.sendUserFrameFromServer("next")).toEqual({ kind: "sent" });
  });

  // The interrupted turn's late `turn/completed` (status interrupted) must not
  // be mistaken for the retry finishing — that would release the slot, emit
  // turn-done (an empty reply → rejected) and abort the retry.
  it("ignores the late turn/completed of the interrupted silent turn", async () => {
    const { t, adapter } = await initObserver();
    adapter.sendUserFrameFromServer(WAKE);
    await flush();
    t.resolve("turn/start", PROD_TURN_START_REPLY);
    await vi.advanceTimersByTimeAsync(OBSERVER_WAKE_SILENCE_MS + 1_000);

    t.push("turn/completed", { threadId: SILENT_THREAD, turn: { id: SILENT_TURN, status: "interrupted" } });
    t.resolve("turn/interrupt", {});
    await flush();
    t.resolve("thread/start", { thread: { id: "thr_fresh" } });
    await flush();

    expect(turnDone).toHaveLength(0);
    expect(t.count("turn/start")).toBe(2);
    expect(adapter.sendUserFrameFromServer("next")).toEqual({ kind: "busy" });
  });

  // Exactly ONE retry per wake: the fresh-thread delivery going silent too
  // means the problem is not the thread → give up and report it, without a
  // drain (the pair degrades and the orchestrator re-queues the checkpoint).
  it("reports observer:wake-failed (silent) when the fresh-thread retry is silent too", async () => {
    const { t, adapter } = await initObserver();
    adapter.sendUserFrameFromServer(WAKE);
    await flush();
    t.resolve("turn/start", PROD_TURN_START_REPLY);
    await vi.advanceTimersByTimeAsync(OBSERVER_WAKE_SILENCE_MS + 1_000);
    t.resolve("turn/interrupt", {});
    await flush();
    t.resolve("thread/start", { thread: { id: "thr_fresh" } });
    await flush();
    t.resolve("turn/start", { turn: { id: "turn_retry", status: "inProgress" } });
    await flush();

    await vi.advanceTimersByTimeAsync(OBSERVER_WAKE_SILENCE_MS + 1_000);
    expect(t.count("turn/interrupt")).toBe(1);
    expect(wakeFailed).toEqual([
      expect.objectContaining({ sessionId: "obs-17fbf63f", reason: "silent" }),
    ]);
    expect(turnDone).toHaveLength(0);
    expect(adapter.sendUserFrameFromServer("next")).toEqual({ kind: "sent" });
  });

  // Deaf transport (the prod failure: requests go out, nothing comes back):
  // the interrupt and the fresh thread/start both time out → report silent
  // right away instead of waiting for another silence window.
  it("reports silent immediately when a fresh thread cannot be started", async () => {
    const { t, adapter } = await initObserver();
    adapter.sendUserFrameFromServer(WAKE);
    await flush();
    t.resolve("turn/start", PROD_TURN_START_REPLY);
    await vi.advanceTimersByTimeAsync(OBSERVER_WAKE_SILENCE_MS + 1_000);
    t.reject("turn/interrupt", new Error("RPC timeout: turn/interrupt did not respond within 15000ms"));
    await flush();
    t.reject("thread/start", new Error("RPC timeout: thread/start did not respond within 30000ms"));
    await flush();

    expect(wakeFailed).toEqual([
      expect.objectContaining({ reason: "silent", error: expect.stringContaining("thread/start") }),
    ]);
    expect(t.count("turn/start")).toBe(1);
    expect(adapter.sendUserFrameFromServer("next")).toEqual({ kind: "sent" });
  });

  // A healthy turn streams frames (largest prod gap: 35 s). As long as frames
  // keep arriving, a long review is never treated as silent.
  it("never fires while the turn keeps streaming frames", async () => {
    const { t, adapter } = await initObserver();
    adapter.sendUserFrameFromServer(WAKE);
    await flush();
    t.resolve("turn/start", { turn: { id: "turn_live", status: "inProgress" } });
    await flush();
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(35_000);
      t.push("item/agentMessage/delta", { threadId: SILENT_THREAD, turnId: "turn_live", itemId: "m", delta: "." });
    }
    expect(t.count("turn/interrupt")).toBe(0);
    expect(wakeFailed).toHaveLength(0);
    t.push("turn/completed", { threadId: SILENT_THREAD, turn: { id: "turn_live", status: "completed" } });
    await flush();
    expect(turnDone).toHaveLength(1);
    // Disarmed on completion: no late verdict.
    await vi.advanceTimersByTimeAsync(OBSERVER_WAKE_SILENCE_MS * 2);
    expect(t.count("turn/interrupt")).toBe(0);
  });

  // Review WARN on PR #371: a command the observer runs (rg over a big tree, a
  // buffered test run) emits `item/started` and then NOTHING until
  // `item/completed` — `outputDelta` only arrives when there is output. That
  // quiet stretch is work, not a lost stream: while a commandExecution item is
  // open the deadline widens to HELD_TIMEOUT_MULTIPLIER x, like the Claude
  // session watchdog does for an outstanding tool_use. A genuine hang inside
  // the command is still caught at the widened deadline.
  it("does not treat a quiet 130s command as silence, but still catches a hang past the widened deadline", async () => {
    const { t, adapter } = await initObserver();
    adapter.sendUserFrameFromServer(WAKE);
    await flush();
    t.resolve("turn/start", { turn: { id: "turn_cmd", status: "inProgress" } });
    await flush();
    t.push("item/started", {
      threadId: SILENT_THREAD, turnId: "turn_cmd",
      item: { type: "commandExecution", id: "exec-1", command: "/bin/bash -lc 'rg -n foo .'" },
    });
    await vi.advanceTimersByTimeAsync(130_000);
    expect(t.count("turn/interrupt")).toBe(0);
    t.push("item/completed", {
      threadId: SILENT_THREAD, turnId: "turn_cmd",
      item: { type: "commandExecution", id: "exec-1", status: "completed" },
    });
    // Command done → back to the normal window.
    await vi.advanceTimersByTimeAsync(OBSERVER_WAKE_SILENCE_MS - 1_000);
    expect(t.count("turn/interrupt")).toBe(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.count("turn/interrupt")).toBe(1);
  });

  it("fires inside a command that hangs past the widened deadline", async () => {
    const { t, adapter } = await initObserver();
    adapter.sendUserFrameFromServer(WAKE);
    await flush();
    t.resolve("turn/start", { turn: { id: "turn_hang", status: "inProgress" } });
    await flush();
    t.push("item/started", {
      threadId: SILENT_THREAD, turnId: "turn_hang",
      item: { type: "commandExecution", id: "exec-hang", command: "/bin/bash -lc 'sleep 9999'" },
    });
    await vi.advanceTimersByTimeAsync(OBSERVER_WAKE_SILENCE_MS * HELD_TIMEOUT_MULTIPLIER - 1_000);
    expect(t.count("turn/interrupt")).toBe(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.count("turn/interrupt")).toBe(1);
  });
});
