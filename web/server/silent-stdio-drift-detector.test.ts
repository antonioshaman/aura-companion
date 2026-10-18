import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkDrift,
  countAssistantRecordsBetween,
  countUndeliveredAssistantRecords,
  defaultSubagentActivitySince,
  defaultSubagentOpenToolCallSince,
  endsInOpenToolCall,
  openToolCallStartedAt,
  mainThreadOpenToolCallStartedAt,
  resolveCliSessionPaths,
  SUBAGENT_OPEN_TOOL_CALL_CEILING_MS,
  resolveJsonlPath,
  DEFAULT_LAG_TOLERANCE_MS,
  SUBAGENT_LIVENESS_WINDOW_MS,
  DEFAULT_JSONL_IDLE_THRESHOLD_MS,
  UNDELIVERED_OUTPUT_MIN_AGE_MS,
  UNDELIVERED_OUTPUT_TAIL_BYTES,
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

  it("converts underscores in cwd to dashes (matches CLI's own slug rule)", () => {
    // Regression guard for 2026-09-20 aura-companion prod incident: the
    // CLI writes to `~/.claude/projects/-root-Rapesha-shop-bot/<sid>.jsonl`
    // for a session whose cwd is `/root/Rapesha_shop_bot`. Without the
    // underscore→dash mirroring, resolveJsonlPath computed the underscore
    // path, `stat` returned null every drift-detector tick, and the
    // session sat silent-stdio forever. See
    // feedback_aura_resolvejsonlpath_underscore_slug_mismatch.md.
    const p = resolveJsonlPath("/home/a/.claude", "/root/Rapesha_shop_bot", "abc");
    expect(p).toBe("/home/a/.claude/projects/-root-Rapesha-shop-bot/abc.jsonl");
  });

  it("collapses BOTH slashes and underscores in a nested underscore-heavy cwd", () => {
    const p = resolveJsonlPath(
      "/home/a/.claude",
      "/root/my_project/sub_folder/deep_nested",
      "cli-x",
    );
    expect(p).toBe("/home/a/.claude/projects/-root-my-project-sub-folder-deep-nested/cli-x.jsonl");
  });
});

// P7/FIX-DRIFT-FALSE-KILLS: the lag check alone killed idle sessions the
// moment they got input (bun's last frame = previous turn's result, minutes
// or hours old; the CLI writes the queued prompt to jsonl within ms). The
// kill now also needs evidence: an `assistant` record in the jsonl, newer
// than bun's last frame and >= UNDELIVERED_OUTPUT_MIN_AGE_MS old.
describe("resolveCliSessionPaths", () => {
  it("returns the main jsonl and its sibling session dir from one slug derivation", () => {
    expect(resolveCliSessionPaths("/h/.claude", "/root/Rapesha_shop_bot", "0537e6d7-aaaa-4bbb-8ccc-123456789abc")).toEqual({
      jsonlPath: "/h/.claude/projects/-root-Rapesha-shop-bot/0537e6d7-aaaa-4bbb-8ccc-123456789abc.jsonl",
      sessionDir: "/h/.claude/projects/-root-Rapesha-shop-bot/0537e6d7-aaaa-4bbb-8ccc-123456789abc",
    });
  });

  it("returns null for a missing cwd / cliSessionId", () => {
    expect(resolveCliSessionPaths("/h/.claude", "", "abc")).toBeNull();
    expect(resolveCliSessionPaths("/h/.claude", "/x", null)).toBeNull();
  });

  it("rejects a cliSessionId that is not id-shaped (no path segments escape projects/<slug>/) — review #7", () => {
    expect(resolveCliSessionPaths("/h/.claude", "/x", "../../etc")).toBeNull();
    expect(resolveCliSessionPaths("/h/.claude", "/x", "a/b")).toBeNull();
    expect(resolveJsonlPath("/h/.claude", "/x", "../../etc")).toBeNull();
  });
});

