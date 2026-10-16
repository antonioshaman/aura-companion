import { describe, expect, it, vi } from "vitest";
import {
  OBSERVER_WAKE_SILENCE_DEFAULT_MS,
  OBSERVER_WAKE_SILENCE_MAX_MS,
  OBSERVER_WAKE_SILENCE_MIN_MS,
  resolveObserverWakeSilenceMs,
} from "./observer-wake-silence.js";
import { OBSERVER_WAKE_TIMEOUT_MS } from "./council-types.js";

// W14: the observer-wake silence threshold. The default must sit well above
// the largest healthy inter-frame gap seen in prod wake turns (35 s across
// 3 611 frames) and well below the 300 s review deadline, so a silent wake is
// handled before the deadline degrades the pair.
describe("resolveObserverWakeSilenceMs", () => {
  it("defaults to 120s, between the healthy-gap ceiling and the review deadline", () => {
    expect(resolveObserverWakeSilenceMs(undefined)).toBe(OBSERVER_WAKE_SILENCE_DEFAULT_MS);
    expect(OBSERVER_WAKE_SILENCE_DEFAULT_MS).toBe(120_000);
    expect(OBSERVER_WAKE_SILENCE_DEFAULT_MS).toBeGreaterThan(35_000 * 3);
    expect(OBSERVER_WAKE_SILENCE_MAX_MS).toBeLessThan(OBSERVER_WAKE_TIMEOUT_MS);
  });

  it("accepts an in-bounds integer override", () => {
    expect(resolveObserverWakeSilenceMs("90000")).toBe(90_000);
  });

  it("rejects junk / out-of-bounds values loudly and falls back", () => {
    for (const bad of ["abc", "1.5", "-1", String(OBSERVER_WAKE_SILENCE_MIN_MS - 1), String(OBSERVER_WAKE_SILENCE_MAX_MS + 1)]) {
      const onInvalid = vi.fn();
      expect(resolveObserverWakeSilenceMs(bad, onInvalid)).toBe(OBSERVER_WAKE_SILENCE_DEFAULT_MS);
      expect(onInvalid).toHaveBeenCalledWith(bad);
    }
  });

  it("treats empty as unset without warning", () => {
    const onInvalid = vi.fn();
    expect(resolveObserverWakeSilenceMs("  ", onInvalid)).toBe(OBSERVER_WAKE_SILENCE_DEFAULT_MS);
    expect(onInvalid).not.toHaveBeenCalled();
  });
});
