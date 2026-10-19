import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Silence the structured logger; individual tests assert on emitted events.
const logSpy = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("./logger.js", () => ({ log: logSpy }));

import {
  DeliveryMetrics,
  MAX_TRACKED_SESSIONS,
  isFirstOutputFrame,
  isNoResponseRequestedReply,
  matchNudge,
} from "./delivery-metrics.js";

// Frame builders mirroring the normalized backend → browser frames the
// bridge sees for both Claude and Codex.
const delta = (text = "hi") => ({
  type: "stream_event",
  event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  parent_tool_use_id: null,
});
const messageStart = () => ({ type: "stream_event", event: { type: "message_start", message: {} }, parent_tool_use_id: null });
const assistant = (text: string) => ({
  type: "assistant",
  message: { id: "m1", role: "assistant", content: [{ type: "text", text }] },
});
// Arbitrary frame literal (classification only reads `type` + a few fields).
const frame = (f: { type: string } & Record<string, unknown>) => f;
const result = (extra: Record<string, unknown> = {}) => ({ type: "result", data: { is_error: false, ...extra } });

function events(level: "info" | "warn"): string[] {
  return logSpy[level].mock.calls.map((c) => (c[2] as { event?: string } | undefined)?.event ?? "");
}

describe("matchNudge", () => {
  // The proxy metric for "the user felt ignored": short RU/EN re-asks seen in
  // real sessions. Only whole short messages count, never long prompts.
  it.each([
    ["жду", "ru_zhdu"],
    ["Жду ответа", "ru_zhdu"],
    ["ну жду", "ru_zhdu"],
    ["ответишь?", "ru_otvetish"],
    ["ты тут?", "ru_ty_tut"],
    ["Ты где", "ru_ty_tut"],
    ["ау", "ru_au"],
    ["ауу?", "ru_au"],
    ["алло", "ru_allo"],
    ["продолжай", "ru_prodolzhai"],
    ["Продолжаем.", "ru_prodolzhai"],
    ["ну?", "ru_nu"],
    ["где ответ?", "ru_gde_otvet"],
    ["завис?", "ru_zavis"],
    ["Are you there?", "en_are_you_there"],
    ["are you still there", "en_are_you_there"],
    ["still there?", "en_still_there"],
    ["hello?", "en_hello"],
    ["any update?", "en_any_update"],
    ["continue", "en_continue"],
    ["ping", "en_ping"],
  ])("%s → %s", (text, id) => {
    expect(matchNudge(text)).toBe(id);
  });

  it.each([
    "",
    "привет, сделай рефакторинг",
    "автоматически продолжай после лимита, если нужно — объясни в комментариях к коду, почему",
    "hello world program in rust",
    "аудит безопасности",
    "ответ неверный, переделай",
    "continue-on-error flag in CI is broken",
  ])("does not flag %j", (text) => {
    expect(matchNudge(text)).toBeNull();
  });
});

describe("frame classification", () => {
  it("counts streamed content, assistant frames and permission prompts as first output", () => {
    expect(isFirstOutputFrame(delta())).toBe(true);
    expect(isFirstOutputFrame(frame({ type: "stream_event", event: { type: "content_block_start" } }))).toBe(true);
    expect(isFirstOutputFrame(assistant("ok"))).toBe(true);
    expect(isFirstOutputFrame({ type: "permission_request" })).toBe(true);
  });

  it("does not count stream bookkeeping without content (incl. Codex synthetic interrupt delta)", () => {
    expect(isFirstOutputFrame(messageStart())).toBe(false);
    expect(isFirstOutputFrame(frame({ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "interrupted" } } }))).toBe(false);
    expect(isFirstOutputFrame(result())).toBe(false);
    expect(isFirstOutputFrame({ type: "status_change" })).toBe(false);
  });

  it("recognizes the exact \"No response requested.\" reply only", () => {
    expect(isNoResponseRequestedReply(assistant("No response requested."))).toBe(true);
    expect(isNoResponseRequestedReply(assistant("  No response requested.\n"))).toBe(true);
    expect(isNoResponseRequestedReply(assistant("No response requested"))).toBe(true);
    expect(isNoResponseRequestedReply(assistant("No response requested. But here is the fix: ..."))).toBe(false);
    // A tool call is a real answer even if the text block says otherwise.
    expect(
      isNoResponseRequestedReply(
        frame({
          type: "assistant",
          message: { content: [{ type: "text", text: "No response requested." }, { type: "tool_use", id: "t", name: "Bash", input: {} }] },
        }),
      ),
    ).toBe(false);
    expect(isNoResponseRequestedReply({ type: "result" })).toBe(false);
  });
});

