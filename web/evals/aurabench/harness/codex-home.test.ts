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
 *   - session-home write-back takes at most one rotated token;
 *   - FIX-D2-1b: a rotation is written back WHILE the cell runs (keeper poll),
 *     on SIGINT/SIGTERM before exit, and after a runner exception; a token
 *     that cannot be written back is stashed, never deleted, and a run killed
 *     hard is recovered from the on-disk ledger on the next start; empty
 *     directories and limit outcomes are covered by the snapshot guard.
 *   - FIX-D2-1c (review of #254): a copy that existed BEFORE the watch (a
 *     stale token from an earlier run) is never written into the real file —
 *     not on sync, release, recover, or from an old-format ledger; the base is
 *     pinned at cell start, so after an external re-login an old-family token
 *     is stashed instead of written; a logged-out (absent/empty) real file is
 *     never refilled from a cell or the stash; the signal handler stops the
 *     agent processes BEFORE releasing homes; a failing ledger write in the
 *     poll does not throw.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
  syncRotatedCodexAuth,
  retryStashedCodexAuth,
  CodexAuthKeeper,
  authSafeSignalHandler,
  withCodexAuthWatch,
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

  it("rotated token: NOT written when someone else rotated the real file meanwhile — and NOT deleted", () => {
    // FIX-D2-1b: a token that could not be written back may be the only live
    // one; it is kept (in place without a stash dir, moved to the stash with one).
    const home = join(root, "h");
    const sha = realAuthSha(real);
    prepareIsolatedCodexHome(home, real);
    rotateInCell(home, '{"token":"t1"}');
    writeFileSync(join(real, "auth.json"), '{"token":"prod"}');
    expect(propagateRotatedCodexAuth(home, real, sha)).toBe("skipped_real_changed");
    expect(readFileSync(join(real, "auth.json"), "utf8")).toBe('{"token":"prod"}');
    expect(readFileSync(join(home, "auth.json"), "utf8")).toBe('{"token":"t1"}');
    const stash = join(root, "stash");
    expect(propagateRotatedCodexAuth(home, real, sha, stash)).toBe("skipped_real_changed");
    expect(existsSync(join(home, "auth.json"))).toBe(false);
    const [f] = readdirSync(stash);
    expect(lstatSync(join(stash, f)).mode & 0o777).toBe(0o600);
    const meta = JSON.parse(readFileSync(join(stash, f), "utf8"));
    expect(Buffer.from(meta.auth, "base64").toString()).toBe('{"token":"t1"}');
    expect(meta.base).toBe(sha);
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
  it("writes back at most one rotated token; in-sync copies are cleaned, the other is stashed", () => {
    const sha = realAuthSha(real);
    const sessions = join(root, "codex-home");
    for (const [sid, tok] of [["s1", "a"], ["s2", "b"], ["s3", null]] as const) {
      prepareIsolatedCodexHome(join(sessions, sid), real);
      if (tok) rotateInCell(join(sessions, sid), tok);
    }
    writeFileSync(join(sessions, "not-a-dir"), "x");
    const stash = join(root, "stash");
    expect(propagateFromSessionHomes(sessions, real, sha, stash)).toEqual({
      s1: "propagated",
      s2: "skipped_real_changed",
      s3: "unchanged",
    });
    expect(readFileSync(join(real, "auth.json"), "utf8")).toBe("a");
    for (const sid of ["s1", "s2", "s3"]) expect(existsSync(join(sessions, sid, "auth.json"))).toBe(false);
    // s2's token was not written back, so it is kept in the stash, not lost.
    expect(readdirSync(stash)).toHaveLength(1);
  });

  it("missing root is a no-op", () => {
    expect(propagateFromSessionHomes(join(root, "none"), real, null)).toEqual({});
  });
});

