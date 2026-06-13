// Types for the WebSocket bridge between Claude Code CLI and the browser

import type { SessionPhase } from "./session-state-machine.js";

// ─── CLI Message Types (NDJSON from Claude Code CLI) ──────────────────────────

export interface CLISystemInitMessage {
  type: "system";
  subtype: "init";
  cwd: string;
  session_id: string;
  tools: string[];
  mcp_servers: { name: string; status: string }[];
  model: string;
  permissionMode: string;
  apiKeySource: string;
  claude_code_version: string;
  slash_commands: string[];
  agents?: string[];
  skills?: string[];
  output_style: string;
  uuid: string;
}

export interface CLISystemStatusMessage {
  type: "system";
  subtype: "status";
  status: "compacting" | null;
  permissionMode?: string;
  uuid: string;
  session_id: string;
}

export interface CLICompactBoundaryMessage {
  type: "system";
  subtype: "compact_boundary";
  compact_metadata: {
    trigger: "manual" | "auto";
    pre_tokens: number;
  };
  uuid: string;
  session_id: string;
}

export interface CLITaskNotificationMessage {
  type: "system";
  subtype: "task_notification";
  task_id: string;
  status: "completed" | "failed" | "stopped";
  output_file: string;
  summary: string;
  uuid: string;
  session_id: string;
}

export interface CLIFilesPersistedMessage {
  type: "system";
  subtype: "files_persisted";
  files: { filename: string; file_id: string }[];
  failed: { filename: string; error: string }[];
  processed_at: string;
  uuid: string;
  session_id: string;
}

export interface CLIHookStartedMessage {
  type: "system";
  subtype: "hook_started";
  hook_id: string;
  hook_name: string;
  hook_event: string;
  uuid: string;
  session_id: string;
}

export interface CLIHookProgressMessage {
  type: "system";
  subtype: "hook_progress";
  hook_id: string;
  hook_name: string;
  hook_event: string;
  stdout: string;
  stderr: string;
  output: string;
  uuid: string;
  session_id: string;
}

export interface CLIHookResponseMessage {
  type: "system";
  subtype: "hook_response";
  hook_id: string;
  hook_name: string;
  hook_event: string;
  output: string;
  stdout: string;
  stderr: string;
  exit_code?: number;
  outcome: "success" | "error" | "cancelled";
  uuid: string;
  session_id: string;
}

export type CLISystemMessage =
  | CLISystemInitMessage
  | CLISystemStatusMessage
  | CLICompactBoundaryMessage
  | CLITaskNotificationMessage
  | CLIFilesPersistedMessage
  | CLIHookStartedMessage
  | CLIHookProgressMessage
  | CLIHookResponseMessage;

export interface CLIAssistantMessage {
  type: "assistant";
  message: {
    id: string;
    type: "message";
    role: "assistant";
    model: string;
    content: ContentBlock[];
    stop_reason: string | null;
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
    };
  };
  parent_tool_use_id: string | null;
  error?: string;
  uuid: string;
  session_id: string;
}

export interface CLIResultMessage {
  type: "result";
  subtype: "success" | "error_during_execution" | "error_max_turns" | "error_max_budget_usd" | "error_max_structured_output_retries";
  is_error: boolean;
  /**
   * Upstream HTTP status when the turn failed at the API layer. `404` is the
   * model-unavailable signal: the CLI accepts `set_model` without validating,
   * so an unusable model surfaces here on the first real turn (alongside an
   * `assistant` frame whose `model` is `<synthetic>`).
   */
  api_error_status?: number;
  result?: string;
  errors?: string[];
  duration_ms: number;
  duration_api_ms: number;
  num_turns: number;
  total_cost_usd: number;
  stop_reason: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  };
  modelUsage?: Record<string, {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    contextWindow: number;
    maxOutputTokens: number;
    costUSD: number;
  }>;
  total_lines_added?: number;
  total_lines_removed?: number;
  uuid: string;
  session_id: string;
}

