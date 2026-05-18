import type { ServerWebSocket } from "bun";
import type {
  BrowserOutgoingMessage,
  BrowserIncomingMessage,
  SessionState,
  PermissionRequest,
  BackendType,
  McpServerConfig,
} from "./session-types.js";
import type { SessionStore } from "./session-store.js";
import type { IBackendAdapter } from "./backend-adapter.js";
import { ClaudeAdapter, type ObserverWakeSendOutcome } from "./claude-adapter.js";
import type { IdleTimerProbe } from "./idle-timer-manager.js";
import { OBSERVER_WAKE_TIMEOUT_MS } from "./council-types.js";
import { buildBrowserGroupRecord } from "./browser-group-record.js";
import type { RecorderManager } from "./recorder.js";
import { resolveSessionGitInfo } from "./session-git-info.js";
import type {
  Session,
  SocketData,
  CLISocketData,
  BrowserSocketData,
  GitSessionKey,
} from "./ws-bridge-types.js";
import { makeDefaultState } from "./ws-bridge-types.js";
export type { SocketData } from "./ws-bridge-types.js";
import {
  isHistoryBackedEvent,
} from "./ws-bridge-replay.js";
import {
  parseBrowserMessage,
  deduplicateBrowserMessage,
  IDEMPOTENT_BROWSER_MESSAGE_TYPES,
} from "./ws-bridge-browser-ingest.js";
import {
  appendHistory as appendHistoryFn,
  persistSession as persistSessionFn,
  serializeForStore,
} from "./ws-bridge-persist.js";
import {
  broadcastToBrowsers as broadcastToBrowsersFn,
  sendToBrowser as sendToBrowserFn,
  EVENT_BUFFER_LIMIT,
} from "./ws-bridge-publish.js";
import {
  handleSetAiValidation,
} from "./ws-bridge-controls.js";
import {
  handleSessionSubscribe,
  handleSessionAck,
} from "./ws-bridge-browser.js";
import {
  trackStreamForInterrupted,
  synthesiseInterruptedMessage,
} from "./ws-bridge-stream-status.js";
import { validatePermission } from "./ai-validator.js";
import { getEffectiveAiValidation } from "./ai-validation-settings.js";
import { companionBus } from "./event-bus.js";
import { SessionStateMachine } from "./session-state-machine.js";
import { metricsCollector } from "./metrics-collector.js";
import { log } from "./logger.js";

// ─── Bridge ───────────────────────────────────────────────────────────────────

/**
 * Outcome returned by {@link WsBridge.sendObserverWakeFrame}. Wraps the
 * adapter-level {@link ObserverWakeSendOutcome} with bridge-level reasons
 * (session/adapter lookup miss) so the orchestrator's dispatcher can map
 * every branch to a single EC-9 structured log entry without ambiguity.
 */
export type BridgeObserverWakeOutcome =
  | ObserverWakeSendOutcome
  | { kind: "session_unknown" }
  | { kind: "adapter_missing" }
  | { kind: "unsupported_backend" };

const RETRYABLE_BACKEND_MESSAGE_TYPES = new Set<BrowserOutgoingMessage["type"]>([
  "user_message",
  "mcp_get_status",
  "mcp_toggle",
  "mcp_reconnect",
  "mcp_set_servers",
]);

export class WsBridge {
  private static readonly PROCESSED_CLIENT_MSG_ID_LIMIT = 1000;
  /** Maximum number of queued browser→backend messages per session to prevent unbounded memory growth. */
  private static readonly PENDING_MESSAGES_LIMIT = 200;
  private static readonly DISCONNECT_DEBOUNCE_MS = Number(
    process.env.COMPANION_DISCONNECT_DEBOUNCE_MS || "15000",
  );
  private disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private idleKillTimers = new Map<string, ReturnType<typeof setInterval>>();
  private sessions = new Map<string, Session>();
  private store: SessionStore | null = null;
  private recorder: RecorderManager | null = null;
  private autoNamingAttempted = new Set<string>();
  private userMsgCounter = 0;
  /**
   * Cross-tab single-firer observers for user-frame arrivals (Task 11.6).
   * The bridge routes each browser→server user frame through
   * `routeBrowserMessage` exactly once regardless of how many tabs are
   * connected, so a callback registered here fires once per frame — not
   * per tab. Production wires this to `IdleTimerManager.noteUserMessage`
   * so the auto-proceed pipeline's turn-token advances on any tab's typing,
   * not just the originating socket.
   */
  private userFrameObservers: Array<(sessionId: string) => void> = [];

  /**
   * Narrow read-only view of {@link IdleTimerManager} used by the
   * idle-kill clock split (Task 11.7). The bridge only needs to know
   * whether a synthetic auto-proceed turn is in flight for a given
   * session; the full manager surface stays in `SessionOrchestrator`.
   * Late-injected via {@link setIdleTimerManager} from `index.ts`
   * (after the manager is constructed) — mirrors the orchestrator's
   * mutual-cycle pattern. `null` until set, in which case
   * {@link noteCliActivity} defaults to advancing the clock (safe
   * pre-Task-11 behaviour).
   */
  private idleTimerProbe: IdleTimerProbe | null = null;
  private static readonly GIT_SESSION_KEYS: GitSessionKey[] = [
    "git_branch",
    "is_worktree",
    "is_containerized",
    "repo_root",
    "git_ahead",
    "git_behind",
  ];

  /**
   * Late-inject the idle-timer manager's synthetic-turn probe (Task 11.7).
   * `index.ts` calls this after constructing the real
   * {@link IdleTimerManager} so the bridge's activity-tracking sites can
   * gate on whether the in-flight turn is synthetic (auto-proceed) vs
   * user-driven. Idempotent; calling with `null` re-arms the safe-default
   * branch where every CLI activity tick advances `lastCliActivityTs`.
   */
  setIdleTimerProbe(probe: IdleTimerProbe | null): void {
    this.idleTimerProbe = probe;
  }

  /**
   * Idle-kill clock activity dispatcher (Task 11.7). Called from every
   * CLI→browser activity callback. Queries the late-injected idle-timer
   * probe and routes to {@link noteUserActivity} (advances the clock)
   * or {@link noteSyntheticActivity} (no-op for the clock) so synthetic
   * auto-proceed turns don't extend the idle-kill window indefinitely.
   *
   * Without this split: a session with auto-proceed iterating every few
   * minutes would never reach the 24h idle threshold, because each
   * synthetic-driven CLI response would reset the clock. The split
   * preserves "user typing keeps session alive" while letting silent
   * auto-proceed loops time out.
   */
  private noteCliActivity(session: Session): void {
    if (this.idleTimerProbe?.isSyntheticTurnInFlight(session.id)) {
      this.noteSyntheticActivity(session);
    } else {
      this.noteUserActivity(session);
    }
  }

  /**
   * The ONLY production code path that writes `session.lastCliActivityTs`
   * outside session initialization and {@link startIdleKillWatchdog}'s
   * fresh-start reset (Task 11.7). The EC-6 static-grep canary in
   * `ws-bridge.test.ts` asserts this — any other mutation site is a bug.
   */
  private noteUserActivity(session: Session): void {
    session.lastCliActivityTs = Date.now();
  }

  /**
   * No-op for the idle-kill clock (Task 11.7). Placeholder for future
   * synthetic-activity telemetry (per-session synthetic-turn counter,
   * last-synthetic-ts, etc.) without violating the idle-clock invariant.
   * Argument is intentionally captured so call sites typecheck identically
   * to {@link noteUserActivity}.
   */
  private noteSyntheticActivity(_session: Session): void {
    // Intentionally empty — synthetic frames do not advance the
    // idle-kill clock. See `noteCliActivity` JSDoc for the rationale.
  }

  /**
   * Register a callback that fires whenever ANY browser tab sends a
   * `user_message` frame to ANY session — caller filters by sessionId.
   *
   * The bridge's `routeBrowserMessage` is the single dispatch point for
   * browser frames, so the callback fires once per frame regardless of
   * tab count. Production caller is `SessionOrchestrator.initialize`
   * wiring `IdleTimerManager.noteUserMessage(sid)`, which advances the
   * per-session turn-token (cancels any pending auto-proceed fire — see
   * `feedback_call_site_presence_not_just_symbol_export`: the manager's
   * `noteUserMessage` method was tested standalone in Task 11.1 but had
   * no production caller until this wiring landed in Task 11.6).
   *
   * Returns an unsubscribe function for symmetry with `companionBus.on`;
   * the orchestrator never calls it (DI lifetime = process lifetime), but
   * tests use it to keep their mock observers isolated.
   */
  onUserFrameObserved(callback: (sessionId: string) => void): () => void {
    this.userFrameObservers.push(callback);
    return () => {
      const idx = this.userFrameObservers.indexOf(callback);
      if (idx >= 0) this.userFrameObservers.splice(idx, 1);
    };
  }

  /** Set the Linear agent session ID on a Companion session and persist it. */
  setLinearSessionId(sessionId: string, linearSessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.state.linearSessionId = linearSessionId;
    this.persistSession(session);
  }

