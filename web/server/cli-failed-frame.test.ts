import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildCliFailedFrame } from "./cli-failed-frame.js";

// AURA-LOCAL — PLAN T10 test suite. Three concerns:
//   1. Shape — every reason produces a frame with the correct
//      discriminator, derived `subprocessAlive`, and stamped origin.
//   2. Purity — the builder reads no clocks and mutates nothing;
//      identical inputs produce identical outputs.
//   3. AP-14 / EC-37 — repo-wide grep for raw `type: "cli_failed"`
//      literals in PRODUCTION code returns zero hits. Every emit
//      MUST route through `buildCliFailedFrame`; a developer who
//      hand-rolls the frame ships a wire shape the builder cannot
//      validate and risks drift (seq collision, missing origin,
//      stale `subprocessAlive` axis).

describe("buildCliFailedFrame — shape", () => {
  it.each([
    ["relaunch_exhausted" as const, false],
    ["container_missing" as const, false],
    ["container_stopped" as const, false],
    ["binary_missing" as const, false],
    ["browser_closed_no_reconnect" as const, true],
  ])("%s -> subprocessAlive=%s", (reason, alive) => {
    const frame = buildCliFailedFrame(reason, "sess_1", {
      seq: 42,
      drainedCount: 3,
      firedAt: 1_700_000_000_000,
    });
    expect(frame.type).toBe("cli_failed");
    expect(frame.sessionId).toBe("sess_1");
    expect(frame.reason).toBe(reason);
    expect(frame.subprocessAlive).toBe(alive);
    expect(frame.seq).toBe(42);
    expect(frame.drainedCount).toBe(3);
    expect(frame.firedAt).toBe(1_700_000_000_000);
    expect(frame.origin).toBe("server:cleanup-drain");
  });

  it("omits the `details` field when no opts.details supplied", () => {
    const frame = buildCliFailedFrame("relaunch_exhausted", "s", {
      seq: 1, drainedCount: 0, firedAt: 0,
    });
    expect("details" in frame).toBe(false);
  });

  it("passes through `lastErrorSha256` when supplied", () => {
    const sha = "a".repeat(64);
    const frame = buildCliFailedFrame("container_missing", "s", {
      seq: 1, drainedCount: 0, firedAt: 0,
      details: { lastErrorSha256: sha },
    });
    expect(frame.details?.lastErrorSha256).toBe(sha);
  });
});

describe("buildCliFailedFrame — purity", () => {
  it("produces identical output for identical inputs", () => {
    const a = buildCliFailedFrame("binary_missing", "sess_x", {
      seq: 7, drainedCount: 12, firedAt: 12345,
    });
    const b = buildCliFailedFrame("binary_missing", "sess_x", {
      seq: 7, drainedCount: 12, firedAt: 12345,
    });
    expect(a).toEqual(b);
  });
});
describe("AP-14 / EC-37 call-site canary", () => {
  // Brief: "EC-37 call-site canary: repo grep for raw
  // type:\"cli_failed\" literal in PRODUCTION code returns ZERO
  // hits — every emit routes through buildCliFailedFrame."
  //
  // Pure filesystem walk (no shell-out) so the canary is hermetic
  // and re-runnable in CI without a git checkout. Skips:
  //
  //   - test files (`*.test.ts` / `*.test.tsx`)
  //   - the sole assembly site itself (`cli-failed-frame.ts`)
  //   - the wire-shape declarations in `session-types.ts` and
  //     `ws-bridge-types.ts` (interface definitions, not emits)
  it("no production code constructs a `type: cli_failed` literal outside the builder", () => {
    const SERVER_DIR = __dirname;
    const FRONTEND_DIR = join(__dirname, "..", "src");
    const ALLOWED = new Set([
      join(SERVER_DIR, "cli-failed-frame.ts"),
      join(SERVER_DIR, "session-types.ts"),
      join(SERVER_DIR, "ws-bridge-types.ts"),
    ]);

    const TS_FILE_RE = /\.tsx?$/;
    const TEST_FILE_RE = /\.test\.tsx?$/;
    const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", ".vite"]);
    // EC-37 surface-detection literal. Built from chars at runtime so
    // this test file itself does not match the pattern.
    const Q = String.fromCharCode(34);
    const NEEDLE = `type: ${Q}cli_failed${Q}`;

    const offenders: string[] = [];
    function walk(dir: string): void {
      let entries: string[];
      try { entries = readdirSync(dir); } catch { return; }
      for (const name of entries) {
        if (SKIP_DIRS.has(name)) continue;
        const full = join(dir, name);
        let st;
        try { st = statSync(full); } catch { continue; }
        if (st.isDirectory()) { walk(full); continue; }
        if (!TS_FILE_RE.test(name)) continue;
        if (TEST_FILE_RE.test(name)) continue;
        if (ALLOWED.has(full)) continue;
        const body = readFileSync(full, "utf8");
        if (body.includes(NEEDLE)) offenders.push(full);
      }
    }
    walk(SERVER_DIR);
    walk(FRONTEND_DIR);
    expect(offenders).toEqual([]);
  });
});
