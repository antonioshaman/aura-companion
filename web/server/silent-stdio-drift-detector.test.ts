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
 * null (matches the module's `defaultStatFile` semantics).
 */
function stubStat(files: Record<string, number>) {
  return (p: unknown) => {
    const s = String(p);
    return s in files ? { mtimeMs: files[s] } : null;
  };
}

const T_STATE: DriftDetectorSessionState = {
  sessionId: "sess-1",
  transcriptPath: "/tmp/transcript.json",
  jsonlPath: "/tmp/cli.jsonl",
};

describe("checkDrift — silent-stdio detector", () => {
  const NOW = 1_800_000_000_000;

  it("returns drifted=false when jsonlPath is null (session not yet initialised)", () => {
    const v = checkDrift({ ...T_STATE, jsonlPath: null }, { now: () => NOW });
    expect(v.drifted).toBe(false);
    expect(v.reason).toBeNull();
    expect(v.jsonlMtimeMs).toBe(0);
    expect(v.transcriptMtimeMs).toBe(0);
  });

  it("returns drifted=false when jsonl file does not exist", () => {
    const v = checkDrift(T_STATE, {
      now: () => NOW,
      statFile: stubStat({ "/tmp/transcript.json": NOW - 10_000 }),
    });
    expect(v.drifted).toBe(false);
    expect(v.jsonlMtimeMs).toBe(0);
  });

  it("returns drifted=false when both jsonl AND transcript are fresh (healthy pair)", () => {
    // jsonl just written 5s ago, transcript just written 3s ago — bun
    // is keeping up with CLI. Normal operation.
    const v = checkDrift(T_STATE, {
      now: () => NOW,
      statFile: stubStat({
        "/tmp/cli.jsonl": NOW - 5_000,
        "/tmp/transcript.json": NOW - 3_000,
      }),
    });
    expect(v.drifted).toBe(false);
    expect(v.mtimeDeltaMs).toBeLessThan(0); // transcript slightly newer
  });

  it("returns drifted=false when jsonl is IDLE (>threshold since last write)", () => {
    // jsonl last written 5 min ago (300s), transcript 10 min ago (600s).
    // jsonl is much newer but it's not actively writing, so no drift.
    const v = checkDrift(T_STATE, {
      now: () => NOW,
      statFile: stubStat({
        "/tmp/cli.jsonl": NOW - 300_000,
        "/tmp/transcript.json": NOW - 600_000,
      }),
    });
    expect(v.drifted).toBe(false);
    // Delta is 300s in jsonl's favour but idle-guard short-circuits.
    expect(v.mtimeDeltaMs).toBe(300_000);
  });

  it("returns drifted=TRUE when jsonl fresh + significantly newer than transcript (canonical silent-stdio)", () => {
    // jsonl written 10s ago, transcript last touched 3 min ago.
    // CLI is actively writing, bun's transcript is 170s behind. That's
    // the two-writer divergence pattern — silent-stdio in the act.
    const v = checkDrift(T_STATE, {
      now: () => NOW,
      statFile: stubStat({
        "/tmp/cli.jsonl": NOW - 10_000,
        "/tmp/transcript.json": NOW - 180_000,
      }),
    });
    expect(v.drifted).toBe(true);
    expect(v.mtimeDeltaMs).toBe(170_000);
    expect(v.reason).toMatch(/jsonl mtime 170s newer than transcript/);
    expect(v.reason).toMatch(/age 10s/);
  });

  it("returns drifted=false when delta is under lag tolerance", () => {
    // jsonl 30s newer than transcript — within the 90s tolerance
    // (normal bun-write lag on a heavy tool_use turn).
    const v = checkDrift(T_STATE, {
      now: () => NOW,
      statFile: stubStat({
        "/tmp/cli.jsonl": NOW - 5_000,
        "/tmp/transcript.json": NOW - 35_000,
      }),
    });
    expect(v.drifted).toBe(false);
    expect(v.mtimeDeltaMs).toBe(30_000);
  });

  it("caller can widen lagTolerance for heavy-tool_use environments", () => {
    // 100s delta — would drift under 90s tolerance, but not under 200s.
    const files = {
      "/tmp/cli.jsonl": NOW - 5_000,
      "/tmp/transcript.json": NOW - 105_000,
    };
    const strict = checkDrift(T_STATE, {
      now: () => NOW,
      statFile: stubStat(files),
      lagToleranceMs: 90_000,
    });
    const relaxed = checkDrift(T_STATE, {
      now: () => NOW,
      statFile: stubStat(files),
      lagToleranceMs: 200_000,
    });
    expect(strict.drifted).toBe(true);
    expect(relaxed.drifted).toBe(false);
  });

  it("boundary — delta exactly equal to tolerance is NOT drift (strict >)", () => {
    const v = checkDrift(T_STATE, {
      now: () => NOW,
      statFile: stubStat({
        "/tmp/cli.jsonl": NOW - 5_000,
        "/tmp/transcript.json": NOW - 5_000 - DEFAULT_LAG_TOLERANCE_MS,
      }),
      lagToleranceMs: DEFAULT_LAG_TOLERANCE_MS,
    });
    expect(v.drifted).toBe(false);
    expect(v.mtimeDeltaMs).toBe(DEFAULT_LAG_TOLERANCE_MS);
  });

  it("boundary — jsonl age exactly equal to idle threshold still triggers if delta exceeds tolerance", () => {
    // Idle guard is `>` not `>=`, so at the exact threshold jsonl still
    // counts as active.
    const v = checkDrift(T_STATE, {
      now: () => NOW,
      statFile: stubStat({
        "/tmp/cli.jsonl": NOW - DEFAULT_JSONL_IDLE_THRESHOLD_MS,
        "/tmp/transcript.json": NOW - DEFAULT_JSONL_IDLE_THRESHOLD_MS - 200_000,
      }),
    });
    expect(v.drifted).toBe(true);
  });

  it("verdict payload always includes both mtimes for observability", () => {
    const v = checkDrift(T_STATE, {
      now: () => NOW,
      statFile: stubStat({
        "/tmp/cli.jsonl": NOW - 5_000,
        "/tmp/transcript.json": NOW - 3_000,
      }),
    });
    expect(v.sessionId).toBe("sess-1");
    expect(v.jsonlMtimeMs).toBe(NOW - 5_000);
    expect(v.transcriptMtimeMs).toBe(NOW - 3_000);
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
