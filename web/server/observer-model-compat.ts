import type { BackendType } from "./session-types.js";

// ─── Observer model compatibility ─────────────────────────────────────────
//
// Council Mode passes ONE caller-supplied model name to both halves of a
// pair via `SessionGroupCoordinator.createGroup({ model })`. That works
// for `claude+claude` (both halves accept the model) but breaks for the
// `claude+codex` pairing: the orchestrator is a Claude session whose model
// is something like `claude-opus-4-7`, and the same string flows into the
// Codex observer's `thread/start` call. Codex on a ChatGPT account
// rejects Claude model names with a structured error:
//
//   { type: "invalid_request_error",
//     message: "The 'claude-opus-4-7' model is not supported when using
//               Codex with a ChatGPT account." }
//
// PR #33 wired auto-wake but did not coerce the model on the cross-backend
// boundary, so every `claude+codex` checkpoint dispatches a wake that
// Codex throws away before the observer can read its prompt.
//
// This module is the per-half model coercion: if the caller-supplied
// model is incompatible with the observer's backend, drop it to
// `undefined` and let the backend pick its own default. Coercing to a
// specific Codex model name (`gpt-5-codex`, `o4-mini`, etc.) would couple
// Aura to a snapshot of Codex's accepted-model list that drifts upstream;
// `undefined` defers to the backend's authoritative choice.

/**
 * Return `true` if `model` is a valid pick for `backendType`. `undefined`
 * is always compatible — backends fall back to their own defaults when
 * no model is supplied.
 *
 * Heuristic: model name prefix. Claude backend accepts `claude-*`; Codex
 * accepts anything else (`gpt-*`, `o4-*`, `o5-*`, future model families
 * Codex adds upstream). This is a one-way gate — it rejects obvious
 * cross-backend leaks (the bug we're fixing) without trying to enumerate
 * every accepted name (which would be brittle against upstream changes).
 */
export function isModelCompatibleWithBackend(
  model: string | undefined,
  backendType: BackendType,
): boolean {
  if (model === undefined || model.length === 0) return true;
  if (backendType === "claude") {
    return model.startsWith("claude-");
  }
  if (backendType === "codex") {
    return !model.startsWith("claude-");
  }
  return true;
}

/**
 * Coerce a caller-supplied model to one the observer's backend will
 * accept. Returns the original model if compatible; returns `undefined`
 * if not (the backend will use its configured default).
 *
 * Pure: no I/O, no logging. The launcher logs the coercion at the call
 * site so the EC-9 structured-log line lands with the full spawn
 * context (sessionId, sessionGroupId, role).
 */
export function coerceObserverModel(
  callerModel: string | undefined,
  observerBackend: BackendType,
): { model: string | undefined; coerced: boolean; reason: "incompatible_backend" | "compatible" } {
  if (isModelCompatibleWithBackend(callerModel, observerBackend)) {
    return { model: callerModel, coerced: false, reason: "compatible" };
  }
  return { model: undefined, coerced: true, reason: "incompatible_backend" };
}
