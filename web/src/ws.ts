import { useStore } from "./store.js";
import type { BrowserIncomingMessage, BrowserOutgoingMessage, ContentBlock, ChatMessage, TaskItem, ProcessItem, ProcessStatus, SdkSessionInfo, McpServerConfig } from "./types.js";
import { generateUniqueSessionName } from "./utils/names.js";
import { playNotificationSound } from "./utils/notification-sound.js";
import { getPreview } from "./components/ToolBlock.js";
import type { ToolActivityEntry } from "./store/tasks-slice.js";
import { api } from "./api.js";

const WS_RECONNECT_DELAY_MS = 2000;
const sockets = new Map<string, WebSocket>();
const reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
/**
 * Tracks sessionIds that are mid-reconnect. Set on `ws.onclose`,
 * cleared on the replacement socket's `ws.onopen`. Required because
 * `scheduleReconnect`'s timer-callback deletes the timer from
 * `reconnectTimers` BEFORE invoking `connectSession`, so by the time
 * the new socket's `onopen` runs, the timer map says "no reconnect" —
 * which would silently suppress the post-reconnect group refetch.
 */
const reconnectingSessions = new Set<string>();
const lastSeqBySession = new Map<string, number>();
const taskCounters = new Map<string, number>();
const streamingPhaseBySession = new Map<string, "thinking" | "text">();
const streamingDraftMessageIdBySession = new Map<string, string>();
const pendingOutgoingBySession = new Map<string, BrowserOutgoingMessage[]>();
/** Track processed tool_use IDs to prevent duplicate task creation */
const processedToolUseIds = new Map<string, Set<string>>();

/**
 * PR #68 friedman fix-pass — when ANY session WebSocket reconnects (a
 * strong correlated signal that the network blipped), refire the
 * Council Mode group bootstrap. The App.tsx mount-effect `fetchGroups`
 * call may have failed in the same blip; without a recovery path the
 * Sidebar's ☼/☽ glyphs stay absent forever for active idle pairs that
 * produce no future `group:*` events.
 *
 * Debounced via a module-level pending-timer slot so a multi-session
 * connect-storm (page returns from background, several pairs all
 * reconnect at once) fires ONE refetch, not N. `hydrateGroups` is
 * idempotent (live WS still wins for already-present groups) so even
 * without dedup this would be safe — the dedup is a polish move.
 */
let pendingGroupRefetchTimer: ReturnType<typeof setTimeout> | null = null;
const GROUP_REFETCH_DEBOUNCE_MS = 250;

function scheduleGroupRefetchAfterReconnect(): void {
  if (pendingGroupRefetchTimer !== null) return;
  pendingGroupRefetchTimer = setTimeout(() => {
    pendingGroupRefetchTimer = null;
    api.fetchGroups().then(({ groups }) => {
      useStore.getState().hydrateGroups(groups);
    }).catch((err) => {
      // Best-effort recovery; the next reconnect will try again.
      // Structured log for forensic grep.
      console.warn("[ws] post-reconnect fetchGroups bootstrap failed", {
        event: "council.bootstrap.fetch_failed_post_reconnect",
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, GROUP_REFETCH_DEBOUNCE_MS);
}

function isSocketUsable(ws: WebSocket | undefined): boolean {
  return !!ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING);
}

function shouldReconnectSession(sessionId: string): boolean {
  const store = useStore.getState();
  const sdkSession = store.sdkSessions.find((s) => s.sessionId === sessionId);
  if (sdkSession) return !sdkSession.archived;
  // Fallback for freshly-created sessions that may not be in sdkSessions yet.
  return store.currentSessionId === sessionId;
}

function getReconnectCandidates(): string[] {
  const store = useStore.getState();
  const ids = new Set<string>();
  for (const s of store.sdkSessions) {
    if (!s.archived) ids.add(s.sessionId);
  }
  if (store.currentSessionId) ids.add(store.currentSessionId);
  return Array.from(ids);
}

// ── Page visibility handling ─────────────────────────────────────────────────
// Mobile browsers (Android Chrome, iOS Safari) aggressively kill WebSocket
// connections when the page is backgrounded. Without this handler, the frontend
// enters a rapid connect/disconnect cycle: WS opens, browser kills it, 2s
// reconnect timer fires, WS opens again, browser kills it again...
//
// Solution: when the page becomes hidden, pause all reconnect attempts. When
// the page becomes visible again, immediately reconnect all active sessions.
let pageHidden = typeof document !== "undefined" ? document.hidden : false;

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      pageHidden = true;
      // Cancel all pending reconnect timers — no point reconnecting while hidden
      for (const [sessionId, timer] of reconnectTimers) {
        clearTimeout(timer);
        reconnectTimers.delete(sessionId);
      }
    } else {
      pageHidden = false;
      // Page is visible again — reconnect all known active sessions.
      for (const sessionId of getReconnectCandidates()) {
        // Re-check in case sdkSessions changed after candidate collection.
        if (!shouldReconnectSession(sessionId)) continue;
        const ws = sockets.get(sessionId);
        if (!isSocketUsable(ws)) {
          if (ws) {
            try { ws.close(); } catch {}
            sockets.delete(sessionId);
          }
          connectSession(sessionId);
        }
      }
    }
  });
}

function normalizePath(path: string): string {
  const isAbs = path.startsWith("/");
  const parts = path.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(part);
  }
  return `${isAbs ? "/" : ""}${out.join("/")}`;
}

function resolveSessionFilePath(filePath: string, cwd?: string): string {
  if (filePath.startsWith("/")) return normalizePath(filePath);
  if (!cwd) return normalizePath(filePath);
  return normalizePath(`${cwd}/${filePath}`);
}

function isPathInSessionScope(filePath: string, cwd?: string): boolean {
  if (!cwd) return true;
  const normalizedCwd = normalizePath(cwd);
  return filePath === normalizedCwd || filePath.startsWith(`${normalizedCwd}/`);
}

function getProcessedSet(sessionId: string): Set<string> {
  let set = processedToolUseIds.get(sessionId);
  if (!set) {
    set = new Set();
    processedToolUseIds.set(sessionId, set);
  }
  return set;
}

// `frameTs` is the wall-clock time the task mutation actually happened. Live
// frames default to now; history-replay passes the original message timestamp so
// the panel's "updated N ago" reflects the true age, not the page-load time.
function extractTasksFromBlocks(sessionId: string, blocks: ContentBlock[], frameTs: number = Date.now()) {
  const store = useStore.getState();
  const processed = getProcessedSet(sessionId);

  for (const block of blocks) {
    if (block.type !== "tool_use") continue;
    const { name, input, id: toolUseId } = block;

    // Deduplicate by tool_use_id
    if (toolUseId) {
      if (processed.has(toolUseId)) continue;
      processed.add(toolUseId);
    }

    // TodoWrite: full replacement — { todos: [{ content, status, activeForm }] }
    if (name === "TodoWrite") {
      const todos = input.todos as { content?: string; status?: string; activeForm?: string }[] | undefined;
      if (Array.isArray(todos)) {
        const tasks: TaskItem[] = todos.map((t, i) => ({
          id: String(i + 1),
          subject: t.content || "Task",
          description: "",
          activeForm: t.activeForm,
          status: (t.status as TaskItem["status"]) || "pending",
        }));
        store.setTasks(sessionId, tasks, frameTs);
        taskCounters.set(sessionId, tasks.length);
      }
      continue;
    }

    // TaskCreate: incremental add — { subject, description, activeForm }
    if (name === "TaskCreate") {
      const count = (taskCounters.get(sessionId) || 0) + 1;
      taskCounters.set(sessionId, count);
      const task = {
        id: String(count),
        subject: (input.subject as string) || "Task",
        description: (input.description as string) || "",
        activeForm: input.activeForm as string | undefined,
        status: "pending" as const,
      };
      store.addTask(sessionId, task, frameTs);
      continue;
    }

    // TaskUpdate: incremental update — { taskId, status, owner, activeForm, addBlockedBy }
    if (name === "TaskUpdate") {
      const taskId = input.taskId as string;
      if (taskId) {
        const updates: Partial<TaskItem> = {};
        if (input.status) updates.status = input.status as TaskItem["status"];
        if (input.owner) updates.owner = input.owner as string;
        if (input.activeForm !== undefined) updates.activeForm = input.activeForm as string;
        if (input.addBlockedBy) updates.blockedBy = input.addBlockedBy as string[];
        store.updateTask(sessionId, taskId, updates, frameTs);
      }
    }
  }
}

