import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  writeEvictingMarker,
  deleteEvictingMarker,
  writeReapingMarker,
  deleteReapingMarker,
  writeSweepInProgressMarker,
  deleteSweepInProgressMarker,
  listReapingMarkerPids,
  reconcileStaleReapingMarkers,
} from "./sentinel-markers.js";
import {
  ARCHIVED_SESSIONS_SUBDIR,
  EVICTING_SENTINEL_SUFFIX,
  REAPING_SENTINEL_SUBDIR,
  SWEEP_IN_PROGRESS_SUFFIX,
} from "./cleanup-paths.js";

// Each test exercises the EC-8 contract: marker write produces a real
// JSON file at the resolved cleanup path BEFORE the action; delete on
// the happy path removes it; delete on missing-file is silent (idempotent
// reconcile-after-resume); delete on other errno surfaces a structured
// WARN with marker kind + identifier but NO raw path (EC-23).

let tmpRoot: string;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "sentinel-markers-test-"));
  const loggerModule = await import("../logger.js");
  warnSpy = vi.spyOn(loggerModule.log, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }
});

describe("evicting marker — write + delete + EC-8 sentinel-before-sweep", () => {
  // Happy path: write produces JSON at the resolved path. Path shape
  // is pinned via the exported constants — the constant test in
  // cleanup-paths.test.ts catches a rename; this test catches the
  // assembly.
  it("writes JSON payload to <root>/archived/<sessionId>.evicting", () => {
    const sessionId = "sess_abc123";
    const payload = { sessionId, startedAt: 1_700_000_000_000, targetDir: "ignored-for-path" };
    const target = writeEvictingMarker(tmpRoot, sessionId, payload);

    // Markers route through resolveCleanupPath, which realpaths the root
    // (macOS /var → /private/var portability).
    expect(target).toBe(join(realpathSync(tmpRoot), ARCHIVED_SESSIONS_SUBDIR, `${sessionId}${EVICTING_SENTINEL_SUFFIX}`));
    expect(existsSync(target)).toBe(true);
    const parsed = JSON.parse(readFileSync(target, "utf8"));
    expect(parsed).toEqual(payload);
  });

  // Idempotent delete: the boot-time reconcile path may call delete
  // when the marker was already cleared by a successful prior pass.
  it("delete is silent ENOENT (no WARN)", () => {
    deleteEvictingMarker(tmpRoot, "no-such-session");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("delete removes the marker after write", () => {
    const sessionId = "sess_xyz";
    writeEvictingMarker(tmpRoot, sessionId, { sessionId, startedAt: 1, targetDir: "x" });
    const target = join(tmpRoot, ARCHIVED_SESSIONS_SUBDIR, `${sessionId}${EVICTING_SENTINEL_SUFFIX}`);
    expect(existsSync(target)).toBe(true);
    deleteEvictingMarker(tmpRoot, sessionId);
    expect(existsSync(target)).toBe(false);
  });

  // EC-7 boundary: a write attempt against a sessionId carrying a
  // traversal token MUST throw at the resolver, not the writer — so
  // the atomic write never reaches the filesystem.
  it("rejects traversal in sessionId (EC-7)", () => {
    expect(() => writeEvictingMarker(tmpRoot, "../etc/passwd", { sessionId: "x", startedAt: 0, targetDir: "" }))
      .toThrow(/traversal|escapes/);
  });
});

describe("reaping marker — pid-validated", () => {
  // Filename is the pid — schema-validate so an attacker-controlled
  // string can't slip in through a hypothetical caller that forgot
  // to cast.
  it("writes JSON to <root>/.reaping/<pid>.json", () => {
    const pid = 12345;
    const payload = { pid, decisionTs: 1_700_000_000_000, reason: "not_in_session_map" };
    const target = writeReapingMarker(tmpRoot, pid, payload);

    expect(target).toBe(join(realpathSync(tmpRoot), REAPING_SENTINEL_SUBDIR, `${pid}.json`));
    expect(existsSync(target)).toBe(true);
    const parsed = JSON.parse(readFileSync(target, "utf8"));
    expect(parsed).toEqual(payload);
  });

  it("rejects non-integer pid at the writer boundary", () => {
    expect(() => writeReapingMarker(tmpRoot, 1.5, { pid: 1, decisionTs: 0, reason: "x" }))
      .toThrow(/invalid pid/);
    expect(() => writeReapingMarker(tmpRoot, 0, { pid: 1, decisionTs: 0, reason: "x" }))
      .toThrow(/invalid pid/);
    expect(() => writeReapingMarker(tmpRoot, -1, { pid: 1, decisionTs: 0, reason: "x" }))
      .toThrow(/invalid pid/);
  });

  it("delete removes the marker", () => {
    writeReapingMarker(tmpRoot, 999, { pid: 999, decisionTs: 0, reason: "x" });
    const target = join(tmpRoot, REAPING_SENTINEL_SUBDIR, "999.json");
    expect(existsSync(target)).toBe(true);
    deleteReapingMarker(tmpRoot, 999);
    expect(existsSync(target)).toBe(false);
  });
});

describe("reaping marker reconcile — list + prune-by-liveness (P2 #5)", () => {
  // The parent can die between the sentinel write and the post-exit delete, so
  // `.reaping/<pid>.json` markers accumulate across crashy restarts. The boot
  // reconcile prunes any marker whose pid is no longer live — leaving live pids
  // for the terminal reaper to finish.

  it("lists the pids of all .reaping/<pid>.json markers", () => {
    writeReapingMarker(tmpRoot, 111, { pid: 111, decisionTs: 0, reason: "x" });
    writeReapingMarker(tmpRoot, 222, { pid: 222, decisionTs: 0, reason: "x" });
    expect(listReapingMarkerPids(tmpRoot).sort((a, b) => a - b)).toEqual([111, 222]);
  });

  it("returns [] when the .reaping dir was never created", () => {
    expect(listReapingMarkerPids(tmpRoot)).toEqual([]);
  });

  it("ignores files whose stem is not a positive integer", () => {
    // Only writeReapingMarker should populate the dir, but be defensive: a
    // stray non-numeric file (e.g. a leftover .DS_Store) must not crash the
    // enumeration or be mistaken for a pid.
    writeReapingMarker(tmpRoot, 333, { pid: 333, decisionTs: 0, reason: "x" });
    const dir = join(tmpRoot, REAPING_SENTINEL_SUBDIR);
    writeFileSync(join(dir, "not-a-pid.json"), "{}");
    writeFileSync(join(dir, "0.json"), "{}"); // zero is not a valid pid
    expect(listReapingMarkerPids(tmpRoot)).toEqual([333]);
  });

  it("prunes a marker whose pid is dead and keeps a live one", () => {
    writeReapingMarker(tmpRoot, 111, { pid: 111, decisionTs: 0, reason: "dead" });
    writeReapingMarker(tmpRoot, 222, { pid: 222, decisionTs: 0, reason: "live" });

    const result = reconcileStaleReapingMarkers(tmpRoot, {
      isPidLive: (pid) => pid === 222, // 111 dead, 222 alive
    });

    expect(result).toEqual({ scanned: 2, pruned: 1 });
    expect(existsSync(join(tmpRoot, REAPING_SENTINEL_SUBDIR, "111.json"))).toBe(false);
    // The live pid's marker is left intact — the terminal reaper owns it.
    expect(existsSync(join(tmpRoot, REAPING_SENTINEL_SUBDIR, "222.json"))).toBe(true);
  });

  it("is a no-op (scanned 0, pruned 0) when there are no markers", () => {
    expect(reconcileStaleReapingMarkers(tmpRoot, { isPidLive: () => true }))
      .toEqual({ scanned: 0, pruned: 0 });
  });
});

describe("sweep-in-progress marker — tier-identified", () => {
  // Tier is an opaque short identifier — schema-validate to reject any
  // attempt at smuggling a path separator into the filename.
  it("writes to <root>/<tier>.sweep-in-progress", () => {
    const tier = "recordings-soft";
    const payload = { tier, startedAt: 1_700_000_000_000 };
    const target = writeSweepInProgressMarker(tmpRoot, tier, payload);

    expect(target).toBe(join(realpathSync(tmpRoot), `${tier}${SWEEP_IN_PROGRESS_SUFFIX}`));
    expect(existsSync(target)).toBe(true);
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual(payload);
  });

  it("rejects tier with path separator at the writer boundary", () => {
    expect(() => writeSweepInProgressMarker(tmpRoot, "foo/bar", { tier: "x", startedAt: 0 }))
      .toThrow(/invalid tier/);
    expect(() => writeSweepInProgressMarker(tmpRoot, "foo\\bar", { tier: "x", startedAt: 0 }))
      .toThrow(/invalid tier/);
    expect(() => writeSweepInProgressMarker(tmpRoot, "foo\0bar", { tier: "x", startedAt: 0 }))
      .toThrow(/invalid tier/);
    expect(() => writeSweepInProgressMarker(tmpRoot, "", { tier: "x", startedAt: 0 }))
      .toThrow(/invalid tier/);
  });

  it("delete removes the marker", () => {
    writeSweepInProgressMarker(tmpRoot, "logs", { tier: "logs", startedAt: 0 });
    const target = join(tmpRoot, `logs${SWEEP_IN_PROGRESS_SUFFIX}`);
    expect(existsSync(target)).toBe(true);
    deleteSweepInProgressMarker(tmpRoot, "logs");
    expect(existsSync(target)).toBe(false);
  });
});

describe("delete-failure path — EC-22 + EC-23 redacted forensics", () => {
  // The marker delete is best-effort: ENOENT is the expected case during
  // idempotent reconcile. Any OTHER errno surfaces as a structured WARN
  // naming the marker kind + identifier — but NEVER the raw path bytes.
  // This pins the EC-23 redaction contract at the wrapper boundary.
  it("non-ENOENT delete failure emits cleanup.sentinel.delete_failed WARN without raw path", () => {
    // Make the marker path a directory we can't unlink as a file:
    // write a marker, then replace it with a directory at the same
    // path so `unlinkSync` returns EISDIR (Linux) / EPERM (macOS).
    const sessionId = "blocked";
    writeEvictingMarker(tmpRoot, sessionId, { sessionId, startedAt: 0, targetDir: "" });
    const target = join(tmpRoot, ARCHIVED_SESSIONS_SUBDIR, `${sessionId}${EVICTING_SENTINEL_SUFFIX}`);
    rmSync(target);
    mkdirSync(target);
    // Drop a file inside so rmdir would also fail — but `deleteEvictingMarker`
    // calls `unlinkSync` (file path), which throws EISDIR/EPERM.
    writeFileSync(join(target, "block.txt"), "x");

    deleteEvictingMarker(tmpRoot, sessionId);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const data = warnSpy.mock.calls[0][2] as Record<string, unknown>;
    expect(data.event).toBe("cleanup.sentinel.delete_failed");
    expect(data.marker).toBe("evicting");
    expect(data.sessionId).toBe("blocked");
    // EC-23: payload MUST NOT contain raw absolute path bytes.
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain(tmpRoot);
    expect(serialized).not.toContain(target);
  });
});