export interface CLIStreamEventMessage {
  type: "stream_event";
  event: unknown;
  parent_tool_use_id: string | null;
  uuid: string;
  session_id: string;
}

export interface CLIToolProgressMessage {
  type: "tool_progress";
  tool_use_id: string;
  tool_name: string;
  parent_tool_use_id: string | null;
  elapsed_time_seconds: number;
  uuid: string;
  session_id: string;
}

export interface CLIToolUseSummaryMessage {
  type: "tool_use_summary";
  summary: string;
  preceding_tool_use_ids: string[];
  uuid: string;
  session_id: string;
}

export interface CLIControlRequestMessage {
  type: "control_request";
  request_id: string;
  request: {
    subtype: "can_use_tool";
    tool_name: string;
    input: Record<string, unknown>;
    permission_suggestions?: PermissionUpdate[];
    description?: string;
    tool_use_id: string;
    agent_id?: string;
    title?: string;
    display_name?: string;
    blocked_path?: string;
    decision_reason?: string;
  };
}

export interface CLIKeepAliveMessage {
  type: "keep_alive";
}

export interface CLIAuthStatusMessage {
  type: "auth_status";
  isAuthenticating: boolean;
  output: string[];
  error?: string;
  uuid: string;
  session_id: string;
}

export interface CLIControlResponseMessage {
  type: "control_response";
  response: {
    subtype: "success" | "error";
    request_id: string;
    response?: Record<string, unknown>;
    error?: string;
  };
}

/** CLI echoes user messages back (including subagent tool_result blocks). */
export interface CLIUserEchoMessage {
  type: "user";
  message: { role: string; content: unknown };
  uuid?: string;
  session_id?: string;
}

/** Rate-limit status from Claude API (allowed/throttled). */
export interface CLIRateLimitEventMessage {
  type: "rate_limit_event";
  rate_limit_info: Record<string, unknown>;
  uuid?: string;
}

/** CLI cancels a pending control_request (e.g. permission revoked). */
export interface CLIControlCancelRequestMessage {
  type: "control_cancel_request";
  request_id: string;
}

/** Simplified assistant text (streamlined output mode). @internal */
export interface CLIStreamlinedTextMessage {
  type: "streamlined_text";
  text: string;
  session_id: string;
  uuid: string;
}

/** Simplified tool use summary (e.g. "Read 2 files, wrote 1 file"). @internal */
export interface CLIStreamlinedToolUseSummaryMessage {
  type: "streamlined_tool_use_summary";
  tool_summary: string;
  session_id: string;
  uuid: string;
}

/** Predicted next user prompts (enabled via promptSuggestions in initialize). */
export interface CLIPromptSuggestionMessage {
  type: "prompt_suggestion";
  suggestions: string[];
  session_id: string;
  uuid: string;
}

export type CLIMessage =
  | CLISystemMessage
  | CLIAssistantMessage
  | CLIResultMessage
  | CLIStreamEventMessage
  | CLIToolProgressMessage
  | CLIToolUseSummaryMessage
  | CLIControlRequestMessage
  | CLIControlResponseMessage
  | CLIUserEchoMessage
  | CLIRateLimitEventMessage
  | CLIKeepAliveMessage
  | CLIAuthStatusMessage
  | CLIUserEchoMessage
  | CLIRateLimitEventMessage
  | CLIControlCancelRequestMessage
  | CLIStreamlinedTextMessage
  | CLIStreamlinedToolUseSummaryMessage
  | CLIPromptSuggestionMessage;

// ─── Content Block Types ──────────────────────────────────────────────────────

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string | ContentBlock[]; is_error?: boolean }
  | { type: "thinking"; thinking: string; budget_tokens?: number };

// ─── Browser Message Types (browser <-> bridge) ──────────────────────────────