function extractChangedFilesFromBlocks(sessionId: string, blocks: ContentBlock[]) {
  const store = useStore.getState();
  const sessionCwd =
    store.sessions.get(sessionId)?.cwd ||
    store.sdkSessions.find((sdk) => sdk.sessionId === sessionId)?.cwd;
  let dirty = false;
  for (const block of blocks) {
    if (block.type !== "tool_use") continue;
    const { name, input } = block;
    if ((name === "Edit" || name === "Write") && typeof input.file_path === "string") {
      const resolvedPath = resolveSessionFilePath(input.file_path, sessionCwd);
      if (isPathInSessionScope(resolvedPath, sessionCwd)) {
        dirty = true;
      }
    }
  }
  if (dirty) store.bumpChangedFilesTick(sessionId);
}

/** Pending background Bash calls awaiting their tool_result (keyed by sessionId → toolUseId) */
const pendingBackgroundBash = new Map<string, Map<string, { command: string; description: string; startedAt: number }>>();

const BG_RESULT_REGEX = /Command running in background with ID:\s*(\S+)\.\s*Output is being written to:\s*(\S+)/;

function extractProcessesFromBlocks(sessionId: string, blocks: ContentBlock[]) {
  const store = useStore.getState();

  for (const block of blocks) {
    // Phase 1: Detect Bash tool_use with run_in_background
    if (block.type === "tool_use" && block.name === "Bash") {
      const input = block.input as Record<string, unknown>;
      if (input.run_in_background === true) {
        let sessionPending = pendingBackgroundBash.get(sessionId);
        if (!sessionPending) {
          sessionPending = new Map();
          pendingBackgroundBash.set(sessionId, sessionPending);
        }
        sessionPending.set(block.id, {
          command: (input.command as string) || "",
          description: (input.description as string) || "",
          startedAt: Date.now(),
        });
      }
    }

    // Phase 2: Match tool_result to a pending background Bash
    if (block.type === "tool_result") {
      const toolUseId = block.tool_use_id;
      const sessionPending = pendingBackgroundBash.get(sessionId);
      const pending = sessionPending?.get(toolUseId);
      if (sessionPending && pending) {
        const content = typeof block.content === "string"
          ? block.content
          : Array.isArray(block.content)
            ? block.content.map((b) => ("text" in b ? (b as { text: string }).text : "")).join("")
            : "";

        const match = content.match(BG_RESULT_REGEX);
        if (match) {
          const processItem: ProcessItem = {
            taskId: match[1],
            toolUseId,
            command: pending.command,
            description: pending.description,
            outputFile: match[2],
            status: "running",
            startedAt: pending.startedAt,
          };
          store.addProcess(sessionId, processItem);
        }

        sessionPending.delete(toolUseId);
        if (sessionPending.size === 0) {
          pendingBackgroundBash.delete(sessionId);
        }
      }
    }
  }
}

function sendBrowserNotification(title: string, body: string, tag: string) {
  if (typeof Notification === "undefined") return;
  if (Notification.permission !== "granted") return;
  new Notification(title, { body, tag });
}

function summarizeSystemEvent(
  event: Extract<BrowserIncomingMessage, { type: "system_event" }>["event"],
): string | null {
  if (event.subtype === "compact_boundary") {
    return `Context compacted (${event.compact_metadata.trigger}, pre-tokens: ${event.compact_metadata.pre_tokens}).`;
  }

  if (event.subtype === "task_notification") {
    const summary = event.summary ? ` ${event.summary}` : "";
    return `Task ${event.status}: ${event.task_id}.${summary}`;
  }

  if (event.subtype === "files_persisted") {
    const persisted = event.files.length;
    const failed = event.failed.length;
    if (failed > 0) {
      return `Persisted ${persisted} file(s), ${failed} failed.`;
    }
    return `Persisted ${persisted} file(s).`;
  }

  if (event.subtype === "hook_started") {
    return `Hook started: ${event.hook_name} (${event.hook_event}).`;
  }

  if (event.subtype === "hook_response") {
    const exitCode = typeof event.exit_code === "number" ? ` (exit ${event.exit_code})` : "";
    return `Hook ${event.outcome}: ${event.hook_name} (${event.hook_event})${exitCode}.`;
  }

  // hook_progress can be high-volume; keep it out of chat by default.
  return null;
}

let idCounter = 0;
let clientMsgCounter = 0;
function nextId(): string {
  return `msg-${Date.now()}-${++idCounter}`;
}

function enqueueOutgoing(sessionId: string, msg: BrowserOutgoingMessage) {
  const queued = pendingOutgoingBySession.get(sessionId) || [];
  queued.push(msg);
  pendingOutgoingBySession.set(sessionId, queued);
}

function flushQueuedOutgoing(sessionId: string, ws: WebSocket) {
  const queued = pendingOutgoingBySession.get(sessionId);
  if (!queued?.length || ws.readyState !== WebSocket.OPEN) return;
  pendingOutgoingBySession.delete(sessionId);
  for (const msg of queued) {
    ws.send(JSON.stringify(msg));
  }
}

/** Accumulated streaming content per session — thinking and text tracked separately */
const streamingBlocksBySession = new Map<string, { thinking: string; text: string }>();

function setStreamingDraftMessage(sessionId: string, content: string, phase?: "thinking" | "text") {
  const store = useStore.getState();
  const existing = store.messages.get(sessionId) || [];
  const existingDraftId = streamingDraftMessageIdBySession.get(sessionId);

  // Remove ALL orphaned streaming drafts (messages with isStreaming that aren't
  // the tracked draft). This prevents duplicates when message_history merges or
  // reconnects leave stale drafts in the array.
  let messages = existing.filter(
    (m) => !m.isStreaming || m.id === existingDraftId,
  );

  let draftIndex = -1;
  if (existingDraftId) {
    draftIndex = messages.findIndex((m) => m.id === existingDraftId);
    if (draftIndex === -1) {
      streamingDraftMessageIdBySession.delete(sessionId);
    }
  }

  if (draftIndex === -1) {
    const id = `stream-${sessionId}-${nextId()}`;
    streamingDraftMessageIdBySession.set(sessionId, id);
    messages = [...messages, {
      id,
      role: "assistant" as const,
      content,
      timestamp: Date.now(),
      isStreaming: true,
      streamingPhase: phase,
    }];
  } else {
    messages = [...messages];
    const prev = messages[draftIndex];
    messages[draftIndex] = {
      ...prev,
      role: "assistant",
      content,
      isStreaming: true,
      streamingPhase: phase,
    };
  }

  store.setMessages(sessionId, messages);
}

function clearStreamingDraftMessage(sessionId: string) {
  streamingDraftMessageIdBySession.delete(sessionId);

  // Remove ALL streaming draft messages, not just the tracked one.
  // This guards against orphaned drafts from reconnects or message_history merges.
  const store = useStore.getState();
  const existing = store.messages.get(sessionId) || [];
  const next = existing.filter((m) => !m.isStreaming);
  if (next.length !== existing.length) {
    store.setMessages(sessionId, next);
  }
}

function nextClientMsgId(): string {
  return `cmsg-${Date.now()}-${++clientMsgCounter}`;
}

export function createClientMessageId(): string {
  return nextClientMsgId();
}

const IDEMPOTENT_OUTGOING_TYPES = new Set<BrowserOutgoingMessage["type"]>([
  "user_message",
  "permission_response",
  "interrupt",
  "set_model",
  "set_permission_mode",
  "mcp_get_status",
  "mcp_toggle",
  "mcp_reconnect",
  "mcp_set_servers",
  "set_ai_validation",
]);

/**
 * A stable, anonymous per-browser id persisted in localStorage. Sent on every
 * browser WS connect so the server can dedupe "one human with N sessions open"
 * (N sockets) down to a single presence headcount. Carries no PII — a random
 * UUID scoped to this browser profile. Survives reloads; a fresh profile or a
 * cleared storage simply starts a new anonymous id.
 */
function getClientId(): string {
  const KEY = "companion_client_id";
  try {
    let id = localStorage.getItem(KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    // Storage unavailable (private mode / disabled) — fall back to an ephemeral
    // id so the socket still connects; it just won't dedupe across reloads.
    return "eph-" + Math.random().toString(36).slice(2);
  }
}

function getWsUrl(sessionId: string): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const token = localStorage.getItem("companion_auth_token") || "";
  const clientId = getClientId();
  return `${proto}//${location.host}/ws/browser/${sessionId}?token=${encodeURIComponent(token)}&clientId=${encodeURIComponent(clientId)}`;
}

function getLastSeqStorageKey(sessionId: string): string {
  return `companion:last-seq:${sessionId}`;
}

function getLastSeq(sessionId: string): number {
  const cached = lastSeqBySession.get(sessionId);
  if (typeof cached === "number") return cached;
  try {
    const raw = localStorage.getItem(getLastSeqStorageKey(sessionId));
    const parsed = raw ? Number(raw) : 0;
    const normalized = Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
    lastSeqBySession.set(sessionId, normalized);
    return normalized;
  } catch {
    return 0;
  }
}