describe("DeliveryMetrics", () => {
  let m: DeliveryMetrics;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    logSpy.info.mockReset();
    logSpy.warn.mockReset();
    m = new DeliveryMetrics({ stallThresholdMs: 60_000 });
  });

  afterEach(() => {
    m.reset();
    vi.useRealTimers();
  });

  it("records time to first output per session and globally", () => {
    m.recordUserMessage("s1", { text: "fix the bug", backend: "claude" });
    vi.advanceTimersByTime(3_000);
    // message_start is not content — the clock keeps running.
    m.recordBackendFrame("s1", messageStart());
    vi.advanceTimersByTime(1_000);
    m.recordBackendFrame("s1", delta());
    // Later output in the same turn does not record a second sample.
    m.recordBackendFrame("s1", assistant("done"));

    const snap = m.getSnapshot();
    expect(snap.timeToFirstOutputMs.count).toBe(1);
    expect(snap.timeToFirstOutputMs.sum).toBe(4_000);
    expect(snap.timeToFirstOutputMs.p50Bucket).toBe(5_000);
    expect(snap.global).toMatchObject({ userMessages: 1, firstOutputs: 1, stalledMessages: 0, awaitingReply: 0 });
    expect(snap.sessions.s1).toMatchObject({ backend: "claude", userMessages: 1, firstOutputs: 1, awaitingSince: null });
  });

  it("counts a message with no output within the threshold as stalled and logs it once", () => {
    m.recordUserMessage("s1", { text: "deploy", backend: "claude" });
    vi.advanceTimersByTime(59_999);
    expect(m.getSnapshot().global.stalledMessages).toBe(0);
    expect(m.getSnapshot().global.awaitingReply).toBe(1);
    vi.advanceTimersByTime(1);
    expect(m.getSnapshot().global.stalledMessages).toBe(1);
    expect(events("warn")).toContain("delivery.no_output_within_threshold");

    // The reply finally arrives: TTFT is recorded and flagged late.
    vi.advanceTimersByTime(30_000);
    m.recordBackendFrame("s1", delta());
    const snap = m.getSnapshot();
    expect(snap.global.stalledMessages).toBe(1);
    expect(snap.timeToFirstOutputMs.max).toBe(90_000);
    expect(events("warn")).toContain("delivery.late_first_output");
  });

  it("keeps the oldest unanswered message's clock when the user re-asks (nudges)", () => {
    m.recordUserMessage("s1", { text: "run the tests", backend: "claude" });
    vi.advanceTimersByTime(20_000);
    m.recordUserMessage("s1", { text: "жду", backend: "claude" });
    vi.advanceTimersByTime(5_000);
    m.recordBackendFrame("s1", delta());
    const snap = m.getSnapshot();
    expect(snap.timeToFirstOutputMs.sum).toBe(25_000);
    expect(snap.global.nudges).toBe(1);
    const nudgeCall = logSpy.info.mock.calls.find((c) => (c[2] as { event?: string }).event === "delivery.nudge_detected");
    // The nudge log carries the pattern id and wait time, never the text.
    expect(nudgeCall?.[2]).toMatchObject({ pattern: "ru_zhdu", awaitingReplyMs: 20_000 });
    expect(JSON.stringify(nudgeCall?.[2])).not.toContain("жду");
  });

  it("starts a fresh clock for a new message after the previous wait was already counted as stalled", () => {
    m.recordUserMessage("s1", { text: "a", backend: "codex" });
    vi.advanceTimersByTime(61_000);
    m.recordUserMessage("s1", { text: "b", backend: "codex" });
    vi.advanceTimersByTime(2_000);
    m.recordBackendFrame("s1", delta());
    expect(m.getSnapshot().timeToFirstOutputMs.sum).toBe(2_000);
  });

  it("only counts nudges typed by a human, not server-injected prompts", () => {
    m.recordUserMessage("s1", { text: "continue", origin: "server:cron" });
    m.recordUserMessage("s1", { text: "continue", origin: "council:peer" });
    expect(m.getSnapshot().global.nudges).toBe(0);
    m.recordUserMessage("s1", { text: "continue" });
    expect(m.getSnapshot().global.nudges).toBe(1);
  });

  it("counts \"No response requested.\" only while a real user message's turn is open", () => {
    // Background task notification turn (no user message): not counted.
    // Seen in prod recordings — a legitimate use of the phrase.
    m.recordBackendFrame("s1", assistant("No response requested."));
    m.recordUserMessage("s1", { text: "продолжаем", backend: "claude" });
    m.recordBackendFrame("s1", delta("No response"));
    m.recordBackendFrame("s1", assistant("No response requested."));
    m.recordBackendFrame("s1", result());
    // After the turn ended, a later notification turn is not counted.
    m.recordBackendFrame("s1", assistant("No response requested."));
    expect(m.getSnapshot().global.noResponseRequestedReplies).toBe(1);
    expect(m.getSnapshot().sessions.s1.noResponseRequestedReplies).toBe(1);
    expect(events("warn")).toContain("delivery.no_response_requested_reply");
  });

  it("an output-less result (init probe's interrupted turn racing a new message) does not close the user's turn", () => {
    m.recordUserMessage("s1", { text: "привет", backend: "claude" });
    // Probe turn result: is_error + aborted_streaming, no output before it.
    m.recordBackendFrame("s1", result({ is_error: true, terminal_reason: "aborted_streaming" }));
    m.recordBackendFrame("s1", assistant("No response requested."));
    const snap = m.getSnapshot();
    expect(snap.global.noResponseRequestedReplies).toBe(1);
  });

  it("user interrupt cancels the wait without counting a stall", () => {
    m.recordUserMessage("s1", { text: "long task" });
    vi.advanceTimersByTime(10_000);
    m.recordInterrupt("s1");
    vi.advanceTimersByTime(120_000);
    const snap = m.getSnapshot();
    expect(snap.global.stalledMessages).toBe(0);
    expect(snap.global.awaitingReply).toBe(0);
    expect(snap.timeToFirstOutputMs.count).toBe(0);
  });

  it("counts drift-detector recoveries per session and logs a structured event", () => {
    m.recordUserMessage("s1", { text: "x", backend: "claude" });
    vi.advanceTimersByTime(15_000);
    m.recordDriftRecovery("s1", "claude");
    m.recordDriftRecovery("s2", "claude");
    const snap = m.getSnapshot();
    expect(snap.global.driftRecoveries).toBe(2);
    expect(snap.sessions.s1.driftRecoveries).toBe(1);
    const call = logSpy.warn.mock.calls.find((c) => (c[2] as { event?: string }).event === "delivery.drift_recovery");
    expect(call?.[2]).toMatchObject({ sessionId: "s1", awaitingReplyMs: 15_000 });
  });

  it("a drift recovery counts the background tasks the kill takes down, then forgets them", () => {
    // The drift detector fires most on a CLI running many parallel
    // background subagents; killing the CLI kills them too. Frames shaped
    // like the CLI's `system.task_started` / `task_notification`.
    const started = (id: string, task_type: string) => ({ subtype: "task_started", task_id: id, task_type });
    m.recordUserMessage("s1", { text: "x", backend: "claude" });
    m.recordTaskFrame("s1", started("t1", "local_agent"));
    m.recordTaskFrame("s1", started("t2", "local_agent"));
    m.recordTaskFrame("s1", started("t3", "local_bash"));
    m.recordTaskFrame("s1", { subtype: "task_notification", task_id: "t3", status: "completed" } as never);
    m.recordTaskFrame("s1", { subtype: "task_started" }); // no task_id → ignored
    expect(m.getSnapshot().sessions.s1.runningTasks).toBe(2);

    m.recordDriftRecovery("s1", "claude");
    const snap = m.getSnapshot();
    expect(snap.sessions.s1).toMatchObject({ backgroundTasksKilled: 2, runningTasks: 0 });
    expect(snap.global.backgroundTasksKilled).toBe(2);
    const call = logSpy.warn.mock.calls.find((c) => (c[2] as { event?: string }).event === "delivery.drift_recovery");
    expect(call?.[2]).toMatchObject({ runningBackgroundTasks: 2, runningTasksByType: { local_agent: 2 } });

    // Nothing left running → a second recovery kills no tasks.
    m.recordDriftRecovery("s1", "claude");
    expect(m.getSnapshot().global.backgroundTasksKilled).toBe(2);
  });

  it("forgets running tasks when the CLI process exits on its own", () => {
    m.recordTaskFrame("s1", { subtype: "task_started", task_id: "t1", task_type: "local_agent" });
    m.clearRunningTasks("s1");
    m.recordDriftRecovery("s1", "claude");
    expect(m.getSnapshot().global.backgroundTasksKilled).toBe(0);
  });

  it("ignores frames for sessions that never had a user message", () => {
    m.recordBackendFrame("ghost", delta());
    expect(m.getSnapshot().sessions.ghost).toBeUndefined();
  });

  it("lists sessions most recently active first and bounds the map", () => {
    m.recordUserMessage("a", { text: "1" });
    m.recordUserMessage("b", { text: "1" });
    m.recordUserMessage("a", { text: "2" });
    expect(Object.keys(m.getSnapshot().sessions)).toEqual(["a", "b"]);

    for (let i = 0; i < MAX_TRACKED_SESSIONS + 5; i++) m.recordUserMessage(`s${i}`, { text: "x" });
    const ids = Object.keys(m.getSnapshot().sessions);
    expect(ids.length).toBe(MAX_TRACKED_SESSIONS);
    expect(ids).not.toContain("a");
    // Global counters are unaffected by eviction.
    expect(m.getSnapshot().global.userMessages).toBe(MAX_TRACKED_SESSIONS + 8);
    // Evicted sessions' stall timers were cleared: no stall fires for them.
    vi.advanceTimersByTime(61_000);
    expect(m.getSnapshot().global.stalledMessages).toBe(MAX_TRACKED_SESSIONS);
  });
});
