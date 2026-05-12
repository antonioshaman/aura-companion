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
    prePopulateCommands: vi.fn(),
    broadcastNameUpdate: vi.fn(),
    broadcastToSession: vi.fn(),
    broadcastToGroup: vi.fn(),
    injectUserMessage: vi.fn(),
    injectSystemPrompt: vi.fn(),
    attachBackendAdapter: vi.fn(),
    cancelDisconnectTimer: vi.fn(() => false),
    setCouncilContext: vi.fn(),
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

    it("CLI session ID callback delegates to launcher.setCLISessionId", () => {
      orchestrator.initialize();

      // Emit event on the bus instead of extracting callback
      companionBus.emit("session:cli-id-received", { sessionId: "s1", cliSessionId: "cli-id-123" });

      expect(deps.launcher.setCLISessionId).toHaveBeenCalledWith("s1", "cli-id-123");
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

    it("drives group:degraded when an unintentional `session:exited` hits a council-tracked half", () => {
      vi.mocked(deps.launcher.listSessions).mockReturnValue([
        { sessionId: "sess_orch_t4", sessionGroupId: "grp_t4", state: "running", cwd: "/w", createdAt: 0 } as any,
      ]);
      const obs = orchestrator as unknown as { councilGroupMeta: Map<string, { primarySessionId: string; observerSessionId: string; pairing: string; createdAt: number; lastCheckpointReceivedAt: number | null }> };
      obs.councilGroupMeta.set("grp_t4", {
        primarySessionId: "sess_orch_t4",
        observerSessionId: "sess_obs_t4",
        pairing: "claude+codex",
        createdAt: Date.now(),
        lastCheckpointReceivedAt: null,
      });
      companionBus.emit("session:exited", { sessionId: "sess_obs_t4", exitCode: 1 });
      const calls = vi.mocked(deps.wsBridge.broadcastToGroup).mock.calls;
      const degraded = calls.find((c: unknown[]) => (c[1] as { type?: string }).type === "group_degraded");
      expect(degraded).toBeDefined();
      expect(degraded?.[1]).toMatchObject({ type: "group_degraded", sessionGroupId: "grp_t4", deadRole: "observer" });
      // EC-2: BOTH halves added to intentionalKills BEFORE the degrade signal emits.
      const intentional = (orchestrator as unknown as { intentionalKills: Set<string> }).intentionalKills;
      expect(intentional.has("sess_orch_t4")).toBe(true);
      expect(intentional.has("sess_obs_t4")).toBe(true);
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

    // The observer half runs `claude --input-format stream-json` and stays
    // blocked at pre-init until the bridge injects a user_message — its
    // only input channel is the WS, and no human types into it. Before this
    // wiring the checkpoint→browser fanout existed but nothing wrote back
    // to the observer's CLI, so the watcher waited forever for a review
    // file the observer was never asked to produce. This test pins the
    // dispatch call so a future refactor can't silently regress to the
    // dangling-symbol state described in
    // `specs/council-mode-residual-fixes-2026-05-11-2251.md`.
    it("injects the manifest as a user_message into the observer CLI", () => {
      seedWatcherEntry("grp_disp_1");
      const meta = (orchestrator as unknown as {
        councilGroupMeta: Map<string, { primarySessionId: string; observerSessionId: string; pairing: string; createdAt: number; lastCheckpointReceivedAt: number | null }>;
      }).councilGroupMeta;
      meta.set("grp_disp_1", {
        primarySessionId: "sess_orch_disp",
        observerSessionId: "sess_obs_disp",
        pairing: "claude+claude",
        createdAt: Date.now(),
        lastCheckpointReceivedAt: null,
      });
      const inject = deps.wsBridge.injectUserMessage as ReturnType<typeof vi.fn>;
      inject.mockClear();

      const handle = (orchestrator as unknown as {
        handleCouncilCheckpoint: (g: string, p: { schema_version: 1; checkpoint_id: string; phase: string; sequence: number; session_group_id: string; emitted_at: string; artifact_paths: string[] }) => void;
      }).handleCouncilCheckpoint;
      handle.call(orchestrator, "grp_disp_1", {
        schema_version: 1,
        checkpoint_id: "chk_disp",
        phase: "council-plan",
        sequence: 0,
        session_group_id: "grp_disp_1",
        emitted_at: "2026-01-01T00:00:00Z",
        artifact_paths: ["src/a.ts", "src/b.ts"],
      });

      expect(inject).toHaveBeenCalledTimes(1);
      const [sid, body] = inject.mock.calls[0]!;
      expect(sid).toBe("sess_obs_disp");
      expect(typeof body).toBe("string");
      // Manifest must carry the identity triple — observer echoes them
      // back into the review file so review-watcher can pair it to the
      // checkpoint that produced it.
      expect(body).toContain("checkpoint_id: chk_disp");
      expect(body).toContain("phase: council-plan");
      expect(body).toContain("session_group_id: grp_disp_1");
      // First checkpoint → all paths are delta. Each artifact must appear
      // verbatim so the observer doesn't read from a stale cached set.
      expect(body).toContain("src/a.ts");
      expect(body).toContain("src/b.ts");
    });

    // Group meta absence is a real production state: a checkpoint can
    // race a `group:exited` event during shutdown. Dispatch must skip
    // silently rather than crash the watcher loop.
    it("skips dispatch when group meta is missing (race with archive)", () => {
      seedWatcherEntry("grp_disp_2");
      const inject = deps.wsBridge.injectUserMessage as ReturnType<typeof vi.fn>;
      inject.mockClear();
      const handle = (orchestrator as unknown as {
        handleCouncilCheckpoint: (g: string, p: Record<string, unknown>) => void;
      }).handleCouncilCheckpoint;
      handle.call(orchestrator, "grp_disp_2", {
        schema_version: 1,
        checkpoint_id: "chk_x",
        phase: "p",
        sequence: 0,
        session_group_id: "grp_disp_2",
        emitted_at: "2026-01-01T00:00:00Z",
        artifact_paths: ["src/a.ts"],
      });
      expect(inject).not.toHaveBeenCalled();
    });

    // Subsequent checkpoints must inject only the delta paths, not the
    // cumulative artifact set. The `buildObserverContextManifest` partition
    // already enforces this for grounding; this test pins that the same
    // partition is used for dispatch so the observer reads the changed
    // surface, not the growing tree.
    it("dispatches only delta paths on a follow-up checkpoint, with carried paths labelled separately", () => {
      seedWatcherEntry("grp_disp_3", {
        lastCheckpoint: { sequence: 0, checkpoint_id: "chk_prev", phase: "p", artifact_paths: ["src/a.ts", "src/b.ts"] },
      });
      const meta = (orchestrator as unknown as {
        councilGroupMeta: Map<string, { primarySessionId: string; observerSessionId: string; pairing: string; createdAt: number; lastCheckpointReceivedAt: number | null }>;
      }).councilGroupMeta;
      meta.set("grp_disp_3", {
        primarySessionId: "sess_orch_3",
        observerSessionId: "sess_obs_3",
        pairing: "claude+claude",
        createdAt: Date.now(),
        lastCheckpointReceivedAt: null,
      });
      const inject = deps.wsBridge.injectUserMessage as ReturnType<typeof vi.fn>;
      inject.mockClear();
      const handle = (orchestrator as unknown as {
        handleCouncilCheckpoint: (g: string, p: Record<string, unknown>) => void;
      }).handleCouncilCheckpoint;
      handle.call(orchestrator, "grp_disp_3", {
        schema_version: 1,
        checkpoint_id: "chk_next",
        phase: "p",
        sequence: 1,
        session_group_id: "grp_disp_3",
        emitted_at: "2026-01-01T00:00:00Z",
        artifact_paths: ["src/a.ts", "src/c.ts"], // a carried, c delta, b dropped
      });
      expect(inject).toHaveBeenCalledTimes(1);
      const body = inject.mock.calls[0]![1] as string;
      // c.ts must appear under the "Modified files this cycle" header.
      const modifiedHeader = body.indexOf("Modified files this cycle");
      const carriedHeader = body.indexOf("Carried from previous checkpoint");
      expect(modifiedHeader).toBeGreaterThanOrEqual(0);
      expect(carriedHeader).toBeGreaterThan(modifiedHeader);
      const modifiedSection = body.slice(modifiedHeader, carriedHeader);
      const carriedSection = body.slice(carriedHeader);
      expect(modifiedSection).toContain("src/c.ts");
      expect(carriedSection).toContain("src/a.ts");
      // b.ts was dropped — must NOT be re-fed; the system prompt enforces
      // "do not re-read dropped" so even mentioning it risks confusing
      // the observer back into reading it.
      expect(body).not.toContain("src/b.ts");
    });
  });

  // maybeEmitAutoCheckpoint is the natural-cadence wake gate added to close
  // the "observer stays silent during ordinary chat workflows" gap. It listens
  // on `message:result` (turn completion) for any orchestrator-half of a
  // council pair, computes `git status --porcelain` against the workspace,
  // and emits an `auto-turn-<N>.json` checkpoint into `.council/checkpoints/`
  // when changes exist. The existing checkpoint-watcher + handleCouncilCheckpoint
  // path then dispatches the manifest to the observer CLI as normal.
  //
  // These tests pin: (1) the orchestrator-only filter, (2) the empty-change
  // skip, (3) the throttle window, (4) the `.council/` path filter that
  // prevents the observer's own review writes from re-waking it.
  describe("maybeEmitAutoCheckpoint", () => {
    type AutoTestCtx = {
      workspace: string;
      cleanup: () => void;
    };
    function setupTmpRepo(): AutoTestCtx {
      const { execSync } = require("node:child_process") as typeof import("node:child_process");
      const { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } = require("node:fs") as typeof import("node:fs");
      const { tmpdir } = require("node:os") as typeof import("node:os");
      const { join: pathJoin } = require("node:path") as typeof import("node:path");
      const workspace = realpathSync(mkdtempSync(pathJoin(tmpdir(), "council-auto-")));
      mkdirSync(pathJoin(workspace, ".council", "checkpoints"), { recursive: true });
      execSync("git init -q && git config user.email a@b && git config user.name t && git commit -q --allow-empty -m base", {
        cwd: workspace,
        stdio: ["ignore", "ignore", "ignore"],
      });
      writeFileSync(pathJoin(workspace, "README.md"), "# new\n");
      return {
        workspace,
        cleanup: () => rmSync(workspace, { recursive: true, force: true }),
      };
    }

    function seedAutoGroup(groupId: string, workspace: string, primary: string = "sess_orch_auto"): void {
      const ws = orchestrator as unknown as {
        councilWatchers: Map<string, { cwd: string; abort: AbortController; lastCheckpoint: unknown; previousCheckpoint: unknown }>;
        councilGroupMeta: Map<string, { primarySessionId: string; observerSessionId: string; pairing: string; createdAt: number; lastCheckpointReceivedAt: number | null }>;
        councilAutoCheckpointLast: Map<string, number>;
      };
      ws.councilWatchers.set(groupId, {
        cwd: workspace,
        abort: new AbortController(),
        lastCheckpoint: null,
        previousCheckpoint: null,
      });
      ws.councilGroupMeta.set(groupId, {
        primarySessionId: primary,
        observerSessionId: "sess_obs_auto",
        pairing: "claude+claude",
        createdAt: Date.now(),
        lastCheckpointReceivedAt: null,
      });
      ws.councilAutoCheckpointLast.delete(groupId);
    }

    // Happy path: orchestrator turn completed, working tree dirty → checkpoint
    // file lands at `<cwd>/.council/checkpoints/auto-turn-0.json` with the
    // dirty path in artifact_paths. Verifies the full chain from
    // `message:result` event through `git status --porcelain` through
    // `writeAtomicJson` to the disk artifact the watcher will consume.
    it("emits an auto-checkpoint when orchestrator turn completes with workspace changes", () => {
      const ctx = setupTmpRepo();
      try {
        seedAutoGroup("grp_auto_1", ctx.workspace);
        const handle = (orchestrator as unknown as {
          maybeEmitAutoCheckpoint: (sid: string) => void;
        }).maybeEmitAutoCheckpoint;
        handle.call(orchestrator, "sess_orch_auto");
        const path = require("node:path").join(ctx.workspace, ".council/checkpoints/auto-turn-0.json");
        const exists = require("node:fs").existsSync(path);
        expect(exists).toBe(true);
        const payload = JSON.parse(require("node:fs").readFileSync(path, "utf-8")) as {
          phase: string;
          sequence: number;
          artifact_paths: string[];
          session_group_id: string;
        };
        expect(payload.phase).toBe("auto-turn-0");
        expect(payload.sequence).toBe(0);
        expect(payload.session_group_id).toBe("grp_auto_1");
        expect(payload.artifact_paths).toContain("README.md");
      } finally {
        ctx.cleanup();
      }
    });

    // Clean working tree → skip. No artifact_paths to ground a review
    // against, so emitting would only burn observer LLM tokens on a no-op.
    it("skips emit when working tree is clean (no changes)", () => {
      const ctx = setupTmpRepo();
      try {
        // overwrite README back to committed state via git checkout
        require("node:child_process").execSync("git checkout -- README.md 2>/dev/null || true && git add -A && git commit -q --allow-empty -m clean", {
          cwd: ctx.workspace,
          stdio: ["ignore", "ignore", "ignore"],
        });
        // verify no porcelain output
        const out = require("node:child_process").execSync("git status --porcelain", { cwd: ctx.workspace, encoding: "utf-8" });
        expect(out).toBe("");
        seedAutoGroup("grp_auto_clean", ctx.workspace);
        const handle = (orchestrator as unknown as {
          maybeEmitAutoCheckpoint: (sid: string) => void;
        }).maybeEmitAutoCheckpoint;
        handle.call(orchestrator, "sess_orch_auto");
        const path = require("node:path").join(ctx.workspace, ".council/checkpoints/auto-turn-0.json");
        expect(require("node:fs").existsSync(path)).toBe(false);
      } finally {
        ctx.cleanup();
      }
    });

    // Throttle: a second message:result inside the throttle window must NOT
    // produce a second checkpoint. The artifact on disk after both calls
    // must still be the first one (sequence 0) — a rapid orchestrator that
    // completes 4 turns in 10 seconds should not flood the observer.
    it("throttles repeat emit inside COUNCIL_AUTOCHECKPOINT_THROTTLE_MS", () => {
      const ctx = setupTmpRepo();
      const origEnv = process.env.COMPANION_COUNCIL_AUTOCHECKPOINT_THROTTLE_MS;
      try {
        seedAutoGroup("grp_auto_th", ctx.workspace);
        const handle = (orchestrator as unknown as {
          maybeEmitAutoCheckpoint: (sid: string) => void;
        }).maybeEmitAutoCheckpoint;
        // First emit
        handle.call(orchestrator, "sess_orch_auto");
        const p0 = require("node:path").join(ctx.workspace, ".council/checkpoints/auto-turn-0.json");
        expect(require("node:fs").existsSync(p0)).toBe(true);
        // Second emit immediately — throttle window blocks. No auto-turn-1.
        // Add a second pending change so git status would have new content.
        require("node:fs").writeFileSync(require("node:path").join(ctx.workspace, "B.md"), "b\n");
        handle.call(orchestrator, "sess_orch_auto");
        const p1 = require("node:path").join(ctx.workspace, ".council/checkpoints/auto-turn-1.json");
        expect(require("node:fs").existsSync(p1)).toBe(false);
      } finally {
        if (origEnv === undefined) delete process.env.COMPANION_COUNCIL_AUTOCHECKPOINT_THROTTLE_MS;
        else process.env.COMPANION_COUNCIL_AUTOCHECKPOINT_THROTTLE_MS = origEnv;
        ctx.cleanup();
      }
    });

    // Observer-half message:result must NOT trigger auto-checkpoint. Observer
    // reviews are the OUTPUT of the wake gate; if they themselves triggered
    // another wake, the pair would loop forever on a single dirty path.
    it("is a no-op when called with the observer-half session id (not orchestrator)", () => {
      const ctx = setupTmpRepo();
      try {
        seedAutoGroup("grp_auto_obs", ctx.workspace);
        const handle = (orchestrator as unknown as {
          maybeEmitAutoCheckpoint: (sid: string) => void;
        }).maybeEmitAutoCheckpoint;
        // Call with OBSERVER session id, not orchestrator
        handle.call(orchestrator, "sess_obs_auto");
        const path = require("node:path").join(ctx.workspace, ".council/checkpoints/auto-turn-0.json");
        expect(require("node:fs").existsSync(path)).toBe(false);
      } finally {
        ctx.cleanup();
      }
    });

    // Non-council session must NOT trigger anything. If a regular (non-paired)
    // session's turn completion event reaches the listener, the lookup in
    // councilGroupMeta returns nothing and we exit silently.
    it("is a no-op for non-council session ids", () => {
      const ctx = setupTmpRepo();
      try {
        // No seedAutoGroup — councilGroupMeta empty.
        const handle = (orchestrator as unknown as {
          maybeEmitAutoCheckpoint: (sid: string) => void;
        }).maybeEmitAutoCheckpoint;
        handle.call(orchestrator, "sess_random");
        const path = require("node:path").join(ctx.workspace, ".council/checkpoints/auto-turn-0.json");
        expect(require("node:fs").existsSync(path)).toBe(false);
      } finally {
        ctx.cleanup();
      }
    });

    // `.council/` paths must be filtered from artifact_paths. If the observer
    // writes `story-N-claude-observer.md` and the orchestrator's next turn
    // completes, `git status --porcelain` reports that review file as new
    // workspace change — feeding it back as an artifact would have the
    // observer review its own previous review (feedback loop). The filter
    // strips them before the manifest reaches the watcher.
    it("strips .council/ paths from artifact_paths so observer reviews do not re-wake the observer", () => {
      const ctx = setupTmpRepo();
      try {
        const { writeFileSync, mkdirSync } = require("node:fs") as typeof import("node:fs");
        const { join: pj } = require("node:path") as typeof import("node:path");
        // Simulate an observer review file landing in .council/reviews
        mkdirSync(pj(ctx.workspace, ".council", "reviews"), { recursive: true });
        writeFileSync(pj(ctx.workspace, ".council", "reviews", "x-claude-observer.md"), "{}\n");
        // README.md is still dirty from setupTmpRepo, so we expect at least it
        // in artifact_paths AND the .council/ entry stripped.
        seedAutoGroup("grp_auto_council_filter", ctx.workspace);
        const handle = (orchestrator as unknown as {
          maybeEmitAutoCheckpoint: (sid: string) => void;
        }).maybeEmitAutoCheckpoint;
        handle.call(orchestrator, "sess_orch_auto");
        const path = require("node:path").join(ctx.workspace, ".council/checkpoints/auto-turn-0.json");
        const payload = JSON.parse(require("node:fs").readFileSync(path, "utf-8")) as { artifact_paths: string[] };
        expect(payload.artifact_paths).toContain("README.md");
        for (const p of payload.artifact_paths) {
          expect(p.startsWith(".council/")).toBe(false);
        }
      } finally {
        ctx.cleanup();
      }
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

    // Willison P1#2 sub-a (council residual fix): every STOP finding that
    // survives grounding is wrapped via `wrapObserverFindingForInjection`
    // and pushed into the ORCHESTRATOR half's chat via
    // `wsBridge.injectUserMessage`. The browser receives the same
    // findings via `group:review`, but the orchestrator LLM only sees
    // them via this synthetic injection — the structured envelope with
    // the Willison-P2 preamble is what tells the orchestrator to treat
    // the body as evidence to evaluate, not a command.
    it("injects each surviving STOP into the orchestrator chat with the attribution envelope", () => {
      const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = require("node:fs") as typeof import("node:fs");
      const { tmpdir } = require("node:os") as typeof import("node:os");
      const { join: pathJoin } = require("node:path") as typeof import("node:path");
      const workspace = require("node:fs").realpathSync(mkdtempSync(pathJoin(tmpdir(), "council-inj-")));
      try {
        mkdirSync(pathJoin(workspace, "src"), { recursive: true });
        writeFileSync(pathJoin(workspace, "src/a.ts"), "// in-scope\n");
        seedGroup("grp_inj", {
          cwd: workspace,
          artifactPaths: ["src/a.ts"],
          primary: "sess_orch_inj",
        });
        // Reset the injectUserMessage mock so call shape is unambiguous.
        vi.mocked(deps.wsBridge.injectUserMessage).mockClear();

        const handle = (orchestrator as unknown as {
          handleCouncilReview: (g: string, p: Record<string, unknown>) => void;
        }).handleCouncilReview;
        handle.call(orchestrator, "grp_inj", {
          schema_version: 1,
          checkpoint_id: "chk_a",
          phase: "council-plan",
          session_group_id: "grp_inj",
          reviewed_at: "2026-01-01T00:00:00Z",
          observer_provider: "claude",
          observer_model: "claude-opus-4-7",
          observer_cli_version: "1.0.0",
          findings: [
            { severity: "STOP", claim: "in-scope STOP survives", evidence_path: "src/a.ts" },
            { severity: "STOP", claim: "out-of-scope STOP downgraded", evidence_path: "src/b.ts" },
            { severity: "NOTE", claim: "informational note", evidence_path: "src/a.ts" },
          ],
        });

        // Exactly ONE injection — the surviving STOP. The downgraded STOP
        // became NOTE before reaching the injection loop; the NOTE
        // finding is non-blocking and not injected.
        expect(deps.wsBridge.injectUserMessage).toHaveBeenCalledTimes(1);
        const call = vi.mocked(deps.wsBridge.injectUserMessage).mock.calls[0]!;
        expect(call[0]).toBe("sess_orch_inj");
        const injectedText = call[1] as string;
        // Envelope shape — preamble, opening element with severity="STOP",
        // claim body, closing element. The orchestrator LLM parses these
        // as a single distinct synthetic message, not user instruction.
        expect(injectedText).toContain("automated review from a separate LLM session");
        expect(injectedText).toContain('<observer-finding model="claude-opus-4-7" provider="claude" phase="council-plan" severity="STOP">');
        expect(injectedText).toContain("in-scope STOP survives");
        expect(injectedText).toContain("</observer-finding>");
        // The downgraded STOP must NOT have been injected.
        expect(injectedText).not.toContain("out-of-scope STOP downgraded");
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    });

    // Defensive: an unsafe attribution token (e.g. provider with a `"`
    // character) makes the wrapper throw. The handler must skip that one
    // injection but still process the remaining findings and emit the
    // `group:review` event.
    it("skips a single bad attribution without dropping later findings or the group:review emission", () => {
      const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = require("node:fs") as typeof import("node:fs");
      const { tmpdir } = require("node:os") as typeof import("node:os");
      const { join: pathJoin } = require("node:path") as typeof import("node:path");
      const workspace = require("node:fs").realpathSync(mkdtempSync(pathJoin(tmpdir(), "council-inj-bad-")));
      try {
        mkdirSync(pathJoin(workspace, "src"), { recursive: true });
        writeFileSync(pathJoin(workspace, "src/a.ts"), "// in-scope\n");
        seedGroup("grp_inj_bad", { cwd: workspace, artifactPaths: ["src/a.ts"], primary: "sess_orch_bad" });
        vi.mocked(deps.wsBridge.injectUserMessage).mockClear();
        const emitted: unknown[] = [];
        companionBus.on("group:review", (e: unknown) => { emitted.push(e); });

        const handle = (orchestrator as unknown as {
          handleCouncilReview: (g: string, p: Record<string, unknown>) => void;
        }).handleCouncilReview;
        handle.call(orchestrator, "grp_inj_bad", {
          schema_version: 1,
          checkpoint_id: "chk_a",
          phase: 'unsafe"phase',
          session_group_id: "grp_inj_bad",
          reviewed_at: "2026-01-01T00:00:00Z",
          observer_provider: "claude",
          observer_model: "claude-opus-4-7",
          observer_cli_version: "1.0.0",
          findings: [
            { severity: "STOP", claim: "in-scope claim", evidence_path: "src/a.ts" },
          ],
        });

        // Phase token carries `"` which `wrapObserverFindingForInjection`
        // rejects; the injection is skipped but the group:review fanout
        // still happens.
        expect(deps.wsBridge.injectUserMessage).not.toHaveBeenCalled();
        expect(emitted).toHaveLength(1);
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

    // Backend P3#13 / EC-2 (council residual fix): when the observer half of
    // a council pair fails to spawn, the coordinator rolls back by killing
    // the orchestrator half. That kill MUST be marked `intentional` before
    // `killSession` runs so the `session:exited` → `scheduleProactiveRelaunch`
    // listener at initialize() doesn't race the rollback and try to resurrect
    // the half being torn down. Verified by snapshotting `intentionalKills`
    // inside the spy at the exact moment killSession is invoked.
    it("marks the rollback-bound session id intentional BEFORE invoking killSession during spawn-rollback", async () => {
      const obs = orchestrator as unknown as {
        intentionalKills: Set<string>;
        killSession: (id: string) => Promise<{ ok: boolean }>;
        doCreateSession: (req: { backend?: string }) => Promise<{ ok: true; session: { sessionId: string } } | { ok: false; error: string; status: number }>;
      };
      let intentionalAtKillTime: boolean | null = null;
      const origKillSession = obs.killSession.bind(orchestrator);
      obs.killSession = vi.fn(async (id: string) => {
        intentionalAtKillTime = obs.intentionalKills.has(id);
        return origKillSession(id);
      }) as typeof obs.killSession;

      let spawnCount = 0;
      obs.doCreateSession = vi.fn(async () => {
        spawnCount++;
        if (spawnCount === 1) {
          return { ok: true as const, session: { sessionId: "sess_orch_rollback" } as { sessionId: string } };
        }
        return { ok: false as const, error: "observer spawn timed out", status: 504 };
      }) as typeof obs.doCreateSession;

      const result = await orchestrator.createCouncilGroup({
        pairing: "claude+codex",
        base: { cwd: "/w" },
      });

      expect(result.ok).toBe(false);
      // The rollback path SHOULD have invoked killSession against the
      // surviving orchestrator half exactly once.
      expect(obs.killSession).toHaveBeenCalledWith("sess_orch_rollback");
      // The EC-2 invariant — the snapshot inside the spy proves the mark
      // landed BEFORE the kill ran (not after, which would be a race).
      expect(intentionalAtKillTime).toBe(true);
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
});
