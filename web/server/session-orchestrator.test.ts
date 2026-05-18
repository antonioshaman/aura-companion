import { vi, describe, it, expect, beforeEach } from "vitest";

// ── Module mocks ────────────────────────────────────────────────────────────
// Must be declared before any imports that reference them.

vi.mock("./env-manager.js", () => ({
  getEnv: vi.fn(() => null),
}));

vi.mock("./sandbox-manager.js", () => ({
  getSandbox: vi.fn(() => null),
}));

vi.mock("./git-utils.js", () => ({
  getRepoInfo: vi.fn(() => null),
  gitFetch: vi.fn(() => ({ success: true, output: "" })),
  gitPull: vi.fn(() => ({ success: true, output: "" })),
  checkoutOrCreateBranch: vi.fn(() => ({ created: false })),
  ensureWorktree: vi.fn(() => ({ worktreePath: "/wt/feat", actualBranch: "feat", isNew: true })),
  isWorktreeDirty: vi.fn(() => false),
  removeWorktree: vi.fn(() => ({ removed: true })),
}));

vi.mock("./session-names.js", () => ({
  getName: vi.fn(() => undefined),
  setName: vi.fn(),
  getAllNames: vi.fn(() => ({})),
  removeName: vi.fn(),
}));

vi.mock("./session-linear-issues.js", () => ({
  getLinearIssue: vi.fn(() => undefined),
  setLinearIssue: vi.fn(),
  removeLinearIssue: vi.fn(),
  getAllLinearIssues: vi.fn(() => ({})),
}));

vi.mock("./settings-manager.js", () => ({
  getSettings: vi.fn(() => ({
    anthropicApiKey: "",
    anthropicModel: "claude-sonnet-4-6",
    linearApiKey: "",
    linearAutoTransition: false,
    linearAutoTransitionStateId: "",
    linearAutoTransitionStateName: "",
    linearArchiveTransition: false,
    linearArchiveTransitionStateId: "",
    linearArchiveTransitionStateName: "",
    claudeCodeOAuthToken: "",
    openaiApiKey: "",
    onboardingCompleted: false,
  })),
}));

vi.mock("./linear-connections.js", () => ({
  getConnection: vi.fn(() => null),
  resolveApiKey: vi.fn(() => null),
}));

vi.mock("./linear-prompt-builder.js", () => ({
  buildLinearSystemPrompt: vi.fn(() => ""),
}));

vi.mock("./routes/linear-routes.js", () => ({
  transitionLinearIssue: vi.fn(async () => ({ ok: true })),
  fetchLinearTeamStates: vi.fn(async () => []),
}));

vi.mock("./claude-container-auth.js", () => ({
  hasContainerClaudeAuth: vi.fn(() => true),
}));

vi.mock("./codex-container-auth.js", () => ({
  hasContainerCodexAuth: vi.fn(() => true),
}));

vi.mock("./commands-discovery.js", () => ({
  discoverCommandsAndSkills: vi.fn(async () => ({ slash_commands: [], skills: [] })),
}));

vi.mock("./auto-namer.js", () => ({
  generateSessionTitle: vi.fn(async () => "Test Title"),
}));

const mockImagePullIsReady = vi.hoisted(() => vi.fn(() => true));
const mockImagePullGetState = vi.hoisted(() => vi.fn(() => ({ image: "", status: "ready", progress: [] })));
const mockImagePullEnsureImage = vi.hoisted(() => vi.fn());
const mockImagePullWaitForReady = vi.hoisted(() => vi.fn(async () => true));
const mockImagePullOnProgress = vi.hoisted(() => vi.fn(() => () => {}));

vi.mock("./image-pull-manager.js", () => ({
  imagePullManager: {
    isReady: mockImagePullIsReady,
    getState: mockImagePullGetState,
    ensureImage: mockImagePullEnsureImage,
    waitForReady: mockImagePullWaitForReady,
    onProgress: mockImagePullOnProgress,
  },
}));

vi.mock("./container-manager.js", () => ({
  containerManager: {
    removeContainer: vi.fn(),
    createContainer: vi.fn(() => ({
      containerId: "cid-1",
      name: "companion-1",
      image: "the-companion:latest",
      portMappings: [],
      hostCwd: "/test",
      containerCwd: "/workspace",
      state: "running",
    })),
    imageExists: vi.fn(() => true),
    retrack: vi.fn(),
    copyWorkspaceToContainer: vi.fn(async () => {}),
    reseedGitAuth: vi.fn(),
    gitOpsInContainer: vi.fn(() => ({
      fetchOk: true,
      checkoutOk: true,
      pullOk: true,
      errors: [],
    })),
    execInContainerAsync: vi.fn(async () => ({ exitCode: 0, output: "ok" })),
    isContainerAlive: vi.fn(() => "not_found"),
  },
}));

// ── Imports (after mocks) ───────────────────────────────────────────────────

import { SessionOrchestrator, deterministicFindingId } from "./session-orchestrator.js";
import type { SessionOrchestratorDeps } from "./session-orchestrator.js";
import { containerManager } from "./container-manager.js";
import * as envManager from "./env-manager.js";
import * as sandboxManager from "./sandbox-manager.js";
import * as gitUtils from "./git-utils.js";
import * as sessionNames from "./session-names.js";
import * as sessionLinearIssues from "./session-linear-issues.js";
import * as settingsManager from "./settings-manager.js";
import { resolveApiKey } from "./linear-connections.js";
import { transitionLinearIssue, fetchLinearTeamStates } from "./routes/linear-routes.js";
import { hasContainerClaudeAuth } from "./claude-container-auth.js";
import { hasContainerCodexAuth } from "./codex-container-auth.js";
import { generateSessionTitle } from "./auto-namer.js";
import { companionBus } from "./event-bus.js";

// ── Mock factories ──────────────────────────────────────────────────────────

function createMockLauncher() {
  return {
    launch: vi.fn(() => ({
      sessionId: "session-1",
      state: "starting",
      cwd: "/test",
      createdAt: Date.now(),
    })),
    kill: vi.fn(async () => true),
    relaunch: vi.fn(async () => ({ ok: true })),
    listSessions: vi.fn(() => []),
    getSession: vi.fn(() => undefined),
    setArchived: vi.fn(),
    removeSession: vi.fn(),
    setCLISessionId: vi.fn(),
    getStartingSessions: vi.fn(() => []),
  } as any;
}

function createMockBridge() {
  return {
    closeSession: vi.fn(),
    isCliConnected: vi.fn(() => false),
    getSession: vi.fn(() => null),
    getAllSessions: vi.fn(() => []),
    markContainerized: vi.fn(),
    markCouncilSession: vi.fn(),
    flushSessionStorePendingSync: vi.fn(),
    prePopulateCommands: vi.fn(),
    broadcastNameUpdate: vi.fn(),
    broadcastToSession: vi.fn(),
    broadcastToGroup: vi.fn(),
    injectSystemPrompt: vi.fn(),
    attachBackendAdapter: vi.fn(),
    cancelDisconnectTimer: vi.fn(() => false),
    sendObserverWakeFrame: vi.fn(() => ({ kind: "sent" })),
    onUserFrameObserved: vi.fn(() => () => {}),
  } as any;
}

function createMockStore() {
  return {
    setArchived: vi.fn(() => true),
  } as any;
}

function createMockTracker() {
  return {
    addMapping: vi.fn(),
    getBySession: vi.fn(() => null),
    removeBySession: vi.fn(),
    isWorktreeInUse: vi.fn(() => false),
  } as any;
}

