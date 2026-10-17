// Extract a text-only handoff brief from a session's messageHistory.
//
// Background: a session can wedge (a) when its context overflows (multi-MB
// transcript → the CLI stops answering; the context-size advisory offers this
// handoff from 5 MB), or (b) when its conversation history contains a
// >2000px image that trips Anthropic's many-image limit. Every subsequent
// API call resends history → same error → `/compact` itself can't recover
// (it's an API call too). The only recovery is to start a new session, but
// without the prior context the user has to re-establish everything.
//
// This module produces a markdown brief that strips images and trims long
// tool results but preserves user text, assistant text, and a compact view
// of tool calls. The brief is meant to be saved to a file in the workspace
// so the next session can `Read` it on demand without re-loading the
// offending images.
//
// Pure function, no I/O. Hosted server-side because messageHistory lives in
// session JSON on disk and exposing it to the browser as-is would re-pull
// the base64 image payloads we're trying to escape.

import { redactSecretsInText } from "./secret-redaction.js";

const MAX_TOOL_RESULT_CHARS = 400;
const MAX_TOOL_INPUT_CHARS = 160;
const MAX_THINKING_CHARS = 200;

interface ContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  is_error?: boolean;
}

function fmtTime(ts: unknown): string {
  if (typeof ts !== "number") return "??";
  const d = new Date(ts);
  return d.toISOString().slice(11, 19); // HH:MM:SS UTC
}

function trim(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `…[+${s.length - max} chars]`;
}

function blockToText(b: unknown): string | null {
  if (!b || typeof b !== "object") return null;
  const block = b as ContentBlock;
  const t = block.type ?? "";

  if (t === "text") return (block.text ?? "").trimEnd();
  if (t === "image") return "[image stripped]";
  if (t === "tool_use") {
    const name = block.name ?? "?";
    const inputJson = JSON.stringify(block.input ?? {});
    return `→ TOOL ${name}(${trim(inputJson, MAX_TOOL_INPUT_CHARS)})`;
  }
  if (t === "tool_result") {
    let c = block.content;
    let body: string;
    if (Array.isArray(c)) {
      body = c.map(blockToText).filter((x) => x).join("\n");
    } else if (typeof c === "string") {
      body = c;
    } else {
      body = JSON.stringify(c ?? "");
    }
    const prefix = block.is_error ? "← ERR " : "← OK  ";
    return prefix + trim(body.trim(), MAX_TOOL_RESULT_CHARS);
  }
  if (t === "thinking") {
    const th = (block.thinking ?? "").trim();
    return `(thinking: ${trim(th, MAX_THINKING_CHARS)})`;
  }
  return `[${t} block]`;
}

interface HistoryEntry {
  type?: string;
  timestamp?: number;
  content?: unknown;
  message?: { content?: unknown };
  data?: { is_error?: boolean; api_error_status?: unknown; result?: unknown };
  session?: { cwd?: string; model?: string };
  request?: { tool_name?: string };
}

function entryToLines(m: unknown): string[] {
  if (!m || typeof m !== "object") return [];
  const e = m as HistoryEntry;
  const t = e.type;
  const when = fmtTime(e.timestamp);

  if (t === "session_init") {
    const s = e.session ?? {};
    return [`## SESSION INIT  (${when})  cwd=${s.cwd ?? "?"}  model=${s.model ?? "?"}`];
  }

  if (t === "user_message") {
    const c = e.content;
    if (typeof c === "string") return [`### USER  ${when}`, c.trim()];
    if (Array.isArray(c)) {
      const parts = c.map(blockToText).filter((x): x is string => x !== null);
      return [`### USER  ${when}`, ...parts];
    }
    return [`### USER  ${when}`, String(c).slice(0, 200)];
  }

  if (t === "assistant") {
    const content = e.message?.content;
    if (!Array.isArray(content)) {
      return typeof content === "string" ? [`### ASSISTANT  ${when}`, content.trim()] : [];
    }
    const parts = content.map(blockToText).filter((x): x is string => x !== null);
    if (parts.length === 0) return [];
    return [`### ASSISTANT  ${when}`, ...parts];
  }

  if (t === "user") {
    // CLI-side tool_result wrapper
    const content = e.message?.content;
    if (!Array.isArray(content)) return [];
    const parts = content.map(blockToText).filter((x): x is string => x !== null);
    if (parts.length === 0) return [];
    return [`### TOOL_RESULT  ${when}`, ...parts];
  }

  if (t === "permission_request") {
    const tool = e.request?.tool_name ?? "?";
    return [`### PERMISSION_PROMPT  ${when}  tool=${tool}`];
  }

  if (t === "result") {
    const data = e.data;
    if (data?.is_error) {
      const status = data.api_error_status ?? "?";
      const result = typeof data.result === "string" ? data.result : JSON.stringify(data.result ?? "");
      return [`### API_ERROR  ${when}  status=${status}`, trim(result, 300)];
    }
    return [];
  }

  return [];
}

