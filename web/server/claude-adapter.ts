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
import type { IdleTimerProbe } from "./idle-timer-manager.js";
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
import type { CliTransport } from "./cli-transport.js";
import { WebSocketCliTransport } from "./cli-transport.js";
import type { CLIDedupState } from "./ws-bridge-cli-ingest.js";
import { reportProtocolDrift } from "./protocol-monitor.js";
import { companionBus } from "./event-bus.js";
import { isToolUseDeniedForSynthetic, denialMessageForSynthetic } from "./auto-proceed-permissions.js";
import { resolveModelAvailability } from "./model-availability.js";
import { SilentStdioWatchdog } from "./silent-stdio-watchdog.js";
import { classifyFallbackReason, nextModelInChain } from "./model-fallback-chain.js";

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
 * Silent-stdio watchdog deadline. If a user turn is in flight and no
 * stream-json frame arrives from the CLI for this many ms, we assume
 * the stdio pipe is dead-but-not-closed and trigger a subprocess
 * respawn via the orchestrator's existing keepalive path.
 *
 * Chosen to sit clearly above a normal tool-heavy turn (long Bash / git
 * runs, sequential Reads) but well below a user's patience threshold.
 * A legitimately long tool call slides the deadline forward every time
 * a `tool_progress` / stream chunk arrives, so this is a "true silence"
 * limit, not a "turn duration" limit.
 */
const SILENT_STDIO_TIMEOUT_MS = 60_000;

/**
 * Adapter-level outcome of a wake send attempt. The orchestrator's
 * dispatcher (Task 3) wraps this in a richer WakeDispatchOutcome that
 * adds coordinator-side reasons (observer_unknown, group_not_active).
 *
 * - `sent` — NDJSON frame was passed to `transport.send` without throwing.
 *   The observer turn-state is now `in-flight` and idle-kill activity
 *   has been registered.
 * - `socket_disconnected` — transport is null or closing. Transient
 *   observer disconnect window; the dispatcher should keep the pending
 *   checkpoint for the reconnect-aware drain (Task 5).
 * - `busy` — observer is mid-turn from a previous wake. Dispatcher should
 *   enqueue (Task 4).
 * - `backpressure` — bufferedAmount exceeds threshold. Refuse rather
 *   than queue; the next checkpoint will try again.
 * - `failed` — `transport.send` threw synchronously. Logged at EC-9 by
 *   the dispatcher; do NOT mark the half degraded directly (Subprocess
 *   Council Rec 6).
 */
export type ObserverWakeSendOutcome =
  | { kind: "sent" }
  | { kind: "socket_disconnected" }
  | { kind: "busy" }
  | { kind: "backpressure"; bufferedAmount: number }
  | { kind: "failed"; error: string };

/**
 * One entry in the per-adapter outbound FIFO queue (PLAN Task 11.1).
 * `evicted` is mutated when an asymmetric-overflow eviction removes the
 * entry mid-flight; the scheduled Promise-chain callback then no-ops
 * rather than sending. Exposed at module scope so tests can construct
 * matchers on the same shape.
 */
export interface ClaudeAdapterOutboundEntry {
  kind: "user" | "synthetic";
  payload: string;
  enqueuedAt: number;
  evicted: boolean;
}

/** Outcome of {@link ClaudeAdapter.enqueueOutboundFrame}. */
export type ClaudeAdapterEnqueueOutcome =
  | { ok: true }
  | { ok: false; error: "queue-full" | "queue-full-no-evictable" };

// --- Claude Code Adapter ------------------------------------------------------

export class ClaudeAdapter implements IBackendAdapter {
  private sessionId: string;

  // Control channel to the Claude Code CLI process. WebSocket for a pinned
  // pre-2.1.121 CLI, stdio pipes for a current one — see ./cli-transport.ts.
  private transport: CliTransport | null = null;

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
  private idleTimerProbe: IdleTimerProbe | null;

  private protocolDriftSeen = new Set<string>();
  private parseErrorSeen = new Set<string>();

  /**
   * Silent-stdio deadline (see {@link SILENT_STDIO_TIMEOUT_MS} and the
   * event contract on `session:backend-silent`). Armed when a user
   * message dispatches to the CLI, slid forward on every parseable
   * frame arrival, disarmed on `result` frames and transport close.
   */
  private readonly silenceWatchdog: SilentStdioWatchdog;

