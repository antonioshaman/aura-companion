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
   *
   * **CONTRACT: relaunch-only.** This channel fires from:
   *   - `cli-launcher.ts:relaunch()` — on observer-prompt-config throw,
   *     workspace↔bundled drift refusal (CR-17), or spawn failure.
   *   - `session-orchestrator.ts:handleAutoRelaunch()` — on retry-budget
   *     exhaustion OR launcher failures the launcher didn't already emit.
   *
   * Cold-start (`cli-launcher.ts:launch()`) does NOT emit on this channel
   * — failures surface as REST 503 via the orchestrator's spawn rollback.
   * Council Review 2026-05-15-1015 CR-8: a static-grep canary in
   * `cli-launcher.test.ts` asserts emit-site confinement; a future
   * refactor that fires this channel from `launch()` or any other site
   * will trip the canary so we re-examine the contract.
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

  /**
   * Council Mode auto-wake — observer's per-turn state machine transitioned
   * from `in-flight` to `idle`. Fired by the Claude adapter when a `result`
   * NDJSON frame arrives AFTER a server-synthesised wake frame had been
   * sent (i.e., the previous state was `in-flight`). Non-council sessions
   * and browser-initiated turns never fire this event.
   *
   * The orchestrator's listener inspects its `councilWatchers` map for a
   * pending-checkpoint queue (Task 4 newest-wins slot) and drains it via
   * a fresh `dispatchObserverWake` call.
   */
  "observer:turn-done": {
    /** Companion sessionId of the observer half (NOT cliSessionId). */
    sessionId: string;
  };

  /**
   * Orchestrator finished a turn — the per-session turn-state machine
   * just transitioned from `{kind:"in-flight"}` to `{kind:"awaiting-input"}`.
   * Fired by the Claude adapter on every `result` NDJSON frame that
   * follows a `user_message` send (the in-flight → awaiting-input
   * transition); never fires on a session that is still in `awaiting-input`
   * (e.g. between attach and first send).
   *
   * Emitted by the adapter unconditionally for every session — the
   * downstream filter (idle-timer-manager from Task 7 of the auto-
   * proceed plan) checks `sessionGroupRole === "orchestrator"` + group
   * status `=== "active"` + reconnect-grace clear before acting. This
   * mirrors the `observer:turn-done` shape so the per-half plumbing
   * stays symmetric.
   *
   * `blockedByStop` is the JS-3 axis: when an unresolved STOP finding
   * exists in the orchestrator's council group, downstream consumers
   * MUST pause any idle-driven action (auto-proceed timer arming). The
   * field lives in the type system so a forgetful consumer can't
   * silently drop it. The adapter itself does NOT know about STOPs —
   * the council slice / observer pipeline owns that knowledge and may
   * either mutate the adapter's state via a setter (Task 8 surface) or
   * compute its own boolean from the event-bus signal stream. Both
   * approaches keep `blockedByStop` accurate; foundation PR emits
   * `false` only — Task 8 wires the STOP coupling.
   */
  "orchestrator:turn-done": {
    /** Companion sessionId of the orchestrator-half (NOT cliSessionId). */
    sessionId: string;
    blockedByStop: boolean;
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