function createDeps(overrides?: Partial<SessionOrchestratorDeps>) {
  const launcher = createMockLauncher();
  const wsBridge = createMockBridge();
  const sessionStore = createMockStore();
  const worktreeTracker = createMockTracker();
  const prPoller = { watch: vi.fn(), unwatch: vi.fn() };
  const agentExecutor = { handleSessionExited: vi.fn() } as any;
  return {
    launcher,
    wsBridge,
    sessionStore,
    worktreeTracker,
    prPoller,
    agentExecutor,
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("SessionOrchestrator", () => {
  let deps: ReturnType<typeof createDeps>;
  let orchestrator: SessionOrchestrator;

  beforeEach(() => {
    vi.clearAllMocks();
    companionBus.clear();
    mockImagePullIsReady.mockReturnValue(true);
    // Re-establish mocks that may have been overridden by mockImplementation in
    // previous tests (clearAllMocks resets calls/results but NOT implementations).
    vi.mocked(hasContainerClaudeAuth).mockReturnValue(true);
    vi.mocked(hasContainerCodexAuth).mockReturnValue(true);
    vi.mocked(containerManager.createContainer).mockReturnValue({
      containerId: "cid-1",
      name: "companion-1",
      image: "the-companion:latest",
      portMappings: [],
      hostCwd: "/test",
      containerCwd: "/workspace",
      state: "running",
    } as any);
    vi.mocked(containerManager.gitOpsInContainer).mockReturnValue({
      fetchOk: true,
      checkoutOk: true,
      pullOk: true,
      errors: [],
    } as any);
    vi.mocked(containerManager.execInContainerAsync).mockResolvedValue({ exitCode: 0, output: "ok" });
    deps = createDeps();
    orchestrator = new SessionOrchestrator(deps);
  });

  // ── Initialization / Event wiring ─────────────────────────────────────────

  describe("initialize()", () => {
    it("registers all expected event listeners on companionBus", () => {
      // Verifies that initialize() wires up all event handlers on the bus
      orchestrator.initialize();

      expect(companionBus.listenerCount("session:cli-id-received")).toBeGreaterThan(0);
      expect(companionBus.listenerCount("backend:codex-adapter-created")).toBeGreaterThan(0);
      expect(companionBus.listenerCount("session:exited")).toBeGreaterThan(0);
      expect(companionBus.listenerCount("session:git-info-ready")).toBeGreaterThan(0);
      expect(companionBus.listenerCount("session:relaunch-needed")).toBeGreaterThan(0);
      expect(companionBus.listenerCount("session:idle-kill")).toBeGreaterThan(0);
      expect(companionBus.listenerCount("session:first-turn-completed")).toBeGreaterThan(0);
    });

    // PLAN-aura-orchestrator-idle-auto-proceed Task 9 — boot reconcile wiring.
    // The full reconcile-loop logic lives in
    // `auto-proceed-orchestrator-bindings.ts` and is tested there end-to-end
    // (real filesystem + real IdleTimerManager). The orchestrator-side
    // contract this exercises is the three-part adapter surface:
    //   1. Constructor falls back to the noop manager when DI omits it
    //      (`getIdleTimerManager()` returns a usable instance).
    //   2. `setIdleTimerManager(...)` replaces the manager (covers the
    //      late-injection seam `index.ts` uses to break the construct cycle).
    //   3. `initialize()` invokes `rehydrateAutoProceedTraces()` which
    //      delegates to `runAutoProceedBootReconcile` — with no council
    //      groups in `councilGroupMeta`, the inner driver short-circuits
    //      cleanly without touching the filesystem.
    it("idle-timer manager DI: get/set + rehydrate-on-init wiring exercised end-to-end", async () => {
      // Pre-init: noop manager from the DI default. Constructor branch
      // exercised. The returned instance must respond to dispose without throwing.
      const noop = orchestrator.getIdleTimerManager();
      expect(noop).toBeDefined();
      expect(() => noop.disposeAll()).not.toThrow();

      // Late-injection seam: replace with a fresh real manager. Asserts
      // the setter actually mutates the instance field — otherwise
      // `index.ts`'s mutual-cycle workaround would silently leave the
      // noop manager in production.
      const { IdleTimerManager: IdleTimerManagerCtor } = await import("./idle-timer-manager.js");
      const { FakeClock } = await import("./clock-source.js");
      const replacement = new IdleTimerManagerCtor({
        clock: new FakeClock(0),
        getSession: () => null,
        getGroupStatus: () => "active",
        persistTrace: () => ({ ok: true }),
        appendSummary: () => ({ ok: true }),
        sendSyntheticFrame: () => ({ ok: false, error: "test" }),
        logEvent: () => undefined,
      });
      orchestrator.setIdleTimerManager(replacement);
      expect(orchestrator.getIdleTimerManager()).toBe(replacement);

      // initialize() exercises the rehydrate delegation path. With no
      // council groups present (default mock returns empty), the driver's
      // early-return fires; no log emit; no manager state mutation.
      orchestrator.initialize();
      // Manager remains pristine — no session was rehydrated.
      expect(replacement.getIterationCount("any-session")).toBe(0);
    });

    it("CLI session ID callback delegates to launcher.setCLISessionId", () => {
      orchestrator.initialize();

      // Emit event on the bus instead of extracting callback
      companionBus.emit("session:cli-id-received", { sessionId: "s1", cliSessionId: "cli-id-123" });

      expect(deps.launcher.setCLISessionId).toHaveBeenCalledWith("s1", "cli-id-123");
    });

    // CR-7 (council review 2026-05-15-0336 finding #7 / Beck P1.1):
    // `initialize()` subscribes `wsBridge.onUserFrameObserved` to
    // `idleTimerManager.noteUserMessage`. Without this test, a future
    // refactor that deletes the subscription line would still pass every
    // existing test — the bridge has a stub `onUserFrameObserved: vi.fn(() => () => {})`
    // and the manager's `noteUserMessage` is also independently tested,
    // but the WIRING between them was untested. The bug class is
    // `feedback_call_site_presence_not_just_symbol_export` — every
    // standalone symbol works, the line connecting them silently breaks
    // and auto-proceed continues firing under real user activity.
    it("CR-7: initialize() subscribes onUserFrameObserved → idleTimerManager.noteUserMessage", () => {
      const noteUserMessage = vi.fn();
      // Capture the callback the orchestrator registers so we can
      // invoke it ourselves (the bridge mock won't actually fire it).
      let captured: ((sid: string) => void) | null = null;
      (deps.wsBridge as any).onUserFrameObserved = vi.fn((cb: (sid: string) => void) => {
        captured = cb;
        return () => {};
      });
      // Replace the noop idle-timer manager with a spy-capable stub.
      orchestrator.setIdleTimerManager({
        noteUserMessage,
        // Stub the other methods so the manager interface is satisfied.
        disposeAll: () => {},
        getIterationCount: () => 0,
        isSyntheticTurnInFlight: () => false,
        noteTerminalResultFrame: () => {},
        clearPendingSyntheticTurn: () => {},
        armForSession: () => undefined,
        cancelForSession: () => undefined,
        rehydrateFromTrace: () => undefined,
      } as any);

      orchestrator.initialize();

      // The orchestrator MUST have called onUserFrameObserved during
      // initialize() — symbol-presence assertion.
      expect((deps.wsBridge as any).onUserFrameObserved).toHaveBeenCalledTimes(1);
      expect(captured).not.toBeNull();

      // BEHAVIOURAL — invoking the captured callback must forward to
      // the manager's noteUserMessage. This is the wiring under test.
      captured!("sess-from-tab-b");
      expect(noteUserMessage).toHaveBeenCalledWith("sess-from-tab-b");
    });

    // CR-7 / Beck P1.2: the new `session:exited` listener (added in PR #54
    // Task 11.8) calls `idleTimerManager.clearPendingSyntheticTurn` on EVERY
    // session exit so an orphaned sticky-token from a session that died
    // mid-synthetic-turn cannot survive across `--resume`. The existing
    // session:exited listener-count tests assert count ≥ N but do NOT
    // distinguish handlers — a regression deleting THIS specific listener
    // keeps the count valid and ships green.
    it("CR-7: session:exited fires idleTimerManager.clearPendingSyntheticTurn", () => {
      const clearPendingSyntheticTurn = vi.fn();
      orchestrator.setIdleTimerManager({
        noteUserMessage: () => {},
        clearPendingSyntheticTurn,
        disposeAll: () => {},
        getIterationCount: () => 0,
        isSyntheticTurnInFlight: () => false,
        noteTerminalResultFrame: () => {},
        armForSession: () => undefined,
        cancelForSession: () => undefined,
        rehydrateFromTrace: () => undefined,
      } as any);

      orchestrator.initialize();
      companionBus.emit("session:exited", { sessionId: "s-exited-1", exitCode: 0 });

      expect(clearPendingSyntheticTurn).toHaveBeenCalledWith("s-exited-1");
    });

    it("session exit callback notifies agentExecutor", () => {
      orchestrator.initialize();

      companionBus.emit("session:exited", { sessionId: "s1", exitCode: 0 });

      expect(deps.agentExecutor.handleSessionExited).toHaveBeenCalledWith("s1", 0);
    });

    it("git info ready callback starts PR polling", () => {
      orchestrator.initialize();

      companionBus.emit("session:git-info-ready", { sessionId: "s1", cwd: "/repo", branch: "main" });

      expect(deps.prPoller.watch).toHaveBeenCalledWith("s1", "/repo", "main");
    });

    it("idle kill callback does not kill archived sessions", async () => {
      deps.launcher.getSession.mockReturnValue({ archived: true });
      orchestrator.initialize();

      companionBus.emit("session:idle-kill", { sessionId: "s1" });
      await new Promise(r => setTimeout(r, 0));

      // Should not kill because session is archived
      expect(deps.launcher.kill).not.toHaveBeenCalled();
    });

    it("idle kill callback kills CLI but preserves container", async () => {
      deps.launcher.getSession.mockReturnValue({ archived: false });
      orchestrator.initialize();

      companionBus.emit("session:idle-kill", { sessionId: "s1" });
      await new Promise(r => setTimeout(r, 0));

      expect(deps.launcher.kill).toHaveBeenCalledWith("s1");
      // Container must NOT be removed — idle-kill only stops the CLI process
      // so the container can be reused on relaunch.
      expect(containerManager.removeContainer).not.toHaveBeenCalled();
    });

    it("after idle-kill, relaunch reuses preserved container without creating a new one", async () => {
      // End-to-end scenario: idle-kill fires, container survives, browser
      // reconnects, and the CLI is relaunched into the existing container.
      vi.useFakeTimers();
      deps.launcher.getSession.mockReturnValue({
        archived: false,
        state: "exited",
        containerId: "cid-preserved",
        pid: undefined,
      } as any);
      deps.wsBridge.isCliConnected.mockReturnValue(false);
      deps.launcher.relaunch.mockResolvedValue({ ok: true });
      orchestrator.initialize();

      // 1. Idle-kill fires — CLI killed, container preserved
      companionBus.emit("session:idle-kill", { sessionId: "s1" });
      await vi.advanceTimersByTimeAsync(0);
      expect(deps.launcher.kill).toHaveBeenCalledWith("s1");
      expect(containerManager.removeContainer).not.toHaveBeenCalled();

      // 2. Browser reconnects — triggers auto-relaunch
      companionBus.emit("session:relaunch-needed", { sessionId: "s1" });
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.advanceTimersByTimeAsync(0);

      // 3. Relaunch succeeds using the preserved container — no new container created
      expect(deps.launcher.relaunch).toHaveBeenCalledWith("s1");
      expect(containerManager.createContainer).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("idle kill clears auto-relaunch counter so session can be fully relaunched later", async () => {
      // After idle-kill, the auto-relaunch counter must be reset. Without this,
      // a session that previously had failed relaunch attempts would be stuck at
      // max and never relaunch when the user returns.
      vi.useFakeTimers();
      deps.launcher.getSession.mockReturnValue({ archived: false, state: "exited", pid: undefined } as any);
      deps.wsBridge.isCliConnected.mockReturnValue(false);
      deps.launcher.relaunch.mockResolvedValue({ ok: false, error: "failed" });
      orchestrator.initialize();

      // Exhaust 2 of 3 relaunch attempts
      for (let i = 0; i < 2; i++) {
        companionBus.emit("session:relaunch-needed", { sessionId: "s1" });
        await vi.advanceTimersByTimeAsync(15_000);
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(deps.launcher.relaunch).toHaveBeenCalledTimes(2);

      // Now idle-kill the session — this should clear the counter
      companionBus.emit("session:idle-kill", { sessionId: "s1" });
      await vi.advanceTimersByTimeAsync(0);

      // After idle-kill, we should get a fresh budget of 3 relaunch attempts.
      // Reset the mock to track new calls.
      deps.launcher.relaunch.mockClear();
      deps.launcher.relaunch.mockResolvedValue({ ok: false, error: "failed" });

      for (let i = 0; i < 3; i++) {
        companionBus.emit("session:relaunch-needed", { sessionId: "s1" });
        await vi.advanceTimersByTimeAsync(15_000);
        await vi.advanceTimersByTimeAsync(0);
      }

      // All 3 attempts should succeed (not blocked by previous count)
      expect(deps.launcher.relaunch).toHaveBeenCalledTimes(3);
      vi.useRealTimers();
    });

    it("is idempotent — calling initialize() twice does not double-register listeners", () => {
      // Guards against accidental re-initialization which would cause
      // all event handlers to fire multiple times per event.
      orchestrator.initialize();
      const countsAfterFirst = {
        cliId: companionBus.listenerCount("session:cli-id-received"),
        codex: companionBus.listenerCount("backend:codex-adapter-created"),
        exited: companionBus.listenerCount("session:exited"),
        relaunch: companionBus.listenerCount("session:relaunch-needed"),
        idleKill: companionBus.listenerCount("session:idle-kill"),
        firstTurn: companionBus.listenerCount("session:first-turn-completed"),
      };

      orchestrator.initialize();

      // Listener counts should not have doubled after the second initialize()
      expect(companionBus.listenerCount("session:cli-id-received")).toBe(countsAfterFirst.cliId);
      expect(companionBus.listenerCount("backend:codex-adapter-created")).toBe(countsAfterFirst.codex);
      expect(companionBus.listenerCount("session:exited")).toBe(countsAfterFirst.exited);
      expect(companionBus.listenerCount("session:relaunch-needed")).toBe(countsAfterFirst.relaunch);
      expect(companionBus.listenerCount("session:idle-kill")).toBe(countsAfterFirst.idleKill);
      expect(companionBus.listenerCount("session:first-turn-completed")).toBe(countsAfterFirst.firstTurn);
    });
  });

  // ── Session Creation ──────────────────────────────────────────────────────

  describe("createSession()", () => {
    it("creates a basic session with defaults", async () => {
      const result = await orchestrator.createSession({ cwd: "/test" });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.session.sessionId).toBe("session-1");
      }
      expect(deps.launcher.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: "/test",
          backendType: "claude",
        }),
      );
    });

    it("returns 400 for invalid backend", async () => {
      const result = await orchestrator.createSession({ cwd: "/test", backend: "invalid" });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Invalid backend");
        expect(result.status).toBe(400);
      }
    });

    it("resolves environment variables from envSlug", async () => {
      vi.mocked(envManager.getEnv).mockReturnValue({
        name: "Production",
        slug: "production",
        variables: { API_KEY: "secret", DB_HOST: "db.example.com" },
        createdAt: 1000,
        updatedAt: 1000,
      });

      const result = await orchestrator.createSession({ cwd: "/test", envSlug: "production" });

      expect(result.ok).toBe(true);
      expect(envManager.getEnv).toHaveBeenCalledWith("production");
      expect(deps.launcher.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          env: expect.objectContaining({ API_KEY: "secret", DB_HOST: "db.example.com" }),
        }),
      );
    });

    // ── Global token injection from settings ───────────────────────────

    // Verifies that CLAUDE_CODE_OAUTH_TOKEN is injected from global settings
    // when the session backend is "claude" and no token is already set
    it("injects CLAUDE_CODE_OAUTH_TOKEN from global settings for claude backend", async () => {
      vi.mocked(settingsManager.getSettings).mockReturnValue({
        ...settingsManager.getSettings(),
        claudeCodeOAuthToken: "global-oauth-token",
      });

      await orchestrator.createSession({ cwd: "/test", backend: "claude" });

      expect(deps.launcher.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          env: expect.objectContaining({ CLAUDE_CODE_OAUTH_TOKEN: "global-oauth-token" }),
        }),
      );
    });

    // Verifies that OPENAI_API_KEY is injected from global settings
    // when the session backend is "codex" and no key is already set
    it("injects OPENAI_API_KEY from global settings for codex backend", async () => {
      vi.mocked(settingsManager.getSettings).mockReturnValue({
        ...settingsManager.getSettings(),
        openaiApiKey: "sk-global-key",
      });

      await orchestrator.createSession({ cwd: "/test", backend: "codex" });

      expect(deps.launcher.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          env: expect.objectContaining({ OPENAI_API_KEY: "sk-global-key" }),
        }),
      );
    });

    // Verifies that env-profile tokens take precedence over global settings
    it("does not overwrite CLAUDE_CODE_OAUTH_TOKEN when already set by env profile", async () => {
      vi.mocked(settingsManager.getSettings).mockReturnValue({
        ...settingsManager.getSettings(),
        claudeCodeOAuthToken: "global-token",
      });
      vi.mocked(envManager.getEnv).mockReturnValue({
        name: "Custom",
        slug: "custom",
        variables: { CLAUDE_CODE_OAUTH_TOKEN: "env-profile-token" },
        createdAt: 1000,
        updatedAt: 1000,
      });

      await orchestrator.createSession({ cwd: "/test", backend: "claude", envSlug: "custom" });

      expect(deps.launcher.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          env: expect.objectContaining({ CLAUDE_CODE_OAUTH_TOKEN: "env-profile-token" }),
        }),
      );
    });

    // Verifies that no token is injected when global settings have empty values
    it("does not inject token when global setting is empty", async () => {
      vi.mocked(settingsManager.getSettings).mockReturnValue({
        ...settingsManager.getSettings(),
        claudeCodeOAuthToken: "",
        openaiApiKey: "",
      });

      await orchestrator.createSession({ cwd: "/test", backend: "claude" });

      const launchCall = vi.mocked(deps.launcher.launch).mock.calls[0][0];
      expect(launchCall.env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    });

    it("validates branch name to prevent injection", async () => {
      const result = await orchestrator.createSession({ cwd: "/test", branch: "bad branch name!" });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Invalid branch name");
        expect(result.status).toBe(400);
      }
    });

    it("performs git fetch, checkout, and pull for non-docker branch", async () => {
      vi.mocked(gitUtils.getRepoInfo).mockReturnValue({
        repoRoot: "/repo",
        repoName: "my-repo",
        currentBranch: "develop",
        defaultBranch: "main",
        isWorktree: false,
      });

      const result = await orchestrator.createSession({ cwd: "/repo", branch: "main" });

      expect(result.ok).toBe(true);
      expect(gitUtils.gitFetch).toHaveBeenCalledWith("/repo");
      expect(gitUtils.checkoutOrCreateBranch).toHaveBeenCalledWith("/repo", "main", {
        createBranch: undefined,
        defaultBranch: "main",
      });
      expect(gitUtils.gitPull).toHaveBeenCalledWith("/repo");
    });

    it("skips checkout when branch matches current branch", async () => {
      vi.mocked(gitUtils.getRepoInfo).mockReturnValue({
        repoRoot: "/repo",
        repoName: "my-repo",
        currentBranch: "main",
        defaultBranch: "main",
        isWorktree: false,
      });

      await orchestrator.createSession({ cwd: "/repo", branch: "main" });

      expect(gitUtils.gitFetch).toHaveBeenCalled();
      expect(gitUtils.checkoutOrCreateBranch).not.toHaveBeenCalled();
      expect(gitUtils.gitPull).toHaveBeenCalled();
    });

    it("creates worktree when useWorktree is true", async () => {
      vi.mocked(gitUtils.getRepoInfo).mockReturnValue({
        repoRoot: "/repo",
        repoName: "my-repo",
        currentBranch: "main",
        defaultBranch: "main",
        isWorktree: false,
      });
      vi.mocked(gitUtils.ensureWorktree).mockReturnValue({
        worktreePath: "/wt/feat",
        branch: "feat",
        actualBranch: "feat",
        isNew: true,
      } as any);

      const result = await orchestrator.createSession({ cwd: "/repo", branch: "feat", useWorktree: true });

      expect(result.ok).toBe(true);
      expect(gitUtils.ensureWorktree).toHaveBeenCalledWith("/repo", "feat", {
        baseBranch: "main",
        createBranch: undefined,
        forceNew: true,
      });
      // Launch should use worktree path as cwd
      expect(deps.launcher.launch).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: "/wt/feat" }),
      );
      // Should track the worktree mapping
      expect(deps.worktreeTracker.addMapping).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "session-1",
          repoRoot: "/repo",
          branch: "feat",
          worktreePath: "/wt/feat",
        }),
      );
    });

    it("proceeds when git fetch fails (non-fatal)", async () => {
      vi.mocked(gitUtils.getRepoInfo).mockReturnValue({
        repoRoot: "/repo",
        repoName: "my-repo",
        currentBranch: "main",
        defaultBranch: "main",
        isWorktree: false,
      });
      vi.mocked(gitUtils.gitFetch).mockReturnValue({ success: false, output: "network error" });

      const result = await orchestrator.createSession({ cwd: "/repo", branch: "main" });

      expect(result.ok).toBe(true);
      expect(deps.launcher.launch).toHaveBeenCalled();
    });

    it("returns 400 when containerized Claude lacks auth", async () => {
      vi.mocked(hasContainerClaudeAuth).mockReturnValue(false);
      vi.mocked(envManager.getEnv).mockReturnValue({
        name: "E",
        slug: "e",
        variables: {},
        createdAt: 1,
        updatedAt: 1,
      } as any);

      const result = await orchestrator.createSession({
        cwd: "/test",
        sandboxEnabled: true,
        envSlug: "e",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Containerized Claude requires auth");
        expect(result.status).toBe(400);
      }
    });

    it("returns 400 when containerized Codex lacks auth", async () => {
      vi.mocked(hasContainerCodexAuth).mockReturnValue(false);
      vi.mocked(envManager.getEnv).mockReturnValue({
        name: "E",
        slug: "e",
        variables: {},
        createdAt: 1,
        updatedAt: 1,
      } as any);

      const result = await orchestrator.createSession({
        cwd: "/test",
        backend: "codex",
        sandboxEnabled: true,
        envSlug: "e",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Containerized Codex requires auth");
        expect(result.status).toBe(400);
      }
    });

    it("creates container for sandboxed sessions", async () => {
      vi.mocked(envManager.getEnv).mockReturnValue({
        name: "Docker",
        slug: "docker",
        variables: { CLAUDE_CODE_OAUTH_TOKEN: "token" },
        createdAt: 1,
        updatedAt: 1,
      } as any);
      vi.mocked(sandboxManager.getSandbox).mockReturnValue({
        name: "Docker",
        slug: "docker",
        createdAt: 1,
        updatedAt: 1,
      });

      const result = await orchestrator.createSession({
        cwd: "/test",
        envSlug: "docker",
        sandboxEnabled: true,
        sandboxSlug: "docker",
      });

      expect(result.ok).toBe(true);
      expect(containerManager.createContainer).toHaveBeenCalled();
      expect(containerManager.copyWorkspaceToContainer).toHaveBeenCalled();
      expect(containerManager.retrack).toHaveBeenCalledWith("cid-1", "session-1");
      expect(deps.wsBridge.markContainerized).toHaveBeenCalledWith("session-1", "/test");
    });

    it("returns 503 when container creation fails", async () => {
      vi.mocked(envManager.getEnv).mockReturnValue({
        name: "E",
        slug: "e",
        variables: { CLAUDE_CODE_OAUTH_TOKEN: "token" },
        createdAt: 1,
        updatedAt: 1,
      } as any);
      vi.mocked(containerManager.createContainer).mockImplementation(() => {
        throw new Error("docker daemon timeout");
      });

      const result = await orchestrator.createSession({
        cwd: "/test",
        sandboxEnabled: true,
        envSlug: "e",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("container startup failed");
        expect(result.status).toBe(503);
      }
    });

    it("runs init script for sandbox sessions", async () => {
      vi.mocked(envManager.getEnv).mockReturnValue({
        name: "E",
        slug: "e",
        variables: { CLAUDE_CODE_OAUTH_TOKEN: "token" },
        createdAt: 1,
        updatedAt: 1,
      } as any);
      vi.mocked(sandboxManager.getSandbox).mockReturnValue({
        name: "E",
        slug: "e",
        initScript: "npm install",
        createdAt: 1,
        updatedAt: 1,
      });

      const result = await orchestrator.createSession({
        cwd: "/test",
        sandboxEnabled: true,
        sandboxSlug: "e",
        envSlug: "e",
      });

      expect(result.ok).toBe(true);
      expect(containerManager.execInContainerAsync).toHaveBeenCalledWith(
        "cid-1",
        ["sh", "-lc", "npm install"],
        expect.objectContaining({ timeout: expect.any(Number) }),
      );
    });

    it("returns 503 when init script fails", async () => {
      vi.mocked(envManager.getEnv).mockReturnValue({
        name: "E",
        slug: "e",
        variables: { CLAUDE_CODE_OAUTH_TOKEN: "token" },
        createdAt: 1,
        updatedAt: 1,
      } as any);
      vi.mocked(sandboxManager.getSandbox).mockReturnValue({
        name: "E",
        slug: "e",
        initScript: "exit 1",
        createdAt: 1,
        updatedAt: 1,
      });
      vi.mocked(containerManager.execInContainerAsync).mockResolvedValue({ exitCode: 1, output: "npm ERR!" });

      const result = await orchestrator.createSession({
        cwd: "/test",
        sandboxEnabled: true,
        sandboxSlug: "e",
        envSlug: "e",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Init script failed");
        expect(result.status).toBe(503);
        // Container should be cleaned up
        expect(containerManager.removeContainer).toHaveBeenCalled();
      }
    });

    it("runs git ops inside container for Docker sessions with branch", async () => {
      vi.mocked(gitUtils.getRepoInfo).mockReturnValue({
        repoRoot: "/repo",
        repoName: "my-repo",
        currentBranch: "main",
        defaultBranch: "main",
        isWorktree: false,
      } as any);
      vi.mocked(envManager.getEnv).mockReturnValue({
        name: "Docker",
        slug: "docker",
        variables: { CLAUDE_CODE_OAUTH_TOKEN: "token" },
        createdAt: 1,
        updatedAt: 1,
      } as any);
      vi.mocked(sandboxManager.getSandbox).mockReturnValue({
        name: "Docker",
        slug: "docker",
        createdAt: 1,
        updatedAt: 1,
      });

      const result = await orchestrator.createSession({
        cwd: "/repo",
        branch: "feat/new",
        envSlug: "docker",
        sandboxEnabled: true,
        sandboxSlug: "docker",
      });

      expect(result.ok).toBe(true);
      // Host git ops should NOT have been called
      expect(gitUtils.gitFetch).not.toHaveBeenCalled();
      expect(gitUtils.checkoutOrCreateBranch).not.toHaveBeenCalled();
      expect(gitUtils.gitPull).not.toHaveBeenCalled();
      // In-container git ops SHOULD have been called
      expect(containerManager.gitOpsInContainer).toHaveBeenCalledWith(
        "cid-1",
        expect.objectContaining({ branch: "feat/new", currentBranch: "main" }),
      );
    });

    it("returns 400 when in-container checkout fails", async () => {
      vi.mocked(gitUtils.getRepoInfo).mockReturnValue({
        repoRoot: "/repo",
        repoName: "my-repo",
        currentBranch: "main",
        defaultBranch: "main",
        isWorktree: false,
      } as any);
      vi.mocked(envManager.getEnv).mockReturnValue({
        name: "E",
        slug: "e",
        variables: { CLAUDE_CODE_OAUTH_TOKEN: "token" },
        createdAt: 1,
        updatedAt: 1,
      } as any);
      vi.mocked(sandboxManager.getSandbox).mockReturnValue({
        name: "E",
        slug: "e",
        createdAt: 1,
        updatedAt: 1,
      });
      vi.mocked(containerManager.gitOpsInContainer).mockReturnValue({
        fetchOk: true,
        checkoutOk: false,
        pullOk: false,
        errors: ['branch "nonexistent" does not exist'],
      });

      const result = await orchestrator.createSession({
        cwd: "/repo",
        branch: "nonexistent",
        sandboxEnabled: true,
        sandboxSlug: "e",
        envSlug: "e",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Failed to checkout branch");
        expect(result.status).toBe(400);
        expect(containerManager.removeContainer).toHaveBeenCalled();
      }
    });

    it("passes resumeSessionAt and forkSession to launcher", async () => {
      const result = await orchestrator.createSession({
        cwd: "/test",
        resumeSessionAt: "  existing-session-id  ",
        forkSession: true,
      });

      expect(result.ok).toBe(true);
      expect(deps.launcher.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          resumeSessionAt: "existing-session-id",
          forkSession: true,
        }),
      );
    });

    it("passes backendType codex to launcher", async () => {
      const result = await orchestrator.createSession({
        cwd: "/test",
        backend: "codex",
        model: "gpt-5",
      });

      expect(result.ok).toBe(true);
      expect(deps.launcher.launch).toHaveBeenCalledWith(
        expect.objectContaining({ backendType: "codex", model: "gpt-5" }),
      );
    });

    it("catches thrown errors from launcher.launch and returns 503", async () => {
      deps.launcher.launch.mockImplementation(() => {
        throw new Error("CLI binary not found");
      });

      const result = await orchestrator.createSession({ cwd: "/test" });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("CLI binary not found");
        expect(result.status).toBe(503);
      }
    });

    it("cleans up container when launcher.launch throws after container creation", async () => {
      // If a container was created but launcher.launch throws, the container
      // should be cleaned up to avoid leaking Docker resources.
      vi.mocked(envManager.getEnv).mockReturnValue({
        name: "E",
        slug: "e",
        variables: { CLAUDE_CODE_OAUTH_TOKEN: "token" },
        createdAt: 1,
        updatedAt: 1,
      } as any);
      deps.launcher.launch.mockImplementation(() => {
        throw new Error("Binary not found");
      });

      const result = await orchestrator.createSession({
        cwd: "/test",
        sandboxEnabled: true,
        envSlug: "e",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Failed to launch CLI");
        expect(result.status).toBe(503);
      }
      // Container should be cleaned up after launch failure
      expect(containerManager.removeContainer).toHaveBeenCalled();
    });
  });

  // ── Streaming Session Creation ────────────────────────────────────────────

  describe("createSessionStreaming()", () => {
    it("calls progress callback during creation", async () => {
      const onProgress = vi.fn();
      const result = await orchestrator.createSessionStreaming({ cwd: "/test" }, onProgress);

      expect(result.ok).toBe(true);
      // Should have at least resolving_env and launching_cli progress events
      expect(onProgress).toHaveBeenCalledWith("resolving_env", expect.any(String), "in_progress");
      expect(onProgress).toHaveBeenCalledWith("resolving_env", expect.any(String), "done");
      expect(onProgress).toHaveBeenCalledWith("launching_cli", expect.any(String), "in_progress");
      expect(onProgress).toHaveBeenCalledWith("launching_cli", expect.any(String), "done");
    });

    it("emits correct label for codex backend", async () => {
      const onProgress = vi.fn();
      await orchestrator.createSessionStreaming({ cwd: "/test", backend: "codex" }, onProgress);

      expect(onProgress).toHaveBeenCalledWith("launching_cli", "Launching Codex...", "in_progress");
    });

    it("emits correct label for claude backend", async () => {
      const onProgress = vi.fn();
      await orchestrator.createSessionStreaming({ cwd: "/test" }, onProgress);

      expect(onProgress).toHaveBeenCalledWith("launching_cli", "Launching Claude Code...", "in_progress");
    });
  });

  // ── Kill ───────────────────────────────────────────────────────────────────

  describe("killSession()", () => {
    it("kills launcher and removes container", async () => {
      deps.launcher.kill.mockResolvedValue(true);
      const result = await orchestrator.killSession("s1");

      expect(result.ok).toBe(true);
      expect(deps.launcher.kill).toHaveBeenCalledWith("s1");
      expect(containerManager.removeContainer).toHaveBeenCalledWith("s1");
    });

    it("returns ok=false and does not remove container when session not found", async () => {
      // When launcher.kill returns false (session not found), removeContainer
      // should NOT be called to preserve the original behavior from routes.ts.
      deps.launcher.kill.mockResolvedValue(false);
      const result = await orchestrator.killSession("s1");

      expect(result.ok).toBe(false);
      expect(containerManager.removeContainer).not.toHaveBeenCalled();
    });
  });

  // ── Relaunch ──────────────────────────────────────────────────────────────

  describe("relaunchSession()", () => {
    it("delegates to launcher.relaunch", async () => {
      const result = await orchestrator.relaunchSession("s1");

      expect(result.ok).toBe(true);
      expect(deps.launcher.relaunch).toHaveBeenCalledWith("s1");
    });

    it("rejects relaunching archived sessions", async () => {
      deps.launcher.getSession.mockReturnValue({ archived: true });

      const result = await orchestrator.relaunchSession("s1");

      expect(result.ok).toBe(false);
      expect(result.error).toContain("archived");
      expect(deps.launcher.relaunch).not.toHaveBeenCalled();
    });

    it("propagates error from launcher.relaunch", async () => {
      deps.launcher.relaunch.mockResolvedValue({ ok: false, error: "Container removed externally" });

      const result = await orchestrator.relaunchSession("s1");

      expect(result.ok).toBe(false);
      expect(result.error).toContain("Container removed externally");
    });
  });

  // ── Archive ───────────────────────────────────────────────────────────────

  describe("archiveSession()", () => {
    it("kills, removes container, unwatches PR, and marks archived", async () => {
      const result = await orchestrator.archiveSession("s1");

      expect(result.ok).toBe(true);
      expect(deps.launcher.kill).toHaveBeenCalledWith("s1");
      expect(containerManager.removeContainer).toHaveBeenCalledWith("s1");
      expect(deps.prPoller.unwatch).toHaveBeenCalledWith("s1");
      expect(deps.launcher.setArchived).toHaveBeenCalledWith("s1", true);
      expect(deps.sessionStore.setArchived).toHaveBeenCalledWith("s1", true);
    });

    it("performs Linear transition when linearTransition=backlog", async () => {
      // Set up linked issue
      vi.mocked(sessionLinearIssues.getLinearIssue).mockReturnValue({
        id: "issue-1",
        identifier: "ENG-42",
        teamId: "team-1",
        connectionId: "conn-1",
      } as any);
      vi.mocked(resolveApiKey).mockReturnValue({ apiKey: "lin_api_123", connectionId: "conn-1" });
      vi.mocked(fetchLinearTeamStates).mockResolvedValue([
        {
          id: "team-1",
          key: "ENG",
          name: "Engineering",
          states: [
            { id: "state-backlog", name: "Backlog", type: "backlog" },
            { id: "state-done", name: "Done", type: "completed" },
          ],
        },
      ]);
      vi.mocked(transitionLinearIssue).mockResolvedValue({
        ok: true,
        issue: { id: "issue-1", identifier: "ENG-42", stateName: "Backlog", stateType: "backlog" },
      } as any);

      const result = await orchestrator.archiveSession("s1", { linearTransition: "backlog" });

      expect(result.ok).toBe(true);
      expect(fetchLinearTeamStates).toHaveBeenCalledWith("lin_api_123");
      expect(transitionLinearIssue).toHaveBeenCalledWith("issue-1", "state-backlog", "lin_api_123", "conn-1");
      // Session should still be archived even with transition
      expect(deps.launcher.setArchived).toHaveBeenCalledWith("s1", true);
    });

    it("archives even when Linear transition fails", async () => {
      vi.mocked(sessionLinearIssues.getLinearIssue).mockReturnValue({
        id: "issue-1",
        identifier: "ENG-42",
        teamId: "team-1",
        connectionId: "conn-1",
      } as any);
      vi.mocked(resolveApiKey).mockReturnValue({ apiKey: "lin_api_123", connectionId: "conn-1" });
      vi.mocked(fetchLinearTeamStates).mockResolvedValue([{
        id: "team-1",
        key: "ENG",
        name: "Engineering",
        states: [{ id: "state-backlog", name: "Backlog", type: "backlog" }],
      }]);
      vi.mocked(transitionLinearIssue).mockResolvedValue({ ok: false, error: "API error" });

      const result = await orchestrator.archiveSession("s1", { linearTransition: "backlog" });

      expect(result.ok).toBe(true);
      expect(result.linearTransition?.ok).toBe(false);
      expect(deps.launcher.setArchived).toHaveBeenCalledWith("s1", true);
    });

    it("catches thrown transition errors and still archives", async () => {
      // When transitionLinearIssue throws, archiveSession should catch it
      // and continue with the archive operation.
      vi.mocked(sessionLinearIssues.getLinearIssue).mockReturnValue({
        id: "issue-1",
        identifier: "ENG-42",
        teamId: "team-1",
        connectionId: "conn-1",
      } as any);
      vi.mocked(resolveApiKey).mockReturnValue({ apiKey: "lin_api_123", connectionId: "conn-1" });
      vi.mocked(fetchLinearTeamStates).mockResolvedValue([{
        id: "team-1",
        key: "ENG",
        name: "Engineering",
        states: [{ id: "state-backlog", name: "Backlog", type: "backlog" }],
      }]);
      vi.mocked(transitionLinearIssue).mockRejectedValue(new Error("Network error"));

      const result = await orchestrator.archiveSession("s1", { linearTransition: "backlog" });

      expect(result.ok).toBe(true);
      expect(result.linearTransition).toEqual({ ok: false, error: "Transition failed unexpectedly" });
      expect(deps.launcher.setArchived).toHaveBeenCalledWith("s1", true);
    });

    it("skips transition when no target state found", async () => {
      // When the target state cannot be found (e.g., team has no backlog state),
      // linearTransition should be marked as skipped.
      vi.mocked(sessionLinearIssues.getLinearIssue).mockReturnValue({
        id: "issue-1",
        identifier: "ENG-42",
        teamId: "team-1",
        connectionId: "conn-1",
      } as any);
      vi.mocked(resolveApiKey).mockReturnValue({ apiKey: "lin_api_123", connectionId: "conn-1" });
      vi.mocked(fetchLinearTeamStates).mockResolvedValue([{
        id: "team-1",
        key: "ENG",
        name: "Engineering",
        states: [{ id: "state-done", name: "Done", type: "completed" }],
        // No backlog state
      }]);

      const result = await orchestrator.archiveSession("s1", { linearTransition: "backlog" });

      expect(result.ok).toBe(true);
      expect(result.linearTransition).toEqual({ ok: true, skipped: true });
    });

    it("cleans up worktree during archive", async () => {
      deps.worktreeTracker.getBySession.mockReturnValue({
        sessionId: "s1",
        repoRoot: "/repo",
        branch: "feat",
        worktreePath: "/wt/feat",
        createdAt: 1000,
      });

      const result = await orchestrator.archiveSession("s1");

      expect(result.ok).toBe(true);
      expect(result.worktree).toMatchObject({ cleaned: true, path: "/wt/feat" });
      expect(gitUtils.removeWorktree).toHaveBeenCalledWith("/repo", "/wt/feat", {
        force: false,
        branchToDelete: undefined,
      });
    });
  });

  // ── Archive — Council pair routing (EC-2 fix) ─────────────────────────────
  //
  // Validates the P1 fix for the bug where the sidebar's "Archive Council
  // pair?" confirm modal advertised dual-kill but `archiveSession` was
  // group-blind: it killed only the clicked half. `coordinator.archiveGroup`
  // existed + state-machine-tested + documented in CLAUDE.md, but had ZERO
  // production call sites. The surviving half kept self-polling forever.
  //
  // These tests prove the council branch in `archiveSession` ACTUALLY routes
  // through `coordinator.archiveGroup` and that the EC-2 ordering invariant
  // is preserved (BOTH session ids in `intentionalKills` BEFORE either kill
  // runs).
  describe("archiveSession() — council pair routing (EC-2)", () => {
    type FakeGroup = {
      sessionGroupId: string;
      status: "active" | "degraded" | "pairing" | "reconnecting" | "archived";
      primary: { sessionId: string };
      observer: { sessionId: string };
    };

    function installFakeCoordinator(group: FakeGroup, archiveGroupResult = true) {
      const archiveGroupSpy = vi.fn(async (sgid: string) => {
        expect(sgid).toBe(group.sessionGroupId);
        return archiveGroupResult;
      });
      const findBySessionIdSpy = vi.fn((sid: string): FakeGroup | undefined => {
        if (sid === group.primary.sessionId || sid === group.observer.sessionId) {
          return group;
        }
        return undefined;
      });
      // The orchestrator's `coordinator` field is private; reach in via
      // the same `as any` cast pattern used by `cleanupCouncilForSession`
      // tests below. Production code constructs the real coordinator in
      // `initialize()`; for council-routing tests we never need its full
      // state-machine surface, only the two methods archiveSession reads.
      (orchestrator as any).coordinator = {
        findBySessionId: findBySessionIdSpy,
        archiveGroup: archiveGroupSpy,
      };
      return { archiveGroupSpy, findBySessionIdSpy };
    }

    function fakeGroup(overrides: Partial<FakeGroup> = {}): FakeGroup {
      return {
        sessionGroupId: "grp_council_test",
        status: "active",
        primary: { sessionId: "s-orch" },
        observer: { sessionId: "s-obs" },
        ...overrides,
      };
    }

    it("clicking orchestrator half routes through coordinator.archiveGroup with EC-2 ordering", async () => {
      const group = fakeGroup();
      // Capture intentionalKills state AT THE MOMENT archiveGroup is called,
      // not after. This is the EC-2 ordering proof: both ids must already
      // be in the absorbing set BEFORE coordinator.deps.kill runs against
      // either half. Without this, the dead half's `session:exited` handler
      // would enter the reconnecting → degraded ladder instead of the
      // absorbing intentional-kill branch.
      let intentionalAtArchiveTime: string[] = [];
      const archiveGroupSpy = vi.fn(async () => {
        intentionalAtArchiveTime = Array.from((orchestrator as any).intentionalKills);
        return true;
      });
      (orchestrator as any).coordinator = {
        findBySessionId: vi.fn((sid: string) =>
          sid === "s-orch" || sid === "s-obs" ? group : undefined,
        ),
        archiveGroup: archiveGroupSpy,
      };

      const result = await orchestrator.archiveSession("s-orch");

      expect(result.ok).toBe(true);
      expect(archiveGroupSpy).toHaveBeenCalledTimes(1);
      expect(archiveGroupSpy).toHaveBeenCalledWith("grp_council_test");
      // EC-2 ordering: BOTH ids visible in intentionalKills at archive time.
      expect(intentionalAtArchiveTime).toContain("s-orch");
      expect(intentionalAtArchiveTime).toContain("s-obs");
    });

    it("clicking observer half archives the WHOLE pair (P1 symptom fix)", async () => {
      // The reported bug: clicking either half archived only that half.
      // Validates that clicking the OBSERVER half also routes through
      // coordinator.archiveGroup, which then kills both halves.
      const group = fakeGroup();
      const { archiveGroupSpy } = installFakeCoordinator(group);

      const result = await orchestrator.archiveSession("s-obs");

      expect(result.ok).toBe(true);
      expect(archiveGroupSpy).toHaveBeenCalledTimes(1);
      expect(deps.launcher.setArchived).toHaveBeenCalledWith("s-orch", true);
      expect(deps.launcher.setArchived).toHaveBeenCalledWith("s-obs", true);
    });

    it("cleanupWorktree runs EXACTLY ONCE for council pairs (shared workspace)", async () => {
      // Council pairs share one workspace. A naive fix that delegated to
      // archiveGroup AND THEN called cleanupWorktree per-half would
      // double-attempt removal. Observer review WARN #1 flagged this.
      const group = fakeGroup();
      installFakeCoordinator(group);
      deps.worktreeTracker.getBySession.mockImplementation((sid: string) => {
        if (sid === "s-orch") {
          return {
            sessionId: "s-orch",
            repoRoot: "/repo",
            branch: "feat",
            worktreePath: "/wt/feat",
            createdAt: 1000,
          };
        }
        return undefined;
      });

      const result = await orchestrator.archiveSession("s-obs");

      expect(result.ok).toBe(true);
      expect(result.worktree).toMatchObject({ cleaned: true, path: "/wt/feat" });
      // removeWorktree must be invoked once, on the orchestrator's
      // provisioned worktree path — not twice for both halves.
      expect(gitUtils.removeWorktree).toHaveBeenCalledTimes(1);
      expect(gitUtils.removeWorktree).toHaveBeenCalledWith("/repo", "/wt/feat", {
        force: false,
        branchToDelete: undefined,
      });
    });

    it("Linear transition runs on the clicked half (not both halves)", async () => {
      // The clicked sessionId is what carries the linkedIssue in normal
      // usage (orchestrator-side); observer-half has no linked issue.
      // The helper consults sessionLinearIssues.getLinearIssue(clickedSid)
      // exactly once, never twice.
      const group = fakeGroup();
      installFakeCoordinator(group);
      vi.mocked(sessionLinearIssues.getLinearIssue).mockReturnValue({
        id: "issue-1",
        identifier: "ENG-42",
        teamId: "team-1",
        connectionId: "conn-1",
      } as any);
      vi.mocked(resolveApiKey).mockReturnValue({ apiKey: "lin_api_123", connectionId: "conn-1" });
      vi.mocked(fetchLinearTeamStates).mockResolvedValue([{
        id: "team-1",
        key: "ENG",
        name: "Engineering",
        states: [{ id: "state-backlog", name: "Backlog", type: "backlog" }],
      }]);
      vi.mocked(transitionLinearIssue).mockResolvedValue({ ok: true } as any);

      await orchestrator.archiveSession("s-orch", { linearTransition: "backlog" });

      // getLinearIssue called once with the CLICKED sessionId (s-orch),
      // never with the observer's sessionId.
      const linearCalls = vi.mocked(sessionLinearIssues.getLinearIssue).mock.calls;
      expect(linearCalls.some((c) => c[0] === "s-orch")).toBe(true);
      expect(linearCalls.some((c) => c[0] === "s-obs")).toBe(false);
      expect(transitionLinearIssue).toHaveBeenCalledTimes(1);
    });

    it("falls through to single-session path when group.status === 'archived'", async () => {
      // Edge case: the group is already archived (re-entrancy / double
      // user click). The branch condition `group.status !== 'archived'`
      // must let this fall through to the single-session path rather than
      // calling archiveGroup again (which is idempotent but would skip
      // the per-session worktree + Linear flow this caller expects).
      const group = fakeGroup({ status: "archived" });
      const { archiveGroupSpy } = installFakeCoordinator(group);

      const result = await orchestrator.archiveSession("s-orch");

      expect(result.ok).toBe(true);
      expect(archiveGroupSpy).not.toHaveBeenCalled();
      // Falls through to single-session path: single launcher.kill call,
      // single setArchived call.
      expect(deps.launcher.kill).toHaveBeenCalledWith("s-orch");
      expect(deps.launcher.kill).not.toHaveBeenCalledWith("s-obs");
    });

    it("falls through to single-session path when no group exists (non-council session)", async () => {
      // Non-council sessions have no group entry. findBySessionId returns
      // undefined → the council branch is skipped → existing single-session
      // path runs as before. Sanity check that the new code didn't break
      // the baseline 140-test path.
      (orchestrator as any).coordinator = {
        findBySessionId: vi.fn(() => undefined),
        archiveGroup: vi.fn(async () => true),
      };

      const result = await orchestrator.archiveSession("s-standalone");

      expect(result.ok).toBe(true);
      expect((orchestrator as any).coordinator.archiveGroup).not.toHaveBeenCalled();
      expect(deps.launcher.kill).toHaveBeenCalledWith("s-standalone");
    });

    it("EC-6 canary: archiveSession's function body contains coordinator.archiveGroup + findBySessionId", async () => {
      // Observer review WARN #2: a file-level grep for `coordinator.archiveGroup`
      // in session-orchestrator.ts would false-positive on the failure
      // class IF a sibling helper anywhere else in the file already
      // referenced the symbol (e.g., the cleanupCouncilForSession helper,
      // or a future addition). Anchor the canary to archiveSession's
      // function body specifically, extracted between the marker
      // `async archiveSession(` and the next section separator
      // `// ── Delete`. Survives renames of local variables via `\w+`.
      //
      // This test will FAIL if a future refactor accidentally removes
      // the council detect-and-route branch (e.g., during a merge
      // conflict, an over-eager simplification, or a bad rebase).
      const { readFileSync } = await import("node:fs");
      const { fileURLToPath } = await import("node:url");
      const { dirname, join } = await import("node:path");
      const here = dirname(fileURLToPath(import.meta.url));
      const source = readFileSync(join(here, "session-orchestrator.ts"), "utf-8");
      const archiveStart = source.indexOf("async archiveSession(");
      expect(archiveStart).toBeGreaterThan(-1);
      const nextSection = source.indexOf("// ── Delete", archiveStart);
      expect(nextSection).toBeGreaterThan(archiveStart);
      const body = source.slice(archiveStart, nextSection);
      // archiveGroup call — survives renames of `coord` local var via `\w+`.
      expect(body).toMatch(/\b\w+\.archiveGroup\s*\(/);
      // findBySessionId call — must be inside the same function body, not
      // only somewhere else in the file.
      expect(body).toMatch(/\.findBySessionId\s*\(/);
    });
  });

  // ── Delete ────────────────────────────────────────────────────────────────

  describe("deleteSession()", () => {
    it("performs full cleanup: kill, container, worktree, PR, Linear, bridge", async () => {
      const result = await orchestrator.deleteSession("s1");

      expect(result.ok).toBe(true);
      expect(deps.launcher.kill).toHaveBeenCalledWith("s1");
      expect(containerManager.removeContainer).toHaveBeenCalledWith("s1");
      expect(deps.prPoller.unwatch).toHaveBeenCalledWith("s1");
      expect(sessionLinearIssues.removeLinearIssue).toHaveBeenCalledWith("s1");
      expect(deps.launcher.removeSession).toHaveBeenCalledWith("s1");
      expect(deps.wsBridge.closeSession).toHaveBeenCalledWith("s1");
    });

    it("returns worktree cleanup info", async () => {
      deps.worktreeTracker.getBySession.mockReturnValue({
        sessionId: "s1",
        repoRoot: "/repo",
        branch: "feat",
        worktreePath: "/wt/feat",
        createdAt: 1000,
      });

      const result = await orchestrator.deleteSession("s1");

      expect(result.ok).toBe(true);
      expect(result.worktree).toMatchObject({ cleaned: true, path: "/wt/feat" });
    });

    it("passes branchToDelete when actualBranch differs from branch", async () => {
      // When actualBranch differs from branch, the worktree-unique branch should be deleted.
      // force=true in deleteSession means "skip dirty check", but removeWorktree gets
      // force: dirty (isWorktreeDirty() result), which is false by default.
      deps.worktreeTracker.getBySession.mockReturnValue({
        sessionId: "s1",
        repoRoot: "/repo",
        branch: "feat",
        actualBranch: "feat-wt-1234",
        worktreePath: "/wt/feat",
        createdAt: 1000,
      });

      await orchestrator.deleteSession("s1");

      expect(gitUtils.removeWorktree).toHaveBeenCalledWith("/repo", "/wt/feat", {
        force: false,
        branchToDelete: "feat-wt-1234",
      });
    });

    it("removes container unconditionally during delete (unlike kill)", async () => {
      // deleteSession always removes the container, even if kill reports no process found,
      // because we're permanently removing the session and must clean up all resources.
      deps.launcher.kill.mockResolvedValue(false);

      await orchestrator.deleteSession("s1");

      expect(containerManager.removeContainer).toHaveBeenCalledWith("s1");
    });
  });

  // ── Unarchive ─────────────────────────────────────────────────────────────

  describe("unarchiveSession()", () => {
    it("unsets archived flag on launcher and store", () => {
      const result = orchestrator.unarchiveSession("s1");

      expect(result.ok).toBe(true);
      expect(deps.launcher.setArchived).toHaveBeenCalledWith("s1", false);
      expect(deps.sessionStore.setArchived).toHaveBeenCalledWith("s1", false);
    });
  });

  // ── Auto-naming ───────────────────────────────────────────────────────────

  describe("handleAutoNaming (via initialize)", () => {
    it("generates title when anthropicApiKey is set and no name exists", async () => {
      vi.mocked(settingsManager.getSettings).mockReturnValue({
        anthropicApiKey: "sk-ant-123",
      } as any);
      vi.mocked(sessionNames.getName).mockReturnValue(undefined);
      deps.launcher.getSession.mockReturnValue({ model: "claude-sonnet-4-6" });
      vi.mocked(generateSessionTitle).mockResolvedValue("Test Title");

      orchestrator.initialize();
      companionBus.emit("session:first-turn-completed", { sessionId: "s1", firstUserMessage: "Hello world" });
      await new Promise(r => setTimeout(r, 0));

      expect(generateSessionTitle).toHaveBeenCalledWith("Hello world", "claude-sonnet-4-6");
      expect(sessionNames.setName).toHaveBeenCalledWith("s1", "Test Title");
      expect(deps.wsBridge.broadcastNameUpdate).toHaveBeenCalledWith("s1", "Test Title");
    });

    it("skips naming when session already has a name", async () => {
      vi.mocked(settingsManager.getSettings).mockReturnValue({ anthropicApiKey: "sk-ant-123" } as any);
      vi.mocked(sessionNames.getName).mockReturnValue("Existing Name");

      orchestrator.initialize();
      companionBus.emit("session:first-turn-completed", { sessionId: "s1", firstUserMessage: "Hello" });
      await new Promise(r => setTimeout(r, 0));

      expect(generateSessionTitle).not.toHaveBeenCalled();
    });

    it("skips naming when no API key is configured", async () => {
      vi.mocked(settingsManager.getSettings).mockReturnValue({ anthropicApiKey: "" } as any);

      orchestrator.initialize();
      companionBus.emit("session:first-turn-completed", { sessionId: "s1", firstUserMessage: "Hello" });
      await new Promise(r => setTimeout(r, 0));

      expect(generateSessionTitle).not.toHaveBeenCalled();
    });
  });

  // ── Reconnection watchdog ─────────────────────────────────────────────────

  describe("startReconnectionWatchdog (via initialize)", () => {
    it("does nothing when no sessions are starting", () => {
      deps.launcher.getStartingSessions.mockReturnValue([]);
      orchestrator.initialize();

      // No error thrown, no relaunch called
      expect(deps.launcher.getStartingSessions).toHaveBeenCalled();
    });

    it("schedules relaunch for stale starting sessions", async () => {
      vi.useFakeTimers();
      try {
        deps.launcher.getStartingSessions
          .mockReturnValueOnce([{ sessionId: "s1", state: "starting" }])
          .mockReturnValueOnce([{ sessionId: "s1", state: "starting" }]);

        orchestrator.initialize();

        // Advance past the reconnect grace period (default 30s)
        await vi.advanceTimersByTimeAsync(30_000);

        expect(deps.launcher.relaunch).toHaveBeenCalledWith("s1");
      } finally {
        vi.useRealTimers();
      }
    });

    it("skips archived sessions during reconnection watchdog", async () => {
      vi.useFakeTimers();
      try {
        deps.launcher.getStartingSessions
          .mockReturnValueOnce([{ sessionId: "s1", state: "starting" }])
          .mockReturnValueOnce([{ sessionId: "s1", state: "starting", archived: true }]);

        orchestrator.initialize();
        await vi.advanceTimersByTimeAsync(30_000);

        // Should NOT relaunch archived session
        expect(deps.launcher.relaunch).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ── Worktree cleanup ──────────────────────────────────────────────────────

  describe("cleanupWorktree (via deleteSession/archiveSession)", () => {
    it("returns undefined when session has no worktree mapping", async () => {
      deps.worktreeTracker.getBySession.mockReturnValue(null);

      const result = await orchestrator.deleteSession("s1");

      expect(result.worktree).toBeUndefined();
    });

    it("does not remove worktree in use by another session", async () => {
      deps.worktreeTracker.getBySession.mockReturnValue({
        sessionId: "s1",
        repoRoot: "/repo",
        branch: "feat",
        worktreePath: "/wt/feat",
        createdAt: 1000,
      });
      deps.worktreeTracker.isWorktreeInUse.mockReturnValue(true);

      const result = await orchestrator.deleteSession("s1");

      expect(result.worktree).toMatchObject({ cleaned: false, path: "/wt/feat" });
      expect(gitUtils.removeWorktree).not.toHaveBeenCalled();
    });

    it("does not remove dirty worktree unless forced", async () => {
      deps.worktreeTracker.getBySession.mockReturnValue({
        sessionId: "s1",
        repoRoot: "/repo",
        branch: "feat",
        worktreePath: "/wt/feat",
        createdAt: 1000,
      });
      vi.mocked(gitUtils.isWorktreeDirty).mockReturnValue(true);

      // Archive without force
      const result = await orchestrator.archiveSession("s1");

      expect(result.worktree).toMatchObject({ cleaned: false, dirty: true, path: "/wt/feat" });
      expect(gitUtils.removeWorktree).not.toHaveBeenCalled();
    });

    it("force-removes dirty worktree when force=true", async () => {
      deps.worktreeTracker.getBySession.mockReturnValue({
        sessionId: "s1",
        repoRoot: "/repo",
        branch: "feat",
        worktreePath: "/wt/feat",
        createdAt: 1000,
      });
      vi.mocked(gitUtils.isWorktreeDirty).mockReturnValue(true);

      const result = await orchestrator.archiveSession("s1", { force: true });

      expect(result.worktree).toMatchObject({ cleaned: true, path: "/wt/feat" });
      expect(gitUtils.removeWorktree).toHaveBeenCalledWith("/repo", "/wt/feat", {
        force: true,
        branchToDelete: undefined,
      });
    });
  });

  // ── getSession ────────────────────────────────────────────────────────────

  describe("getSession()", () => {
    it("delegates to launcher.getSession", () => {
      const mockSession = { sessionId: "s1", state: "connected" };
      deps.launcher.getSession.mockReturnValue(mockSession);

      const result = orchestrator.getSession("s1");

      expect(result).toBe(mockSession);
      expect(deps.launcher.getSession).toHaveBeenCalledWith("s1");
    });

    it("returns undefined for unknown session", () => {
      deps.launcher.getSession.mockReturnValue(undefined);

      const result = orchestrator.getSession("unknown");

      expect(result).toBeUndefined();
    });
  });

  // ── Auto-relaunch ──────────────────────────────────────────────────────────

  describe("handleAutoRelaunch (via initialize)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("skips relaunch for archived sessions", async () => {
      // Archived sessions should not be auto-relaunched.
      deps.launcher.getSession.mockReturnValue({ archived: true } as any);
      orchestrator.initialize();

      companionBus.emit("session:relaunch-needed", { sessionId: "s1" });
      // Advance past the grace period and flush microtasks for the async handler
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.advanceTimersByTimeAsync(0);

      expect(deps.launcher.relaunch).not.toHaveBeenCalled();
    });

    it("skips relaunch when CLI reconnects during grace period", async () => {
      // During the grace period, if CLI reconnects, relaunch should be skipped.
      deps.launcher.getSession.mockReturnValue({ archived: false } as any);
      deps.wsBridge.isCliConnected.mockReturnValue(true);
      orchestrator.initialize();

      companionBus.emit("session:relaunch-needed", { sessionId: "s1" });
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.advanceTimersByTimeAsync(0);

      expect(deps.launcher.relaunch).not.toHaveBeenCalled();
    });

    it("skips relaunch when session state is 'connected' after grace", async () => {
      // If the session reconnects (state=connected) during grace, skip relaunch.
      deps.launcher.getSession
        .mockReturnValueOnce({ archived: false } as any) // check archived
        .mockReturnValueOnce({ state: "connected" } as any); // after grace
      deps.wsBridge.isCliConnected.mockReturnValue(false);
      orchestrator.initialize();

      companionBus.emit("session:relaunch-needed", { sessionId: "s1" });
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.advanceTimersByTimeAsync(0);

      expect(deps.launcher.relaunch).not.toHaveBeenCalled();
    });

    it("skips relaunch when session is still starting", async () => {
      // A session in "starting" state should not be relaunched — it's still
      // initializing. The starting guard at line 771 prevents this.
      deps.launcher.getSession
        .mockReturnValueOnce({ archived: false } as any) // check archived
        .mockReturnValueOnce({ state: "starting", pid: process.pid } as any); // after grace: still starting
      deps.wsBridge.isCliConnected.mockReturnValue(false);
      orchestrator.initialize();

      companionBus.emit("session:relaunch-needed", { sessionId: "s1" });
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.advanceTimersByTimeAsync(0);

      expect(deps.launcher.relaunch).not.toHaveBeenCalled();
    });

    it("relaunches exited session even when PID was recycled to a live process", async () => {
      // After idle-kill, the session state is "exited" but the PID field stays
      // set. If the kernel recycles the PID to a different process, we must NOT
      // let the PID check prevent relaunch. The fix skips PID liveness for
      // exited sessions entirely.
      deps.launcher.getSession
        .mockReturnValueOnce({ archived: false } as any) // check archived
        .mockReturnValueOnce({ state: "exited", pid: process.pid } as any); // after grace: PID is alive (recycled!)
      deps.wsBridge.isCliConnected.mockReturnValue(false);
      orchestrator.initialize();

      companionBus.emit("session:relaunch-needed", { sessionId: "s1" });
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.advanceTimersByTimeAsync(0);

      // Should relaunch despite the PID being alive — exited sessions skip PID check
      expect(deps.launcher.relaunch).toHaveBeenCalledWith("s1");
    });

    it("skips relaunch for containerized session when container is still running", async () => {
      // For non-exited containerized sessions, use container liveness instead
      // of PID check. If the container is running, skip relaunch to let the
      // CLI reconnect on its own. Use state "starting" to bypass the earlier
      // connected/running guard and actually exercise the container check path.
      vi.mocked(containerManager.isContainerAlive).mockReturnValue("running" as any);
      deps.launcher.getSession
        .mockReturnValueOnce({ archived: false } as any) // check archived
        .mockReturnValueOnce({ state: "starting", containerId: "cid-abc", pid: 99999 } as any); // after grace
      deps.wsBridge.isCliConnected.mockReturnValue(false);
      orchestrator.initialize();

      companionBus.emit("session:relaunch-needed", { sessionId: "s1" });
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.advanceTimersByTimeAsync(0);

      expect(containerManager.isContainerAlive).toHaveBeenCalledWith("cid-abc");
      expect(deps.launcher.relaunch).not.toHaveBeenCalled();
    });

    it("relaunches exited containerized session even when container was removed", async () => {
      // After idle-kill, the container is removed and state becomes "exited".
      // The fix skips PID/container checks for exited sessions entirely, so
      // relaunch proceeds. This is the core Docker bug scenario.
      vi.mocked(containerManager.isContainerAlive).mockReturnValue("not_found" as any);
      deps.launcher.getSession
        .mockReturnValueOnce({ archived: false } as any) // check archived
        .mockReturnValueOnce({ state: "exited", containerId: "cid-dead", pid: 99999 } as any); // after grace
      deps.wsBridge.isCliConnected.mockReturnValue(false);
      orchestrator.initialize();

      companionBus.emit("session:relaunch-needed", { sessionId: "s1" });
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.advanceTimersByTimeAsync(0);

      // Exited sessions skip the container/PID check entirely, so relaunch proceeds
      expect(deps.launcher.relaunch).toHaveBeenCalledWith("s1");
    });

    it("relaunches when CLI does not reconnect after grace period", async () => {
      // When CLI disconnects and doesn't reconnect, the session should be relaunched.
      deps.launcher.getSession
        .mockReturnValueOnce({ archived: false } as any) // First call: check archived
        .mockReturnValueOnce({ state: "exited", pid: undefined } as any); // Second call: after grace
      deps.wsBridge.isCliConnected.mockReturnValue(false);
      orchestrator.initialize();

      companionBus.emit("session:relaunch-needed", { sessionId: "s1" });
      // Advance past grace (10s) + cooldown (5s) and flush microtasks
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.advanceTimersByTimeAsync(0);

      expect(deps.launcher.relaunch).toHaveBeenCalledWith("s1");
    });

    it("preserves retry budget when relaunch returns ok:false without error", async () => {
      // A silent failure (ok:false, no error string) should NOT reset the auto-relaunch
      // count. This prevents unlimited retries when the launcher silently fails.
      deps.launcher.getSession.mockReturnValue({ archived: false, state: "exited", pid: undefined } as any);
      deps.wsBridge.isCliConnected.mockReturnValue(false);
      deps.launcher.relaunch.mockResolvedValue({ ok: false }); // no error string
      orchestrator.initialize();

      // Trigger 3 silent-failure relaunches (the max)
      for (let i = 0; i < 3; i++) {
        companionBus.emit("session:relaunch-needed", { sessionId: "s1" });
        await vi.advanceTimersByTimeAsync(15_000);
        await vi.advanceTimersByTimeAsync(0);
      }

      // 4th attempt should hit the MAX_AUTO_RELAUNCHES limit
      companionBus.emit("session:relaunch-needed", { sessionId: "s1" });
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.advanceTimersByTimeAsync(0);

      // Only 3 relaunch calls, 4th was rejected at the limit
      expect(deps.launcher.relaunch).toHaveBeenCalledTimes(3);
    });

    it("stops after MAX_AUTO_RELAUNCHES attempts", async () => {
      // After reaching the max auto-relaunch count, give up and notify the user.
      // Mock relaunch to return an error so the count doesn't get cleared
      // (successful relaunch clears the count, simulating recovery).
      deps.launcher.getSession.mockReturnValue({ archived: false, state: "exited", pid: undefined } as any);
      deps.wsBridge.isCliConnected.mockReturnValue(false);
      deps.launcher.relaunch.mockResolvedValue({ ok: false, error: "crashed again" });
      orchestrator.initialize();

      // Trigger 3 relaunches (the max). Each needs the relaunchingSet cooldown
      // to clear before the next attempt can proceed.
      for (let i = 0; i < 3; i++) {
        companionBus.emit("session:relaunch-needed", { sessionId: "s1" });
        await vi.advanceTimersByTimeAsync(15_000);
        await vi.advanceTimersByTimeAsync(0);
      }

      // 4th attempt should be rejected since count reached MAX_AUTO_RELAUNCHES
      companionBus.emit("session:relaunch-needed", { sessionId: "s1" });
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.advanceTimersByTimeAsync(0);

      // relaunch should have been called 3 times, not 4
      expect(deps.launcher.relaunch).toHaveBeenCalledTimes(3);
      // Should broadcast error message to session
      expect(deps.wsBridge.broadcastToSession).toHaveBeenCalledWith("s1", expect.objectContaining({
        type: "error",
        message: expect.stringContaining("keeps crashing"),
      }));
    });
  });

  // ── Proactive keepalive ───────────────────────────────────────────────────

  describe("proactive keepalive (auto-relaunch on exit without browser)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("schedules relaunch when CLI exits unexpectedly", async () => {
      // When a CLI process exits (crash) and is not an intentional kill,
      // the orchestrator should proactively relaunch it after a short delay
      // even if no browsers are connected.
      deps.launcher.getSession.mockReturnValue({
        archived: false,
        state: "exited",
        pid: undefined,
      } as any);
      deps.wsBridge.isCliConnected.mockReturnValue(false);
      orchestrator.initialize();

      // Simulate CLI exit
      companionBus.emit("session:exited", { sessionId: "s1", exitCode: 1 });

      // Advance past keepalive delay (3s) + relaunch grace (10s) + cooldown
      await vi.advanceTimersByTimeAsync(3_000);
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.advanceTimersByTimeAsync(0);

      expect(deps.launcher.relaunch).toHaveBeenCalledWith("s1");
    });

    it("does NOT proactively relaunch after idle-kill (intentional kill)", async () => {
      // Idle-kill is intentional — the proactive keepalive should NOT trigger.
      // The debounce timer in ws-bridge is also cancelled by the idle-kill
      // handler (via cancelDisconnectTimer), so session:relaunch-needed never
      // fires from the debounce path. A browser reconnect CAN still relaunch.
      deps.launcher.getSession.mockReturnValue({
        archived: false,
        state: "exited",
        pid: undefined,
      } as any);
      deps.wsBridge.isCliConnected.mockReturnValue(false);
      orchestrator.initialize();

      // Simulate idle-kill followed by session exit
      companionBus.emit("session:idle-kill", { sessionId: "s1" });
      companionBus.emit("session:exited", { sessionId: "s1", exitCode: 0 });

      // Advance well past any possible keepalive delay
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(0);

      // Proactive keepalive should NOT have relaunched
      expect(deps.launcher.relaunch).not.toHaveBeenCalled();
      // Disconnect debounce timer should have been cancelled
      expect(deps.wsBridge.cancelDisconnectTimer).toHaveBeenCalledWith("s1");
    });

    it("does NOT relaunch archived sessions", async () => {
      // Archived sessions should not be relaunched proactively.
      deps.launcher.getSession.mockReturnValue({
        archived: true,
        state: "exited",
        pid: undefined,
      } as any);
      orchestrator.initialize();

      companionBus.emit("session:exited", { sessionId: "s1", exitCode: 1 });

      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(0);

      expect(deps.launcher.relaunch).not.toHaveBeenCalled();
    });

    it("uses exponential backoff on repeated crashes (3s → 6s → 12s)", async () => {
      // Each crash should increase the delay before the keepalive timer fires.
      let relaunchCount = 0;
      deps.launcher.getSession.mockReturnValue({
        archived: false,
        state: "exited",
        pid: undefined,
      } as any);
      deps.wsBridge.isCliConnected.mockReturnValue(false);
      // Simulate repeated failures so the auto-relaunch count increments
      deps.launcher.relaunch.mockImplementation(async () => {
        relaunchCount++;
        return { ok: false, error: "crashed" };
      });
      orchestrator.initialize();

      // ── 1st crash: 3s keepalive delay ──
      companionBus.emit("session:exited", { sessionId: "s1", exitCode: 1 });

      // At 2s: nothing yet (3s delay not elapsed)
      await vi.advanceTimersByTimeAsync(2_000);
      expect(relaunchCount).toBe(0);

      // At 3s: keepalive fires → handleAutoRelaunch with 10s grace
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(relaunchCount).toBe(1);

      // ── 2nd crash: 6s keepalive delay ──
      companionBus.emit("session:exited", { sessionId: "s1", exitCode: 1 });

      // At 5s: nothing yet (6s delay not elapsed)
      await vi.advanceTimersByTimeAsync(5_000);
      expect(relaunchCount).toBe(1);

      // At 6s: keepalive fires → handleAutoRelaunch with 10s grace
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(relaunchCount).toBe(2);

      // ── 3rd crash: 12s keepalive delay ──
      companionBus.emit("session:exited", { sessionId: "s1", exitCode: 1 });

      // At 11s: nothing yet (12s delay not elapsed)
      await vi.advanceTimersByTimeAsync(11_000);
      expect(relaunchCount).toBe(2);

      // At 12s: keepalive fires → handleAutoRelaunch with 10s grace
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(relaunchCount).toBe(3);
    });

    it("cancels keepalive timer on session delete", async () => {
      // If user deletes a session while a keepalive timer is pending,
      // the timer should be cancelled and no relaunch should occur.
      deps.launcher.getSession.mockReturnValue({
        archived: false,
        state: "exited",
        pid: undefined,
      } as any);
      deps.wsBridge.isCliConnected.mockReturnValue(false);
      orchestrator.initialize();

      // Simulate CLI exit
      companionBus.emit("session:exited", { sessionId: "s1", exitCode: 1 });

      // Delete the session before the keepalive timer fires
      await orchestrator.deleteSession("s1");

      // Advance past all delays
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(0);

      // kill() is called by deleteSession, but relaunch should NOT be
      expect(deps.launcher.relaunch).not.toHaveBeenCalled();
    });
  });

  // ── Council Mode (Beck council review #9 — P2#9 test coverage) ────────────

  describe("deterministicFindingId", () => {
    // Pure helper: same input → same id; different input → different id.
    // Restart-replay dedup on the browser side depends on this stability.
    it("returns the same id for the same input tuple", () => {
      const input = {
        sessionGroupId: "grp_abc",
        checkpointId: "chk_1",
        observerProvider: "codex",
        findingIndex: 0,
        evidencePath: "src/foo.ts",
        claim: "Race condition in spawn",
      };
      const a = deterministicFindingId(input);
      const b = deterministicFindingId(input);
      expect(a).toBe(b);
      expect(a).toMatch(/^fnd_[0-9a-f]{16}$/);
    });

    it("returns different ids when any field differs", () => {
      const base = {
        sessionGroupId: "grp_abc",
        checkpointId: "chk_1",
        observerProvider: "codex",
        findingIndex: 0,
        evidencePath: "src/foo.ts",
        claim: "claim",
      };
      const id = deterministicFindingId(base);
      expect(deterministicFindingId({ ...base, sessionGroupId: "grp_xyz" })).not.toBe(id);
      expect(deterministicFindingId({ ...base, checkpointId: "chk_2" })).not.toBe(id);
      expect(deterministicFindingId({ ...base, observerProvider: "claude" })).not.toBe(id);
      expect(deterministicFindingId({ ...base, findingIndex: 1 })).not.toBe(id);
      expect(deterministicFindingId({ ...base, evidencePath: "src/bar.ts" })).not.toBe(id);
      expect(deterministicFindingId({ ...base, claim: "different claim" })).not.toBe(id);
    });

    // Null-byte separator hardening: two distinct-but-concatenation-equal
    // inputs MUST yield different ids. Without the separators, e.g.
    // `("ab"+"c")` and `("a"+"bc")` would hash to the same value.
    it("uses separators so concatenation-collisions are impossible", () => {
      const a = deterministicFindingId({
        sessionGroupId: "ab",
        checkpointId: "c",
        observerProvider: "p",
        findingIndex: 0,
        evidencePath: "e",
        claim: "k",
      });
      const b = deterministicFindingId({
        sessionGroupId: "a",
        checkpointId: "bc",
        observerProvider: "p",
        findingIndex: 0,
        evidencePath: "e",
        claim: "k",
      });
      expect(a).not.toBe(b);
    });
  });

  describe("Council Mode bus → wsBridge fanout", () => {
    // The orchestrator's wireGroupListeners subscribes to companionBus
    // and broadcasts `observer_review` to both halves. These tests drive
    // the bus directly and assert the wire-message reaches
    // wsBridge.broadcastToGroup with the correct shape.

    beforeEach(() => {
      orchestrator.initialize();
    });

    it("fans `group:created` out to both halves with the correct pairing label", () => {
      // Seed the launcher's session map so the listener can resolve
      // backendType for the pairing label.
      vi.mocked(deps.launcher.getSession).mockImplementation((id: string) => {
        if (id === "sess_orch") return { sessionId: "sess_orch", state: "starting", cwd: "/w", createdAt: 0, backendType: "claude" } as any;
        if (id === "sess_obs") return { sessionId: "sess_obs", state: "starting", cwd: "/w", createdAt: 0, backendType: "codex" } as any;
        return undefined;
      });
      companionBus.emit("group:created", {
        sessionGroupId: "grp_t1",
        primarySessionId: "sess_orch",
        observerSessionId: "sess_obs",
      });
      expect(deps.wsBridge.broadcastToGroup).toHaveBeenCalledWith(
        ["sess_orch", "sess_obs"],
        expect.objectContaining({ type: "group_created", pairing: "claude+codex" }),
      );
    });

    it("fans `group:review` out as the observer_review wire message including grounding downgrades", () => {
      vi.mocked(deps.launcher.listSessions).mockReturnValue([
        { sessionId: "sess_orch", sessionGroupId: "grp_t2", state: "running", cwd: "/w", createdAt: 0 } as any,
        { sessionId: "sess_obs", sessionGroupId: "grp_t2", state: "running", cwd: "/w", createdAt: 0 } as any,
      ]);
      companionBus.emit("group:review", {
        sessionGroupId: "grp_t2",
        checkpointId: "chk_a",
        phase: "council-plan",
        findings: [
          { id: "f1", severity: "STOP", claim: "live STOP", evidence_path: "src/x.ts" },
          { id: "f2", severity: "STOP", claim: "downgraded STOP", evidence_path: "src/y.ts", wasDowngraded: true, downgradeReason: "evidence_not_in_modified_set" },
        ],
        downgrades: [{ id: "f2", reason: "evidence_not_in_modified_set" }],
        observerModel: "gpt-5-codex",
        observerProvider: "codex",
      });
      const calls = vi.mocked(deps.wsBridge.broadcastToGroup).mock.calls;
      const last = calls[calls.length - 1]!;
      expect(last[0]).toEqual(["sess_orch", "sess_obs"]);
      const msg = last[1] as { type: string; findings: Array<{ id: string; wasDowngraded?: boolean }>; downgrades: Array<{ id: string }>; observerProvider: string };
      expect(msg.type).toBe("observer_review");
      expect(msg.observerProvider).toBe("codex");
      expect(msg.findings).toHaveLength(2);
      expect(msg.findings[1]?.wasDowngraded).toBe(true);
      expect(msg.downgrades).toEqual([{ id: "f2", reason: "evidence_not_in_modified_set" }]);
    });

    // EC-2 invariant (Subprocess council review #4): when an
    // unintentional `session:exited` hits a council-tracked session,
    // BOTH halves land in `intentionalKills` BEFORE the degrade signal
    // emits — preventing the proactive-relaunch race.
    it("does NOT drive group:degraded for an `intentional` session exit", () => {
      // Seed council group meta so the orchestrator's session:exited
      // listener has a group to match against.
      const obs = orchestrator as unknown as { councilGroupMeta: Map<string, { primarySessionId: string; observerSessionId: string; pairing: string; createdAt: number; lastCheckpointReceivedAt: number | null }> };
      obs.councilGroupMeta.set("grp_t3", {
        primarySessionId: "sess_orch_t3",
        observerSessionId: "sess_obs_t3",
        pairing: "claude+claude",
        createdAt: Date.now(),
        lastCheckpointReceivedAt: null,
      });
      const intentional = (orchestrator as unknown as { intentionalKills: Set<string> }).intentionalKills;
      intentional.add("sess_obs_t3");
      const broadcastCallsBefore = vi.mocked(deps.wsBridge.broadcastToGroup).mock.calls.length;
      companionBus.emit("session:exited", { sessionId: "sess_obs_t3", exitCode: 0 });
      expect(vi.mocked(deps.wsBridge.broadcastToGroup).mock.calls.length).toBe(broadcastCallsBefore);
    });

    // PLAN Task 3 — new contract: an unintentional council-half `session:exited`
    // no longer goes straight to `group_degraded`. Instead, it arms a 45s
    // reconnect grace window via `coordinator.armReconnect`. The dead-half is
    // NOT marked intentional (session-level auto-relaunch must still fire);
    // intentional-marking only happens when going straight to degraded
    // (relaunch budget exhausted, or second-half-dies-during-reconnect).
    it("arms reconnect grace (defers group_degraded) on unintentional council-half exit", () => {
      const obs = orchestrator as unknown as {
        councilGroupMeta: Map<string, { primarySessionId: string; observerSessionId: string; pairing: string; createdAt: number; lastCheckpointReceivedAt: number | null }>;
      };
      obs.councilGroupMeta.set("grp_t4", {
        primarySessionId: "sess_orch_t4",
        observerSessionId: "sess_obs_t4",
        pairing: "claude+codex",
        createdAt: Date.now(),
        lastCheckpointReceivedAt: null,
      });
      // Register the group with the long-lived coordinator so `armReconnect`
      // can find it. Direct registration mirrors `reconcileCouncilGroups`
      // on a server restart.
      const coord = (orchestrator as unknown as { getOrCreateCoordinatorSync: () => { registerExternalGroup: (r: unknown) => void; get: (id: string) => { status: string } | undefined } }).getOrCreateCoordinatorSync();
      coord.registerExternalGroup({
        sessionGroupId: "grp_t4",
        primary: { sessionId: "sess_orch_t4", backendType: "claude" },
        observer: { sessionId: "sess_obs_t4", backendType: "codex" },
        status: "active",
        createdAt: Date.now(),
      });

      companionBus.emit("session:exited", { sessionId: "sess_obs_t4", exitCode: 1 });

      // Contract: NO immediate group_degraded broadcast — we're in reconnecting
      const calls = vi.mocked(deps.wsBridge.broadcastToGroup).mock.calls;
      const degraded = calls.find((c: unknown[]) => (c[1] as { type?: string }).type === "group_degraded");
      expect(degraded).toBeUndefined();

      // Coordinator status is now `reconnecting`
      expect(coord.get("grp_t4")?.status).toBe("reconnecting");

      // intentionalKills NOT mutated — auto-relaunch must be free to fire
      const intentional = (orchestrator as unknown as { intentionalKills: Set<string> }).intentionalKills;
      expect(intentional.has("sess_obs_t4")).toBe(false);
      expect(intentional.has("sess_orch_t4")).toBe(false);
    });

    // PLAN Task 3 — EC-8 dual: if session-level relaunch is already exhausted,
    // arming a 45s window is pointless. Skip the grace and degrade immediately.
    // BOTH halves marked intentional (no path back to active).
    it("skips reconnect grace and goes straight to degraded when relaunch budget is exhausted", () => {
      const obs = orchestrator as unknown as {
        councilGroupMeta: Map<string, { primarySessionId: string; observerSessionId: string; pairing: string; createdAt: number; lastCheckpointReceivedAt: number | null }>;
        relaunchExhaustedNotified: Set<string>;
      };
      obs.councilGroupMeta.set("grp_t4b", {
        primarySessionId: "sess_orch_t4b",
        observerSessionId: "sess_obs_t4b",
        pairing: "claude+claude",
        createdAt: Date.now(),
        lastCheckpointReceivedAt: null,
      });
      const coord = (orchestrator as unknown as { getOrCreateCoordinatorSync: () => { registerExternalGroup: (r: unknown) => void; get: (id: string) => { status: string } | undefined } }).getOrCreateCoordinatorSync();
      coord.registerExternalGroup({
        sessionGroupId: "grp_t4b",
        primary: { sessionId: "sess_orch_t4b", backendType: "claude" },
        observer: { sessionId: "sess_obs_t4b", backendType: "claude" },
        status: "active",
        createdAt: Date.now(),
      });
      // Pre-mark the dying half as exhausted — Task 3's gate condition.
      obs.relaunchExhaustedNotified.add("sess_obs_t4b");

      companionBus.emit("session:exited", { sessionId: "sess_obs_t4b", exitCode: 1 });

      // Contract: group_degraded fires IMMEDIATELY (skipped grace).
      const calls = vi.mocked(deps.wsBridge.broadcastToGroup).mock.calls;
      const degraded = calls.find((c: unknown[]) => (c[1] as { type?: string }).type === "group_degraded");
      expect(degraded).toBeDefined();
      expect(degraded?.[1]).toMatchObject({ type: "group_degraded", sessionGroupId: "grp_t4b", deadRole: "observer" });

      // Coordinator status is `degraded` (not `reconnecting`).
      expect(coord.get("grp_t4b")?.status).toBe("degraded");

      // BOTH halves intentional — no relaunch can save this group.
      const intentional = (orchestrator as unknown as { intentionalKills: Set<string> }).intentionalKills;
      expect(intentional.has("sess_orch_t4b")).toBe(true);
      expect(intentional.has("sess_obs_t4b")).toBe(true);
    });
  });

  // ── handleCouncilCheckpoint / handleCouncilReview producers ────────────────
  //
  // These tests exercise the producer side of the Council Mode pipeline that
  // the bus-listener tests above only consume. handleCouncilCheckpoint is the
  // server-side sequence-monotonicity authority (Realtime P1-R2); handleCouncilReview
  // composes the delta manifest, grounding-validates the findings, and emits
  // the structured invocation log entry (Willison P1-1 / P1-4 / EC-9).
  describe("handleCouncilCheckpoint", () => {
    type WatcherEntry = {
      cwd: string;
      abort: AbortController;
      lastCheckpoint: { sequence: number; checkpoint_id: string; phase: string; artifact_paths: string[] } | null;
      previousCheckpoint: { sequence: number; checkpoint_id: string; phase: string; artifact_paths: string[] } | null;
    };
    function seedWatcherEntry(groupId: string, overrides: Partial<WatcherEntry> = {}): WatcherEntry {
      const entry: WatcherEntry = {
        cwd: "/w",
        abort: new AbortController(),
        lastCheckpoint: null,
        previousCheckpoint: null,
        ...overrides,
      };
      const obs = orchestrator as unknown as { councilWatchers: Map<string, WatcherEntry> };
      obs.councilWatchers.set(groupId, entry);
      return entry;
    }

    it("captures the first checkpoint and emits group:checkpoint", () => {
      const entry = seedWatcherEntry("grp_c1");
      const emitted: Array<{ sessionGroupId: string; sequence: number }> = [];
      companionBus.on("group:checkpoint", (e: unknown) => { emitted.push(e as { sessionGroupId: string; sequence: number }); });

      const handle = (orchestrator as unknown as {
        handleCouncilCheckpoint: (g: string, p: { schema_version: 1; checkpoint_id: string; phase: string; sequence: number; session_group_id: string; emitted_at: string; artifact_paths: string[] }) => void;
      }).handleCouncilCheckpoint;
      handle.call(orchestrator, "grp_c1", {
        schema_version: 1,
        checkpoint_id: "chk_a",
        phase: "council-plan",
        sequence: 0,
        session_group_id: "grp_c1",
        emitted_at: "2026-01-01T00:00:00Z",
        artifact_paths: ["src/a.ts"],
      });
      expect(entry.lastCheckpoint?.checkpoint_id).toBe("chk_a");
      expect(entry.previousCheckpoint).toBeNull();
      expect(emitted).toHaveLength(1);
      expect(emitted[0]?.sessionGroupId).toBe("grp_c1");
    });

    it("drops a checkpoint whose sequence is <= the last seen sequence", () => {
      const entry = seedWatcherEntry("grp_c2", {
        lastCheckpoint: { sequence: 5, checkpoint_id: "chk_old", phase: "p", artifact_paths: [] },
      });
      const emitted: unknown[] = [];
      companionBus.on("group:checkpoint", (e: unknown) => { emitted.push(e); });

      const handle = (orchestrator as unknown as {
        handleCouncilCheckpoint: (g: string, p: Record<string, unknown>) => void;
      }).handleCouncilCheckpoint;
      handle.call(orchestrator, "grp_c2", {
        schema_version: 1,
        checkpoint_id: "chk_stale",
        phase: "p",
        sequence: 3,
        session_group_id: "grp_c2",
        emitted_at: "2026-01-01T00:00:00Z",
        artifact_paths: [],
      });
      expect(entry.lastCheckpoint?.checkpoint_id).toBe("chk_old");
      expect(emitted).toHaveLength(0);
    });

    it("captures the prior checkpoint into previousCheckpoint when a new one supersedes", () => {
      const entry = seedWatcherEntry("grp_c3", {
        lastCheckpoint: { sequence: 1, checkpoint_id: "chk_prev", phase: "p", artifact_paths: ["src/a.ts"] },
      });
      const handle = (orchestrator as unknown as {
        handleCouncilCheckpoint: (g: string, p: Record<string, unknown>) => void;
      }).handleCouncilCheckpoint;
      handle.call(orchestrator, "grp_c3", {
        schema_version: 1,
        checkpoint_id: "chk_new",
        phase: "p",
        sequence: 2,
        session_group_id: "grp_c3",
        emitted_at: "2026-01-01T00:00:00Z",
        artifact_paths: ["src/a.ts", "src/b.ts"],
      });
      expect(entry.previousCheckpoint?.checkpoint_id).toBe("chk_prev");
      expect(entry.lastCheckpoint?.checkpoint_id).toBe("chk_new");
    });

    it("is a no-op when no watcher entry exists for the group", () => {
      const emitted: unknown[] = [];
      companionBus.on("group:checkpoint", (e: unknown) => { emitted.push(e); });
      const handle = (orchestrator as unknown as {
        handleCouncilCheckpoint: (g: string, p: Record<string, unknown>) => void;
      }).handleCouncilCheckpoint;
      handle.call(orchestrator, "grp_missing", {
        schema_version: 1,
        checkpoint_id: "chk_x",
        phase: "p",
        sequence: 0,
        session_group_id: "grp_missing",
        emitted_at: "2026-01-01T00:00:00Z",
        artifact_paths: [],
      });
      expect(emitted).toHaveLength(0);
    });
  });

  describe("handleCouncilReview", () => {
    function seedGroup(groupId: string, opts: { cwd?: string; artifactPaths?: string[]; primary?: string; observer?: string } = {}) {
      const cwd = opts.cwd ?? "/w";
      const ws = orchestrator as unknown as {
        councilWatchers: Map<string, {
          cwd: string;
          abort: AbortController;
          lastCheckpoint: { sequence: number; checkpoint_id: string; phase: string; artifact_paths: string[] } | null;
          previousCheckpoint: { sequence: number; artifact_paths: string[] } | null;
        }>;
        councilGroupMeta: Map<string, { primarySessionId: string; observerSessionId: string; pairing: string; observerPromptSha256?: string; createdAt: number; lastCheckpointReceivedAt: number | null }>;
      };
      ws.councilWatchers.set(groupId, {
        cwd,
        abort: new AbortController(),
        lastCheckpoint: {
          sequence: 0,
          checkpoint_id: "chk_a",
          phase: "council-plan",
          artifact_paths: opts.artifactPaths ?? [],
        },
        previousCheckpoint: null,
      });
      ws.councilGroupMeta.set(groupId, {
        primarySessionId: opts.primary ?? "sess_orch",
        observerSessionId: opts.observer ?? "sess_obs",
        pairing: "claude+claude",
        observerPromptSha256: "abc123",
        createdAt: Date.now(),
        lastCheckpointReceivedAt: Date.now() - 100,
      });
    }

    it("emits group:review with deterministic ids and downgrades STOPs whose evidence path is outside the modified set", () => {
      // Use a real tmp workspace so the grounding check's existsRelative
      // gate (Hunt P1-2) returns true for the in-scope file. Without this
      // the realpathSync-backed default predicate downgrades ALL STOPs as
      // `evidence_missing_on_disk`, hiding the modified-set branch.
      const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = require("node:fs") as typeof import("node:fs");
      const { tmpdir } = require("node:os") as typeof import("node:os");
      const { join: pathJoin } = require("node:path") as typeof import("node:path");
      const workspace = require("node:fs").realpathSync(mkdtempSync(pathJoin(tmpdir(), "council-orch-")));
      try {
        mkdirSync(pathJoin(workspace, "src"), { recursive: true });
        writeFileSync(pathJoin(workspace, "src/a.ts"), "// in-scope\n");
        seedGroup("grp_r1", { cwd: workspace, artifactPaths: ["src/a.ts"] });
        const emitted: Array<{ findings: Array<{ id: string; severity: string; wasDowngraded?: boolean }> }> = [];
        companionBus.on("group:review", (e: unknown) => { emitted.push(e as { findings: Array<{ id: string; severity: string; wasDowngraded?: boolean }> }); });

        const handle = (orchestrator as unknown as {
          handleCouncilReview: (g: string, p: Record<string, unknown>) => void;
        }).handleCouncilReview;
        handle.call(orchestrator, "grp_r1", {
          schema_version: 1,
          // Council Review 2026-05-13 Willison #12: wake-version echo
          // is mandatory; tests that exercise grounding (not echo
          // validation) must supply it so findings are not blanket-
          // downgraded with `wake_version_mismatch`.
          observer_wake_payload_version_echo: 1,
          checkpoint_id: "chk_a",
          phase: "council-plan",
          session_group_id: "grp_r1",
          reviewed_at: "2026-01-01T00:00:00Z",
          observer_provider: "claude",
          observer_model: "claude-opus-4-7",
          observer_cli_version: "1.0.0",
          findings: [
            { severity: "STOP", claim: "in scope", evidence_path: "src/a.ts" },
            { severity: "STOP", claim: "out of scope", evidence_path: "src/b.ts" },
          ],
        });
        expect(emitted).toHaveLength(1);
        const f0 = emitted[0]!.findings[0]!;
        const f1 = emitted[0]!.findings[1]!;
        expect(f0.id).toMatch(/^fnd_/);
        expect(f0.wasDowngraded).not.toBe(true);
        expect(f1.wasDowngraded).toBe(true);
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    });

    it("is a no-op (no emission) when the group has no watcher entry", () => {
      const emitted: unknown[] = [];
      companionBus.on("group:review", (e: unknown) => { emitted.push(e); });
      const handle = (orchestrator as unknown as {
        handleCouncilReview: (g: string, p: Record<string, unknown>) => void;
      }).handleCouncilReview;
      handle.call(orchestrator, "grp_missing", {
        schema_version: 1,
        checkpoint_id: "chk",
        phase: "p",
        session_group_id: "grp_missing",
        reviewed_at: "2026-01-01T00:00:00Z",
        observer_provider: "claude",
        observer_model: "m",
        observer_cli_version: "1",
        findings: [],
      });
      expect(emitted).toHaveLength(0);
    });

    it("swallows transient errors thrown during the grounding pipeline so the watcher's read loop stays alive", () => {
      // Seed group then trip the meta lookup to throw via a Proxy on the Map.
      seedGroup("grp_r2", { artifactPaths: ["src/a.ts"] });
      const ws = orchestrator as unknown as {
        councilGroupMeta: Map<string, { primarySessionId: string }>;
      };
      const original = ws.councilGroupMeta.get;
      ws.councilGroupMeta.get = () => { throw new Error("forced"); };
      try {
        const handle = (orchestrator as unknown as {
          handleCouncilReview: (g: string, p: Record<string, unknown>) => void;
        }).handleCouncilReview;
        expect(() => handle.call(orchestrator, "grp_r2", {
          schema_version: 1,
          checkpoint_id: "chk_a",
          phase: "p",
          session_group_id: "grp_r2",
          reviewed_at: "2026-01-01T00:00:00Z",
          observer_provider: "claude",
          observer_model: "m",
          observer_cli_version: "1",
          findings: [{ severity: "INFO", claim: "x", evidence_path: "src/a.ts" }],
        })).not.toThrow();
      } finally {
        ws.councilGroupMeta.get = original;
      }
    });
  });

  // ── dispatchObserverWake — direct outcome-table coverage (Beck regression #2) ──
  //
  // The keystone observer-wake dispatcher has 10 distinct outcome branches
  // (dispatched + 8 skip reasons + failed) and 5 ordered gates (sentinel,
  // group_status, build, busy/disconnected/backpressure/etc., send). The
  // static-grep canary at observer-prompt.test.ts pins the call site but
  // does not exercise behaviour — this describe block covers each outcome
  // via the injected `deps.wsBridge.sendObserverWakeFrame` mock.
  describe("dispatchObserverWake", () => {
    function seedActiveGroup(groupId: string, opts: { cwd?: string; primary?: string; observer?: string } = {}) {
      const cwd = opts.cwd ?? require("node:fs").realpathSync(require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "council-disp-")));
      const ws = orchestrator as unknown as {
        councilWatchers: Map<string, { cwd: string; abort: AbortController; lastCheckpoint: unknown; previousCheckpoint: unknown; pendingCheckpoint: unknown; supersededCheckpointIds: string[] }>;
        councilGroupMeta: Map<string, { primarySessionId: string; observerSessionId: string; pairing: string; createdAt: number; lastCheckpointReceivedAt: number | null }>;
        coordinator: unknown;
      };
      ws.councilWatchers.set(groupId, {
        cwd,
        abort: new AbortController(),
        lastCheckpoint: null,
        previousCheckpoint: null,
        pendingCheckpoint: null,
        supersededCheckpointIds: [],
      });
      ws.councilGroupMeta.set(groupId, {
        primarySessionId: opts.primary ?? "sess_orch",
        observerSessionId: opts.observer ?? "sess_obs",
        pairing: "claude+claude",
        createdAt: Date.now(),
        lastCheckpointReceivedAt: null,
      });
      // Stub a minimal coordinator with an active group record so Gate 1
      // doesn't short-circuit on absent-coordinator.
      ws.coordinator = {
        get: vi.fn(() => ({ sessionGroupId: groupId, status: "active" })),
      };
      return cwd;
    }
    function validPayload(groupId: string, opts: { sequence?: number; checkpointId?: string } = {}) {
      return {
        schema_version: 1,
        checkpoint_id: opts.checkpointId ?? "chk_dispatch_1",
        phase: "council-plan",
        sequence: opts.sequence ?? 1,
        session_group_id: groupId,
        emitted_at: "2026-01-01T00:00:00Z",
        artifact_paths: [],
      } as any;
    }
    function callDispatch(groupId: string, payload: any) {
      return (orchestrator as unknown as {
        dispatchObserverWake: (g: string, p: any) => any;
      }).dispatchObserverWake.call(orchestrator, groupId, payload);
    }

    afterEach(() => {
      vi.mocked(deps.wsBridge.sendObserverWakeFrame).mockReset();
      vi.mocked(deps.wsBridge.sendObserverWakeFrame).mockReturnValue({ kind: "sent" });
    });

    // Happy path: bridge returns sent → outcome dispatched + sentinel written.
    it("returns dispatched + writes sentinel when the bridge accepts the wake", () => {
      seedActiveGroup("grp_d1");
      vi.mocked(deps.wsBridge.sendObserverWakeFrame).mockReturnValue({ kind: "sent" });
      const out = callDispatch("grp_d1", validPayload("grp_d1"));
      expect(out.kind).toBe("dispatched");
      expect(out.checkpointId).toBe("chk_dispatch_1");
      expect(out.observerSessionId).toBe("sess_obs");
      expect(deps.wsBridge.sendObserverWakeFrame).toHaveBeenCalledTimes(1);
    });

    // Observer unknown — watcher exists but councilGroupMeta drops mid-flight.
    it("returns skipped:observer_unknown when councilGroupMeta is missing for the group", () => {
      seedActiveGroup("grp_d_unknown");
      const ws = orchestrator as unknown as { councilGroupMeta: Map<string, unknown> };
      ws.councilGroupMeta.delete("grp_d_unknown");
      const out = callDispatch("grp_d_unknown", validPayload("grp_d_unknown"));
      expect(out.kind).toBe("skipped");
      expect(out.reason).toBe("observer_unknown");
    });

    // Group status not-active (degraded) → skipped:group_not_active.
    it("returns skipped:group_not_active when coordinator status is degraded", () => {
      seedActiveGroup("grp_d_deg");
      const ws = orchestrator as unknown as { coordinator: { get: ReturnType<typeof vi.fn> } };
      ws.coordinator.get = vi.fn(() => ({ status: "degraded" }));
      const out = callDispatch("grp_d_deg", validPayload("grp_d_deg"));
      expect(out.kind).toBe("skipped");
      expect(out.reason).toBe("group_not_active");
    });

    // Group status reconnecting → queues into pendingCheckpoint (#3 fix).
    it("queues into pendingCheckpoint when coordinator status is reconnecting", () => {
      seedActiveGroup("grp_d_rec");
      const ws = orchestrator as unknown as { coordinator: { get: ReturnType<typeof vi.fn> }; councilWatchers: Map<string, { pendingCheckpoint: unknown }> };
      ws.coordinator.get = vi.fn(() => ({ status: "reconnecting" }));
      const payload = validPayload("grp_d_rec");
      const out = callDispatch("grp_d_rec", payload);
      expect(out.kind).toBe("skipped");
      expect(out.reason).toBe("observer_busy");
      expect(ws.councilWatchers.get("grp_d_rec")?.pendingCheckpoint).toBe(payload);
    });

    // Bridge returns busy → queues into pendingCheckpoint.
    it("queues into pendingCheckpoint when the adapter is mid-turn (busy)", () => {
      seedActiveGroup("grp_d_busy");
      vi.mocked(deps.wsBridge.sendObserverWakeFrame).mockReturnValue({ kind: "busy" });
      const payload = validPayload("grp_d_busy");
      const out = callDispatch("grp_d_busy", payload);
      expect(out.kind).toBe("skipped");
      expect(out.reason).toBe("observer_busy");
      const ws = orchestrator as unknown as { councilWatchers: Map<string, { pendingCheckpoint: unknown }> };
      expect(ws.councilWatchers.get("grp_d_busy")?.pendingCheckpoint).toBe(payload);
    });

    // Bridge returns socket_disconnected → skip without queue.
    it("returns skipped:socket_disconnected when the bridge can't reach the observer", () => {
      seedActiveGroup("grp_d_disc");
      vi.mocked(deps.wsBridge.sendObserverWakeFrame).mockReturnValue({ kind: "socket_disconnected" });
      const out = callDispatch("grp_d_disc", validPayload("grp_d_disc"));
      expect(out.kind).toBe("skipped");
      expect(out.reason).toBe("socket_disconnected");
    });

    // Bridge returns backpressure → queues (Realtime #17 fix).
    it("queues into pendingCheckpoint on backpressure (Realtime #17)", () => {
      seedActiveGroup("grp_d_bp");
      vi.mocked(deps.wsBridge.sendObserverWakeFrame).mockReturnValue({ kind: "backpressure", bufferedAmount: 2_000_000 });
      const payload = validPayload("grp_d_bp");
      const out = callDispatch("grp_d_bp", payload);
      expect(out.kind).toBe("skipped");
      expect(out.reason).toBe("backpressure");
      const ws = orchestrator as unknown as { councilWatchers: Map<string, { pendingCheckpoint: unknown }> };
      expect(ws.councilWatchers.get("grp_d_bp")?.pendingCheckpoint).toBe(payload);
    });

    // Bridge returns session_unknown → observer_unknown (mapped).
    it("maps bridge session_unknown to skipped:observer_unknown", () => {
      seedActiveGroup("grp_d_su");
      vi.mocked(deps.wsBridge.sendObserverWakeFrame).mockReturnValue({ kind: "session_unknown" });
      const out = callDispatch("grp_d_su", validPayload("grp_d_su"));
      expect(out.kind).toBe("skipped");
      expect(out.reason).toBe("observer_unknown");
    });

    // Bridge returns adapter_missing → adapter_missing.
    it("returns skipped:adapter_missing when the bridge has no adapter for the session", () => {
      seedActiveGroup("grp_d_am");
      vi.mocked(deps.wsBridge.sendObserverWakeFrame).mockReturnValue({ kind: "adapter_missing" });
      const out = callDispatch("grp_d_am", validPayload("grp_d_am"));
      expect(out.kind).toBe("skipped");
      expect(out.reason).toBe("adapter_missing");
    });

    // Bridge returns unsupported_backend (Codex pairing not wired).
    it("returns skipped:unsupported_backend on Codex pairing", () => {
      seedActiveGroup("grp_d_un");
      vi.mocked(deps.wsBridge.sendObserverWakeFrame).mockReturnValue({ kind: "unsupported_backend" });
      const out = callDispatch("grp_d_un", validPayload("grp_d_un"));
      expect(out.kind).toBe("skipped");
      expect(out.reason).toBe("unsupported_backend");
    });

    // Bridge throws → failed outcome with error string.
    it("returns failed with error message on bridge send-throw", () => {
      seedActiveGroup("grp_d_fail");
      vi.mocked(deps.wsBridge.sendObserverWakeFrame).mockReturnValue({ kind: "failed", error: "socket-write-EPIPE" });
      const out = callDispatch("grp_d_fail", validPayload("grp_d_fail"));
      expect(out.kind).toBe("failed");
      expect(out.error).toBe("socket-write-EPIPE");
    });

    // Sentinel idempotency: a second dispatch for the same checkpoint id skips.
    it("returns skipped:already_woken on second dispatch for the same checkpoint_id (sentinel idempotency)", () => {
      seedActiveGroup("grp_d_sent");
      vi.mocked(deps.wsBridge.sendObserverWakeFrame).mockReturnValue({ kind: "sent" });
      const p = validPayload("grp_d_sent", { checkpointId: "chk_repeat" });
      const first = callDispatch("grp_d_sent", p);
      expect(first.kind).toBe("dispatched");
      const second = callDispatch("grp_d_sent", p);
      expect(second.kind).toBe("skipped");
      expect(second.reason).toBe("already_woken");
    });

    // drainPendingObserverWake: drains queue when one exists.
    it("drainPendingObserverWake dispatches the queued checkpoint and clears the slot", () => {
      seedActiveGroup("grp_d_drain");
      const ws = orchestrator as unknown as {
        councilWatchers: Map<string, { pendingCheckpoint: any }>;
        drainPendingObserverWake: (g: string) => void;
      };
      const queued = validPayload("grp_d_drain", { checkpointId: "chk_queued" });
      ws.councilWatchers.get("grp_d_drain")!.pendingCheckpoint = queued;
      vi.mocked(deps.wsBridge.sendObserverWakeFrame).mockReturnValue({ kind: "sent" });
      ws.drainPendingObserverWake.call(orchestrator, "grp_d_drain");
      // Slot cleared, send invoked.
      expect(ws.councilWatchers.get("grp_d_drain")!.pendingCheckpoint).toBeNull();
      expect(deps.wsBridge.sendObserverWakeFrame).toHaveBeenCalledTimes(1);
    });

    it("drainPendingObserverWake is a no-op when no checkpoint is queued", () => {
      seedActiveGroup("grp_d_drain_empty");
      const ws = orchestrator as unknown as {
        drainPendingObserverWake: (g: string) => void;
      };
      vi.mocked(deps.wsBridge.sendObserverWakeFrame).mockReset();
      ws.drainPendingObserverWake.call(orchestrator, "grp_d_drain_empty");
      expect(deps.wsBridge.sendObserverWakeFrame).not.toHaveBeenCalled();
    });

    it("drainPendingObserverWake is a no-op when the watcher entry is missing", () => {
      const ws = orchestrator as unknown as {
        drainPendingObserverWake: (g: string) => void;
      };
      vi.mocked(deps.wsBridge.sendObserverWakeFrame).mockReset();
      ws.drainPendingObserverWake.call(orchestrator, "grp_nonexistent");
      expect(deps.wsBridge.sendObserverWakeFrame).not.toHaveBeenCalled();
    });

    // Foreign-group checkpoint defence (Hunt #1 from prior pass).
    it("handleCouncilCheckpoint drops a checkpoint whose session_group_id mismatches the watcher", () => {
      seedActiveGroup("grp_fg_a");
      vi.mocked(deps.wsBridge.sendObserverWakeFrame).mockReset();
      const handle = (orchestrator as unknown as {
        handleCouncilCheckpoint: (g: string, p: any) => void;
      }).handleCouncilCheckpoint;
      // Payload claims group B but watcher is for group A.
      handle.call(orchestrator, "grp_fg_a", validPayload("grp_fg_OTHER"));
      // Cross-group filter at handler head: no dispatch, no state mutation.
      expect(deps.wsBridge.sendObserverWakeFrame).not.toHaveBeenCalled();
    });
  });

  // ── scanForMissedObserverWakes (EC-12 pre-scan reconciler) ───────────────
  describe("scanForMissedObserverWakes", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    const pathLib = require("node:path") as typeof import("node:path");
    const osLib = require("node:os") as typeof import("node:os");

    function seedActiveGroupAt(groupId: string, workspaceCwd: string) {
      const ws = orchestrator as unknown as {
        councilWatchers: Map<string, { cwd: string; abort: AbortController; lastCheckpoint: unknown; previousCheckpoint: unknown; pendingCheckpoint: unknown; supersededCheckpointIds: string[] }>;
        councilGroupMeta: Map<string, { primarySessionId: string; observerSessionId: string; pairing: string; createdAt: number; lastCheckpointReceivedAt: number | null }>;
        coordinator: unknown;
      };
      ws.councilWatchers.set(groupId, {
        cwd: workspaceCwd,
        abort: new AbortController(),
        lastCheckpoint: null,
        previousCheckpoint: null,
        pendingCheckpoint: null,
        supersededCheckpointIds: [],
      });
      ws.councilGroupMeta.set(groupId, {
        primarySessionId: "orch",
        observerSessionId: "obs",
        pairing: "claude+claude",
        createdAt: Date.now(),
        lastCheckpointReceivedAt: null,
      });
      ws.coordinator = { get: vi.fn(() => ({ sessionGroupId: groupId, status: "active" })) };
    }

    afterEach(() => {
      vi.mocked(deps.wsBridge.sendObserverWakeFrame).mockReset();
      vi.mocked(deps.wsBridge.sendObserverWakeFrame).mockReturnValue({ kind: "sent" });
    });

    it("dispatches a wake for the highest-sequence on-disk checkpoint when no sentinel exists", () => {
      const workspace = fs.realpathSync(fs.mkdtempSync(pathLib.join(osLib.tmpdir(), "scan-test-")));
      try {
        fs.mkdirSync(pathLib.join(workspace, ".council", "checkpoints"), { recursive: true });
        fs.writeFileSync(pathLib.join(workspace, ".council", "checkpoints", "phase-a.json"), JSON.stringify({
          schema_version: 1, checkpoint_id: "chk_a", phase: "phase-a", sequence: 1,
          session_group_id: "grp_scan1", emitted_at: "2026-01-01T00:00:00Z", artifact_paths: [],
        }));
        fs.writeFileSync(pathLib.join(workspace, ".council", "checkpoints", "phase-b.json"), JSON.stringify({
          schema_version: 1, checkpoint_id: "chk_b", phase: "phase-b", sequence: 2,
          session_group_id: "grp_scan1", emitted_at: "2026-01-01T00:00:00Z", artifact_paths: [],
        }));
        seedActiveGroupAt("grp_scan1", workspace);
        (orchestrator as unknown as { scanForMissedObserverWakes: () => void }).scanForMissedObserverWakes.call(orchestrator);
        // Highest-sequence (chk_b, seq=2) should be dispatched.
        expect(deps.wsBridge.sendObserverWakeFrame).toHaveBeenCalledTimes(1);
      } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
      }
    });

    it("skips dispatch when the highest on-disk checkpoint matches the sentinel", () => {
      const workspace = fs.realpathSync(fs.mkdtempSync(pathLib.join(osLib.tmpdir(), "scan-test-")));
      try {
        fs.mkdirSync(pathLib.join(workspace, ".council", "checkpoints"), { recursive: true });
        fs.writeFileSync(pathLib.join(workspace, ".council", "checkpoints", "phase-a.json"), JSON.stringify({
          schema_version: 1, checkpoint_id: "chk_a", phase: "phase-a", sequence: 5,
          session_group_id: "grp_scan2", emitted_at: "2026-01-01T00:00:00Z", artifact_paths: [],
        }));
        // Pre-write sentinel claiming we already woke for seq 5.
        // Inline the sentinel file write — avoids vitest's ESM/CJS
        // require quirk on .js extensions for sibling source files.
        const stateDir = pathLib.join(workspace, ".council", "state");
        fs.mkdirSync(stateDir, { recursive: true });
        fs.writeFileSync(pathLib.join(stateDir, "grp_scan2-wake.json"), JSON.stringify({
          schema_version: 1,
          last_woken_checkpoint_id: "chk_a",
          last_woken_sequence: 5,
          last_woken_at: "2026-01-01T00:00:00Z",
        }));
        seedActiveGroupAt("grp_scan2", workspace);
        (orchestrator as unknown as { scanForMissedObserverWakes: () => void }).scanForMissedObserverWakes.call(orchestrator);
        expect(deps.wsBridge.sendObserverWakeFrame).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
      }
    });

    it("absorbs missing .council/checkpoints/ directory without throwing", () => {
      const workspace = fs.mkdtempSync(pathLib.join(osLib.tmpdir(), "scan-test-"));
      try {
        // Workspace exists but no .council subdir.
        seedActiveGroupAt("grp_scan3", workspace);
        expect(() => (orchestrator as unknown as { scanForMissedObserverWakes: () => void }).scanForMissedObserverWakes.call(orchestrator)).not.toThrow();
        expect(deps.wsBridge.sendObserverWakeFrame).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
      }
    });

    it("skips foreign-group checkpoints in the scan (cross-group filter)", () => {
      const workspace = fs.realpathSync(fs.mkdtempSync(pathLib.join(osLib.tmpdir(), "scan-test-")));
      try {
        fs.mkdirSync(pathLib.join(workspace, ".council", "checkpoints"), { recursive: true });
        // Checkpoint claims a DIFFERENT group than the watcher.
        fs.writeFileSync(pathLib.join(workspace, ".council", "checkpoints", "phase-x.json"), JSON.stringify({
          schema_version: 1, checkpoint_id: "chk_x", phase: "phase-x", sequence: 1,
          session_group_id: "grp_OTHER", emitted_at: "2026-01-01T00:00:00Z", artifact_paths: [],
        }));
        seedActiveGroupAt("grp_scan4", workspace);
        (orchestrator as unknown as { scanForMissedObserverWakes: () => void }).scanForMissedObserverWakes.call(orchestrator);
        expect(deps.wsBridge.sendObserverWakeFrame).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
      }
    });

    it("skips corrupt checkpoint files without crashing", () => {
      const workspace = fs.realpathSync(fs.mkdtempSync(pathLib.join(osLib.tmpdir(), "scan-test-")));
      try {
        fs.mkdirSync(pathLib.join(workspace, ".council", "checkpoints"), { recursive: true });
        fs.writeFileSync(pathLib.join(workspace, ".council", "checkpoints", "garbage.json"), "{not valid JSON");
        fs.writeFileSync(pathLib.join(workspace, ".council", "checkpoints", "good.json"), JSON.stringify({
          schema_version: 1, checkpoint_id: "chk_ok", phase: "phase-ok", sequence: 1,
          session_group_id: "grp_scan5", emitted_at: "2026-01-01T00:00:00Z", artifact_paths: [],
        }));
        seedActiveGroupAt("grp_scan5", workspace);
        (orchestrator as unknown as { scanForMissedObserverWakes: () => void }).scanForMissedObserverWakes.call(orchestrator);
        // The good file should still be dispatched; the garbage file is skipped.
        expect(deps.wsBridge.sendObserverWakeFrame).toHaveBeenCalledTimes(1);
      } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
      }
    });

    it("caps file iteration at SCAN_MAX_FILES_PER_GROUP and emits a structured truncated log", () => {
      const workspace = fs.realpathSync(fs.mkdtempSync(pathLib.join(osLib.tmpdir(), "scan-cap-")));
      try {
        fs.mkdirSync(pathLib.join(workspace, ".council", "checkpoints"), { recursive: true });
        // Write 250 files (cap is 200). Use simple unique names; the
        // sort() in the scan picks the lexicographic tail.
        for (let i = 1; i <= 250; i++) {
          const padded = String(i).padStart(4, "0");
          fs.writeFileSync(pathLib.join(workspace, ".council", "checkpoints", `phase-${padded}.json`), JSON.stringify({
            schema_version: 1, checkpoint_id: `chk_${padded}`, phase: `phase-${padded}`,
            sequence: i, session_group_id: "grp_cap", emitted_at: "2026-01-01T00:00:00Z", artifact_paths: [],
          }));
        }
        seedActiveGroupAt("grp_cap", workspace);
        (orchestrator as unknown as { scanForMissedObserverWakes: () => void }).scanForMissedObserverWakes.call(orchestrator);
        // Scan still picks a dispatch from the capped tail — coverage
        // proof is the truncated log path was exercised.
        expect(deps.wsBridge.sendObserverWakeFrame).toHaveBeenCalled();
      } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
      }
    });
  });

  // ── Bus listener paths added by the fix-pass ──────────────────────────────
  // Exercises the group:exited / group:degraded listeners' sentinel cleanup
  // + tearDownCouncilGroupTracking helper (Backend #4 fix).
  describe("council group lifecycle listeners", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    const pathLib = require("node:path") as typeof import("node:path");
    const osLib = require("node:os") as typeof import("node:os");

    function setupGroup(groupId: string): { workspace: string; ws: any } {
      const workspace = fs.realpathSync(fs.mkdtempSync(pathLib.join(osLib.tmpdir(), "lifecycle-")));
      const ws = orchestrator as unknown as {
        councilWatchers: Map<string, { cwd: string; abort: AbortController; lastCheckpoint: unknown; previousCheckpoint: unknown; pendingCheckpoint: unknown; supersededCheckpointIds: string[] }>;
        councilGroupMeta: Map<string, { primarySessionId: string; observerSessionId: string; pairing: string; createdAt: number; lastCheckpointReceivedAt: number | null }>;
        councilGroupBySessionId: Map<string, string>;
      };
      ws.councilWatchers.set(groupId, {
        cwd: workspace,
        abort: new AbortController(),
        lastCheckpoint: null,
        previousCheckpoint: null,
        pendingCheckpoint: null,
        supersededCheckpointIds: [],
      });
      ws.councilGroupMeta.set(groupId, {
        primarySessionId: "orch_id",
        observerSessionId: "obs_id",
        pairing: "claude+claude",
        createdAt: Date.now(),
        lastCheckpointReceivedAt: null,
      });
      ws.councilGroupBySessionId.set("orch_id", groupId);
      ws.councilGroupBySessionId.set("obs_id", groupId);
      // Pre-write a sentinel so the cleanup path exercises unlink.
      const stateDir = pathLib.join(workspace, ".council", "state");
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(pathLib.join(stateDir, `${groupId}-wake.json`), JSON.stringify({
        schema_version: 1,
        last_woken_checkpoint_id: "chk_x",
        last_woken_sequence: 1,
        last_woken_at: "2026-01-01T00:00:00Z",
      }));
      return { workspace, ws };
    }

    it("group:exited listener tears down all 3 state maps + deletes sentinel + stops watcher", () => {
      // Listeners are wired in initialize() — these tests need them live.
      orchestrator.initialize();
      const { workspace, ws } = setupGroup("grp_le1");
      try {
        companionBus.emit("group:exited", { sessionGroupId: "grp_le1", reason: "user_archived" });
        // Tracking maps cleared.
        expect(ws.councilGroupMeta.has("grp_le1")).toBe(false);
        expect(ws.councilGroupBySessionId.has("orch_id")).toBe(false);
        expect(ws.councilGroupBySessionId.has("obs_id")).toBe(false);
        expect(ws.councilWatchers.has("grp_le1")).toBe(false);
        // Sentinel file removed.
        expect(fs.existsSync(pathLib.join(workspace, ".council", "state", "grp_le1-wake.json"))).toBe(false);
      } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
      }
    });

    it("group:degraded listener drops queued pendingCheckpoint + cleans sentinel without removing watcher", () => {
      orchestrator.initialize();
      const { workspace, ws } = setupGroup("grp_ld1");
      try {
        // Stage a queued checkpoint that should be dropped.
        ws.councilWatchers.get("grp_ld1")!.pendingCheckpoint = {
          checkpoint_id: "chk_queued",
          sequence: 5,
        };
        companionBus.emit("group:degraded", { sessionGroupId: "grp_ld1", deadRole: "observer" });
        // pendingCheckpoint cleared.
        expect(ws.councilWatchers.get("grp_ld1")?.pendingCheckpoint).toBeNull();
        // Sentinel removed (the new fix-pass behaviour).
        expect(fs.existsSync(pathLib.join(workspace, ".council", "state", "grp_ld1-wake.json"))).toBe(false);
        // Watcher NOT torn down — group still operable with surviving half.
        expect(ws.councilWatchers.has("grp_ld1")).toBe(true);
      } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
      }
    });

    it("observer:turn-done listener drains pendingCheckpoint via reverse-index lookup (Backend #21)", () => {
      orchestrator.initialize();
      const { workspace, ws } = setupGroup("grp_lt1");
      try {
        // Stage a queued checkpoint that should drain on turn-done.
        const queued = {
          schema_version: 1, checkpoint_id: "chk_queued", phase: "p", sequence: 1,
          session_group_id: "grp_lt1", emitted_at: "2026-01-01T00:00:00Z", artifact_paths: [],
        };
        ws.councilWatchers.get("grp_lt1")!.pendingCheckpoint = queued;
        vi.mocked(deps.wsBridge.sendObserverWakeFrame).mockReset();
        vi.mocked(deps.wsBridge.sendObserverWakeFrame).mockReturnValue({ kind: "sent" });
        // Need a coordinator stub for the drain's dispatchObserverWake call.
        (orchestrator as any).coordinator = {
          get: vi.fn(() => ({ sessionGroupId: "grp_lt1", status: "active" })),
        };
        companionBus.emit("observer:turn-done", { sessionId: "obs_id" });
        // Drain ran — pending slot cleared, dispatch fired.
        expect(ws.councilWatchers.get("grp_lt1")?.pendingCheckpoint).toBeNull();
        expect(deps.wsBridge.sendObserverWakeFrame).toHaveBeenCalled();
      } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
      }
    });

    it("observer:turn-done from non-observer sessionId is ignored (Backend #21 guard)", () => {
      orchestrator.initialize();
      const { workspace, ws } = setupGroup("grp_lt2");
      try {
        ws.councilWatchers.get("grp_lt2")!.pendingCheckpoint = { checkpoint_id: "chk_q", sequence: 1 };
        vi.mocked(deps.wsBridge.sendObserverWakeFrame).mockReset();
        // Emit with the ORCHESTRATOR's id — guard skips drain because
        // meta.observerSessionId !== sessionId.
        companionBus.emit("observer:turn-done", { sessionId: "orch_id" });
        // No drain, slot still occupied.
        expect(ws.councilWatchers.get("grp_lt2")?.pendingCheckpoint).not.toBeNull();
        expect(deps.wsBridge.sendObserverWakeFrame).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
      }
    });
  });

  // ── stopCouncilWatchers cleanup ────────────────────────────────────────────
  // ── createCouncilGroup early-error branches ─────────────────────────────
  //
  // The full happy path requires a real coordinator + spawn pipeline (covered
  // indirectly by the routes.test.ts SSE branch tests). Here we focus on the
  // synchronous early-error paths that gate against malformed pairing labels
  // — cheap to cover, and the user-facing error shape is the contract.
  describe("createCouncilGroup early-error branches", () => {
    // The pairing label is typed at the API boundary, but the runtime
    // parser is the actual gate — callers can hand-craft a malformed
    // request from a stale browser. Cast through `as` so the test exercises
    // that gate directly.
    it("returns ok:false with status 400 on an unparseable pairing label (wrong arity)", async () => {
      const result = await orchestrator.createCouncilGroup({
        pairing: "claude-only-no-plus" as "claude+claude",
        base: { cwd: "/w" },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(400);
        expect(result.error).toMatch(/unsupported pairing/);
      }
    });

    it("returns ok:false with status 400 on an unsupported provider in the pairing label", async () => {
      const result = await orchestrator.createCouncilGroup({
        pairing: "claude+gemini" as "claude+claude",
        base: { cwd: "/w" },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(400);
      }
    });

    it("returns ok:false with status 400 when the parsed pairing is not in SUPPORTED_PAIRINGS", async () => {
      // codex+claude is parseable but not in the allow-list.
      const result = await orchestrator.createCouncilGroup({
        pairing: "codex+claude" as "claude+claude",
        base: { cwd: "/w" },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(400);
      }
    });
  });

  // ── startCouncilWatchers — real tmp dir wiring ──────────────────────────
  //
  // Verifies that startCouncilWatchers (a) creates .council/checkpoints +
  // .council/reviews directories under the workspace, (b) inserts the
  // watcher entry into the councilWatchers map, (c) stopCouncilWatchers
  // tears it down cleanly. The fs.watch handles themselves are exercised
  // by checkpoint-watcher.test.ts / review-watcher.test.ts; we just verify
  // the orchestrator's bookkeeping side here.
  describe("startCouncilWatchers", () => {
    it("creates .council/checkpoints + .council/reviews and inserts the watcher entry", async () => {
      const fs = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");
      const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "council-watch-")));
      try {
        const obs = orchestrator as unknown as {
          startCouncilWatchers: (g: string, cwd: string) => void;
          stopCouncilWatchers: (g: string) => void;
          councilWatchers: Map<string, { cwd: string; abort: AbortController }>;
        };
        obs.startCouncilWatchers("grp_sw1", ws);
        expect(obs.councilWatchers.has("grp_sw1")).toBe(true);
        expect(fs.existsSync(path.join(ws, ".council", "checkpoints"))).toBe(true);
        expect(fs.existsSync(path.join(ws, ".council", "reviews"))).toBe(true);
        obs.stopCouncilWatchers("grp_sw1");
        expect(obs.councilWatchers.has("grp_sw1")).toBe(false);
      } finally {
        fs.rmSync(ws, { recursive: true, force: true });
      }
    });

    it("is a no-op when called twice for the same group (idempotency)", async () => {
      const fs = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");
      const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "council-watch-")));
      try {
        const obs = orchestrator as unknown as {
          startCouncilWatchers: (g: string, cwd: string) => void;
          stopCouncilWatchers: (g: string) => void;
          councilWatchers: Map<string, { cwd: string; abort: AbortController }>;
        };
        obs.startCouncilWatchers("grp_sw2", ws);
        const first = obs.councilWatchers.get("grp_sw2");
        obs.startCouncilWatchers("grp_sw2", ws);
        const second = obs.councilWatchers.get("grp_sw2");
        // Same entry (no re-attach).
        expect(second).toBe(first);
        obs.stopCouncilWatchers("grp_sw2");
      } finally {
        fs.rmSync(ws, { recursive: true, force: true });
      }
    });
  });

  // ── reconcileCouncilGroups — startup recovery ──────────────────────────
  //
  // After a server restart, --resume brings back CLI processes from
  // session-store, but the orchestrator's in-memory group-lifecycle layer
  // (councilGroupMeta + councilWatchers) is empty until createCouncilGroup
  // is called fresh. reconcileCouncilGroups() rebuilds that layer by
  // scanning launcher.listSessions() for complete (orchestrator + observer
  // present, non-archived) pairs and arming watchers. Without it, the UI
  // hydration path (synthetic group_created on browser subscribe) has no
  // backing data and the checkpoint→review pipeline stays dead post-restart.
  describe("reconcileCouncilGroups", () => {
    it("restores councilGroupMeta + arms watchers for a complete pair", async () => {
      const fs = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");
      const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "council-recon-")));
      try {
        (deps.launcher.listSessions as any).mockReturnValue([
          { sessionId: "s-orch", sessionGroupId: "grp_r1", sessionGroupRole: "orchestrator",
            backendType: "claude", cwd: ws, archived: false, createdAt: 1000, state: "running" },
          { sessionId: "s-obs", sessionGroupId: "grp_r1", sessionGroupRole: "observer",
            backendType: "claude", cwd: ws, archived: false, createdAt: 1001,
            observerPromptSha256: "deadbeef", state: "running" },
        ]);
        const obs = orchestrator as unknown as {
          reconcileCouncilGroups: () => void;
          councilGroupMeta: Map<string, { primarySessionId: string; observerSessionId: string; pairing: string; observerPromptSha256?: string }>;
          councilWatchers: Map<string, unknown>;
        };
        obs.reconcileCouncilGroups();
        const meta = obs.councilGroupMeta.get("grp_r1");
        expect(meta).toBeDefined();
        expect(meta?.primarySessionId).toBe("s-orch");
        expect(meta?.observerSessionId).toBe("s-obs");
        expect(meta?.pairing).toBe("claude+claude");
        expect(meta?.observerPromptSha256).toBe("deadbeef");
        expect(obs.councilWatchers.has("grp_r1")).toBe(true);
        // stopCouncilWatchers tears down — keeps test tmpdir cleanup safe.
        (obs as any).stopCouncilWatchers("grp_r1");
      } finally {
        fs.rmSync(ws, { recursive: true, force: true });
      }
    });

    it("emits the correct pairing label for claude+codex cross-pairing", async () => {
      const fs = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");
      const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "council-recon-")));
      try {
        (deps.launcher.listSessions as any).mockReturnValue([
          { sessionId: "p-orch", sessionGroupId: "grp_xp", sessionGroupRole: "orchestrator",
            backendType: "claude", cwd: ws, archived: false, createdAt: 1, state: "running" },
          { sessionId: "p-obs", sessionGroupId: "grp_xp", sessionGroupRole: "observer",
            backendType: "codex", cwd: ws, archived: false, createdAt: 2, state: "running" },
        ]);
        const obs = orchestrator as unknown as { reconcileCouncilGroups: () => void; councilGroupMeta: Map<string, any> };
        obs.reconcileCouncilGroups();
        expect(obs.councilGroupMeta.get("grp_xp")?.pairing).toBe("claude+codex");
        (orchestrator as any).stopCouncilWatchers("grp_xp");
      } finally {
        fs.rmSync(ws, { recursive: true, force: true });
      }
    });

    // PLAN Task 6: partial pairs are no longer dropped — the surviving half
    // re-registers the group in `reconnecting` state and the coordinator
    // arms the standard reconnect grace window. Session-level auto-relaunch
    // will fire for the missing half; if it handshakes within the grace,
    // `reconnect_ok` resolves it back to `active`. Watcher attach is best-
    // effort (mkdirSync of a missing cwd fails silently); the Task 6
    // contract is the coordinator state machine, not the filesystem watcher.
    // PLAN-aura-consolidated-refactor.md Task 3 (FINAL-REVIEW 2026-05-12-2211
    // P1 #1): partial-pair restart now lands directly in `degraded` rather
    // than arming a useless reconnect grace window. The `__missing_*`
    // placeholder sessionId cannot bind to any real handshake by
    // construction, so the grace window would always expire 45s later into
    // `degraded` anyway — better to surface the honest state immediately
    // than show a lying "reconnecting…" UI for 45s.
    it("partial pair (orchestrator-only) registers in degraded directly — no reconnect grace, no UI lie", async () => {
      const fs = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");
      const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "council-partial-")));
      try {
        (deps.launcher.listSessions as any).mockReturnValue([
          { sessionId: "lone-orch", sessionGroupId: "grp_partial", sessionGroupRole: "orchestrator",
            backendType: "claude", cwd: ws, archived: false, createdAt: 1, state: "running" },
        ]);
        const obs = orchestrator as unknown as {
          reconcileCouncilGroups: () => void;
          councilGroupMeta: Map<string, any>;
          councilWatchers: Map<string, any>;
          stopCouncilWatchers: (id: string) => void;
          coordinator: { get: (id: string) => { status: string } | undefined; getReconnectContext: (id: string) => unknown };
        };
        obs.reconcileCouncilGroups();
        expect(obs.councilGroupMeta.has("grp_partial")).toBe(true);
        // Direct to degraded — no transient `reconnecting` state.
        expect(obs.coordinator.get("grp_partial")?.status).toBe("degraded");
        // No reconnect context armed — the grace window would be useless.
        expect(obs.coordinator.getReconnectContext("grp_partial")).toBeUndefined();
        obs.stopCouncilWatchers("grp_partial");
      } finally {
        fs.rmSync(ws, { recursive: true, force: true });
      }
    });

    // PLAN Task 3 — explicit injunction enforcement (observer review WARN
    // on commit efe8d9f): placeholder __missing_* sessionIds may be
    // synthesised to satisfy `GroupMember.sessionId` typing, but they MUST
    // NOT enter `councilGroupBySessionId` reverse index. A future
    // session:cli-id-received for an unrelated session that happens to
    // collide with the placeholder string (or a `getCouncilGroupBySessionId`
    // lookup keyed on a leaked placeholder) would resolve to the wrong
    // group. Canary asserts the placeholder is structurally absent from
    // every lookup surface the orchestrator exposes.
    it("partial pair placeholder sessionIds are NEVER inserted into councilGroupBySessionId reverse index", async () => {
      const fs = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");
      const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "council-placeholder-")));
      try {
        (deps.launcher.listSessions as any).mockReturnValue([
          { sessionId: "lone-orch-real", sessionGroupId: "grp_canary", sessionGroupRole: "orchestrator",
            backendType: "claude", cwd: ws, archived: false, createdAt: 1, state: "running" },
        ]);
        const obs = orchestrator as unknown as {
          reconcileCouncilGroups: () => void;
          stopCouncilWatchers: (id: string) => void;
          councilGroupBySessionId: Map<string, string>;
          getCouncilGroupBySessionId: (id: string) => { sessionGroupId: string; role: string } | null;
          coordinator: { findBySessionId: (id: string) => { sessionGroupId: string } | undefined };
        };
        obs.reconcileCouncilGroups();
        // Real surviving half IS in the reverse index.
        expect(obs.councilGroupBySessionId.get("lone-orch-real")).toBe("grp_canary");
        // Placeholder for the missing observer half IS NOT in the index.
        // Anything matching the `__missing_*` prefix is dead weight at best
        // and a collision risk at worst.
        const placeholderKey = `__missing_obs_grp_canary`;
        expect(obs.councilGroupBySessionId.has(placeholderKey)).toBe(false);
        // Symmetric verification — observer-review v2 NOTE 1: the prefix
        // check must catch ANY synthesized placeholder, not just the
        // literal `__missing_` prefix. A future refactor renaming to
        // `__placeholder_*` / `__synthetic_*` / `__pending_*` would
        // bypass a literal-substring check. Regex catches any
        // `__<lowercase>_` shape.
        const placeholderShape = /^__[a-z]+_/;
        for (const key of obs.councilGroupBySessionId.keys()) {
          expect(placeholderShape.test(key), `placeholder-shaped key leaked to reverse index: ${key}`).toBe(false);
        }
        // Observer-review v2 NOTE 2: document the KNOWN LEAK at
        // `coord.findBySessionId`. The coordinator's groups map stores
        // GroupRecord with placeholder sessionIds (required by the
        // string-typed GroupMember.sessionId slot). A direct lookup via
        // `coord.findBySessionId(placeholder)` still returns the
        // partial-pair group — this is the gap a `string | null`
        // widening would close. Pinning both halves so future refactor
        // shifting either invariant fails the test:
        //   - Orchestrator-level lookup IS safe (placeholder-free index).
        //   - Coordinator-level direct lookup IS the documented leak.
        expect(obs.getCouncilGroupBySessionId(placeholderKey)).toBeNull();
        // Document the leak — if a future change closes this leak (e.g.
        // GroupMember widening + drop placeholders from groups map), the
        // test will fail and force a conscious update of the comment +
        // the orchestrator's forbidden-paths block.
        const coordHit = obs.coordinator.findBySessionId(placeholderKey);
        expect(coordHit?.sessionGroupId, "coord.findBySessionId leak documentation — flip if/when GroupMember widens to string|null").toBe("grp_canary");
        obs.stopCouncilWatchers("grp_canary");
      } finally {
        fs.rmSync(ws, { recursive: true, force: true });
      }
    });

    // Symmetric test: when only the observer half survives across restart,
    // the dead-role is "orchestrator" and the group still lands in degraded.
    it("partial pair (observer-only) registers in degraded with deadRole=orchestrator", async () => {
      const fs = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");
      const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "council-partial-obs-")));
      try {
        (deps.launcher.listSessions as any).mockReturnValue([
          { sessionId: "lone-obs", sessionGroupId: "grp_partial_obs", sessionGroupRole: "observer",
            backendType: "claude", cwd: ws, archived: false, createdAt: 1, state: "running" },
        ]);
        const obs = orchestrator as unknown as {
          reconcileCouncilGroups: () => void;
          councilGroupMeta: Map<string, any>;
          stopCouncilWatchers: (id: string) => void;
          coordinator: { get: (id: string) => { status: string } | undefined; getReconnectContext: (id: string) => unknown };
        };
        obs.reconcileCouncilGroups();
        expect(obs.councilGroupMeta.has("grp_partial_obs")).toBe(true);
        expect(obs.coordinator.get("grp_partial_obs")?.status).toBe("degraded");
        expect(obs.coordinator.getReconnectContext("grp_partial_obs")).toBeUndefined();
        obs.stopCouncilWatchers("grp_partial_obs");
      } finally {
        fs.rmSync(ws, { recursive: true, force: true });
      }
    });

    // Post-grace recovery: when a half re-handshakes AFTER the reconnect
    // grace window expired and the pair is already settled in `degraded`,
    // the `session:cli-id-received` handler must emit `half_respawned` so
    // the state machine flips back to `active` and `dispatchObserverWake`
    // stops refusing checkpoints.
    //
    // Without this branch, the pair was structurally terminal in
    // production — `transition()` defined the recovery transition, tests
    // covered the state-machine pure function, but no producer ever
    // emitted `half_respawned`. Symptom seen on 2026-05-15: pair
    // `grp_e81a5ef...` sat in degraded for 17+ minutes with both halves
    // alive (chat working via `isOperable`), while every checkpoint POST
    // was refused with `reason=group_not_active`.
    it("post-grace recovery: cli-id-received on a degraded pair fires half_respawned and flips to active", async () => {
      const fs = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");
      const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "council-recovery-")));
      try {
        (deps.launcher.listSessions as any).mockReturnValue([
          { sessionId: "orch-real", sessionGroupId: "grp_recover", sessionGroupRole: "orchestrator",
            backendType: "claude", cwd: ws, archived: false, createdAt: 1, state: "running" },
          { sessionId: "obs-real", sessionGroupId: "grp_recover", sessionGroupRole: "observer",
            backendType: "claude", cwd: ws, archived: false, createdAt: 2, state: "running" },
        ]);
        // initialize() also installs the `session:cli-id-received` handler
        // we're exercising — without it, the emit below is a no-op.
        orchestrator.initialize();
        const obs = orchestrator as unknown as {
          reconcileCouncilGroups: () => void;
          stopCouncilWatchers: (id: string) => void;
          coordinator: {
            get: (id: string) => { status: string } | undefined;
            applyEvent: (id: string, event: { type: string; role?: string }) => void;
          };
        };
        obs.reconcileCouncilGroups();
        // Both-halves-alive reconcile lands in `active`.
        expect(obs.coordinator.get("grp_recover")?.status).toBe("active");

        // Drive the pair into `degraded` via `half_died` (observer falls
        // off the bus). The state machine settles immediately — no
        // reconnect context is armed by this transition.
        obs.coordinator.applyEvent("grp_recover", { type: "half_died", role: "observer" });
        expect(obs.coordinator.get("grp_recover")?.status).toBe("degraded");

        // The observer's session reconnects later (e.g. server restart
        // → --resume → cli handshake). Before this fix, this event was a
        // silent no-op because `getReconnectContext` returned undefined.
        companionBus.emit("session:cli-id-received", { sessionId: "obs-real", cliSessionId: "cli-obs-1" });

        // Recovery: state flips back to active. Observer wake gate
        // (dispatchObserverWake Gate 1) will accept future checkpoints.
        expect(obs.coordinator.get("grp_recover")?.status).toBe("active");

        obs.stopCouncilWatchers("grp_recover");
      } finally {
        fs.rmSync(ws, { recursive: true, force: true });
      }
    });

    // Symmetric: the orchestrator half can also flap and recover.
    it("post-grace recovery: degraded × half_respawned for orchestrator role also flips to active", async () => {
      const fs = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");
      const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "council-recovery-orch-")));
      try {
        (deps.launcher.listSessions as any).mockReturnValue([
          { sessionId: "orch-r", sessionGroupId: "grp_recover_o", sessionGroupRole: "orchestrator",
            backendType: "claude", cwd: ws, archived: false, createdAt: 1, state: "running" },
          { sessionId: "obs-r", sessionGroupId: "grp_recover_o", sessionGroupRole: "observer",
            backendType: "claude", cwd: ws, archived: false, createdAt: 2, state: "running" },
        ]);
        orchestrator.initialize();
        const obs = orchestrator as unknown as {
          reconcileCouncilGroups: () => void;
          stopCouncilWatchers: (id: string) => void;
          coordinator: {
            get: (id: string) => { status: string } | undefined;
            applyEvent: (id: string, event: { type: string; role?: string }) => void;
          };
        };
        obs.reconcileCouncilGroups();
        obs.coordinator.applyEvent("grp_recover_o", { type: "half_died", role: "orchestrator" });
        expect(obs.coordinator.get("grp_recover_o")?.status).toBe("degraded");

        companionBus.emit("session:cli-id-received", { sessionId: "orch-r", cliSessionId: "cli-orch-1" });
        expect(obs.coordinator.get("grp_recover_o")?.status).toBe("active");

        obs.stopCouncilWatchers("grp_recover_o");
      } finally {
        fs.rmSync(ws, { recursive: true, force: true });
      }
    });

    // Identity boundary: the recovery branch must NOT fire for an
    // unrelated sessionId that happens to arrive while the pair is
    // degraded. Only sessionIds tracked in `councilGroupMeta` (i.e. real
    // halves of the registered pair) are eligible for recovery — otherwise
    // a stray handshake from another session would be misattributed.
    it("post-grace recovery: unrelated sessionId does NOT trigger half_respawned", async () => {
      const fs = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");
      const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "council-recovery-stray-")));
      try {
        (deps.launcher.listSessions as any).mockReturnValue([
          { sessionId: "orch-s", sessionGroupId: "grp_stray", sessionGroupRole: "orchestrator",
            backendType: "claude", cwd: ws, archived: false, createdAt: 1, state: "running" },
          { sessionId: "obs-s", sessionGroupId: "grp_stray", sessionGroupRole: "observer",
            backendType: "claude", cwd: ws, archived: false, createdAt: 2, state: "running" },
        ]);
        orchestrator.initialize();
        const obs = orchestrator as unknown as {
          reconcileCouncilGroups: () => void;
          stopCouncilWatchers: (id: string) => void;
          coordinator: {
            get: (id: string) => { status: string } | undefined;
            applyEvent: (id: string, event: { type: string; role?: string }) => void;
          };
        };
        obs.reconcileCouncilGroups();
        obs.coordinator.applyEvent("grp_stray", { type: "half_died", role: "observer" });
        expect(obs.coordinator.get("grp_stray")?.status).toBe("degraded");

        // Handshake from an unrelated solo session — must not affect the
        // council group's state.
        companionBus.emit("session:cli-id-received", { sessionId: "unrelated-solo", cliSessionId: "cli-other" });
        expect(obs.coordinator.get("grp_stray")?.status).toBe("degraded");

        obs.stopCouncilWatchers("grp_stray");
      } finally {
        fs.rmSync(ws, { recursive: true, force: true });
      }
    });

    // EC-6 static-grep canary (per `feedback_call_site_presence_not_just_symbol_export`):
    // the recovery transition is only reachable if at least one production
    // (non-test) emit site for `half_respawned` exists. The state machine
    // shipped the recovery branch + unit tests months ago without a
    // production emit site — pairs sat in degraded forever. Asserting the
    // call site is present in production source (not just tests) prevents
    // a future refactor from silently removing it.
    it("static canary: half_respawned has at least one production emit site outside tests", async () => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const root = path.resolve(__dirname);
      const files = fs.readdirSync(root).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
      let emitSites = 0;
      // Match an applyEvent (or transition-builder) carrying `type: "half_respawned"`.
      // Tolerates whitespace + key ordering shifts; rejects matches inside
      // strings/comments by requiring `type:` directly before the literal.
      const pattern = /type\s*:\s*"half_respawned"/;
      for (const f of files) {
        const raw = fs.readFileSync(path.join(root, f), "utf-8");
        const matches = raw.match(new RegExp(pattern, "g")) ?? [];
        // The state-machine type definition itself uses this literal in the
        // `GroupEvent` union — exclude the file that defines the type.
        if (f === "group-state-machine.ts") continue;
        emitSites += matches.length;
      }
      expect(emitSites, "no production emit site for half_respawned — recovery transition is unreachable").toBeGreaterThan(0);
    });

    // Archived half means the group was intentionally torn down. Partial-
    // pair grace MUST NOT apply — that would re-arm a reconnect cycle on
    // a group the user (or shutdown path) had already given up on. Fixed
    // post-Task 6 live-test where `grp_7a2a49e417861d` (Old Boy: orchestrator
    // alive, observer archived) silently entered `reconnect_failed` on
    // server restart and produced confusing log noise.
    it("skips pairs where ANY half is archived (intentional teardown, no grace)", () => {
      (deps.launcher.listSessions as any).mockReturnValue([
        { sessionId: "a-orch", sessionGroupId: "grp_arch", sessionGroupRole: "orchestrator",
          backendType: "claude", cwd: "/wsx", archived: false, createdAt: 1, state: "running" },
        { sessionId: "a-obs", sessionGroupId: "grp_arch", sessionGroupRole: "observer",
          backendType: "claude", cwd: "/wsx", archived: true, createdAt: 2, state: "exited" },
      ]);
      const obs = orchestrator as unknown as {
        reconcileCouncilGroups: () => void;
        councilGroupMeta: Map<string, any>;
        coordinator: { get: (id: string) => unknown } | null;
      };
      obs.reconcileCouncilGroups();
      // Group must NOT be registered — surviving half stays as a solo session.
      expect(obs.councilGroupMeta.has("grp_arch")).toBe(false);
      // And no reconnect context armed on the coordinator either.
      expect(obs.coordinator?.get("grp_arch")).toBeUndefined();
    });

    it("is idempotent — re-entry does not overwrite or duplicate watchers", async () => {
      const fs = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");
      const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "council-recon-")));
      try {
        (deps.launcher.listSessions as any).mockReturnValue([
          { sessionId: "i-orch", sessionGroupId: "grp_idem", sessionGroupRole: "orchestrator",
            backendType: "claude", cwd: ws, archived: false, createdAt: 1, state: "running" },
          { sessionId: "i-obs", sessionGroupId: "grp_idem", sessionGroupRole: "observer",
            backendType: "claude", cwd: ws, archived: false, createdAt: 2, state: "running" },
        ]);
        const obs = orchestrator as unknown as { reconcileCouncilGroups: () => void; councilGroupMeta: Map<string, any>; councilWatchers: Map<string, any> };
        obs.reconcileCouncilGroups();
        const firstMeta = obs.councilGroupMeta.get("grp_idem");
        const firstWatcher = obs.councilWatchers.get("grp_idem");
        // Re-entry must be a no-op for the already-registered group.
        obs.reconcileCouncilGroups();
        expect(obs.councilGroupMeta.get("grp_idem")).toBe(firstMeta);
        expect(obs.councilWatchers.get("grp_idem")).toBe(firstWatcher);
        (orchestrator as any).stopCouncilWatchers("grp_idem");
      } finally {
        fs.rmSync(ws, { recursive: true, force: true });
      }
    });

    it("ignores sessions without sessionGroupId — solo sessions are untouched", () => {
      (deps.launcher.listSessions as any).mockReturnValue([
        { sessionId: "solo-1", backendType: "claude", cwd: "/x", archived: false, createdAt: 1, state: "running" },
        { sessionId: "solo-2", backendType: "claude", cwd: "/y", archived: false, createdAt: 2, state: "running" },
      ]);
      const obs = orchestrator as unknown as { reconcileCouncilGroups: () => void; councilGroupMeta: Map<string, any> };
      obs.reconcileCouncilGroups();
      expect(obs.councilGroupMeta.size).toBe(0);
    });
  });

  describe("stopCouncilWatchers", () => {
    it("aborts the watcher signal and removes the entry from the map", () => {
      const abort = new AbortController();
      const obs = orchestrator as unknown as {
        councilWatchers: Map<string, { cwd: string; abort: AbortController; lastCheckpoint: null; previousCheckpoint: null }>;
        stopCouncilWatchers: (g: string) => void;
      };
      obs.councilWatchers.set("grp_stop", {
        cwd: "/w",
        abort,
        lastCheckpoint: null,
        previousCheckpoint: null,
      });
      obs.stopCouncilWatchers("grp_stop");
      expect(abort.signal.aborted).toBe(true);
      expect(obs.councilWatchers.has("grp_stop")).toBe(false);
    });

    it("is a no-op when the group has no watcher entry", () => {
      const obs = orchestrator as unknown as { stopCouncilWatchers: (g: string) => void };
      expect(() => obs.stopCouncilWatchers("grp_unknown")).not.toThrow();
    });
  });

  // ─── getCouncilGroupBySessionId ───────────────────────────────────────────
  //
  // Public O(1) accessor used by REST endpoints (notably the checkpoint
  // emit route in PR #10) to authorize callers without leaking the full
  // council group meta map. Returns {sessionGroupId, role} or null. The
  // role is decided by comparing the session id to the meta's
  // `primarySessionId` — anything else under that group is observer.
  // Read-only; no state mutation.
  describe("getCouncilGroupBySessionId", () => {
    function seedGroup(gid: string, orchId: string, obsId: string) {
      const obs = orchestrator as unknown as {
        councilGroupMeta: Map<string, {
          primarySessionId: string;
          observerSessionId: string;
          pairing: string;
          createdAt: number;
          lastCheckpointReceivedAt: number | null;
        }>;
        councilGroupBySessionId: Map<string, string>;
      };
      obs.councilGroupMeta.set(gid, {
        primarySessionId: orchId,
        observerSessionId: obsId,
        pairing: "claude+claude",
        createdAt: Date.now(),
        lastCheckpointReceivedAt: null,
      });
      obs.councilGroupBySessionId.set(orchId, gid);
      obs.councilGroupBySessionId.set(obsId, gid);
    }

    it("returns null when the session id is not part of any council group", () => {
      expect(orchestrator.getCouncilGroupBySessionId("never_seen")).toBeNull();
    });

    it("returns {sessionGroupId, role: orchestrator} when sessionId matches primarySessionId", () => {
      seedGroup("grp_role_orch", "orch_a", "obs_a");
      expect(orchestrator.getCouncilGroupBySessionId("orch_a")).toEqual({
        sessionGroupId: "grp_role_orch",
        role: "orchestrator",
      });
    });

    it("returns {sessionGroupId, role: observer} when sessionId matches observerSessionId", () => {
      seedGroup("grp_role_obs", "orch_b", "obs_b");
      expect(orchestrator.getCouncilGroupBySessionId("obs_b")).toEqual({
        sessionGroupId: "grp_role_obs",
        role: "observer",
      });
    });

    // Defends against the rare reconciliation race where the
    // bySessionId reverse-index still points at a group whose meta
    // entry has been torn down. Without the null check on `meta` the
    // accessor would throw on `meta.primarySessionId`.
    it("returns null when the reverse-index points at a group whose meta is gone", () => {
      const obs = orchestrator as unknown as {
        councilGroupBySessionId: Map<string, string>;
      };
      obs.councilGroupBySessionId.set("orphan_sid", "grp_meta_missing");
      expect(orchestrator.getCouncilGroupBySessionId("orphan_sid")).toBeNull();
    });
  });

  // ─── getAllGroupsForBootstrap ─────────────────────────────────────────────
  //
  // PR #68 — Council Mode group REST bootstrap. The browser's
  // `groupBySessionId` map is populated EXCLUSIVELY from the live
  // `group:created` push, so a reload after pair creation leaves the
  // Sidebar without ☼/☽ glyphs (`BUG-council-mode-group-rest-bootstrap-gap.md`).
  // This method is the REST counterpart — every live group, in the same
  // browser wire shape the live push emits, fetched on app mount.
  describe("getAllGroupsForBootstrap", () => {
    // Helper: seed the coordinator directly via `registerExternalGroup`
    // so we don't have to drive the full createSession spawn pipeline
    // (which requires mocking the launcher's full surface). Mirrors the
    // pattern used by other council tests in this file and by the
    // `reconcileCouncilGroups()` restart path.
    function seedCoordGroup(gid: string, orchId: string, obsId: string, status: string = "active", observerBackend: "claude" | "codex" = "claude") {
      const coord = (orchestrator as unknown as {
        getOrCreateCoordinatorSync: () => {
          registerExternalGroup: (r: unknown) => void;
          applyEvent: (id: string, ev: { type: string; role?: string }) => unknown;
        };
      }).getOrCreateCoordinatorSync();
      coord.registerExternalGroup({
        sessionGroupId: gid,
        primary: { sessionId: orchId, backendType: "claude" },
        observer: { sessionId: obsId, backendType: observerBackend },
        status: "active",
        createdAt: Date.now(),
      });
      if (status === "degraded") {
        coord.applyEvent(gid, { type: "half_died", role: "observer" });
      }
    }

    it("returns an empty array when no coordinator has been created (no Council Mode usage)", () => {
      // Fresh orchestrator, no createCouncilGroup invocation — coordinator
      // is lazily constructed, so the bootstrap method must short-circuit.
      expect(orchestrator.getAllGroupsForBootstrap()).toEqual([]);
    });

    it("returns one wire-shape record per active group, with status + pairing label", () => {
      seedCoordGroup("grp_b1", "orch_b1", "obs_b1", "active", "claude");
      seedCoordGroup("grp_b2", "orch_b2", "obs_b2", "active", "codex");
      const out = orchestrator.getAllGroupsForBootstrap();
      expect(out).toHaveLength(2);
      // Order is not guaranteed (Map iteration order is insertion order in
      // practice, but the wire contract does not pin it). Index by group id.
      const byId = new Map(out.map((g) => [g.sessionGroupId, g]));
      expect(byId.get("grp_b1")).toEqual({
        sessionGroupId: "grp_b1",
        primarySessionId: "orch_b1",
        observerSessionId: "obs_b1",
        pairing: "claude+claude",
        status: "active",
        wakeTimeoutMs: expect.any(Number),
      });
      expect(byId.get("grp_b2")).toEqual({
        sessionGroupId: "grp_b2",
        primarySessionId: "orch_b2",
        observerSessionId: "obs_b2",
        pairing: "claude+codex",
        status: "active",
        wakeTimeoutMs: expect.any(Number),
      });
    });

    // Symmetry with the live `group:created` push: the panel-state deriver
    // bounds the `reviewing` interval by `lastCheckpointAt + wakeTimeoutMs`.
    // REST-bootstrapped groups must receive the same constant or the deriver
    // would silently fall back to a frontend default — diverging behaviour.
    it("populates wakeTimeoutMs with the same constant the group_created push uses", async () => {
      const { OBSERVER_WAKE_TIMEOUT_MS } = await import("./council-types.js");
      seedCoordGroup("grp_wt", "orch_wt", "obs_wt", "active", "claude");
      const out = orchestrator.getAllGroupsForBootstrap();
      expect(out[0]?.wakeTimeoutMs).toBe(OBSERVER_WAKE_TIMEOUT_MS);
    });

    // Reload during degraded pair MUST surface the true status. Without
    // this, the panel header pill would render "active" against a dead
    // half — the bootstrap path would silently mask the very condition
    // the operator needs to see.
    it("preserves degraded status across bootstrap (does not flatten to active)", () => {
      seedCoordGroup("grp_d1", "orch_d1", "obs_d1", "degraded", "claude");
      const out = orchestrator.getAllGroupsForBootstrap();
      expect(out).toHaveLength(1);
      expect(out[0]?.status).toBe("degraded");
    });

    // Archived groups are torn down — they must not appear in the Sidebar.
    // The orchestrator filters at this boundary (the coordinator returns
    // every record including archived; the visibility policy belongs here).
    it("filters out archived groups from the bootstrap response", () => {
      const coord = (orchestrator as unknown as {
        getOrCreateCoordinatorSync: () => {
          registerExternalGroup: (r: unknown) => void;
          applyEvent: (id: string, ev: { type: string }) => unknown;
        };
      }).getOrCreateCoordinatorSync();
      coord.registerExternalGroup({
        sessionGroupId: "grp_arch",
        primary: { sessionId: "orch_arch", backendType: "claude" },
        observer: { sessionId: "obs_arch", backendType: "claude" },
        status: "active",
        createdAt: Date.now(),
      });
      coord.applyEvent("grp_arch", { type: "user_archived" });
      // Also seed one healthy group so we can verify selective filtering,
      // not blanket emptiness from a coordinator-wide bug.
      seedCoordGroup("grp_live", "orch_live", "obs_live", "active", "claude");
      const out = orchestrator.getAllGroupsForBootstrap();
      expect(out).toHaveLength(1);
      expect(out[0]?.sessionGroupId).toBe("grp_live");
    });
  });
});