  /** Return all sessions that have a linearSessionId set (for map restoration on startup). */
  getLinearSessionMappings(): Array<{ sessionId: string; linearSessionId: string }> {
    const mappings: Array<{ sessionId: string; linearSessionId: string }> = [];
    for (const [sessionId, session] of this.sessions) {
      if (session.state.linearSessionId) {
        mappings.push({ sessionId, linearSessionId: session.state.linearSessionId });
      }
    }
    return mappings;
  }

  /**
   * Mark a session as belonging to a Council Mode pair. Populates
   * `session.state.sessionGroupId` / `sessionGroupRole` so
   * `handleBrowserOpen` can hydrate a synthetic `group_created` on
   * subscribe (post-restart, page-reload, second-tab).
   *
   * Prior to this method existing, the synthetic-hydration path from
   * commit a37ded5 read `state.sessionGroupId` which was never written
   * in production — only in unit tests. Surviving pairs across browser
   * reload / server restart looked like two unrelated solo sessions.
   * Called from `SessionOrchestrator.createCouncilGroup` after spawn
   * and from `reconcileCouncilGroups` for resumed pairs.
   */
  markCouncilSession(
    sessionId: string,
    sessionGroupId: string,
    sessionGroupRole: import("./session-types.js").SessionGroupRole,
  ): void {
    const session = this.getOrCreateSession(sessionId);
    session.state.sessionGroupId = sessionGroupId;
    session.state.sessionGroupRole = sessionGroupRole;
    this.persistSession(session);
  }

  /**
   * Pre-populate a session with container info so that handleSystemMessage
   * preserves the host cwd instead of overwriting it with /workspace.
   * Call this right after launcher.launch() for containerized sessions.
   */
  markContainerized(sessionId: string, hostCwd: string): void {
    const session = this.getOrCreateSession(sessionId);
    session.state.is_containerized = true;
    session.state.cwd = hostCwd;
  }

  /**
   * Pre-populate slash_commands and skills on a session so they are
   * available to browsers immediately (before system.init from the CLI).
   * If system.init arrives later, it overwrites these with the CLI's
   * authoritative list (see handleSystemMessage).
   */
  prePopulateCommands(sessionId: string, slashCommands: string[], skills: string[]): void {
    const session = this.getOrCreateSession(sessionId);
    let changed = false;
    if (session.state.slash_commands.length === 0 && slashCommands.length > 0) {
      session.state.slash_commands = slashCommands;
      changed = true;
    }
    if (session.state.skills.length === 0 && skills.length > 0) {
      session.state.skills = skills;
      changed = true;
    }
    if (changed && session.browserSockets.size > 0) {
      this.broadcastToBrowsers(session, { type: "session_init", session: session.state });
    }
  }

