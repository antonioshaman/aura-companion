import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { COUNCIL_SCHEMA_VERSION } from "./council-types.js";
import {
  type RestartState,
  decideReconciliation,
  writeArchiveTombstone,
} from "./group-reconciliation.js";

function state(primaryAlive: boolean, observerAlive: boolean): RestartState {
  return {
    sessionGroupId: "grp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    primary: { sessionId: "sess-1", aliveByPid: primaryAlive },
    observer: { sessionId: "sess-2", aliveByPid: observerAlive },
  };
}

describe("decideReconciliation", () => {
  it("returns resume_pair when both halves are alive", () => {
    expect(decideReconciliation(state(true, true))).toEqual({
      type: "resume_pair",
      sessionGroupId: "grp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
  });

  it("returns relaunch_observer when only the primary is alive", () => {
    expect(decideReconciliation(state(true, false))).toEqual({
      type: "relaunch_observer",
      sessionGroupId: "grp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      primarySessionId: "sess-1",
    });
  });

  it("returns mark_orphan when only the observer is alive", () => {
    expect(decideReconciliation(state(false, true))).toEqual({
      type: "mark_orphan",
      sessionGroupId: "grp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      reason: "observer_only_alive",
    });
  });

  it("returns archive_dead when neither half is alive", () => {
    expect(decideReconciliation(state(false, false))).toEqual({
      type: "archive_dead",
      sessionGroupId: "grp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      reason: "neither_alive",
    });
  });
});

describe("writeArchiveTombstone", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tombstone-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // Persistence F1+F2: per-group path + schema_version. A second archive
  // for a different group must not overwrite the first.
  it("writes a versioned tombstone payload to per-group path", () => {
    writeArchiveTombstone(dir, "grp_aaa", "2026-05-11T10:00:00.000Z");
    const raw = readFileSync(join(dir, ".council", "archived", "grp_aaa.json"), "utf-8");
    expect(JSON.parse(raw)).toEqual({
      schema_version: COUNCIL_SCHEMA_VERSION,
      session_group_id: "grp_aaa",
      archived_at: "2026-05-11T10:00:00.000Z",
    });
  });

  it("two archives for different groups coexist (no overwrite)", () => {
    writeArchiveTombstone(dir, "grp_aaa", "2026-05-11T10:00:00.000Z");
    writeArchiveTombstone(dir, "grp_bbb", "2026-05-11T11:00:00.000Z");
    const files = readdirSync(join(dir, ".council", "archived")).sort();
    expect(files).toEqual(["grp_aaa.json", "grp_bbb.json"]);
  });

  // Re-archive of the same group overwrites atomically (last writer wins).
  it("re-archive of the same group overwrites atomically", () => {
    writeArchiveTombstone(dir, "grp_aaa", "2026-01-01T00:00:00.000Z");
    writeArchiveTombstone(dir, "grp_aaa", "2026-02-02T00:00:00.000Z");
    const raw = readFileSync(join(dir, ".council", "archived", "grp_aaa.json"), "utf-8");
    expect(JSON.parse(raw).archived_at).toBe("2026-02-02T00:00:00.000Z");
  });
});
