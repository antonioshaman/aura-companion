/**
 * Strict typed parser for Codex JSON-RPC envelopes. Codex frames cross
 * `ws-bridge.ts` into the orchestrator's UI and through `session-store.ts`
 * for replay; a malformed or hostile frame must NOT ride through unparsed.
 *
 * Hunt P4 ("type system as armour"): only frames matching one of the
 * four definite shapes pass. Anything else returns `null` and the caller
 * drops the message — never logs-and-forwards.
 */

const MAX_METHOD_LEN = 128;
const MAX_ERROR_MESSAGE_LEN = 4_000;

/**
 * The four kinds of JSON-RPC envelope this server cares about. Codex
 * uses a subset of JSON-RPC 2.0 — we mirror that subset here.
 */
export type CodexFrame =
  | { kind: "request"; method: string; id: number; params: Record<string, unknown> }
  | { kind: "notification"; method: string; params: Record<string, unknown> }
  | { kind: "result"; id: number; result: unknown }
  | { kind: "error"; id: number; error: { code: number; message: string; data?: unknown } };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * A valid method name is a bounded printable ASCII identifier. We
 * forbid control characters defensively — they have no semantic role
 * in JSON-RPC and a NUL byte poisoning attempt would be caught here.
 */
function isValidMethod(m: unknown): m is string {
  if (typeof m !== "string") return false;
  if (m.length === 0 || m.length > MAX_METHOD_LEN) return false;
  // Reject ASCII control range (0x00..0x1F)
  for (let i = 0; i < m.length; i++) {
    if (m.charCodeAt(i) < 0x20) return false;
  }
  return true;
}

function isValidId(id: unknown): id is number {
  return typeof id === "number" && Number.isInteger(id) && id >= 0;
}

/**
 * Parse one Codex JSON-RPC line. Returns `null` on ANY malformation —
 * invalid JSON, wrong shape, mixed fields (e.g. both `result` and
 * `method` set), unknown control chars in method, oversize message.
 *
 * The discriminated return type lets the caller branch exhaustively.
 */
export function parseCodexFrame(raw: string): CodexFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(parsed)) return null;

  const hasMethod = "method" in parsed;
  const hasResult = "result" in parsed;
  const hasError = "error" in parsed;
  const hasId = "id" in parsed;

  // Request: method + id + params, no result, no error.
  if (hasMethod && hasId && !hasResult && !hasError) {
    if (!isValidMethod(parsed.method)) return null;
    if (!isValidId(parsed.id)) return null;
    if (!isObject(parsed.params)) return null;
    return { kind: "request", method: parsed.method, id: parsed.id, params: parsed.params };
  }

  // Notification: method + params, no id, no result, no error.
  if (hasMethod && !hasId && !hasResult && !hasError) {
    if (!isValidMethod(parsed.method)) return null;
    if (!isObject(parsed.params)) return null;
    return { kind: "notification", method: parsed.method, params: parsed.params };
  }

  // Result: id + result, no method, no error.
  if (hasId && hasResult && !hasMethod && !hasError) {
    if (!isValidId(parsed.id)) return null;
    return { kind: "result", id: parsed.id, result: parsed.result };
  }

  // Error: id + error, no method, no result.
  if (hasId && hasError && !hasMethod && !hasResult) {
    if (!isValidId(parsed.id)) return null;
    if (!isObject(parsed.error)) return null;
    const err = parsed.error;
    if (typeof err.code !== "number" || !Number.isInteger(err.code)) return null;
    if (typeof err.message !== "string" || err.message.length > MAX_ERROR_MESSAGE_LEN) return null;
    return {
      kind: "error",
      id: parsed.id,
      error: { code: err.code, message: err.message, data: err.data },
    };
  }

  // Any other shape (mixed fields, partial, etc.) — reject.
  return null;
}