function setLastSeq(sessionId: string, seq: number): void {
  const normalized = Math.max(0, Math.floor(seq));
  lastSeqBySession.set(sessionId, normalized);
  try {
    localStorage.setItem(getLastSeqStorageKey(sessionId), String(normalized));
  } catch {
    // ignore storage errors
  }
}

function ackSeq(sessionId: string, seq: number): void {
  sendToSession(sessionId, { type: "session_ack", last_seq: seq });
}

function extractTextFromBlocks(blocks: ContentBlock[]): string {
  return blocks
    .map((b) => {
      if (b.type === "text") return b.text;
      if (b.type === "thinking") return b.thinking;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/** Stable dedup key for a content block — ignores mutable metadata like `signature`. */
function contentBlockKey(block: ContentBlock): string {
  if (block.type === "thinking") return `thinking:${block.thinking}`;
  if (block.type === "text") return `text:${block.text}`;
  if (block.type === "tool_use") return `tool_use:${block.id}`;
  if (block.type === "tool_result") return `tool_result:${block.tool_use_id}`;
  return JSON.stringify(block);
}

function mergeContentBlocks(prev?: ContentBlock[], next?: ContentBlock[]): ContentBlock[] | undefined {
  const prevBlocks = prev || [];
  const nextBlocks = next || [];
  if (prevBlocks.length === 0 && nextBlocks.length === 0) return undefined;

  // Build a map of next blocks for in-place replacement of matching prev blocks.
  const nextByKey = new Map<string, ContentBlock>();
  for (const block of nextBlocks) {
    nextByKey.set(contentBlockKey(block), block);
  }

  const merged: ContentBlock[] = [];
  const seen = new Set<string>();

  // Prev blocks first (preserves chronological order), replaced by next if matching.
  for (const block of prevBlocks) {
    const key = contentBlockKey(block);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(nextByKey.get(key) || block);
  }
  // Append any next blocks not already covered by prev.
  for (const block of nextBlocks) {
    const key = contentBlockKey(block);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(block);
  }
  return merged;
}

function buildToolActivityEntry(
  toolUseId: string,
  toolName: string,
  input: Record<string, unknown>,
  startedAt: number,
  parentToolUseId?: string | null,
): ToolActivityEntry {
  return {
    toolUseId,
    toolName,
    preview: getPreview(toolName, input),
    startedAt,
    elapsedSeconds: 0,
    isError: false,
    parentToolUseId: parentToolUseId || undefined,
  };
}

function mergeAssistantMessage(previous: ChatMessage, incoming: ChatMessage): ChatMessage {
  const mergedBlocks = mergeContentBlocks(previous.contentBlocks, incoming.contentBlocks);
  const mergedContent = mergedBlocks && mergedBlocks.length > 0
    ? extractTextFromBlocks(mergedBlocks)
    : (incoming.content || previous.content);

  return {
    ...previous,
    ...incoming,
    content: mergedContent,
    contentBlocks: mergedBlocks,
    // Keep the original timestamp position when this is an in-place assistant update.
    timestamp: previous.timestamp ?? incoming.timestamp,
    // Explicitly clear stale streaming marker when incoming is final.
    isStreaming: incoming.isStreaming,
  };
}

function upsertAssistantMessage(sessionId: string, incoming: ChatMessage) {
  const store = useStore.getState();
  const existing = store.messages.get(sessionId) || [];
  const index = existing.findIndex((m) => m.role === "assistant" && m.id === incoming.id);
  if (index === -1) {
    store.appendMessage(sessionId, incoming);
    return;
  }

  const messages = [...existing];
  messages[index] = mergeAssistantMessage(messages[index], incoming);
  store.setMessages(sessionId, messages);
}

/**
 * Reactive runtime classification (Model Registry Task 6). The Claude CLI
 * accepts `set_model` without validating access, so an unusable model only
 * fails on the first real turn — surfaced here as the `result` frame's
 * `api_error_status`. Map that status onto a closed enum of failure reasons.
 * An unrecognised status returns `null` → today's behaviour (settle the
 * in-flight marker, no revert).
 */
export type ModelRuntimeFailure = "retired" | "blocked" | "overloaded";

export function classifyModelRuntimeError(status: number | undefined): ModelRuntimeFailure | null {
  if (status === 404) return "retired";
  if (status === 403) return "blocked";
  if (status === 429 || (typeof status === "number" && status >= 500 && status <= 599)) return "overloaded";
  return null;
}

/** Human-facing copy per failure reason. Mirrors the proactive-substitution
 * copy (Task 9) so reactive-revert and proactive paths read identically. */
function modelFailureNotice(
  reason: ModelRuntimeFailure,
  model: string | undefined,
  revertedTo: string | null,
): string {
  const named = model ? ` "${model}"` : "";
  const tail = revertedTo ? ` — reverted to "${revertedTo}"` : "";
  switch (reason) {
    case "retired":
      return `Model${named} is unavailable for this session${tail}. Pick a different model from the selector.`;
    case "blocked":
      return `Model${named} is blocked for this session (region or policy)${tail}. Pick a different model from the selector.`;
    case "overloaded":
      return `Model${named} is temporarily overloaded${tail}. Try again shortly or pick a different model.`;
  }
}

/**
 * Drift canary: runtime truth is authoritative over the registry. When a model
 * the registry overlay still considers usable (`active`/`degraded`/unknown —
 * i.e. NOT pre-suppressed) is killed by a runtime error, the proactive gate
 * missed it. Emit a structured log so the gap is visible without changing any
 * control flow. Best-effort: reads the optional registry status carried on the
 * cached model list (Task 7); absent status reads as "active" (= disagreement).
 */
function logRegistryDisagreementIfActive(
  sessionId: string,
  backend: string | undefined,
  model: string | undefined,
  apiErrorStatus: number | undefined,
  classifiedAs: ModelRuntimeFailure,
): void {
  if (!model) return;
  const store = useStore.getState();
  const list = backend === "codex" ? store.dynamicBackendModels.codex : store.dynamicBackendModels.claude;
  const entry = list?.find((m) => m.value === model) as { status?: string } | undefined;
  const registryStatus = entry?.status ?? "active";
  if (registryStatus === "retired" || registryStatus === "blocked") return;
  console.warn("[ws] registry.disagreement", {
    event: "registry.disagreement",
    sessionId,
    backend,
    model,
    apiErrorStatus,
    classifiedAs,
    registryStatus,
  });
}

/**
 * Map the server's proactive-substitution wire reason onto the banner's
 * runtime-failure enum (Task 9). `substituted` always carries a suppression
 * status; the `overloaded` arm exists only for parity with the reactive copy
 * and is never produced by the proactive gate.
 */
function substitutionNoticeReason(reason: string): "retired" | "blocked" | "overloaded" {
  if (reason === "blocked") return "blocked";
  if (reason === "overloaded") return "overloaded";
  return "retired";
}

function handleMessage(sessionId: string, event: MessageEvent) {
  let data: BrowserIncomingMessage;
  try {
    data = JSON.parse(event.data);
  } catch {
    console.warn(`[ws] Failed to parse incoming message for session ${sessionId}:`, event.data?.substring?.(0, 120));
    return;
  }

  // Promote to "connected" on any valid message. A stale close/recovery path can
  // leave the UI marked disconnected even after a replacement socket starts
  // receiving frames; a parseable frame proves the subscription is live.
  const store = useStore.getState();
  if (store.connectionStatus.get(sessionId) !== "connected") {
    store.setConnectionStatus(sessionId, "connected");
  }

  handleParsedMessage(sessionId, data);
}

function handleParsedMessage(
  sessionId: string,
  data: BrowserIncomingMessage,
  options: { processSeq?: boolean; ackSeqMessage?: boolean } = {},
) {
  const { processSeq = true, ackSeqMessage = true } = options;
  const store = useStore.getState();

  if (processSeq && typeof data.seq === "number") {
    const previous = getLastSeq(sessionId);
    if (data.seq <= previous) return;
    setLastSeq(sessionId, data.seq);
    if (ackSeqMessage) {
      ackSeq(sessionId, data.seq);
    }
  }

  switch (data.type) {
    case "session_init": {
      const existingSession = store.sessions.get(sessionId);
      const pendingCodexSwitch = store.pendingCodexModelSwitches.get(sessionId);
      store.addSession(data.session);
      // PLAN T12 (Phase G) - a new CLI subprocess is alive
      // (relaunch landed); clear any prior terminal-failure
      // banner state so the Composer re-enables atomically.
      store.clearCliFailure(sessionId);
      // PLAN T12 (Phase G) - if the user clicked
      // "Start new session with this draft" on a dead session,
      // route the stashed draft into THIS session as a pickup
      // draft. Friedman finding #4 — only a genuinely-NEW session
      // may claim the stash; a reconnect/relaunch's session_init for
      // an already-known session must not silently swallow a draft the
      // user staged for a different new session.
      if (!existingSession) {
        const pendingDraft = store.consumePendingDraftForNextSession();
        if (pendingDraft !== undefined && pendingDraft.length > 0) {
          store.setPickupDraft(sessionId, pendingDraft);
        }
      }
      store.setCliConnected(sessionId, true);
      store.setCliReconnecting(sessionId, false);
      if (!existingSession) {
        store.setSessionStatus(sessionId, "idle");
      }
      if (pendingCodexSwitch) {
        if (data.session.model && data.session.model !== pendingCodexSwitch.requestedModel) {
          store.appendMessage(sessionId, {
            id: nextId(),
            role: "system",
            content: `Requested Codex model "${pendingCodexSwitch.requestedModel}" is unavailable. Using "${data.session.model}" instead.`,
            timestamp: Date.now(),
          });
        }
        store.clearPendingCodexModelSwitch(sessionId);
      }
      if (!store.sessionNames.has(sessionId)) {
        const existingNames = new Set(store.sessionNames.values());
        const name = generateUniqueSessionName(existingNames);
        store.setSessionName(sessionId, name);
      }
      break;
    }

    case "session_update": {
      store.updateSession(sessionId, data.session);
      break;
    }

    case "model_substitution": {
      // Model Registry Task 9 — the server's proactive pre-send gate (Claude
      // only) decided about an outgoing `set_model` BEFORE any frame crossed
      // the wire. ModelSwitcher already wrote the requested model optimistically
      // and seeded a single in-flight marker; reconcile the display + that SAME
      // marker against the server's decision (never seed a second — EC-41).
      const subBackend = store.sdkSessions.find((s) => s.sessionId === sessionId)?.backendType;
      const pendingSwitch = store.pendingClaudeModelSwitches.get(sessionId);
      const previousModel = pendingSwitch?.previousModel ?? store.sessions.get(sessionId)?.model ?? "";

      const applyOptimisticModel = (model: string) => {
        store.updateSession(sessionId, { model });
        store.setSdkSessions(
          store.sdkSessions.map((sdk) =>
            sdk.sessionId === sessionId ? { ...sdk, model } : sdk,
          ),
        );
      };

      switch (data.outcome) {
        case "substituted": {
          // The server already sent `set_model` to `applied`. Move the
          // optimistic display off the (retired/blocked) requested id onto the
          // model actually running, and re-point the existing marker at
          // `applied` (Map overwrite — same key, not a second marker) so a
          // later runtime failure reverts to the correct previous model.
          if (data.applied) {
            applyOptimisticModel(data.applied);
            store.setPendingClaudeModelSwitch(sessionId, data.applied, previousModel);
            store.setModelSubstitutionNotice(sessionId, {
              requested: data.requested,
              applied: data.applied,
              reason: substitutionNoticeReason(data.reason),
            });
          }
          break;
        }
        case "needs-user-action": {
          // Cross-tier swap — never silent (it changes cost). The server sent
          // NO frame, so roll the optimistic switch back to the previous model
          // and clear the in-flight marker (nothing is actually in flight),
          // then hold the proposal for an explicit confirmation dialog. The
          // proposed replacement is the requested model's registry replacement,
          // carried on the frontend catalog (Task 7).
          store.clearPendingClaudeModelSwitch(sessionId);
          if (previousModel) applyOptimisticModel(previousModel);
          const list =
            subBackend === "codex"
              ? store.dynamicBackendModels.codex
              : store.dynamicBackendModels.claude;
          const replacement = list?.find((m) => m.value === data.requested)?.replacement ?? null;
          if (replacement) {
            store.setPendingCrossTierSwitch(sessionId, {
              requested: data.requested,
              replacement,
              previousModel,
            });
          }
          break;
        }
        case "unavailable": {
          // No usable replacement — keep the current model. Roll the optimistic
          // switch back, clear the marker, and surface a single system message
          // (same channel + phrasing as the reactive-revert path).
          store.clearPendingClaudeModelSwitch(sessionId);
          if (previousModel) applyOptimisticModel(previousModel);
          const unavailableNotice = `Model "${data.requested}" is unavailable for this session — keeping the current model. Pick a different model from the selector.`;
          store.appendMessage(sessionId, {
            id: nextId(),
            role: "system",
            content: unavailableNotice,
            timestamp: Date.now(),
          });
          // Task 10: the system message renders in MessageFeed (no live region),
          // so announce it through the dedicated polite region. (`substituted`
          // is NOT announced here — the ModelFallbackBanner's own role="status"
          // already speaks it; double-announcing would be a P2 over-announce.)
          store.announceModelAvailability(sessionId, unavailableNotice);
          break;
        }
      }
      break;
    }

    case "assistant": {
      const msg = data.message;
      const textContent = extractTextFromBlocks(msg.content);
      const chatMsg: ChatMessage = {
        id: msg.id,
        role: "assistant",
        content: textContent,
        contentBlocks: msg.content,
        timestamp: data.timestamp || Date.now(),
        parentToolUseId: data.parent_tool_use_id,
        model: msg.model,
        stopReason: msg.stop_reason,
        streamStatus: data.streamStatus,
      };
      // Clear any streaming draft first, then upsert the real message.
      // Using clearStreamingDraftMessage + upsertAssistantMessage instead of
      // finalizeStreamingDraftMessage avoids duplicates when the CLI sends
      // multiple assistant messages for the same turn (e.g. thinking → text →
      // tool_use) and streaming deltas create new drafts between them.
      clearStreamingDraftMessage(sessionId);
      upsertAssistantMessage(sessionId, chatMsg);
      store.setStreaming(sessionId, null);
      streamingPhaseBySession.delete(sessionId);
      // Reset streaming text accumulators so subsequent deltas in the same
      // turn don't re-show content that was already committed in the real
      // assistant message (prevents the "3-4 duplicate lines" streaming bug).
      streamingBlocksBySession.delete(sessionId);
      // Clear progress only for completed tools (tool_result blocks), not all tools.
      // Blanket clear would cause flickering during concurrent tool execution.
      if (msg.content?.length) {
        for (const block of msg.content) {
          if (block.type === "tool_result") {
            store.clearToolProgress(sessionId, block.tool_use_id);
          }
        }
      }
      store.setSessionStatus(sessionId, "running");

      // Start timer if not already started (for non-streaming tool calls)
      if (!store.streamingStartedAt.has(sessionId)) {
        store.setStreamingStats(sessionId, { startedAt: Date.now() });
      }

      // Track tool activity for execution timeline
      if (msg.content?.length) {
        for (const block of msg.content) {
          if (block.type === "tool_use") {
            const input = (block as { input?: Record<string, unknown> }).input || {};
            store.addToolActivity(sessionId, buildToolActivityEntry(
              block.id,
              block.name,
              input,
              data.timestamp || Date.now(),
              data.parent_tool_use_id,
            ));
          }
          if (block.type === "tool_result") {
            store.updateToolActivity(sessionId, block.tool_use_id, {
              completedAt: Date.now(),
              isError: Boolean(block.is_error),
            });
          }
        }
      }

      // Extract tasks and changed files from tool_use content blocks
      if (msg.content?.length) {
        extractTasksFromBlocks(sessionId, msg.content);
        extractChangedFilesFromBlocks(sessionId, msg.content);
        extractProcessesFromBlocks(sessionId, msg.content);
      }

      break;
    }

    case "stream_event": {
      const evt = data.event as Record<string, unknown>;
      if (evt && typeof evt === "object") {
        // message_start → mark generation start time
        if (evt.type === "message_start") {
          streamingPhaseBySession.delete(sessionId);
          streamingBlocksBySession.delete(sessionId);
          clearStreamingDraftMessage(sessionId);
          if (!store.streamingStartedAt.has(sessionId)) {
            store.setStreamingStats(sessionId, { startedAt: Date.now(), outputTokens: 0 });
          }
        }

        // content_block_delta → accumulate streaming text
        if (evt.type === "content_block_delta") {
          const delta = evt.delta as Record<string, unknown> | undefined;
          if (delta?.type === "text_delta" && typeof delta.text === "string") {
            const parts = streamingBlocksBySession.get(sessionId) || { thinking: "", text: "" };
            // Reset thinking accumulator on phase transition so that if
            // thinking resumes later it starts fresh (avoids showing stale
            // concatenated thinking from a previous block).
            if (streamingPhaseBySession.get(sessionId) === "thinking") {
              parts.thinking = "";
            }
            parts.text += delta.text;
            streamingBlocksBySession.set(sessionId, parts);
            streamingPhaseBySession.set(sessionId, "text");
            // Show only the response text in the streaming draft
            store.setStreaming(sessionId, parts.text);
            setStreamingDraftMessage(sessionId, parts.text, "text");
          }
          if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
            const parts = streamingBlocksBySession.get(sessionId) || { thinking: "", text: "" };
            parts.thinking += delta.thinking;
            streamingBlocksBySession.set(sessionId, parts);
            streamingPhaseBySession.set(sessionId, "thinking");
            // Show thinking text directly as faded inline text
            store.setStreaming(sessionId, parts.thinking);
            setStreamingDraftMessage(sessionId, parts.thinking, "thinking");
          }
        }

        // message_delta → extract output token count
        if (evt.type === "message_delta") {
          const usage = (evt as { usage?: { output_tokens?: number } }).usage;
          if (usage?.output_tokens) {
            store.setStreamingStats(sessionId, { outputTokens: usage.output_tokens });
          }
        }
      }
      break;
    }

    case "result": {
      // Flush processed tool IDs at end of turn — deduplication only needed
      // within a single turn. Preserves memory in long-running sessions.
      processedToolUseIds.delete(sessionId);

      const r = data.data;

      // Resolve any in-flight Claude in-session model switch. ModelSwitcher
      // writes the new model optimistically, but the Claude CLI accepts
      // `set_model` WITHOUT validating access — an unusable model only fails
      // here, on the first real turn, as an HTTP error. Classify that status
      // into a closed enum (Task 6) and, on a recognised failure, revert the
      // optimistic label to the last working model so the session stays usable.
      //
      // The classification is gated on `backendType !== "codex"` BEFORE reading
      // `api_error_status` — a Codex session relaunches on switch and carries a
      // different result shape, so its error statuses must never be read here.
      // An unrecognised status leaves `runtimeFailure` null → today's behaviour
      // (settle the marker, no revert).
      const resultBackend = store.sdkSessions.find((s) => s.sessionId === sessionId)?.backendType;
      const runtimeFailure =
        resultBackend !== "codex" && r.is_error ? classifyModelRuntimeError(r.api_error_status) : null;

      const pendingClaudeSwitch = store.pendingClaudeModelSwitches.get(sessionId);
      if (pendingClaudeSwitch) {
        store.clearPendingClaudeModelSwitch(sessionId);
        if (runtimeFailure) {
          const { requestedModel, previousModel } = pendingClaudeSwitch;
          const revertedTo = previousModel && previousModel !== requestedModel ? previousModel : null;
          logRegistryDisagreementIfActive(sessionId, resultBackend, requestedModel, r.api_error_status, runtimeFailure);
          if (revertedTo) {
            sendToSession(sessionId, { type: "set_model", model: revertedTo });
            store.updateSession(sessionId, { model: revertedTo });
            store.setSdkSessions(
              store.sdkSessions.map((sdk) =>
                sdk.sessionId === sessionId ? { ...sdk, model: revertedTo } : sdk,
              ),
            );
          }
          const revertNotice = modelFailureNotice(runtimeFailure, requestedModel, revertedTo);
          store.appendMessage(sessionId, {
            id: nextId(),
            role: "system",
            content: revertNotice,
            timestamp: Date.now(),
          });
          // Task 10: announce the reactive revert through the dedicated polite
          // region — the system message itself reaches no live region.
          store.announceModelAvailability(sessionId, revertNotice);
        }
      } else if (
        runtimeFailure &&
        typeof r.result === "string" &&
        r.result.toLowerCase().includes("model")
      ) {
        // No in-flight switch to revert: the session was LAUNCHED on a model
        // the subscription can't use (dropdown sourced from the API-key
        // /v1/models list; sessions run on OAuth). There is no previous model
        // to fall back to, so surface a clear, non-silent message rather than
        // letting every turn fail in silence. Already Claude-gated via
        // `runtimeFailure`.
        const launchedModel = store.sessions.get(sessionId)?.model;
        logRegistryDisagreementIfActive(sessionId, resultBackend, launchedModel, r.api_error_status, runtimeFailure);
        const launchFailNotice = modelFailureNotice(runtimeFailure, launchedModel, null);
        store.appendMessage(sessionId, {
          id: nextId(),
          role: "system",
          content: launchFailNotice,
          timestamp: Date.now(),
        });
        // Task 10: launched-on-unusable-model has no live region either.
        store.announceModelAvailability(sessionId, launchFailNotice);
      }

      const sessionUpdates: Partial<{ total_cost_usd: number; num_turns: number; context_used_percent: number; total_lines_added: number; total_lines_removed: number }> = {
        total_cost_usd: r.total_cost_usd,
        num_turns: r.num_turns,
      };
      // Forward lines changed if present
      if (typeof r.total_lines_added === "number") {
        sessionUpdates.total_lines_added = r.total_lines_added;
      }
      if (typeof r.total_lines_removed === "number") {
        sessionUpdates.total_lines_removed = r.total_lines_removed;
      }
      // Compute context % from modelUsage if available
      if (r.modelUsage) {
        for (const usage of Object.values(r.modelUsage)) {
          if (usage.contextWindow > 0) {
            const pct = Math.round(
              ((usage.inputTokens + usage.outputTokens) / usage.contextWindow) * 100
            );
            sessionUpdates.context_used_percent = Math.max(0, Math.min(pct, 100));
          }
        }
      }
      store.updateSession(sessionId, sessionUpdates);
      clearStreamingDraftMessage(sessionId);
      store.setStreaming(sessionId, null);
      streamingPhaseBySession.delete(sessionId);
      streamingBlocksBySession.delete(sessionId);
      store.setStreamingStats(sessionId, null);
      store.clearToolProgress(sessionId);
      store.setSessionStatus(sessionId, "idle");
      // Play notification sound if enabled and tab is not focused
      if (!document.hasFocus() && store.notificationSound) {
        playNotificationSound();
      }
      if (!document.hasFocus() && store.notificationDesktop) {
        sendBrowserNotification("Session completed", "Claude finished the task", sessionId);
      }
      if (r.is_error && r.errors?.length) {
        store.appendMessage(sessionId, {
          id: nextId(),
          role: "system",
          content: `Error: ${r.errors.join(", ")}`,
          timestamp: Date.now(),
        });
      }
      break;
    }

    case "permission_request": {
      store.addPermission(sessionId, data.request);
      if (!document.hasFocus() && store.notificationDesktop) {
        const req = data.request;
        sendBrowserNotification(
          "Permission needed",
          `${req.tool_name}: approve or deny`,
          req.request_id,
        );
      }
      // Also extract tasks and changed files from permission requests
      const req = data.request;
      if (req.tool_name && req.input) {
        const permBlocks = [{
          type: "tool_use" as const,
          id: req.tool_use_id,
          name: req.tool_name,
          input: req.input,
        }];
        extractTasksFromBlocks(sessionId, permBlocks);
        extractChangedFilesFromBlocks(sessionId, permBlocks);
        extractProcessesFromBlocks(sessionId, permBlocks);
      }
      break;
    }

    case "permission_cancelled": {
      store.removePermission(sessionId, data.request_id);
      break;
    }

    case "permission_auto_resolved": {
      store.addAiResolvedPermission(sessionId, {
        request: data.request,
        behavior: data.behavior,
        reason: data.reason,
        timestamp: Date.now(),
      });
      break;
    }

    case "tool_progress": {
      store.setToolProgress(sessionId, data.tool_use_id, {
        toolName: data.tool_name,
        elapsedSeconds: data.elapsed_time_seconds,
      });
      // Also update tool activity elapsed time
      store.updateToolActivity(sessionId, data.tool_use_id, {
        elapsedSeconds: data.elapsed_time_seconds,
      });
      break;
    }

    case "tool_use_summary": {
      // For Claude Code, tool_use content blocks in the assistant message
      // already render the tool call via ToolBlock/EditBlock — rendering a
      // duplicate system message would be redundant.
      // For Codex, tool_use blocks may not be present, so we still render.
      const backend = store.sdkSessions.find(
        (s) => s.sessionId === sessionId,
      )?.backendType;
      if (backend === "codex") {
        store.appendMessage(sessionId, {
          id: nextId(),
          role: "system",
          content: data.summary,
          timestamp: Date.now(),
        });
      }
      break;
    }

    case "user_message": {
      store.appendMessage(sessionId, {
        id: data.id || nextId(),
        role: "user",
        content: data.content,
        timestamp: data.timestamp || Date.now(),
      });
      store.clearPromptSuggestions(sessionId);
      break;
    }

    case "system_event": {
      // Update structured process state from task_notification
      if (data.event?.subtype === "task_notification") {
        const { task_id, status, summary: taskSummary } = data.event;
        if (task_id && status) {
          store.updateProcess(sessionId, task_id, {
            status: status as ProcessStatus,
            completedAt: Date.now(),
            summary: taskSummary || undefined,
          });
        }
      }

      const summary = summarizeSystemEvent(data.event);
      if (!summary) break;
      store.appendMessage(sessionId, {
        id: nextId(),
        role: "system",
        content: summary,
        timestamp: data.timestamp || Date.now(),
      });
      break;
    }

    case "status_change": {
      if (data.status === "compacting") {
        store.setSessionStatus(sessionId, "compacting");
      } else {
        store.setSessionStatus(sessionId, data.status);
      }
      break;
    }

    case "auth_status": {
      if (data.error) {
        store.appendMessage(sessionId, {
          id: nextId(),
          role: "system",
          content: `Auth error: ${data.error}`,
          timestamp: Date.now(),
        });
      }
      break;
    }

    case "error": {
      // Phase F WATCHPOINT carry-forward - when this session has a
      // live cli_failed banner, suppress the legacy chat-error
      // message (session-orchestrator.ts:3267 and :3302 fire
      // legacy "Session keeps crashing" alongside session:relaunch-exhausted).
      if (store.cliFailures.has(sessionId)) break;
      store.appendMessage(sessionId, {
        id: nextId(),
        role: "system",
        content: data.message,
        timestamp: Date.now(),
      });
      break;
    }

    case "session_phase": {
      const phase = data.phase;
      if (phase === "terminated") {
        store.setCliConnected(sessionId, false);
        store.setCliReconnecting(sessionId, false);
        store.setSessionStatus(sessionId, null);
      } else if (phase === "reconnecting") {
        store.setCliConnected(sessionId, false);
        store.setCliReconnecting(sessionId, true);
        store.setSessionStatus(sessionId, null);
      } else if (phase === "starting" || phase === "initializing") {
        store.setCliConnected(sessionId, false);
        store.setCliReconnecting(sessionId, true);
      } else {
        store.setCliConnected(sessionId, true);
        store.setCliReconnecting(sessionId, false);
        if (phase === "ready") store.setSessionStatus(sessionId, "idle");
        else if (phase === "streaming") store.setSessionStatus(sessionId, "running");
        else if (phase === "compacting") store.setSessionStatus(sessionId, "compacting");
        else if (phase === "awaiting_permission") store.setSessionStatus(sessionId, "running");
      }
      break;
    }

    case "cli_disconnected": {
      store.setCliConnected(sessionId, false);
      store.setCliReconnecting(sessionId, false);
      store.setSessionStatus(sessionId, null);
      break;
    }

    case "cli_connected": {
      store.setCliConnected(sessionId, true);
      store.setCliReconnecting(sessionId, false);
      break;
    }

    case "cli_failed": {
      // PLAN T12 (Phase G) - terminal CLI failure landed on this
      // session. Population into the cli-status-slice flips the
      // ChatView priority chain to the CliFailedBanner slot AND
      // disables the Composer submit path.
      //
      // Friedman R10 - clear all in-flight visual indicators
      // atomically on banner mount so the user sees one terminal
      // state, not banner + spinner + streaming-dots + optimistic
      // bubble all at once. The spinner state lives across multiple
      // store fields (streaming, streamingStats, sessionStatus,
      // toolProgress, cliConnected); drain ALL of them here so the
      // store transition itself is the atomic frame.
      store.setCliFailure(sessionId, {
        reason: data.reason,
        drainedCount: data.drainedCount,
        subprocessAlive: data.subprocessAlive,
        firedAt: data.firedAt,
        ...(data.details?.lastErrorSha256 !== undefined
          ? { lastErrorSha256: data.details.lastErrorSha256 }
          : {}),
      });
      store.clearPendingCodexModelSwitch(sessionId);
      store.setCliConnected(sessionId, false);
      store.setCliReconnecting(sessionId, false);
      store.setSessionStatus(sessionId, null);
      store.setStreaming(sessionId, null);
      store.setStreamingStats(sessionId, null);
      store.clearToolProgress(sessionId);
      // Finding #5 — a permission pending when the CLI dies must be cleared,
      // or it outranks the CliFailedBanner in the single-slot priority chain
      // and hides the terminal banner behind an un-answerable approval. The
      // most common way a CLI dies is mid-tool-call, which is exactly the
      // state that leaves a permission pending — so this is common, not edge.
      store.clearPendingPermissions(sessionId);
      break;
    }

    case "session_evicted": {
      // Realtime finding #1 — the server evicted this archived session from
      // memory after archive. Drop the live bridge row so the UI stops
      // treating it as active; unlike `cli_disconnected` this does NOT request
      // a relaunch. The session remains in the archived list (REST-sourced
      // `sdkSessions`); a reconnect is refused server-side by the resurrection
      // guard, so the client simply stops here.
      store.setCliConnected(sessionId, false);
      store.setCliReconnecting(sessionId, false);
      store.setSessionStatus(sessionId, null);
      // Council review P2 #3: an evicted session is terminal — no
      // `session_init` or `cli_failed` will follow to clear an in-flight
      // Codex model switch, so the ModelSwitcher would be stuck rendering
      // "Restarting to X" forever. Clear it here.
      //
      // NOTE: we deliberately do NOT clear on `session_phase: terminated`
      // or `cli_disconnected` — both fire transiently during EVERY normal
      // model-switch relaunch (old proc exit drives the SM to `terminated`;
      // the old backend adapter dropping broadcasts `cli_disconnected`).
      // The pending switch must survive those so the eventual `session_init`
      // can surface the fallback-model system message. Permanent failure on
      // those paths self-heals via `cli_failed` (relaunch-exhausted), which
      // already clears the pending switch.
      store.clearPendingCodexModelSwitch(sessionId);
      store.removeBridgeSession(sessionId);
      break;
    }

    case "session_name_update": {
      // Only apply auto-name if user hasn't manually renamed (still has random Adj+Noun name)
      const currentName = store.sessionNames.get(sessionId);
      const isRandomName = currentName && /^[A-Z][a-z]+ [A-Z][a-z]+$/.test(currentName);
      if (!currentName || isRandomName) {
        store.setSessionName(sessionId, data.name);
        store.markRecentlyRenamed(sessionId);
      }
      break;
    }

    case "pr_status_update": {
      store.setPRStatus(sessionId, { available: data.available, pr: data.pr });
      break;
    }

    case "mcp_status": {
      store.setMcpServers(sessionId, data.servers);
      break;
    }

    case "message_history": {
      const chatMessages: ChatMessage[] = [];
      const toolActivityById = new Map<string, ToolActivityEntry>();
      for (let i = 0; i < data.messages.length; i++) {
        const histMsg = data.messages[i];
        if (histMsg.type === "user_message") {
          chatMessages.push({
            id: histMsg.id || nextId(),
            role: "user",
            content: histMsg.content,
            timestamp: histMsg.timestamp,
          });
        } else if (histMsg.type === "assistant") {
          const msg = histMsg.message;
          const textContent = extractTextFromBlocks(msg.content);
          const assistantMsg: ChatMessage = {
            id: msg.id,
            role: "assistant",
            content: textContent,
            contentBlocks: msg.content,
            timestamp: histMsg.timestamp || Date.now(),
            parentToolUseId: histMsg.parent_tool_use_id,
            model: msg.model,
            stopReason: msg.stop_reason,
            streamStatus: histMsg.streamStatus,
          };
          const existingIndex = chatMessages.findIndex((m) => m.role === "assistant" && m.id === assistantMsg.id);
          if (existingIndex === -1) {
            chatMessages.push(assistantMsg);
          } else {
            chatMessages[existingIndex] = mergeAssistantMessage(chatMessages[existingIndex], assistantMsg);
          }
          // Also extract tasks, changed files, and background processes from history
          if (msg.content?.length) {
            const baseTimestamp = histMsg.timestamp || Date.now();
            extractTasksFromBlocks(sessionId, msg.content, baseTimestamp);
            extractChangedFilesFromBlocks(sessionId, msg.content);
            extractProcessesFromBlocks(sessionId, msg.content);
            for (const block of msg.content) {
              if (block.type === "tool_use") {
                const input = (block as { input?: Record<string, unknown> }).input || {};
                const existing = toolActivityById.get(block.id);
                toolActivityById.set(
                  block.id,
                  existing ?? buildToolActivityEntry(
                    block.id,
                    block.name,
                    input,
                    baseTimestamp,
                    histMsg.parent_tool_use_id,
                  ),
                );
              }
              if (block.type === "tool_result") {
                const existing = toolActivityById.get(block.tool_use_id);
                if (existing) {
                  toolActivityById.set(block.tool_use_id, {
                    ...existing,
                    completedAt: baseTimestamp,
                    isError: existing.isError || Boolean(block.is_error),
                    elapsedSeconds: Math.max(
                      existing.elapsedSeconds,
                      existing.completedAt ? existing.elapsedSeconds : Math.max(0, (baseTimestamp - existing.startedAt) / 1000),
                    ),
                  });
                }
              }
            }
          }
        } else if (histMsg.type === "result") {
          const r = histMsg.data;
          if (r.is_error && r.errors?.length) {
            chatMessages.push({
              id: `hist-error-${i}`,
              role: "system",
              content: `Error: ${r.errors.join(", ")}`,
              timestamp: Date.now(),
            });
          }
          // Track cost/turns from history result, same as the live result handler
          const resultUpdates: Partial<{ total_cost_usd: number; num_turns: number; context_used_percent: number; total_lines_added: number; total_lines_removed: number }> = {
            total_cost_usd: r.total_cost_usd,
            num_turns: r.num_turns,
          };
          if (typeof r.total_lines_added === "number") {
            resultUpdates.total_lines_added = r.total_lines_added;
          }
          if (typeof r.total_lines_removed === "number") {
            resultUpdates.total_lines_removed = r.total_lines_removed;
          }
          if (r.modelUsage) {
            for (const usage of Object.values(r.modelUsage)) {
              if ((usage as { contextWindow: number; inputTokens: number; outputTokens: number }).contextWindow > 0) {
                const u = usage as { contextWindow: number; inputTokens: number; outputTokens: number };
                const pct = Math.round(((u.inputTokens + u.outputTokens) / u.contextWindow) * 100);
                resultUpdates.context_used_percent = Math.max(0, Math.min(pct, 100));
              }
            }
          }
          store.updateSession(sessionId, resultUpdates);
        } else if (histMsg.type === "system_event") {
          const summary = summarizeSystemEvent(histMsg.event);
          if (!summary) continue;
          chatMessages.push({
            id: `hist-system-event-${i}`,
            role: "system",
            content: summary,
            timestamp: histMsg.timestamp || Date.now(),
          });
        }
      }
      if (chatMessages.length > 0) {
        const existing = store.messages.get(sessionId) || [];
        if (existing.length === 0) {
          // Initial connect: history is the full truth
          store.setMessages(sessionId, chatMessages);
        } else {
          // Reconnect: merge history with live messages, upserting duplicate assistant IDs.
          const merged = [...existing];
          for (const incoming of chatMessages) {
            const idx = merged.findIndex((m) => m.id === incoming.id);
            if (idx === -1) {
              merged.push(incoming);
              continue;
            }
            const current = merged[idx];
            if (current.role === "assistant" && incoming.role === "assistant") {
              merged[idx] = mergeAssistantMessage(current, incoming);
            } else {
              merged[idx] = incoming;
            }
          }
          merged.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
          store.setMessages(sessionId, merged);
        }
      }
      store.setToolActivity(sessionId, Array.from(toolActivityById.values()).sort((a, b) => a.startedAt - b.startedAt));
      // Fix: if the last history message is a `result`, the session's last turn
      // is complete. Clear any stale streaming state that event_replay might not
      // correct (e.g. when `result` was pruned from the 600-event buffer).
      const lastHistMsg = data.messages[data.messages.length - 1];
      if (lastHistMsg?.type === "result") {
        clearStreamingDraftMessage(sessionId);
        store.setStreaming(sessionId, null);
        streamingPhaseBySession.delete(sessionId);
        streamingBlocksBySession.delete(sessionId);
        store.setStreamingStats(sessionId, null);
        store.clearToolProgress(sessionId);
        store.setSessionStatus(sessionId, "idle");
      }
      break;
    }

    case "keep_alive": {
      // Server-side heartbeat — keeps mobile/proxy connections from idling out.
      // No state change needed; arrival itself counts as proof the socket is alive.
      break;
    }

    case "event_replay": {
      let latestProcessed: number | undefined;
      for (const evt of data.events) {
        const previous = getLastSeq(sessionId);
        if (evt.seq <= previous) continue;
        setLastSeq(sessionId, evt.seq);
        latestProcessed = evt.seq;
        handleParsedMessage(
          sessionId,
          evt.message as BrowserIncomingMessage,
          { processSeq: false, ackSeqMessage: false },
        );
      }
      if (typeof latestProcessed === "number") {
        ackSeq(sessionId, latestProcessed);
      }
      break;
    }

    case "prompt_suggestion": {
      const suggestions = (data as BrowserIncomingMessage & { type: "prompt_suggestion"; suggestions: string[] }).suggestions;
      store.setPromptSuggestions(sessionId, suggestions);
      break;
    }

    case "streamlined_text": {
      store.appendMessage(sessionId, {
        id: nextId(),
        role: "assistant",
        content: data.text,
        timestamp: Date.now(),
      });
      break;
    }

    case "streamlined_tool_use_summary": {
      // Streamlined mode emits summary-only tool activity instead of the richer
      // assistant/tool_use_summary flow, so surface it as a system message.
      store.appendMessage(sessionId, {
        id: nextId(),
        role: "system",
        content: data.tool_summary,
        timestamp: Date.now(),
      });
      break;
    }

    case "group_created": {
      store.upsertGroup({
        sessionGroupId: data.sessionGroupId,
        primarySessionId: data.primarySessionId,
        observerSessionId: data.observerSessionId,
        // PR #68: server now publishes the live coordinator status via
        // the shared `buildBrowserGroupRecord` helper. Both the live push
        // and the REST bootstrap (`GET /api/groups`) go through this
        // variant, so a reload mid-`degraded` or mid-`reconnecting` pair
        // hydrates with the true status instead of the legacy hardcoded
        // `"active"`.
        //
        // The `?? "active"` fallback is a LEGACY-REPLAY SAFETY NET — NOT
        // dead code. The session event buffer is persisted to disk
        // (`session-store.ts:39 — eventBuffer?: BufferedBrowserEvent[]`)
        // and rehydrated on server restart. A pre-PR-#68 server that
        // buffered a `group_created` frame, then upgrades onto this PR,
        // will replay that legacy frame (no `status` field) to a
        // reconnecting browser inside an `event_replay` envelope. The
        // wire variant is correspondingly optional on `status` to keep
        // the type contract truthful across the upgrade window. Future
        // cleanup MUST NOT delete this fallback while persisted event
        // buffers from older server versions might still exist.
        status: data.status ?? "active",
        pairing: data.pairing,
        // #9: server carries the dead half on a degraded-on-arrival
        // bootstrap snapshot so the deriver labels the correct half
        // instead of falling back to `deadRole ?? "observer"`.
        deadRole: data.deadRole,
        degradedReason: data.degradedReason,
        // Task 9: server-published wake-to-review timeout. The panel-
        // state deriver (Task 11) bounds the `reviewing` interval by
        // `lastCheckpointAt + wakeTimeoutMs`; past that, fall through
        // to `reviewing-stalled`.
        wakeTimeoutMs: data.wakeTimeoutMs,
      });
      // Bootstrap historical findings from REST. Without this, a tab
      // connecting / reloading after the live `group:review` event has
      // no way to discover the findings — UI stuck on "Awaiting first
      // checkpoint" even with review files on disk. Closes
      // `feedback_aura_observer_panel_no_rest_bootstrap`. Idempotent —
      // findings dedup by deterministic id so live WS events converge
      // with REST-bootstrapped findings without double-render.
      import("./api.js").then(({ api }) => {
        api.fetchGroupFindings(data.sessionGroupId).then((res) => {
          if (res.reviewCount === 0) return; // nothing to bootstrap
          // Bootstrap calls appendObserverReview with a synthetic
          // checkpoint envelope per review — slice already dedups by
          // finding id, so re-arrival on next live event is a no-op.
          store.appendObserverReview({
            sessionGroupId: res.sessionGroupId,
            checkpointId: "rest-bootstrap", // synthetic — real checkpoint ids carried inside finding ids
            phase: "rest-bootstrap",
            findings: res.findings,
            downgrades: res.downgrades,
            observerModel: res.observerModel ?? "",
            observerProvider: res.observerProvider ?? "",
            timestamp: Date.now(),
          });
        }).catch((err) => {
          // REST bootstrap is best-effort — live WS events still arrive.
          // Log structurally for forensic; don't disturb panel state.
          console.warn("[ws] fetchGroupFindings bootstrap failed", {
            sessionGroupId: data.sessionGroupId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      });
      break;
    }

    case "group_exited": {
      store.removeGroup(data.sessionGroupId);
      break;
    }

    case "group_degraded": {
      store.setGroupStatus(data.sessionGroupId, "degraded", { deadRole: data.deadRole, reason: data.reason });
      break;
    }

    // PLAN Task 9: light up the previously-unreachable ObserverPanel
    // `reconnecting` branch. The pill render code in
    // `components/council/ObserverPanel.tsx` + the priority ladder in
    // `observer-panel-state.ts` already support this status; this case
    // is the missing dispatch that makes it reachable in production.
    //
    // `deadlineMs` is intentionally dropped on the floor — per React
    // expert recommendation, no consumer reads it today; storing it
    // would become a stale field on the next active flip. When/if a
    // countdown UI ships, plumb in the same commit as its renderer.
    case "group_reconnecting": {
      store.setGroupStatus(data.sessionGroupId, "reconnecting");
      break;
    }

    case "group_checkpoint": {
      store.recordCheckpoint({
        sessionGroupId: data.sessionGroupId,
        checkpointId: data.checkpointId,
        phase: data.phase,
        sequence: data.sequence,
        timestamp: data.timestamp,
      });
      break;
    }

    case "observer_review": {
      store.appendObserverReview({
        sessionGroupId: data.sessionGroupId,
        checkpointId: data.checkpointId,
        phase: data.phase,
        findings: data.findings,
        downgrades: data.downgrades,
        observerModel: data.observerModel,
        observerProvider: data.observerProvider,
        timestamp: data.timestamp,
        // Task 9: server-reported checkpoint ids dropped by the mid-
        // turn queue between previous review and this one. Slice uses
        // this to flip the panel into `queued-dropped` state.
        ...(data.supersededCheckpointIds !== undefined
          ? { supersededCheckpointIds: data.supersededCheckpointIds }
          : {}),
      });
      break;
    }

    case "group_convergence": {
      // Bidirectional pipeline Story 4.1 — server-authoritative convergence
      // state. Frontend stores cycleNumber / threshold / convergenceState
      // on the GroupRecord; ObserverPanel + Sidebar badges read off it.
      store.applyConvergence({
        sessionGroupId: data.sessionGroupId,
        cycleNumber: data.cycleNumber,
        convergenceThreshold: data.convergenceThreshold,
        convergenceState: data.convergenceState,
      });
      break;
    }

    default: {
      console.debug("[ws] Unhandled message type:", (data as { type: string }).type);
      break;
    }
  }
}

export function connectSession(sessionId: string) {
  const existing = sockets.get(sessionId);
  if (isSocketUsable(existing)) return;
  if (existing) {
    try { existing.close(); } catch {}
    sockets.delete(sessionId);
  }

  const store = useStore.getState();
  store.setConnectionStatus(sessionId, "connecting");

  const ws = new WebSocket(getWsUrl(sessionId));
  sockets.set(sessionId, ws);

  ws.onopen = () => {
    // Stay in "connecting" until we receive the first message from the server,
    // proving the subscription succeeded. handleMessage promotes to "connected".
    const lastSeq = getLastSeq(sessionId);
    ws.send(JSON.stringify({ type: "session_subscribe", last_seq: lastSeq }));
    flushQueuedOutgoing(sessionId, ws);
    // Clear any reconnect timer (defensive — usually already cleared by
    // the timer-callback itself before it called connectSession).
    const timer = reconnectTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      reconnectTimers.delete(sessionId);
    }
    // If this session was mid-reconnect (flag set in onclose), schedule
    // a Council Mode group refetch — closes PR #68 friedman finding
    // (silent fetchGroups failure on initial mount has no user-
    // discoverable recovery; pair the refetch with every WS reconnect,
    // the strongest correlated signal that the original bootstrap may
    // have failed in the same network blip). Using a dedicated Set
    // rather than `reconnectTimers.has` because the timer is deleted
    // before connectSession runs — see reconnectingSessions JSDoc.
    const wasReconnect = reconnectingSessions.has(sessionId);
    reconnectingSessions.delete(sessionId);
    if (wasReconnect) scheduleGroupRefetchAfterReconnect();
  };

  ws.onmessage = (event) => handleMessage(sessionId, event);

  ws.onclose = () => {
    // Guard against stale close events from a replaced socket.
    if (sockets.get(sessionId) !== ws) return;
    sockets.delete(sessionId);
    useStore.getState().setConnectionStatus(sessionId, "disconnected");
    // Mark this session as mid-reconnect BEFORE scheduling the timer.
    // The replacement socket's onopen reads this flag (and clears it)
    // to decide whether to fire the post-reconnect group refetch. We
    // can't rely on `reconnectTimers.has` for that decision because the
    // timer-callback deletes itself before invoking connectSession.
    reconnectingSessions.add(sessionId);
    scheduleReconnect(sessionId);
  };

  ws.onerror = () => {
    ws.close();
  };
}

function scheduleReconnect(sessionId: string) {
  if (reconnectTimers.has(sessionId)) return;
  // Don't schedule reconnect when page is hidden — mobile browsers will just
  // kill the new connection too, creating a wasteful connect/disconnect cycle.
  // The visibilitychange handler will reconnect when the page becomes visible.
  if (pageHidden) return;
  const timer = setTimeout(() => {
    reconnectTimers.delete(sessionId);
    // Re-check visibility — page may have been hidden during the delay
    if (pageHidden) return;
    if (shouldReconnectSession(sessionId)) connectSession(sessionId);
  }, WS_RECONNECT_DELAY_MS);
  reconnectTimers.set(sessionId, timer);
}

export function disconnectSession(sessionId: string) {
  const timer = reconnectTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    reconnectTimers.delete(sessionId);
  }
  reconnectingSessions.delete(sessionId);
  const ws = sockets.get(sessionId);
  if (ws) {
    ws.close();
    sockets.delete(sessionId);
  }
  useStore.getState().setConnectionStatus(sessionId, "disconnected");
  processedToolUseIds.delete(sessionId);
  pendingBackgroundBash.delete(sessionId);
  taskCounters.delete(sessionId);
  streamingPhaseBySession.delete(sessionId);
  streamingDraftMessageIdBySession.delete(sessionId);
  streamingBlocksBySession.delete(sessionId);
  lastSeqBySession.delete(sessionId);
  pendingOutgoingBySession.delete(sessionId);
}

export function disconnectAll() {
  for (const [id] of sockets) {
    disconnectSession(id);
  }
}

export function connectAllSessions(sessions: SdkSessionInfo[]) {
  // Skip connection attempts when page is hidden — mobile browsers kill
  // backgrounded WS connections, so connecting here would just cycle.
  if (pageHidden) return;
  for (const s of sessions) {
    if (!s.archived) {
      connectSession(s.sessionId);
    }
  }
}

export function waitForConnection(sessionId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const check = setInterval(() => {
      const ws = sockets.get(sessionId);
      if (ws?.readyState === WebSocket.OPEN) {
        clearInterval(check);
        clearTimeout(timeout);
        resolve();
      }
    }, 50);
    const timeout = setTimeout(() => {
      clearInterval(check);
      reject(new Error("Connection timeout"));
    }, 10000);
  });
}

export function sendToSession(sessionId: string, msg: BrowserOutgoingMessage) {
  const ws = sockets.get(sessionId);
  let outgoing: BrowserOutgoingMessage = msg;
  const isIdempotent = IDEMPOTENT_OUTGOING_TYPES.has(msg.type);
  if (isIdempotent) {
    switch (msg.type) {
      case "user_message":
      case "permission_response":
      case "interrupt":
      case "set_model":
      case "set_permission_mode":
      case "mcp_get_status":
      case "mcp_toggle":
      case "mcp_reconnect":
      case "mcp_set_servers":
      case "set_ai_validation":
        if (!msg.client_msg_id) {
          outgoing = { ...msg, client_msg_id: nextClientMsgId() };
        }
        break;
    }
  }

  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(outgoing));
    return;
  }

  if (isIdempotent) {
    enqueueOutgoing(sessionId, outgoing);
  }
}

export function sendMcpGetStatus(sessionId: string) {
  sendToSession(sessionId, { type: "mcp_get_status" });
}

export function sendMcpToggle(sessionId: string, serverName: string, enabled: boolean) {
  sendToSession(sessionId, { type: "mcp_toggle", serverName, enabled });
}

export function sendMcpReconnect(sessionId: string, serverName: string) {
  sendToSession(sessionId, { type: "mcp_reconnect", serverName });
}

export function sendMcpSetServers(sessionId: string, servers: Record<string, McpServerConfig>) {
  sendToSession(sessionId, { type: "mcp_set_servers", servers });
}

export function sendSetAiValidation(
  sessionId: string,
  settings: {
    aiValidationEnabled?: boolean | null;
    aiValidationAutoApprove?: boolean | null;
    aiValidationAutoDeny?: boolean | null;
  },
) {
  sendToSession(sessionId, { type: "set_ai_validation", ...settings });
}