export interface HandoffMeta {
  sessionId: string;
  cwd?: string;
  backend?: string;
  totalMessages: number;
  userTurns: number;
  hasImageError: boolean;
  /** Rendered transcript entries dropped by the head/tail cap (0 = full transcript). */
  omittedMessages: number;
}

export interface HandoffResult {
  markdown: string;
  meta: HandoffMeta;
}

/**
 * Reason codes the browser sends to `POST /sessions/:id/continue-in-new`.
 * Any other string is still accepted and printed verbatim (back-compat with
 * free-text reasons), but only these get tailored copy.
 */
export type HandoffReason = "context_too_large" | "image_limit";

/** How many of the latest user messages go verbatim into "Current task". */
export const CURRENT_TASK_USER_MESSAGES = 5;
/** Per-message cap inside "Current task" (a pasted log must not drown it). */
const MAX_CURRENT_TASK_MESSAGE_CHARS = 8_000;
/**
 * Transcript cap. A >10 MB session renders to a multi-MB brief that a fresh
 * agent can't read in one go, so keep the start (the original ask + setup)
 * and a generous tail (where we stopped), dropping the middle with an
 * explicit marker. Bytes of UTF-8 markdown.
 */
export const DEFAULT_TRANSCRIPT_HEAD_BYTES = 20_000;
export const DEFAULT_TRANSCRIPT_TAIL_BYTES = 200_000;

function describeReason(reason: string | undefined, hasImageError: boolean, contextBytes?: number): string {
  if (reason === "context_too_large") {
    return `prior session's context overflowed${formatMb(contextBytes, " (>", ")")} and it stopped responding reliably`;
  }
  if (reason === "image_limit") return "prior session wedged on Anthropic 2000px multi-image limit";
  if (reason) return reason;
  return hasImageError
    ? "prior session wedged on Anthropic 2000px multi-image limit"
    : "session handoff requested";
}

function formatMb(bytes: number | undefined, prefix: string, suffix: string): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return "";
  const mb = bytes / 1_000_000;
  const text = mb >= 10 ? String(Math.round(mb)) : String(Math.round(mb * 10) / 10);
  return `${prefix}${text} MB${suffix}`;
}

/** Plain text of a user_message entry (string or content blocks). */
function userMessageText(e: HistoryEntry): string {
  const c = e.content;
  if (typeof c === "string") return c.trim();
  if (Array.isArray(c)) {
    return c
      .map(blockToText)
      .filter((x): x is string => x !== null)
      .join("\n")
      .trim();
  }
  return String(c ?? "").slice(0, 200);
}

interface TodoItem {
  content?: unknown;
  status?: unknown;
  activeForm?: unknown;
}

/** The most recent TodoWrite list in history (Claude + Codex both emit it). */
function latestTodoList(messageHistory: unknown[]): { todos: TodoItem[]; timestamp?: number } | null {
  for (let i = messageHistory.length - 1; i >= 0; i--) {
    const m = messageHistory[i];
    if (!m || typeof m !== "object") continue;
    const e = m as HistoryEntry;
    if (e.type !== "assistant" || !Array.isArray(e.message?.content)) continue;
    const blocks = e.message.content as ContentBlock[];
    for (let j = blocks.length - 1; j >= 0; j--) {
      const b = blocks[j];
      if (b?.type !== "tool_use" || b.name !== "TodoWrite") continue;
      const todos = (b.input as { todos?: unknown } | undefined)?.todos;
      if (Array.isArray(todos)) {
        return { todos: todos.filter((t): t is TodoItem => !!t && typeof t === "object"), timestamp: e.timestamp };
      }
    }
  }
  return null;
}

