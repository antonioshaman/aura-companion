import type { ServerWebSocket } from "bun";
import type {
  BackendType,
  BrowserIncomingMessage,
  PermissionRequest,
  SessionState,
  BufferedBrowserEvent,
} from "./session-types.js";
import type { IBackendAdapter } from "./backend-adapter.js";
import type { SessionStateMachine } from "./session-state-machine.js";
import { getSettings } from "./settings-manager.js";

export interface CLISocketData {
  kind: "cli";
  sessionId: string;
}

export interface BrowserSocketData {
  kind: "browser";
  sessionId: string;
  subscribed?: boolean;
  lastAckSeq?: number;
}

export interface TerminalSocketData {
  kind: "terminal";
  terminalId: string;
}

export interface NoVncSocketData {
  kind: "novnc";
  sessionId: string;
}

export type SocketData = CLISocketData | BrowserSocketData | TerminalSocketData | NoVncSocketData;

/** Tracks a pending control_request sent to CLI that expects a control_response. */
export interface PendingControlRequest {
  subtype: string;
  resolve: (response: unknown) => void;
}

export interface Session {
  id: string;
  backendType: BackendType;
  /** Unified backend adapter — replaces the former cliSocket (Claude) / codexAdapter (Codex) fields. */
  backendAdapter: IBackendAdapter | null;
  browserSockets: Set<ServerWebSocket<SocketData>>;
  state: SessionState;
  pendingPermissions: Map<string, PermissionRequest>;
  messageHistory: BrowserIncomingMessage[];
  pendingMessages: string[];
  nextEventSeq: number;
  eventBuffer: BufferedBrowserEvent[];
  lastAckSeq: number;
  processedClientMessageIds: string[];
  processedClientMessageIdSet: Set<string>;
  /** Timestamp of last non-keepalive CLI message (for idle detection) */
  lastCliActivityTs: number;
  /** Formal session state machine tracking phase and validating transitions. */
  stateMachine: SessionStateMachine;
  /** Cleanup function for state machine transition listener — call on session teardown. */
  unsubscribeStateMachine?: () => void;
  /**
   * PLAN Task 12 (streamStatus) — in-memory tracker of the assistant message
   * currently being streamed by the CLI. Populated on `stream_event` for
   * `message_start`, accumulated on `content_block_delta` text deltas, cleared
   * on the consolidated `assistant` frame. If the CLI socket closes (confirmed
   * after the 15s debounce) with this still set, the bridge synthesises a
   * partial assistant message with `streamStatus: "interrupted"` and persists
   * it so the next mount renders the cut bubble explicitly rather than
   * silently losing the partial text. Not persisted itself — recomputed
   * deterministically from incoming wire frames.
   */
  streamingAssistant?: {
    id: string;
    text: string;
    parentToolUseId: string | null;
    model?: string;
    startedAt: number;
  } | null;
  /**
   * OBS-STOP-1 fix — pending `appendSystemPrompt` buffered when
   * `injectSystemPrompt` is called BEFORE the CLI WebSocket connects
   * (the early session-creation-service.ts:461 path). Without buffering,
   * the previous `if (backendAdapter instanceof ClaudeAdapter)` guard
   * silently no-op'd and the prompt was lost. `handleCLIOpen` consumes
   * this in the kickoff initialize so there is exactly ONE initialize
   * control_request per session lifecycle, carrying any accumulated
   * `appendSystemPrompt` rather than a bare kickoff that races a
   * later second initialize.
   */
  pendingSystemPromptInjection?: string | null;
}

export type GitSessionKey =
  | "git_branch"
  | "is_worktree"
  | "is_containerized"
  | "repo_root"
  | "git_ahead"
  | "git_behind";

export function makeDefaultState(
  sessionId: string,
  backendType: BackendType = "claude",
): SessionState {
  return {
    session_id: sessionId,
    backend_type: backendType,
    model: "",
    cwd: "",
    tools: [],
    permissionMode: "default",
    claude_code_version: "",
    mcp_servers: [],
    agents: [],
    slash_commands: [],
    skills: [],
    total_cost_usd: 0,
    num_turns: 0,
    context_used_percent: 0,
    is_compacting: false,
    git_branch: "",
    is_worktree: false,
    is_containerized: false,
    repo_root: "",
    git_ahead: 0,
    git_behind: 0,
    total_lines_added: 0,
    total_lines_removed: 0,
    aiValidationEnabled: getSettings().aiValidationEnabled,
    aiValidationAutoApprove: getSettings().aiValidationAutoApprove,
    aiValidationAutoDeny: getSettings().aiValidationAutoDeny,
  };
}
