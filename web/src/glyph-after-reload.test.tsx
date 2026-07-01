// @vitest-environment jsdom
//
// Integration regression — PR #68 Phase 3β bootstrap-fix.
//
// `BUG-council-mode-group-rest-bootstrap-gap.md`: Council Mode pair
// sessions in the Sidebar did NOT show the ☼/☽ glyph + " · orchestrator"/
// " · observer" suffix after browser reload. Root cause: `group:created`
// was the ONLY source of group records in the browser store; on reload,
// the events were lost and `groupBySessionId` stayed empty, so
// `councilInfoFor()` returned `role: undefined` and `SessionItem` skipped
// the glyph branch.
//
// PR #68 closes the gap by exposing a `GET /api/groups` REST bootstrap,
// dispatched via `useStore.getState().hydrateGroups(...)` on App mount.
// This test exercises the cross-cutting fix end-to-end at the store ↔
// Sidebar boundary:
//
//   - Before bootstrap (the bug state): both halves of a council pair
//     are present as sessions but have no group record. The Sidebar
//     renders WITHOUT the role glyph (the bug).
//   - After `hydrateGroups([...])`: the store has the group; the
//     Sidebar re-renders WITH the ☼ (orchestrator) + ☽ (observer)
//     glyphs.
//
// Unlike the unit tests for `hydrateGroups` (council-slice.test.ts) and
// `getAllGroupsForBootstrap` (session-orchestrator.test.ts), this test
// hits the FULL chain — real Zustand store, real `councilInfoFor` derivation
// in Sidebar.tsx, real SessionItem render — so a regression at any layer
// that nominally type-checks but fails to flow the data through would
// trip here.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import "@testing-library/jest-dom";

// ─── Module mocks (must be declared before imports) ──────────────────────────

// Polyfill matchMedia + localStorage early — the real store reads from
// localStorage at module-load time.
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
});

// Mock the api + ws modules so Sidebar's mount effects don't hit the
// network. We're testing the store→Sidebar reactive chain, not the API.
//
// `vi.mock` factories run BEFORE module imports, so the api spies are
// hoisted via `vi.hoisted` and the factory closes over them. Mutating
// `mockApi.X.mockResolvedValue(...)` later in `beforeEach` re-binds the
// spy's behaviour without touching the module reference.
const mockApi = vi.hoisted(() => ({
  listSessions: vi.fn().mockResolvedValue([]),
  fetchGroups: vi.fn().mockResolvedValue({ groups: [] }),
  deleteSession: vi.fn().mockResolvedValue({}),
  archiveSession: vi.fn().mockResolvedValue({}),
  unarchiveSession: vi.fn().mockResolvedValue({}),
  renameSession: vi.fn().mockResolvedValue({}),
  getArchiveInfo: vi.fn().mockResolvedValue({ hasLinkedIssue: false, issueNotDone: false }),
  // TelemetryNudge in the sidebar footer reads/writes telemetryEnabled on mount.
  getSettings: vi.fn().mockResolvedValue({ telemetryEnabled: true }),
  updateSettings: vi.fn().mockResolvedValue({ telemetryEnabled: true }),
}));

vi.mock("./api.js", () => ({
  api: mockApi,
  fetchGlobalStats: () => Promise.resolve(null),
}));

vi.mock("./ws.js", () => ({
  connectSession: vi.fn(),
  connectAllSessions: vi.fn(),
  disconnectSession: vi.fn(),
}));

vi.mock("./analytics.js", () => ({
  captureEvent: vi.fn(),
  captureException: vi.fn(),
  capturePageView: vi.fn(),
}));

// ─── Imports (after mocks) ───────────────────────────────────────────────────

import { useStore } from "./store.js";
import { Sidebar } from "./components/Sidebar.js";
import type { GroupRecord, SdkSessionInfo, SessionState } from "./types.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSession(id: string, overrides: Partial<SessionState> = {}): SessionState {
  return {
    session_id: id,
    model: "claude-sonnet-4-6",
    cwd: "/work/repo",
    tools: [],
    permissionMode: "default",
    claude_code_version: "1.0",
    mcp_servers: [],
    agents: [],
    slash_commands: [],
    skills: [],
    total_cost_usd: 0,
    num_turns: 0,
    context_used_percent: 0,
    is_compacting: false,
    git_branch: "",
    is_worktree: false,
    is_containerized: false,
    repo_root: "",
    git_ahead: 0,
    git_behind: 0,
    total_lines_added: 0,
    total_lines_removed: 0,
    ...overrides,
  };
}

function makeSdkSession(id: string, overrides: Partial<SdkSessionInfo> = {}): SdkSessionInfo {
  return {
    sessionId: id,
    state: "connected",
    cwd: "/work/repo",
    createdAt: Date.now(),
    archived: false,
    ...overrides,
  };
}

function makeGroup(overrides: Partial<GroupRecord> = {}): GroupRecord {
  return {
    sessionGroupId: "grp_reload",
    primarySessionId: "orch_reload",
    observerSessionId: "obs_reload",
    status: "active",
    pairing: "claude+codex",
    ...overrides,
  };
}

