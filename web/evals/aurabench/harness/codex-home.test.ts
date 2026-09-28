/**
 * Tests for Codex home isolation (P6/FIX-D2-1). Real files in a temp dir — the
 * point is to prove what touches disk, so nothing is mocked except the runner.
 *
 * Validates:
 *   - the per-cell home holds ONLY an auth.json symlink to the real one;
 *   - a rotated token (symlink replaced by a regular file, as Codex's
 *     tmp+rename refresh does) is written back to the real auth.json only when
 *     the real file is unchanged since the cell started, and the cell copy is
 *     always removed (no credential left in artifacts);
 *   - the snapshot sees content, size, mtime, new and deleted files, and
 *     symlink retargeting; auth.json is the only allowed change;
 *   - the guard turns a real ~/.codex write (pilot 1: config.toml trust
 *     entries, memories sqlite) into an isolation violation, keeps a clean
 *     cell clean, and never invents a verdict for runners that have none;
 *   - the bench HOME's `.codex` pilot-1 symlink is replaced by an own dir
 *     WITHOUT touching the real ~/.codex behind it;
 *   - session-home write-back takes at most one rotated token.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  diffSnapshots,
  guardRealCodexHome,
  prepareIsolatedCodexHome,
  propagateFromSessionHomes,
  propagateRotatedCodexAuth,
  realAuthSha,
  snapshotDir,
} from "./codex-home.js";
import { prepareBenchCodexHome } from "./bench-instance.js";
import type { AgentContext, AgentRun, AgentRunner } from "./run-cell.js";
import { emptyMetrics } from "./agent-metrics.js";

let root: string;
let real: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aurabench-codex-"));
  real = join(root, "real-codex");
  mkdirSync(join(real, "memories"), { recursive: true });
  writeFileSync(join(real, "auth.json"), '{"token":"t0"}');
  writeFileSync(join(real, "config.toml"), 'model = "gpt-5.5"\n');
  writeFileSync(join(real, "AGENTS.md"), "global instructions");
  writeFileSync(join(real, "memories", "m1.md"), "memory");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** What Codex does on a token refresh: write a tmp file, rename over auth.json. */
function rotateInCell(home: string, token: string) {
  writeFileSync(join(home, "auth.json.tmp"), token);
  unlinkSync(join(home, "auth.json"));
  writeFileSync(join(home, "auth.json"), token);
  rmSync(join(home, "auth.json.tmp"));
}

