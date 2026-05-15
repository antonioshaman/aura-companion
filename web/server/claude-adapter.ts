/**
 * Claude Code Backend Adapter
 *
 * Translates between the Claude Code NDJSON WebSocket protocol and
 * Aura Companion's BrowserIncomingMessage/BrowserOutgoingMessage types.
 *
 * This allows the bridge (and by extension the browser) to be completely
 * unaware of which backend is running -- it sees the same message types
 * regardless of whether Claude Code or Codex is the backend.
 */

import { randomUUID } from "node:crypto";
import type { ServerWebSocket } from "bun";
import type { IBackendAdapter } from "./backend-adapter.js";
import type {
  BrowserIncomingMessage,
  BrowserOutgoingMessage,
  CLIMessage,
  CLISystemMessage,
  CLISystemInitMessage,
  CLIAssistantMessage,
  CLIResultMessage,
  CLIStreamEventMessage,
  CLIToolProgressMessage,
  CLIToolUseSummaryMessage,
  CLIControlRequestMessage,
  CLIControlResponseMessage,
  CLIAuthStatusMessage,
  CLIUserEchoMessage,
  CLIControlCancelRequestMessage,
  CLIStreamlinedTextMessage,
  CLIStreamlinedToolUseSummaryMessage,
  CLIPromptSuggestionMessage,
  CLICompactBoundaryMessage,
  CLITaskNotificationMessage,
  CLIFilesPersistedMessage,
  CLIHookStartedMessage,
  CLIHookProgressMessage,
  CLIHookResponseMessage,
  PermissionRequest,
  McpServerDetail,
  SessionState,
} from "./session-types.js";
import type { SocketData } from "./ws-bridge-types.js";
import type { PendingControlRequest } from "./ws-bridge-types.js";
import type { RecorderManager } from "./recorder.js";
import { parseNDJSON, isDuplicateCLIMessage } from "./ws-bridge-cli-ingest.js";
import type { CLIDedupState } from "./ws-bridge-cli-ingest.js";
import { reportProtocolDrift } from "./protocol-monitor.js";
import { companionBus } from "./event-bus.js";
import { isToolUseDeniedForSynthetic, denialMessageForSynthetic } from "./auto-proceed-permissions.js";

// --- Constants ----------------------------------------------------------------

/** Number of recent CLI message hashes to track for deduplication on WS reconnect. */
const CLI_DEDUP_WINDOW = 2000;

/**
 * Backpressure threshold for the server-direction wake send. Bun's
 * `ServerWebSocket.bufferedAmount` accumulates when the peer can't drain
 * fast enough. Wake frames are bounded at OBSERVER_WAKE_MAX_BYTES (32 KiB)
 * so 1 MiB of buffered tells us the observer transport is stuck, not that
 * the message is large — refuse the send rather than silently queue.
 */
const OBSERVER_WAKE_BACKPRESSURE_THRESHOLD_BYTES = 1024 * 1024;

/**
 * Adapter-level outcome of a wake send attempt. The orchestrator's
 * dispatcher (Task 3) wraps this in a richer WakeDispatchOutcome that
 * adds coordinator-side reasons (observer_unknown, group_not_active).
 *
 * - `sent` — NDJSON frame was passed to `cliSocket.send` without throwing.
 *   The observer turn-state is now `in-flight` and idle-kill activity
 *   has been registered.
 * - `socket_disconnected` — cliSocket is null or closing. Transient
 *   observer disconnect window; the dispatcher should keep the pending
 *   checkpoint for the reconnect-aware drain (Task 5).
 * - `busy` — observer is mid-turn from a previous wake. Dispatcher should
 *   enqueue (Task 4).
 * - `backpressure` — bufferedAmount exceeds threshold. Refuse rather
 *   than queue; the next checkpoint will try again.
 * - `failed` — `cliSocket.send` threw synchronously. Logged at EC-9 by
 *   the dispatcher; do NOT mark the half degraded directly (Subprocess
 *   Council Rec 6).
 */
export type ObserverWakeSendOutcome =
  | { kind: "sent" }
  | { kind: "socket_disconnected" }
  | { kind: "busy" }
  | { kind: "backpressure"; bufferedAmount: number }
  | { kind: "failed"; error: string };

// --- Claude Code Adapter ------------------------------------------------------

export class ClaudeAdapter implements IBackendAdapter {
  private sessionId: string;

  // WebSocket to the Claude Code CLI process
  private cliSocket: ServerWebSocket<SocketData> | null = null;

  // Callbacks registered by the bridge via on*() methods
  private browserMessageCb: ((msg: BrowserIncomingMessage) => void) | null = null;
  private sessionMetaCb: ((meta: { cliSessionId?: string; model?: string; cwd?: string }) => void) | null = null;
  private disconnectCb: (() => void) | null = null;

  // Pending NDJSON messages queued before CLI WebSocket connects
  private pendingMessages: string[] = [];

  // Async control request/response pairs (e.g. MCP status queries)
  private pendingControlRequests = new Map<string, PendingControlRequest>();

  // CLI message deduplication state (rolling hash window)
  private dedupState: CLIDedupState = {
    recentCLIMessageHashes: [],
    recentCLIMessageHashSet: new Set(),
  };

  // Optional recorder for raw protocol messages
  private recorder: RecorderManager | null;

  // Callback to update session.lastCliActivityTs from the bridge
  private onActivityUpdate: (() => void) | null;

  // Task 11.8 — narrow probe into IdleTimerManager. The adapter uses it
  // for two synchronous decisions:
  //   1. `can_use_tool` denylist gate — when an auto-proceed synthetic
  //      turn is in flight, dangerous tools (`Bash:git push`, network
  //      operations, etc.) are denied at the adapter without ever
  //      surfacing a permission UI to the user.
  //   2. `result`-frame terminator — clears the pending-synthetic-turn
  //      sticky token so the next idle re-armament starts clean.
  // Null in unit tests that don't exercise auto-proceed (default-safe:
  // gate falls open, terminator no-ops).
  private idleTimerProbe: {
    isSyntheticTurnInFlight(sessionId: string): boolean;
    noteTerminalResultFrame(sessionId: string): void;
  } | null;

