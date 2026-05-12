// Typed event map for the Companion internal event bus.
// Each key is a namespaced event name; values are the payload passed to handlers.

import type { BrowserIncomingMessage } from "./session-types.js";
import type { CodexAdapter } from "./codex-adapter.js";
import type { SessionPhase } from "./session-state-machine.js";

export interface CompanionEventMap {
  // ── Session lifecycle ──────────────────────────────────────────────

  /** CLI reported its internal session ID (used for --resume). */
  "session:cli-id-received": { sessionId: string; cliSessionId: string };

  /** CLI/Codex process exited. */
  "session:exited": { sessionId: string; exitCode: number | null };

  /** CLI WebSocket disconnected and a browser needs a relaunch. */
  "session:relaunch-needed": { sessionId: string };

  /**
   * Auto-relaunch produced a deterministic failure: synchronous spawn
   * failure (binary missing, observer-config load failure) OR the
   * `relaunchExhaustedNotified` budget is now spent. Group-level
   * `reconnecting` listeners short-circuit to `reconnect_failed` rather
   * than wait out the full grace window for an outcome already decided
   * (PLAN Task 5, Subprocess council recommendation).
   */
  "session:relaunch-failed": { sessionId: string; reason: string };

  /** Idle-kill threshold reached with no connected browsers. */
  "session:idle-kill": { sessionId: string };

  /** First non-error turn completed (triggers auto-naming). */
  "session:first-turn-completed": {
    sessionId: string;
    firstUserMessage: string;
  };

  /** Git info resolved for a session (branch and cwd known). */
  "session:git-info-ready": { sessionId: string; cwd: string; branch: string };

  /** Session phase changed (formal state machine transition). */
  "session:phase-changed": {
    sessionId: string;
    from: SessionPhase;
    to: SessionPhase;
    trigger: string;
  };

  // ── Backend integration ────────────────────────────────────────────

  /** Codex adapter created and ready to be attached to WsBridge. */
  "backend:codex-adapter-created": {
    sessionId: string;
    adapter: CodexAdapter;
  };

  // ── Per-session messages (high volume) ─────────────────────────────

  /** An assistant message was processed and broadcast to browsers. */
  "message:assistant": {
    sessionId: string;
    message: BrowserIncomingMessage;
  };

  /** A stream event was processed and broadcast to browsers. */
  "message:stream_event": {
    sessionId: string;
    message: BrowserIncomingMessage;
  };

  /** A result (turn completion) was processed and broadcast to browsers. */
  "message:result": { sessionId: string; message: BrowserIncomingMessage };

  // ── Council Mode session groups ────────────────────────────────────
  // Group-scoped events fire in addition to (not instead of) the
  // corresponding per-session events. Subscribers that only care about
  // group membership read these; per-session subscribers are unaffected.

  /** A new Council Mode pair was created and both halves are active. */
  "group:created": {
    sessionGroupId: string;
    primarySessionId: string;
    observerSessionId: string;
  };

  /** A Council Mode group was archived (intentional teardown). */
  "group:exited": {
    sessionGroupId: string;
    reason: "user_archived" | "shutdown" | "both_halves_died";
  };

  /** One half of a Council Mode group died unexpectedly; the surviving
   *  half is now in degraded mode and may be respawned by the user. */
  "group:degraded": {
    sessionGroupId: string;
    deadRole: "orchestrator" | "observer";
  };

  /** One half of a Council Mode group is reconnecting — bounded grace
   *  window armed (PLAN Task 7). Resolved by `session:cli-id-received`
   *  → `group:created` re-broadcast (active again) or by timer expiry
   *  → `group:degraded`. */
  "group:reconnecting": {
    sessionGroupId: string;
    survivingRole: "orchestrator" | "observer";
    /** Absolute wallclock ms — robust to in-flight latency and tab sleep. */
    deadlineMs: number;
  };

  /** Observer wake-up: a new checkpoint sentinel was emitted by the
   *  orchestrator and validated. Subscribers may forward to the observer
   *  half or surface in the UI. */
  "group:checkpoint": {
    sessionGroupId: string;
    checkpointId: string;
    phase: string;
    sequence: number;
  };

  /** Observer review processed end-to-end: parsed from the review file,
   *  validated for grounding, findings hydrated with server-assigned ids,
   *  ready for browser fanout. Subscribers transform the payload into
   *  the `observer_review` BrowserIncomingMessage and broadcast it. */
  "group:review": {
    sessionGroupId: string;
    checkpointId: string;
    phase: string;
    /** Findings after grounding validation. Each has a stable server-assigned id. */
    findings: import("./session-types.js").BrowserObserverFinding[];
    /** Server-side grounding downgrades (correlate to `findings[].id`). */
    downgrades: import("./session-types.js").BrowserObserverDowngrade[];
    observerModel: string;
    observerProvider: string;
  };
}