function todoMarker(status: unknown): string {
  if (status === "completed") return "[x]";
  if (status === "in_progress") return "[~]";
  return "[ ]";
}

/**
 * "Current task" — goes at the TOP of the brief so a fresh agent sees the
 * live ask and the plan before wading into the transcript.
 */
function renderCurrentTask(messageHistory: unknown[]): string[] {
  const users = messageHistory.filter(
    (m): m is HistoryEntry => !!m && typeof m === "object" && (m as HistoryEntry).type === "user_message",
  );
  const recent = users.slice(-CURRENT_TASK_USER_MESSAGES);
  const lines: string[] = ["## Current task (read this first)", ""];
  lines.push(`### Latest user messages (last ${recent.length} of ${users.length}, oldest first)`, "");
  if (recent.length === 0) {
    lines.push("_No user messages in this session._", "");
  }
  recent.forEach((e, i) => {
    lines.push(`#### ${i + 1}. ${fmtTime(e.timestamp)}`);
    lines.push(trim(userMessageText(e), MAX_CURRENT_TASK_MESSAGE_CHARS) || "_(empty)_");
    lines.push("");
  });

  const todo = latestTodoList(messageHistory);
  if (todo && todo.todos.length > 0) {
    lines.push(`### Todo list (latest TodoWrite, ${fmtTime(todo.timestamp)})`, "");
    for (const t of todo.todos) {
      const text = typeof t.content === "string" && t.content ? t.content : "Task";
      const status = typeof t.status === "string" ? t.status : "pending";
      lines.push(`- ${todoMarker(t.status)} ${text} (${status})`);
    }
    lines.push("");
  } else {
    lines.push("### Todo list", "", "_No TodoWrite list in this session._", "");
  }
  return lines;
}

/**
 * Keep the first `headBytes` and the last `tailBytes` of rendered chunks,
 * replacing the middle with an explicit omission marker. The last chunk is
 * always kept (it is where the session stopped), even if it alone exceeds
 * the tail budget.
 */
function capTranscript(
  chunks: string[],
  headBytes: number,
  tailBytes: number,
): { chunks: string[]; omitted: number } {
  const sizes = chunks.map((c) => Buffer.byteLength(c, "utf8"));
  const total = sizes.reduce((a, b) => a + b, 0);
  if (total <= headBytes + tailBytes) return { chunks, omitted: 0 };

  let tailStart = chunks.length;
  let tailUsed = 0;
  while (tailStart > 0) {
    const size = sizes[tailStart - 1];
    if (tailStart < chunks.length && tailUsed + size > tailBytes) break;
    tailUsed += size;
    tailStart--;
  }
  let headEnd = 0;
  let headUsed = 0;
  while (headEnd < tailStart && headUsed + sizes[headEnd] <= headBytes) {
    headUsed += sizes[headEnd];
    headEnd++;
  }
  const omitted = tailStart - headEnd;
  if (omitted === 0) return { chunks, omitted: 0 };
  const omittedBytes = sizes.slice(headEnd, tailStart).reduce((a, b) => a + b, 0);
  const marker = `[… ${omitted} messages omitted (~${Math.round(omittedBytes / 1024)} KB) — the start and the latest part of the conversation are kept …]\n`;
  return { chunks: [...chunks.slice(0, headEnd), marker, ...chunks.slice(tailStart)], omitted };
}

