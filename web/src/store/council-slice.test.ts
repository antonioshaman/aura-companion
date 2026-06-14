// @vitest-environment jsdom

// Polyfill localStorage + matchMedia before store.ts initializes (matches the
// pattern used by ui-slice.test.ts — store.ts imports trigger localStorage
// reads at module-load time via getInitialSessionId etc.).
vi.hoisted(() => {
  Object.defineProperty(globalThis.window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
  if (typeof globalThis.localStorage === "undefined" || typeof globalThis.localStorage.getItem !== "function") {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, String(v)); },
        removeItem: (k: string) => { store.delete(k); },
        clear: () => { store.clear(); },
        get length() { return store.size; },
        key: (i: number) => [...store.keys()][i] ?? null,
      },
      writable: true,
      configurable: true,
    });
  }
});

import { useStore } from "../store.js";
import {
  COUNCIL_PANEL_OPEN_KEY,
  COUNCIL_PANEL_WIDTH_KEY,
  COUNCIL_FIRST_RUN_DISMISSED_KEY,
  DEFAULT_OBSERVER_PANEL_WIDTH_PX,
  MAX_OBSERVER_PANEL_WIDTH_PX,
  MIN_OBSERVER_PANEL_WIDTH_PX,
  clampWidth,
  hydrateObserverFinding,
} from "./council-slice.js";
import type { BrowserObserverFinding, GroupRecord } from "../types.js";

beforeEach(() => {
  useStore.getState().reset();
  localStorage.clear();
});

function group(overrides: Partial<GroupRecord> = {}): GroupRecord {
  return {
    sessionGroupId: "grp_abc",
    primarySessionId: "sess_orch",
    observerSessionId: "sess_obs",
    status: "active",
    pairing: "claude+claude",
    ...overrides,
  };
}

function wireFinding(overrides: Partial<BrowserObserverFinding> = {}): BrowserObserverFinding {
  return {
    id: "fnd_1",
    severity: "STOP",
    claim: "test claim",
    evidence_path: "src/foo.ts",
    ...overrides,
  };
}

// ── clampWidth (Beck F4: each branch independently) ─────────────────────────

describe("clampWidth", () => {
  it("returns the value unchanged when in range", () => {
    expect(clampWidth(400)).toBe(400);
  });

  it("floors values above MAX to MAX", () => {
    expect(clampWidth(MAX_OBSERVER_PANEL_WIDTH_PX + 100)).toBe(MAX_OBSERVER_PANEL_WIDTH_PX);
  });

  it("raises values below MIN to MIN", () => {
    expect(clampWidth(50)).toBe(MIN_OBSERVER_PANEL_WIDTH_PX);
  });

  it("floors fractional values to integer", () => {
    expect(clampWidth(400.7)).toBe(400);
  });

  it("returns DEFAULT for non-finite input", () => {
    expect(clampWidth(Number.NaN)).toBe(DEFAULT_OBSERVER_PANEL_WIDTH_PX);
    expect(clampWidth(Number.POSITIVE_INFINITY)).toBe(DEFAULT_OBSERVER_PANEL_WIDTH_PX);
  });
});

// ── hydrateObserverFinding ──────────────────────────────────────────────────

describe("hydrateObserverFinding", () => {
  // Happy path — required fields + context fields land in the output.
  it("hydrates wire shape with context-supplied bookkeeping fields", () => {
    const wire = wireFinding({ id: "fnd_x", evidence_lines: [10, 20], confidence: "high" });
    const out = hydrateObserverFinding(wire, {
      receivedAt: 5_000,
      checkpointId: "chk_2",
      phase: "council-plan",
      observerModel: "claude-opus-4-7",
      observerProvider: "claude",
    });
    expect(out).toEqual({
      id: "fnd_x",
      severity: "STOP",
      claim: "test claim",
      evidence_path: "src/foo.ts",
      evidence_lines: [10, 20],
      confidence: "high",
      receivedAt: 5_000,
      checkpointId: "chk_2",
      phase: "council-plan",
      observerModel: "claude-opus-4-7",
      observerProvider: "claude",
    });
  });

  // Optional wire fields drop out when absent — no `undefined` litter on the
  // hydrated record.
  it("omits optional wire fields when absent on input", () => {
    const out = hydrateObserverFinding(wireFinding(), {
      receivedAt: 1_000,
      checkpointId: "chk",
      phase: "p",
      observerModel: "m",
      observerProvider: "claude",
    });
    expect(out).not.toHaveProperty("evidence_lines");
    expect(out).not.toHaveProperty("confidence");
    expect(out).not.toHaveProperty("wasDowngraded");
    expect(out).not.toHaveProperty("downgradeReason");
  });

  // Beck F4 — the downgrade-path branch. Hydrated finding preserves the
  // server-side downgrade signal so the UI can annotate it.
  it("preserves server-side downgrade signals", () => {
    const wire = wireFinding({ wasDowngraded: true, downgradeReason: "evidence_missing_on_disk" });
    const out = hydrateObserverFinding(wire, {
      receivedAt: 1_000,
      checkpointId: "chk",
      phase: "p",
      observerModel: "m",
      observerProvider: "codex",
    });
    expect(out.wasDowngraded).toBe(true);
    expect(out.downgradeReason).toBe("evidence_missing_on_disk");
  });
});

