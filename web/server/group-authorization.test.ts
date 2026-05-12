import { beforeEach, describe, expect, it } from "vitest";
import {
  authorizeGroupAccess,
  isWellFormedGroupId,
  resolveSessionGroup,
} from "./group-authorization.js";
import { SessionGroupCoordinator, type SessionSpawner } from "./session-group-coordinator.js";

let coord: SessionGroupCoordinator;
let groupId: string;
let primaryId: string;
let observerId: string;

beforeEach(async () => {
  let n = 0;
  const spawner: SessionSpawner = async () => {
    n++;
    return { sessionId: `sess-${n}` };
  };
  coord = new SessionGroupCoordinator({ spawn: spawner, kill: async () => {} });
  const g = await coord.createGroup({ cwd: "/w", primary: "claude", observer: "claude" });
  groupId = g.sessionGroupId;
  primaryId = g.primary.sessionId;
  observerId = g.observer.sessionId;
});

describe("isWellFormedGroupId", () => {
  // Happy path — the coordinator generates exactly this shape.
  it("accepts a coordinator-generated ID", () => {
    expect(isWellFormedGroupId(groupId)).toBe(true);
  });

  // Hunt P7: anything other than the canonical shape MUST be rejected
  // before any map lookup happens. These are typical enum / typo attempts.
  it.each<[string, unknown]>([
    ["empty string", ""],
    ["null", null],
    ["undefined", undefined],
    ["number", 12345],
    ["wrong prefix", "ses_0123456789abcdef0123456789abcdef"],
    ["short hex", "grp_abc"],
    ["uppercase hex", "grp_0123456789ABCDEF0123456789ABCDEF"],
    ["with traversal", "grp_../../etc/passwd000000000000000"],
    ["NUL byte", "grp_00000000000000000000000000000\x00"],
    ["trailing whitespace", "grp_0123456789abcdef0123456789abcdef "],
  ])("rejects malformed ID: %s", (_label, val) => {
    expect(isWellFormedGroupId(val)).toBe(false);
  });
});

describe("authorizeGroupAccess", () => {
  // Happy path — verified token + known group → record.
  it("returns the record for a known well-formed group", () => {
    const rec = authorizeGroupAccess(coord, groupId);
    expect(rec?.sessionGroupId).toBe(groupId);
  });

  // Hunt P7 IDOR mitigation: ID shaped right but unknown to coordinator
  // (e.g. stale ID from a torn-down group, attacker guess) MUST return null.
  it("returns null for an unknown but well-formed group ID", () => {
    expect(authorizeGroupAccess(coord, "grp_ffffffffffffffffffffffffffffffff")).toBeNull();
  });

  // Malformed input never reaches the coordinator's map — early-rejects.
  it("returns null for malformed input without touching the coordinator", () => {
    expect(authorizeGroupAccess(coord, "")).toBeNull();
    expect(authorizeGroupAccess(coord, null)).toBeNull();
    expect(authorizeGroupAccess(coord, { evil: "object" })).toBeNull();
  });
});

describe("resolveSessionGroup", () => {
  // Per-session route (recording start/stop on session id) must be able
  // to resolve to its group for group-level authorisation.
  it("resolves either half of the pair to the group", () => {
    expect(resolveSessionGroup(coord, primaryId)?.sessionGroupId).toBe(groupId);
    expect(resolveSessionGroup(coord, observerId)?.sessionGroupId).toBe(groupId);
  });

  // Single (non-paired) sessions return null — caller falls through to
  // the existing per-session auth path. Must NOT leak "this id exists
  // somewhere but not in a group".
  it("returns null for a session id not in any group", () => {
    expect(resolveSessionGroup(coord, "lonely-session")).toBeNull();
  });

  it("returns null for empty or non-string session id", () => {
    expect(resolveSessionGroup(coord, "")).toBeNull();
  });
});
