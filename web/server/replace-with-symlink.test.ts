import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { replaceWithSymlink } from "./cli-launcher.js";

/**
 * ritchie B7 (council review 2026-11-15): resetting a session's Codex
 * auth.json to the shared sign-in was unlink-then-symlink; a crash between the
 * two left the session with no auth.json. Now a symlink is made under a temp
 * name and renamed over the file in one step. Synthetic files only.
 */
describe("replaceWithSymlink", () => {
  it("replaces a regular file with a symlink in one step and leaves no temp entry", () => {
    const dir = mkdtempSync(join(tmpdir(), "relink-"));
    try {
      const primary = join(dir, "primary.json");
      const dest = join(dir, "auth.json");
      writeFileSync(primary, '{"synthetic":true}');
      writeFileSync(dest, '{"old":true}');
      replaceWithSymlink(primary, dest);
      expect(lstatSync(dest).isSymbolicLink()).toBe(true);
      expect(readlinkSync(dest)).toBe(primary);
      expect(readdirSync(dir).sort()).toEqual(["auth.json", "primary.json"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("on a failed rename the original file stays and the temp link is removed", () => {
    const dir = mkdtempSync(join(tmpdir(), "relink-"));
    try {
      const destDir = join(dir, "is-a-dir");
      // rename(2) of a symlink over a non-empty directory fails.
      writeFileSync(join(dir, "primary.json"), "{}");
      mkdirSync(destDir);
      writeFileSync(join(destDir, "x"), "keep");
      expect(() => replaceWithSymlink(join(dir, "primary.json"), destDir)).toThrow();
      expect(existsSync(join(destDir, "x"))).toBe(true);
      expect(readdirSync(dir).filter((n) => n.endsWith(".link"))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
