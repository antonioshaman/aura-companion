import type {
  SessionState,
  PermissionRequest,
  AiValidationInfo,
  ContentBlock,
  BrowserIncomingMessage,
  BrowserOutgoingMessage,
  BackendType,
  McpServerDetail,
  McpServerConfig,
  CreationProgressEvent,
  BrowserObserverFinding,
  BrowserObserverDowngrade,
} from "../server/session-types.js";

export type {
  SessionState,
  PermissionRequest,
  AiValidationInfo,
  ContentBlock,
  BrowserIncomingMessage,
  BrowserOutgoingMessage,
  BackendType,
  McpServerDetail,
  McpServerConfig,
  CreationProgressEvent,
  BrowserObserverFinding,
  BrowserObserverDowngrade,
};
export type { SessionPhase } from "../server/session-state-machine.js";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  contentBlocks?: ContentBlock[];
  images?: { media_type: string; data: string }[];
  timestamp: number;
  parentToolUseId?: string | null;
  isStreaming?: boolean;
  streamingPhase?: "thinking" | "text";
  model?: string;
  stopReason?: string | null;
  /**
   * PLAN Task 12 — terminal state of the stream that produced this
   * assistant message. Mirrors the server-side wire field with the same
   * name. Absent on user/system messages and on legacy assistant messages
   * persisted before this field existed — the renderer treats absent as
   * "complete" so existing histories show no badge. Set to "interrupted"
   * on a synthesised partial frame after a CLI disconnect.
   */
  streamStatus?: "complete" | "interrupted" | "errored";
}

export interface TaskItem {
  id: string;
  subject: string;
  description: string;
  activeForm?: string;
  status: "pending" | "in_progress" | "completed";
  owner?: string;
  blockedBy?: string[];
}

export type ProcessStatus = "running" | "completed" | "failed" | "stopped";

export interface ProcessItem {
  /** Claude Code internal task_id (e.g., "b9d9718") */
  taskId: string;
  /** The tool_use_id from the Bash tool_use block that spawned this process */
  toolUseId: string;
  /** The shell command that was run in the background */
  command: string;
  /** Human-readable description from the Bash tool input */
  description: string;
  /** Path to the output file (from tool_result content) */
  outputFile: string;
  /** Current status */
  status: ProcessStatus;
  /** Timestamp when the process was first detected */
  startedAt: number;
  /** Timestamp when status changed to a terminal state */
  completedAt?: number;
  /** Summary text from task_notification */
  summary?: string;
}

export interface SystemProcess {
  /** OS process ID */
  pid: number;
  /** Short command name (e.g., "node", "bun", "python3") */
  command: string;
  /** Full command line with arguments */
  fullCommand: string;
  /** TCP ports this process is listening on */
  ports: number[];
  /** Process working directory, when available */
  cwd?: string;
  /** Best-effort process start timestamp (ms since epoch) */
  startedAt?: number;
}

// ── Council Mode client-side types ──────────────────────────────────────────

export type SessionGroupStatus = "pairing" | "active" | "degraded" | "archived" | "reconnecting";
export type SessionRole = "orchestrator" | "observer";

/**
 * Mirror of the server-side group record, narrowed to what the browser
 * needs to render. Updated by the council slice in response to the
 * `group_*` / `observer_review` WS messages — never mutated directly.
 */
export interface GroupRecord {
  sessionGroupId: string;
  primarySessionId: string;
  observerSessionId: string;
  status: SessionGroupStatus;
  /** Server-validated pairing label ("claude+claude", "claude+codex"). */
  pairing: string;
  /** Which half died — populated only when status === "degraded". */
  deadRole?: SessionRole;
  /** Wallclock (ms) of the most recent checkpoint received. */
  lastCheckpointAt?: number;
  /** Monotonic sequence of the most recent checkpoint received. */
  lastCheckpointSeq?: number;
  /** Phase name of the most recent checkpoint received. */
  lastPhase?: string;
  /**
   * True if the observer is actively reviewing the latest checkpoint
   * (set on `group_checkpoint`, cleared on `observer_review`). Optimistic
   * paint is reserved for orchestrator inputs — observer activity is
   * server-confirmed only (faking it destroys the independent-signal value).
   */
  observerReviewing?: boolean;
  /**
   * Task 9/11: server-published wake-to-review timeout in milliseconds.
   * Populated from `group_created`; the panel-state deriver uses this to
   * bound the `reviewing` interval. Past `lastCheckpointAt + wakeTimeoutMs`
   * without an `observer_review` arrival, the deriver yields
   * `reviewing-stalled` rather than silently reverting to `sleeping`.
   */
  wakeTimeoutMs?: number;
  /**
   * Task 9/11: checkpoint ids the server's mid-turn newest-wins queue
   * dropped between the previous review and the most recent one.
   * Populated from `observer_review.supersededCheckpointIds`. Surfaced
   * in the panel as `queued-dropped` state so the user knows the cycle
   * deliberately skipped coverage. Cleared when the next review lands
   * with an empty/omitted superseded list.
   */
  recentlySupersededCheckpointIds?: string[];