  /** Push a message to all connected browsers for a session (public, for PRPoller etc.). */
  broadcastToSession(sessionId: string, msg: BrowserIncomingMessage): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.broadcastToBrowsers(session, msg);
  }

  /**
   * Council Mode auto-wake — dispatch a server-synthesised `user` NDJSON
   * frame to a specific observer session's CLI socket via its adapter.
   *
   * The bridge is the only place that knows the sessionId → adapter map,
   * so it owns the lookup. The Claude-instance narrowing is intentional
   * for the current claude+claude scope; Codex pairings return
   * `unsupported_backend` (the dispatcher in `session-orchestrator.ts`
   * skips with that reason). When Codex pairing ships, replace the
   * narrowing with an `IBackendAdapter`-shaped optional method.
   */
  sendObserverWakeFrame(sessionId: string, content: string): BridgeObserverWakeOutcome {
    const session = this.sessions.get(sessionId);
    if (!session) return { kind: "session_unknown" };
    if (!session.backendAdapter) return { kind: "adapter_missing" };
    if (!(session.backendAdapter instanceof ClaudeAdapter)) {
      return { kind: "unsupported_backend" };
    }
    return session.backendAdapter.sendUserFrameFromServer(content);
  }

  /**
   * Task 11.8 — orchestrator-half auto-proceed synthetic frame send.
   * Mirror of {@link sendObserverWakeFrame} but routes to the
   * orchestrator-half adapter with recorder origin `server:auto-proceed`.
   * Production caller is {@link IdleTimerManager}'s `sendSyntheticFrame`
   * DI seam (wired in `index.ts`). Returns the same outcome shape so
   * the manager's EC-9 logger can correlate failures across both paths.
   */
  sendOrchestratorSyntheticFrame(sessionId: string, content: string): BridgeObserverWakeOutcome {
    const session = this.sessions.get(sessionId);
    if (!session) return { kind: "session_unknown" };
    if (!session.backendAdapter) return { kind: "adapter_missing" };
    if (!(session.backendAdapter instanceof ClaudeAdapter)) {
      return { kind: "unsupported_backend" };
    }
    return session.backendAdapter.sendOrchestratorSyntheticFrame(content);
  }

  /**
   * Council Mode — push the same message to ALL browsers attached to
   * EITHER half of a session pair. Used to fan `group_created` /
   * `group_exited` / `group_degraded` / `group_checkpoint` /
   * `observer_review` out to whichever half the user happens to have open.
   * Missing-session ids are skipped silently.
   */
  broadcastToGroup(sessionIds: readonly string[], msg: BrowserIncomingMessage): void {
    for (const sid of sessionIds) {
      const session = this.sessions.get(sid);
      if (!session) continue;
      this.broadcastToBrowsers(session, msg);
    }
  }

  /** Attach a persistent store. Call restoreFromDisk() after. */
  setStore(store: SessionStore): void {
    this.store = store;
  }

  /** Attach a recorder for raw message capture. */
  setRecorder(recorder: RecorderManager): void {
    this.recorder = recorder;
  }

  /** Restore sessions from disk (call once at startup). */
  restoreFromDisk(): number {
    if (!this.store) return 0;
    const persisted = this.store.loadAll();
    let count = 0;
    for (const p of persisted) {
      if (this.sessions.has(p.id)) continue; // don't overwrite live sessions
      const session: Session = {
        id: p.id,
        backendType: p.state.backend_type || "claude",
        backendAdapter: null,
        browserSockets: new Set(),
        state: p.state,
        pendingPermissions: new Map(p.pendingPermissions || []),
        messageHistory: p.messageHistory || [],
        pendingMessages: p.pendingMessages || [],
        nextEventSeq: p.nextEventSeq && p.nextEventSeq > 0 ? p.nextEventSeq : 1,
        eventBuffer: Array.isArray(p.eventBuffer) ? p.eventBuffer : [],
        lastAckSeq: typeof p.lastAckSeq === "number" ? p.lastAckSeq : 0,
        processedClientMessageIds: Array.isArray(p.processedClientMessageIds) ? p.processedClientMessageIds : [],
        processedClientMessageIdSet: new Set(
          Array.isArray(p.processedClientMessageIds) ? p.processedClientMessageIds : [],
        ),
        lastCliActivityTs: Date.now(),
        stateMachine: new SessionStateMachine(p.id, "terminated"),
      };
      session.state.backend_type = session.backendType;
      // Resolve git info for restored sessions (may have been persisted without it)
      resolveSessionGitInfo(session.id, session.state);
      this.sessions.set(p.id, session);
      // Restored sessions with completed turns don't need auto-naming re-triggered
      if (session.state.num_turns > 0) {
        this.autoNamingAttempted.add(session.id);
      }
      count++;
    }
    if (count > 0) {
      console.log(`[ws-bridge] Restored ${count} session(s) from disk`);
    }
    return count;
  }

  /** Persist a session to disk (debounced). Delegates to ws-bridge-persist. */
  private persistSession(session: Session): void {
    persistSessionFn(session, this.store);
  }

  private refreshGitInfo(
    session: Session,
    options: { broadcastUpdate?: boolean; notifyPoller?: boolean } = {},
  ): void {
    const before = {
      git_branch: session.state.git_branch,
      is_worktree: session.state.is_worktree,
      is_containerized: session.state.is_containerized,
      repo_root: session.state.repo_root,
      git_ahead: session.state.git_ahead,
      git_behind: session.state.git_behind,
    };

    resolveSessionGitInfo(session.id, session.state);

    let changed = false;
    for (const key of WsBridge.GIT_SESSION_KEYS) {
      if (session.state[key] !== before[key]) {
        changed = true;
        break;
      }
    }

    if (changed) {
      if (options.broadcastUpdate) {
        this.broadcastToBrowsers(session, {
          type: "session_update",
          session: {
            git_branch: session.state.git_branch,
            is_worktree: session.state.is_worktree,
            is_containerized: session.state.is_containerized,
            repo_root: session.state.repo_root,
            git_ahead: session.state.git_ahead,
            git_behind: session.state.git_behind,
          },
        });
      }
      this.persistSession(session);
    }

    if (options.notifyPoller && session.state.git_branch && session.state.cwd) {
      companionBus.emit("session:git-info-ready", { sessionId: session.id, cwd: session.state.cwd, branch: session.state.git_branch });
    }
  }

  // ── Session management ──────────────────────────────────────────────────

  getOrCreateSession(sessionId: string, backendType?: BackendType): Session {
    let session = this.sessions.get(sessionId);
    if (!session) {
      const type = backendType || "claude";
      session = {
        id: sessionId,
        backendType: type,
        backendAdapter: null,
        browserSockets: new Set(),
        state: makeDefaultState(sessionId, type),
        pendingPermissions: new Map(),
        messageHistory: [],
        pendingMessages: [],
        nextEventSeq: 1,
        eventBuffer: [],
        lastAckSeq: 0,
        processedClientMessageIds: [],
        processedClientMessageIdSet: new Set(),
        lastCliActivityTs: Date.now(),
        stateMachine: new SessionStateMachine(sessionId),
      };
      this.sessions.set(sessionId, session);
      this.wireStateMachineListeners(session);
    } else if (backendType) {
      // Only overwrite backendType when explicitly provided (e.g. attachBackendAdapter)
      // Prevents handleBrowserOpen from resetting codex→claude
      session.backendType = backendType;
      session.state.backend_type = backendType;
    }
    return session;
  }

  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  getAllSessions(): SessionState[] {
    return Array.from(this.sessions.values()).map((s) => s.state);
  }

  /**
   * PLAN Task 11: synchronously flush every pending debounced session-store
   * write to disk. Used by `gracefulShutdown` so a state mutation that
   * landed in the 150ms debounce window seconds before SIGTERM is not
   * lost. No-op if no store is attached.
   */
  flushSessionStorePendingSync(): void {
    if (!this.store) return;
    this.store.flushAll((sessionId) => {
      const session = this.sessions.get(sessionId);
      return session ? serializeForStore(session) : null;
    });
  }

  /**
   * PLAN Task 12 (v) — at shutdown, walk every session and synthesise an
   * interrupted assistant frame for any in-flight stream that the CLI
   * never closed with a consolidated `assistant`. The existing per-session
   * `flushInterruptedStream` already covers CLI disconnect; this is the
   * sibling path for "the server itself is going down with active streams
   * mid-token". Without this, SIGTERM during a long generation leaves the
   * persisted history with no record of the in-flight reply (same data
   * loss the disconnect path closed). Returns the count of synthesised
   * frames for the shutdown log.
   *
   * Idempotent: re-running after the trackers are already null is a no-op.
   * Does NOT itself persist the store — caller invokes
   * `flushSessionStorePendingSync` immediately after so all the
   * synthesised frames land in the same final write.
   */
  flushInterruptedStreamsForShutdown(): number {
    let synthesised = 0;
    for (const session of this.sessions.values()) {
      if (session.streamingAssistant && session.streamingAssistant.text.length > 0) {
        this.flushInterruptedStream(session);
        synthesised += 1;
      } else {
        // Clear the tracker even if no text (no synthesis happens) so the
        // post-shutdown invariant `streamingAssistant === null` holds for
        // every session.
        session.streamingAssistant = null;
      }
    }
    return synthesised;
  }

  /** Return per-session memory stats for diagnostics. */
  getSessionMemoryStats(): { id: string; browsers: number; historyLen: number; eventBufferLen: number; pendingMsgs: number }[] {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      browsers: s.browserSockets.size,
      historyLen: s.messageHistory.length,
      eventBufferLen: s.eventBuffer.length,
      pendingMsgs: s.pendingMessages.length,
    }));
  }

  /** Return current phase for each session (for metrics gauges). */
  getSessionPhases(): Map<string, import("./session-state-machine.js").SessionPhase> {
    const phases = new Map<string, import("./session-state-machine.js").SessionPhase>();
    for (const [id, session] of this.sessions) {
      phases.set(id, session.stateMachine.phase);
    }
    return phases;
  }

  getCodexRateLimits(sessionId: string) {
    const session = this.sessions.get(sessionId);
    return session?.backendAdapter?.getRateLimits?.() ?? null;
  }

  isCliConnected(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return session?.backendAdapter?.isConnected() ?? false;
  }

  removeSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    session?.unsubscribeStateMachine?.();
    this.cancelDisconnectTimer(sessionId);
    this.stopIdleKillWatchdog(sessionId);
    this.sessions.delete(sessionId);
    this.autoNamingAttempted.delete(sessionId);
    this.store?.remove(sessionId);
  }

  /** Wire state machine transition listener to broadcast phase changes. */
  private wireStateMachineListeners(session: Session): void {
    // Unsubscribe any previous listener (e.g. from session restoration) to prevent leaks
    session.unsubscribeStateMachine?.();
    session.unsubscribeStateMachine = session.stateMachine.onTransition((event) => {
      companionBus.emit("session:phase-changed", {
        sessionId: event.sessionId,
        from: event.from,
        to: event.to,
        trigger: event.trigger,
      });
      this.broadcastToBrowsers(session, {
        type: "session_phase",
        phase: event.to,
        previousPhase: event.from,
      });
    });
  }

  /**
   * Close all sockets (CLI + browsers) for a session and remove it.
   */
  closeSession(sessionId: string) {
    this.cancelDisconnectTimer(sessionId);
    this.stopIdleKillWatchdog(sessionId);
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Unsubscribe state machine listener to prevent leaks
    session.unsubscribeStateMachine?.();

    // Disconnect backend adapter (Claude or Codex)
    if (session.backendAdapter) {
      session.backendAdapter.disconnect().catch(() => {});
      session.backendAdapter = null;
    }

    // Close all browser sockets
    for (const ws of session.browserSockets) {
      try { ws.close(); } catch {}
    }
    session.browserSockets.clear();

    this.sessions.delete(sessionId);
    this.autoNamingAttempted.delete(sessionId);
    this.store?.remove(sessionId);
  }

  // ── Backend adapter attachment ────────────────────────────────────────────

  /**
   * Attach a backend adapter (Claude or Codex) to a session.
   * Wires up the shared event pipeline: activity tracking, session state
   * merging, history appending, broadcasting, and persistence.
   */
  attachBackendAdapter(sessionId: string, adapter: IBackendAdapter, backendType?: BackendType): void {
    const session = this.getOrCreateSession(sessionId, backendType);
    session.backendAdapter = adapter;

    // Advance the state machine so that system_init (starting → ready) is reachable.
    // For Claude, handleCLIOpen does starting → initializing via cli_ws_open.
    // For Codex (and any non-Claude adapter), the adapter attachment IS the transport
    // open event — no separate WS open fires — so do the equivalent transition here.
    // Also handles relaunched sessions stuck in "terminated": step through
    // terminated → starting → initializing so system_init can land on "ready".
    if (!(adapter instanceof ClaudeAdapter)) {
      const phase = session.stateMachine.phase;
      if (phase === "terminated") {
        session.stateMachine.transition("starting", "adapter_reattached");
      }
      // starting → initializing (or reconnecting → initializing)
      session.stateMachine.transition("initializing", "adapter_attached");
    }

    // ── onBrowserMessage — messages from backend → browsers ──────────────
    adapter.onBrowserMessage((msg) => {
      // Task 11.7 — idle-kill clock split. Synthetic auto-proceed turns
      // do NOT advance the clock; only user-driven CLI activity does.
      this.noteCliActivity(session);
      metricsCollector.recordMessageProcessed(msg.type);

      // -- session_init: merge into session state, broadcast, persist -----
      if (msg.type === "session_init") {
        // Exclude session_id from the spread: the CLI reports its own internal
        // session ID which differs from the Companion's session ID.  Allowing
        // it to overwrite session.state.session_id causes the browser to key
        // the session under the wrong ID, producing duplicate sidebar entries.
        const { slash_commands, skills, session_id: _cliSessionId, ...rest } = msg.session;
        // For containerized sessions, the CLI reports /workspace as its cwd.
        // Keep the host path (set by markContainerized()) for correct project grouping.
        const cwdOverride = session.state.is_containerized ? { cwd: session.state.cwd } : {};
        session.state = {
          ...session.state,
          ...rest,
          // Preserve pre-populated commands/skills when adapter sends empty arrays
          ...(slash_commands?.length ? { slash_commands } : {}),
          ...(skills?.length ? { skills } : {}),
          ...cwdOverride,
          backend_type: session.backendType,
        };
        this.refreshGitInfo(session, { notifyPoller: true });
        this.broadcastToBrowsers(session, { type: "session_init", session: session.state });
        session.stateMachine.transition("ready", "system_init");
        this.persistSession(session);
        return;
      }

      // -- session_update: merge into session state, persist ---------------
      if (msg.type === "session_update") {
        // Exclude session_id — same rationale as session_init above.
        const { slash_commands, skills, session_id: _cliSessionId, ...rest } = msg.session;
        session.state = {
          ...session.state,
          ...rest,
          ...(slash_commands?.length ? { slash_commands } : {}),
          ...(skills?.length ? { skills } : {}),
          backend_type: session.backendType,
        };
        this.refreshGitInfo(session, { notifyPoller: true });
        this.persistSession(session);
        if (session.pendingMessages.length > 0 && adapter.isConnected()) {
          this.flushQueuedBrowserMessages(session, adapter, "backend_session_update");
        }
      }

      // -- status_change: update compacting flag ---------------------------
      if (msg.type === "status_change") {
        session.state.is_compacting = msg.status === "compacting";
        if (msg.status === "compacting") {
          session.stateMachine.transition("compacting", "compaction_started");
        } else {
          session.stateMachine.transition("ready", "compaction_ended");
        }
        // Claude status messages may include permissionMode (not in the typed interface)
        const permMode = (msg as unknown as { permissionMode?: string }).permissionMode;
        if (permMode) {
          session.state.permissionMode = permMode;
        }
        this.persistSession(session);
      }

      if (msg.type === "user_message") {
        const alreadyPersisted = msg.id
          ? session.messageHistory.some((entry) => entry.type === "user_message" && entry.id === msg.id)
          : false;
        if (!alreadyPersisted) {
          this.appendHistory(session, msg);
          this.persistSession(session);
        }
      }

      // -- assistant: append to history, notify listeners ------------------
      if (msg.type === "assistant") {
        // PLAN Task 12 — stamp `streamStatus: "complete"` on the persisted
        // form. The consolidated assistant frame IS the completion signal:
        // by reaching this branch we have a whole turn from the CLI. If a
        // streaming tracker is still set for this id, clear it so the
        // disconnect-time interrupted flush doesn't emit a duplicate.
        if (session.streamingAssistant?.id === msg.message.id) {
          session.streamingAssistant = null;
        }
        const assistantMsg = { ...msg, timestamp: msg.timestamp || Date.now(), streamStatus: "complete" as const };
        this.appendHistory(session, assistantMsg);
        this.persistSession(session);
        companionBus.emit("message:assistant", { sessionId: session.id, message: assistantMsg });
      }

      if (msg.type === "stream_event") {
        // PLAN Task 12 — feed the in-memory stream tracker so a CLI death
        // between message_start and the consolidated assistant frame can be
        // surfaced to the browser as an interrupted bubble rather than
        // silently lost. Tracker is pure-function over wire frames; no
        // persistence happens here.
        trackStreamForInterrupted(session, msg);
        companionBus.emit("message:stream_event", { sessionId: session.id, message: msg });
      }

      // -- result: update session cost/turns, refresh git, notify listeners
      if (msg.type === "result") {
        const resultData = msg.data;
        session.state.total_cost_usd = resultData.total_cost_usd;
        session.state.num_turns = resultData.num_turns;
        if (typeof resultData.total_lines_added === "number") {
          session.state.total_lines_added = resultData.total_lines_added;
        }
        if (typeof resultData.total_lines_removed === "number") {
          session.state.total_lines_removed = resultData.total_lines_removed;
        }
        if (resultData.modelUsage) {
          for (const usage of Object.values(resultData.modelUsage)) {
            if (usage.contextWindow > 0) {
              const pct = Math.round(
                ((usage.inputTokens + usage.outputTokens) / usage.contextWindow) * 100
              );
              session.state.context_used_percent = Math.max(0, Math.min(pct, 100));
            }
          }
        }
        this.refreshGitInfo(session, { broadcastUpdate: true, notifyPoller: true });
        this.appendHistory(session, msg);
        session.stateMachine.transition("ready", "turn_completed");
        this.persistSession(session);
        companionBus.emit("message:result", { sessionId: session.id, message: msg });

        // Trigger auto-naming after first successful result
        if (
          !(resultData as { is_error?: boolean }).is_error &&
          !this.autoNamingAttempted.has(session.id)
        ) {
          this.autoNamingAttempted.add(session.id);
          const firstUserMsg = session.messageHistory.find((m) => m.type === "user_message");
          if (firstUserMsg && firstUserMsg.type === "user_message") {
            companionBus.emit("session:first-turn-completed", { sessionId: session.id, firstUserMessage: firstUserMsg.content });
          }
        }
      }

      // -- permission_request: AI validation, add to pending ---------------
      if (msg.type === "permission_request") {
        const perm = msg.request;
        metricsCollector.recordPermissionRequested(perm.request_id, session.id);

        // AI Validation Mode: evaluate the tool call before showing to user
        const aiSettings = getEffectiveAiValidation(session.state);
        if (
          aiSettings.enabled
          && aiSettings.anthropicApiKey
          && perm.tool_name !== "AskUserQuestion"
          && perm.tool_name !== "ExitPlanMode"
        ) {
          // Run AI validation async
          this.handleAiValidation(session, adapter, perm).catch((err) => {
            console.warn(`[ws-bridge] AI validation error for tool=${perm.tool_name} request_id=${perm.request_id} session=${session.id}, falling through to manual:`, err);
            // On error, fall through to normal permission flow
            session.pendingPermissions.set(perm.request_id, perm);
            session.stateMachine.transition("awaiting_permission", "ai_validation_error_fallback");
            this.persistSession(session);
            this.broadcastToBrowsers(session, msg);
          });
          return; // Don't broadcast yet — AI validation is async
        }

        session.pendingPermissions.set(perm.request_id, perm);
        session.stateMachine.transition("awaiting_permission", "permission_requested");
        this.persistSession(session);
      }

      // -- permission_cancelled: remove from pending -----------------------
      if (msg.type === "permission_cancelled") {
        const reqId = (msg as { request_id: string }).request_id;
        session.pendingPermissions.delete(reqId);
        // If no more pending permissions, transition back to streaming
        if (session.pendingPermissions.size === 0 && session.stateMachine.phase === "awaiting_permission") {
          session.stateMachine.transition("streaming", "permission_cancelled");
        }
        this.persistSession(session);
      }

      // -- system_event: append to history (except hook_progress) ----------
      if (msg.type === "system_event") {
        const event = msg.event;
        if (event.subtype !== "hook_progress") {
          this.appendHistory(session, msg);
          this.persistSession(session);
        }
      }

      // Broadcast all messages to browsers
      this.broadcastToBrowsers(session, msg);
    });

    // ── onSessionMeta — metadata updates (CLI session ID, model, cwd) ────
    adapter.onSessionMeta((meta) => {
      if (meta.cliSessionId) {
        companionBus.emit("session:cli-id-received", { sessionId: session.id, cliSessionId: meta.cliSessionId });
      }
      if (meta.model) session.state.model = meta.model;
      // For containerized sessions, the CLI reports the container's cwd (e.g. /workspace).
      // Keep the host path (set by markContainerized()) for correct project grouping.
      if (meta.cwd && !session.state.is_containerized) {
        session.state.cwd = meta.cwd;
      }
      session.state.backend_type = session.backendType;
      this.refreshGitInfo(session, { broadcastUpdate: true, notifyPoller: true });
      this.persistSession(session);
      if (session.pendingMessages.length > 0 && adapter.isConnected()) {
        this.flushQueuedBrowserMessages(session, adapter, "backend_session_meta");
      }
    });

    // ── onDisconnect — handle transport disconnection ────────────────────
    adapter.onDisconnect(() => {
      // Guard: only act if THIS adapter is still the active one
      if (session.backendAdapter !== adapter) {
        console.log(`[ws-bridge] Ignoring stale disconnect for session ${sessionId} (adapter replaced)`);
        return;
      }

      // For ClaudeAdapter, disconnect is handled by handleCLIClose debounce logic
      if (adapter instanceof ClaudeAdapter) {
        // Do nothing here — handleCLIClose manages the debounce timer
        return;
      }

      // For Codex adapters: immediate cleanup + auto-relaunch
      for (const [reqId] of session.pendingPermissions) {
        this.broadcastToBrowsers(session, { type: "permission_cancelled", request_id: reqId });
      }
      session.pendingPermissions.clear();
      // PLAN Task 12 — flush partial stream as `streamStatus: "interrupted"`
      // BEFORE persisting so the bubble lands in the same atomic save and
      // is visible to browsers reconnecting after the disconnect.
      this.flushInterruptedStream(session);
      session.backendAdapter = null;
      this.persistSession(session);
      console.log(`[ws-bridge] Backend adapter disconnected for session ${sessionId}`);
      this.broadcastToBrowsers(session, { type: "cli_disconnected" });

      // Auto-relaunch if browsers are still connected
      if (session.browserSockets.size > 0) {
        console.log(`[ws-bridge] Auto-relaunching backend for session ${sessionId} (${session.browserSockets.size} browser(s) connected)`);
        companionBus.emit("session:relaunch-needed", { sessionId });
      }
    });

    // ── onInitError (optional) ───────────────────────────────────────────
    adapter.onInitError?.((error) => {
      log.error("ws-bridge", "Backend init error", { sessionId, error });
      this.broadcastToBrowsers(session, { type: "error", message: error });
    });

    // Flush pending messages for non-Claude backends (Codex uses stdio, not
    // a CLI WebSocket, so handleCLIOpen never runs to flush the queue).
    // For Claude backends, handleCLIOpen handles this after attachWebSocket.
    if (!(adapter instanceof ClaudeAdapter) && session.pendingMessages.length > 0) {
      this.flushQueuedBrowserMessages(session, adapter, "adapter_attach");
      this.persistSession(session);
    }

    // Broadcast cli_connected
    this.broadcastToBrowsers(session, { type: "cli_connected" });
    log.info("ws-bridge", "Backend adapter attached", {
      sessionId,
      backendType: session.backendType,
    });
  }

  /** AI validation for permission requests — shared by Claude and Codex paths. */
  private async handleAiValidation(
    session: Session,
    adapter: IBackendAdapter,
    perm: PermissionRequest,
  ): Promise<void> {
    const aiSettings = getEffectiveAiValidation(session.state);
    const result = await validatePermission(
      perm.tool_name,
      perm.input,
      perm.description,
    );

    perm.ai_validation = {
      verdict: result.verdict,
      reason: result.reason,
      ruleBasedOnly: result.ruleBasedOnly,
    };

    // Auto-approve safe tools
    if (result.verdict === "safe" && aiSettings.autoApprove) {
      metricsCollector.recordPermissionResolved(perm.request_id, "allow", true);
      this.broadcastToBrowsers(session, {
        type: "permission_auto_resolved",
        request: perm,
        behavior: "allow",
        reason: result.reason,
      });
      adapter.send({
        type: "permission_response",
        request_id: perm.request_id,
        behavior: "allow",
        updated_input: perm.input,
      });
      return;
    }

    // Auto-deny dangerous tools
    if (result.verdict === "dangerous" && aiSettings.autoDeny) {
      metricsCollector.recordPermissionResolved(perm.request_id, "deny", true);
      this.broadcastToBrowsers(session, {
        type: "permission_auto_resolved",
        request: perm,
        behavior: "deny",
        reason: result.reason,
      });
      adapter.send({
        type: "permission_response",
        request_id: perm.request_id,
        behavior: "deny",
      });
      return;
    }

    // Uncertain or auto-action disabled: fall through to manual
    session.pendingPermissions.set(perm.request_id, perm);
    session.stateMachine.transition("awaiting_permission", "ai_validation_manual_fallback");
    this.persistSession(session);
    this.broadcastToBrowsers(session, {
      type: "permission_request",
      request: perm,
    });
  }

  /** Cancel a pending disconnect debounce timer for a session, if any. */
  cancelDisconnectTimer(sessionId: string): boolean {
    const timer = this.disconnectTimers.get(sessionId);
    if (!timer) return false;
    clearTimeout(timer);
    this.disconnectTimers.delete(sessionId);
    return true;
  }

  // ── CLI WebSocket handlers ──────────────────────────────────────────────

  handleCLIOpen(ws: ServerWebSocket<SocketData>, sessionId: string) {
    metricsCollector.recordWsConnection("cli", "open");
    this.recorder?.recordEvent(sessionId, "ws_open", "cli");
    const session = this.getOrCreateSession(sessionId);

    // Create or retrieve ClaudeAdapter for this session
    let adapter: ClaudeAdapter;
    let isNewAdapter = false;
    if (session.backendAdapter instanceof ClaudeAdapter) {
      adapter = session.backendAdapter;
    } else {
      isNewAdapter = true;
      adapter = new ClaudeAdapter(sessionId, {
        recorder: this.recorder,
        // Task 11.7 — same idle-kill split as the `attachBackendAdapter`
        // path above. Adapter-internal activity ticks (stream chunks etc.)
        // funnel through the same dispatcher so synthetic turns don't
        // sneak the clock forward via a parallel mutator.
        onActivityUpdate: () => { this.noteCliActivity(session); },
        // Task 11.8 — adapter consults the probe synchronously inside
        // `handleControlRequest` (denylist gate) and `handleResultMessage`
        // (sticky-token cleanup). The probe is set once via
        // `setIdleTimerProbe` (index.ts late-injection); reading here at
        // construction time would capture null because the manager is
        // built AFTER the bridge. Pass a closure that re-reads the
        // current probe on each call.
        idleTimerProbe: {
          isSyntheticTurnInFlight: (sid) => this.idleTimerProbe?.isSyntheticTurnInFlight(sid) ?? false,
          noteTerminalResultFrame: (sid) => { this.idleTimerProbe?.noteTerminalResultFrame(sid); },
        },
      });
      // Wire up the shared event pipeline via attachBackendAdapter
      // (also broadcasts cli_connected for new adapters)
      this.attachBackendAdapter(sessionId, adapter);
    }
    // For relaunched sessions the state machine may be "terminated".
    // Step through terminated → starting first so the cli_ws_open trigger can land.
    if (session.stateMachine.phase === "terminated") {
      session.stateMachine.transition("starting", "cli_reattached");
    }
    session.stateMachine.transition("initializing", "cli_ws_open");

    // Cancel any pending disconnect debounce timer — CLI reconnected in time
    if (this.cancelDisconnectTimer(sessionId)) {
      log.info("ws-bridge", "CLI reconnected (debounce cancelled)", { sessionId });
    } else {
      log.info("ws-bridge", "CLI connected", { sessionId });
    }

    // Attach the raw WebSocket to the adapter (flushes pending NDJSON)
    adapter.attachWebSocket(ws);

    // Broadcast cli_connected on reconnection (new adapters already got this
    // via attachBackendAdapter to avoid double-broadcasting)
    if (!isNewAdapter) {
      this.broadcastToBrowsers(session, { type: "cli_connected" });
    }

    // Bootstrap kickoff. Claude Code CLI in `--print -p --input-format stream-json`
    // mode does not emit `system` init until it receives its first input frame.
    // Without a kickoff, sessions stay stuck in "initializing" until a browser
    // happens to send a control_request — fragile for orchestrators, broken for
    // observers (no chat surface = no browser-side traffic).
    this.sendInitializeKickoff(sessionId);

    // Flush any messages queued while waiting for the CLI WebSocket.
    // Per the SDK protocol, the first user message triggers system.init,
    // so we must send it as soon as the WebSocket is open — NOT wait for
    // system.init (which would create a deadlock for slow-starting sessions
    // like Docker containers where the user message arrives before CLI connects).
    if (session.pendingMessages.length > 0) {
      console.log(`[ws-bridge] Flushing ${session.pendingMessages.length} queued message(s) on CLI connect for session ${sessionId}`);
      const queued = session.pendingMessages.splice(0);
      for (const raw of queued) {
        try {
          const queued_msg = JSON.parse(raw) as BrowserOutgoingMessage;
          adapter.send(queued_msg);
        } catch {
          console.warn(`[ws-bridge] Failed to parse queued message: ${raw.substring(0, 100)}`);
        }
      }
    }
  }

  handleCLIMessage(ws: ServerWebSocket<SocketData>, raw: string | Buffer) {
    const data = typeof raw === "string" ? raw : raw.toString("utf-8");
    const sessionId = (ws.data as CLISocketData).sessionId;
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Delegate raw NDJSON parsing, dedup, and routing to the ClaudeAdapter
    // (recording is done inside the adapter's handleRawMessage)
    if (!(session.backendAdapter instanceof ClaudeAdapter)) {
      console.warn(`[ws-bridge] handleCLIMessage: no ClaudeAdapter for session ${sessionId}, dropping message`);
      return;
    }
    session.backendAdapter.handleRawMessage(data);
  }

  handleCLIClose(ws: ServerWebSocket<SocketData>) {
    metricsCollector.recordWsConnection("cli", "close");
    const sessionId = (ws.data as CLISocketData).sessionId;
    this.recorder?.recordEvent(sessionId, "ws_close", "cli");
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Detach the WebSocket from the ClaudeAdapter (guards against stale sockets)
    if (session.backendAdapter instanceof ClaudeAdapter) {
      session.backendAdapter.detachWebSocket(ws);
    }
    session.stateMachine.transition("reconnecting", "cli_ws_closed");

    // Debounce: delay disconnect notification by 15s.
    // CLI cycles its WebSocket every ~30s (close code 1000) and uses exponential
    // backoff (1s → 2s → 4s → 8s → …) on reconnect. After rapid successive
    // disconnects, the backoff can exceed 5s, so we use 15s to cover the worst
    // case (8s backoff + connection overhead).
    const existing = this.disconnectTimers.get(sessionId);
    if (existing) clearTimeout(existing);
    this.disconnectTimers.set(sessionId, setTimeout(() => {
      this.disconnectTimers.delete(sessionId);
      // Check if CLI reconnected during grace period
      if (session.backendAdapter?.isConnected()) return;
      log.warn("ws-bridge", "CLI disconnect confirmed", { sessionId });
      session.stateMachine.transition("terminated", "disconnect_confirmed");
      // PLAN Task 12 — flush partial stream as `streamStatus: "interrupted"`
      // so the persisted history reflects the cut bubble; emit BEFORE
      // broadcasting `cli_disconnected` so an attached browser receives the
      // synthesised `assistant` frame in the same flush window.
      this.flushInterruptedStream(session);
      this.broadcastToBrowsers(session, { type: "cli_disconnected" });
      for (const [reqId] of session.pendingPermissions) {
        this.broadcastToBrowsers(session, { type: "permission_cancelled", request_id: reqId });
      }
      session.pendingPermissions.clear();

      // Request auto-relaunch regardless of browser state — the proactive
      // keepalive in the orchestrator ensures headless sessions stay alive.
      companionBus.emit("session:relaunch-needed", { sessionId });
    }, WsBridge.DISCONNECT_DEBOUNCE_MS));
  }

  // ── Browser WebSocket handlers ──────────────────────────────────────────

  handleBrowserOpen(ws: ServerWebSocket<SocketData>, sessionId: string) {
    metricsCollector.recordWsConnection("browser", "open");
    this.recorder?.recordEvent(sessionId, "ws_open", "browser");
    const session = this.getOrCreateSession(sessionId);
    const browserData = ws.data as BrowserSocketData;
    browserData.subscribed = false;
    browserData.lastAckSeq = 0;
    session.browserSockets.add(ws);
    log.info("ws-bridge", "Browser connected", { sessionId, browsers: session.browserSockets.size });

    // Cancel idle kill watchdog — a browser is back
    this.stopIdleKillWatchdog(sessionId);

    // Refresh git state on browser connect so branch changes made mid-session are reflected.
    this.refreshGitInfo(session, { notifyPoller: true });

    // Send current session state as snapshot
    const snapshot: BrowserIncomingMessage = {
      type: "session_init",
      session: session.state,
    };
    this.sendToBrowser(ws, snapshot);

    // Council Mode — hydrate the browser's group state. `group_created` is
    // emitted by the orchestrator only at initial createCouncilGroup time;
    // a browser that connects later (page reload, second tab, post-restart)
    // would otherwise see two unrelated sessions and never mount the
    // ObserverPanel. Replay a synthetic group_created to THIS browser only.
    if (session.state.sessionGroupId && session.state.sessionGroupRole) {
      const groupPayload = this.deriveGroupCreatedForBrowser(session);
      if (groupPayload) this.sendToBrowser(ws, groupPayload);
    }

    // Replay message history so the browser can reconstruct the conversation
    if (session.messageHistory.length > 0) {
      this.sendToBrowser(ws, {
        type: "message_history",
        messages: session.messageHistory,
      });
    }

    // Send any pending permission requests
    for (const perm of session.pendingPermissions.values()) {
      this.sendToBrowser(ws, { type: "permission_request", request: perm });
    }

    // Notify if backend is not connected and request relaunch.
    // Treat an attached adapter as "alive" during init — `isConnected()`
    // may flip true only after initialize/thread start, and relaunching
    // during that window can kill a healthy startup.
    const backendConnected = !!session.backendAdapter;

    if (!backendConnected && !this.disconnectTimers.has(sessionId)) {
      // Only signal disconnection if we're not within the debounce window
      // (CLI may be mid-reconnect — avoid UI flap and spurious relaunch)
      this.sendToBrowser(ws, { type: "cli_disconnected" });
      console.log(`[ws-bridge] Browser connected but backend is dead for session ${sessionId}, requesting relaunch`);
      companionBus.emit("session:relaunch-needed", { sessionId });
    }
  }

  handleBrowserMessage(ws: ServerWebSocket<SocketData>, raw: string | Buffer) {
    const data = typeof raw === "string" ? raw : raw.toString("utf-8");
    const sessionId = (ws.data as BrowserSocketData).sessionId;
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Record raw incoming browser message
    this.recorder?.record(sessionId, "in", data, "browser", session.backendType, session.state.cwd);

    // Pipeline: parse → route (dedup happens inside routeBrowserMessage)
    const msg = parseBrowserMessage(data);
    if (!msg) return;

    this.routeBrowserMessage(session, msg, ws);
  }

  /** Send a user message into a session programmatically (no browser required).
   *  Used by the cron scheduler and agent executor to send prompts to autonomous sessions. */
  /**
   * Server-driven user_message injection. Used by cron-scheduler,
   * linear-agent-bridge, and the system REST endpoint to programmatically
   * advance a session as if a user had typed.
   *
   * Council Review #12 (EC-16) — `origin` discriminator threaded through
   * `routeBrowserMessage` so server-driven frames are distinguishable
   * from real browser-typed user_messages. The userFrameObservers fanout
   * (currently the idle-timer manager's `noteUserMessage`) skips for
   * server-origins because automated injection isn't user activity; the
   * synthetic-turn token must not advance on cron/agent fires.
   */
  injectUserMessage(
    sessionId: string,
    content: string,
    origin?: "server:cron" | "server:agent" | "server:rest" | "council:peer",
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      console.error(`[ws-bridge] Cannot inject message: session ${sessionId} not found`);
      return;
    }
    this.routeBrowserMessage(session, { type: "user_message", content }, undefined, origin);
  }

  /** Configure MCP servers on a session programmatically (no browser required).
   *  Used by the agent executor to set up MCP servers after CLI connects. */
  injectMcpSetServers(sessionId: string, servers: Record<string, McpServerConfig>): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      console.error(`[ws-bridge] Cannot inject MCP servers: session ${sessionId} not found`);
      return;
    }
    this.routeBrowserMessage(session, { type: "mcp_set_servers", servers });
  }

  /** Council Mode — build a synthetic `group_created` payload for a single
   *  browser subscribing to a session that's part of a pair. Uses the
   *  bridge's own session map (both halves register here on CLI ws_open
   *  after spawn or --resume) so no orchestrator dependency is needed.
   *  Returns null if the counterpart half is not yet registered — the
   *  browser will hydrate on the next reconnect once both halves are up. */
  private deriveGroupCreatedForBrowser(session: Session): BrowserIncomingMessage | null {
    const groupId = session.state.sessionGroupId;
    const role = session.state.sessionGroupRole;
    if (!groupId || !role) return null;
    let counterpart: Session | null = null;
    for (const other of this.sessions.values()) {
      if (other === session) continue;
      if (other.state.sessionGroupId !== groupId) continue;
      if (other.state.sessionGroupRole === role) continue;
      counterpart = other;
      break;
    }
    if (!counterpart) return null;
    const primary = role === "orchestrator" ? session : counterpart;
    const observer = role === "observer" ? session : counterpart;
    // PR #68: route through the shared `buildBrowserGroupRecord` helper —
    // same construction site as the live push from `session-orchestrator`
    // and the REST bootstrap. Status is hardcoded `"active"` because this
    // synthetic hydration only fires when both halves are registered on
    // the bridge (and thus by definition the pair is live). Legacy
    // defensive `?? "claude"` fallback preserved for sessions whose
    // backend type hasn't propagated yet from the spawner.
    return {
      type: "group_created",
      ...buildBrowserGroupRecord({
        sessionGroupId: groupId,
        primary: {
          sessionId: primary.id,
          backendType: (primary.backendType ?? "claude") as BackendType,
        },
        observer: {
          sessionId: observer.id,
          backendType: (observer.backendType ?? "claude") as BackendType,
        },
        status: "active",
      }),
    };
  }

  /**
   * Bootstrap kickoff for sessions that never get browser-driven traffic
   * (e.g. Council Mode observers). Sends ONE `initialize` control_request
   * on CLI ws_open so the CLI emits its `system` init and reaches "ready"
   * state without depending on user input or browser activity. Claude-only.
   *
   * OBS-STOP-1 fix: if `session.pendingSystemPromptInjection` is set
   * (because `injectSystemPrompt` was called before the WS connected),
   * include the prompt in the kickoff's `appendSystemPrompt` field and
   * clear the pending slot. This collapses what was previously a two-
   * initialize race (bare kickoff at WS open → later second initialize
   * with prompt, second silently dropped) into one well-formed init.
   */
  sendInitializeKickoff(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (!(session.backendAdapter instanceof ClaudeAdapter)) return;
    const { randomUUID } = require("node:crypto") as typeof import("node:crypto");
    const pendingPrompt = session.pendingSystemPromptInjection;
    const request: { subtype: "initialize"; appendSystemPrompt?: string } =
      pendingPrompt
        ? { subtype: "initialize", appendSystemPrompt: pendingPrompt }
        : { subtype: "initialize" };
    const ndjson = JSON.stringify({
      type: "control_request",
      request_id: randomUUID(),
      request,
    });
    session.backendAdapter.sendRawNDJSON(ndjson);
    if (pendingPrompt) {
      // Clear the pending slot — kickoff just consumed it. A future
      // `injectSystemPrompt` after this point is a legitimate mid-session
      // re-init (agent-executor mid-flow) and goes through the existing
      // direct-send path.
      session.pendingSystemPromptInjection = null;
    }
  }

  /** Send an initialize control request with context appended to the system prompt.
   *  Must be called before the first user message. Claude-specific: uses ClaudeAdapter
   *  to send a raw control_request. If CLI isn't connected yet, the adapter queues it. */
  injectSystemPrompt(sessionId: string, appendSystemPrompt: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      console.error(`[ws-bridge] Cannot inject system prompt: session ${sessionId} not found`);
      return;
    }
    // OBS-STOP-1 fix: if the adapter is not yet connected, buffer the
    // prompt for the upcoming kickoff to consume. Previously the guard
    // `if (backendAdapter instanceof ClaudeAdapter)` silently no-op'd
    // and the prompt was lost — the session-creation-service.ts:461
    // path called `injectSystemPrompt` BEFORE the CLI subprocess had
    // handshaked the WS back, hitting this exact silent-loss path.
    if (!(session.backendAdapter instanceof ClaudeAdapter)) {
      session.pendingSystemPromptInjection = appendSystemPrompt;
      return;
    }
    // Adapter already connected — direct send. This is the agent-executor
    // mid-flow path (line 211 of agent-executor.ts), where the prompt
    // arrives after handleCLIOpen has already fired the kickoff but
    // before any user_message has been sent. Per the existing JSDoc
    // contract ("Must be called before the first user message"), the
    // CLI accepts a second initialize when it carries `appendSystemPrompt`.
    const { randomUUID } = require("node:crypto") as typeof import("node:crypto");
    const ndjson = JSON.stringify({
      type: "control_request",
      request_id: randomUUID(),
      request: { subtype: "initialize", appendSystemPrompt },
    });
    session.backendAdapter.sendRawNDJSON(ndjson);
  }

  handleBrowserClose(ws: ServerWebSocket<SocketData>) {
    metricsCollector.recordWsConnection("browser", "close");
    const sessionId = (ws.data as BrowserSocketData).sessionId;
    this.recorder?.recordEvent(sessionId, "ws_close", "browser");
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.browserSockets.delete(ws);
    log.info("ws-bridge", "Browser disconnected", { sessionId, browsers: session.browserSockets.size });

    // Start idle kill watchdog when last browser disconnects
    if (session.browserSockets.size === 0 && !this.idleKillTimers.has(sessionId)) {
      this.startIdleKillWatchdog(sessionId);
    }
  }

  // ── Browser heartbeat (AURA-LOCAL — preserve in upstream merges) ─────────
  // Mobile carriers and many proxies silently drop idle WebSockets after
  // 30-120s, surfacing on the client as code=1006 and triggering a reconnect
  // storm. Bun's `sendPings` is a global option that also kills the CLI
  // socket, so we use an application-level keep_alive frame instead.
  //
  // Composability with upstream PR #634 (proactive CLI relaunch on browser
  // disconnect): this heartbeat keeps the WS alive while a browser is open;
  // #634's relaunch path fires only after `browserSockets.size === 0` plus
  // the existing idle-kill watchdog. They are sequenced, not redundant.
  // See aura/CONFLICT_WATCHLIST.md.

  private static readonly BROWSER_HEARTBEAT_INTERVAL_MS = 25_000;
  private browserHeartbeatTimer: ReturnType<typeof setInterval> | null = null;

  startBrowserHeartbeat(): void {
    if (this.browserHeartbeatTimer) return;
    this.browserHeartbeatTimer = setInterval(() => {
      this.broadcastBrowserHeartbeat();
    }, WsBridge.BROWSER_HEARTBEAT_INTERVAL_MS);
  }

  stopBrowserHeartbeat(): void {
    if (!this.browserHeartbeatTimer) return;
    clearInterval(this.browserHeartbeatTimer);
    this.browserHeartbeatTimer = null;
  }

  /**
   * Send keep_alive to every browser socket. Intentionally bypasses
   * `sequenceEvent` / `eventBuffer` / `messageHistory` via direct `ws.send` —
   * heartbeats are transient liveness probes, not state. If a future merge
   * unifies all outgoing-to-browser through a helper that auto-sequences,
   * the heartbeat must remain on the direct path. See PLAN-upstream-sync.md
   * Watchpoint "TS expert — keep_alive seq invariant".
   */
  private broadcastBrowserHeartbeat(): void {
    const json = JSON.stringify({ type: "keep_alive" });
    for (const session of this.sessions.values()) {
      if (session.browserSockets.size === 0) continue;
      for (const ws of session.browserSockets) {
        try {
          ws.send(json);
        } catch {
          session.browserSockets.delete(ws);
        }
      }
    }
  }

  // ── Idle kill watchdog ─────────────────────────────────────────────────

  private static readonly IDLE_KILL_THRESHOLD_MS = Number(
    process.env.COMPANION_IDLE_KILL_MINUTES
      ? Number(process.env.COMPANION_IDLE_KILL_MINUTES) * 60_000
      : 24 * 60 * 60_000, // 24 hours default
  );
  private static readonly IDLE_CHECK_INTERVAL_MS = 60_000; // check every 60s

  private startIdleKillWatchdog(sessionId: string) {
    // Reset activity timestamp so we measure from when browsers left, not from
    // last CLI message (which may have been seconds ago during active work)
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastCliActivityTs = Date.now();
    }
    console.log(`[ws-bridge] Starting idle kill watchdog for ${sessionId} (threshold: ${WsBridge.IDLE_KILL_THRESHOLD_MS / 60_000}min)`);
    const timer = setInterval(() => {
      this.checkIdleKill(sessionId);
    }, WsBridge.IDLE_CHECK_INTERVAL_MS);
    this.idleKillTimers.set(sessionId, timer);
  }

  private stopIdleKillWatchdog(sessionId: string) {
    const timer = this.idleKillTimers.get(sessionId);
    if (timer) {
      clearInterval(timer);
      this.idleKillTimers.delete(sessionId);
      console.log(`[ws-bridge] Cancelled idle kill watchdog for ${sessionId} (browser reconnected)`);
    }
  }

  private checkIdleKill(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.stopIdleKillWatchdog(sessionId);
      return;
    }

    // Browser reconnected — cancel
    if (session.browserSockets.size > 0) {
      this.stopIdleKillWatchdog(sessionId);
      return;
    }

    const idleMs = Date.now() - session.lastCliActivityTs;
    if (idleMs < WsBridge.IDLE_KILL_THRESHOLD_MS) {
      return; // still active or not idle long enough
    }

    // Truly idle with no browsers — kill
    console.log(`[ws-bridge] Idle kill triggered for ${sessionId} (idle ${Math.round(idleMs / 60_000)}min, 0 browsers)`);
    this.stopIdleKillWatchdog(sessionId);
    companionBus.emit("session:idle-kill", { sessionId });
  }

  /** Append to messageHistory with cap. Delegates to ws-bridge-persist. */
  private appendHistory(session: Session, msg: BrowserIncomingMessage) {
    appendHistoryFn(session, msg);
  }

  /**
   * PLAN Task 12 — if `session.streamingAssistant` carries a partial reply
   * that the CLI never closed with a consolidated `assistant` frame,
   * synthesise an assistant message with `streamStatus: "interrupted"`,
   * append it to history, broadcast it to attached browsers, and clear the
   * tracker. Caller is responsible for the surrounding `persistSession`
   * window so the synthesised frame lands on disk in the same write.
   *
   * Idempotent: a second call with the tracker already cleared is a no-op.
   * Drop-no-text: a tracker that only saw `message_start` (no text deltas)
   * yields no message — we will not fabricate an empty bubble for it.
   */
  private flushInterruptedStream(session: Session): void {
    const synthesised = synthesiseInterruptedMessage(session);
    session.streamingAssistant = null;
    if (!synthesised) return;
    this.appendHistory(session, synthesised);
    this.broadcastToBrowsers(session, synthesised);
  }

  // ── Browser message routing ─────────────────────────────────────────────

  private routeBrowserMessage(
    session: Session,
    msg: BrowserOutgoingMessage,
    ws?: ServerWebSocket<SocketData>,
    origin?: "server:cron" | "server:agent" | "server:rest" | "council:peer",
  ) {
    // Bridge-level message types — never forwarded to backend
    if (msg.type === "session_subscribe") {
      handleSessionSubscribe(
        session,
        ws,
        msg.last_seq,
        this.sendToBrowser.bind(this),
        isHistoryBackedEvent,
      );
      return;
    }

    if (msg.type === "session_ack") {
      handleSessionAck(session, ws, msg.last_seq, this.persistSession.bind(this));
      return;
    }

    // Dedup idempotent messages
    if (deduplicateBrowserMessage(
      msg,
      IDEMPOTENT_BROWSER_MESSAGE_TYPES,
      session,
      WsBridge.PROCESSED_CLIENT_MSG_ID_LIMIT,
      this.persistSession.bind(this),
    )) {
      return;
    }

    // -- set_permission_mode: observer-guard + EC-9 telemetry chokepoint --
    // Council Mode (EC-1 server mirror): the observer's permissionMode is
    // locked at spawn (buildObserverSpawnOverrides). Any runtime
    // set_permission_mode targeting an observer must be rejected here BEFORE
    // adapter delivery, regardless of which client crafted the frame.
    // EC-17 fail-closed: a council session whose role probe is null MUST
    // reject — silent allow would let a corrupted council session mutate
    // observer state. `from` snapshot taken before delivery so the
    // adapter's post-send mutation doesn't collapse the transition.
    if (msg.type === "set_permission_mode") {
      const from = session.state.permissionMode;
      const to = msg.mode;
      const sessionGroupId = session.state.sessionGroupId;
      const sessionGroupRole = session.state.sessionGroupRole;
      if (sessionGroupRole === "observer") {
        log.warn("ws-bridge", "set_permission_mode rejected on observer", {
          event: "composer.permission-mode.observer-rejected",
          sessionId: session.id,
          sessionGroupId,
          sessionGroupRole,
          from,
          to,
        });
        return;
      }
      if (sessionGroupId !== undefined && sessionGroupRole === undefined) {
        log.warn("ws-bridge", "set_permission_mode rejected — role probe null", {
          event: "composer.permission-mode.role-probe-null",
          sessionId: session.id,
          sessionGroupId,
          from,
          to,
        });
        return;
      }
      log.info("ws-bridge", "Composer permission-mode toggled", {
        event: "composer.permission-mode.toggled",
        sessionId: session.id,
        sessionGroupId,
        sessionGroupRole,
        from,
        to,
        backend: session.backendType,
      });
      // fall through to existing adapter delivery
    }

    // -- set_ai_validation: bridge-level, not forwarded to backend --------
    if (msg.type === "set_ai_validation") {
      handleSetAiValidation(session, msg);
      this.persistSession(session);
      this.broadcastToBrowsers(session, {
        type: "session_update",
        session: {
          aiValidationEnabled: session.state.aiValidationEnabled,
          aiValidationAutoApprove: session.state.aiValidationAutoApprove,
          aiValidationAutoDeny: session.state.aiValidationAutoDeny,
        },
      });
      return;
    }

    // -- user_message: store in history before delegating to adapter ------
    if (msg.type === "user_message") {
      metricsCollector.recordTurnStarted(session.id);
      // Council Review #12 (EC-16) — server-driven user_message frames
      // (cron-scheduler, linear-agent-bridge, REST `/sessions/:id/inject`)
      // are NOT user activity and MUST NOT advance the synthetic-turn
      // token via `IdleTimerManager.noteUserMessage`. Skip the
      // userFrameObservers fanout for any non-browser origin; log
      // structurally for forensics.
      // Bidirectional pipeline: `council:peer` frames are inter-half
      // coordination, not user typing — same skip semantic.
      const isServerOrigin = origin !== undefined && origin.startsWith("server:");
      const isCouncilPeer = origin === "council:peer";
      const skipUserFrameObservers = isServerOrigin || isCouncilPeer;
      if (skipUserFrameObservers) {
        log.info("ws-bridge", "non-user user_message injection", {
          event: "ws-bridge.non-user-user-message",
          sessionId: session.id,
          sessionGroupId: session.state.sessionGroupId,
          origin,
        });
      }
      // Task 11.6 — cross-tab single-firer for IdleTimerManager.noteUserMessage.
      // Fire BEFORE history append + state-machine transition so the
      // observer (and downstream auto-proceed turn-token advance) sees the
      // frame at the same logical point as the session state mutation. A
      // thrown observer must not corrupt history — guarded per-callback.
      if (!skipUserFrameObservers) {
        for (const observer of this.userFrameObservers) {
          try {
            observer(session.id);
          } catch (err) {
            log.warn("ws-bridge", "userFrameObserver threw", {
              sessionId: session.id,
              error: String(err),
            });
          }
        }
      }
      const ts = Date.now();
      const userMessage: BrowserIncomingMessage = {
        type: "user_message",
        content: msg.content,
        timestamp: ts,
        id: msg.client_msg_id || `user-${ts}-${this.userMsgCounter++}`,
      };
      this.appendHistory(session, userMessage);
      const transitioned = session.stateMachine.transition("streaming", "user_message");
      if (!transitioned) {
        // Session not ready yet (e.g. still initializing). Log a warning so
        // protocol drift is visible, but still forward the message — the
        // backend adapter has its own internal queue for pre-init messages.
        log.warn("ws-bridge", "Session not ready for user message, forwarding to adapter queue", {
          sessionId: session.id,
          phase: session.stateMachine.phase,
        });
      }
      this.persistSession(session);
      this.broadcastToBrowsers(session, userMessage);
    }

    // -- permission_response: populate updatedInput fallback from pending, then remove -------
    if (msg.type === "permission_response") {
      metricsCollector.recordPermissionResolved(msg.request_id, msg.behavior as "allow" | "deny", false);
      const pending = session.pendingPermissions.get(msg.request_id);
      // When the browser sends allow without updated_input, use the original tool input
      // as a fallback. This matches the pre-adapter behavior.
      if (msg.behavior === "allow" && !msg.updated_input && pending?.input) {
        msg = { ...msg, updated_input: pending.input };
      }
      session.pendingPermissions.delete(msg.request_id);
      session.stateMachine.transition("streaming", "permission_resolved");
      this.persistSession(session);
    }

    // Delegate to the backend adapter if connected; otherwise queue for later flush.
    // For Claude: adapter may exist but WS is disconnected (CLI cycling). Queue at
    // bridge level so handleCLIOpen flushes via adapter.send() after reconnect.
    if (session.backendAdapter?.isConnected()) {
      if (session.pendingMessages.length > 0) {
        this.flushQueuedBrowserMessages(session, session.backendAdapter, "backend_connected_send");
        // Preserve FIFO ordering: if flush was interrupted and left pending
        // messages, queue this incoming message behind them instead of sending
        // it immediately (which could overtake older queued work).
        if (session.pendingMessages.length > 0) {
          this.enqueuePendingMessage(session, JSON.stringify(msg));
          this.persistSession(session);
          return;
        }
      }
      const sent = session.backendAdapter.send(msg);
      // Codex can be "adapter-connected" while its underlying transport is in a
      // transient disconnected state. If send rejects retryable messages, keep
      // them queued so they can be flushed after reconnect/relaunch.
      if (!sent && RETRYABLE_BACKEND_MESSAGE_TYPES.has(msg.type)) {
        log.warn("ws-bridge", "Backend send failed, re-queuing", {
          sessionId: session.id,
          messageType: msg.type,
        });
        this.enqueuePendingMessage(session, JSON.stringify(msg));
      }
      this.persistSession(session);
    } else {
      // Adapter not yet attached or transport disconnected — queue for when it reconnects
      log.info("ws-bridge", "Backend not connected, queuing message", {
        sessionId: session.id,
        messageType: msg.type,
      });
      this.enqueuePendingMessage(session, JSON.stringify(msg));
      this.persistSession(session);
    }
  }

  // ── Transport helpers (delegate to ws-bridge-publish) ────────────────────

  /** Push a session name update to all connected browsers for a session. */
  broadcastNameUpdate(sessionId: string, name: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.broadcastToBrowsers(session, { type: "session_name_update", name });
  }

  private broadcastToBrowsers(session: Session, msg: BrowserIncomingMessage) {
    broadcastToBrowsersFn(session, msg, {
      eventBufferLimit: EVENT_BUFFER_LIMIT,
      recorder: this.recorder,
      persistFn: this.persistSession.bind(this),
    });
  }

  private sendToBrowser(ws: ServerWebSocket<SocketData>, msg: BrowserIncomingMessage) {
    sendToBrowserFn(ws, msg);
  }

  /**
   * Flush queued browser-originated messages to an attached backend adapter.
   * Keeps ordering and re-queues retryable messages if dispatch fails.
   */
  /** Enqueue a browser→backend message, dropping the oldest if the queue is full. */
  private enqueuePendingMessage(session: Session, raw: string): void {
    if (session.pendingMessages.length >= WsBridge.PENDING_MESSAGES_LIMIT) {
      const dropped = session.pendingMessages.shift();
      log.warn("ws-bridge", "Pending message queue full, dropping oldest message", {
        sessionId: session.id,
        queueSize: session.pendingMessages.length,
        droppedPreview: dropped?.substring(0, 80),
      });
      this.broadcastToBrowsers(session, {
        type: "error",
        message: "Message queue full: the oldest queued message was discarded.",
      });
    }
    session.pendingMessages.push(raw);
  }

  private flushQueuedBrowserMessages(session: Session, adapter: IBackendAdapter, reason: string): void {
    if (session.pendingMessages.length === 0) return;

    log.info("ws-bridge", "Flushing queued messages", {
      sessionId: session.id,
      backendType: session.backendType,
      reason,
      count: session.pendingMessages.length,
    });

    const queued = session.pendingMessages.splice(0);
    for (let i = 0; i < queued.length; i++) {
      const raw = queued[i];
      let queuedMsg: BrowserOutgoingMessage;
      try {
        queuedMsg = JSON.parse(raw) as BrowserOutgoingMessage;
      } catch {
        log.warn("ws-bridge", "Failed to parse queued message during flush", {
          sessionId: session.id,
          backendType: session.backendType,
          rawPreview: raw.substring(0, 100),
        });
        continue;
      }

      const sent = adapter.send(queuedMsg);
      if (!sent && RETRYABLE_BACKEND_MESSAGE_TYPES.has(queuedMsg.type)) {
        const remaining = queued.slice(i);
        session.pendingMessages = remaining.concat(session.pendingMessages);
        log.warn("ws-bridge", "Queued message flush interrupted, re-queued remaining messages", {
          sessionId: session.id,
          backendType: session.backendType,
          reason,
          failedMessageType: queuedMsg.type,
          remaining: remaining.length,
        });
        break;
      }

      if (!sent) {
        log.warn("ws-bridge", "Dropping non-retryable queued message after flush failure", {
          sessionId: session.id,
          backendType: session.backendType,
          reason,
          failedMessageType: queuedMsg.type,
        });
      }
    }
  }
}