beforeEach(() => {
  // Reset the real store between tests. The store's `reset` action wipes
  // sessions/sdkSessions/groups/etc. back to initial state so each test
  // starts from a known baseline (mirrors council-slice.test.ts).
  useStore.getState().reset();
  localStorage.clear();
  vi.clearAllMocks();
  mockApi.listSessions.mockResolvedValue([]);
  mockApi.fetchGroups.mockResolvedValue({ groups: [] });
  window.location.hash = "";
});

describe("Council Mode — glyph render after reload (PR #68 BUG closure)", () => {
  /** Seed both council halves into the store as fully-populated
   *  sessions. Sidebar reads the live session map (`state.sessions`) for
   *  per-row render, and `state.sdkSessions` for the model-name fallback;
   *  both need to be present for the SessionItem to render. */
  function seedTwoHalvesIntoStore() {
    const store = useStore.getState();
    store.addSession(makeSession("orch_reload"));
    store.addSession(makeSession("obs_reload"));
    store.setSdkSessions([
      makeSdkSession("orch_reload"),
      makeSdkSession("obs_reload"),
    ]);
  }

  // Bug-state canary. Both council halves are present as sessions, but the
  // group record is absent (REST bootstrap not yet dispatched OR not yet
  // shipped). `councilInfoFor()` returns role: undefined; SessionItem skips
  // the glyph branch. This is the exact failure mode that
  // BUG-council-mode-group-rest-bootstrap-gap.md describes.
  it("WITHOUT hydrateGroups: glyph + role suffix are absent (bug reproduction)", () => {
    seedTwoHalvesIntoStore();
    const store = useStore.getState();
    // Sessions ARE in the store, but the group record + reverse-index
    // are NOT. This is the post-reload state before PR #68.
    expect(store.groups.size).toBe(0);
    expect(store.groupBySessionId.size).toBe(0);

    render(<Sidebar />);

    // Neither half renders the glyph (☼ / ☽). queryAllBy returns [] (not
    // throwing) so the assertion is "glyph element count === 0".
    expect(screen.queryAllByTestId("council-role-glyph")).toHaveLength(0);
    expect(screen.queryAllByTestId("council-role-suffix")).toHaveLength(0);
  });

  // Fix canary. Same sessions, but the REST bootstrap dispatched via
  // `hydrateGroups` HAS landed. The Sidebar must now render the ☼ glyph
  // for the orchestrator half and the ☽ glyph for the observer half,
  // plus the " · orchestrator"/" · observer" suffix.
  it("AFTER hydrateGroups: both halves render the ☼/☽ glyph + role suffix", () => {
    seedTwoHalvesIntoStore();
    const store = useStore.getState();
    // Simulate the App.tsx bootstrap dispatch — what `fetchGroups()`
    // resolution feeds into the store.
    act(() => {
      store.hydrateGroups([makeGroup()]);
    });

    render(<Sidebar />);

    // Exactly two glyphs — one per half. The aria-hidden attribute on
    // the glyph element means screen-readers see the suffix instead;
    // queryAllByTestId still finds the visual element.
    const glyphs = screen.getAllByTestId("council-role-glyph");
    expect(glyphs).toHaveLength(2);
    // Each glyph carries the role-specific character. We don't lock the
    // ordering (Sidebar's project-grouping may reorder); checking the
    // set of rendered text is robust.
    const glyphTexts = glyphs.map((el) => el.textContent).sort();
    expect(glyphTexts).toEqual(["☼", "☽"]);

    // " · orchestrator" / " · observer" suffix renders alongside.
    const suffixes = screen.getAllByTestId("council-role-suffix");
    expect(suffixes).toHaveLength(2);
    const suffixTexts = suffixes.map((el) => el.textContent).sort();
    // Sorted alphabetically: " · observer" before " · orchestrator".
    expect(suffixTexts).toEqual([" · observer", " · orchestrator"]);
  });

  // Reactive update canary — the Sidebar must respond to a hydrate that
  // arrives AFTER the initial render. This is the realistic timing: the
  // App.tsx auth-flip effect dispatches `fetchGroups()` asynchronously;
  // its resolution may land while the Sidebar is already mounted.
  it("hydrate that arrives AFTER initial render: Sidebar re-renders with the glyph", () => {
    seedTwoHalvesIntoStore();
    const store = useStore.getState();

    render(<Sidebar />);

    // First render: no glyph yet (group record not in store).
    expect(screen.queryAllByTestId("council-role-glyph")).toHaveLength(0);

    // Bootstrap REST resolves — dispatch happens now.
    act(() => {
      store.hydrateGroups([makeGroup()]);
    });

    // Sidebar's Zustand selectors fire; the council glyph branch in
    // SessionItem becomes truthy for both halves.
    expect(screen.getAllByTestId("council-role-glyph")).toHaveLength(2);
  });
});
