// Tests for the shared `buildBrowserGroupRecord` helper that all three
// `group_created` producers (live push, REST bootstrap, ws-bridge synthetic
// hydration) go through. PR #68 introduced this helper to close the PICKUP
// §"shared mapper" invariant — drift between the producers is now
// mechanically impossible because there is only one assembly site.

import { describe, expect, it } from "vitest";
import { buildBrowserGroupRecord } from "./browser-group-record.js";
import { OBSERVER_WAKE_TIMEOUT_MS } from "./council-types.js";

describe("buildBrowserGroupRecord", () => {
  // Happy path — claude+claude pair, active status. This is the shape the
  // live push emits today; locking it in as a baseline guards the helper's
  // wire contract.
  it("maps a claude+claude pair to the canonical wire shape", () => {
    const out = buildBrowserGroupRecord({
      sessionGroupId: "grp_x",
      primary: { sessionId: "sess_o", backendType: "claude" },
      observer: { sessionId: "sess_v", backendType: "claude" },
      status: "active",
    });
    expect(out).toEqual({
      sessionGroupId: "grp_x",
      primarySessionId: "sess_o",
      observerSessionId: "sess_v",
      pairing: "claude+claude",
      status: "active",
      wakeTimeoutMs: OBSERVER_WAKE_TIMEOUT_MS,
    });
  });

  // Asymmetric pairing — claude+codex is the experimental cross-family
  // variant. The pairing label MUST carry both backends in `primary+observer`
  // order (not alphabetical, not arbitrary) because the frontend's
  // `ProviderBadges` component asymmetrically renders the two.
  it("assembles the pairing label as primary+observer, not alphabetical", () => {
    const out = buildBrowserGroupRecord({
      sessionGroupId: "grp_y",
      primary: { sessionId: "p", backendType: "claude" },
      observer: { sessionId: "o", backendType: "codex" },
      status: "active",
    });
    expect(out.pairing).toBe("claude+codex");
  });

  // Status passthrough — REST bootstrap passes the coordinator's current
  // status (which may be `degraded` or `reconnecting`), while the live push
  // and ws-bridge synthetic hydration both pass `"active"`. The helper must
  // not silently override the caller's status (any such bug would mask
  // dead-half pairs across browser reload — the very gap PR #68 closes).
  it("forwards the caller-supplied status verbatim (does not silently coerce to active)", () => {
    const out = buildBrowserGroupRecord({
      sessionGroupId: "grp_z",
      primary: { sessionId: "p", backendType: "claude" },
      observer: { sessionId: "o", backendType: "claude" },
      status: "degraded",
    });
    expect(out.status).toBe("degraded");
  });

  // #9: deadRole passthrough — when a degraded pair is snapshotted by REST
  // bootstrap, the dead half MUST ride the wire. Without it the frontend
  // deriver falls back to `deadRole ?? "observer"` and a pair whose
  // ORCHESTRATOR died is mislabeled "Observer offline".
  it("forwards deadRole when supplied (degraded-on-arrival snapshot)", () => {
    const out = buildBrowserGroupRecord({
      sessionGroupId: "grp_dead",
      primary: { sessionId: "p", backendType: "claude" },
      observer: { sessionId: "o", backendType: "claude" },
      status: "degraded",
      deadRole: "orchestrator",
    });
    expect(out.deadRole).toBe("orchestrator");
  });

  // #9: deadRole is omitted (not `undefined`) for the common active case so
  // the wire stays minimal and `event_replay` of pre-#9 frames doesn't carry
  // a spurious key.
  it("omits deadRole entirely when not supplied", () => {
    const out = buildBrowserGroupRecord({
      sessionGroupId: "grp_nodead",
      primary: { sessionId: "p", backendType: "claude" },
      observer: { sessionId: "o", backendType: "claude" },
      status: "active",
    });
    expect("deadRole" in out).toBe(false);
  });

  // wakeTimeoutMs sourced from the server constant — frontend deriver
  // bounds the `reviewing` interval by this value. Any drift between
  // producer sites would yield different `reviewing-stalled` thresholds
  // depending on whether the group arrived via REST bootstrap or the
  // live push.
  it("populates wakeTimeoutMs from the server-owned constant", () => {
    const out = buildBrowserGroupRecord({
      sessionGroupId: "grp_w",
      primary: { sessionId: "p", backendType: "claude" },
      observer: { sessionId: "o", backendType: "claude" },
      status: "active",
    });
    expect(out.wakeTimeoutMs).toBe(OBSERVER_WAKE_TIMEOUT_MS);
  });

  // Field-parity canary: the helper is deterministic. The same input
  // produces an output structurally equal to any other call with the same
  // input. This is the "drift impossible" invariant the helper exists to
  // enforce — encoded as a test so a future refactor that re-introduces
  // call-site-specific construction (e.g. inlining one of the producers)
  // would be caught by a diverging field if a fixture-dependent comparison
  // is built on top.
  it("is deterministic — identical input yields structurally equal output across calls", () => {
    const parts = {
      sessionGroupId: "grp_det",
      primary: { sessionId: "p1", backendType: "claude" as const },
      observer: { sessionId: "o1", backendType: "codex" as const },
      status: "active" as const,
    };
    const first = buildBrowserGroupRecord(parts);
    const second = buildBrowserGroupRecord(parts);
    expect(first).toEqual(second);
    expect(Object.keys(first).sort()).toEqual([
      "observerSessionId",
      "pairing",
      "primarySessionId",
      "sessionGroupId",
      "status",
      "wakeTimeoutMs",
    ]);
  });

  // PR #68 Fowler fix-pass — the helper internalises the
  // launcher-propagation-lag fallback for `backendType: undefined`.
  // Two of three call sites (live push + ws-bridge synthetic hydration)
  // source backendType from launcher / bridge Session maps where it can
  // be transiently undefined right after spawn. The helper applies
  // `DEFAULT_BACKEND_TYPE = "claude"` so the wire never carries an
  // ill-formed `"undefined+undefined"` pairing label.
  it("applies the internal default when primary backendType is undefined", () => {
    const out = buildBrowserGroupRecord({
      sessionGroupId: "grp_fb_p",
      primary: { sessionId: "p", backendType: undefined },
      observer: { sessionId: "o", backendType: "codex" },
      status: "active",
    });
    expect(out.pairing).toBe("claude+codex");
  });

  it("applies the internal default when observer backendType is undefined", () => {
    const out = buildBrowserGroupRecord({
      sessionGroupId: "grp_fb_o",
      primary: { sessionId: "p", backendType: "claude" },
      observer: { sessionId: "o", backendType: undefined },
      status: "active",
    });
    expect(out.pairing).toBe("claude+claude");
  });

  it("applies the internal default when both backendType values are undefined", () => {
    // The early-bootstrap edge case — neither launcher nor bridge has
    // wired backend metadata yet. Output MUST be a well-formed pairing
    // string, never `"undefined+undefined"`.
    const out = buildBrowserGroupRecord({
      sessionGroupId: "grp_fb_both",
      primary: { sessionId: "p", backendType: undefined },
      observer: { sessionId: "o", backendType: undefined },
      status: "active",
    });
    expect(out.pairing).toBe("claude+claude");
    expect(out.pairing).not.toContain("undefined");
  });
});
