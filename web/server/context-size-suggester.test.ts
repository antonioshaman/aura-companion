import { describe, it, expect } from "vitest";
import {
  CODEX_COMPACTION_LADDER,
  COMPACTION_MILESTONE_BYTES,
  HANDOFF_MILESTONE_MIN_BYTES,
  MILESTONE_MESSAGE,
  TRANSCRIPT_BYTES_LADDER,
  advisoryActionFor,
  decodeContextAdvisory,
  nextCompactionMilestone,
  nextContextMilestone,
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

// The structured advisory (context-overflow handoff): from 5 MB up the
// browser offers a one-click "Continue in a new session" instead of a plain
// text line. 1.5/3 MB keep suggesting /compact.
describe("advisoryActionFor / structured advisory action", () => {
  it("1.5 MB and 3 MB milestones suggest /compact only", () => {
    expect(advisoryActionFor(1_500_000)).toBe("compact");
    expect(advisoryActionFor(3_000_000)).toBe("compact");
    expect(nextCompactionMilestone(1_500_000, 0)?.action).toBe("compact");
    expect(nextCompactionMilestone(3_000_000, 1_500_000)?.action).toBe("compact");
  });

  it("5 MB and 10 MB milestones offer continue-in-new-session", () => {
    expect(HANDOFF_MILESTONE_MIN_BYTES).toBe(5_000_000);
    expect(nextCompactionMilestone(5_000_000, 3_000_000)?.action).toBe("continue_in_new");
    expect(nextCompactionMilestone(12_000_000, 5_000_000)?.action).toBe("continue_in_new");
  });

  it("the handoff-tier copy points at a new session, not at archiving", () => {
    // The old 10 MB copy told the user to "archive this session"; the new
    // flow keeps the session and hands the task over to a fresh one.
    expect(MILESTONE_MESSAGE[10_000_000]).toMatch(/continue in a new session/i);
    expect(MILESTONE_MESSAGE[5_000_000]).toMatch(/continue in a new session/i);
  });
});

// ── Ladder-generic decision (council plan 2026-10-17, AC1) ───────────────────
// Claude and Codex share one pure decision path; only the ladder differs. The
// function never learns where the number came from.
describe("nextContextMilestone + ladders", () => {
  it("the bytes ladder reproduces nextCompactionMilestone exactly", () => {
    for (const [size, last] of [[0, 0], [1_500_000, 0], [3_200_000, 1_500_000], [5_000_000, 3_000_000], [10_500_000, 5_000_000], [10_500_000, 10_000_000]] as const) {
      const legacy = nextCompactionMilestone(size, last);
      const generic = nextContextMilestone(size, last, TRANSCRIPT_BYTES_LADDER);
      if (legacy === null) expect(generic).toBeNull();
      else expect(generic).toMatchObject({ signal: "transcript_bytes", milestone: legacy.milestoneBytes, message: legacy.message, action: legacy.action });
    }
  });

  it("Codex compactions ladder: 2 → continue_in_new, 1 → nothing, same rung never twice, 5 and 10 are fresh rungs", () => {
    expect(nextContextMilestone(0, 0, CODEX_COMPACTION_LADDER)).toBeNull();
    expect(nextContextMilestone(1, 0, CODEX_COMPACTION_LADDER)).toBeNull();
    const fired = nextContextMilestone(2, 0, CODEX_COMPACTION_LADDER);
    expect(fired).toMatchObject({ signal: "codex_compactions", milestone: 2, action: "continue_in_new" });
    expect(fired?.message).toMatch(/twice/);
    expect(fired?.message).toMatch(/continue in a new session/i);
    expect(nextContextMilestone(3, 2, CODEX_COMPACTION_LADDER)).toBeNull();
    expect(nextContextMilestone(5, 2, CODEX_COMPACTION_LADDER)).toMatchObject({ milestone: 5, action: "continue_in_new" });
    expect(nextContextMilestone(12, 5, CODEX_COMPACTION_LADDER)).toMatchObject({ milestone: 10, action: "continue_in_new" });
  });

  it("the compactions ladder's handoff floor is its own, not the 5 MB byte floor", () => {
    // A mutant that keeps comparing against HANDOFF_MILESTONE_MIN_BYTES would
    // label 2 (< 5_000_000) as "compact".
    expect(advisoryActionFor(2, CODEX_COMPACTION_LADDER.handoffMin)).toBe("continue_in_new");
    expect(advisoryActionFor(2)).toBe("compact");
  });

  it("decodeContextAdvisory: legacy bytes-only record → transcript_bytes; new record keeps signal + milestone", () => {
    expect(decodeContextAdvisory({ milestoneBytes: 10_000_000 })).toEqual({ signal: "transcript_bytes", milestone: 10_000_000 });
    expect(decodeContextAdvisory({ signal: "codex_compactions", milestone: 5 })).toEqual({ signal: "codex_compactions", milestone: 5 });
    expect(decodeContextAdvisory({})).toEqual({ signal: "transcript_bytes", milestone: 0 });
  });

  it("every ladder rung has copy and rungs are ascending", () => {
    for (const ladder of [TRANSCRIPT_BYTES_LADDER, CODEX_COMPACTION_LADDER]) {
      for (let i = 0; i < ladder.milestones.length; i++) {
        const m = ladder.milestones[i]!;
        expect(typeof ladder.messages[m]).toBe("string");
        if (i > 0) expect(m).toBeGreaterThan(ladder.milestones[i - 1]!);
      }
      expect(ladder.milestones).toContain(ladder.handoffMin);
    }
  });
});