/** Messages the browser sends to the bridge */
export type BrowserOutgoingMessage =
  | { type: "user_message"; content: string; session_id?: string; images?: { media_type: string; data: string }[]; client_msg_id?: string }
  | { type: "permission_response"; request_id: string; behavior: "allow" | "deny"; updated_input?: Record<string, unknown>; updated_permissions?: PermissionUpdate[]; message?: string; client_msg_id?: string }
  | { type: "session_subscribe"; last_seq: number }
  | { type: "session_ack"; last_seq: number }
  | { type: "interrupt"; client_msg_id?: string }
  | { type: "set_model"; model: string; client_msg_id?: string }
  | { type: "set_permission_mode"; mode: string; client_msg_id?: string }
  | { type: "mcp_get_status"; client_msg_id?: string }
  | { type: "mcp_toggle"; serverName: string; enabled: boolean; client_msg_id?: string }
  | { type: "mcp_reconnect"; serverName: string; client_msg_id?: string }
  | { type: "mcp_set_servers"; servers: Record<string, McpServerConfig>; client_msg_id?: string }
  | { type: "set_ai_validation"; aiValidationEnabled?: boolean | null; aiValidationAutoApprove?: boolean | null; aiValidationAutoDeny?: boolean | null; client_msg_id?: string }
  | { type: "end_session"; reason?: string; client_msg_id?: string }
  | { type: "stop_task"; task_id: string; client_msg_id?: string }
  | { type: "update_environment_variables"; variables: Record<string, string>; client_msg_id?: string };