describe("prepareIsolatedCodexHome", () => {
  it("creates a home with only an auth.json symlink, wiping leftovers", () => {
    const home = join(root, "cell", "codex-home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "memories_1.sqlite"), "left from a previous rep");
    const ev = prepareIsolatedCodexHome(home, real);
    expect(readdirSync(home)).toEqual(["auth.json"]);
    expect(lstatSync(join(home, "auth.json")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(home, "auth.json"))).toBe(join(real, "auth.json"));
    expect(ev).toEqual({ codex_home: home, seeded: [`auth.json -> ${join(real, "auth.json")}`] });
  });

  it("seeds nothing when the real home has no auth.json", () => {
    rmSync(join(real, "auth.json"));
    const home = join(root, "h");
    expect(prepareIsolatedCodexHome(home, real)).toMatchObject({ seeded: [] });
    expect(readdirSync(home)).toEqual([]);
  });
});

describe("propagateRotatedCodexAuth", () => {
  it("unchanged symlink: just removed, real untouched", () => {
    const home = join(root, "h");
    prepareIsolatedCodexHome(home, real);
    expect(propagateRotatedCodexAuth(home, real, realAuthSha(real))).toBe("unchanged");
    expect(existsSync(join(home, "auth.json"))).toBe(false);
    expect(readFileSync(join(real, "auth.json"), "utf8")).toBe('{"token":"t0"}');
  });

  it("rotated token: written back when the real file is unchanged since start", () => {
    const home = join(root, "h");
    const sha = realAuthSha(real);
    prepareIsolatedCodexHome(home, real);
    rotateInCell(home, '{"token":"t1"}');
    expect(propagateRotatedCodexAuth(home, real, sha)).toBe("propagated");
    expect(readFileSync(join(real, "auth.json"), "utf8")).toBe('{"token":"t1"}');
    expect(lstatSync(join(real, "auth.json")).mode & 0o777).toBe(0o600);
    expect(existsSync(join(home, "auth.json"))).toBe(false);
    // No temp file left behind in the real home.
    expect(readdirSync(real).filter((n) => n.includes("aurabench"))).toEqual([]);
  });

  it("rotated token: NOT written when someone else rotated the real file meanwhile", () => {
    const home = join(root, "h");
    const sha = realAuthSha(real);
    prepareIsolatedCodexHome(home, real);
    rotateInCell(home, '{"token":"t1"}');
    writeFileSync(join(real, "auth.json"), '{"token":"prod"}');
    expect(propagateRotatedCodexAuth(home, real, sha)).toBe("skipped_real_changed");
    expect(readFileSync(join(real, "auth.json"), "utf8")).toBe('{"token":"prod"}');
    expect(existsSync(join(home, "auth.json"))).toBe(false);
  });

  it("a regular file identical to the real one is not rewritten", () => {
    const home = join(root, "h");
    mkdirSync(home);
    writeFileSync(join(home, "auth.json"), '{"token":"t0"}');
    expect(propagateRotatedCodexAuth(home, real, realAuthSha(real))).toBe("skipped_not_newer");
  });

  it("no auth in the cell home", () => {
    const home = join(root, "h");
    mkdirSync(home);
    expect(propagateRotatedCodexAuth(home, real, null)).toBe("no_auth");
  });
});

describe("propagateFromSessionHomes", () => {
  it("writes back at most one rotated token and cleans every session copy", () => {
    const sha = realAuthSha(real);
    const sessions = join(root, "codex-home");
    for (const [sid, tok] of [["s1", "a"], ["s2", "b"], ["s3", null]] as const) {
      prepareIsolatedCodexHome(join(sessions, sid), real);
      if (tok) rotateInCell(join(sessions, sid), tok);
    }
    writeFileSync(join(sessions, "not-a-dir"), "x");
    expect(propagateFromSessionHomes(sessions, real, sha)).toEqual({
      s1: "propagated",
      s2: "skipped_real_changed",
      s3: "unchanged",
    });
    expect(readFileSync(join(real, "auth.json"), "utf8")).toBe("a");
    for (const sid of ["s1", "s2", "s3"]) expect(existsSync(join(sessions, sid, "auth.json"))).toBe(false);
  });

  it("missing root is a no-op", () => {
    expect(propagateFromSessionHomes(join(root, "none"), real, null)).toEqual({});
  });
});

describe("snapshotDir / diffSnapshots", () => {
  it("detects added, removed, modified (content, mtime) and allows auth.json", () => {
    symlinkSync(join(real, "config.toml"), join(real, "link"));
    const before = snapshotDir(real);
    expect([...before.keys()].sort()).toEqual(["AGENTS.md", "auth.json", "config.toml", "link", "memories/m1.md"]);
    writeFileSync(join(real, "auth.json"), '{"token":"t9"}');
    // Pilot 1's actual write: a trust entry appended to config.toml.
    writeFileSync(join(real, "config.toml"), 'model = "gpt-5.5"\n[projects."/bench/wt/cell"]\ntrust_level = "trusted"\n');
    writeFileSync(join(real, "memories_1.sqlite"), "db");
    rmSync(join(real, "memories", "m1.md"));
    const t = new Date("2020-01-01T00:00:00Z");
    utimesSync(join(real, "AGENTS.md"), t, t); // same bytes, touched
    unlinkSync(join(real, "link"));
    symlinkSync(join(real, "AGENTS.md"), join(real, "link"));
    expect(diffSnapshots(before, snapshotDir(real), ["auth.json"])).toEqual({
      added: ["memories_1.sqlite"],
      removed: ["memories/m1.md"],
      modified: ["AGENTS.md", "config.toml", "link"],
    });
  });

  it("a missing dir is an empty snapshot", () => {
    expect(snapshotDir(join(root, "nope")).size).toBe(0);
  });
});

describe("guardRealCodexHome", () => {
  const ctx = { artifactDir: "/a" } as AgentContext;
  const done = (isolation: Record<string, unknown>): AgentRun => ({
    kind: "done",
    status: "completed",
    metrics: emptyMetrics(),
    isolation,
    confounds: [],
  });

  it("clean cell: diff recorded, verdict kept", async () => {
    const r = await guardRealCodexHome(async () => done({ isolated: true, violations: [] }), { realCodexDir: real })(ctx);
    expect(r).toMatchObject({
      kind: "done",
      isolation: { isolated: true, violations: [], real_codex_home: { files: 4, unchanged: true, added: [], removed: [], modified: [] } },
    });
  });

  it("an auth refresh alone is allowed", async () => {
    const runner: AgentRunner = async () => {
      writeFileSync(join(real, "auth.json"), '{"token":"t2"}');
      return done({ isolated: true });
    };
    const r = await guardRealCodexHome(runner, { realCodexDir: real })(ctx);
    expect(r).toMatchObject({ isolation: { isolated: true, real_codex_home: { unchanged: true } } });
  });

  it("a write to the real ~/.codex is a violation, even for a runner that claimed isolation", async () => {
    const runner: AgentRunner = async () => {
      writeFileSync(join(real, "config.toml"), 'trust_level = "trusted"\n');
      mkdirSync(join(real, "shell_snapshots"));
      writeFileSync(join(real, "shell_snapshots", "s.sh"), "x");
      return done({ isolated: true, violations: [] });
    };
    const r = await guardRealCodexHome(runner, { realCodexDir: real })(ctx);
    if (r.kind !== "done") throw new Error("expected done");
    expect(r.isolation.isolated).toBe(false);
    expect(r.isolation.violations).toEqual(["real ~/.codex changed during the cell: shell_snapshots/s.sh, config.toml"]);
    expect(r.isolation.real_codex_home).toMatchObject({ unchanged: false, added: ["shell_snapshots/s.sh"], modified: ["config.toml"] });
  });

  it("does not invent a verdict for a runner without one (Aura), but flags a dirty diff", async () => {
    const clean = await guardRealCodexHome(async () => done({ instance_port: 3499 }), { realCodexDir: real })(ctx);
    if (clean.kind !== "done") throw new Error("expected done");
    expect("isolated" in clean.isolation).toBe(false);
    const dirty = await guardRealCodexHome(
      async () => (writeFileSync(join(real, "x"), "y"), done({ instance_port: 3499 })),
      { realCodexDir: real },
    )(ctx);
    if (dirty.kind !== "done") throw new Error("expected done");
    expect(dirty.isolation.isolated).toBe(false);
  });

  it("limit outcomes pass through untouched", async () => {
    const limit: AgentRun = { kind: "limit", limit: { resetAt: null, message: "429" } };
    expect(await guardRealCodexHome(async () => limit, { realCodexDir: real })(ctx)).toBe(limit);
  });
});

describe("prepareBenchCodexHome", () => {
  it("replaces a pilot-1 symlink to the real ~/.codex without touching its target", () => {
    const bench = join(root, "aura-home", ".codex");
    mkdirSync(join(root, "aura-home"));
    symlinkSync(real, bench);
    const before = snapshotDir(real);
    prepareBenchCodexHome(bench, real);
    expect(lstatSync(bench).isDirectory()).toBe(true);
    expect(readdirSync(bench)).toEqual(["auth.json"]);
    expect(readlinkSync(join(bench, "auth.json"))).toBe(join(real, "auth.json"));
    expect(diffSnapshots(before, snapshotDir(real))).toEqual({ added: [], removed: [], modified: [] });
    // Idempotent.
    prepareBenchCodexHome(bench, real);
    expect(readdirSync(bench)).toEqual(["auth.json"]);
  });
});
