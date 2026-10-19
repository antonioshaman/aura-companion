import { describe, it, expect, vi } from "vitest";
import type { GroupRecord } from "../types.js";
import { pickRespawnTargetSessionId, respawnCouncilHalf } from "./council-respawn.js";

// These helpers back the ObserverPanel's recovery buttons in the real app
// (PR #188 review item #5). Before, App.tsx never passed `onRespawnHalf`, so
// the "Respawn" / "Relaunch observer" buttons were never rendered outside the
// Playground. The helper decides WHICH half to relaunch and calls the
// existing per-session relaunch API for it.

function group(overrides: Partial<GroupRecord> = {}): GroupRecord {
  return {
    sessionGroupId: "grp_1",
    primarySessionId: "sess_orch",
    observerSessionId: "sess_obs",
    status: "degraded",
    pairing: "claude+codex",
    ...overrides,
  };
}

describe("pickRespawnTargetSessionId", () => {
  it("targets the orchestrator when the orchestrator half died", () => {
    expect(pickRespawnTargetSessionId(group({ deadRole: "orchestrator" }))).toBe("sess_orch");
  });

  it("targets the observer when the observer half died", () => {
    expect(pickRespawnTargetSessionId(group({ deadRole: "observer" }))).toBe("sess_obs");
  });

  it("defaults to the observer when no half is marked dead (reviewing-stalled)", () => {
    // Stalled review: both processes may be alive, but the observer never
    // answered — it is the half to relaunch.
    expect(pickRespawnTargetSessionId(group({ status: "active", deadRole: undefined }))).toBe("sess_obs");
  });
});

describe("respawnCouncilHalf", () => {
  it("relaunches the dead half through the provided relaunch call", async () => {
    const relaunch = vi.fn().mockResolvedValue({ ok: true });
    const g = group({ deadRole: "orchestrator" });
    const result = await respawnCouncilHalf("grp_1", (id) => (id === "grp_1" ? g : undefined), relaunch);
    expect(relaunch).toHaveBeenCalledWith("sess_orch");
    expect(result).toBe("sess_orch");
  });

  it("does nothing for an unknown group", async () => {
    const relaunch = vi.fn();
    const result = await respawnCouncilHalf("grp_missing", () => undefined, relaunch);
    expect(relaunch).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it("propagates relaunch failures so the caller can report them", async () => {
    const relaunch = vi.fn().mockRejectedValue(new Error("Relaunch failed"));
    await expect(respawnCouncilHalf("grp_1", () => group(), relaunch)).rejects.toThrow("Relaunch failed");
  });
});