/** Messages the bridge sends to the browser */
export type BrowserIncomingMessageBase =
  | { type: "session_init"; session: SessionState }
  | { type: "session_update"; session: Partial<SessionState> }
  | {
    type: "assistant";
    message: CLIAssistantMessage["message"];
    parent_tool_use_id: string | null;
    timestamp?: number;
    /**
     * PLAN Task 12 (schema versioning) — terminal state of the stream that
     * produced this assistant message. Absent on legacy on-disk records;
     * load-side reader treats missing as "complete" so existing histories
     * render unchanged. New writes set:
     *   - "complete"    — CLI finished the turn and emitted a consolidated
     *                     `assistant` frame; the persisted message is whole.
     *   - "interrupted" — CLI streamed deltas then died/disconnected before
     *                     the consolidated frame arrived. The persisted
     *                     message is a synthetic snapshot of the partial
     *                     text; downstream renderers should signal the cut.
     *   - "errored"     — CLI signalled an error mid-stream (reserved for
     *                     future use; not produced yet).
     *
     * Reason this field belongs on the wire shape (not only on a private
     * persisted shape): the browser receives historic messages via
     * `message_history` AND live messages via `assistant`. The renderer
     * needs the same signal in both cases.
     */
    streamStatus?: "complete" | "interrupted" | "errored";
  }
  | { type: "stream_event"; event: unknown; parent_tool_use_id: string | null }
  | {
    type: "system_event";
    event:
      | Pick<CLICompactBoundaryMessage, "subtype" | "compact_metadata" | "uuid" | "session_id">
      | Pick<CLITaskNotificationMessage, "subtype" | "task_id" | "status" | "output_file" | "summary" | "uuid" | "session_id">
      | Pick<CLIFilesPersistedMessage, "subtype" | "files" | "failed" | "processed_at" | "uuid" | "session_id">
      | Pick<CLIHookStartedMessage, "subtype" | "hook_id" | "hook_name" | "hook_event" | "uuid" | "session_id">
      | Pick<CLIHookProgressMessage, "subtype" | "hook_id" | "hook_name" | "hook_event" | "stdout" | "stderr" | "output" | "uuid" | "session_id">
      | Pick<CLIHookResponseMessage, "subtype" | "hook_id" | "hook_name" | "hook_event" | "output" | "stdout" | "stderr" | "exit_code" | "outcome" | "uuid" | "session_id">;
    timestamp?: number;
  }
  | { type: "result"; data: CLIResultMessage }
  | { type: "permission_request"; request: PermissionRequest }
  | { type: "permission_cancelled"; request_id: string }
  | { type: "permission_auto_resolved"; request: PermissionRequest; behavior: "allow" | "deny"; reason: string }
  | { type: "tool_progress"; tool_use_id: string; tool_name: string; elapsed_time_seconds: number }
  | { type: "tool_use_summary"; summary: string; tool_use_ids: string[] }
  | { type: "status_change"; status: "compacting" | "idle" | "running" | null }
  | { type: "auth_status"; isAuthenticating: boolean; output: string[]; error?: string }
  | { type: "error"; message: string }
  | { type: "cli_disconnected" }
  | { type: "cli_connected" }
  // Terminal frame for the session-map eviction sweep (Realtime finding #1).
  // Unlike `cli_disconnected` (transient — drives a relaunch), this tells the
  // browser the row was INTENTIONALLY evicted from memory after archive. The
  // client marks the session archived and MUST NOT request a relaunch, so a
  // stale tab can no longer resurrect a blank live row on reconnect.
  | { type: "session_evicted" }
  // PLAN T10 (Phase F) - terminal CLI-failure wire frame.
  // Construction routed through `buildCliFailedFrame` in
  // `cli-failed-frame.ts` per AP-14 sole-assembly-site invariant;
  // production callers never literal this variant. Re-exported as
  // `CliFailedFrame` from `ws-bridge-types.ts` for the Phase G
  // frontend bridge.
  | import("./cli-failed-frame.js").CliFailedFrame
  | { type: "user_message"; content: string; timestamp: number; id?: string }
  | { type: "message_history"; messages: BrowserIncomingMessage[] }
  | { type: "event_replay"; events: BufferedBrowserEvent[] }
  | { type: "session_name_update"; name: string }
  | { type: "pr_status_update"; pr: import("./github-pr.js").GitHubPRInfo | null; available: boolean }
  | { type: "mcp_status"; servers: McpServerDetail[] }
  | { type: "session_phase"; phase: SessionPhase; previousPhase: SessionPhase }
  | { type: "keep_alive" }
  | { type: "prompt_suggestion"; suggestions: string[] }
  | { type: "streamlined_text"; text: string }
  | { type: "streamlined_tool_use_summary"; tool_summary: string }
  // ── Council Mode group events (T15 frontend wire contract) ─────────────
  // Emitters live in ws-bridge.ts (wired in a later Phase F commit). The
  // types are declared here so the frontend store + slice + ws.ts handler
  // can compile against the final wire shape from day one.
  | {
    type: "group_created";
    sessionGroupId: string;
    primarySessionId: string;
    observerSessionId: string;
    /** Server-validated pairing label, e.g. "claude+claude" or "claude+codex". */
    pairing: string;
    /**
     * PR #68: server emits the live coordinator status so REST bootstrap
     * (`GET /api/groups`) and the live push share one wire shape via the
     * `buildBrowserGroupRecord` helper. The push path always emits
     * `"active"` (the variant fires only on a transition that leaves the
     * group active); REST bootstrap may emit `"degraded"` or
     * `"reconnecting"` when the user reloads mid-state.
     *
     * **Optional on the wire** — mirrors the Task 9 precedent that made
     * `wakeTimeoutMs` optional. The persistent event buffer
     * (`session-store.ts:39 — eventBuffer?: BufferedBrowserEvent[]`) survives
     * a server restart, so a pre-PR-#68 server that buffered a `group_created`
     * frame, then upgrades onto this PR, will replay that legacy frame to a
     * reconnecting browser inside an `event_replay` envelope WITHOUT the
     * `status` field. Making the field optional keeps the type contract
     * truthful across the upgrade window; the client falls back to
     * `"active"` (the only sensible default for a `group_created` push) for
     * such legacy frames. New emits always carry `status` because they
     * route through `buildBrowserGroupRecord`.
     */
    status?: "pairing" | "active" | "degraded" | "archived" | "reconnecting";
    /**
     * Task 9: server-published auto-wake-to-review timeout in
     * milliseconds. Frontend uses this to bound the `reviewing` panel
     * state — past this deadline without an `observer_review` arrival,
     * the panel-state deriver yields `reviewing-stalled` (Task 11)
     * instead of silently reverting to `sleeping`. Server constant
     * mirrored here so the deriver has a real bound rather than a
     * frontend guess.
     *
     * Council Review 2026-05-13 Realtime #9: optional on the wire with
     * a frontend-side fallback constant (90s). Required would break
     * event-buffer replay for clients holding a pre-Task-9 `group_created`
     * frame. New clients always receive a populated value from the
     * server's current emit; replay-only-old-clients fall back gracefully.
     */
    wakeTimeoutMs?: number;
  }
  | {
    type: "group_exited";
    sessionGroupId: string;
    reason: "user_archived" | "shutdown" | "both_halves_died";
  }
  | {
    type: "group_degraded";
    sessionGroupId: string;
    deadRole: "orchestrator" | "observer";
    /**
     * Task 9: optional discriminant on the reason this group went
     * degraded. Frontend may render a sub-state of the `degraded`
     * status pill (e.g. "observer wake send failed" vs the default
     * "observer exited"). Omitted field defaults to "observer_exited"
     * for back-compat with v1 clients.
     */
    reason?: "observer_exited" | "wake_send_failed" | "reconnect_failed";
  }
  | {
    /**
     * PLAN Task 7: one half of a Council Mode group dropped its CLI ws
     * unexpectedly; the coordinator armed a bounded grace window before
     * flipping to `degraded`. Sent at transition time only — not periodic.
     *
     * `survivingRole` describes the alive half (the one whose browser
     * tab is guaranteed to receive the frame). `deadlineMs` is an
     * **absolute** wallclock (`Date.now()` at the server when armed +
     * grace), robust to in-flight latency, sleeping tabs, and replay.
     * `attempts` is omitted in v1 — current scope is one-shot per active
     * episode; widening to multi-attempt is an additive field bump.
     */
    type: "group_reconnecting";
    sessionGroupId: string;
    survivingRole: "orchestrator" | "observer";
    deadlineMs: number;
  }
  | {
    type: "group_checkpoint";
    sessionGroupId: string;
    checkpointId: string;
    phase: string;
    sequence: number;
    /** Wallclock (ms) the server processed the checkpoint sentinel. */
    timestamp: number;
  }
  | {
    type: "observer_review";
    sessionGroupId: string;
    checkpointId: string;
    phase: string;
    /** Findings after grounding validation. Each carries a stable server-assigned id. */
    findings: BrowserObserverFinding[];
    /** Server-side grounding downgrades, surfaced to the panel for transparency. */
    downgrades: BrowserObserverDowngrade[];
    observerModel: string;
    observerProvider: string;
    /** Wallclock (ms) the review was processed server-side. */
    timestamp: number;
    /**
     * Task 9: checkpoint ids that were superseded by the mid-turn
     * newest-wins queue (Task 4) between the previous review and this
     * one. Frontend renders a "checkpoint X was skipped (superseded)"
     * note in the panel so the user knows the cycle dropped coverage
     * deliberately, not silently. Omitted/empty when no checkpoints
     * were dropped — keeps the on-wire payload minimal in the happy path.
     */
    supersededCheckpointIds?: string[];
  }
  | {
    /**
     * Bidirectional pipeline Story 4.1 — convergence-tracker state update.
     * Server-authoritative; frontend never derives its own counter.
     *
     * `transition` discriminates which kind of change happened:
     *   - `cycle-progress`  counter changed (may be increment or reset)
     *   - `converged`       threshold reached; UI flips ☼ row to ✅ badge
     *   - `revoked`         STOP arrived post-convergence; back to in-progress
     *
     * `cycleNumber` / `convergenceThreshold` / `convergenceState` carry
     * the full server-side state so the frontend can render without
     * tracking prior values. Cumulative absolute values, not deltas.
     */
    type: "group_convergence";
    sessionGroupId: string;
    transition: "cycle-progress" | "converged" | "revoked";
    cycleNumber: number;
    convergenceThreshold: number;
    convergenceState: "in-progress" | "converged" | "revoked";
    /** Wallclock (ms) the server processed the transition. */
    timestamp: number;
  };

