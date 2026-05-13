/**
 * Council Review 2026-05-13 Beck #13: dedicated test file for the new
 * `council-wake-sentinel.ts` module. Covers read+write+parse helpers
 * including the parse-returns-null-on-corruption case.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  COUNCIL_WAKE_SENTINEL_SCHEMA_VERSION,
  councilWakeSentinelPath,
  parseCouncilWakeSentinel,
  readCouncilWakeSentinel,
  writeCouncilWakeSentinel,
} from "./council-wake-sentinel.js";

describe("council-wake-sentinel", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "wake-sentinel-test-"));
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  describe("councilWakeSentinelPath", () => {
    it("joins workspace + .council/state + group id into a stable path", () => {
      const path = councilWakeSentinelPath(workspace, "grp_abc");
      expect(path).toBe(join(workspace, ".council", "state", "grp_abc-wake.json"));
    });
  });

  describe("writeCouncilWakeSentinel + readCouncilWakeSentinel", () => {
    it("round-trips checkpoint id + sequence through the atomic write", () => {
      writeCouncilWakeSentinel(workspace, "grp_a", {
        checkpointId: "chk_1",
        sequence: 5,
      });
      const restored = readCouncilWakeSentinel(workspace, "grp_a");
      expect(restored).not.toBeNull();
      expect(restored?.schema_version).toBe(COUNCIL_WAKE_SENTINEL_SCHEMA_VERSION);
      expect(restored?.last_woken_checkpoint_id).toBe("chk_1");
      expect(restored?.last_woken_sequence).toBe(5);
      expect(typeof restored?.last_woken_at).toBe("string");
    });

    it("overwrites the sentinel atomically on subsequent writes", () => {
      writeCouncilWakeSentinel(workspace, "grp_a", {
        checkpointId: "chk_1",
        sequence: 1,
      });
      writeCouncilWakeSentinel(workspace, "grp_a", {
        checkpointId: "chk_2",
        sequence: 2,
      });
      const restored = readCouncilWakeSentinel(workspace, "grp_a");
      expect(restored?.last_woken_checkpoint_id).toBe("chk_2");
      expect(restored?.last_woken_sequence).toBe(2);
    });

    it("returns null when no sentinel exists for the group (missing-file branch)", () => {
      const restored = readCouncilWakeSentinel(workspace, "grp_never_woken");
      expect(restored).toBeNull();
    });

    it("isolates groups — group A's write does not affect group B's read", () => {
      writeCouncilWakeSentinel(workspace, "grp_a", { checkpointId: "chk_a", sequence: 1 });
      writeCouncilWakeSentinel(workspace, "grp_b", { checkpointId: "chk_b", sequence: 2 });
      const a = readCouncilWakeSentinel(workspace, "grp_a");
      const b = readCouncilWakeSentinel(workspace, "grp_b");
      expect(a?.last_woken_checkpoint_id).toBe("chk_a");
      expect(b?.last_woken_checkpoint_id).toBe("chk_b");
    });
  });

  describe("parseCouncilWakeSentinel — corruption handling", () => {
    it("returns null on non-JSON input (fail-safe to no-sentinel)", () => {
      expect(parseCouncilWakeSentinel("this is not JSON")).toBeNull();
    });

    it("returns null on schema_version mismatch", () => {
      const raw = JSON.stringify({
        schema_version: 999,
        last_woken_checkpoint_id: "chk",
        last_woken_sequence: 1,
        last_woken_at: "2026-01-01T00:00:00Z",
      });
      expect(parseCouncilWakeSentinel(raw)).toBeNull();
    });

    it("returns null on missing required fields", () => {
      const raw = JSON.stringify({ schema_version: 1 });
      expect(parseCouncilWakeSentinel(raw)).toBeNull();
    });

    it("returns null on negative sequence (validator rejects)", () => {
      const raw = JSON.stringify({
        schema_version: 1,
        last_woken_checkpoint_id: "chk",
        last_woken_sequence: -1,
        last_woken_at: "2026-01-01T00:00:00Z",
      });
      expect(parseCouncilWakeSentinel(raw)).toBeNull();
    });

    it("returns null on malformed ISO timestamp", () => {
      const raw = JSON.stringify({
        schema_version: 1,
        last_woken_checkpoint_id: "chk",
        last_woken_sequence: 1,
        last_woken_at: "not a timestamp",
      });
      expect(parseCouncilWakeSentinel(raw)).toBeNull();
    });

    it("readCouncilWakeSentinel returns null when the file content is corrupt", () => {
      mkdirSync(join(workspace, ".council", "state"), { recursive: true });
      writeFileSync(councilWakeSentinelPath(workspace, "grp_corrupt"), "garbage{not json");
      expect(readCouncilWakeSentinel(workspace, "grp_corrupt")).toBeNull();
    });
  });

  describe("file-on-disk semantics", () => {
    it("the sentinel directory is created lazily on first write (mkdir -p)", () => {
      // The .council/state/ dir does not pre-exist; writeAtomicJson mkdir-recursives.
      writeCouncilWakeSentinel(workspace, "grp_x", { checkpointId: "chk", sequence: 1 });
      const onDisk = readFileSync(councilWakeSentinelPath(workspace, "grp_x"), "utf-8");
      const parsed = JSON.parse(onDisk);
      expect(parsed.last_woken_checkpoint_id).toBe("chk");
    });
  });
});