export function extractHandoff(args: {
  sessionId: string;
  messageHistory: unknown[];
  cwd?: string;
  backend?: string;
  reason?: string;
  /** Size of the source session's transcript, for the context_too_large reason line. */
  contextBytes?: number;
  /** Transcript head/tail budgets (bytes); defaults suit a fresh agent's Read. */
  transcriptHeadBytes?: number;
  transcriptTailBytes?: number;
}): HandoffResult {
  const {
    sessionId,
    messageHistory,
    cwd,
    backend,
    reason,
    contextBytes,
    transcriptHeadBytes = DEFAULT_TRANSCRIPT_HEAD_BYTES,
    transcriptTailBytes = DEFAULT_TRANSCRIPT_TAIL_BYTES,
  } = args;
  const userTurns = messageHistory.filter(
    (m) => m && typeof m === "object" && (m as HistoryEntry).type === "user_message",
  ).length;
  const hasImageError = messageHistory.some((m) => {
    if (!m || typeof m !== "object") return false;
    const e = m as HistoryEntry;
    if (e.type !== "result") return false;
    const r = e.data?.result;
    return typeof r === "string" && r.includes("dimension limit");
  });

  const reasonLine = describeReason(reason, hasImageError, contextBytes);

  const chunks: string[] = [];
  for (const m of messageHistory) {
    const out = entryToLines(m);
    if (out.length > 0) chunks.push(out.join("\n") + "\n");
  }
  const capped = capTranscript(chunks, transcriptHeadBytes, transcriptTailBytes);

  const lines: string[] = [
    `# Handoff brief — session ${sessionId.slice(0, 8)}`,
    "",
    `Source: \`~/.companion/sessions/${sessionId}.json\` (extracted offline, no API call)`,
    `cwd: ${cwd ?? "?"}  |  backend: ${backend ?? "?"}`,
    `Total messages: ${messageHistory.length} (${userTurns} user turns)`,
    `Reason: ${reasonLine}.`,
    "",
    "---",
    "",
    ...renderCurrentTask(messageHistory),
    "---",
    "",
    capped.omitted > 0
      ? `## Transcript (capped: first ~${Math.round(transcriptHeadBytes / 1000)} KB + last ~${Math.round(transcriptTailBytes / 1000)} KB)`
      : "## Transcript",
    "",
  ];
  for (const chunk of capped.chunks) {
    lines.push(chunk);
  }

  return {
    // The brief is written into the workspace (often git-tracked, 0644), so
    // credentials pasted into chat are masked with the shared policy.
    markdown: redactSecretsInText(lines.join("\n")),
    meta: {
      sessionId,
      cwd,
      backend,
      totalMessages: messageHistory.length,
      userTurns,
      hasImageError,
      omittedMessages: capped.omitted,
    },
  };
}

/**
 * Pickup prompt pre-filled into the new session's composer. Russian, like
 * the rest of the owner-facing recovery copy. The opening line names WHY
 * the previous session was abandoned, so the new agent (and the user) know
 * which failure mode the handoff recovers from.
 */
export function buildPickupDraft(
  handoffFilename: string,
  reason?: string,
  opts: { contextBytes?: number } = {},
): string {
  if (reason === "context_too_large") {
    return [
      `Pickup с прошлой сессии: её контекст переполнился${formatMb(opts.contextBytes, " (>", ")")}, и она перестала нормально отвечать.`,
      "",
      `Прочитай \`${handoffFilename}\` в текущей папке. В начале файла — раздел «Current task»:`,
      "последние сообщения пользователя дословно и актуальный todo-список; дальше — текстовый",
      "дамп беседы (середина длинной истории вырезана с явной пометкой).",
      "",
      "После прочтения дай мне 5-10-строчный summary:",
      "- Где остановились",
      "- Что было следующим шагом",
      "- Какие открытые вопросы я ещё не закрыл",
      "",
      "Потом продолжай задачу с того места, где остановились. Не запускай тяжёлые операции без моего \"go\".",
    ].join("\n");
  }
  const opening = reason === "image_limit"
    ? "Pickup с прошлой сессии (она словила Anthropic 2000px image-limit и зависла)."
    : "Pickup с прошлой сессии.";
  return [
    opening,
    "",
    `Прочитай \`${handoffFilename}\` в текущей папке — это текст-онли дамп`,
    "предыдущей беседы (картинки выкинуты механически, API errors помечены).",
    "",
    "После прочтения дай мне 5-10-строчный summary:",
    "- Где остановились",
    "- Что было следующим шагом",
    "- Какие открытые вопросы я ещё не закрыл",
    "",
    "Только потом продолжаем. Не запускай тяжёлые операции без моего \"go\".",
  ].join("\n");
}