  /**
   * Once-per-spawn guard for the model-fallback classifier. A rate-
   * limit-class error typically produces several assistant frames
   * (synthetic "You've hit your session limit" messages, followed by a
   * `result` with `stop_reason: "stop_sequence"`). We only want to
   * fire the fallback event on the first such detection — the
   * subsequent frames belong to the same failure, not a new one.
   * Reset on {@link attachTransport} because a fresh spawn is by
   * definition a fresh classification opportunity.
   */
  private modelFallbackFiredForThisSpawn = false;

  /**
   * Content of the last user_message we dispatched to the CLI that has
   * NOT yet been acknowledged by a `result` NDJSON frame. Set at the
   * end of {@link handleOutgoingUserMessage}; cleared on the in-flight
   * → awaiting-input transition in {@link handleResultMessage}.
   *
   * The silent-stdio-death failure mode (see PR #175, this same file's
   * silence watchdog) causes the CLI to receive a user_message,
   * process it into its own jsonl, but never emit the response on
   * stdout. When the watchdog kills and the keepalive relaunches, the
   * new subprocess resumes via `--resume` but does NOT re-drive the
   * unanswered message — the user's turn is silently lost.
   *
   * This field is the memory that {@link handleSystemInit} uses to
   * replay the unanswered message on the next spawn. Two guards keep
   * it safe:
   *   1. Set only for text-only user messages. Image payloads carry
   *      base64 blobs that we'd prefer not to re-decode + re-transmit
   *      on our own initiative — replaying those on respawn is out of
   *      scope for now (logged + skipped).
   *   2. Cleared on transport-close paths ({@link handleTransportClose},
   *      {@link detachWebSocket}) alongside `orchestratorTurnState`
   *      to keep the two in sync — a clean disconnect zeroes both.
   */
  private lastUnansweredUserMessage: string | null = null;

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

  /**
   * PLAN-aura-orchestrator-idle-auto-proceed Task 11.1 + 11.2 —
   * per-session outbound FIFO queue + asymmetric overflow policy.
   *
   * The queue serialises outbound `user` / `synthetic` NDJSON frames so
   * concurrent producers (browser-relayed user message + auto-proceed
   * synthetic, or two near-simultaneous browser tabs) can never invert
   * order at the wire. Promise-chain ordering is the serialization
   * primitive — each enqueue appends a `.then()` to `outboundChain`
   * which sends the entry's payload via {@link sendRaw} when scheduled.
   *
   * Bounded depth = **16** with the rationale: 4 concurrent browser
   * tabs × 4 in-flight messages × 2x headroom. The literal `16` is
   * the load-bearing magic number — a future refactor that wants to
   * change it must update the rationale comment so a grep audit
   * surfaces drift between value + justification.
   *
   * Asymmetric overflow policy:
   *  - **Synthetic enqueue at depth ≥ 16:** REFUSE → return
   *    `{ok:false, error:"queue-full"}`. Trace counter does NOT advance.
   *    Rationale: an auto-proceed nudge that can't fit isn't urgent;
   *    the next idle-timer cycle will retry on fresh state.
   *  - **User-frame enqueue at depth ≥ 16:** evict the OLDEST synthetic
   *    entry (newest-to-oldest scan via `findIndex` over `kind ===
   *    "synthetic"`) and admit the user frame. If NO synthetic is
   *    queued at saturation → refuse with `queue-full-no-evictable`
   *    so the caller (bridge) can surface `protocol.frame_dropped` to
   *    the originating browser socket via the existing wire variant.
   *    User-typed messages must NEVER be silently lost — refusing
   *    explicitly is the right boundary.
   *
   * Existing `sendUserFrameFromServer` (observer-wake) and `sendToBackend`
   * (browser → CLI) paths are unchanged in this PR. The wire-up that
   * actually routes synthetic / user frames through this queue lands
   * in Task 11.8 (FIFO queue is foundation; wire-up is integration).
   */
  private static readonly OUTBOUND_QUEUE_MAX_DEPTH = 16;
  private outboundQueue: ClaudeAdapterOutboundEntry[] = [];
  private outboundChain: Promise<void> = Promise.resolve();