describe("snapshotDir / diffSnapshots", () => {
  it("detects added, removed, modified (content, mtime) and allows auth.json", () => {
    symlinkSync(join(real, "config.toml"), join(real, "link"));
    const before = snapshotDir(real);
    expect([...before.keys()].sort()).toEqual(["AGENTS.md", "auth.json", "config.toml", "link", "memories", "memories/m1.md"]);
    writeFileSync(join(real, "auth.json"), '{"token":"t9"}');
    // Pilot 1's actual write: a trust entry appended to config.toml.
    writeFileSync(join(real, "config.toml"), 'model = "gpt-5.5"\n[projects."/bench/wt/cell"]\ntrust_level = "trusted"\n');
    writeFileSync(join(real, "memories_1.sqlite"), "db");
    rmSync(join(real, "memories", "m1.md"));
    const t = new Date("2020-01-01T00:00:00Z");
    utimesSync(join(real, "AGENTS.md"), t, t); // same bytes, touched
    unlinkSync(join(real, "link"));
    symlinkSync(join(real, "AGENTS.md"), join(real, "link"));
    const after = snapshotDir(real);
    // Deleting m1.md also bumps the mtime of its directory.
    utimesSync(join(real, "memories"), new Date(), new Date(Date.now() + 5000));
    expect(diffSnapshots(before, snapshotDir(real), ["auth.json"])).toEqual({
      added: ["memories_1.sqlite"],
      removed: ["memories/m1.md"],
      modified: ["AGENTS.md", "config.toml", "link", "memories"],
    });
    expect(after.get("memories")?.sha256).toBe("dir");
  });

  it("an EMPTY directory created or removed in the real home is a diff (FIX-D2-1b)", () => {
    // Pilot 1 left shell_snapshots/logs/memories dirs; a files-only snapshot
    // could not see an empty one appear or vanish.
    const before = snapshotDir(real);
    mkdirSync(join(real, "shell_snapshots"));
    expect(diffSnapshots(before, snapshotDir(real))).toEqual({ added: ["shell_snapshots"], removed: [], modified: [] });
    const withDir = snapshotDir(real);
    rmSync(join(real, "shell_snapshots"), { recursive: true });
    expect(diffSnapshots(withDir, snapshotDir(real))).toEqual({ added: [], removed: ["shell_snapshots"], modified: [] });
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
    expect(r.isolation.violations).toEqual(["real ~/.codex changed during the cell: shell_snapshots, shell_snapshots/s.sh, config.toml"]);
    expect(r.isolation.real_codex_home).toMatchObject({
      unchanged: false,
      added: ["shell_snapshots", "shell_snapshots/s.sh"],
      modified: ["config.toml"],
    });
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
    const reported: unknown[] = [];
    const r = await guardRealCodexHome(async () => limit, { realCodexDir: real, onLimitViolation: (d) => reported.push(d) })(ctx);
    expect(r).toBe(limit);
    expect(reported).toEqual([]);
  });

  it("a limit outcome is compared too: a dirty diff is reported, since no record is written (FIX-D2-1b)", async () => {
    const limit: AgentRun = { kind: "limit", limit: { resetAt: null, message: "429" } };
    const reported: unknown[] = [];
    const runner: AgentRunner = async () => (writeFileSync(join(real, "config.toml"), "x"), limit);
    const r = await guardRealCodexHome(runner, { realCodexDir: real, onLimitViolation: (d) => reported.push(d) })(ctx);
    expect(r).toBe(limit);
    expect(reported).toEqual([{ added: [], removed: [], modified: ["config.toml"] }]);
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

describe("syncRotatedCodexAuth (non-destructive, FIX-D2-1b)", () => {
  it("writes a rotation back immediately and leaves the cell copy for the running Codex", () => {
    const home = join(root, "h");
    const sha = realAuthSha(real);
    prepareIsolatedCodexHome(home, real);
    rotateInCell(home, "t1");
    const r = syncRotatedCodexAuth(home, real, sha);
    expect(r).toEqual({ outcome: "propagated", base: realAuthSha(real) });
    expect(readFileSync(join(real, "auth.json"), "utf8")).toBe("t1");
    // Not touched: replacing it under a live Codex could clobber a newer rotation.
    expect(readFileSync(join(home, "auth.json"), "utf8")).toBe("t1");
    // A second rotation in the same cell derives from t1 → written back too.
    rotateInCell(home, "t2");
    expect(syncRotatedCodexAuth(home, real, r.base).outcome).toBe("propagated");
    expect(readFileSync(join(real, "auth.json"), "utf8")).toBe("t2");
  });

  it("a copy already equal to the real file is in sync, not rewritten", () => {
    const home = join(root, "h");
    mkdirSync(home);
    writeFileSync(join(home, "auth.json"), '{"token":"t0"}');
    expect(syncRotatedCodexAuth(home, real, null)).toEqual({ outcome: "skipped_not_newer", base: realAuthSha(real) });
  });
});

describe("CodexAuthKeeper (FIX-D2-1b)", () => {
  const keeper = () => new CodexAuthKeeper({ realCodexDir: real, stateDir: join(root, "state") });

  it("syncAll writes a mid-cell rotation back without waiting for the end of the cell", () => {
    const k = keeper();
    const home = join(root, "cell", "codex-home");
    prepareIsolatedCodexHome(home, real);
    k.watch(home, "home", realAuthSha(real));
    rotateInCell(home, "t1");
    k.syncAll();
    expect(readFileSync(join(real, "auth.json"), "utf8")).toBe("t1");
    // A later rotation in the same cell is followed as well.
    rotateInCell(home, "t2");
    k.syncAll();
    expect(readFileSync(join(real, "auth.json"), "utf8")).toBe("t2");
    expect(k.release(home)).toEqual({ "auth.json": "skipped_not_newer" });
    expect(existsSync(join(home, "auth.json"))).toBe(false);
  });

  it("the poller does the write-back on its own", async () => {
    const k = keeper();
    const home = join(root, "h");
    prepareIsolatedCodexHome(home, real);
    k.watch(home, "home", realAuthSha(real));
    k.start(10);
    rotateInCell(home, "t1");
    await new Promise((r) => setTimeout(r, 60));
    k.stop();
    expect(readFileSync(join(real, "auth.json"), "utf8")).toBe("t1");
  });

  it("session homes: a sibling rotated from the SAME old token is not written over the first (stashed at release)", () => {
    const k = keeper();
    const sessions = join(root, "codex-home");
    k.watch(sessions, "homes", realAuthSha(real));
    prepareIsolatedCodexHome(join(sessions, "s1"), real);
    prepareIsolatedCodexHome(join(sessions, "s2"), real);
    k.syncAll(); // both seen as symlinks following t0
    rotateInCell(join(sessions, "s1"), "a");
    rotateInCell(join(sessions, "s2"), "b");
    k.syncAll();
    expect(readFileSync(join(real, "auth.json"), "utf8")).toBe("a");
    expect(k.release(sessions)).toEqual({ s1: "skipped_not_newer", s2: "skipped_real_changed" });
    expect(readdirSync(k.stash)).toHaveLength(1);
  });

  it("recover(): a watch left in the ledger by a hard-killed run is finished on the next start", () => {
    const home = join(root, "cell", "codex-home");
    prepareIsolatedCodexHome(home, real);
    const dead = keeper();
    dead.watch(home, "home", realAuthSha(real));
    rotateInCell(home, "t1");
    // The process dies here (SIGKILL): no sync, no release. A new process:
    const next = keeper();
    const r = next.recover();
    expect(r.released).toEqual([home]);
    expect(readFileSync(join(real, "auth.json"), "utf8")).toBe("t1");
    expect(existsSync(join(home, "auth.json"))).toBe(false);
    // Ledger is empty now: a second recovery does nothing.
    expect(keeper().recover().released).toEqual([]);
  });

  it("recover(): a stashed token is written back once the real file is at its base again, else kept", () => {
    const home = join(root, "h");
    const sha0 = realAuthSha(real);
    prepareIsolatedCodexHome(home, real);
    // Watched while still a symlink (FIX-D2-1c: a copy that predates the
    // watch would be foreign), then rotated while prod rotated too.
    const k = keeper();
    k.watch(home, "home", sha0);
    rotateInCell(home, "t1");
    writeFileSync(join(real, "auth.json"), "prod");
    expect(k.release(home)).toEqual({ "auth.json": "skipped_real_changed" });
    expect(k.recover().stash).toEqual({ propagated: [], dropped_in_sync: [], kept: [expect.any(String)] });
    expect(readFileSync(join(real, "auth.json"), "utf8")).toBe("prod");
    writeFileSync(join(real, "auth.json"), '{"token":"t0"}');
    expect(retryStashedCodexAuth(k.stash, real).propagated).toHaveLength(1);
    expect(readFileSync(join(real, "auth.json"), "utf8")).toBe("t1");
    expect(readdirSync(k.stash)).toEqual([]);
  });
});

describe("authSafeSignalHandler (FIX-D2-1b item 1)", () => {
  it("writes the rotated token back BEFORE the instance stop and exit, then finishes the watch", async () => {
    const k = new CodexAuthKeeper({ realCodexDir: real, stateDir: join(root, "state") });
    const home = join(root, "h");
    prepareIsolatedCodexHome(home, real);
    k.watch(home, "home", realAuthSha(real));
    rotateInCell(home, "t1");
    const events: string[] = [];
    let exited: (c: number) => void = () => {};
    const exitedP = new Promise<number>((r) => (exited = r));
    const handler = authSafeSignalHandler(
      k,
      async () => {
        events.push(`stop real=${readFileSync(join(real, "auth.json"), "utf8")}`);
      },
      (code) => (events.push(`exit ${code} cell=${existsSync(join(home, "auth.json"))}`), exited(code)),
    );
    handler();
    // Synchronous part already wrote it back — before any await.
    expect(readFileSync(join(real, "auth.json"), "utf8")).toBe("t1");
    expect(await exitedP).toBe(130);
    expect(events).toEqual(["stop real=t1", "exit 130 cell=false"]);
  });

  it("a second signal while the stop hangs still writes back and exits", () => {
    const k = { syncAll: vi.fn(), releaseAll: vi.fn(), stop: vi.fn() };
    const exit = vi.fn();
    const handler = authSafeSignalHandler(k, () => new Promise(() => {}), exit);
    handler();
    expect(exit).not.toHaveBeenCalled();
    handler();
    expect(k.syncAll).toHaveBeenCalledTimes(2);
    expect(k.releaseAll).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(130);
  });
});

describe("withCodexAuthWatch (FIX-D2-1b item 4)", () => {
  const ctx = { artifactDir: "/a" } as AgentContext;

  it("an exception in the Aura runner still writes a rotated session token back", async () => {
    const k = new CodexAuthKeeper({ realCodexDir: real, stateDir: join(root, "state") });
    const sessions = join(root, "codex-home");
    const runner: AgentRunner = async () => {
      prepareIsolatedCodexHome(join(sessions, "s1"), real);
      rotateInCell(join(sessions, "s1"), "t1");
      throw new Error("ws closed");
    };
    await expect(withCodexAuthWatch(runner, k, sessions, () => realAuthSha(real))(ctx)).rejects.toThrow("ws closed");
    expect(readFileSync(join(real, "auth.json"), "utf8")).toBe("t1");
    expect(existsSync(join(sessions, "s1", "auth.json"))).toBe(false);
  });

  it("records the outcome in isolation.codex_auth", async () => {
    const k = new CodexAuthKeeper({ realCodexDir: real, stateDir: join(root, "state") });
    const sessions = join(root, "codex-home");
    const runner: AgentRunner = async () => {
      prepareIsolatedCodexHome(join(sessions, "s1"), real);
      return { kind: "done", status: "completed", metrics: emptyMetrics(), isolation: {}, confounds: [] };
    };
    const r = await withCodexAuthWatch(runner, k, sessions, () => realAuthSha(real))(ctx);
    expect(r).toMatchObject({ isolation: { codex_auth: { s1: "unchanged" } } });
  });
});

/**
 * FIX-D2-1c — review of #254 ("NOT SAFE TO PILOT"). Every test below is a
 * way the keeper could overwrite prod's live `~/.codex/auth.json` with a token
 * it cannot vouch for; each asserts the real file stays byte-identical.
 */
describe("CodexAuthKeeper — copies of unknown origin (FIX-D2-1c item 1, STOP)", () => {
  const keeper = () => new CodexAuthKeeper({ realCodexDir: real, stateDir: join(root, "state") });
  const realText = () => readFileSync(join(real, "auth.json"), "utf8");

  it("a stale regular auth.json already in a session home when the watch starts is never written back (sync, release)", () => {
    // Reproduces the review: bench/aura-home/.companion/codex-home/test-session-id/auth.json
    // was a regular file left from an earlier run. The old keeper took the
    // current real sha as its base and wrote it over prod on the first tick.
    const sessions = join(root, "codex-home");
    mkdirSync(join(sessions, "test-session-id"), { recursive: true });
    writeFileSync(join(sessions, "test-session-id", "auth.json"), '{"token":"stale"}');
    const k = keeper();
    k.watch(sessions, "homes", realAuthSha(real));
    k.syncAll();
    k.syncAll();
    expect(realText()).toBe('{"token":"t0"}');
    expect(k.release(sessions)).toEqual({ "test-session-id": "skipped_foreign" });
    expect(realText()).toBe('{"token":"t0"}');
    // Moved to the stash (credential not left in the tree), flagged foreign.
    expect(existsSync(join(sessions, "test-session-id", "auth.json"))).toBe(false);
    const [stashed] = readdirSync(k.stash);
    expect(JSON.parse(readFileSync(join(k.stash, stashed!), "utf8"))).toMatchObject({ foreign: true, base: null });
  });

  it("a foreign stash is never auto-restored, even when the real file later matches nothing / anything", () => {
    const sessions = join(root, "codex-home");
    mkdirSync(join(sessions, "old"), { recursive: true });
    writeFileSync(join(sessions, "old", "auth.json"), '{"token":"stale"}');
    const k = keeper();
    k.watch(sessions, "homes", realAuthSha(real));
    k.release(sessions);
    expect(retryStashedCodexAuth(k.stash, real)).toEqual({ propagated: [], dropped_in_sync: [], kept: [expect.any(String)] });
    expect(realText()).toBe('{"token":"t0"}');
  });

  it("a stale copy equal to the real file is just removed (in sync, nothing to stash)", () => {
    const sessions = join(root, "codex-home");
    mkdirSync(join(sessions, "old"), { recursive: true });
    writeFileSync(join(sessions, "old", "auth.json"), '{"token":"t0"}');
    const k = keeper();
    k.watch(sessions, "homes", realAuthSha(real));
    expect(k.release(sessions)).toEqual({ old: "skipped_not_newer" });
    expect(existsSync(k.stash) ? readdirSync(k.stash) : []).toEqual([]);
  });

  it("the stale copy does not block a legitimate rotation from a session created during the cell", () => {
    const sessions = join(root, "codex-home");
    mkdirSync(join(sessions, "old"), { recursive: true });
    writeFileSync(join(sessions, "old", "auth.json"), '{"token":"stale"}');
    const k = keeper();
    k.watch(sessions, "homes", realAuthSha(real));
    prepareIsolatedCodexHome(join(sessions, "new"), real);
    k.syncAll();
    rotateInCell(join(sessions, "new"), "t1");
    k.syncAll();
    expect(realText()).toBe("t1");
  });

  it("recover(): a watch from a hard-killed run never writes back a copy that predated it", () => {
    const sessions = join(root, "codex-home");
    mkdirSync(join(sessions, "old"), { recursive: true });
    writeFileSync(join(sessions, "old", "auth.json"), '{"token":"stale"}');
    keeper().watch(sessions, "homes", realAuthSha(real)); // then SIGKILL
    const r = keeper().recover();
    expect(r.released).toEqual([sessions]);
    expect(realText()).toBe('{"token":"t0"}');
    expect(r.stash.kept).toHaveLength(1);
  });

  it("recover(): a pre-FIX-D2-1c ledger (no version) is fail-closed — its bases are not trusted", () => {
    // The old keeper persisted `bases[home] = startSha` for a stale regular
    // copy it saw on the first tick. Recovering that entry verbatim would
    // write the stale copy over the (still unchanged) real file.
    const home = join(root, "cell", "codex-home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "auth.json"), '{"token":"stale"}');
    const sha0 = realAuthSha(real);
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(join(root, "state", "ledger.json"), JSON.stringify({ [home]: { kind: "home", startSha: sha0, bases: { [home]: sha0 } } }));
    const r = keeper().recover();
    expect(r.released).toEqual([home]);
    expect(realText()).toBe('{"token":"t0"}');
    expect(r.stash.kept).toHaveLength(1);
  });

  it("re-watching an active path keeps the pinned start (a second watch cannot adopt a copy)", () => {
    const home = join(root, "h");
    prepareIsolatedCodexHome(home, real);
    const k = keeper();
    k.watch(home, "home", realAuthSha(real));
    rotateInCell(home, "t1");
    writeFileSync(join(real, "auth.json"), "prod");
    k.watch(home, "home", realAuthSha(real)); // would pin to "prod" if reset
    k.syncAll();
    expect(realText()).toBe("prod");
  });
});

describe("CodexAuthKeeper — pinned base (FIX-D2-1c item 2)", () => {
  const keeper = () => new CodexAuthKeeper({ realCodexDir: real, stateDir: join(root, "state") });

  it("a prod re-login during the cell freezes the base: the cell's old-family token is stashed, not written over it", () => {
    const home = join(root, "h");
    prepareIsolatedCodexHome(home, real);
    const k = keeper();
    k.watch(home, "home", realAuthSha(real));
    k.syncAll(); // symlink, real at t0
    writeFileSync(join(real, "auth.json"), "fresh-login"); // someone re-logs in prod
    k.syncAll(); // symlink still — the old keeper moved base to "fresh-login" here
    rotateInCell(home, "old-family"); // Codex in the cell rotates from its in-memory t0 token
    k.syncAll();
    expect(readFileSync(join(real, "auth.json"), "utf8")).toBe("fresh-login");
    expect(k.release(home)).toEqual({ "auth.json": "skipped_real_changed" });
    expect(readFileSync(join(real, "auth.json"), "utf8")).toBe("fresh-login");
    expect(readdirSync(k.stash)).toHaveLength(1);
  });

  it("the base still follows a sha the keeper itself wrote (a sibling's write-back is not 'external')", () => {
    const sessions = join(root, "codex-home");
    const k = keeper();
    k.watch(sessions, "homes", realAuthSha(real));
    prepareIsolatedCodexHome(join(sessions, "s1"), real);
    prepareIsolatedCodexHome(join(sessions, "s2"), real);
    k.syncAll();
    rotateInCell(join(sessions, "s1"), "a");
    k.syncAll(); // keeper writes "a"
    k.syncAll(); // s2 (symlink) now reads "a" and may follow it
    rotateInCell(join(sessions, "s2"), "b"); // derived from "a"
    k.syncAll();
    expect(readFileSync(join(real, "auth.json"), "utf8")).toBe("b");
  });

  it("syncRotatedCodexAuth without a trusted set keeps the base pinned on a symlink", () => {
    const home = join(root, "h");
    prepareIsolatedCodexHome(home, real);
    const sha0 = realAuthSha(real);
    writeFileSync(join(real, "auth.json"), "fresh-login");
    expect(syncRotatedCodexAuth(home, real, sha0)).toEqual({ outcome: "unchanged", base: sha0 });
  });
});

describe("logged-out real file (FIX-D2-1c item 3)", () => {
  const keeper = () => new CodexAuthKeeper({ realCodexDir: real, stateDir: join(root, "state") });

  it("a stash with base=null is not restored after `codex logout` removed the real file", () => {
    const home = join(root, "h");
    prepareIsolatedCodexHome(home, real);
    const k = keeper();
    k.watch(home, "home", null);
    rotateInCell(home, "t1");
    rmSync(join(real, "auth.json"));
    expect(k.release(home)).toEqual({ "auth.json": "skipped_real_missing" });
    expect(retryStashedCodexAuth(k.stash, real).kept).toHaveLength(1);
    expect(existsSync(join(real, "auth.json"))).toBe(false);
  });

  it("a cell rotation is not written into an absent or empty real file", () => {
    for (const logout of [() => rmSync(join(real, "auth.json")), () => writeFileSync(join(real, "auth.json"), "")]) {
      writeFileSync(join(real, "auth.json"), '{"token":"t0"}');
      const home = join(root, `h-${Math.random()}`);
      prepareIsolatedCodexHome(home, real);
      const k = keeper();
      k.watch(home, "home", realAuthSha(real));
      rotateInCell(home, "t1");
      logout();
      k.syncAll();
      expect(existsSync(join(real, "auth.json")) ? readFileSync(join(real, "auth.json"), "utf8") : null).not.toBe("t1");
      expect(k.release(home)).toEqual({ "auth.json": "skipped_real_missing" });
    }
  });

  it("an empty real file counts as logged out for realAuthSha", () => {
    writeFileSync(join(real, "auth.json"), "");
    expect(realAuthSha(real)).toBeNull();
  });
});

describe("authSafeSignalHandler — agent processes first (FIX-D2-1c item 3)", () => {
  it("stops the agent processes BEFORE releasing the homes, and syncs again after they exit", async () => {
    const events: string[] = [];
    const k = {
      syncAll: vi.fn(() => events.push("sync")),
      releaseAll: vi.fn(() => events.push("release")),
      stop: vi.fn(),
    };
    let exited: () => void = () => {};
    const done = new Promise<void>((r) => (exited = r));
    const handler = authSafeSignalHandler(
      k,
      async () => void events.push("instance stopped"),
      () => (events.push("exit"), exited()),
      {
        stop: async () => {
          await new Promise((r) => setTimeout(r, 5));
          events.push("children stopped");
        },
        killNow: () => events.push("kill"),
      },
    );
    handler();
    await done;
    // Exact order: sync now, agents + instance stopped, sync again, release, exit.
    expect(events).toEqual(["sync", "instance stopped", "children stopped", "sync", "release", "exit"]);
  });

  it("a second signal SIGKILLs the agents before releasing; a late first-path completion does not release twice", async () => {
    const events: string[] = [];
    const k = { syncAll: vi.fn(), releaseAll: vi.fn(() => events.push("release")), stop: vi.fn() };
    let finishChildren: () => void = () => {};
    const exit = vi.fn();
    const handler = authSafeSignalHandler(k, async () => {}, exit, {
      stop: () => new Promise<void>((r) => (finishChildren = r)),
      killNow: () => events.push("kill"),
    });
    handler();
    handler();
    expect(events).toEqual(["kill", "release"]);
    finishChildren();
    await new Promise((r) => setTimeout(r, 5));
    expect(k.releaseAll).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});

describe("CodexAuthKeeper — ledger write failure in the poll (FIX-D2-1c item 3)", () => {
  it("syncAll logs instead of throwing when the ledger cannot be written, and the write-back still happened", () => {
    const logs: string[] = [];
    const stateDir = join(root, "state");
    const k = new CodexAuthKeeper({ realCodexDir: real, stateDir, log: (l) => logs.push(l) });
    const home = join(root, "h");
    prepareIsolatedCodexHome(home, real);
    k.watch(home, "home", realAuthSha(real));
    // Make the ledger path unwritable: a directory where the tmp file goes.
    mkdirSync(join(stateDir, "ledger.json.tmp"), { recursive: true });
    rotateInCell(home, "t1");
    expect(() => k.syncAll()).not.toThrow();
    expect(readFileSync(join(real, "auth.json"), "utf8")).toBe("t1");
    expect(logs.some((l) => l.includes("ledger write failed"))).toBe(true);
  });
});
