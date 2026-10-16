/**
 * AutoResumeScheduler — one-shot "continue after the usage limit resets"
 * schedules.
 *
 * Validates: fireAt = resetAt + 60–120 s jitter; idempotence (the same limit
 * reported twice — synthetic assistant + result frames — keeps ONE schedule;
 * a NEW limit replaces it); persistence to disk and re-arm on a fresh
 * scheduler (server restart), including overdue schedules (fired after a
 * boot grace) and orphaned ones (session gone → dropped); fire-once
 * self-cleaning (the record is gone from memory AND disk before resume runs);
 * cancellation; the global setting gate; structured log events.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutoResumeScheduler, type AutoResumeHit, type AutoResumeSchedulerDeps } from "./auto-resume-scheduler.js";
import { log } from "./logger.js";

const T0 = Date.UTC(2026, 9, 16, 10, 0);

function hit(overrides: Partial<AutoResumeHit> = {}): AutoResumeHit {
  return {
    sessionId: "s1",
    backend: "claude",
    model: "claude-opus-5-5",
    resetAt: T0 + 3_600_000,
    resetSource: "rate_limit_event",
    limitType: "five_hour",
    role: "solo",
    sessionGroupId: null,
    ...overrides,
  };
}

describe("AutoResumeScheduler", () => {
  let dir: string;
  let file: string;
  let resume: ReturnType<typeof vi.fn>;
  let publish: ReturnType<typeof vi.fn>;
  let enabled: boolean;
  let resumable: Set<string>;

  function make(overrides: Partial<AutoResumeSchedulerDeps> = {}): AutoResumeScheduler {
    return new AutoResumeScheduler({
      filePath: file,
      now: () => Date.now(),
      random: () => 0.5,
      isEnabled: () => enabled,
      isSessionResumable: (id) => resumable.has(id),
      resume: resume as unknown as AutoResumeSchedulerDeps["resume"],
      publish: publish as unknown as AutoResumeSchedulerDeps["publish"],
      bootGraceMs: 30_000,
      ...overrides,
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    dir = mkdtempSync(join(tmpdir(), "auto-resume-"));
    file = join(dir, "auto-resume.json");
    resume = vi.fn(async () => ({ ok: true, outcome: "injected" }));
    publish = vi.fn();
    enabled = true;
    resumable = new Set(["s1", "s2"]);
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it("schedules at resetAt + 60..120s jitter, persists, and publishes the banner state", () => {
    const s = make();
    const sched = s.schedule(hit());
    // random()=0.5 → 60s + 30s
    expect(sched?.fireAt).toBe(T0 + 3_600_000 + 90_000);
    expect(publish).toHaveBeenCalledWith("s1", { resetAt: T0 + 3_600_000, fireAt: T0 + 3_690_000, resetSource: "rate_limit_event" });
    const disk = JSON.parse(readFileSync(file, "utf-8"));
    expect(disk.schedules).toHaveLength(1);
    expect(disk.schedules[0].sessionId).toBe("s1");
  });

  it("jitter is always within [60s, 120s]", () => {
    for (const r of [0, 0.999999]) {
      const s = make({ random: () => r });
      const sched = s.schedule(hit({ sessionId: `x${r}` }));
      const delta = (sched?.fireAt ?? 0) - (T0 + 3_600_000);
      expect(delta).toBeGreaterThanOrEqual(60_000);
      expect(delta).toBeLessThanOrEqual(120_000);
      s.dispose();
    }
  });

  it("is idempotent: the same limit reported twice keeps the first schedule", () => {
    const s = make();
    const first = s.schedule(hit());
    const second = s.schedule(hit({ resetAt: T0 + 3_600_000 + 10_000 }));
    expect(second).toEqual(first);
    expect(s.list()).toHaveLength(1);
    vi.advanceTimersByTime(3_700_000);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("a new limit hit (different reset) replaces the old schedule — only the new one fires", async () => {
    const s = make();
    s.schedule(hit());
    const replaced = s.schedule(hit({ resetAt: T0 + 7 * 3_600_000, limitType: "seven_day" }));
    expect(s.list()).toHaveLength(1);
    expect(replaced?.resetAt).toBe(T0 + 7 * 3_600_000);
    await vi.advanceTimersByTimeAsync(3_700_000);
    expect(resume).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(6 * 3_600_000);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume.mock.calls[0][0].limitType).toBe("seven_day");
  });

  it("fires once and self-cleans: memory + disk cleared before resume runs, banner cleared", async () => {
    const s = make();
    resume.mockImplementation(async () => {
      // At the moment resume runs the schedule must already be gone (fire-once
      // even if resume throws or the server dies mid-resume).
      expect(s.get("s1")).toBeUndefined();
      expect(JSON.parse(readFileSync(file, "utf-8")).schedules).toHaveLength(0);
      return { ok: true, outcome: "injected" };
    });
    s.schedule(hit());
    await vi.advanceTimersByTimeAsync(3_690_000);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenLastCalledWith("s1", null);
    await vi.advanceTimersByTimeAsync(10 * 3_600_000);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("a throwing resume does not resurrect the schedule", async () => {
    const s = make();
    resume.mockRejectedValue(new Error("boom"));
    s.schedule(hit());
    await vi.advanceTimersByTimeAsync(3_690_000);
    expect(s.list()).toHaveLength(0);
  });

  it("cancel removes the schedule, clears the banner and prevents firing", async () => {
    const s = make();
    s.schedule(hit());
    expect(s.cancel("s1", "user_message")).toBe(true);
    expect(s.cancel("s1", "user_message")).toBe(false);
    expect(publish).toHaveBeenLastCalledWith("s1", null);
    await vi.advanceTimersByTimeAsync(10 * 3_600_000);
    expect(resume).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(file, "utf-8")).schedules).toHaveLength(0);
  });

  it("does not schedule when the global setting is off", () => {
    enabled = false;
    const s = make();
    expect(s.schedule(hit())).toBeNull();
    expect(s.list()).toHaveLength(0);
  });

  it("setting switched off before the fire → cancelled at fire time, no resume", async () => {
    const s = make();
    s.schedule(hit());
    enabled = false;
    await vi.advanceTimersByTimeAsync(3_690_000);
    expect(resume).not.toHaveBeenCalled();
    expect(s.list()).toHaveLength(0);
  });

  it("cancelAll drops every schedule", () => {
    const s = make();
    s.schedule(hit());
    s.schedule(hit({ sessionId: "s2" }));
    s.cancelAll("disabled");
    expect(s.list()).toHaveLength(0);
    expect(publish).toHaveBeenCalledWith("s2", null);
  });

  describe("persistence + re-arm across restart", () => {
    it("a future schedule re-arms on a fresh scheduler at its original fireAt", async () => {
      // "restart": the first instance's timers die with it; a new instance
      // reads the same file.
      const first = make();
      first.schedule(hit());
      first.dispose();
      const restarted = make();
      expect(restarted.restore()).toBe(1);
      expect(restarted.get("s1")?.fireAt).toBe(T0 + 3_690_000);
      expect(publish).toHaveBeenLastCalledWith("s1", expect.objectContaining({ fireAt: T0 + 3_690_000 }));
      await vi.advanceTimersByTimeAsync(3_689_000);
      expect(resume).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(resume).toHaveBeenCalledTimes(1);
    });

    it("an overdue schedule (server was down at fireAt) fires after the boot grace", async () => {
      const first = make();
      first.schedule(hit());
      first.dispose();
      const later = T0 + 10 * 3_600_000;
      vi.setSystemTime(later);
      const restarted = make();
      restarted.restore();
      expect(restarted.get("s1")?.fireAt).toBe(later + 30_000);
      await vi.advanceTimersByTimeAsync(29_000);
      expect(resume).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(resume).toHaveBeenCalledTimes(1);
    });

    it("drops schedules whose session is gone/archived", () => {
      const first = make();
      first.schedule(hit());
      first.dispose();
      resumable.delete("s1");
      const restarted = make();
      expect(restarted.restore()).toBe(0);
      expect(JSON.parse(readFileSync(file, "utf-8")).schedules).toHaveLength(0);
    });

    it("a corrupt file is tolerated (empty) instead of crashing boot", () => {
      writeFileSync(file, "{not json");
      expect(make().restore()).toBe(0);
    });

    it("a missing file restores nothing", () => {
      expect(existsSync(file)).toBe(false);
      expect(make().restore()).toBe(0);
    });
  });

  it("emits structured scheduled / cancelled / fired log events", async () => {
    const info = vi.spyOn(log, "info").mockImplementation(() => {});
    const s = make();
    s.schedule(hit());
    s.cancel("s1", "user_message");
    s.schedule(hit({ sessionId: "s2", backend: "codex", model: "gpt-6.1-sol" }));
    await vi.advanceTimersByTimeAsync(3_690_000);
    const events = info.mock.calls.map((c) => (c[2] as Record<string, unknown>)?.event);
    expect(events).toEqual(
      expect.arrayContaining([
        "usage_limit.auto_resume.scheduled",
        "usage_limit.auto_resume.cancelled",
        "usage_limit.auto_resume.fired",
      ]),
    );
    const fired = info.mock.calls.find((c) => (c[2] as Record<string, unknown>)?.event === "usage_limit.auto_resume.fired")?.[2] as Record<string, unknown>;
    expect(fired).toMatchObject({ sessionId: "s2", backend: "codex", model: "gpt-6.1-sol", resetAt: new Date(T0 + 3_600_000).toISOString() });
    info.mockRestore();
  });

  it("delays longer than the 32-bit timer limit still fire at the right time", async () => {
    const s = make();
    const far = T0 + 30 * 86_400_000;
    s.schedule(hit({ resetAt: far }));
    await vi.advanceTimersByTimeAsync(29 * 86_400_000);
    expect(resume).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(86_400_000 + 120_000);
    expect(resume).toHaveBeenCalledTimes(1);
  });
});
