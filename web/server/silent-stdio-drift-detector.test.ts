import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkDrift,
  countAssistantRecordsBetween,
  countUndeliveredAssistantRecords,
  resolveJsonlPath,
  DEFAULT_LAG_TOLERANCE_MS,
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
