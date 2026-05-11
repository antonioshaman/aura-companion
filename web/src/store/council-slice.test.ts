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

  it("setGroupStatus is a no-op for an unknown group id", () => {
    useStore.getState().setGroupStatus("grp_missing", "degraded", { deadRole: "observer" });
    expect(useStore.getState().groups.has("grp_missing")).toBe(false);
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