describe("countAssistantRecordsBetween", () => {
  const T0 = Date.parse("2026-10-01T00:00:00.000Z");
  const rec = (type: string, atMs: number) => JSON.stringify({ type, timestamp: new Date(atMs).toISOString() });

  it("counts only assistant records inside (since, until]", () => {
    // since is exclusive (a record at bun's last frame was delivered),
    // until is inclusive; other record types never count.
    const chunk = [
      rec("assistant", T0), // == since → excluded
      rec("assistant", T0 + 1_000),
      rec("user", T0 + 2_000),
      rec("queue-operation", T0 + 2_500),
      rec("assistant", T0 + 5_000), // == until → included
      rec("assistant", T0 + 5_001), // too young → excluded
    ].join("\n");
    expect(countAssistantRecordsBetween(chunk, T0, T0 + 5_000)).toBe(2);
  });

  it("skips a truncated first line and unparseable lines (tail reads start mid-record)", () => {
    const chunk = ['istant","timestamp":"2026-10-01T00:00:09.000Z"}', "{not json", rec("assistant", T0 + 9_000)].join("\n");
    expect(countAssistantRecordsBetween(chunk, T0, T0 + 10_000)).toBe(1);
  });

  it("ignores records without a string timestamp and text that merely mentions assistant", () => {
    const chunk = [
      JSON.stringify({ type: "assistant" }),
      JSON.stringify({ type: "user", note: "the assistant said", timestamp: new Date(T0 + 1_000).toISOString() }),
    ].join("\n");
    expect(countAssistantRecordsBetween(chunk, T0 - 1, T0 + 10_000)).toBe(0);
  });

  it("excludes subagent/sidechain records (isSidechain:true, parentToolUseID) — only main-chain counts", () => {
    // Belt-and-braces for a CLI layout that interleaves subagent output into
    // the flat jsonl: those records are not main-stream output bun missed, so
    // they must not count as evidence of a dead stdout pipe.
    const chunk = [
      JSON.stringify({ type: "assistant", timestamp: new Date(T0 + 1_000).toISOString(), isSidechain: true }),
      JSON.stringify({ type: "assistant", timestamp: new Date(T0 + 2_000).toISOString(), parentToolUseID: "toolu_abc" }),
      JSON.stringify({ type: "assistant", timestamp: new Date(T0 + 3_000).toISOString(), isSidechain: false }),
    ].join("\n");
    // Only the main-chain record (isSidechain:false) counts.
    expect(countAssistantRecordsBetween(chunk, T0, T0 + 10_000)).toBe(1);
  });

  it("counts a record missing isSidechain/parentToolUseID as main-chain (fail-safe for older CLIs)", () => {
    const chunk = rec("assistant", T0 + 1_000); // no isSidechain field
    expect(countAssistantRecordsBetween(chunk, T0, T0 + 10_000)).toBe(1);
  });
});

describe("countUndeliveredAssistantRecords (reads the jsonl tail)", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("finds an assistant record at the end of a jsonl larger than the tail window", () => {
    // Prod jsonls reach tens of MB; only the last UNDELIVERED_OUTPUT_TAIL_BYTES
    // are read. Old assistant records beyond the window must not matter, the
    // fresh one at the end must be found.
    dir = mkdtempSync(join(tmpdir(), "drift-tail-"));
    const p = join(dir, "cli.jsonl");
    const T0 = Date.parse("2026-10-01T00:00:00.000Z");
    const filler = JSON.stringify({ type: "attachment", pad: "x".repeat(1000) });
    const lines = [JSON.stringify({ type: "assistant", timestamp: new Date(T0 + 1_000).toISOString() })];
    for (let i = 0; i < Math.ceil(UNDELIVERED_OUTPUT_TAIL_BYTES / filler.length) + 10; i++) lines.push(filler);
    lines.push(JSON.stringify({ type: "assistant", timestamp: new Date(T0 + 2_000).toISOString() }));
    writeFileSync(p, lines.join("\n") + "\n");
    expect(countUndeliveredAssistantRecords(p, T0, T0 + 60_000)).toBe(1);
  });

  it("returns 0 for a missing file (no evidence → no kill)", () => {
    expect(countUndeliveredAssistantRecords("/nonexistent/drift/cli.jsonl", 0, Date.now())).toBe(0);
  });
});