  constructor(
    sessionId: string,
    opts?: {
      recorder?: RecorderManager | null;
      onActivityUpdate?: () => void;
      idleTimerProbe?: IdleTimerProbe | null;
    },
  ) {
    this.sessionId = sessionId;
    this.recorder = opts?.recorder ?? null;
    this.onActivityUpdate = opts?.onActivityUpdate ?? null;
    this.idleTimerProbe = opts?.idleTimerProbe ?? null;
    this.silenceWatchdog = new SilentStdioWatchdog({
      timeoutMs: SILENT_STDIO_TIMEOUT_MS,
      onSilent: ({ sinceMs, reason }) => {
        // The subprocess is producing output somewhere (its own jsonl
        // is likely still growing — this failure mode was reproduced
        // 2026-09-09), but nothing is reaching us. Surface a browser-
        // visible error and let the orchestrator kill + relaunch.
        this.browserMessageCb?.({
          type: "error",
          message: `Backend silent for ${Math.round(sinceMs / 1000)}s — relaunching…`,
        });
        companionBus.emit("session:backend-silent", {
          sessionId: this.sessionId,
          sinceMs,
          reason,
        });
      },
    });
  }

  // -- WebSocket lifecycle ----------------------------------------------------

  /**
   * Called when the CLI WebSocket connects. Stores the socket reference and
   * flushes any NDJSON messages that were queued before the connection.
   */
  attachWebSocket(ws: ServerWebSocket<SocketData>): void {
    this.attachTransport(new WebSocketCliTransport(ws));
  }

  /**
   * Transport-agnostic attach. `attachWebSocket` is the WS-flavoured wrapper;
   * the stdio launcher calls this directly with a {@link StdioCliTransport}.
   *
   * Every turn-state reset below is attach-bound, not socket-bound: a fresh
   * transport is by definition a fresh turn regardless of its kind.
   */
  attachTransport(transport: CliTransport): void {
    this.transport = transport;
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
    // A fresh spawn is a fresh classification opportunity — the
    // previous spawn's rate-limit fatality does not carry.
    this.modelFallbackFiredForThisSpawn = false;
    // A fresh transport by definition cannot be silent yet.
    this.silenceWatchdog.disarm();

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
    // Only detach if this is the current transport -- ignore stale close events
    if (this.transport?.raw !== ws) return;
    this.transport = null;
    this.observerTurnState = "idle";
    // Mirror reset for the orchestrator-half. See `observerTurnState`
    // comment immediately above; same socket-bound semantics.
    this.orchestratorTurnState = { kind: "awaiting-input", blockedByStop: false };
    // Same reasoning as handleTransportClose: transport gone → no
    // more frames → silence watchdog would misfire on a real
    // disconnect.
    this.silenceWatchdog.disarm();
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
    return this.transport !== null;
  }

  /**
   * Send-readiness gate for council wakes — mirrors the transport guard in
   * {@link sendUserFrameFromServer} (socket present AND OPEN). Stricter than
   * {@link isConnected} (which only checks presence) by the readyState
   * check, so a socket attached but not yet OPEN is correctly treated as
   * not-ready. See {@link IBackendAdapter.isReadyForServerFrame}.
   */
  isReadyForServerFrame(): boolean {
    return this.transport !== null && this.transport.isOpen();
  }

