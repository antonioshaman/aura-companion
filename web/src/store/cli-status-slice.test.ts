// @vitest-environment jsdom

// Boot polyfills (matchMedia + localStorage) mirror the sibling permissions-slice.test.ts
// pattern. Without them, store.ts initialization throws under jsdom +
// Node 22 native localStorage bugs.
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
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => { store.set(key, String(value)); },
        removeItem: (key: string) => { store.delete(key); },
        clear: () => { store.clear(); },
        get length() { return store.size; },
        key: (index: number) => [...store.keys()][index] ?? null,
      },
      writable: true,
      configurable: true,
    });
  }
});

import { useStore } from "../store.js";
import type { CliFailure } from "./cli-status-slice.js";

function failure(overrides: Partial<CliFailure> = {}): CliFailure {
  return {
    reason: "relaunch_exhausted",
    drainedCount: 0,
    subprocessAlive: false,
    firedAt: 1_000,
    ...overrides,
  };
}

beforeEach(() => {
  useStore.getState().reset();
  localStorage.clear();
});

describe("CliStatusSlice — setCliFailure / clearCliFailure", () => {
  it("setCliFailure stores the failure keyed by sessionId", () => {
    useStore.getState().setCliFailure("s1", failure({ reason: "container_missing", drainedCount: 2 }));
    const stored = useStore.getState().cliFailures.get("s1");
    expect(stored).toEqual({
      reason: "container_missing",
      drainedCount: 2,
      subprocessAlive: false,
      firedAt: 1_000,
    });
  });

  it("setCliFailure preserves optional lastErrorSha256", () => {
    useStore.getState().setCliFailure("s1", failure({ lastErrorSha256: "abc123" }));
    expect(useStore.getState().cliFailures.get("s1")?.lastErrorSha256).toBe("abc123");
  });

  it("setCliFailure replaces a prior entry (newest wins)", () => {
    useStore.getState().setCliFailure("s1", failure({ reason: "relaunch_exhausted", drainedCount: 1 }));
    useStore.getState().setCliFailure("s1", failure({ reason: "binary_missing", drainedCount: 4 }));
    const stored = useStore.getState().cliFailures.get("s1");
    expect(stored?.reason).toBe("binary_missing");
    expect(stored?.drainedCount).toBe(4);
  });

  it("setCliFailure for session A does not affect session B", () => {
    useStore.getState().setCliFailure("sA", failure({ reason: "relaunch_exhausted" }));
    useStore.getState().setCliFailure("sB", failure({ reason: "container_missing" }));
    expect(useStore.getState().cliFailures.get("sA")?.reason).toBe("relaunch_exhausted");
    expect(useStore.getState().cliFailures.get("sB")?.reason).toBe("container_missing");
    expect(useStore.getState().cliFailures.size).toBe(2);
  });

  it("clearCliFailure removes the entry", () => {
    useStore.getState().setCliFailure("s1", failure());
    useStore.getState().clearCliFailure("s1");
    expect(useStore.getState().cliFailures.has("s1")).toBe(false);
  });

  it("clearCliFailure no-ops when absent (no spurious re-render)", () => {
    const before = useStore.getState().cliFailures;
    useStore.getState().clearCliFailure("unknown");
    // Reference equality intentionally - we want the Map identity preserved so
    // selectors subscribed to cliFailures do not refire.
    expect(useStore.getState().cliFailures).toBe(before);
  });

  // Brief: "Clears on session archive/relaunch."
  it("removeSession (archive path) drops the cliFailure entry for the session", () => {
    useStore.getState().setCliFailure("s1", failure());
    useStore.getState().addSession({
      session_id: "s1",
      backend_type: "claude",
      model: "",
      cwd: "",
      tools: [],
      permissionMode: "default",
      claude_code_version: "",
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
    });
    useStore.getState().removeSession("s1");
    expect(useStore.getState().cliFailures.has("s1")).toBe(false);
  });

  // Brief: pendingDraftForNextSession round-trip - cli-failed banner stash flow.
  it("setPendingDraftForNextSession / consumePendingDraftForNextSession round-trip is one-shot", () => {
    useStore.getState().setPendingDraftForNextSession("draft text");
    expect(useStore.getState().pendingDraftForNextSession).toBe("draft text");
    const consumed = useStore.getState().consumePendingDraftForNextSession();
    expect(consumed).toBe("draft text");
    expect(useStore.getState().pendingDraftForNextSession).toBeNull();
    // Second consume returns undefined (single-fire contract).
    expect(useStore.getState().consumePendingDraftForNextSession()).toBeUndefined();
  });
});
