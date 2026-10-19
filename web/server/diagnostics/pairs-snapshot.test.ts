// Tests for the Pairs card snapshot (AC1).
//
// What is validated:
//   - a live pair whose observer received its last inbound frame 20 minutes
//     ago is listed with that frame time and the last checkpoint time, so the
//     card can render "silent 20m" next to the number it came from;
//   - group status / dead role / degraded reason pass through verbatim from
//     the coordinator record (AP-2 — no re-derivation);
//   - a half with no frame yet (0) or an untracked backend reports null, not
//     an age computed from epoch;
//   - the wake time is looked up in the orchestrator's workspace.

import { describe, expect, it, vi } from "vitest";
import { buildPairsSnapshot, type PairsSnapshotDeps } from "./pairs-snapshot.js";

const NOW = Date.parse("2026-10-19T12:00:00Z");

function deps(overrides: Partial<PairsSnapshotDeps> = {}): PairsSnapshotDeps {
  return {
    groups: () => [
      {
        sessionGroupId: "grp_1",
        primarySessionId: "orch-1",
        observerSessionId: "obs-1",
        pairing: "claude+codex",
        status: "active",
      },
    ],
    session: (id) =>
      id === "orch-1"
        ? { backendType: "claude", state: "connected", pid: 11, cwd: "/root/proj" }
        : { backendType: "codex", state: "connected", pid: 22, exitCode: null },
    lastFrameAt: (id) => (id === "orch-1" ? NOW - 5_000 : NOW - 20 * 60_000),
    lastCheckpointAt: () => NOW - 25 * 60_000,
    lastWakeAt: () => NOW - 24 * 60_000,
    ...overrides,
  };
}

describe("buildPairsSnapshot", () => {
  it("lists a pair whose observer has been silent 20 minutes with the evidence for it", () => {
    const [pair] = buildPairsSnapshot(deps());
    expect(pair).toMatchObject({
      sessionGroupId: "grp_1",
      status: "active",
      pairing: "claude+codex",
      lastCheckpointAt: NOW - 25 * 60_000,
      lastWakeAt: NOW - 24 * 60_000,
    });
    const observer = pair.halves.find((h) => h.role === "observer")!;
    expect(observer).toEqual({
      sessionId: "obs-1",
      role: "observer",
      backendType: "codex",
      state: "connected",
      pid: 22,
      exitCode: null,
      lastInboundFrameAt: NOW - 20 * 60_000,
    });
  });

  it("passes degraded status and its reason through verbatim", () => {
    const [pair] = buildPairsSnapshot(
      deps({
        groups: () => [
          {
            sessionGroupId: "grp_2",
            primarySessionId: "orch-1",
            observerSessionId: "obs-1",
            pairing: "claude+claude",
            status: "degraded",
            deadRole: "observer",
            degradedReason: "observer_exited",
          },
        ],
      }),
    );
    expect(pair).toMatchObject({ status: "degraded", deadRole: "observer", degradedReason: "observer_exited" });
  });

  it("reports null — not an age from epoch — when no frame was recorded", () => {
    const [pair] = buildPairsSnapshot(deps({ lastFrameAt: (id) => (id === "orch-1" ? 0 : undefined) }));
    expect(pair.halves.map((h) => h.lastInboundFrameAt)).toEqual([null, null]);
  });

  it("looks up the wake sentinel in the orchestrator's workspace, and skips it without one", () => {
    const lastWakeAt = vi.fn(() => 1);
    buildPairsSnapshot(deps({ lastWakeAt }));
    expect(lastWakeAt).toHaveBeenCalledWith("grp_1", "/root/proj");
    const [pair] = buildPairsSnapshot(deps({ session: () => undefined, lastWakeAt }));
    expect(pair.lastWakeAt).toBeNull();
    expect(pair.halves[0]).toMatchObject({ backendType: "unknown", state: null, pid: null });
  });
});
