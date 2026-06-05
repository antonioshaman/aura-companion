import type { StateCreator } from "zustand";
import type { AppState } from "./index.js";
import type { SessionState, SdkSessionInfo, McpServerDetail } from "../types.js";
import type { PRStatusResponse, LinearIssue } from "../api.js";
import { deleteFromMap, deleteFromSet } from "./utils.js";
import { COUNCIL_PANEL_OPEN_KEY, COUNCIL_PANEL_WIDTH_KEY } from "./council-slice.js";

function getInitialSessionNames(): Map<string, string> {
  if (typeof window === "undefined") return new Map();
  try {
    return new Map(JSON.parse(localStorage.getItem("cc-session-names") || "[]"));
  } catch {
    return new Map();
  }
}

function getInitialSessionId(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("cc-current-session") || null;
}

function getInitialCollapsedProjects(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    return new Set(JSON.parse(localStorage.getItem("cc-collapsed-projects") || "[]"));
  } catch {
    return new Set();
  }
}

export interface SessionsSlice {
  sessions: Map<string, SessionState>;
  sdkSessions: SdkSessionInfo[];
  currentSessionId: string | null;
  connectionStatus: Map<string, "connecting" | "connected" | "disconnected">;
  cliConnected: Map<string, boolean>;
  cliReconnecting: Map<string, boolean>;
  sessionStatus: Map<string, "idle" | "running" | "compacting" | null>;
  previousPermissionMode: Map<string, string>;
  sessionNames: Map<string, string>;
  recentlyRenamed: Set<string>;
  prStatus: Map<string, PRStatusResponse>;
  linkedLinearIssues: Map<string, LinearIssue>;
  mcpServers: Map<string, McpServerDetail[]>;
  collapsedProjects: Set<string>;
  /**
   * Per-session one-shot pickup drafts. Populated when a user clicks
   * "Continue in new session" on a wedged session — the server returns a
   * pickup prompt that asks the new agent to read the handoff file. The
   * Composer reads + consumes the draft on mount (single-fire) so the
   * textarea is pre-populated; the user can edit before submit.
   * Not persisted — purely transient handoff between Sidebar action and
   * Composer mount within the same tab session.
   */
  pickupDrafts: Map<string, string>;
  /**
   * AURA-LOCAL - PLAN T12 (Phase G). One-shot draft that the next
   * `session_init` handler converts into a `pickupDraft` keyed by
   * the freshly-created session id. Set by `CliFailedBanner` when
   * the user clicks "Start new session with this draft" so the
   * composer text survives the navigation home -> new session flow
   * even though the future session id is not yet known.
   */
  pendingDraftForNextSession: string | null;

  setCurrentSession: (id: string | null) => void;
  addSession: (session: SessionState) => void;
  updateSession: (sessionId: string, updates: Partial<SessionState>) => void;
  removeSession: (sessionId: string) => void;
  removeBridgeSession: (sessionId: string) => void;
  setSdkSessions: (sessions: SdkSessionInfo[]) => void;
  setConnectionStatus: (sessionId: string, status: "connecting" | "connected" | "disconnected") => void;
  setCliConnected: (sessionId: string, connected: boolean) => void;
  setCliReconnecting: (sessionId: string, reconnecting: boolean) => void;
  setSessionStatus: (sessionId: string, status: "idle" | "running" | "compacting" | null) => void;
  setPreviousPermissionMode: (sessionId: string, mode: string) => void;
  setSessionName: (sessionId: string, name: string) => void;
  markRecentlyRenamed: (sessionId: string) => void;
  clearRecentlyRenamed: (sessionId: string) => void;
  setPRStatus: (sessionId: string, status: PRStatusResponse) => void;
  setLinkedLinearIssue: (sessionId: string, issue: LinearIssue | null) => void;
  setMcpServers: (sessionId: string, servers: McpServerDetail[]) => void;
  toggleProjectCollapse: (projectKey: string) => void;
  setSessionAiValidation: (sessionId: string, settings: { aiValidationEnabled?: boolean | null; aiValidationAutoApprove?: boolean | null; aiValidationAutoDeny?: boolean | null }) => void;
  /** Store a pickup draft for a future-mounted Composer (continue-in-new flow). */
  setPickupDraft: (sessionId: string, text: string) => void;
  /** Read + clear the pickup draft atomically. Returns undefined if none pending. */
  consumePickupDraft: (sessionId: string) => string | undefined;
  /** Phase G - stash a draft for the NEXT session_init to pick up. */
  setPendingDraftForNextSession: (text: string | null) => void;
  /** Phase G - read+clear the pending draft atomically. */
  consumePendingDraftForNextSession: () => string | undefined;
}