  private protocolDriftSeen = new Set<string>();
  private parseErrorSeen = new Set<string>();

  /**
   * Observer turn-state for the Council Mode auto-wake gate.
   *
   * `idle` means the observer is ready for a new `user` frame — either
   * never received one yet (cliSessionId still null), or the previous
   * turn terminated with a `result` NDJSON frame.
   *
   * `in-flight` means a wake `user` frame was sent and we have not yet
   * seen the matching `result` frame back. Subsequent wake attempts
   * return {kind:"busy"} so the dispatcher can enqueue (Task 4 newest-
   * wins slot).
   *
   * Browser-initiated `user_message` traffic does NOT touch this field —
   * it tracks ONLY the auto-wake pump. The observer-tab composer is
   * disabled in council mode, so cross-contamination isn't a concern,
   * but the field name and the toggle sites are scoped narrowly on
   * purpose.
   */
  private observerTurnState: "idle" | "in-flight" = "idle";

  /**
   * Orchestrator-half per-turn state. Mirrors `observerTurnState` but
   * tracks the user-driven cycle on the OTHER half of a Council pair
   * (and on solo sessions). Discriminated union — NOT a boolean — so
   * the JS-3 axis (`blockedByStop`) lives in the type system rather
   * than as a sibling field that the next refactor can silently drop.
   *
   *  - `{kind:"in-flight"}` — a `user_message` was sent to the CLI and
   *    we have not yet seen the matching `result` frame back.
   *  - `{kind:"awaiting-input", blockedByStop:boolean}` — turn done,
   *    orchestrator is waiting for user input. `blockedByStop=true`
   *    when an unresolved STOP finding exists in the session's
   *    Council group; idle-driven consumers MUST pause when this is
   *    true. The adapter does not own STOP knowledge — it emits
   *    `false` and exposes a setter for the council slice to flip.
   *
   * Initial state is `awaiting-input` because a freshly-attached
   * session has no in-flight turn yet. Reset to `awaiting-input` on
   * `attachWebSocket`/`detachWebSocket` so a transient WS flap mid-turn
   * doesn't leave the state machine permanently in-flight. Fires the
   * `orchestrator:turn-done` event on the in-flight → awaiting-input
   * transition only (matches the `observer:turn-done` discipline —
   * never fires on a still-in-state transition).
   */
  private orchestratorTurnState:
    | { kind: "in-flight" }
    | { kind: "awaiting-input"; blockedByStop: boolean } = { kind: "awaiting-input", blockedByStop: false };

  constructor(
    sessionId: string,
    opts?: {
      recorder?: RecorderManager | null;
      onActivityUpdate?: () => void;
      idleTimerProbe?: {
        isSyntheticTurnInFlight(sessionId: string): boolean;
        noteTerminalResultFrame(sessionId: string): void;
      } | null;
    },
  ) {
    this.sessionId = sessionId;
    this.recorder = opts?.recorder ?? null;
    this.onActivityUpdate = opts?.onActivityUpdate ?? null;
    this.idleTimerProbe = opts?.idleTimerProbe ?? null;
  }

  // -- WebSocket lifecycle ----------------------------------------------------

  /**
   * Called when the CLI WebSocket connects. Stores the socket reference and
   * flushes any NDJSON messages that were queued before the connection.
   */
  attachWebSocket(ws: ServerWebSocket<SocketData>): void {
    this.cliSocket = ws;
    // Council Review 2026-05-13 Subprocess #5: reset turn-state on every
    // attach. A fresh socket is by definition a fresh turn — closes the
    // late-detach race where the stale-socket guard in detachWebSocket
    // skips the reset, leaving `in-flight` from the prior socket and
    // permanently blocking the dispatcher.
    this.observerTurnState = "idle";
    // Same discipline for the orchestrator half: a fresh socket has no
    // in-flight turn. Default `blockedByStop` to false on reattach —
    // the council slice will re-mutate via setter (Task 8 surface) when
    // it next reconciles the session against the unresolved-STOP set.
    this.orchestratorTurnState = { kind: "awaiting-input", blockedByStop: false };

    // Flush pending messages
    if (this.pendingMessages.length > 0) {
      console.log(
        `[claude-adapter] Flushing ${this.pendingMessages.length} queued message(s) for session ${this.sessionId}`,
      );
      const queued = this.pendingMessages.splice(0);
      for (const ndjson of queued) {
        this.sendRaw(ndjson);
      }
    }
  }

  /**
   * Called when the CLI WebSocket closes. Guards against stale socket references
   * (a new WS may have opened before the old one closed).
   *
   * Council Review 2026-05-13 Subprocess #2: reset `observerTurnState` to
   * `idle` on detach. Turn-state is socket-bound; a fresh socket starts
   * idle. Without this reset, a transient WS flap mid-turn left the
   * adapter permanently in-flight and every subsequent wake returned
   * `busy` regardless of actual observer state.
   */
  detachWebSocket(ws: ServerWebSocket<SocketData>): void {
    // Only detach if this is the current socket -- ignore stale close events
    if (this.cliSocket !== ws) return;
    this.cliSocket = null;
    this.observerTurnState = "idle";
    // Mirror reset for the orchestrator-half. See `observerTurnState`
    // comment immediately above; same socket-bound semantics.
    this.orchestratorTurnState = { kind: "awaiting-input", blockedByStop: false };
    // Council Review #13 — mid-flap cleanup: clear pendingControlRequests
    // so unresolved Promise resolvers from the now-dead socket don't leak
    // into the next attach. `disconnect()` already clears this (line 283);
    // detachWebSocket is the WS-close-event path that bypassed it. Without
    // this, a flap with in-flight control requests can wedge memory plus
    // leave the next attach's caller waiting on a resolver that will
    // never fire.
    this.pendingControlRequests.clear();
    this.disconnectCb?.();
  }

  // -- IBackendAdapter: Event registration ------------------------------------

  onBrowserMessage(cb: (msg: BrowserIncomingMessage) => void): void {
    this.browserMessageCb = cb;
  }

  onSessionMeta(cb: (meta: { cliSessionId?: string; model?: string; cwd?: string }) => void): void {
    this.sessionMetaCb = cb;
  }