// ── group lifecycle ─────────────────────────────────────────────────────────

describe("upsertGroup / removeGroup", () => {
  it("stores the group and builds reverse index by both session ids", () => {
    useStore.getState().upsertGroup(group());
    const s = useStore.getState();
    expect(s.groups.get("grp_abc")?.pairing).toBe("claude+claude");
    expect(s.groupBySessionId.get("sess_orch")).toBe("grp_abc");
    expect(s.groupBySessionId.get("sess_obs")).toBe("grp_abc");
  });

  it("initializes empty findings + downgrades buckets on first upsert", () => {
    useStore.getState().upsertGroup(group());
    expect(useStore.getState().findings.get("grp_abc")).toEqual([]);
    expect(useStore.getState().groundingDowngrades.get("grp_abc")).toEqual([]);
  });

  it("removeGroup deletes both reverse-index entries", () => {
    useStore.getState().upsertGroup(group());
    useStore.getState().removeGroup("grp_abc");
    const s = useStore.getState();
    expect(s.groups.has("grp_abc")).toBe(false);
    expect(s.groupBySessionId.has("sess_orch")).toBe(false);
    expect(s.groupBySessionId.has("sess_obs")).toBe(false);
    expect(s.findings.has("grp_abc")).toBe(false);
  });

  it("setGroupStatus to degraded records deadRole; transitioning away clears it", () => {
    useStore.getState().upsertGroup(group());
    useStore.getState().setGroupStatus("grp_abc", "degraded", { deadRole: "observer" });
    expect(useStore.getState().groups.get("grp_abc")?.deadRole).toBe("observer");
    useStore.getState().setGroupStatus("grp_abc", "active");
    expect(useStore.getState().groups.get("grp_abc")?.deadRole).toBeUndefined();
  });

  it("setGroupStatus stores degradedReason and clears it when the group recovers", () => {
    useStore.getState().upsertGroup(group());
    useStore.getState().setGroupStatus("grp_abc", "degraded", {
      deadRole: "observer",
      reason: "wake_send_failed",
    });
    expect(useStore.getState().groups.get("grp_abc")?.degradedReason).toBe("wake_send_failed");
    useStore.getState().setGroupStatus("grp_abc", "active");
    expect(useStore.getState().groups.get("grp_abc")?.degradedReason).toBeUndefined();
  });

  it("setGroupStatus is a no-op for an unknown group id", () => {
    useStore.getState().setGroupStatus("grp_missing", "degraded", { deadRole: "observer" });
    expect(useStore.getState().groups.has("grp_missing")).toBe(false);
  });
});

