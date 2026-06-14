import type { BrowserIncomingMessage, BrowserOutgoingMessage } from "./session-types.js";

export type ServerSyntheticSendOutcome =
  | { kind: "sent" }
  | { kind: "socket_disconnected" }
  | { kind: "busy" }
  | { kind: "backpressure"; bufferedAmount: number }
  | { kind: "failed"; error: string };

// ─── Unified Backend Adapter Interface ───────────────────────────────────────
// Both Claude Code (NDJSON WebSocket) and Codex (JSON-RPC stdio/WS) implement
// this so that application code never branches on BackendType for message routing.

/**
 * Unified interface for backend communication.
 *
 * Adapters translate between the backend-native protocol and the common
 * BrowserIncomingMessage / BrowserOutgoingMessage types used by the bridge
 * and the frontend.
 */
export interface IBackendAdapter {
  /** Send a browser-originated message to the backend. Returns true if accepted. */
  send(msg: BrowserOutgoingMessage): boolean;

  /** Whether the backend transport is currently connected and ready. */
  isConnected(): boolean;

  /** Gracefully disconnect the backend transport. */
  disconnect(): Promise<void>;

  // ── Event registration (called once at attachment time) ──

  /**
   * Register callback for messages to forward to browsers.
   * The adapter translates backend-native protocol into BrowserIncomingMessage.
   */
  onBrowserMessage(cb: (msg: BrowserIncomingMessage) => void): void;

  /**
   * Register callback for session metadata updates (CLI session ID, model, cwd).
   * Used for --resume tracking and state synchronization.
   */
  onSessionMeta(cb: (meta: { cliSessionId?: string; model?: string; cwd?: string }) => void): void;

  /** Register callback for transport disconnection. */
  onDisconnect(cb: () => void): void;

  /** Register callback for initialization errors. */
  onInitError?(cb: (error: string) => void): void;

  // ── Optional capabilities (not all backends support these) ──

  /**
   * Register the idle-kill activity hook (#12). The Claude adapter wires the
   * equivalent at construction; Codex wires it here at attach time so a
   * server-synthesized wake counts as group liveness even when gated `busy`.
   */
  setServerActivityHook?(cb: () => void): void;

  /** Send a server-synthesized user turn to the observer half. */
  sendUserFrameFromServer?(content: string): ServerSyntheticSendOutcome;

  /**
   * True only when {@link sendUserFrameFromServer} would be accepted RIGHT
   * NOW — full transport + protocol readiness, not mere socket liveness.
   *
   * Distinct from {@link isConnected}: the codex adapter flips its
   * `connected` flag true after the `initialized` notification but BEFORE
   * the `thread/resume` round-trip assigns a `threadId` (~16s window on
   * prod). During that window `isConnected()` returns true yet a wake send
   * is rejected with `socket_disconnected` because `threadId` is null.
   * Council-wake poll gates MUST poll on this predicate, not isConnected(),
   * so the wake fires only once the observer can actually accept it.
   *
   * Optional: adapters that do not implement it are treated as
   * send-ready whenever {@link isConnected} is true (the Claude adapter's
   * socket-readyState gate already coincides with isConnected()).
   */
  isReadyForServerFrame?(): boolean;

  /** Send a server-synthesized user turn to the orchestrator half. */
  sendOrchestratorSyntheticFrame?(content: string): ServerSyntheticSendOutcome;

  /** Return backend-specific rate limits, if available (Codex only). */
  getRateLimits?(): {
    primary: { usedPercent: number; windowDurationMins: number; resetsAt: number } | null;
    secondary: { usedPercent: number; windowDurationMins: number; resetsAt: number } | null;
  } | null;

  /** Handle transport-level close (used when WS proxy drops). */
  handleTransportClose?(): void;
}