  onDisconnect(cb: () => void): void {
    this.disconnectCb = cb;
  }

  // -- IBackendAdapter: Transport state ---------------------------------------

  isConnected(): boolean {
    return this.cliSocket !== null;
  }

  async disconnect(): Promise<void> {
    // Clear pending control requests to prevent memory leaks from
    // unresolved promises (CLI won't respond after disconnect)
    this.pendingControlRequests.clear();
    if (this.cliSocket) {
      try {
        this.cliSocket.close();
      } catch {
        // Socket may already be closed
      }
      this.cliSocket = null;
    }
  }

  /**
   * Handle transport-level close (used when WS proxy drops).
   * Clears the socket reference without triggering the disconnect callback,
   * allowing the CLI to reconnect.
   *
   * Council Review 2026-05-13 Subprocess #2: also reset `observerTurnState`
   * — transport closing means any in-flight wake's `result` frame will
   * never arrive. Stale `in-flight` here would deadlock the dispatcher.
   */
  handleTransportClose(): void {
    this.cliSocket = null;
    this.observerTurnState = "idle";
  }

  // -- IBackendAdapter: Raw message ingestion from CLI ------------------------

  /**
   * Called when raw NDJSON data arrives from the CLI WebSocket.
   * Parses lines, deduplicates, and routes each message.
   */
  handleRawMessage(data: string): void {
    // Record raw incoming CLI message before any parsing
    this.recorder?.record(
      this.sessionId, "in", data, "cli", "claude", "",
    );

    const lines = parseNDJSON(data);
    for (const line of lines) {
      let msg: CLIMessage;
      try {
        msg = JSON.parse(line);
      } catch {
        reportProtocolDrift(
          this.parseErrorSeen,
          {
            backend: "claude",
            sessionId: this.sessionId,
            direction: "incoming",
            messageKind: "parse_error",
            messageName: "ndjson",
            rawPreview: line,
          },
          (message) => this.browserMessageCb?.({ type: "error", message }),
        );
        continue;
      }

      if (isDuplicateCLIMessage(msg, line, this.dedupState, CLI_DEDUP_WINDOW)) {
        continue;
      }

      this.routeCLIMessage(msg);
    }
  }

  // -- IBackendAdapter: send() -- browser -> CLI translation ------------------

  send(msg: BrowserOutgoingMessage): boolean {
    switch (msg.type) {
      case "user_message":
        return this.handleOutgoingUserMessage(msg);

      case "permission_response":
        return this.handleOutgoingPermissionResponse(msg);

      case "interrupt":
        return this.handleOutgoingInterrupt();

      case "set_model":
        return this.handleOutgoingSetModel(msg.model);

      case "set_permission_mode":
        return this.handleOutgoingSetPermissionMode(msg.mode);

      case "set_ai_validation":
        // AI validation state is managed at the bridge/session level, not
        // forwarded to the CLI. Return true to indicate acceptance.
        return true;

      case "mcp_get_status":
        return this.handleOutgoingMcpGetStatus();

      case "mcp_toggle":
        return this.handleOutgoingMcpToggle(msg.serverName, msg.enabled);

      case "mcp_reconnect":
        return this.handleOutgoingMcpReconnect(msg.serverName);

      case "mcp_set_servers":
        return this.handleOutgoingMcpSetServers(msg.servers);

      case "end_session":
        return this.handleOutgoingEndSession((msg as { reason?: string }).reason);

      case "stop_task":
        return this.handleOutgoingStopTask((msg as { task_id: string }).task_id);

      case "update_environment_variables":
        return this.handleOutgoingUpdateEnvVars((msg as { variables: Record<string, string> }).variables);

      case "session_subscribe":
      case "session_ack":
        // These are handled at the bridge level -- never forwarded to the backend.
        return false;

      default:
        return false;
    }
  }

  // -- Outgoing message handlers (browser -> NDJSON) --------------------------