// ── hydrateGroups (PR #68 REST bootstrap) ────────────────────────────────────
//
// `hydrateGroups` is the dispatch site for the REST `/api/groups` bootstrap
// (`api.fetchGroups()` → this action). It MUST be idempotent against
// concurrent / subsequent live `group:created` WS events for the same
// sessionGroupId — otherwise the live state's mutable runtime fields
// (lastCheckpointAt, observerReviewing, etc.) would be clobbered each
// time the REST snapshot lands.
describe("hydrateGroups", () => {
  it("inserts groups not already in the store, with full reverse-index population", () => {
    useStore.getState().hydrateGroups([
      group({ sessionGroupId: "grp_a", primarySessionId: "orch_a", observerSessionId: "obs_a" }),
      group({ sessionGroupId: "grp_b", primarySessionId: "orch_b", observerSessionId: "obs_b", pairing: "claude+codex" }),
    ]);
    const s = useStore.getState();
    expect(s.groups.get("grp_a")?.pairing).toBe("claude+claude");
    expect(s.groups.get("grp_b")?.pairing).toBe("claude+codex");
    expect(s.groupBySessionId.get("orch_a")).toBe("grp_a");
    expect(s.groupBySessionId.get("obs_a")).toBe("grp_a");
    expect(s.groupBySessionId.get("orch_b")).toBe("grp_b");
    expect(s.groupBySessionId.get("obs_b")).toBe("grp_b");
  });

  it("initializes empty findings + downgrades buckets per hydrated group", () => {
    useStore.getState().hydrateGroups([
      group({ sessionGroupId: "grp_h1", primarySessionId: "p", observerSessionId: "o" }),
    ]);
    expect(useStore.getState().findings.get("grp_h1")).toEqual([]);
    expect(useStore.getState().groundingDowngrades.get("grp_h1")).toEqual([]);
  });

  // Load-bearing idempotency contract — the REST bootstrap fires once on
  // mount, possibly AFTER the live `group:created` push already populated
  // the store with runtime state. If hydrate overwrote, lastCheckpointAt /
  // observerReviewing / recentlySupersededCheckpointIds / convergenceState
  // would visibly regress on every mount-effect re-run.
  it("does NOT overwrite groups already in the store — live WS wins", () => {
    // Live event populated the store first.
    useStore.getState().upsertGroup(group({
      sessionGroupId: "grp_live",
      primarySessionId: "orch_live",
      observerSessionId: "obs_live",
    }));
    // Simulate a runtime field that REST does not carry — set via
    // recordCheckpoint (the WS dispatch path).
    useStore.getState().recordCheckpoint({
      sessionGroupId: "grp_live",
      checkpointId: "chk_x",
      phase: "council-plan",
      sequence: 5,
      timestamp: 1_700_000_000_000,
    });
    expect(useStore.getState().groups.get("grp_live")?.lastCheckpointAt).toBe(1_700_000_000_000);
    expect(useStore.getState().groups.get("grp_live")?.observerReviewing).toBe(true);

    // REST snapshot arrives — without lastCheckpointAt / observerReviewing
    // fields. Hydrate MUST not erase the runtime state.
    useStore.getState().hydrateGroups([
      group({
        sessionGroupId: "grp_live",
        primarySessionId: "orch_live",
        observerSessionId: "obs_live",
      }),
    ]);
    const after = useStore.getState().groups.get("grp_live");
    expect(after?.lastCheckpointAt).toBe(1_700_000_000_000);
    expect(after?.observerReviewing).toBe(true);
    expect(after?.lastCheckpointSeq).toBe(5);
  });

  it("preserves findings already accumulated for a group present at hydrate time", () => {
    useStore.getState().upsertGroup(group({ sessionGroupId: "grp_live_f" }));
    useStore.getState().appendObserverReview({
      sessionGroupId: "grp_live_f",
      checkpointId: "chk_1",
      phase: "p",
      findings: [wireFinding({ id: "f_keep" })],
      downgrades: [],
      observerModel: "m",
      observerProvider: "claude",
      timestamp: 1_000,
    });
    useStore.getState().hydrateGroups([group({ sessionGroupId: "grp_live_f" })]);
    expect(useStore.getState().findings.get("grp_live_f")?.[0]?.id).toBe("f_keep");
  });

  it("empty input is a true no-op (no spurious re-render — same map references)", () => {
    useStore.getState().upsertGroup(group({ sessionGroupId: "grp_ref" }));
    const before = useStore.getState();
    useStore.getState().hydrateGroups([]);
    const after = useStore.getState();
    expect(after.groups).toBe(before.groups);
    expect(after.groupBySessionId).toBe(before.groupBySessionId);
    expect(after.findings).toBe(before.findings);
    expect(after.groundingDowngrades).toBe(before.groundingDowngrades);
  });

  it("input where every group is already present is a true no-op (same map references)", () => {
    useStore.getState().upsertGroup(group({ sessionGroupId: "grp_dup" }));
    const before = useStore.getState();
    useStore.getState().hydrateGroups([group({ sessionGroupId: "grp_dup" })]);
    const after = useStore.getState();
    expect(after.groups).toBe(before.groups);
    expect(after.groupBySessionId).toBe(before.groupBySessionId);
  });

  it("mixed input — partial insert + partial skip — mutates only the new entries", () => {
    useStore.getState().upsertGroup(group({ sessionGroupId: "grp_existing", primarySessionId: "p_ex", observerSessionId: "o_ex" }));
    useStore.getState().hydrateGroups([
      group({ sessionGroupId: "grp_existing", primarySessionId: "p_ex", observerSessionId: "o_ex" }),
      group({ sessionGroupId: "grp_new", primarySessionId: "p_new", observerSessionId: "o_new" }),
    ]);
    const s = useStore.getState();
    expect(s.groups.has("grp_existing")).toBe(true);
    expect(s.groups.has("grp_new")).toBe(true);
    expect(s.groupBySessionId.get("p_new")).toBe("grp_new");
    expect(s.groupBySessionId.get("p_ex")).toBe("grp_existing");
  });

  // PICKUP §2.3 hydrate→WS sequence contract. The realistic mount flow:
  //   1. App.tsx fires `fetchGroups()` → `hydrateGroups([...])` (REST).
  //   2. A live `group_created` push arrives shortly after for the same
  //      pair (server emits it on bus when a tab that was in a closed-WS
  //      state reconnects, or when the group reconnects via the recovery
  //      path).
  // The WS dispatch path in `ws.ts` calls `upsertGroup`, which always
  // overwrites by Map semantics. The contract under test: the second
  // arrival MUST NOT produce a double-insert (groups.size stays 1), MUST
  // NOT swap the role mapping in `groupBySessionId`, and MUST NOT split
  // the pair across two records. The REST and WS wire shapes are
  // produced by the same `buildBrowserGroupRecord` helper (PR #68 C1.1),
  // so they agree on the primary/observer assignment; this test pins
  // that contract at the store layer so a future regression that
  // accidentally diverged the two assembly paths would surface here.
  it("hydrate then live group_created for the same sessionGroupId — no double-insert, no role swap, reverse-index intact", () => {
    const groupId = "grp_seq";
    const primaryId = "orch_seq";
    const observerId = "obs_seq";

    // 1. REST bootstrap lands first.
    useStore.getState().hydrateGroups([
      group({
        sessionGroupId: groupId,
        primarySessionId: primaryId,
        observerSessionId: observerId,
        pairing: "claude+codex",
      }),
    ]);
    {
      const s = useStore.getState();
      expect(s.groups.size).toBe(1);
      expect(s.groupBySessionId.get(primaryId)).toBe(groupId);
      expect(s.groupBySessionId.get(observerId)).toBe(groupId);
    }

    // 2. Subsequent live `group_created` arrives for the same pair —
    //    `ws.ts` dispatches `upsertGroup`. Both REST and WS go through
    //    `buildBrowserGroupRecord` server-side so the role assignment is
    //    structurally identical.
    useStore.getState().upsertGroup(
      group({
        sessionGroupId: groupId,
        primarySessionId: primaryId,
        observerSessionId: observerId,
        pairing: "claude+codex",
      }),
    );

    // 3. Invariants AFTER the WS arrival:
    //    - groups.size remains 1 (no double-insert from sequencing)
    //    - primary/observer role mapping unchanged (no role swap)
    //    - groupBySessionId has exactly 2 entries (one per half), both
    //      resolving to the same sessionGroupId
    const s = useStore.getState();
    expect(s.groups.size).toBe(1);
    const stored = s.groups.get(groupId);
    expect(stored?.primarySessionId).toBe(primaryId);
    expect(stored?.observerSessionId).toBe(observerId);
    expect(s.groupBySessionId.size).toBe(2);
    expect(s.groupBySessionId.get(primaryId)).toBe(groupId);
    expect(s.groupBySessionId.get(observerId)).toBe(groupId);
  });
});

