import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  recordCleanupEvent,
  getCleanupEventCountLastHour,
  __resetCleanupCountersForTests,
  __getCleanupEventStoreSizeForTests,
} from "./cleanup-events.js";
import { setClockSourceForTests, __resetClockSourceForTests } from "./age-ms.js";

// AP-17 discipline applies to BOTH this module's `droppedOverflowWarned`
// flag AND the age-ms module's clock source — each suite-level reset is
// hard-required so a previous test's overflow latch / clock override
// doesn't leak forward.

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  __resetCleanupCountersForTests();
  __resetClockSourceForTests();
  const loggerModule = await import("../logger.js");
  warnSpy = vi.spyOn(loggerModule.log, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  __resetCleanupCountersForTests();
  __resetClockSourceForTests();
  vi.restoreAllMocks();
});

describe("recordCleanupEvent — append + read", () => {
  // Closed enum sanity: each kind round-trips through the store.
  // Documents the public contract for downstream Phases D/E/F/H.
  it("records all 5 cleanup-event kinds and reads each back via the projection", () => {
    setClockSourceForTests(() => 1_000_000);
    recordCleanupEvent("evicted");
    recordCleanupEvent("orphan_reaped");
    recordCleanupEvent("drained_pending");
    recordCleanupEvent("recordings_soft_archived");
    recordCleanupEvent("recordings_hard_deleted");

    expect(getCleanupEventCountLastHour("evicted")).toBe(1);
    expect(getCleanupEventCountLastHour("orphan_reaped")).toBe(1);
    expect(getCleanupEventCountLastHour("drained_pending")).toBe(1);
    expect(getCleanupEventCountLastHour("recordings_soft_archived")).toBe(1);
    expect(getCleanupEventCountLastHour("recordings_hard_deleted")).toBe(1);
  });

  // Counts within the same kind accumulate.
  it("accumulates same-kind counts", () => {
    setClockSourceForTests(() => 1_000_000);
    recordCleanupEvent("evicted");
    recordCleanupEvent("evicted");
    recordCleanupEvent("evicted");
    expect(getCleanupEventCountLastHour("evicted")).toBe(3);
    expect(getCleanupEventCountLastHour("orphan_reaped")).toBe(0);
  });
});

describe("getCleanupEventCountLastHour — sliding 1h window + age-ms anchor", () => {
  // Events older than 1h are pruned BEFORE counting. The clock-source
  // override is the determinism anchor; without it the test would have
  // to sleep one real hour.
  it("excludes events older than 1h from the count", () => {
    const oneHourMs = 60 * 60 * 1000;
    const baseTs = 10_000_000;

    setClockSourceForTests(() => baseTs);
    recordCleanupEvent("evicted"); // ts = baseTs

    // Advance "now" to baseTs + 1h + 1s — the event is now ~1h+1s old.
    setClockSourceForTests(() => baseTs + oneHourMs + 1_000);
    expect(getCleanupEventCountLastHour("evicted")).toBe(0);
  });

  // Boundary: an event exactly at the 1h boundary is still inside the window.
  it("includes events at exactly the 1h boundary (inclusive lower edge)", () => {
    const oneHourMs = 60 * 60 * 1000;
    const baseTs = 10_000_000;

    setClockSourceForTests(() => baseTs);
    recordCleanupEvent("evicted");

    setClockSourceForTests(() => baseTs + oneHourMs);
    expect(getCleanupEventCountLastHour("evicted")).toBe(1);
  });

  // The prune is permanent — calling count once at a future time drops
  // the old entries, so a subsequent count at the same future time has
  // a smaller working set. This pins the "prune-on-read" contract
  // (vs "filter-on-read") that EC-21 documents at the module floor.
  it("pruning is permanent: store size shrinks after a count that drops old entries", () => {
    const oneHourMs = 60 * 60 * 1000;
    const baseTs = 10_000_000;

    setClockSourceForTests(() => baseTs);
    recordCleanupEvent("evicted");
    recordCleanupEvent("evicted");
    expect(__getCleanupEventStoreSizeForTests()).toBe(2);

    setClockSourceForTests(() => baseTs + oneHourMs + 1_000);
    getCleanupEventCountLastHour("evicted");
    expect(__getCleanupEventStoreSizeForTests()).toBe(0);
  });
});

describe("AP-17 — `droppedOverflowWarned` flag + warn-path test", () => {
  // Push the store past 10K cap and assert (a) the one-shot WARN fires
  // exactly once with the documented event shape, (b) the store stays
  // bounded at the cap, and (c) the latch re-arms after a reset.
  it("emits dropped_counter_overflow WARN exactly once on cap saturation", () => {
    // 10K cap → push 10_005 to trigger 5 drops; the WARN fires once.
    const CAP = 10_000;
    for (let i = 0; i < CAP + 5; i++) {
      recordCleanupEvent("evicted");
    }

    expect(__getCleanupEventStoreSizeForTests()).toBe(CAP);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const data = warnSpy.mock.calls[0][2] as Record<string, unknown>;
    expect(data.event).toBe("dropped_counter_overflow");
    expect(data.cap).toBe(CAP);
  });

  // EC-42 mutation resistance: removing the `if (!droppedOverflowWarned)`
  // guard would make the warn fire N times instead of once — this test
  // goes red in that case.
  it("does NOT re-emit WARN on subsequent overflow drops without a reset", () => {
    const CAP = 10_000;
    for (let i = 0; i < CAP + 10; i++) {
      recordCleanupEvent("evicted");
    }
    expect(warnSpy).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 5; i++) {
      recordCleanupEvent("evicted");
    }
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  // The AP-17 third piece: `__reset` re-arms the latch so subsequent
  // tests can see the warn fire again.
  it("__resetCleanupCountersForTests re-arms the overflow latch", () => {
    const CAP = 10_000;
    for (let i = 0; i < CAP + 1; i++) recordCleanupEvent("evicted");
    expect(warnSpy).toHaveBeenCalledTimes(1);

    __resetCleanupCountersForTests();
    expect(__getCleanupEventStoreSizeForTests()).toBe(0);

    for (let i = 0; i < CAP + 1; i++) recordCleanupEvent("evicted");
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });
});

describe("AP-17 — reset between tests is REAL (not vacuous)", () => {
  // Two siblings that both record then read. The second test's
  // assertions MUST hold even when the first ran before it — which is
  // only true because `__resetCleanupCountersForTests` runs in
  // `beforeEach`. Removing the reset turns this suite red, proving
  // the reset isn't decorative.
  it("first test records 3 evictions", () => {
    setClockSourceForTests(() => 1_000_000);
    recordCleanupEvent("evicted");
    recordCleanupEvent("evicted");
    recordCleanupEvent("evicted");
    expect(getCleanupEventCountLastHour("evicted")).toBe(3);
  });

  it("second test sees a fresh store (no leakage from sibling)", () => {
    setClockSourceForTests(() => 1_000_000);
    expect(__getCleanupEventStoreSizeForTests()).toBe(0);
    expect(getCleanupEventCountLastHour("evicted")).toBe(0);
  });
});
