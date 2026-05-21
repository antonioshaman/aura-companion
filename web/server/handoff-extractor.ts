// Extract a text-only handoff brief from a session's messageHistory.
//
// Background: a session can wedge when its conversation history contains a
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
}

export interface HandoffResult {
  markdown: string;
  meta: HandoffMeta;
}

export function extractHandoff(args: {
  sessionId: string;
  messageHistory: unknown[];
  cwd?: string;
  backend?: string;
  reason?: string;
}): HandoffResult {
  const { sessionId, messageHistory, cwd, backend, reason } = args;
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

  const reasonLine = reason ?? (hasImageError
    ? "prior session wedged on Anthropic 2000px multi-image limit"
    : "session handoff requested");

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
  ];
  for (const m of messageHistory) {
    const out = entryToLines(m);
    if (out.length > 0) {
      lines.push(...out);
      lines.push("");
    }
  }

  return {
    markdown: lines.join("\n"),
    meta: {
      sessionId,
      cwd,
      backend,
      totalMessages: messageHistory.length,
      userTurns,
      hasImageError,
    },
  };
}

export function buildPickupDraft(handoffFilename: string): string {
  return [
    "Pickup с прошлой сессии (она словила Anthropic 2000px image-limit и зависла).",
    "",
    `Прочитай \`${handoffFilename}\` в текущей папке — это полный текст-онли дамп`,
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