/**
 * Browser-shape observer finding. The server-side `ObserverReviewFinding`
 * (council-types.ts) is the storage/protocol shape; this is the per-message
 * envelope the browser consumes — adds `id` (server-assigned, stable for
 * React reconciliation) and grounding-related fields.
 */
export interface BrowserObserverFinding {
  id: string;
  severity: "STOP" | "WARN" | "NOTE" | "INFO";
  claim: string;
  evidence_path: string;
  evidence_lines?: [number, number];
  confidence?: "high" | "medium" | "low";
  /** True when grounding validation downgraded this from STOP → NOTE. */
  wasDowngraded?: boolean;
  /** Why grounding downgraded this finding. Set iff wasDowngraded. */
  downgradeReason?: "evidence_not_in_modified_set" | "evidence_missing_on_disk" | "wake_version_mismatch";
}

export interface BrowserObserverDowngrade {
  /** Finding id (correlates with `findings[].id` when downgraded entry kept in stream). */
  id: string;
  reason: "evidence_not_in_modified_set" | "evidence_missing_on_disk" | "wake_version_mismatch";
}

/**
 * Council Mode group — browser wire shape. The subset of the coordinator's
 * `GroupRecord` the browser needs to render the Sidebar glyph + ObserverPanel
 * pair context. Returned by:
 *
 *   1. The REST bootstrap endpoint `GET /api/groups` (PR #68 — close the
 *      bootstrap gap where `group:created` events are lost on reload).
 *   2. The producer-side mapper inside `SessionOrchestrator` that the
 *      `group:created` listener can also use, so the wire shape and the
 *      bootstrap shape stay in lockstep (AP-3: writer + reader schemas
 *      co-located in one file).
 *
 * `status` is INCLUDED here (unlike the original `group_created` wire
 * variant which implicitly meant "active") because a browser reloading
 * mid-degraded or mid-reconnecting pair MUST receive the true status —
 * otherwise the panel renders a stale "active" pill against a dead half.
 *
 * `wakeTimeoutMs` mirrors the server's {@link OBSERVER_WAKE_TIMEOUT_MS}
 * constant so the panel-state deriver bounds the `reviewing` interval
 * identically whether the group surfaced via REST bootstrap or the live
 * `group_created` push.
 */
