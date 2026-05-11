import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
  // Both alive — happy restart path, no spawn.
  it("returns resume_pair when both halves are alive", () => {
    expect(decideReconciliation(state(true, true))).toEqual({
      type: "resume_pair",
      sessionGroupId: "grp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
  });

  // Observer died, primary alive — common case. Relaunch observer with
  // same groupId so the checkpoint stream continues without forking.
  it("returns relaunch_observer when only the primary is alive", () => {
    expect(decideReconciliation(state(true, false))).toEqual({
      type: "relaunch_observer",
      sessionGroupId: "grp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      primarySessionId: "sess-1",
    });
  });

  // Primary died, observer alive — refuse auto-promotion. An
  // orchestrator-less observer cannot drive the next phase; surface
  // to the user. This is the case FS-Durability flagged as "must not
  // be ambiguous".
  it("returns mark_orphan when only the observer is alive", () => {
    expect(decideReconciliation(state(false, true))).toEqual({
      type: "mark_orphan",
      sessionGroupId: "grp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      reason: "observer_only_alive",
    });
  });

  // Both dead — refuse auto-relaunch. Auto-respawning both would fork
  // the checkpoint timeline behind the user's back.
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

  // FS-Durability: tombstone is the "mark" half of mark-then-sweep.
  // Must be atomic so a crash between mark and sweep leaves consistent
  // state, never a half-written tombstone.
  it("writes a valid tombstone payload at .council/ARCHIVED", () => {
    writeArchiveTombstone(dir, "grp_abc", "2026-05-11T10:00:00.000Z");
    const raw = readFileSync(join(dir, ".council", "ARCHIVED"), "utf-8");
    expect(JSON.parse(raw)).toEqual({
      session_group_id: "grp_abc",
      archived_at: "2026-05-11T10:00:00.000Z",
    });
  });

  // Creates the .council/ subtree on demand — caller doesn't have to
  // pre-create it for the first archive of an otherwise-clean workspace.
  it("creates the .council/ directory if missing", () => {
    expect(() => writeArchiveTombstone(dir, "grp_xyz")).not.toThrow();
  });

  // Re-archive must overwrite atomically — the second mark replaces
  // the first cleanly.
  it("overwrites an existing tombstone atomically", () => {
    writeArchiveTombstone(dir, "grp_v1", "2026-01-01T00:00:00.000Z");
    writeArchiveTombstone(dir, "grp_v2", "2026-02-02T00:00:00.000Z");
    const raw = readFileSync(join(dir, ".council", "ARCHIVED"), "utf-8");
    expect(JSON.parse(raw)).toEqual({
      session_group_id: "grp_v2",
      archived_at: "2026-02-02T00:00:00.000Z",
    });
  });
});