describe("checkDrift — undelivered-output evidence gate", () => {
  const NOW = 1_800_000_000_000;
  const base: DriftDetectorSessionState = { sessionId: "s", bunLastFrameMs: NOW - 400_000, jsonlPath: "/tmp/cli.jsonl" };
  const stat = (p: unknown) => (String(p) === "/tmp/cli.jsonl" ? { mtimeMs: NOW - 3_000 } : null);

  it("withholds the kill when the jsonl holds no undelivered model output", () => {
    // Idle 400 s, prompt queued 3 s ago: lag 397 s > 90 s, but nothing the
    // model produced is missing on bun's side.
    const v = checkDrift(base, { now: () => NOW, statFile: stat, undeliveredOutput: () => 0 });
    expect(v.drifted).toBe(false);
    expect(v.suppressedReason).toBe("no_undelivered_output");
    expect(v.undeliveredAssistantRecords).toBe(0);
    expect(v.mtimeDeltaMs).toBe(397_000);
  });

  it("kills when model output sat undelivered, and asks for records at least the min age old", () => {
    const calls: Array<[string, number, number]> = [];
    const v = checkDrift(base, {
      now: () => NOW,
      statFile: stat,
      undeliveredOutput: (p, since, until) => {
        calls.push([p, since, until]);
        return 3;
      },
    });
    expect(v.drifted).toBe(true);
    expect(v.suppressedReason).toBeNull();
    expect(v.undeliveredAssistantRecords).toBe(3);
    expect(v.reason).toMatch(/3 undelivered assistant record/);
    expect(calls).toEqual([["/tmp/cli.jsonl", NOW - 400_000, NOW - UNDELIVERED_OUTPUT_MIN_AGE_MS]]);
  });

  it("does not read the jsonl at all while the lag is under tolerance", () => {
    // The tail read is the expensive part; it must only run on suspicion.
    let reads = 0;
    const v = checkDrift(
      { ...base, bunLastFrameMs: NOW - 10_000 },
      { now: () => NOW, statFile: stat, undeliveredOutput: () => ++reads },
    );
    expect(v.drifted).toBe(false);
    expect(v.undeliveredAssistantRecords).toBeNull();
    expect(reads).toBe(0);
  });
});

describe("checkDrift — live-subagent-activity liveness gate", () => {
  const NOW = 1_800_000_000_000;
  // Undelivered main-stream output present (lag 400s, 3 records) — without the
  // liveness gate this would kill. sessionDir points at the CLI's sibling tree.
  const base: DriftDetectorSessionState = {
    sessionId: "s",
    bunLastFrameMs: NOW - 400_000,
    jsonlPath: "/tmp/cli.jsonl",
    sessionDir: "/tmp/cli",
  };
  const stat = (p: unknown) => (String(p) === "/tmp/cli.jsonl" ? { mtimeMs: NOW - 3_000 } : null);

  it("withholds the kill when the subagent tree has fresh writes (council / Task fan-out)", () => {
    // The CLI is alive mid fan-out — quiet stdout is expected, not a dead pipe.
    const calls: Array<[string, number]> = [];
    const v = checkDrift(base, {
      now: () => NOW,
      statFile: stat,
      undeliveredOutput: () => 3,
      subagentActivitySince: (dir, since) => {
        calls.push([dir, since]);
        return true;
      },
    });
    expect(v.drifted).toBe(false);
    expect(v.suppressedReason).toBe("live_subagent_activity");
    expect(v.undeliveredAssistantRecords).toBe(3);
    // Liveness asked about the session dir over the recent window only: bun's
    // last frame (400 s ago) is older than the window, so the floor is
    // `now - SUBAGENT_LIVENESS_WINDOW_MS` (review 2026-10-14-2248 #1).
    expect(calls).toEqual([["/tmp/cli", NOW - SUBAGENT_LIVENESS_WINDOW_MS]]);
  });

  it("floors the liveness window at bun's last frame when that is more recent", () => {
    // A write before bun's last frame was already delivered context, never
    // evidence of fresh life — the floor is max(bunLastFrameMs, now - window).
    const calls: number[] = [];
    checkDrift(
      { ...base, bunLastFrameMs: NOW - 60_000 },
      {
        now: () => NOW,
        statFile: stat,
        undeliveredOutput: () => 3,
        subagentActivitySince: (_dir, since) => { calls.push(since); return true; },
      },
    );
    expect(calls).toEqual([NOW - 60_000]);
  });

  it("a subagent write after bun's last frame but older than the window does NOT suppress (review #1 wedge)", () => {
    // Review 2026-10-14-2248 P1 #1: stdout dies at T0 (bunLastFrameMs freezes),
    // the fan-out finishes a little later and its subagent file keeps an mtime
    // > T0 forever. Measured only "since bun's last frame", that stale write
    // suppressed the kill on every tick until the 30 min idle window dropped the
    // session for good. Liveness must mean "written recently", so a tree that
    // went quiet longer than the window ago lets the recovery fire.
    const lastSubagentWriteMs = NOW - SUBAGENT_LIVENESS_WINDOW_MS - 30_000; // > bunLastFrameMs, < window
    expect(lastSubagentWriteMs).toBeGreaterThan(base.bunLastFrameMs);
    const v = checkDrift(base, {
      now: () => NOW,
      statFile: stat,
      undeliveredOutput: () => 3,
      subagentActivitySince: (_dir, since) => lastSubagentWriteMs > since,
    });
    expect(v.drifted).toBe(true);
    expect(v.suppressedReason).toBeNull();
  });

  it("still kills when the subagent tree is idle (genuine stdout death)", () => {
    const v = checkDrift(base, {
      now: () => NOW,
      statFile: stat,
      undeliveredOutput: () => 3,
      subagentActivitySince: () => false,
    });
    expect(v.drifted).toBe(true);
    expect(v.suppressedReason).toBeNull();
    expect(v.undeliveredAssistantRecords).toBe(3);
  });

  it("does not consult the liveness check when there is no undelivered output", () => {
    // The fs scan must stay off the hot path — only runs after positive evidence.
    let called = 0;
    const v = checkDrift(base, {
      now: () => NOW,
      statFile: stat,
      undeliveredOutput: () => 0,
      subagentActivitySince: () => { called++; return true; },
    });
    expect(v.suppressedReason).toBe("no_undelivered_output");
    expect(called).toBe(0);
  });

  it("kills (no liveness suppression) when sessionDir is unknown", () => {
    const v = checkDrift(
      { ...base, sessionDir: null },
      { now: () => NOW, statFile: stat, undeliveredOutput: () => 3, subagentActivitySince: () => true },
    );
    expect(v.drifted).toBe(true);
    expect(v.suppressedReason).toBeNull();
  });
});

