/**
 * SessionOrchestrator × usage-limit auto-resume — the integration seam.
 *
 * Validates the wiring between the adapters' `session:usage-limit` bus event,
 * the AutoResumeScheduler and the real orchestrator actions:
 *  - a limit on a solo session schedules a resume and publishes the banner
 *    state through the bridge; a council half is scheduled with its role;
 *  - a browser-typed user message, a user stop, archive and delete cancel it;
 *  - firing relaunches a DEAD session through the regular relaunch path and
 *    injects the continuation prompt with origin `server:auto-resume`;
 *  - for a council pair the orchestrator is injected and a dead observer is
 *    relaunched as well;
 *  - schedules persist and are re-armed by a fresh orchestrator (restart);
 *  - switching the setting off cancels pending resumes.
 * Module mocks are copied from session-orchestrator.test.ts.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

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

// Worktree isolation: real pure decision logic, mocked git/fs side effects
// (the git operations themselves are covered on temp repos in
// worktree-isolation.test.ts).
vi.mock("./worktree-isolation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./worktree-isolation.js")>();
  return {
    ...actual,
    gitToplevel: vi.fn(() => null),
    findLiveSessionsInTree: vi.fn(() => []),
    listSystemdServiceDirs: vi.fn(() => []),
    getWorktreesBaseDir: vi.fn(() => "/home/u/.companion/worktrees"),
    createIsolatedWorktree: vi.fn(),
    cleanupIsolatedWorktree: vi.fn(() => ({ removed: true, branchDeleted: true })),
  };
});

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
      image: "aura-companion-sandbox:latest",
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

import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionOrchestrator } from "./session-orchestrator.js";
import { companionBus } from "./event-bus.js";
import { AUTO_RESUME_PROMPT } from "./auto-resume-executor.js";

const NOW = Date.UTC(2026, 9, 16, 10, 0);

interface FakeInfo {
  sessionId: string;
  model?: string;
  archived?: boolean;
  backendType?: string;
}

function makeDeps(sessions: Map<string, FakeInfo>, alive: Set<string>, filePath: string) {
  let userFrameCb: ((sessionId: string) => void) | null = null;
  const launcher = {
    launch: vi.fn(),
    kill: vi.fn(async (id: string) => {
      alive.delete(id);
      return true;
    }),
    relaunch: vi.fn(async (id: string) => {
      alive.add(id);
      return { ok: true };
    }),
    listSessions: vi.fn(() => [...sessions.values()]),
    getSession: vi.fn((id: string) => sessions.get(id)),
    isAlive: vi.fn((id: string) => alive.has(id)),
    setArchived: vi.fn((id: string, v: boolean) => {
      const s = sessions.get(id);
      if (s) s.archived = v;
    }),
    removeSession: vi.fn((id: string) => sessions.delete(id)),
    setCLISessionId: vi.fn(),
    setModel: vi.fn(),
    markConnected: vi.fn(),
    getStartingSessions: vi.fn(() => []),
  } as any;
  const wsBridge = {
    closeSession: vi.fn(),
    isCliConnected: vi.fn(() => false),
    getSession: vi.fn(() => null),
    getAllSessions: vi.fn(() => []),
    broadcastToSession: vi.fn(),
    broadcastToGroup: vi.fn(),
    cancelDisconnectTimer: vi.fn(() => false),
    onUserFrameObserved: vi.fn((cb: (sessionId: string) => void) => {
      userFrameCb = cb;
      return () => {};
    }),
    trimArchivedSessionMemory: vi.fn(),
    markSessionUnarchived: vi.fn(),
    injectUserMessage: vi.fn(),
    setAutoResumeState: vi.fn(),
    sendObserverWakeFrame: vi.fn(() => ({ kind: "sent" })),
  } as any;
  const deps = {
    launcher,
    wsBridge,
    sessionStore: { setArchived: vi.fn(() => true) } as any,
    worktreeTracker: {
      addMapping: vi.fn(),
      getBySession: vi.fn(() => null),
      removeBySession: vi.fn(),
      updateMapping: vi.fn(),
      isWorktreeInUse: vi.fn(() => false),
    } as any,
    prPoller: { watch: vi.fn(), unwatch: vi.fn() },
    agentExecutor: { handleSessionExited: vi.fn() } as any,
    autoResume: { filePath },
  };
  return { deps, launcher, wsBridge, typeAsUser: (id: string) => userFrameCb?.(id) };
}

function limitEvent(sessionId: string, resetAt = NOW + 3_600_000) {
  return {
    sessionId,
    backend: "claude" as const,
    model: null,
    resetAt,
    resetSource: "rate_limit_event" as const,
    limitType: "five_hour",
  };
}

describe("SessionOrchestrator — usage-limit auto-resume", () => {
  let dir: string;
  let filePath: string;
  let sessions: Map<string, FakeInfo>;
  let alive: Set<string>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    companionBus.clear();
    dir = mkdtempSync(join(tmpdir(), "orch-auto-resume-"));
    filePath = join(dir, "auto-resume.json");
    sessions = new Map([
      ["solo", { sessionId: "solo", model: "claude-opus-5-5", backendType: "claude" }],
      ["orch", { sessionId: "orch", model: "claude-opus-5-5", backendType: "claude" }],
      ["obs", { sessionId: "obs", model: "gpt-6.1-sol", backendType: "codex" }],
    ]);
    alive = new Set(["solo", "orch", "obs"]);
  });

  afterEach(() => {
    vi.useRealTimers();
    companionBus.clear();
    rmSync(dir, { recursive: true, force: true });
  });

  function boot() {
    const h = makeDeps(sessions, alive, filePath);
    const orchestrator = new SessionOrchestrator(h.deps);
    orchestrator.initialize();
    return { ...h, orchestrator };
  }

  function withPair(orchestrator: SessionOrchestrator) {
    // The coordinator is created lazily on first pair spawn; install a
    // minimal fake so the auto-resume path can resolve the pair.
    (orchestrator as any).coordinator = {
      findBySessionId: (id: string) =>
        id === "orch" || id === "obs"
          ? { sessionGroupId: "grp_1", primary: { sessionId: "orch" }, observer: { sessionId: "obs" }, status: "active" }
          : undefined,
      applyEvent: vi.fn(),
    };
  }

  it("a usage limit on a solo session schedules a resume and publishes the banner state", () => {
    const { orchestrator, wsBridge } = boot();
    companionBus.emit("session:usage-limit", limitEvent("solo"));
    const sched = orchestrator.getAutoResume("solo");
    expect(sched).toMatchObject({ sessionId: "solo", role: "solo", model: "claude-opus-5-5", resetAt: NOW + 3_600_000 });
    expect(sched!.fireAt - sched!.resetAt).toBeGreaterThanOrEqual(60_000);
    expect(sched!.fireAt - sched!.resetAt).toBeLessThanOrEqual(120_000);
    expect(wsBridge.setAutoResumeState).toHaveBeenCalledWith("solo", expect.objectContaining({ resetAt: NOW + 3_600_000 }));
    orchestrator.shutdown();
  });

  it("an archived session is never scheduled", () => {
    sessions.get("solo")!.archived = true;
    const { orchestrator } = boot();
    companionBus.emit("session:usage-limit", limitEvent("solo"));
    expect(orchestrator.getAutoResume("solo")).toBeUndefined();
    orchestrator.shutdown();
  });

  it("a browser-typed user message cancels the pending resume", () => {
    const { orchestrator, wsBridge, typeAsUser } = boot();
    companionBus.emit("session:usage-limit", limitEvent("solo"));
    typeAsUser("solo");
    expect(orchestrator.getAutoResume("solo")).toBeUndefined();
    expect(wsBridge.setAutoResumeState).toHaveBeenLastCalledWith("solo", null);
    orchestrator.shutdown();
  });

  it("user stop (kill), archive and delete cancel the pending resume", async () => {
    const { orchestrator } = boot();
    companionBus.emit("session:usage-limit", limitEvent("solo"));
    await orchestrator.killSession("solo");
    expect(orchestrator.getAutoResume("solo")).toBeUndefined();

    companionBus.emit("session:usage-limit", limitEvent("orch"));
    await orchestrator.archiveSession("orch");
    expect(orchestrator.getAutoResume("orch")).toBeUndefined();

    companionBus.emit("session:usage-limit", limitEvent("obs"));
    await orchestrator.deleteSession("obs");
    expect(orchestrator.getAutoResume("obs")).toBeUndefined();
    orchestrator.shutdown();
  });

  it("firing on a DEAD session relaunches it, then injects the continuation prompt (server:auto-resume)", async () => {
    alive.delete("solo");
    const { orchestrator, launcher, wsBridge } = boot();
    companionBus.emit("session:usage-limit", limitEvent("solo", NOW + 60_000));
    await vi.advanceTimersByTimeAsync(60_000 + 121_000);
    expect(launcher.relaunch.mock.calls.map((c: unknown[]) => c[0])).toEqual(["solo"]);
    expect(wsBridge.injectUserMessage).toHaveBeenCalledWith("solo", AUTO_RESUME_PROMPT, "server:auto-resume");
    const relaunchOrder = launcher.relaunch.mock.invocationCallOrder[0];
    const injectOrder = wsBridge.injectUserMessage.mock.invocationCallOrder[0];
    expect(relaunchOrder).toBeLessThan(injectOrder);
    // Self-cleaning: nothing left in memory or on disk.
    expect(orchestrator.getAutoResume("solo")).toBeUndefined();
    expect(JSON.parse(readFileSync(filePath, "utf-8")).schedules).toEqual([]);
    orchestrator.shutdown();
  });

  // Review NOTE (cancel/fire race): the user types while the dead session is
  // being relaunched for the resume → the continuation prompt is skipped.
  it("a user message during the resume's relaunch suppresses the injection", async () => {
    alive.delete("solo");
    const h = boot();
    h.launcher.relaunch.mockImplementation(async (id: string) => {
      alive.add(id);
      vi.setSystemTime(Date.now() + 1_000);
      h.typeAsUser(id);
      return { ok: true };
    });
    companionBus.emit("session:usage-limit", limitEvent("solo", NOW + 60_000));
    await vi.advanceTimersByTimeAsync(60_000 + 121_000);
    expect(h.launcher.relaunch).toHaveBeenCalled();
    expect(h.wsBridge.injectUserMessage).not.toHaveBeenCalled();
    h.orchestrator.shutdown();
  });

  // Council STOP: user presses Stop while the resume's relaunch is in flight
  // → no "продолжай" is injected into the stopped session.
  it("a user Stop during the resume's relaunch aborts the injection", async () => {
    alive.delete("solo");
    const h = boot();
    let stopDuringRelaunch: Promise<unknown> | null = null;
    h.launcher.relaunch.mockImplementation(async (id: string) => {
      alive.add(id);
      stopDuringRelaunch = h.orchestrator.killSession(id);
      return { ok: true };
    });
    companionBus.emit("session:usage-limit", limitEvent("solo", NOW + 60_000));
    await vi.advanceTimersByTimeAsync(60_000 + 121_000);
    await stopDuringRelaunch;
    expect(h.launcher.relaunch).toHaveBeenCalled();
    expect(h.wsBridge.injectUserMessage).not.toHaveBeenCalled();
    h.orchestrator.shutdown();
  });

  // Council WARN1: a PAUSED banner restored on boot must not be wiped by the
  // stale-banner sweep (paused records are not in the schedule map).
  it("restart keeps the restored paused banner", async () => {
    const first = boot();
    const fallback = () => ({ ...limitEvent("solo", Date.now() + 5 * 3_600_000), resetSource: "fallback" as const, limitType: null });
    companionBus.emit("session:usage-limit", fallback());
    for (let i = 0; i < 2; i++) {
      await vi.advanceTimersByTimeAsync(5 * 3_600_000 + 121_000);
      companionBus.emit("session:usage-limit", fallback());
    }
    first.orchestrator.shutdown();
    companionBus.clear();

    const h = makeDeps(sessions, alive, filePath);
    h.wsBridge.getAllSessions.mockReturnValue([
      { session_id: "solo", auto_resume: { resetAt: 1, fireAt: 1, resetSource: "fallback", paused: true } },
    ]);
    const second = new SessionOrchestrator(h.deps);
    second.initialize();
    expect(h.wsBridge.setAutoResumeState).toHaveBeenCalledWith("solo", expect.objectContaining({ paused: true }));
    expect(h.wsBridge.setAutoResumeState).not.toHaveBeenCalledWith("solo", null);
    second.shutdown();
  });

  it("council pair: the orchestrator is resumed and a dead observer is relaunched too", async () => {
    alive.delete("obs");
    const { orchestrator, launcher, wsBridge } = boot();
    withPair(orchestrator);
    companionBus.emit("session:usage-limit", limitEvent("orch", NOW + 60_000));
    expect(orchestrator.getAutoResume("orch")).toMatchObject({ role: "orchestrator", sessionGroupId: "grp_1" });
    await vi.advanceTimersByTimeAsync(60_000 + 121_000);
    expect(launcher.relaunch.mock.calls.map((c: unknown[]) => c[0])).toEqual(["obs"]);
    expect(wsBridge.injectUserMessage).toHaveBeenCalledTimes(1);
    expect(wsBridge.injectUserMessage).toHaveBeenCalledWith("orch", AUTO_RESUME_PROMPT, "server:auto-resume");
    orchestrator.shutdown();
  });

  it("council observer limit: scheduled with role observer; firing never injects a user prompt", async () => {
    const { orchestrator, wsBridge } = boot();
    withPair(orchestrator);
    companionBus.emit("session:usage-limit", { ...limitEvent("obs", NOW + 60_000), backend: "codex" as const });
    expect(orchestrator.getAutoResume("obs")).toMatchObject({ role: "observer", backend: "codex" });
    await vi.advanceTimersByTimeAsync(60_000 + 121_000);
    expect(wsBridge.injectUserMessage).not.toHaveBeenCalled();
    expect(orchestrator.getAutoResume("obs")).toBeUndefined();
    orchestrator.shutdown();
  });

  it("schedules survive a restart: a fresh orchestrator re-arms and fires them", async () => {
    const first = boot();
    companionBus.emit("session:usage-limit", limitEvent("solo"));
    first.orchestrator.shutdown();
    companionBus.clear();

    const second = boot();
    expect(second.orchestrator.getAutoResume("solo")).toMatchObject({ resetAt: NOW + 3_600_000 });
    expect(second.wsBridge.setAutoResumeState).toHaveBeenCalledWith("solo", expect.objectContaining({ resetAt: NOW + 3_600_000 }));
    await vi.advanceTimersByTimeAsync(3_600_000 + 121_000);
    expect(second.wsBridge.injectUserMessage).toHaveBeenCalledWith("solo", AUTO_RESUME_PROMPT, "server:auto-resume");
    expect(first.wsBridge.injectUserMessage).not.toHaveBeenCalled();
    second.orchestrator.shutdown();
  });

  it("switching the setting off cancels pending resumes", () => {
    const { orchestrator } = boot();
    companionBus.emit("session:usage-limit", limitEvent("solo"));
    companionBus.emit("settings:auto-resume-changed", { enabled: false });
    expect(orchestrator.getAutoResume("solo")).toBeUndefined();
    orchestrator.shutdown();
  });
});
