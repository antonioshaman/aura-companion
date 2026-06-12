import { create } from "zustand";
import { createAuthSlice, type AuthSlice } from "./auth-slice.js";
import { createSessionsSlice, type SessionsSlice } from "./sessions-slice.js";
import { createChatSlice, type ChatSlice } from "./chat-slice.js";
import { createPermissionsSlice, type PermissionsSlice } from "./permissions-slice.js";
import { createTasksSlice, type TasksSlice } from "./tasks-slice.js";
import { createUiSlice, type UiSlice, getInitialDiffBase } from "./ui-slice.js";
import { createTerminalSlice, type TerminalSlice, getInitialQuickTerminalPlacement } from "./terminal-slice.js";
import { createUpdatesSlice, type UpdatesSlice } from "./updates-slice.js";
import { createCouncilSlice, type CouncilSlice } from "./council-slice.js";
import { createSettingsSlice, type SettingsSlice } from "./settings-slice.js";
import { createCliStatusSlice, type CliStatusSlice } from "./cli-status-slice.js";

export type AppState = AuthSlice &
  SessionsSlice &
  ChatSlice &
  PermissionsSlice &
  TasksSlice &
  UiSlice &
  TerminalSlice &
  UpdatesSlice &
  CouncilSlice &
  SettingsSlice &
  CliStatusSlice & {
    reset: () => void;
  };

export const useStore = create<AppState>((...args) => ({
  ...createAuthSlice(...args),
  ...createSessionsSlice(...args),
  ...createChatSlice(...args),
  ...createPermissionsSlice(...args),
  ...createTasksSlice(...args),
  ...createUiSlice(...args),
  ...createTerminalSlice(...args),
  ...createUpdatesSlice(...args),
  ...createCouncilSlice(...args),
  ...createSettingsSlice(...args),
  ...createCliStatusSlice(...args),

  reset: () => {
    const [set] = args;
    set({
      // Sessions — note: collapsedProjects is intentionally preserved across
      // resets so the user's sidebar collapse preferences persist.
      sessions: new Map(),
      sdkSessions: [],
      currentSessionId: null,
      connectionStatus: new Map(),
      cliConnected: new Map(),
      cliReconnecting: new Map(),
      sessionStatus: new Map(),
      previousPermissionMode: new Map(),
      sessionNames: new Map(),
      recentlyRenamed: new Set(),
      mcpServers: new Map(),
      prStatus: new Map(),
      linkedLinearIssues: new Map(),
      // Chat
      messages: new Map(),
      streaming: new Map(),
      streamingStartedAt: new Map(),
      streamingOutputTokens: new Map(),
      // Permissions
      pendingPermissions: new Map(),
      aiResolvedPermissions: new Map(),
      // Tasks
      sessionTasks: new Map(),
      changedFilesTick: new Map(),
      gitChangedFilesCount: new Map(),
      sessionProcesses: new Map(),
      toolProgress: new Map(),
      toolActivity: new Map(),
      // UI
      taskPanelConfigMode: false,
      activeTab: "chat" as const,
      chatTabReentryTickBySession: new Map(),
      diffPanelSelectedFile: new Map(),
      diffBase: getInitialDiffBase(),
      // Terminal
      quickTerminalOpen: false,
      quickTerminalTabs: [],
      activeQuickTerminalTabId: null,
      quickTerminalPlacement: getInitialQuickTerminalPlacement(),
      quickTerminalNextHostIndex: 1,
      quickTerminalNextDockerIndex: 1,
      terminalOpen: false,
      terminalCwd: null,
      terminalId: null,
      // Council Mode — note: observerPanelOpen / observerPanelWidth /
      // firstRunHintDismissed are user-preferences that persist across
      // reset (parallels the collapsedProjects intent).
      groups: new Map(),
      groupBySessionId: new Map(),
      findings: new Map(),
      groundingDowngrades: new Map(),
      dismissedStopIds: new Set(),
      // CLI terminal failures — reset to empty on hard store reset.
      cliFailures: new Map(),
      pendingCodexModelSwitches: new Map(),
    });
  },
}));

// Re-export types for backward compatibility
export type { QuickTerminalTab, QuickTerminalPlacement } from "./terminal-slice.js";
export type { DiffBase } from "./ui-slice.js";