describe("defaultSubagentActivitySince (reads the sibling subagent tree)", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("returns true when a subagents/ file is newer than sinceMs", () => {
    dir = mkdtempSync(join(tmpdir(), "drift-sub-"));
    mkdirSync(join(dir, "subagents"));
    const f = join(dir, "subagents", "agent-1.jsonl");
    writeFileSync(f, "{}\n");
    const nowSec = Date.now() / 1000;
    utimesSync(f, nowSec, nowSec); // mtime = now
    expect(defaultSubagentActivitySince(dir, Date.now() - 60_000)).toBe(true);
  });

  it("returns false when all subagent files are older than sinceMs", () => {
    dir = mkdtempSync(join(tmpdir(), "drift-sub-"));
    mkdirSync(join(dir, "tool-results"));
    const f = join(dir, "tool-results", "r1.json");
    writeFileSync(f, "{}\n");
    const oldSec = (Date.now() - 600_000) / 1000;
    utimesSync(f, oldSec, oldSec);
    expect(defaultSubagentActivitySince(dir, Date.now() - 60_000)).toBe(false);
  });

  it("returns false when the session dir has no subagent subtrees", () => {
    dir = mkdtempSync(join(tmpdir(), "drift-sub-"));
    expect(defaultSubagentActivitySince(dir, 0)).toBe(false);
  });

  it("counts a fresh tool-results/ file as activity (not only subagents/)", () => {
    // Review B-2: an implementation that scanned only subagents/ passed every test.
    dir = mkdtempSync(join(tmpdir(), "drift-sub-"));
    mkdirSync(join(dir, "tool-results"));
    const f = join(dir, "tool-results", "r1.txt");
    writeFileSync(f, "x");
    const nowSec = Date.now() / 1000;
    utimesSync(f, nowSec, nowSec);
    expect(defaultSubagentActivitySince(dir, Date.now() - 60_000)).toBe(true);
  });

  it("mtime equal to sinceMs is not activity (strict boundary)", () => {
    dir = mkdtempSync(join(tmpdir(), "drift-sub-"));
    mkdirSync(join(dir, "subagents"));
    const f = join(dir, "subagents", "agent-1.jsonl");
    writeFileSync(f, "{}\n");
    const atMs = Math.floor(Date.now() / 1000) * 1000 - 5_000; // whole second: exact round-trip
    utimesSync(f, atMs / 1000, atMs / 1000);
    expect(defaultSubagentActivitySince(dir, atMs)).toBe(false);
    expect(defaultSubagentActivitySince(dir, atMs - 1)).toBe(true);
  });

  it("ignores symlinks and directories — only regular files are evidence (review #8)", () => {
    // A symlink's target mtime (or a nested dir's entry-change mtime) says
    // nothing about the CLI writing its own subagent output.
    dir = mkdtempSync(join(tmpdir(), "drift-sub-"));
    mkdirSync(join(dir, "subagents"));
    const outside = join(dir, "outside.txt");
    writeFileSync(outside, "x");
    symlinkSync(outside, join(dir, "subagents", "agent-link.jsonl"));
    mkdirSync(join(dir, "subagents", "nested"));
    expect(defaultSubagentActivitySince(dir, Date.now() - 60_000)).toBe(false);
  });
});