// ── recordCheckpoint ────────────────────────────────────────────────────────

describe("recordCheckpoint", () => {
  it("updates lastCheckpoint fields and flips observerReviewing on", () => {
    useStore.getState().upsertGroup(group());
    useStore.getState().recordCheckpoint({
      sessionGroupId: "grp_abc",
      checkpointId: "chk_1",
      phase: "council-plan",
      sequence: 1,
      timestamp: 1_000,
    });
    const g = useStore.getState().groups.get("grp_abc");
    expect(g?.lastCheckpointAt).toBe(1_000);
    expect(g?.lastCheckpointSeq).toBe(1);
    expect(g?.lastPhase).toBe("council-plan");
    expect(g?.observerReviewing).toBe(true);
  });

  // Server is the seq authority — out-of-order events must NOT regress
  // client state (Realtime EC-5: per-sequence monotonicity).
  it("ignores out-of-order checkpoint events (sequence <= last)", () => {
    useStore.getState().upsertGroup(group());
    useStore.getState().recordCheckpoint({
      sessionGroupId: "grp_abc",
      checkpointId: "chk_2",
      phase: "council-implement",
      sequence: 2,
      timestamp: 2_000,
    });
    // Stale event for an older seq number — must be ignored.
    useStore.getState().recordCheckpoint({
      sessionGroupId: "grp_abc",
      checkpointId: "chk_1",
      phase: "council-plan",
      sequence: 1,
      timestamp: 1_000,
    });
    const g = useStore.getState().groups.get("grp_abc");
    expect(g?.lastCheckpointSeq).toBe(2);
    expect(g?.lastPhase).toBe("council-implement");
  });

  it("is a no-op for an unknown group id", () => {
    useStore.getState().recordCheckpoint({
      sessionGroupId: "grp_missing",
      checkpointId: "chk_1",
      phase: "council-plan",
      sequence: 1,
      timestamp: 1_000,
    });
    expect(useStore.getState().groups.has("grp_missing")).toBe(false);
  });
});

