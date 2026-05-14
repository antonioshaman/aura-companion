import { describe, it, expect } from "vitest";
import {
  isModelCompatibleWithBackend,
  coerceObserverModel,
} from "./observer-model-compat.js";

// ─── Test fixtures ────────────────────────────────────────────────────────
//
// This module fixes Council Mode Residual #1 (HANDOFF-morning.md): the
// `claude+codex` pairing dispatches one caller-supplied model name to
// both halves of the pair, and Codex rejects Claude model names at
// `thread/start` with `invalid_request_error`, blocking auto-wake
// reviews. Coverage focuses on the cross-backend leak path and the
// "compatible / no-op" path so the launcher's wire-in stays correct
// across both pairings.

describe("isModelCompatibleWithBackend", () => {
  it("treats undefined and empty model as compatible with any backend", () => {
    // Backends fall back to their own configured default when model is
    // omitted — that's strictly safer than picking a stale-name guess.
    expect(isModelCompatibleWithBackend(undefined, "claude")).toBe(true);
    expect(isModelCompatibleWithBackend(undefined, "codex")).toBe(true);
    expect(isModelCompatibleWithBackend("", "claude")).toBe(true);
    expect(isModelCompatibleWithBackend("", "codex")).toBe(true);
  });

  it("accepts Claude-family models on the Claude backend", () => {
    expect(isModelCompatibleWithBackend("claude-opus-4-7", "claude")).toBe(true);
    expect(isModelCompatibleWithBackend("claude-sonnet-4-6", "claude")).toBe(true);
    expect(isModelCompatibleWithBackend("claude-haiku-4-5", "claude")).toBe(true);
  });

  it("rejects non-Claude-family models on the Claude backend", () => {
    // Catches the symmetric leak (codex+claude pairing).
    expect(isModelCompatibleWithBackend("gpt-5", "claude")).toBe(false);
    expect(isModelCompatibleWithBackend("gpt-5-codex", "claude")).toBe(false);
    expect(isModelCompatibleWithBackend("o4-mini", "claude")).toBe(false);
  });

  it("rejects Claude-family models on the Codex backend — the bug we're fixing", () => {
    // The exact scenario observed in production: every checkpoint POST
    // logs `event=protocol.drift backend=codex direction=incoming ...
    // 'claude-opus-4-7' model is not supported when using Codex with a
    // ChatGPT account.`
    expect(isModelCompatibleWithBackend("claude-opus-4-7", "codex")).toBe(false);
    expect(isModelCompatibleWithBackend("claude-sonnet-4-6", "codex")).toBe(false);
  });

  it("accepts Codex-family models on the Codex backend", () => {
    expect(isModelCompatibleWithBackend("gpt-5", "codex")).toBe(true);
    expect(isModelCompatibleWithBackend("gpt-5-codex", "codex")).toBe(true);
    expect(isModelCompatibleWithBackend("o4-mini", "codex")).toBe(true);
  });

  it("does not assume any backend other than claude/codex (forward-compat)", () => {
    // A future backend addition would default to "compatible" until
    // someone teaches this function its naming convention. That's the
    // safer drift behaviour: don't silently drop fields just because the
    // backend tag is unfamiliar.
    expect(isModelCompatibleWithBackend("anything", "unknown" as never)).toBe(true);
  });
});

describe("coerceObserverModel", () => {
  it("returns the model unchanged when compatible", () => {
    const result = coerceObserverModel("claude-opus-4-7", "claude");
    expect(result).toEqual({
      model: "claude-opus-4-7",
      coerced: false,
      reason: "compatible",
    });
  });

  it("returns the model unchanged when undefined (backend default kicks in)", () => {
    const result = coerceObserverModel(undefined, "codex");
    expect(result).toEqual({
      model: undefined,
      coerced: false,
      reason: "compatible",
    });
  });

  it("drops a Claude model when the observer backend is Codex — fixes Residual #1", () => {
    const result = coerceObserverModel("claude-opus-4-7", "codex");
    expect(result).toEqual({
      model: undefined,
      coerced: true,
      reason: "incompatible_backend",
    });
  });

  it("drops a Codex model when the observer backend is Claude — symmetric case", () => {
    // Covers the codex+claude pairing (not in current SUPPORTED_PAIRINGS
    // but the coercion is direction-agnostic so it stays correct if/when
    // that pairing is enabled).
    const result = coerceObserverModel("gpt-5", "claude");
    expect(result).toEqual({
      model: undefined,
      coerced: true,
      reason: "incompatible_backend",
    });
  });

  it("does not coerce when the original is already undefined (no-op idempotent)", () => {
    // Idempotency check — re-coercing a previously-coerced result must
    // not loop or report a phantom mutation.
    const first = coerceObserverModel("claude-opus-4-7", "codex");
    const second = coerceObserverModel(first.model, "codex");
    expect(second).toEqual({
      model: undefined,
      coerced: false,
      reason: "compatible",
    });
  });
});