// Prod 2026-10-09, Rapesha_shop_bot (recording 41054082…, CLI jsonl
// 0537e6d7…): bun's last CLI frame 18:14:43 (control_response); the user's
// "жду вердикт" reached stdin 18:14:52; the CLI wrote thinking 18:14:56 and
// its answer 18:15:16 to the jsonl and emitted NOTHING on stdout. The old
// thresholds never fired (lag 33 s < 90 s, then the jsonl went "idle" at
// 18:17:16); the user waited 12 min and had to ask again. These tests pin
// that a short stalled answer is now caught on the first tick after the
// record is 10 s old, and stays catchable after the jsonl goes quiet.
describe("checkDrift — short stalled answer (evidence windows)", () => {
  const at = (hms: string) => Date.parse(`2026-10-09T${hms}.000Z`);
  const lastFrame = at("18:14:43");
  const jsonl = [
    { type: "user", timestamp: "2026-10-09T18:14:52.000Z" },
    { type: "assistant", timestamp: "2026-10-09T18:14:56.000Z" },
    { type: "assistant", timestamp: "2026-10-09T18:15:16.000Z" },
    { type: "system", timestamp: "2026-10-09T18:15:16.000Z" },
  ];
  const chunk = jsonl.map((r) => JSON.stringify(r)).join("\n");
  const tick = (now: number, gated: boolean) =>
    checkDrift(
      { sessionId: "s", bunLastFrameMs: lastFrame, jsonlPath: "/replay/cli.jsonl" },
      {
        now: () => now,
        statFile: () => ({ mtimeMs: at("18:15:16") }),
        undeliveredOutput: gated ? (_p, since, until) => countAssistantRecordsBetween(chunk, since, until) : undefined,
      },
    );

  it("timing-only check (no evidence dep) still misses it — documents the old blind spot", () => {
    expect(tick(at("18:15:30"), false).drifted).toBe(false);
    expect(tick(at("18:20:00"), false).drifted).toBe(false);
  });

  it("with the evidence check: kills on the first tick once the answer is 10 s old", () => {
    // 18:15:20 — the 18:15:16 record is only 4 s old, but the 18:14:56
    // thinking record already counts: the stall is proven.
    const v = tick(at("18:15:20"), true);
    expect(v.drifted).toBe(true);
    expect(v.undeliveredAssistantRecords).toBe(1);
  });

  it("with the evidence check: still kills after the jsonl went quiet (old idle cutoff)", () => {
    const v = tick(at("18:20:00"), true);
    expect(v.drifted).toBe(true);
    expect(v.undeliveredAssistantRecords).toBe(2);
  });

  it("a quiet, healthy session past the 30 min window is not even examined", () => {
    let reads = 0;
    const v = checkDrift(
      { sessionId: "s", bunLastFrameMs: lastFrame, jsonlPath: "/replay/cli.jsonl" },
      { now: () => at("18:46:00"), statFile: () => ({ mtimeMs: at("18:15:16") }), undeliveredOutput: () => ++reads },
    );
    expect(v.drifted).toBe(false);
    expect(reads).toBe(0);
  });

  it("a healthy turn whose frames arrived is never killed: no assistant record newer than bun's last frame", () => {
    // Same jsonl, but bun DID receive the 18:15:16 result frame.
    const v = checkDrift(
      { sessionId: "s", bunLastFrameMs: at("18:15:16"), jsonlPath: "/replay/cli.jsonl" },
      {
        now: () => at("18:16:00"),
        statFile: () => ({ mtimeMs: at("18:15:16") }),
        undeliveredOutput: (_p, since, until) => countAssistantRecordsBetween(chunk, since, until),
      },
    );
    expect(v.drifted).toBe(false);
  });

  it("a prompt queued on an idle session with no model output yet is withheld (P7 false-kill guard holds)", () => {
    const v = checkDrift(
      { sessionId: "s", bunLastFrameMs: at("18:14:43"), jsonlPath: "/replay/cli.jsonl" },
      {
        // Prompt written 15 s after bun's last frame (past the 10 s lag
        // tolerance, so the evidence check runs) and no model output yet.
        now: () => at("18:15:10"),
        statFile: () => ({ mtimeMs: at("18:14:58") }),
        undeliveredOutput: (_p, since, until) =>
          countAssistantRecordsBetween(JSON.stringify({ type: "user", timestamp: "2026-10-09T18:14:58.000Z" }), since, until),
      },
    );
    expect(v.drifted).toBe(false);
    expect(v.suppressedReason).toBe("no_undelivered_output");
  });
});

