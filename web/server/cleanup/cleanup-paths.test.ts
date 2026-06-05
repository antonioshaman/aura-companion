import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ARCHIVED_SESSIONS_SUBDIR,
  ARCHIVED_RECORDINGS_SUBDIR,
  EVICTING_SENTINEL_SUFFIX,
  REAPING_SENTINEL_SUBDIR,
  SWEEP_IN_PROGRESS_SUFFIX,
  RECORDINGS_HOLD_SENTINEL,
  resolveCleanupPath,
} from "./cleanup-paths.js";

// Each test pins one path-resolution contract. Several use a real tmpdir
// because the resolver inspects the filesystem via `realpathSync`; pure
// in-memory mocks would bypass the symlink-resolution path that EC-7
// exists to defend.

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "cleanup-paths-test-"));
});

afterEach(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch { /* best-effort */ }
});

describe("exported path constants — EC-20 single source of truth", () => {
  // Producer↔consumer contract: every cleanup tier MUST import these
  // constants, never hardcode the string. The static-grep canary below
  // backs the rule; this test just pins the values so a future rename
  // is a deliberate (visible) edit.
  it("uses the documented filesystem-shape strings", () => {
    expect(ARCHIVED_SESSIONS_SUBDIR).toBe("archived");
    expect(ARCHIVED_RECORDINGS_SUBDIR).toBe("archived-recordings");
    expect(EVICTING_SENTINEL_SUFFIX).toBe(".evicting");
    expect(REAPING_SENTINEL_SUBDIR).toBe(".reaping");
    expect(SWEEP_IN_PROGRESS_SUFFIX).toBe(".sweep-in-progress");
    expect(RECORDINGS_HOLD_SENTINEL).toBe(".hold");
  });
});

describe("resolveCleanupPath — happy path", () => {
  // The common case: caller passes a real session root + simple relPath
  // for a yet-to-be-written sentinel. Resolver must return the joined
  // absolute path with symlinks collapsed.
  it("returns root/relPath for a simple relative path under an existing root", () => {
    const got = resolveCleanupPath(tmpRoot, `${ARCHIVED_SESSIONS_SUBDIR}/sess123${EVICTING_SENTINEL_SUFFIX}`);
    // resolveCleanupPath realpaths the deepest existing ancestor, so compare
    // against the realpath'd root (macOS /var → /private/var portability).
    expect(got).toBe(join(realpathSync(tmpRoot), ARCHIVED_SESSIONS_SUBDIR, `sess123${EVICTING_SENTINEL_SUFFIX}`));
  });

  // Nested relPath under a multi-level sub-directory: must compose
  // correctly without re-checking each intermediate.
  it("resolves a 2-segment relPath even when sub-dirs don't yet exist", () => {
    const got = resolveCleanupPath(tmpRoot, `${REAPING_SENTINEL_SUBDIR}/12345.json`);
    expect(got).toBe(join(realpathSync(tmpRoot), REAPING_SENTINEL_SUBDIR, "12345.json"));
  });
});

describe("resolveCleanupPath — EC-7 traversal defences", () => {
  // The two structural attacks the resolver MUST reject: parent traversal
  // and absolute-path injection. Both are fail-CLOSED (throw).
  it("throws on `..` traversal segments", () => {
    expect(() => resolveCleanupPath(tmpRoot, "../etc/passwd")).toThrow(/parent traversal/);
  });

  it("throws on absolute relPath", () => {
    expect(() => resolveCleanupPath(tmpRoot, "/etc/passwd")).toThrow(/must be relative/);
  });

  it("throws on NUL byte in relPath", () => {
    expect(() => resolveCleanupPath(tmpRoot, "foo\0bar")).toThrow(/NUL/);
  });

  it("throws on empty relPath", () => {
    expect(() => resolveCleanupPath(tmpRoot, "")).toThrow(/empty/);
  });

  it("throws on non-absolute root", () => {
    expect(() => resolveCleanupPath("relative/root", "foo")).toThrow(/invalid root/);
  });

  it("throws on NUL byte in root", () => {
    expect(() => resolveCleanupPath(`${tmpRoot}\0poison`, "foo")).toThrow(/invalid root/);
  });

  // EC-7 cross-symlink defence: if an EXISTING sub-directory inside the
  // root is a symlink to outside the root, the realpath check must catch
  // it. This is the live attack the convention is designed to prevent.
  it("throws when an existing symlinked sub-dir escapes the root via realpath", () => {
    const outsideTarget = mkdtempSync(join(tmpdir(), "cleanup-outside-"));
    try {
      symlinkSync(outsideTarget, join(tmpRoot, "escape"));
      expect(() => resolveCleanupPath(tmpRoot, "escape/foo")).toThrow(/escapes root/);
    } finally {
      try { rmSync(outsideTarget, { recursive: true, force: true }); } catch { /* */ }
    }
  });
});

describe("resolveCleanupPath — symlink resolution within bounds", () => {
  // A symlink that stays inside the root is NOT an attack: the resolver
  // must collapse it without throwing. Pinning this prevents the
  // resolver from accidentally over-rejecting (which would break
  // operator-installed convenience symlinks).
  it("accepts a symlinked sub-dir whose target stays inside the root", () => {
    mkdirSync(join(tmpRoot, "real-archive"));
    symlinkSync(join(tmpRoot, "real-archive"), join(tmpRoot, ARCHIVED_SESSIONS_SUBDIR));
    const got = resolveCleanupPath(tmpRoot, `${ARCHIVED_SESSIONS_SUBDIR}/sess1${EVICTING_SENTINEL_SUFFIX}`);
    // The symlink resolves to real-archive, which is still inside tmpRoot.
    expect(got.startsWith(realpathSync(tmpRoot) + sep)).toBe(true);
  });
});

describe("static-grep canary — EC-20 enforcement", () => {
  // Per the PLAN brief: assert no LITERAL `"archived"` or
  // `"archived-recordings"` string appears anywhere else in the
  // cleanup/ directory. If a Phase E/H/etc author re-hardcodes the
  // subdir name, this canary fires and they're forced to import the
  // constant — closing the EC-20 producer↔consumer drift surface.
  //
  // The pattern intentionally matches BOTH single- and double-quoted
  // literal forms so a future cosmetic edit (`'archived'` ↔ `"archived"`)
  // doesn't weaken the canary. EC-19 — regex, not literal substring.
  it("no literal \"archived\" string in other cleanup/*.ts files", () => {
    const cleanupDir = dirname(fileURLToPath(import.meta.url));
    const files = readdirSync(cleanupDir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith(".ts"))
      .filter((d) => d.name !== "cleanup-paths.ts" && d.name !== "cleanup-paths.test.ts")
      .map((d) => d.name);

    const violations: { file: string; sample: string }[] = [];
    const ARCHIVED_LITERAL = /["']archived(?:-recordings)?["']/;
    for (const filename of files) {
      const content = readFileSync(join(cleanupDir, filename), "utf8");
      const match = ARCHIVED_LITERAL.exec(content);
      if (match) {
        violations.push({ file: filename, sample: match[0] });
      }
    }
    expect(violations).toEqual([]);
  });
});