// ── appendObserverReview ────────────────────────────────────────────────────

describe("appendObserverReview", () => {
  it("appends hydrated findings and flips observerReviewing off", () => {
    useStore.getState().upsertGroup(group());
    useStore.getState().recordCheckpoint({
      sessionGroupId: "grp_abc",
      checkpointId: "chk_1",
      phase: "council-plan",
      sequence: 1,
      timestamp: 1_000,
    });
    useStore.getState().appendObserverReview({
      sessionGroupId: "grp_abc",
      checkpointId: "chk_1",
      phase: "council-plan",
      findings: [wireFinding({ id: "f1" }), wireFinding({ id: "f2", severity: "NOTE" })],
      downgrades: [{ id: "f3", reason: "evidence_missing_on_disk" }],
      observerModel: "gpt-5-codex",
      observerProvider: "codex",
      timestamp: 1_500,
    });
    const s = useStore.getState();
    expect(s.groups.get("grp_abc")?.observerReviewing).toBe(false);
    const findings = s.findings.get("grp_abc")!;
    expect(findings).toHaveLength(2);
    expect(findings[0]?.id).toBe("f1");
    expect(findings[0]?.observerProvider).toBe("codex");
    expect(findings[0]?.receivedAt).toBe(1_500);
    expect(s.groundingDowngrades.get("grp_abc")).toEqual([{ id: "f3", reason: "evidence_missing_on_disk" }]);
  });

  // Server may re-emit reviews on reconnect; client must dedup by id so
  // findings aren't duplicated in the panel after a transient drop.
  it("dedups findings by id on re-emission", () => {
    useStore.getState().upsertGroup(group());
    const sameWire = wireFinding({ id: "f1" });
    const reviewArgs = {
      sessionGroupId: "grp_abc",
      checkpointId: "chk_1",
      phase: "council-plan",
      findings: [sameWire],
      downgrades: [],
      observerModel: "claude-opus-4-7",
      observerProvider: "claude",
      timestamp: 1_000,
    };
    useStore.getState().appendObserverReview(reviewArgs);
    useStore.getState().appendObserverReview(reviewArgs);
    expect(useStore.getState().findings.get("grp_abc")).toHaveLength(1);
  });

  it("is a no-op for an unknown group id", () => {
    useStore.getState().appendObserverReview({
      sessionGroupId: "grp_missing",
      checkpointId: "chk_1",
      phase: "council-plan",
      findings: [wireFinding()],
      downgrades: [],
      observerModel: "claude",
      observerProvider: "claude",
      timestamp: 1_000,
    });
    expect(useStore.getState().findings.has("grp_missing")).toBe(false);
  });

  // Attribution upgrade: bootstrap → live ordering.
  //
  // Scenario: ws.ts dispatches appendObserverReview from a REST bootstrap
  // (GET /api/groups) when the response lacks attribution fields (e.g. older
  // server or race before observer handshake). A subsequent live
  // `observer_review` WS event arrives carrying the SAME finding id but with
  // correct non-empty observerProvider/observerModel. Without the upgrade
  // logic the dedup by id would permanently keep the empty attribution from
  // the bootstrap. The fix: a later record with non-empty attribution UPGRADES
  // an existing finding whose attribution is empty.
  it("bootstrap-then-live: upgrades empty attribution to non-empty on same finding id", () => {
    useStore.getState().upsertGroup(group());

    // Step 1: Bootstrap arrives with empty attribution.
    useStore.getState().appendObserverReview({
      sessionGroupId: "grp_abc",
      checkpointId: "chk_1",
      phase: "council-plan",
      findings: [wireFinding({ id: "fnd_upgrade" })],
      downgrades: [],
      observerModel: "",
      observerProvider: "",
      timestamp: 1_000,
    });

    // Sanity check: finding stored with empty attribution from bootstrap.
    const afterBootstrap = useStore.getState().findings.get("grp_abc")!;
    expect(afterBootstrap).toHaveLength(1);
    expect(afterBootstrap[0]?.observerProvider).toBe("");
    expect(afterBootstrap[0]?.observerModel).toBe("");

    // Step 2: Live observer_review event arrives for the same finding id
    // but carries real attribution.
    useStore.getState().appendObserverReview({
      sessionGroupId: "grp_abc",
      checkpointId: "chk_1",
      phase: "council-plan",
      findings: [wireFinding({ id: "fnd_upgrade" })],
      downgrades: [],
      observerModel: "codex-1",
      observerProvider: "codex",
      timestamp: 2_000,
    });

    // After the upgrade: still exactly one finding (no duplicate), and the
    // attribution fields now reflect the live event's non-empty values.
    const afterLive = useStore.getState().findings.get("grp_abc")!;
    expect(afterLive).toHaveLength(1);
    expect(afterLive[0]?.id).toBe("fnd_upgrade");
    expect(afterLive[0]?.observerProvider).toBe("codex");
    expect(afterLive[0]?.observerModel).toBe("codex-1");
  });

  // Attribution downgrade guard: non-empty attribution must never be
  // overwritten by a later empty-attribution arrival.
  //
  // Scenario: the live observer_review event arrives first (with real
  // attribution), then a second bootstrap or stale REST re-hydration arrives
  // with observerProvider="" / observerModel="" for the same finding id.
  // The empty arrival must be treated as a no-op for attribution fields;
  // the previously stored non-empty values must survive unchanged.
  it("non-empty attribution is never downgraded by a subsequent empty-attribution arrival", () => {
    useStore.getState().upsertGroup(group());

    // Step 1: Live event with correct attribution.
    useStore.getState().appendObserverReview({
      sessionGroupId: "grp_abc",
      checkpointId: "chk_1",
      phase: "council-plan",
      findings: [wireFinding({ id: "fnd_nodowngrade" })],
      downgrades: [],
      observerModel: "claude-opus-4",
      observerProvider: "claude",
      timestamp: 1_000,
    });

    // Step 2: Stale bootstrap re-emit with empty attribution.
    useStore.getState().appendObserverReview({
      sessionGroupId: "grp_abc",
      checkpointId: "chk_1",
      phase: "council-plan",
      findings: [wireFinding({ id: "fnd_nodowngrade" })],
      downgrades: [],
      observerModel: "",
      observerProvider: "",
      timestamp: 2_000,
    });

    // The stored finding must still carry the original non-empty attribution.
    const stored = useStore.getState().findings.get("grp_abc")!;
    expect(stored).toHaveLength(1);
    expect(stored[0]?.observerProvider).toBe("claude");
    expect(stored[0]?.observerModel).toBe("claude-opus-4");
  });

  // Regression guard: findings with genuinely new ids are still appended
  // normally after the dedup/upgrade logic was introduced. This ensures
  // the upgrade path did not accidentally break the append-new path.
  it("genuinely new finding ids are still appended (regression guard for upgrade logic)", () => {
    useStore.getState().upsertGroup(group());

    useStore.getState().appendObserverReview({
      sessionGroupId: "grp_abc",
      checkpointId: "chk_1",
      phase: "council-plan",
      findings: [wireFinding({ id: "fnd_a" })],
      downgrades: [],
      observerModel: "codex-1",
      observerProvider: "codex",
      timestamp: 1_000,
    });

    // Second call introduces an entirely different finding id — must append.
    useStore.getState().appendObserverReview({
      sessionGroupId: "grp_abc",
      checkpointId: "chk_2",
      phase: "council-implement",
      findings: [wireFinding({ id: "fnd_b", severity: "NOTE" })],
      downgrades: [],
      observerModel: "codex-1",
      observerProvider: "codex",
      timestamp: 2_000,
    });

    const stored = useStore.getState().findings.get("grp_abc")!;
    expect(stored).toHaveLength(2);
    expect(stored[0]?.id).toBe("fnd_a");
    expect(stored[1]?.id).toBe("fnd_b");
    // Attribution on the new finding must also be correct.
    expect(stored[1]?.observerProvider).toBe("codex");
  });
});