  private handleOutgoingUserMessage(
    msg: { type: "user_message"; content: string; session_id?: string; images?: { media_type: string; data: string }[] },
  ): boolean {
    // Build content: if images are present, use content block array; otherwise plain string
    let content: string | unknown[];
    if (msg.images?.length) {
      const blocks: unknown[] = [];
      for (const img of msg.images) {
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: img.media_type, data: img.data },
        });
      }
      blocks.push({ type: "text", text: msg.content });
      content = blocks;
    } else {
      content = msg.content;
    }

    const ndjson = JSON.stringify({
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      session_id: msg.session_id || "",
    });
    this.sendToBackend(ndjson);
    // Track the orchestrator turn flip on the user-message path. The
    // adapter cannot tell apart a user-typed message from a synthetic
    // server-sourced one at this seam — both produce identical NDJSON
    // bodies by design (per the auto-proceed envelope contract). That
    // is the correct behaviour: the in-flight transition tracks the
    // CLI's perception of "a turn is now running", not the
    // provenance of the prompt. Provenance is recorded separately by
    // the recorder (Task 11 of the auto-proceed plan).
    this.orchestratorTurnState = { kind: "in-flight" };
    return true;
  }

  private handleOutgoingPermissionResponse(
    msg: {
      type: "permission_response";
      request_id: string;
      behavior: "allow" | "deny";
      updated_input?: Record<string, unknown>;
      updated_permissions?: unknown[];
      message?: string;
    },
  ): boolean {
    if (msg.behavior === "allow") {
      const response: Record<string, unknown> = {
        behavior: "allow",
        updatedInput: msg.updated_input ?? {},
      };
      if (msg.updated_permissions?.length) {
        response.updatedPermissions = msg.updated_permissions;
      }
      const ndjson = JSON.stringify({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: msg.request_id,
          response,
        },
      });
      this.sendToBackend(ndjson);
    } else {
      const ndjson = JSON.stringify({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: msg.request_id,
          response: {
            behavior: "deny",
            message: msg.message || "Denied by user",
          },
        },
      });
      this.sendToBackend(ndjson);
    }
    return true;
  }

  private handleOutgoingInterrupt(): boolean {
    const ndjson = JSON.stringify({
      type: "control_request",
      request_id: randomUUID(),
      request: { subtype: "interrupt" },
    });
    this.sendToBackend(ndjson);
    return true;
  }

  private handleOutgoingSetModel(model: string): boolean {
    const ndjson = JSON.stringify({
      type: "control_request",
      request_id: randomUUID(),
      request: { subtype: "set_model", model },
    });
    this.sendToBackend(ndjson);
    return true;
  }

  private handleOutgoingSetPermissionMode(mode: string): boolean {
    const ndjson = JSON.stringify({
      type: "control_request",
      request_id: randomUUID(),
      request: { subtype: "set_permission_mode", mode },
    });
    this.sendToBackend(ndjson);
    return true;
  }

  private handleOutgoingMcpGetStatus(): boolean {
    this.sendControlRequest(
      { subtype: "mcp_status" },
      {
        subtype: "mcp_status",
        resolve: (response) => {
          const servers = (response as { mcpServers?: McpServerDetail[] }).mcpServers ?? [];
          this.browserMessageCb?.({ type: "mcp_status", servers });
        },
      },
    );
    return true;
  }

  private handleOutgoingMcpToggle(serverName: string, enabled: boolean): boolean {
    this.sendControlRequest({ subtype: "mcp_toggle", serverName, enabled });
    // Refresh MCP status after a delay to pick up the change
    setTimeout(() => this.handleOutgoingMcpGetStatus(), 500);
    return true;
  }

  private handleOutgoingMcpReconnect(serverName: string): boolean {
    this.sendControlRequest({ subtype: "mcp_reconnect", serverName });
    // Refresh MCP status after a delay to pick up the reconnection
    setTimeout(() => this.handleOutgoingMcpGetStatus(), 1000);
    return true;
  }

  private handleOutgoingMcpSetServers(servers: Record<string, unknown>): boolean {
    this.sendControlRequest({ subtype: "mcp_set_servers", servers });
    // Refresh MCP status after a delay to pick up the new server config
    setTimeout(() => this.handleOutgoingMcpGetStatus(), 2000);
    return true;
  }

  private handleOutgoingEndSession(reason?: string): boolean {
    this.sendControlRequest({ subtype: "end_session", ...(reason ? { reason } : {}) });
    return true;
  }

  private handleOutgoingStopTask(taskId: string): boolean {
    this.sendControlRequest({ subtype: "stop_task", task_id: taskId });
    return true;
  }

  private handleOutgoingUpdateEnvVars(variables: Record<string, string>): boolean {
    const ndjson = JSON.stringify({
      type: "update_environment_variables",
      variables,
    });
    this.sendToBackend(ndjson);
    return true;
  }

  // -- CLI message routing (NDJSON -> BrowserIncomingMessage) -----------------

  private routeCLIMessage(msg: CLIMessage): void {
    // Track activity for idle detection (skip keepalives -- they don't indicate real work)
    if (msg.type !== "keep_alive") {
      this.onActivityUpdate?.();
    }

    switch (msg.type) {
      case "system":
        this.handleSystemMessage(msg);
        break;

      case "assistant":
        this.handleAssistantMessage(msg);
        break;

      case "result":
        this.handleResultMessage(msg);
        break;

      case "stream_event":
        this.handleStreamEvent(msg);
        break;

      case "control_request":
        this.handleControlRequest(msg);
        break;

      case "control_response":
        this.handleControlResponse(msg);
        break;

      case "tool_progress":
        this.handleToolProgress(msg);
        break;

      case "tool_use_summary":
        this.handleToolUseSummary(msg);
        break;

      case "auth_status":
        this.handleAuthStatus(msg);
        break;

      case "keep_alive":
        // Silently consume keepalives
        break;

      case "user":
        // CLI echoes back user messages (including tool_result blocks from
        // subagents). These are informational — the bridge already persists
        // user messages from the browser side, so we emit them for history
        // completeness but don't need special handling.
        this.handleUserEcho(msg as CLIUserEchoMessage);
        break;

      case "rate_limit_event":
        // Rate-limit status from Claude API (allowed/throttled). Silently
        // consumed — no user-facing action needed.
        break;

      case "control_cancel_request":
        this.handleControlCancelRequest(msg as CLIControlCancelRequestMessage);
        break;

      case "streamlined_text":
        this.handleStreamlinedText(msg as CLIStreamlinedTextMessage);
        break;

      case "streamlined_tool_use_summary":
        this.handleStreamlinedToolUseSummary(msg as CLIStreamlinedToolUseSummaryMessage);
        break;

      case "prompt_suggestion":
        this.handlePromptSuggestion(msg as CLIPromptSuggestionMessage);
        break;

      default:
        reportProtocolDrift(
          this.protocolDriftSeen,
          {
            backend: "claude",
            sessionId: this.sessionId,
            direction: "incoming",
            messageKind: "message",
            messageName: (msg as { type?: string }).type || "unknown",
            rawPreview: JSON.stringify(msg),
          },
          (message) => this.browserMessageCb?.({ type: "error", message }),
        );
        break;
    }
  }

  // -- System message handling ------------------------------------------------

  private handleSystemMessage(msg: CLISystemMessage): void {
    if (msg.subtype === "init") {
      this.handleSystemInit(msg as CLISystemInitMessage);
      return;
    }

    if (msg.subtype === "status") {
      const statusMsg = msg as { subtype: "status"; status: "compacting" | null; permissionMode?: string; uuid: string; session_id: string };
      // Include permissionMode in the emitted message so the bridge can update session state
      const statusChange: Record<string, unknown> = {
        type: "status_change",
        status: statusMsg.status ?? null,
      };
      if (statusMsg.permissionMode) {
        statusChange.permissionMode = statusMsg.permissionMode;
      }
      this.browserMessageCb?.(statusChange as BrowserIncomingMessage);
      return;
    }

    if (msg.subtype === "compact_boundary") {
      const m = msg as CLICompactBoundaryMessage;
      this.emitSystemEvent({
        subtype: "compact_boundary",
        compact_metadata: m.compact_metadata,
        uuid: m.uuid,
        session_id: m.session_id,
      });
      return;
    }

    if (msg.subtype === "task_notification") {
      const m = msg as CLITaskNotificationMessage;
      this.emitSystemEvent({
        subtype: "task_notification",
        task_id: m.task_id,
        status: m.status,
        output_file: m.output_file,
        summary: m.summary,
        uuid: m.uuid,
        session_id: m.session_id,
      });
      return;
    }

    if (msg.subtype === "files_persisted") {
      const m = msg as CLIFilesPersistedMessage;
      this.emitSystemEvent({
        subtype: "files_persisted",
        files: m.files,
        failed: m.failed,
        processed_at: m.processed_at,
        uuid: m.uuid,
        session_id: m.session_id,
      });
      return;
    }

    if (msg.subtype === "hook_started") {
      const m = msg as CLIHookStartedMessage;
      this.emitSystemEvent({
        subtype: "hook_started",
        hook_id: m.hook_id,
        hook_name: m.hook_name,
        hook_event: m.hook_event,
        uuid: m.uuid,
        session_id: m.session_id,
      });
      return;
    }

    if (msg.subtype === "hook_progress") {
      const m = msg as CLIHookProgressMessage;
      // hook_progress is transient -- emitted but not persisted in message history.
      // The bridge handler decides on persistence based on message type.
      this.emitSystemEvent({
        subtype: "hook_progress",
        hook_id: m.hook_id,
        hook_name: m.hook_name,
        hook_event: m.hook_event,
        stdout: m.stdout,
        stderr: m.stderr,
        output: m.output,
        uuid: m.uuid,
        session_id: m.session_id,
      });
      return;
    }

    if (msg.subtype === "hook_response") {
      const m = msg as CLIHookResponseMessage;
      this.emitSystemEvent({
        subtype: "hook_response",
        hook_id: m.hook_id,
        hook_name: m.hook_name,
        hook_event: m.hook_event,
        output: m.output,
        stdout: m.stdout,
        stderr: m.stderr,
        exit_code: m.exit_code,
        outcome: m.outcome,
        uuid: m.uuid,
        session_id: m.session_id,
      });
      return;
    }

    // Unknown system subtypes are intentionally ignored until we map them.
  }

  private handleSystemInit(msg: CLISystemInitMessage): void {
    // Emit session metadata so the bridge can update session state
    this.sessionMetaCb?.({
      cliSessionId: msg.session_id,
      model: msg.model,
      cwd: msg.cwd,
    });

    // Emit session_init to browsers with CLI-provided fields only.
    // The bridge's attachBackendAdapter handler will merge these into the
    // canonical session state (which owns git info, cost, etc.) and broadcast.
    this.browserMessageCb?.({
      type: "session_init",
      session: {
        session_id: msg.session_id,
        model: msg.model,
        cwd: msg.cwd,
        tools: msg.tools,
        permissionMode: msg.permissionMode,
        claude_code_version: msg.claude_code_version,
        mcp_servers: msg.mcp_servers,
        agents: msg.agents ?? [],
        slash_commands: msg.slash_commands ?? [],
        skills: msg.skills ?? [],
      } as SessionState,
    });

    // Flush any NDJSON messages queued before the CLI was initialized
    // (e.g. user sent a message while the CLI was still starting up).
    if (this.pendingMessages.length > 0) {
      console.log(
        `[claude-adapter] Flushing ${this.pendingMessages.length} queued message(s) after init for session ${this.sessionId}`,
      );
      const queued = this.pendingMessages.splice(0);
      for (const ndjson of queued) {
        this.sendRaw(ndjson);
      }
    }
  }

  // -- Assistant, result, stream ----------------------------------------------

  private handleAssistantMessage(msg: CLIAssistantMessage): void {
    this.browserMessageCb?.({
      type: "assistant",
      message: msg.message,
      parent_tool_use_id: msg.parent_tool_use_id,
      timestamp: Date.now(),
    });
  }

  private handleResultMessage(msg: CLIResultMessage): void {
    // Council Mode auto-wake: `result` is the documented per-turn
    // terminator in the Claude Code NDJSON protocol. When we see one
    // and the observer was mid-flight from an auto-wake, flip back to
    // idle and emit `observer:turn-done` so the orchestrator's drain
    // hook can dispatch any queued checkpoint (Task 4 newest-wins slot).
    // Browser-initiated user_message paths never set in-flight, so
    // emitting only on the in-flight → idle transition keeps non-council
    // sessions off the bus channel.
    if (this.observerTurnState === "in-flight") {
      this.observerTurnState = "idle";
      companionBus.emit("observer:turn-done", { sessionId: this.sessionId });
    }
    // Orchestrator-half symmetric emit. Only fires on the in-flight →
    // awaiting-input transition so a `result` arriving for a session
    // that was already awaiting (e.g. CLI re-handshake replay) does
    // not double-fire the consumers (idle-timer-manager would
    // mis-account iteration counters). `blockedByStop` defaults to
    // false at this seam — the council slice owns the STOP-aware
    // axis and may mutate via setter (Task 8 wiring).
    if (this.orchestratorTurnState.kind === "in-flight") {
      this.orchestratorTurnState = { kind: "awaiting-input", blockedByStop: false };
      companionBus.emit("orchestrator:turn-done", {
        sessionId: this.sessionId,
        blockedByStop: false,
      });
      // Task 11.8 — clear the pending-synthetic-turn sticky token on
      // the happy-path turn-completion edge. `noteTerminalResultFrame`
      // is idempotent on never-armed sessions, so calling it for every
      // result-frame is safe (the manager owns the predicate). Without
      // this, a successful synthetic turn would leave the sticky token
      // set forever, and the next can_use_tool check would still treat
      // the session as auto-proceed-driven.
      this.idleTimerProbe?.noteTerminalResultFrame(this.sessionId);
    }
    this.browserMessageCb?.({
      type: "result",
      data: msg,
    });
  }

  private handleStreamEvent(msg: CLIStreamEventMessage): void {
    this.browserMessageCb?.({
      type: "stream_event",
      event: msg.event,
      parent_tool_use_id: msg.parent_tool_use_id,
    });
  }

  // -- Control request (permission) -------------------------------------------

  private handleControlRequest(msg: CLIControlRequestMessage): void {
    if (msg.request.subtype === "can_use_tool") {
      // Task 11.8 — auto-proceed denylist gate. When a synthetic turn is
      // in flight and the requested tool is in the denylist (Bash:git push,
      // git commit, gh pr create, gh pr merge — publish-to-others ops),
      // respond directly with `behavior: "deny"` and do NOT surface the
      // permission request to the user's browser. This prevents an
      // unattended auto-proceed loop from triggering publish operations
      // that would have required explicit user approval.
      //
      // CR-1 fix (fail-CLOSED on probe-null): the previous predicate
      // `this.idleTimerProbe?.isSyntheticTurnInFlight(...)` optional-
      // chained to `undefined` when the probe was null and the entire
      // denylist branch was skipped — fail-OPEN. Three council reviewers
      // (Willison × Hunt × Subprocess) converged on the same DI-ordering
      // risk. The fix: if the probe is null but the tool itself is in
      // the denylist, deny REGARDLESS of in-flight state (defence-in-
      // depth over availability — the synthetic-turn case is unattended
      // and a malformed/missing probe should not auto-allow). Per
      // `feedback_multi_expert_convergence_promotion` this is structural
      // truth, not paranoia.
      //
      // Honest scope: the denylist is a defence-in-depth string-match
      // filter and CANNOT catch shell-escapes (`bash -c '...'`, command
      // substitution, chained operators), nor non-string tool_name from
      // protocol drift (covered separately in auto-proceed-permissions.ts).
      const toolDenylisted = isToolUseDeniedForSynthetic(msg.request.tool_name, msg.request.input);
      const probeReportsInFlight = this.idleTimerProbe?.isSyntheticTurnInFlight(this.sessionId);
      const probeMissing = this.idleTimerProbe === null;
      if (toolDenylisted && (probeReportsInFlight || probeMissing)) {
        const denyNdjson = JSON.stringify({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: msg.request_id,
            response: {
              behavior: "deny",
              message: denialMessageForSynthetic(msg.request.tool_name, msg.request.input),
            },
          },
        });
        this.sendToBackend(denyNdjson);
        return;
      }

      const perm: PermissionRequest = {
        request_id: msg.request_id,
        tool_name: msg.request.tool_name,
        input: msg.request.input,
        permission_suggestions: msg.request.permission_suggestions,
        description: msg.request.description,
        tool_use_id: msg.request.tool_use_id,
        agent_id: msg.request.agent_id,
        title: msg.request.title,
        display_name: msg.request.display_name,
        blocked_path: msg.request.blocked_path,
        decision_reason: msg.request.decision_reason,
        timestamp: Date.now(),
      };

      this.browserMessageCb?.({
        type: "permission_request",
        request: perm,
      });
    }
  }

  // -- Control cancel request ------------------------------------------------

  private handleControlCancelRequest(msg: CLIControlCancelRequestMessage): void {
    // Clean up any pending async control request in the adapter
    this.pendingControlRequests.delete(msg.request_id);
    // Emit permission_cancelled so the bridge removes from pendingPermissions
    this.browserMessageCb?.({
      type: "permission_cancelled",
      request_id: msg.request_id,
    });
  }

  // -- Streamlined messages (simplified output mode) -------------------------

  private handleStreamlinedText(msg: CLIStreamlinedTextMessage): void {
    this.browserMessageCb?.({
      type: "streamlined_text",
      text: msg.text,
    } as BrowserIncomingMessage);
  }

  private handleStreamlinedToolUseSummary(msg: CLIStreamlinedToolUseSummaryMessage): void {
    this.browserMessageCb?.({
      type: "streamlined_tool_use_summary",
      tool_summary: msg.tool_summary,
    } as BrowserIncomingMessage);
  }

  // -- Prompt suggestions ----------------------------------------------------

  private handlePromptSuggestion(msg: CLIPromptSuggestionMessage): void {
    this.browserMessageCb?.({
      type: "prompt_suggestion",
      suggestions: msg.suggestions,
    } as BrowserIncomingMessage);
  }

  // -- Control response (for pending control requests like MCP status) --------

  private handleControlResponse(msg: CLIControlResponseMessage): void {
    const reqId = msg.response.request_id;
    const pending = this.pendingControlRequests.get(reqId);
    if (!pending) return;
    this.pendingControlRequests.delete(reqId);
    if (msg.response.subtype === "error") {
      console.warn(
        `[claude-adapter] Control request ${pending.subtype} failed: ${msg.response.error}`,
      );
      return;
    }
    pending.resolve(msg.response.response ?? {});
  }

  // -- Tool progress & summary ------------------------------------------------

  private handleToolProgress(msg: CLIToolProgressMessage): void {
    this.browserMessageCb?.({
      type: "tool_progress",
      tool_use_id: msg.tool_use_id,
      tool_name: msg.tool_name,
      elapsed_time_seconds: msg.elapsed_time_seconds,
    });
  }

  private handleToolUseSummary(msg: CLIToolUseSummaryMessage): void {
    this.browserMessageCb?.({
      type: "tool_use_summary",
      summary: msg.summary,
      tool_use_ids: msg.preceding_tool_use_ids,
    });
  }

  // -- User echo --------------------------------------------------------------

  private handleUserEcho(_msg: CLIUserEchoMessage): void {
    // The CLI echoes every user-role message back, including the protocol-level
    // tool_result arrays the SDK sends after each assistant tool_use. These
    // echoes carry no information the browser doesn't already have:
    //   - String echoes duplicate the user's own composer message.
    //   - Array echoes (tool_result blocks) duplicate output already surfaced
    //     via the assistant's tool_use ToolBlock + tool_progress + completedAt.
    // Forwarding them produced raw JSON dumps in the chat, so drop silently.
  }

  // -- Auth status ------------------------------------------------------------

  private handleAuthStatus(msg: CLIAuthStatusMessage): void {
    this.browserMessageCb?.({
      type: "auth_status",
      isAuthenticating: msg.isAuthenticating,
      output: msg.output,
      error: msg.error,
    });
  }

  // -- Helpers ----------------------------------------------------------------

  /**
   * Emit a system_event BrowserIncomingMessage to browsers.
   */
  private emitSystemEvent(
    event: Extract<BrowserIncomingMessage, { type: "system_event" }>["event"],
  ): void {
    this.browserMessageCb?.({
      type: "system_event",
      event,
      timestamp: Date.now(),
    });
  }

  /**
   * Send a control_request to the CLI and optionally track the pending response.
   */
  private sendControlRequest(
    request: Record<string, unknown>,
    onResponse?: { subtype: string; resolve: (response: unknown) => void },
  ): void {
    const requestId = randomUUID();
    if (onResponse) {
      this.pendingControlRequests.set(requestId, onResponse);
    }
    const ndjson = JSON.stringify({
      type: "control_request",
      request_id: requestId,
      request,
    });
    this.sendToBackend(ndjson);
  }

  /**
   * Send a raw NDJSON string to the CLI, bypassing the BrowserOutgoingMessage
   * translation layer. Used for Claude-specific control requests (e.g. initialize)
   * that don't map to a BrowserOutgoingMessage type.
   */
  sendRawNDJSON(ndjson: string): void {
    this.sendToBackend(ndjson);
  }

  /**
   * Council Mode auto-wake seam: synthesise a `user` NDJSON frame on the
   * server's own initiative and push it to the observer's CLI socket.
   *
   * This is the ONLY server-internal-origin path that emits a `user`
   * frame to the CLI. Every other `user` frame is browser-relayed via
   * {@link handleOutgoingUserMessage}. The `FromServer` suffix is
   * load-bearing — it makes the unusual provenance grep-able at every
   * current and future call site.
   *
   * Gating order — three strict checks per Subprocess Council Rec 3:
   * 1. `observerTurnState === "in-flight"` → return `busy`
   * 2. `cliSocket` is null or not OPEN → return `socket_disconnected`
   * 3. `bufferedAmount > OBSERVER_WAKE_BACKPRESSURE_THRESHOLD_BYTES`
   *    → return `backpressure`
   *
   * On a successful send: flip turn-state to `in-flight`, register
   * idle-kill activity (wake counts as activity — observer working
   * continuously via auto-wake must not be killed at 4h), record the
   * outgoing frame.
   *
   * `content` is the assembled wake message body from
   * {@link buildObserverWakePayload}. It is passed straight into the
   * NDJSON envelope's `content[0].text` field. JSON.stringify escapes
   * any `\n` inside it to `\\n` so the serialised line is single-line by
   * construction; the post-stringify assertion catches builder bugs that
   * would otherwise unframe the observer's stream-json reader (Hunt P1
   * NDJSON line-discipline injection).
   *
   * `session_id` is `""` — the Claude Code NDJSON protocol documents this
   * for the first `user` frame to a freshly spawned CLI, and the
   * browser-side path also passes `""` by default. The observer's CLI
   * binds session via socket identity, not via the field.
   */
  /**
   * Task 11.8 — auto-proceed synthetic frame send. Mirror of
   * {@link sendUserFrameFromServer} (observer-wake path) but addressed
   * to the ORCHESTRATOR half, with recorder origin `server:auto-proceed`
   * so replays can distinguish auto-proceed-driven turns from
   * council-wake-driven ones and from browser-relayed user frames.
   *
   * Honest scope: this is a direct send, not routed through an outbound
   * FIFO queue. PR #52 (Task 11.1+11.2) adds `enqueueOutboundFrame` with
   * kind-aware overflow policy; once merged, this method should route
   * through it (kind: "synthetic"). Until then, behaviour matches
   * `sendUserFrameFromServer` (transport + backpressure gates only).
   *
   * The gate stack does NOT consult observer turn-state — synthetic is
   * an orchestrator-side concern and orchestrator turn-state is the
   * caller's responsibility (`IdleTimerManager.fire` already checks).
   */
  sendOrchestratorSyntheticFrame(content: string): ObserverWakeSendOutcome {
    this.onActivityUpdate?.();

    // CR-2 fix: orchestrator turn-state gate. The previous shape
    // explicitly handwaved the check to the caller (IdleTimerManager.fire)
    // running in a different stack — a TOCTOU window where a real user
    // could flip orchestratorTurnState to `in-flight` via
    // handleOutgoingUserMessage between the manager's read and this
    // adapter's send. The CLI would then have two `user` frames pending
    // against one orchestrator slot; the second result-frame to arrive
    // would fire the in-flight → awaiting-input transition prematurely,
    // clear the synthetic sticky token, and the genuine user's later
    // result would find state already `awaiting-input` and silently
    // drop both the bus event AND cleanup. Carmack: the check and the
    // act must be the same act. Mirrors `sendUserFrameFromServer` Gate 1.
    if (this.orchestratorTurnState.kind === "in-flight") {
      return { kind: "busy" };
    }

    if (!this.cliSocket) {
      return { kind: "socket_disconnected" };
    }
    if (this.cliSocket.readyState !== 1) {
      return { kind: "socket_disconnected" };
    }

    const buffered = this.cliSocket.getBufferedAmount();
    if (buffered > OBSERVER_WAKE_BACKPRESSURE_THRESHOLD_BYTES) {
      return { kind: "backpressure", bufferedAmount: buffered };
    }

    const frame = JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: content }] },
      parent_tool_use_id: null,
      session_id: "",
    });
    if (frame.includes("\n")) {
      return {
        kind: "failed",
        error: "NDJSON line-discipline violated: frame contains embedded newline",
      };
    }

    try {
      // Record BEFORE send so a crash-during-send leaves a forensic
      // trail. `origin: "server:auto-proceed"` distinguishes this from
      // browser-relayed user frames AND from council-wake frames in
      // replay — see RecorderManager's RecordingOrigin union.
      this.recorder?.record(
        this.sessionId, "out", frame, "cli", "claude", "", "server:auto-proceed",
      );
      this.cliSocket.send(frame + "\n");
    } catch (err) {
      return {
        kind: "failed",
        error: err instanceof Error ? err.message : String(err),
      };
    }

    this.orchestratorTurnState = { kind: "in-flight" };
    return { kind: "sent" };
  }

  sendUserFrameFromServer(content: string): ObserverWakeSendOutcome {
    // Council Review 2026-05-13 Subprocess #15: register idle-kill
    // activity unconditionally, BEFORE the gates. A wake-dispatch
    // attempt is real activity even when gated out (observer is mid-
    // turn, transient socket flap, backpressure) — the orchestrator
    // clearly producing checkpoints means the group is alive and
    // should not idle-kill the observer at 4h. Previously this was
    // inside the success branch, so a long-running review with
    // intervening busy-gated checkpoints would still tick toward
    // idle-kill.
    this.onActivityUpdate?.();

    // Gate 1: turn-state.
    if (this.observerTurnState === "in-flight") {
      return { kind: "busy" };
    }

    // Gate 2: transport. readyState 1 === OPEN per WebSocket spec.
    if (!this.cliSocket) {
      return { kind: "socket_disconnected" };
    }
    if (this.cliSocket.readyState !== 1) {
      return { kind: "socket_disconnected" };
    }

    // Gate 3: backpressure. Bun's ServerWebSocket exposes
    // getBufferedAmount(); refuse rather than silently queue in JS.
    const buffered = this.cliSocket.getBufferedAmount();
    if (buffered > OBSERVER_WAKE_BACKPRESSURE_THRESHOLD_BYTES) {
      return { kind: "backpressure", bufferedAmount: buffered };
    }

    // Build the NDJSON envelope. Array-of-one-text-block content shape
    // (canonical Claude SDK; survives a future image/attachment append
    // as a pure array push rather than a shape migration).
    const frame = JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: content }] },
      parent_tool_use_id: null,
      session_id: "",
    });

    // Post-stringify NDJSON line-discipline assertion. JSON.stringify
    // contractually escapes interior `\n` to `\\n`, so this can only
    // fire on builder bugs that inject literal newlines outside the
    // string-escape path. Cheap tripwire — Carmack P1.
    if (frame.includes("\n")) {
      return {
        kind: "failed",
        error: "NDJSON line-discipline violated: frame contains embedded newline",
      };
    }

    // Send. Bun's `ServerWebSocket.send` is sync and may throw on a
    // closed-but-not-yet-detached socket. Per Subprocess Council Rec 6:
    // log and propagate, do NOT mark the half degraded here — the
    // natural socket-close handler will fire `session:exited` within
    // milliseconds and the existing reconnect path takes over.
    try {
      // Record BEFORE send so a crash-during-send leaves a forensic
      // trail. `origin: "server:council-wake"` distinguishes this from
      // browser-relayed user frames in replay (recorder v2 schema —
      // see {@link RECORDING_HEADER_VERSION}).
      this.recorder?.record(
        this.sessionId, "out", frame, "cli", "claude", "", "server:council-wake",
      );
      this.cliSocket.send(frame + "\n");
    } catch (err) {
      return {
        kind: "failed",
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // Success: flip turn-state to in-flight. Activity was already
    // registered before the gates (Council Review #15).
    this.observerTurnState = "in-flight";
    return { kind: "sent" };
  }

  /**
   * Council Mode test hook + restart-reconcile helper. Returns the current
   * observer turn-state. Callers must NOT use this for gating — the
   * gating decision lives inside {@link sendUserFrameFromServer} so the
   * check and the send are atomic. This accessor exists for assertion
   * sites and for the orchestrator's reconcile-on-initialize path that
   * needs to know whether to pre-flip state when restoring a pair whose
   * observer was mid-turn at server-shutdown time.
   */
  getObserverTurnState(): "idle" | "in-flight" {
    return this.observerTurnState;
  }

  /**
   * Test hook + reconcile helper for the orchestrator-half turn-state.
   * Same caveat as {@link getObserverTurnState} — do NOT gate
   * production decisions on this; the in-flight transition fires the
   * `orchestrator:turn-done` bus event atomically with the state
   * mutation. Use the event stream, not the accessor.
   */
  getOrchestratorTurnState():
    | { kind: "in-flight" }
    | { kind: "awaiting-input"; blockedByStop: boolean } {
    // Return a frozen shallow copy to defend against caller mutation.
    if (this.orchestratorTurnState.kind === "in-flight") {
      return { kind: "in-flight" };
    }
    return {
      kind: "awaiting-input",
      blockedByStop: this.orchestratorTurnState.blockedByStop,
    };
  }

  /**
   * Council slice setter for the STOP-aware axis of the orchestrator
   * turn-state. The adapter does not subscribe to observer findings —
   * the council slice owns that knowledge and pushes through this
   * setter when an unresolved STOP appears (true) or all STOPs
   * resolve (false). A no-op when the state is `in-flight` (the JS-3
   * axis is only meaningful while awaiting input).
   *
   * Idempotent — repeated sets with the same boolean do NOT re-fire
   * the bus event. The event is reserved for the in-flight →
   * awaiting-input transition (Task 4) and the future
   * `blocked-by-stop` axis-flip event (Task 8 surface). Foundation PR
   * exposes the setter only; downstream consumers and event wiring
   * land with Task 8.
   */
  setOrchestratorBlockedByStop(blocked: boolean): void {
    if (this.orchestratorTurnState.kind !== "awaiting-input") return;
    if (this.orchestratorTurnState.blockedByStop === blocked) return;
    this.orchestratorTurnState = { kind: "awaiting-input", blockedByStop: blocked };
  }

  /**
   * Send an NDJSON string to the CLI. If the CLI socket is not yet connected,
   * queues the message for later delivery (flushed in attachWebSocket).
   */
  private sendToBackend(ndjson: string): void {
    if (!this.cliSocket) {
      console.log(
        `[claude-adapter] CLI not yet connected for session ${this.sessionId}, queuing message`,
      );
      this.pendingMessages.push(ndjson);
      return;
    }
    this.sendRaw(ndjson);
  }

  /**
   * Low-level send: writes NDJSON to the CLI socket with newline delimiter.
   * Records the outgoing message. Assumes cliSocket is non-null.
   */
  private sendRaw(ndjson: string): void {
    // Record raw outgoing CLI message
    this.recorder?.record(
      this.sessionId, "out", ndjson, "cli", "claude", "",
    );
    try {
      // NDJSON requires a newline delimiter
      this.cliSocket!.send(ndjson + "\n");
    } catch (err) {
      console.error(
        `[claude-adapter] Failed to send to CLI for session ${this.sessionId}:`,
        err,
      );
    }
  }
}