export interface BrowserGroupRecord {
  sessionGroupId: string;
  primarySessionId: string;
  observerSessionId: string;
  /** Server-validated pairing label, e.g. "claude+claude" / "claude+codex". */
  pairing: string;
  /** Live coordinator status — see `GroupStatus` in `group-state-machine.ts`. */
  status: "pairing" | "active" | "degraded" | "archived" | "reconnecting";
  /** Optional: which half died (populated only when status === "degraded"). */
  deadRole?: SessionGroupRole;
  /** Task 9 — server-published wake-to-review bound; see `group_created`. */
  wakeTimeoutMs?: number;
}

export type BrowserIncomingMessage = BrowserIncomingMessageBase & { seq?: number };

export type ReplayableBrowserIncomingMessage = Exclude<BrowserIncomingMessageBase, { type: "event_replay" }>;

export interface BufferedBrowserEvent {
  seq: number;
  message: ReplayableBrowserIncomingMessage;
}

// ─── Session State ────────────────────────────────────────────────────────────

export type BackendType = "claude" | "codex";

export interface SessionState {
  session_id: string;
  backend_type?: BackendType;
  model: string;
  cwd: string;
  tools: string[];
  permissionMode: string;
  claude_code_version: string;
  mcp_servers: { name: string; status: string }[];
  agents: string[];
  slash_commands: string[];
  skills: string[];
  total_cost_usd: number;
  num_turns: number;
  context_used_percent: number;
  is_compacting: boolean;
  git_branch: string;
  is_worktree: boolean;
  is_containerized: boolean;
  repo_root: string;
  git_ahead: number;
  git_behind: number;
  total_lines_added: number;
  total_lines_removed: number;
  // Codex-specific token details (forwarded from thread/tokenUsage/updated)
  codex_token_details?: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    reasoningOutputTokens: number;
    modelContextWindow: number;
  };
  // Codex-specific rate limits (forwarded from account/rateLimits/updated)
  codex_rate_limits?: {
    primary: { usedPercent: number; windowDurationMins: number; resetsAt: number } | null;
    secondary: { usedPercent: number; windowDurationMins: number; resetsAt: number } | null;
  };
  /** If this session was spawned by a cron job */
  cronJobId?: string;
  /** Human-readable name of the cron job that spawned this session */
  cronJobName?: string;
  /** If this session was spawned by an agent */
  agentId?: string;
  /** Human-readable name of the agent that spawned this session */
  agentName?: string;
  /** Per-session AI validation override. null/undefined = use global default */
  aiValidationEnabled?: boolean | null;
  /** Per-session auto-approve override. null/undefined = use global default */
  aiValidationAutoApprove?: boolean | null;
  /** Per-session auto-deny override. null/undefined = use global default */
  aiValidationAutoDeny?: boolean | null;
  /** If this session is linked to a Linear agent session */
  linearSessionId?: string;
  /** Council Mode pairing — group this session belongs to, if any. Server-generated, opaque to clients. */
  sessionGroupId?: string;
  /** Council Mode pairing — the role this session plays within {@link sessionGroupId}. */
  sessionGroupRole?: SessionGroupRole;
}

