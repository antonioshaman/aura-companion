import { describe, it, expect } from "vitest";
import {
  checkDrift,
  resolveJsonlPath,
  DEFAULT_LAG_TOLERANCE_MS,
  DEFAULT_JSONL_IDLE_THRESHOLD_MS,
  type DriftDetectorSessionState,
} from "./silent-stdio-drift-detector.js";

/**
 * Build a stat-wrapper stub keyed by path → mtime. Missing paths return
 * null (matches the module's `defaultStatFile` semantics). Post-2026-09-20
 * refactor, only jsonl paths are stat'd — the "bun freshness" signal is
 * now an in-memory `bunLastFrameMs` number passed on the state directly.
 */
function stubStat(files: Record<string, number>) {
  return (p: unknown) => {
    const s = String(p);
    return s in files ? { mtimeMs: files[s] } : null;
  };
}

describe("checkDrift — silent-stdio detector", () => {
  const NOW = 1_800_000_000_000;

  /**
   * Build a session state fixture. Default `bunLastFrameMs` is 3s ago,
   * i.e. "the adapter recently saw a CLI frame" — the typical baseline
   * for a healthy live session.
   */
  function state(overrides: Partial<DriftDetectorSessionState> = {}): DriftDetectorSessionState {
    return {
      sessionId: "sess-1",
      bunLastFrameMs: NOW - 3_000,
      jsonlPath: "/tmp/cli.jsonl",
      ...overrides,
    };
  }

  it("returns drifted=false when jsonlPath is null (session not yet initialised)", () => {
    const v = checkDrift(state({ jsonlPath: null }), { now: () => NOW });
    expect(v.drifted).toBe(false);
    expect(v.reason).toBeNull();
    expect(v.jsonlMtimeMs).toBe(0);
    expect(v.bunLastFrameMs).toBe(NOW - 3_000);
  });

  it("returns drifted=false when jsonl file does not exist", () => {
    const v = checkDrift(state(), {
      now: () => NOW,
      statFile: stubStat({}),
    });
    expect(v.drifted).toBe(false);
    expect(v.jsonlMtimeMs).toBe(0);
  });

  it("returns drifted=false when jsonl is fresh and bun recently received a frame (healthy)", () => {
    // jsonl just written 5s ago, bun received a frame 3s ago —
    // bun is keeping up. Normal operation.
    const v = checkDrift(state({ bunLastFrameMs: NOW - 3_000 }), {
      now: () => NOW,
      statFile: stubStat({ "/tmp/cli.jsonl": NOW - 5_000 }),
    });
    expect(v.drifted).toBe(false);
    expect(v.mtimeDeltaMs).toBeLessThan(0); // bun slightly newer than jsonl
  });

  it("returns drifted=false when jsonl is IDLE (>threshold since last write)", () => {
    // jsonl last written 5 min ago (300s), bun heard nothing for 10 min.
    // jsonl mtime is much newer than bun-last-frame, but jsonl not
    // actively writing, so no active drift to catch.
    const v = checkDrift(state({ bunLastFrameMs: NOW - 600_000 }), {
      now: () => NOW,
      statFile: stubStat({ "/tmp/cli.jsonl": NOW - 300_000 }),
    });
    expect(v.drifted).toBe(false);
    expect(v.mtimeDeltaMs).toBe(300_000);
  });

  it("returns drifted=TRUE when jsonl fresh + significantly newer than bun-last-frame (canonical silent-stdio-pipe-death)", () => {
    // jsonl written 10s ago, bun last received a CLI frame 3 min ago.
    // CLI is actively writing to its own jsonl, but bun's stdout pipe
    // from CLI dropped — 170s of divergence, in the act.
    const v = checkDrift(state({ bunLastFrameMs: NOW - 180_000 }), {
      now: () => NOW,
      statFile: stubStat({ "/tmp/cli.jsonl": NOW - 10_000 }),
    });
    expect(v.drifted).toBe(true);
    expect(v.mtimeDeltaMs).toBe(170_000);
    expect(v.reason).toMatch(/jsonl mtime 170s newer than bun's last frame/);
    expect(v.reason).toMatch(/age 10s/);
  });

  it("returns drifted=false when delta is under lag tolerance", () => {
    // jsonl 30s newer than bun-last-frame — within the 90s tolerance
    // (normal bun-processing lag on a heavy tool_use turn).
    const v = checkDrift(state({ bunLastFrameMs: NOW - 35_000 }), {
      now: () => NOW,
      statFile: stubStat({ "/tmp/cli.jsonl": NOW - 5_000 }),
    });
    expect(v.drifted).toBe(false);
    expect(v.mtimeDeltaMs).toBe(30_000);
  });

  it("caller can widen lagTolerance for heavy-tool_use environments", () => {
    // 100s delta — would drift under 90s tolerance, but not under 200s.
    const s = state({ bunLastFrameMs: NOW - 105_000 });
    const stat = stubStat({ "/tmp/cli.jsonl": NOW - 5_000 });
    const strict = checkDrift(s, { now: () => NOW, statFile: stat, lagToleranceMs: 90_000 });
    const relaxed = checkDrift(s, { now: () => NOW, statFile: stat, lagToleranceMs: 200_000 });
    expect(strict.drifted).toBe(true);
    expect(relaxed.drifted).toBe(false);
  });

  it("boundary — delta exactly equal to tolerance is NOT drift (strict >)", () => {
    const v = checkDrift(
      state({ bunLastFrameMs: NOW - 5_000 - DEFAULT_LAG_TOLERANCE_MS }),
      {
        now: () => NOW,
        statFile: stubStat({ "/tmp/cli.jsonl": NOW - 5_000 }),
        lagToleranceMs: DEFAULT_LAG_TOLERANCE_MS,
      },
    );
    expect(v.drifted).toBe(false);
    expect(v.mtimeDeltaMs).toBe(DEFAULT_LAG_TOLERANCE_MS);
  });

  it("boundary — jsonl age exactly equal to idle threshold still triggers if delta exceeds tolerance", () => {
    // Idle guard is `>` not `>=`, so at the exact threshold jsonl still
    // counts as active.
    const v = checkDrift(
      state({ bunLastFrameMs: NOW - DEFAULT_JSONL_IDLE_THRESHOLD_MS - 200_000 }),
      {
        now: () => NOW,
        statFile: stubStat({ "/tmp/cli.jsonl": NOW - DEFAULT_JSONL_IDLE_THRESHOLD_MS }),
      },
    );
    expect(v.drifted).toBe(true);
  });

  it("returns drifted=false when bunLastFrameMs is 0 (adapter has not attached yet)", () => {
    // Guards the boot window: a session whose ClaudeAdapter has not yet
    // received `attachTransport` reports 0 as its last-frame timestamp.
    // Without this guard the jsonl freshness alone would trigger drift
    // (jsonl age 5s, bun age = epoch = billions of seconds).
    const v = checkDrift(state({ bunLastFrameMs: 0 }), {
      now: () => NOW,
      statFile: stubStat({ "/tmp/cli.jsonl": NOW - 5_000 }),
    });
    expect(v.drifted).toBe(false);
    expect(v.bunLastFrameMs).toBe(0);
    // jsonlMtimeMs is still surfaced so operators can log both numbers.
    expect(v.jsonlMtimeMs).toBe(NOW - 5_000);
  });

  it("verdict payload always includes bunLastFrameMs + jsonlMtimeMs for observability", () => {
    const v = checkDrift(state({ bunLastFrameMs: NOW - 3_000 }), {
      now: () => NOW,
      statFile: stubStat({ "/tmp/cli.jsonl": NOW - 5_000 }),
    });
    expect(v.sessionId).toBe("sess-1");
    expect(v.jsonlMtimeMs).toBe(NOW - 5_000);
    expect(v.bunLastFrameMs).toBe(NOW - 3_000);
  });
});

describe("resolveJsonlPath", () => {
  it("mirrors Claude CLI path derivation for a nested cwd", () => {
    const p = resolveJsonlPath(
      "/home/auracomp/.claude",
      "/root/aura-companion/web",
      "d5e8a369-028d-4175-bf24-c2c42320c167",
    );
    expect(p).toBe(
      "/home/auracomp/.claude/projects/-root-aura-companion-web/d5e8a369-028d-4175-bf24-c2c42320c167.jsonl",
    );
  });

  it("returns null when cwd is missing (fresh session, cwd not yet resolved)", () => {
    expect(resolveJsonlPath("/home/a/.claude", null, "cli-sess")).toBeNull();
    expect(resolveJsonlPath("/home/a/.claude", "", "cli-sess")).toBeNull();
    expect(resolveJsonlPath("/home/a/.claude", undefined, "cli-sess")).toBeNull();
  });

  it("returns null when cliSessionId is missing (pre-init spawn)", () => {
    expect(resolveJsonlPath("/home/a/.claude", "/root/x", null)).toBeNull();
    expect(resolveJsonlPath("/home/a/.claude", "/root/x", "")).toBeNull();
    expect(resolveJsonlPath("/home/a/.claude", "/root/x", undefined)).toBeNull();
  });

  it("handles top-level cwd (single-segment path) — no double dashes", () => {
    const p = resolveJsonlPath("/home/a/.claude", "/root", "abc");
    expect(p).toBe("/home/a/.claude/projects/-root/abc.jsonl");
  });
});
