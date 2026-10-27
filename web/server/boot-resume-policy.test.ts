// Boot-resume policy: the age (TTL) filter and the concurrency cap that keep a
// server restart from reviving weeks-old sessions or spawning every CLI at
// once. These are the pure pieces; the wiring into
// `SessionRecovery.scheduleBootResume` is covered in session-recovery.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BootResumeLimiter,
  DEFAULT_BOOT_RESUME_CONCURRENCY,
  DEFAULT_BOOT_RESUME_MAX_AGE_HOURS,
  DEFAULT_BOOT_RESUME_SLOT_TIMEOUT_MS,
  lastActivityAt,
  parseBootResumeConcurrency,
  parseBootResumeMaxAgeHours,
  parseBootResumeSlotTimeoutMs,
  staleAgeHours,
} from "./boot-resume-policy.js";

const HOUR = 3_600_000;

describe("parseBootResumeMaxAgeHours", () => {
  // Default 72 h when unset/blank; 0 is a valid value meaning "filter off";
  // fractional hours are allowed; garbage or negative falls back to the default
  // instead of silently disabling the filter.
  it("parses valid values, keeps 0 as 'disabled', falls back on invalid", () => {
    expect(parseBootResumeMaxAgeHours(undefined)).toBe(DEFAULT_BOOT_RESUME_MAX_AGE_HOURS);
    expect(DEFAULT_BOOT_RESUME_MAX_AGE_HOURS).toBe(72);
    expect(parseBootResumeMaxAgeHours("")).toBe(72);
    expect(parseBootResumeMaxAgeHours("24")).toBe(24);
    expect(parseBootResumeMaxAgeHours("0.5")).toBe(0.5);
    expect(parseBootResumeMaxAgeHours("0")).toBe(0);
    expect(parseBootResumeMaxAgeHours("-1")).toBe(72);
    expect(parseBootResumeMaxAgeHours("abc")).toBe(72);
    expect(parseBootResumeMaxAgeHours("Infinity")).toBe(72);
  });
});

describe("parseBootResumeConcurrency", () => {
  // Default 3; only positive integers accepted. 0 would deadlock the queue,
  // so it falls back to the default like any other invalid value.
  it("accepts positive integers only", () => {
    expect(parseBootResumeConcurrency(undefined)).toBe(DEFAULT_BOOT_RESUME_CONCURRENCY);
    expect(DEFAULT_BOOT_RESUME_CONCURRENCY).toBe(3);
    expect(parseBootResumeConcurrency("1")).toBe(1);
    expect(parseBootResumeConcurrency("8")).toBe(8);
    expect(parseBootResumeConcurrency("0")).toBe(3);
    expect(parseBootResumeConcurrency("-2")).toBe(3);
    expect(parseBootResumeConcurrency("2.5")).toBe(3);
    expect(parseBootResumeConcurrency("x")).toBe(3);
  });
});

describe("parseBootResumeSlotTimeoutMs", () => {
  it("accepts positive numbers, falls back otherwise", () => {
    expect(parseBootResumeSlotTimeoutMs(undefined)).toBe(DEFAULT_BOOT_RESUME_SLOT_TIMEOUT_MS);
    expect(parseBootResumeSlotTimeoutMs("5000")).toBe(5000);
    expect(parseBootResumeSlotTimeoutMs("0")).toBe(DEFAULT_BOOT_RESUME_SLOT_TIMEOUT_MS);
    expect(parseBootResumeSlotTimeoutMs("nope")).toBe(DEFAULT_BOOT_RESUME_SLOT_TIMEOUT_MS);
  });
});

describe("lastActivityAt", () => {
  // The newest timestamped history entry wins over createdAt (a session created
  // weeks ago but chatted with today is fresh). Entries without a timestamp
  // (e.g. `result` frames) are ignored.
  it("uses the newest message timestamp", () => {
    const history = [
      { type: "user_message", timestamp: 1_000 },
      { type: "result" },
      { type: "assistant", timestamp: 5_000 },
      { type: "user_message", timestamp: 3_000 },
    ];
    expect(lastActivityAt(history, 10)).toBe(5_000);
  });

  // No timestamped entry → createdAt; nothing usable (createdAt 0/missing) →
  // undefined, which the caller treats as "unknown age, do not filter".
  it("falls back to createdAt, then to undefined", () => {
    expect(lastActivityAt([{ type: "result" }], 42)).toBe(42);
    expect(lastActivityAt(undefined, 42)).toBe(42);
    expect(lastActivityAt([], 0)).toBeUndefined();
    expect(lastActivityAt(undefined, undefined)).toBeUndefined();
  });
});

describe("staleAgeHours", () => {
  const now = 1_000 * HOUR;

  it("flags sessions older than the threshold with their age", () => {
    expect(staleAgeHours(now - 100 * HOUR, 72, now)).toBe(100);
  });

  it("keeps fresh sessions, the exact boundary, unknown ages, and everything when disabled", () => {
    expect(staleAgeHours(now - 2 * HOUR, 72, now)).toBeNull();
    expect(staleAgeHours(now - 72 * HOUR, 72, now)).toBeNull();
    expect(staleAgeHours(undefined, 72, now)).toBeNull();
    // maxAgeHours = 0 disables the filter entirely.
    expect(staleAgeHours(now - 10_000 * HOUR, 0, now)).toBeNull();
  });
});

describe("BootResumeLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Core invariant: no matter how many tasks are queued, at most `max` run at
  // the same time, and every task eventually runs in FIFO order.
  it("never runs more than maxConcurrent tasks at once", async () => {
    const limiter = new BootResumeLimiter(2, 60_000);
    let running = 0;
    let peak = 0;
    const order: number[] = [];
    const runs = Array.from({ length: 6 }, (_, i) =>
      limiter.run(async () => {
        running++;
        peak = Math.max(peak, running);
        order.push(i);
        await new Promise((r) => setTimeout(r, 1_000 + i * 100));
        running--;
      }),
    );
    expect(limiter.inFlight).toBe(2);
    expect(limiter.queued).toBe(4);
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all(runs);
    expect(peak).toBe(2);
    expect(order).toEqual([0, 1, 2, 3, 4, 5]);
    expect(limiter.inFlight).toBe(0);
  });

  // A rejecting (or synchronously throwing) task frees its slot immediately and
  // the limiter's own promise never rejects.
  it("a failing task frees its slot", async () => {
    const limiter = new BootResumeLimiter(1, 60_000);
    const ran: string[] = [];
    const a = limiter.run(async () => {
      ran.push("a");
      throw new Error("spawn failed");
    });
    const b = limiter.run(() => {
      ran.push("b");
      throw new Error("sync throw");
    });
    const c = limiter.run(async () => {
      ran.push("c");
    });
    await expect(a).resolves.toBe("settled");
    await expect(b).resolves.toBe("settled");
    await expect(c).resolves.toBe("settled");
    expect(ran).toEqual(["a", "b", "c"]);
  });

  // A task that never settles must not block the queue forever: after the slot
  // timeout its slot goes to the next task.
  it("a hung task frees its slot after the timeout", async () => {
    const limiter = new BootResumeLimiter(1, 5_000);
    const hung = limiter.run(() => new Promise(() => {}));
    const next = vi.fn(async () => {});
    const second = limiter.run(next);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(next).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(hung).resolves.toBe("timeout");
    await expect(second).resolves.toBe("settled");
    expect(next).toHaveBeenCalledTimes(1);
    expect(limiter.inFlight).toBe(0);
  });
});
