import { describe, it, expect } from "vitest";
import {
  COMPACTION_MILESTONE_BYTES,
  MILESTONE_MESSAGE,
  nextCompactionMilestone,
} from "./context-size-suggester.js";

describe("nextCompactionMilestone", () => {
  it("returns null when size is below the first threshold", () => {
    expect(nextCompactionMilestone(0, 0)).toBeNull();
    expect(nextCompactionMilestone(500_000, 0)).toBeNull();
    expect(nextCompactionMilestone(1_499_999, 0)).toBeNull();
  });

  it("fires the first milestone (1.5 MB) when crossed for the first time", () => {
    const a = nextCompactionMilestone(1_500_000, 0);
    expect(a).not.toBeNull();
    expect(a?.milestoneBytes).toBe(1_500_000);
    expect(a?.message).toMatch(/1\.5 MB/);
  });

  it("does NOT re-fire the same milestone (steady state suppression)", () => {
    // We've already fired 1.5 MB. Session still at 1.9 MB (between
    // 1.5 and 3). No new milestone → no fire.
    expect(nextCompactionMilestone(1_900_000, 1_500_000)).toBeNull();
    expect(nextCompactionMilestone(1_500_000, 1_500_000)).toBeNull();
    expect(nextCompactionMilestone(2_999_999, 1_500_000)).toBeNull();
  });

  it("fires the NEXT milestone once the session crosses it", () => {
    // Already advised at 1.5 MB, now hits 3 MB.
    const a = nextCompactionMilestone(3_000_000, 1_500_000);
    expect(a?.milestoneBytes).toBe(3_000_000);
    expect(a?.message).toMatch(/3 MB/);
  });

  it("jumps straight to the highest crossed milestone when session ballooned between ticks", () => {
    // Fresh session (0 fired) then next tick we observe 6 MB — likely
    // a very active turn between ticks. We return the highest crossed
    // (5 MB), not 1.5. Caller only fires the loudest advisory once.
    const a = nextCompactionMilestone(6_000_000, 0);
    expect(a?.milestoneBytes).toBe(5_000_000);
  });

  it("returns null when already at ceiling — no re-fire on the 10 MB tier once it fired", () => {
    // Fired 10 MB milestone. Session still growing but no higher tier.
    expect(nextCompactionMilestone(15_000_000, 10_000_000)).toBeNull();
    expect(nextCompactionMilestone(100_000_000, 10_000_000)).toBeNull();
  });

  it("boundary — exactly at threshold triggers (>=)", () => {
    expect(nextCompactionMilestone(1_500_000, 0)?.milestoneBytes).toBe(1_500_000);
    expect(nextCompactionMilestone(3_000_000, 0)?.milestoneBytes).toBe(3_000_000);
    expect(nextCompactionMilestone(5_000_000, 0)?.milestoneBytes).toBe(5_000_000);
    expect(nextCompactionMilestone(10_000_000, 0)?.milestoneBytes).toBe(10_000_000);
  });

  it("all milestones have a message and are ordered ascending", () => {
    // Belt-and-braces: adding a milestone without a message entry
    // would silently drop the advisory. Assert content sanity.
    for (const m of COMPACTION_MILESTONE_BYTES) {
      expect(MILESTONE_MESSAGE[m]).toBeDefined();
      expect(MILESTONE_MESSAGE[m].length).toBeGreaterThan(20);
    }
    // Ordered ascending — the function relies on this to break the loop early.
    for (let i = 1; i < COMPACTION_MILESTONE_BYTES.length; i++) {
      expect(COMPACTION_MILESTONE_BYTES[i]).toBeGreaterThan(COMPACTION_MILESTONE_BYTES[i - 1]);
    }
  });

  it("caller-supplied custom milestone list is honoured (for tests / operator overrides)", () => {
    const custom = [100, 200, 300];
    const messages: Record<number, string> = {
      100: "at 100",
      200: "at 200",
      300: "at 300",
    };
    expect(nextCompactionMilestone(150, 0, custom, messages)?.milestoneBytes).toBe(100);
    expect(nextCompactionMilestone(250, 100, custom, messages)?.milestoneBytes).toBe(200);
    expect(nextCompactionMilestone(350, 200, custom, messages)?.milestoneBytes).toBe(300);
    expect(nextCompactionMilestone(500, 300, custom, messages)).toBeNull();
  });

  it("returns null when a milestone lacks a message entry (defensive)", () => {
    // Simulates operator adding a milestone without wiring copy.
    const custom = [1000];
    const messages: Record<number, string> = {}; // no message for 1000
    expect(nextCompactionMilestone(1500, 0, custom, messages)).toBeNull();
  });
});