  async disconnect(): Promise<void> {
    // Clear pending control requests to prevent memory leaks from
    // unresolved promises (CLI won't respond after disconnect)
    this.pendingControlRequests.clear();
    if (this.transport) {
      try {
        this.transport.close();
      } catch {
        // Transport may already be closed
      }
      this.transport = null;
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
    this.transport = null;
    this.observerTurnState = "idle";
    // Transport gone = no more frames can arrive; the exit + relaunch
    // path takes over. Firing `backend-silent` on top of a real exit
    // would double-trigger the orchestrator.
    this.silenceWatchdog.disarm();
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
    // Arm the silence deadline: from this moment we expect a frame
    // back within SILENT_STDIO_TIMEOUT_MS. Rate-limit-class errors
    // still produce a synthetic assistant frame + result, so those
    // paths will disarm normally; only a genuinely dead pipe reaches
    // the timeout without any frame at all.
    this.silenceWatchdog.arm("user_message_sent");
    // Remember this text-only turn's content in case the pipe goes
    // silent and the watchdog forces a respawn. `handleSystemInit`
    // replays it on the new spawn. Image-carrying messages are NOT
    // remembered — replaying a base64 payload on our own initiative
    // has a larger blast radius than the anti-silence win.
    if (!msg.images?.length) {
      this.lastUnansweredUserMessage = msg.content;
    } else {
      this.lastUnansweredUserMessage = null;
    }
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
    // Task 5 — proactive pre-send gate. The server is the substitution-decision
    // owner: a `retired`/`blocked` target is swapped for its registry
    // replacement (cap 1 hop, same tier) or suppressed entirely BEFORE any
    // control_request crosses the wire. This is a PURE pre-send check — no
    // process kill, no relaunch; idle-kill / auto-relaunch / --resume / PID
    // reconnect are all untouched. Exactly one frame (or none) reaches the CLI,
    // so no second in-flight marker is ever seeded.
    const resolution = resolveModelAvailability({ backend: "claude", requested: model });
    switch (resolution.kind) {
      case "ok":
        return this.emitSetModel(resolution.model);
      case "substituted":
        this.browserMessageCb?.({
          type: "model_substitution",
          requested: resolution.from,
          applied: resolution.to,
          outcome: "substituted",
          reason: resolution.reason,
        });
        return this.emitSetModel(resolution.to);
      case "needs-user-action":
        // Cross-tier swap — never silent. Keep the current model and let the
        // frontend raise an explicit confirmation (Task 9). No frame crosses.
        this.browserMessageCb?.({
          type: "model_substitution",
          requested: resolution.from,
          applied: null,
          outcome: "needs-user-action",
          reason: resolution.reason,
        });
        return false;
      case "unavailable":
        this.browserMessageCb?.({
          type: "model_substitution",
          requested: model,
          applied: null,
          outcome: "unavailable",
          reason: resolution.reason,
        });
        return false;
    }
  }

  private emitSetModel(model: string): boolean {
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

    // Any parseable frame — including keep_alives — is proof the stdio
    // pipe is delivering. Slide the silence deadline forward. The 2026-
    // 09-09 failure mode is exactly the opposite: ZERO frames for
    // minutes while the subprocess kept working on its own jsonl.
    this.silenceWatchdog.onFrame();

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

    // Silent-stdio replay hook. When the previous spawn ate a user
    // message but died before emitting a response (see
    // `feedback_two_writer_path_divergence_canary.md` for the failure
    // class), we saved the text content in `lastUnansweredUserMessage`.
    // A fresh `system.init` frame is proof the new spawn's stdout is
    // now alive, so re-drive that turn now — the user sees a slight
    // pause and then the reply they were owed, instead of eternal
    // silence. Guards:
    //   - Only fires when the previous turn was ACTUALLY in-flight at
    //     silence time (the field is null after a clean turn).
    //   - The queue-flush above runs first; a browser-typed follow-up
    //     that landed during the outage takes priority in the CLI's
    //     input queue.
    //   - The `handleOutgoingUserMessage` call below re-arms the
    //     silence watchdog + re-sets `lastUnansweredUserMessage`, so a
    //     second silence on the same replay produces the same
    //     kill+respawn+replay loop and eventually trips
    //     `MAX_AUTO_RELAUNCHES` — bounded, not infinite.
    if (this.lastUnansweredUserMessage !== null) {
      const content = this.lastUnansweredUserMessage;
      // Clear BEFORE dispatch so the replay path itself sets a fresh
      // pending state (via handleOutgoingUserMessage) rather than
      // reading stale data if it races.
      this.lastUnansweredUserMessage = null;
      console.log(
        `[claude-adapter] Replaying last unanswered user message after respawn for session ${this.sessionId} (${content.length} chars)`,
      );
      // Surface the replay on the browser channel so the user knows
      // their previous turn is being re-driven, not just going quiet.
      this.browserMessageCb?.({
        type: "error",
        message: "Backend recovered — replaying your last message…",
      });
      this.handleOutgoingUserMessage({
        type: "user_message",
        content,
      });
    }
  }

  // -- Assistant, result, stream ----------------------------------------------

  private handleAssistantMessage(msg: CLIAssistantMessage): void {
    // Rate-limit-class classification. The Claude CLI fabricates a
    // synthetic assistant message (`model: "<synthetic>"`) containing
    // the human-readable error string ("You've hit your session limit
    // · resets 2:40am (UTC)") when the API returns an error the CLI
    // knows how to translate. We look at those first-class error
    // surfaces and, if the current model has a downgrade target in
    // the chain, ask the orchestrator to swap-and-relaunch.
    this.maybeEmitModelFallback(msg);

    this.browserMessageCb?.({
      type: "assistant",
      message: msg.message,
      parent_tool_use_id: msg.parent_tool_use_id,
      timestamp: Date.now(),
    });
  }

  /**
   * Scan an assistant message for rate-limit-class error text; if the
   * classifier fires AND we have a downgrade target AND we haven't
   * already fired this spawn, emit `session:model-fallback` for the
   * orchestrator to swap-and-relaunch.
   *
   * Deliberately narrow: only "hit your session limit" / "rate_limit" /
   * "out of credits" / "unknown model" surfaces trigger this. Any
   * ambiguous or new failure mode is not misclassified as a fallback
   * candidate — it flows through as a normal error.
   */
  private maybeEmitModelFallback(msg: CLIAssistantMessage): void {
    if (this.modelFallbackFiredForThisSpawn) return;
    const message = msg.message as { model?: unknown; content?: unknown } | undefined;
    if (!message) return;

    const currentModel = typeof message.model === "string" ? message.model : "";
    // Extract text from all text-typed content blocks. Non-text blocks
    // (tool_use, tool_result, etc.) can't carry a rate-limit surface
    // in the shape we classify against, so skip.
    const parts: string[] = [];
    const content = message.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
          const text = (block as { text?: unknown }).text;
          if (typeof text === "string") parts.push(text);
        }
      }
    } else if (typeof content === "string") {
      parts.push(content);
    }
    const joined = parts.join("\n");
    if (!joined) return;

    const reason = classifyFallbackReason(joined);
    if (!reason) return;

    // Prefer the CLI's spawn-time model (persisted on the launcher's
    // session record) over the message's own `model` — the assistant
    // frame carries `<synthetic>` in exactly the case where a
    // downgrade would help, and `<synthetic>` is not in the chain.
    // The orchestrator has the real spawn model; we forward the
    // reason and let it resolve `from` there.
    const messageModel = currentModel;
    const nextModel = nextModelInChain(messageModel);
    // For the `<synthetic>` case, `nextModel` is null. That's the
    // signal to the orchestrator handler: "please look up the real
    // spawn model and downgrade from there". We fire the event
    // regardless so the orchestrator gets a chance to decide; the
    // handler will drop the event if it also can't resolve a next
    // model.
    this.modelFallbackFiredForThisSpawn = true;
    companionBus.emit("session:model-fallback", {
      sessionId: this.sessionId,
      from: messageModel || "<unknown>",
      to: nextModel ?? "<resolve-at-orchestrator>",
      reason,
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
      // Turn done → cancel the silence deadline. `handleRawMessage`
      // already reset it on this very `result` frame, but the intent
      // here is "no longer expecting output", not "reset for another
      // 60s window".
      this.silenceWatchdog.disarm();
      // Turn answered — no replay needed on a future respawn. This
      // clear MUST live in the in-flight → awaiting-input branch so a
      // spurious `result` for a session already awaiting (CLI
      // re-handshake replay) does not erase pending replay state
      // from a still-in-flight turn.
      this.lastUnansweredUserMessage = null;
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
   * 2. transport is null or not writable → return `socket_disconnected`
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

    if (!this.transport) {
      return { kind: "socket_disconnected" };
    }
    if (!this.transport.isOpen()) {
      return { kind: "socket_disconnected" };
    }

    const buffered = this.transport.bufferedAmount();
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
      this.transport.send(frame + "\n");
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

    // Gate 2: transport is attached AND writable right now.
    if (!this.transport) {
      return { kind: "socket_disconnected" };
    }
    if (!this.transport.isOpen()) {
      return { kind: "socket_disconnected" };
    }

    // Gate 3: backpressure. The WS transport reports Bun's buffered amount;
    // the stdio transport reports 0 (a pipe exposes no queue depth), so this
    // gate is a no-op there rather than a fabricated number.
    const buffered = this.transport.bufferedAmount();
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
      this.transport.send(frame + "\n");
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
    if (!this.transport) {
      console.log(
        `[claude-adapter] CLI not yet connected for session ${this.sessionId}, queuing message`,
      );
      this.pendingMessages.push(ndjson);
      return;
    }
    this.sendRaw(ndjson);
  }

  /**
   * PLAN Task 11.1 + 11.2 — enqueue an outbound NDJSON frame on the
   * per-session FIFO queue. See class-level outbound-queue docstring
   * for full semantics. Returns the admission outcome; the caller
   * (currently test surface only; Task 11.8 will wire production
   * callers) does NOT await the send — Promise-chain serialization
   * means the entry is sent in admission order whenever the previous
   * entry's send completes.
   *
   * Public for test access. Production wire-up in Task 11.8 will
   * funnel auto-proceed synthetic frames + (optionally) browser
   * user frames through this seam.
   */
  enqueueOutboundFrame(
    kind: "user" | "synthetic",
    payload: string,
  ): ClaudeAdapterEnqueueOutcome {
    // Bounded depth — see class-level docstring for the 16 rationale
    // (4 tabs × 4 in-flight × 2x headroom). DO NOT change the literal
    // without updating the rationale comment in the same diff.
    if (this.outboundQueue.length >= ClaudeAdapter.OUTBOUND_QUEUE_MAX_DEPTH) {
      if (kind === "synthetic") {
        console.warn(
          `[claude-adapter] outbound queue saturated (${this.outboundQueue.length}/${ClaudeAdapter.OUTBOUND_QUEUE_MAX_DEPTH}); refusing synthetic frame for session ${this.sessionId}`,
        );
        return { ok: false, error: "queue-full" };
      }
      // Asymmetric overflow: user frame at saturation evicts the OLDEST
      // synthetic. `findIndex` returns index 0 first → oldest synthetic
      // by enqueue order. Mark evicted so the chain callback no-ops,
      // and remove from queue immediately to make room for the user.
      const oldestSyntheticIdx = this.outboundQueue.findIndex(
        (e) => e.kind === "synthetic" && !e.evicted,
      );
      if (oldestSyntheticIdx < 0) {
        // Saturated with only user frames — load-shed the new admission
        // explicitly. The caller (bridge) surfaces protocol.frame_dropped
        // to the originating browser socket per Task 11.2 contract.
        console.warn(
          `[claude-adapter] outbound queue saturated with no synthetic to evict; refusing user frame for session ${this.sessionId}`,
        );
        return { ok: false, error: "queue-full-no-evictable" };
      }
      const evictedEntry = this.outboundQueue[oldestSyntheticIdx];
      if (evictedEntry) evictedEntry.evicted = true;
      this.outboundQueue.splice(oldestSyntheticIdx, 1);
    }

    const entry: ClaudeAdapterOutboundEntry = {
      kind,
      payload,
      enqueuedAt: Date.now(),
      evicted: false,
    };
    this.outboundQueue.push(entry);

    // Promise-chain serialization. Each entry binds its callback by
    // closure-captured reference (NOT by queue head shift) so an
    // eviction that splices a middle entry doesn't cause the callback
    // to send the wrong payload. Evicted entries no-op on schedule.
    this.outboundChain = this.outboundChain.then(async () => {
      if (entry.evicted) return;
      const queueIdx = this.outboundQueue.indexOf(entry);
      if (queueIdx >= 0) this.outboundQueue.splice(queueIdx, 1);
      try {
        this.sendRaw(entry.payload);
      } catch (err) {
        console.error(
          `[claude-adapter] outbound chain send failed for session ${this.sessionId}:`,
          err,
        );
      }
    });

    return { ok: true };
  }

  /**
   * Test-only forensic accessor — returns the current count of
   * non-evicted entries in the outbound FIFO queue.
   */
  getOutboundQueueDepth(): number {
    return this.outboundQueue.filter((e) => !e.evicted).length;
  }

  /**
   * Test-only: returns a snapshot of the outbound queue's entry kinds
   * in admission order. Use sparingly — exposes internal state for
   * assertion only.
   */
  getOutboundQueueKinds(): Array<"user" | "synthetic"> {
    return this.outboundQueue
      .filter((e) => !e.evicted)
      .map((e) => e.kind);
  }

  /**
   * Test-only: awaits the current outbound chain. Returns when every
   * already-enqueued send has been scheduled + completed (or no-op'd
   * if evicted). Production callers don't await — the chain is fire-
   * and-forget by design. Tests use this to deterministically advance
   * past the Promise microtask boundary.
   */
  drainOutboundQueueForTest(): Promise<void> {
    return this.outboundChain;
  }

  /**
   * Low-level send: writes NDJSON to the CLI transport with newline delimiter.
   * Records the outgoing message. Assumes the transport is non-null.
   */
  private sendRaw(ndjson: string): void {
    // Record raw outgoing CLI message
    this.recorder?.record(
      this.sessionId, "out", ndjson, "cli", "claude", "",
    );
    try {
      // NDJSON requires a newline delimiter
      this.transport!.send(ndjson + "\n");
    } catch (err) {
      console.error(
        `[claude-adapter] Failed to send to CLI for session ${this.sessionId}:`,
        err,
      );
    }
  }
}