// EC-6 replay: real prod kills (journal `silent_stdio_drift.detected`) with
// the CLI's own jsonl around them, reduced to record type/timestamp (see
// __fixtures__/silent-stdio-drift/README.md). Each case replays the tick that
// killed in prod: the old check must still fire (proves the fixture
// reproduces the kill); the gated check must keep the real stall and drop the
// false ones.
describe("checkDrift — replay of prod drift kills", () => {
  interface Fixture {
    bunLastFrameMs: number;
    originalKillAtMs: number;
    jsonl: Array<{ type: string; timestamp: string }>;
  }
  const load = (name: string): Fixture =>
    JSON.parse(readFileSync(join(__dirname, "__fixtures__", "silent-stdio-drift", `${name}.json`), "utf-8"));

  function replayAtKillTick(fx: Fixture, gated: boolean) {
    const now = fx.originalKillAtMs;
    const visible = fx.jsonl.filter((r) => Date.parse(r.timestamp) <= now);
    const chunk = visible.map((r) => JSON.stringify(r)).join("\n");
    const mtime = Math.max(...visible.map((r) => Date.parse(r.timestamp)));
    return checkDrift(
      { sessionId: "replay", bunLastFrameMs: fx.bunLastFrameMs, jsonlPath: "/replay/cli.jsonl" },
      {
        now: () => now,
        statFile: () => ({ mtimeMs: mtime }),
        undeliveredOutput: gated ? (_p, since, until) => countAssistantRecordsBetween(chunk, since, until) : undefined,
      },
    );
  }

  it.each([
    // Session idle 7 min; user message queued 3 s before the kill tick.
    ["false-kill-input-after-idle"],
    // Session idle 85 min; CLI-internal scheduled prompt queued 4 s before the kill tick.
    ["false-kill-scheduled-wake"],
  ])("%s: prod killed a turn seconds old; the gated check withholds", (name) => {
    const fx = load(name);
    expect(replayAtKillTick(fx, false).drifted).toBe(true);
    const v = replayAtKillTick(fx, true);
    expect(v.drifted).toBe(false);
    expect(v.suppressedReason).toBe("no_undelivered_output");
  });

  it("real-stdout-stall: the CLI wrote 72 s of model output bun never got; the gated check still kills", () => {
    // Protocol recording for this kill: no inbound CLI frame between
    // bunLastFrameMs and the kill, while the jsonl gained thinking, text,
    // tool_use and tool_result records — a genuinely dead stdout channel.
    const fx = load("real-stdout-stall");
    expect(replayAtKillTick(fx, false).drifted).toBe(true);
    const v = replayAtKillTick(fx, true);
    expect(v.drifted).toBe(true);
    expect(v.undeliveredAssistantRecords).toBeGreaterThan(0);
  });
});


// Observer review 2026-10-14 WARN 1: a subagent inside ONE long tool call
// (slow test run, long fetch) writes nothing under its tree until the call
// returns, so the 5 min mtime window alone would read it as dead mid fan-out.
// An open tool call keeps the tree alive up to SUBAGENT_OPEN_TOOL_CALL_CEILING_MS.
describe("endsInOpenToolCall (subagent transcript tail)", () => {
  const rec = (o: object) => JSON.stringify(o);
  const toolUse = rec({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] } });
  const toolResult = rec({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } });
  const endTurn = rec({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "done" }], stop_reason: "end_turn" } });
  const attachment = rec({ type: "attachment" });

  it("true when the last meaningful record is an assistant tool_use", () => {
    expect(endsInOpenToolCall([toolResult, toolUse].join("\n") + "\n")).toBe(true);
  });

  it("skips trailing attachment records (CLI 2.1.283 interleaves them)", () => {
    expect(endsInOpenToolCall([toolUse, attachment, attachment].join("\n"))).toBe(true);
  });

  it("false once the tool_result landed, or when the subagent finished its turn", () => {
    expect(endsInOpenToolCall([toolUse, toolResult].join("\n"))).toBe(false);
    expect(endsInOpenToolCall([toolUse, toolResult, attachment, endTurn].join("\n"))).toBe(false);
  });

  it("tolerates a tail that starts mid-record and empty input", () => {
    expect(endsInOpenToolCall('tent":"x"}}\n' + toolUse)).toBe(true);
    expect(endsInOpenToolCall("")).toBe(false);
  });
});