  /**
   * Bidirectional pipeline Story 4.1 — server-authoritative convergence
   * state. The frontend NEVER derives these locally; the server publishes
   * them via `group_convergence` wire frames. Absent until the first
   * review processed.
   *
   *   - `cycleNumber`           clean-cycle counter (0..threshold)
   *   - `convergenceThreshold`  pair-level threshold (default 3, range 2-5)
   *   - `convergenceState`      `"in-progress" | "converged" | "revoked"`
   */
  cycleNumber?: number;
  convergenceThreshold?: number;
  convergenceState?: "in-progress" | "converged" | "revoked";
}

/**
 * Browser-side finding record. Adds `receivedAt`, `checkpointId`, `phase`
 * and observer attribution fields onto the wire envelope so the panel
 * can group findings by checkpoint without consulting the server again.
 */
export interface ObserverFinding {
  /** Server-assigned stable id — used for React reconciliation. Do not re-key on UI. */
  id: string;
  severity: "STOP" | "WARN" | "NOTE" | "INFO";
  claim: string;
  evidence_path: string;
  evidence_lines?: [number, number];
  confidence?: "high" | "medium" | "low";
  /** Wallclock (ms) when the finding reached the browser. */
  receivedAt: number;
  /** Checkpoint this finding answers. */
  checkpointId: string;
  /** Phase name (e.g. "council-plan"). */
  phase: string;
  /** True when grounding validation downgraded this from STOP → NOTE server-side. */
  wasDowngraded?: boolean;
  /** Why grounding downgraded this finding. Set iff wasDowngraded.
   *  `wake_version_mismatch` (Task 10) is a global downgrade applied to
   *  every finding when the observer's echo of the wake-payload version
   *  disagrees with what the server dispatched. */
  downgradeReason?: "evidence_not_in_modified_set" | "evidence_missing_on_disk" | "wake_version_mismatch";
  observerModel: string;
  observerProvider: string;
}

export type ObserverPanelStateName =
  | "never-checkpointed-yet"
  | "spawning"
  | "reconnecting"
  | "sleeping"
  | "reviewing"
  | "reviewing-stalled"
  | "queued-dropped"
  | "cycle-progress"
  | "converged"
  | "blocker-found"
  | "degraded";

/**
 * Discriminated-union for the observer panel header status pill.
 * Components MUST consume the derived value as a unit — they MUST NOT
 * recompute the name from independent booleans (Saarinen P8 component
 * consistency + the "three diverging boolean expressions" anti-pattern).
 *
 * `spawning` covers the 10-30s pair-creation window when the backend is
 * still bringing the second half up; `reconnecting` covers the transient
 * WebSocket flap when the observer half's CLI socket drops. Both states
 * sit above `never-checkpointed-yet` in priority — they communicate
 * "the pair is in flux", not "the pair is healthy + idle".
 */
export type ObserverPanelState =
  | { name: "never-checkpointed-yet" }
  | { name: "spawning"; sinceMs: number; pairing: string }
  | { name: "reconnecting"; lastCheckpointAt: number | null; lastPhase: string | null }
  | { name: "sleeping"; lastCheckpointAt: number; lastPhase: string }
  | { name: "reviewing"; reviewingSince: number; phase: string; expiresAt: number }
  | { name: "reviewing-stalled"; reviewingSince: number; phase: string; expiredAt: number }
  | { name: "queued-dropped"; lastCheckpointAt: number; lastPhase: string; droppedCheckpointIds: readonly string[] }
  /**
   * Bidirectional pipeline Story 4.1 — clean-cycle progress.
   * Server-authoritative: `cycleNumber` + `threshold` arrive on each
   * `group_convergence` frame; the pill renders `🔄 Cycle N/T`. Slots
   * BELOW `blocker-found`/`reconnecting`/`reviewing` so a live STOP
   * or active review still wins priority.
   */
  | { name: "cycle-progress"; cycleNumber: number; threshold: number }
  /**
   * Bidirectional pipeline Story 4.1 — pair has converged. Pill renders
   * `✅ Converged — ready to ship` (emerald-500 token). Slots BELOW
   * `degraded` so a half going dead immediately re-asserts the warning.
   */
  | { name: "converged"; cycleNumber: number; threshold: number }
  | { name: "blocker-found"; unresolvedStops: number; lastBlockerAt: number }
  | { name: "degraded"; deadRole: SessionRole };

export interface SdkSessionInfo {
  sessionId: string;
  cliSessionId?: string;
  pid?: number;
  state: "starting" | "connected" | "running" | "exited";
  exitCode?: number | null;
  model?: string;
  permissionMode?: string;
  cwd: string;
  createdAt: number;
  archived?: boolean;
  containerId?: string;
  containerName?: string;
  containerImage?: string;
  name?: string;
  backendType?: BackendType;
  gitBranch?: string;
  gitAhead?: number;
  gitBehind?: number;
  totalLinesAdded?: number;
  totalLinesRemoved?: number;
  resumeSessionAt?: string;
  forkSession?: boolean;
  /** If this session was spawned by a cron job */
  cronJobId?: string;
  /** Human-readable name of the cron job that spawned this session */
  cronJobName?: string;
  /** If this session was spawned by an agent */
  agentId?: string;
  /** Human-readable name of the agent that spawned this session */
  agentName?: string;
  /** Sandbox profile slug used for this session */
  sandboxSlug?: string;
}