/** Roles a session can play inside a Council Mode pair. */
export type SessionGroupRole = "orchestrator" | "observer";

// ─── MCP Types ───────────────────────────────────────────────────────────────

export interface McpServerConfig {
  type: "stdio" | "sse" | "http" | "sdk";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

export interface McpServerDetail {
  name: string;
  status: "connected" | "failed" | "disabled" | "connecting";
  serverInfo?: unknown;
  error?: string;
  config: { type: string; url?: string; command?: string; args?: string[] };
  scope: string;
  tools?: { name: string; annotations?: { readOnly?: boolean; destructive?: boolean; openWorld?: boolean } }[];
}

// ─── Permission Request ──────────────────────────────────────────────────────

// ─── Permission Rule Types ───────────────────────────────────────────────────

export type PermissionDestination = "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg";

export type PermissionUpdate =
  | { type: "addRules"; rules: { toolName: string; ruleContent?: string }[]; behavior: "allow" | "deny" | "ask"; destination: PermissionDestination }
  | { type: "replaceRules"; rules: { toolName: string; ruleContent?: string }[]; behavior: "allow" | "deny" | "ask"; destination: PermissionDestination }
  | { type: "removeRules"; rules: { toolName: string; ruleContent?: string }[]; behavior: "allow" | "deny" | "ask"; destination: PermissionDestination }
  | { type: "setMode"; mode: string; destination: PermissionDestination }
  | { type: "addDirectories"; directories: string[]; destination: PermissionDestination }
  | { type: "removeDirectories"; directories: string[]; destination: PermissionDestination };

export interface AiValidationInfo {
  verdict: "safe" | "dangerous" | "uncertain";
  reason: string;
  ruleBasedOnly: boolean;
}

export interface PermissionRequest {
  request_id: string;
  tool_name: string;
  input: Record<string, unknown>;
  permission_suggestions?: PermissionUpdate[];
  description?: string;
  tool_use_id: string;
  agent_id?: string;
  title?: string;
  display_name?: string;
  blocked_path?: string;
  decision_reason?: string;
  timestamp: number;
  ai_validation?: AiValidationInfo;
}

// ─── Session Creation Progress (SSE streaming) ──────────────────────────────

export type CreationStepId =
  | "resolving_env"
  | "fetching_git"
  | "checkout_branch"
  | "pulling_git"
  | "creating_worktree"
  | "pulling_image"
  | "building_image"
  | "creating_container"
  | "copying_workspace"
  | "running_init_script"
  | "launching_cli";

export interface CreationProgressEvent {
  step: CreationStepId;
  label: string;
  status: "in_progress" | "done" | "error";
  detail?: string;
}