describe("openToolCallStartedAt / mainThreadOpenToolCallStartedAt (main jsonl tail)", () => {
  // Owner incident 2026-10-18: drift kills always landed mid Bash call on the
  // main thread and lost the running command. The recovery tick needs to know
  // whether the main chain is inside a tool call and since when.
  const rec = (o: object) => JSON.stringify(o);
  const T1 = "2026-10-18T04:14:31.318Z";
  const toolUse = rec({ type: "assistant", timestamp: T1, message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] } });
  const toolResult = rec({ type: "user", timestamp: "2026-10-18T04:14:36.529Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } });
  const text = rec({ type: "assistant", timestamp: "2026-10-18T04:14:24.493Z", message: { role: "assistant", content: [{ type: "text", text: "x" }] } });
  const attachment = rec({ type: "attachment" });
  const prLink = rec({ type: "pr-link" });
  const sidechainUse = rec({ type: "assistant", isSidechain: true, timestamp: "2026-10-18T04:14:40.000Z", message: { content: [{ type: "tool_use", id: "s1", name: "Bash", input: {} }] } });

  it("returns the tool_use record's timestamp when the chain ends inside a tool call", () => {
    expect(openToolCallStartedAt([text, toolUse].join("\n") + "\n")).toBe(Date.parse(T1));
  });

  it("skips trailing attachment / pr-link records (prod jsonl 04:14:31 → 04:14:36 shape)", () => {
    expect(openToolCallStartedAt([toolUse, prLink, attachment].join("\n"))).toBe(Date.parse(T1));
  });

  it("null once the tool_result landed, or when the last assistant record is text", () => {
    expect(openToolCallStartedAt([toolUse, toolResult].join("\n"))).toBeNull();
    expect(openToolCallStartedAt([toolUse, toolResult, text].join("\n"))).toBeNull();
  });

  it("ignores sidechain records and tolerates a tail that starts mid-record", () => {
    // A subagent's tool_use interleaved in the main jsonl (older layouts) must
    // not report the main thread as busy; the main chain's own state decides.
    expect(openToolCallStartedAt([toolUse, toolResult, sidechainUse].join("\n"))).toBeNull();
    expect(openToolCallStartedAt('tent":"x"}}\n' + toolUse)).toBe(Date.parse(T1));
    expect(openToolCallStartedAt("")).toBeNull();
  });

  it("parallel calls: stays open until EVERY tool_use is answered, bounded by the oldest (prod 18:16:04)", () => {
    // One assistant message with three tool_use blocks; results land out of order.
    const T0 = "2026-10-18T18:15:29.375Z";
    const three = rec({ type: "assistant", timestamp: T0, message: { role: "assistant", content: [
      { type: "tool_use", id: "a", name: "Bash", input: {} },
      { type: "tool_use", id: "b", name: "Bash", input: {} },
      { type: "tool_use", id: "c", name: "Bash", input: {} },
    ] } });
    const res = (id: string, ts: string) => rec({ type: "user", timestamp: ts, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });
    const later = rec({ type: "assistant", timestamp: "2026-10-18T18:15:38.524Z", message: { role: "assistant", content: [{ type: "tool_use", id: "d", name: "Bash", input: {} }] } });
    // first result landed, two still running → still open, since the message that opened them
    expect(openToolCallStartedAt([three, res("b", "2026-10-18T18:15:57.308Z")].join("\n"))).toBe(Date.parse(T0));
    // a newer call opened while older ones run → the OLDEST bounds the deferral
    expect(openToolCallStartedAt([three, later, res("b", "2026-10-18T18:15:57.308Z")].join("\n"))).toBe(Date.parse(T0));
    // all four answered → closed
    const all = [three, later, res("a", "2026-10-18T18:16:00Z"), res("b", "2026-10-18T18:16:01Z"), res("c", "2026-10-18T18:16:02Z"), res("d", "2026-10-18T18:16:03Z")];
    expect(openToolCallStartedAt(all.join("\n"))).toBeNull();
  });

  it("null when the open record has no parseable timestamp (unbounded deferral is never allowed)", () => {
    const noTs = rec({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] } });
    expect(openToolCallStartedAt(noTs)).toBeNull();
  });

  it("mainThreadOpenToolCallStartedAt reads the real file tail and returns null on a missing file", () => {
    const dir = mkdtempSync(join(tmpdir(), "drift-main-open-"));
    try {
      const path = join(dir, "main.jsonl");
      writeFileSync(path, [text, toolUse].join("\n") + "\n");
      expect(mainThreadOpenToolCallStartedAt(path)).toBe(Date.parse(T1));
      writeFileSync(path, [toolUse, toolResult].join("\n") + "\n");
      expect(mainThreadOpenToolCallStartedAt(path)).toBeNull();
      expect(mainThreadOpenToolCallStartedAt(join(dir, "missing.jsonl"))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("checkDrift — open subagent tool call keeps a quiet tree alive", () => {
  const NOW = 1_800_000_000_000;
  const base: DriftDetectorSessionState = {
    sessionId: "s",
    bunLastFrameMs: NOW - 20 * 60_000,
    jsonlPath: "/tmp/cli.jsonl",
    sessionDir: "/tmp/cli",
  };
  const stat = (p: unknown) => (String(p) === "/tmp/cli.jsonl" ? { mtimeMs: NOW - 3_000 } : null);

  it("quiet past the 5 min window but an open tool call → live_subagent_activity, probed with the 15 min ceiling (not floored at bun's last frame)", () => {
    const since: number[] = [];
    const v = checkDrift(base, {
      now: () => NOW,
      statFile: stat,
      undeliveredOutput: () => 2,
      subagentActivitySince: () => false,
      subagentOpenToolCallSince: (_d, s) => { since.push(s); return true; },
    });
    expect(v).toMatchObject({ drifted: false, suppressedReason: "live_subagent_activity" });
    expect(since).toEqual([NOW - SUBAGENT_OPEN_TOOL_CALL_CEILING_MS]);
  });

  it("an open call last written beyond the ceiling no longer suppresses (no wedge from a subagent that died mid-call)", () => {
    const lastWrite = NOW - SUBAGENT_OPEN_TOOL_CALL_CEILING_MS - 60_000;
    const v = checkDrift(base, {
      now: () => NOW,
      statFile: stat,
      undeliveredOutput: () => 2,
      subagentActivitySince: () => false,
      subagentOpenToolCallSince: (_d, s) => lastWrite > s,
    });
    expect(v.drifted).toBe(true);
  });

  it("the open-call probe is not consulted when recent activity already proves life", () => {
    let called = 0;
    checkDrift(base, {
      now: () => NOW,
      statFile: stat,
      undeliveredOutput: () => 2,
      subagentActivitySince: () => true,
      subagentOpenToolCallSince: () => { called++; return true; },
    });
    expect(called).toBe(0);
  });
});

describe("defaultSubagentOpenToolCallSince (real files)", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });
  const toolUse = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] } });
  const endTurn = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "done" }] } });

  function agent(name: string, body: string, agoMs: number) {
    mkdirSync(join(dir!, "subagents"), { recursive: true });
    const f = join(dir!, "subagents", name);
    writeFileSync(f, body + "\n");
    const t = (Date.now() - agoMs) / 1000;
    utimesSync(f, t, t);
  }

  it("true for an agent transcript written after sinceMs that ends in an open tool call", () => {
    dir = mkdtempSync(join(tmpdir(), "drift-open-"));
    agent("agent-a.jsonl", toolUse, 8 * 60_000);
    expect(defaultSubagentOpenToolCallSince(dir, Date.now() - 15 * 60_000)).toBe(true);
  });

  it("false for a finished agent, a transcript older than sinceMs, or a non-jsonl file", () => {
    dir = mkdtempSync(join(tmpdir(), "drift-open-"));
    agent("agent-done.jsonl", endTurn, 60_000);
    agent("agent-old.jsonl", toolUse, 20 * 60_000);
    agent("agent-x.meta.json", toolUse, 60_000);
    expect(defaultSubagentOpenToolCallSince(dir, Date.now() - 15 * 60_000)).toBe(false);
  });

  it("false when there is no subagents/ dir", () => {
    dir = mkdtempSync(join(tmpdir(), "drift-open-"));
    expect(defaultSubagentOpenToolCallSince(dir, 0)).toBe(false);
  });
});