export const createSessionsSlice: StateCreator<AppState, [], [], SessionsSlice> = (set) => ({
  sessions: new Map(),
  sdkSessions: [],
  currentSessionId: getInitialSessionId(),
  connectionStatus: new Map(),
  cliConnected: new Map(),
  cliReconnecting: new Map(),
  sessionStatus: new Map(),
  previousPermissionMode: new Map(),
  sessionNames: getInitialSessionNames(),
  recentlyRenamed: new Set(),
  prStatus: new Map(),
  linkedLinearIssues: new Map(),
  mcpServers: new Map(),
  collapsedProjects: getInitialCollapsedProjects(),
  pickupDrafts: new Map(),
  pendingDraftForNextSession: null,

  setCurrentSession: (id) => {
    if (id) {
      localStorage.setItem("cc-current-session", id);
    } else {
      localStorage.removeItem("cc-current-session");
    }
    set({ currentSessionId: id });
  },

  addSession: (session) =>
    set((s) => {
      const sessions = new Map(s.sessions);
      sessions.set(session.session_id, session);
      // Cross-slice write: initialize the messages entry (owned by ChatSlice)
      // atomically with the session so consumers always find a messages array.
      const messages = new Map(s.messages);
      if (!messages.has(session.session_id)) messages.set(session.session_id, []);
      return { sessions, messages };
    }),

  updateSession: (sessionId, updates) =>
    set((s) => {
      const sessions = new Map(s.sessions);
      const existing = sessions.get(sessionId);
      if (existing) sessions.set(sessionId, { ...existing, ...updates });
      return { sessions };
    }),

  removeSession: (sessionId) =>
    set((s) => {
      const sessionNames = deleteFromMap(s.sessionNames, sessionId);
      localStorage.setItem("cc-session-names", JSON.stringify(Array.from(sessionNames.entries())));
      if (s.currentSessionId === sessionId) {
        localStorage.removeItem("cc-current-session");
      }
      // Cross-slice: drop the per-session panel preference + group record if any.
      // Council slice owns its own state; we persist the trimmed panel maps
      // here via the same localStorage keys the slice uses, keeping the
      // truth-of-keys exported from council-slice.ts (no duplicate literals).
      const groupId = s.groupBySessionId.get(sessionId);
      const observerPanelOpen = new Map(s.observerPanelOpen);
      observerPanelOpen.delete(sessionId);
      const observerPanelWidth = new Map(s.observerPanelWidth);
      observerPanelWidth.delete(sessionId);
      try {
        localStorage.setItem(COUNCIL_PANEL_OPEN_KEY, JSON.stringify(Array.from(observerPanelOpen.entries())));
        localStorage.setItem(COUNCIL_PANEL_WIDTH_KEY, JSON.stringify(Array.from(observerPanelWidth.entries())));
      } catch {
        /* quota / serialization failure — silent; not load-bearing */
      }
      const groups = new Map(s.groups);
      const groupBySessionId = new Map(s.groupBySessionId);
      const findings = new Map(s.findings);
      const groundingDowngrades = new Map(s.groundingDowngrades);
      if (groupId) {
        const existing = s.groups.get(groupId);
        groups.delete(groupId);
        if (existing) {
          groupBySessionId.delete(existing.primarySessionId);
          groupBySessionId.delete(existing.observerSessionId);
        }
        findings.delete(groupId);
        groundingDowngrades.delete(groupId);
      }
      return {
        // Sessions slice fields
        sessions: deleteFromMap(s.sessions, sessionId),
        connectionStatus: deleteFromMap(s.connectionStatus, sessionId),
        cliConnected: deleteFromMap(s.cliConnected, sessionId),
        cliReconnecting: deleteFromMap(s.cliReconnecting, sessionId),
        sessionStatus: deleteFromMap(s.sessionStatus, sessionId),
        previousPermissionMode: deleteFromMap(s.previousPermissionMode, sessionId),
        sessionNames,
        recentlyRenamed: deleteFromSet(s.recentlyRenamed, sessionId),
        mcpServers: deleteFromMap(s.mcpServers, sessionId),
        prStatus: deleteFromMap(s.prStatus, sessionId),
        linkedLinearIssues: deleteFromMap(s.linkedLinearIssues, sessionId),
        sdkSessions: s.sdkSessions.filter((sdk) => sdk.sessionId !== sessionId),
        currentSessionId: s.currentSessionId === sessionId ? null : s.currentSessionId,
        // Chat slice fields
        messages: deleteFromMap(s.messages, sessionId),
        streaming: deleteFromMap(s.streaming, sessionId),
        streamingStartedAt: deleteFromMap(s.streamingStartedAt, sessionId),
        streamingOutputTokens: deleteFromMap(s.streamingOutputTokens, sessionId),
        // Permissions slice fields
        pendingPermissions: deleteFromMap(s.pendingPermissions, sessionId),
        aiResolvedPermissions: deleteFromMap(s.aiResolvedPermissions, sessionId),
        // Tasks slice fields
        sessionTasks: deleteFromMap(s.sessionTasks, sessionId),
        changedFilesTick: deleteFromMap(s.changedFilesTick, sessionId),
        gitChangedFilesCount: deleteFromMap(s.gitChangedFilesCount, sessionId),
        sessionProcesses: deleteFromMap(s.sessionProcesses, sessionId),
        toolProgress: deleteFromMap(s.toolProgress, sessionId),
        toolActivity: deleteFromMap(s.toolActivity, sessionId),
        // UI slice fields
        diffPanelSelectedFile: deleteFromMap(s.diffPanelSelectedFile, sessionId),
        chatTabReentryTickBySession: deleteFromMap(s.chatTabReentryTickBySession, sessionId),
        // Council slice cleanup (computed above)
        observerPanelOpen,
        observerPanelWidth,
        groups,
        groupBySessionId,
        findings,
        groundingDowngrades,
        // PLAN T12 (Phase G) - drop any cli-status-slice entry
        // when the session leaves the store. Sibling of the
        // permissionPermissions cleanup above.
        cliFailures: deleteFromMap(s.cliFailures, sessionId),
      };
    }),

  removeBridgeSession: (sessionId) =>
    set((s) => {
      if (!s.sessions.has(sessionId)) return {};
      const sessions = new Map(s.sessions);
      sessions.delete(sessionId);
      return { sessions };
    }),

  setSdkSessions: (sessions) => set({ sdkSessions: sessions }),

  setConnectionStatus: (sessionId, status) =>
    set((s) => {
      const connectionStatus = new Map(s.connectionStatus);
      connectionStatus.set(sessionId, status);
      return { connectionStatus };
    }),

  setCliConnected: (sessionId, connected) =>
    set((s) => {
      const cliConnected = new Map(s.cliConnected);
      cliConnected.set(sessionId, connected);
      return { cliConnected };
    }),

  setCliReconnecting: (sessionId, reconnecting) =>
    set((s) => {
      const cliReconnecting = new Map(s.cliReconnecting);
      if (reconnecting) {
        cliReconnecting.set(sessionId, true);
      } else {
        cliReconnecting.delete(sessionId);
      }
      return { cliReconnecting };
    }),

  setSessionStatus: (sessionId, status) =>
    set((s) => {
      const sessionStatus = new Map(s.sessionStatus);
      sessionStatus.set(sessionId, status);
      return { sessionStatus };
    }),

  setPreviousPermissionMode: (sessionId, mode) =>
    set((s) => {
      const previousPermissionMode = new Map(s.previousPermissionMode);
      previousPermissionMode.set(sessionId, mode);
      return { previousPermissionMode };
    }),

  setSessionName: (sessionId, name) =>
    set((s) => {
      const sessionNames = new Map(s.sessionNames);
      sessionNames.set(sessionId, name);
      localStorage.setItem("cc-session-names", JSON.stringify(Array.from(sessionNames.entries())));
      return { sessionNames };
    }),

  markRecentlyRenamed: (sessionId) =>
    set((s) => {
      const recentlyRenamed = new Set(s.recentlyRenamed);
      recentlyRenamed.add(sessionId);
      return { recentlyRenamed };
    }),

  clearRecentlyRenamed: (sessionId) =>
    set((s) => {
      const recentlyRenamed = new Set(s.recentlyRenamed);
      recentlyRenamed.delete(sessionId);
      return { recentlyRenamed };
    }),

  setPRStatus: (sessionId, status) =>
    set((s) => {
      const prStatus = new Map(s.prStatus);
      prStatus.set(sessionId, status);
      return { prStatus };
    }),

  setLinkedLinearIssue: (sessionId, issue) =>
    set((s) => {
      const linkedLinearIssues = new Map(s.linkedLinearIssues);
      if (issue) {
        linkedLinearIssues.set(sessionId, issue);
      } else {
        linkedLinearIssues.delete(sessionId);
      }
      return { linkedLinearIssues };
    }),

  setMcpServers: (sessionId, servers) =>
    set((s) => {
      const mcpServers = new Map(s.mcpServers);
      mcpServers.set(sessionId, servers);
      return { mcpServers };
    }),

  toggleProjectCollapse: (projectKey) =>
    set((s) => {
      const collapsedProjects = new Set(s.collapsedProjects);
      if (collapsedProjects.has(projectKey)) {
        collapsedProjects.delete(projectKey);
      } else {
        collapsedProjects.add(projectKey);
      }
      localStorage.setItem("cc-collapsed-projects", JSON.stringify(Array.from(collapsedProjects)));
      return { collapsedProjects };
    }),

  setSessionAiValidation: (sessionId, settings) =>
    set((s) => {
      const sessions = new Map(s.sessions);
      const existing = sessions.get(sessionId);
      if (!existing) return {};
      sessions.set(sessionId, { ...existing, ...settings });
      return { sessions };
    }),

  setPickupDraft: (sessionId, text) =>
    set((s) => {
      const pickupDrafts = new Map(s.pickupDrafts);
      pickupDrafts.set(sessionId, text);
      return { pickupDrafts };
    }),

  // Atomic read-and-clear. Returns the draft if one was pending, otherwise
  // undefined. Used by Composer on mount to single-fire pre-populate without
  // re-applying on re-render or surviving an unmount/remount cycle.
  consumePickupDraft: (sessionId) => {
    let consumed: string | undefined;
    set((s) => {
      const existing = s.pickupDrafts.get(sessionId);
      if (existing === undefined) return {};
      consumed = existing;
      const pickupDrafts = new Map(s.pickupDrafts);
      pickupDrafts.delete(sessionId);
      return { pickupDrafts };
    });
    return consumed;
  },

  setPendingDraftForNextSession: (text) => set({ pendingDraftForNextSession: text }),

  // Phase G: ws.ts session_init reads this to route the cli-failed
  // hand-off draft into the new session as a regular pickup draft.
  consumePendingDraftForNextSession: () => {
    let consumed: string | undefined;
    set((s) => {
      if (s.pendingDraftForNextSession === null) return {};
      consumed = s.pendingDraftForNextSession;
      return { pendingDraftForNextSession: null };
    });
    return consumed;
  },
});
