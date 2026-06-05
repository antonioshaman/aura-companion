import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ageMs, setClockSourceForTests, __resetClockSourceForTests } from "./age-ms.js";

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  // AP-17: every suite that touches the module-scope clock source MUST
  // reset it in beforeEach so test ordering doesn't leak through.
  __resetClockSourceForTests();
  const loggerModule = await import("../logger.js");
  warnSpy = vi.spyOn(loggerModule.log, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  __resetClockSourceForTests();
  vi.restoreAllMocks();
});

describe("ageMs — happy path", () => {
  // Round-trip: past timestamp → positive age. The injected clock is the
  // determinism anchor.
  it("returns now - pastMs when raw difference is positive", () => {
    setClockSourceForTests(() => 1_000_000);
    expect(ageMs(900_000)).toBe(100_000);
  });

  // Boundary: zero raw difference is zero age, not skew.
  it("returns 0 when now === pastMs (no warn)", () => {
    setClockSourceForTests(() => 500_000);
    expect(ageMs(500_000)).toBe(0);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  // Caller-supplied `nowMs` overrides the clock source — the sweep-tick
  // pattern (capture clock once, compare against many rows).
  it("uses caller-supplied nowMs when provided", () => {
    setClockSourceForTests(() => 999_999_999); // would dominate without override
    expect(ageMs(100, 500)).toBe(400);
  });
});

describe("ageMs — EC-38 negative-skew clamp", () => {
  // The whole reason this helper exists: clamp negative skew to 0
  // rather than letting the caller compare a negative number against
  // a positive threshold.
  it("clamps negative age to 0", () => {
    setClockSourceForTests(() => 1_000);
    expect(ageMs(5_000)).toBe(0);
  });

  // EC-22: the structured log line is operator-facing — pin the event
  // name + the `skewMs` field so alerts watching `event=clock.skew_detected`
  // don't silently regress.
  it("emits clock.skew_detected WARN with skewMs naming the negative delta", () => {
    setClockSourceForTests(() => 1_000);
    ageMs(5_000);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const data = warnSpy.mock.calls[0][2] as Record<string, unknown>;
    expect(data.event).toBe("clock.skew_detected");
    expect(data.skewMs).toBe(-4_000);
    expect(data.now).toBe(1_000);
    expect(data.pastMs).toBe(5_000);
  });

  // EC-42 mutation resistance: removing the WARN in production code
  // would make this test red (warn count expected = 0 for non-skew).
  it("does NOT emit WARN when delta is zero or positive", () => {
    setClockSourceForTests(() => 10_000);
    ageMs(10_000);
    ageMs(5_000);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("ageMs — clock source defaults", () => {
  // Sanity: without an override, the default clock source is `Date.now`
  // (i.e., a number close to "right now"). Loose bounds are sufficient —
  // we just need to prove the helper doesn't blow up without the test seam.
  it("uses Date.now() by default after __resetClockSourceForTests", () => {
    __resetClockSourceForTests();
    const before = Date.now();
    const result = ageMs(before - 100);
    expect(result).toBeGreaterThanOrEqual(100);
    expect(result).toBeLessThan(5_000);
  });
});