// ── panel preferences (persistence) ─────────────────────────────────────────

describe("observer panel preferences", () => {
  it("setObserverPanelOpen persists to localStorage", () => {
    useStore.getState().setObserverPanelOpen("sess_orch", false);
    const raw = localStorage.getItem(COUNCIL_PANEL_OPEN_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual([["sess_orch", false]]);
  });

  it("toggleObserverPanel flips the value (defaults to open=true on first call)", () => {
    // Use a per-test-unique session id so this test does not pick up state
    // set by sibling tests in this file. observerPanelOpen is a persistent
    // user-preference Map and intentionally survives `reset()` (parallels
    // collapsedProjects), so cross-test contamination is real if shared ids
    // are reused.
    const sid = "sess_orch_toggle_test";
    useStore.getState().toggleObserverPanel(sid);
    // First toggle on a fresh key starts from the default (open=true) → false.
    expect(useStore.getState().observerPanelOpen.get(sid)).toBe(false);
    useStore.getState().toggleObserverPanel(sid);
    expect(useStore.getState().observerPanelOpen.get(sid)).toBe(true);
  });

  it("setObserverPanelWidth clamps and persists", () => {
    useStore.getState().setObserverPanelWidth("sess_orch", 10_000);
    expect(useStore.getState().observerPanelWidth.get("sess_orch")).toBe(MAX_OBSERVER_PANEL_WIDTH_PX);
    expect(JSON.parse(localStorage.getItem(COUNCIL_PANEL_WIDTH_KEY)!)).toEqual([["sess_orch", MAX_OBSERVER_PANEL_WIDTH_PX]]);
  });

  it("dismissFirstRunHint persists a per-user flag", () => {
    expect(useStore.getState().firstRunHintDismissed).toBe(false);
    useStore.getState().dismissFirstRunHint();
    expect(useStore.getState().firstRunHintDismissed).toBe(true);
    expect(localStorage.getItem(COUNCIL_FIRST_RUN_DISMISSED_KEY)).toBe("true");
  });
});

// ── dismissStop ─────────────────────────────────────────────────────────────

describe("dismissStop", () => {
  it("adds finding ids to the dismissed set", () => {
    useStore.getState().dismissStop("f1");
    useStore.getState().dismissStop("f2");
    expect(useStore.getState().dismissedStopIds.has("f1")).toBe(true);
    expect(useStore.getState().dismissedStopIds.has("f2")).toBe(true);
  });

  it("is idempotent — dismissing the same id twice is a no-op", () => {
    useStore.getState().dismissStop("f1");
    const before = useStore.getState().dismissedStopIds;
    useStore.getState().dismissStop("f1");
    expect(useStore.getState().dismissedStopIds).toBe(before);
  });
});

// ── cross-slice cleanup via removeSession ───────────────────────────────────

describe("cross-slice cleanup", () => {
  it("removeSession drops the council group when the orchestrator session is removed", () => {
    // Seed a session and a council group so the cross-slice cleanup path
    // has something to delete.
    useStore.getState().addSession({
      session_id: "sess_orch",
      created_at: 0,
      messages: [],
      worktree: null,
      sdkSession: undefined,
    } as never);
    useStore.getState().upsertGroup(group());
    useStore.getState().setObserverPanelOpen("sess_orch", false);

    useStore.getState().removeSession("sess_orch");

    const s = useStore.getState();
    expect(s.groups.has("grp_abc")).toBe(false);
    expect(s.findings.has("grp_abc")).toBe(false);
    expect(s.observerPanelOpen.has("sess_orch")).toBe(false);
    // Persistence also trimmed so the next mount doesn't resurrect the key.
    const raw = localStorage.getItem(COUNCIL_PANEL_OPEN_KEY);
    if (raw !== null) {
      const entries = JSON.parse(raw) as Array<[string, boolean]>;
      expect(entries.find(([k]) => k === "sess_orch")).toBeUndefined();
    }
  });
});
