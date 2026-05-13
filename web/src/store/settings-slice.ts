/**
 * Settings slice (PLAN Task 6).
 *
 * Server-authoritative settings facts surfaced as a single source of truth.
 * Holds only flags the server owns — fields the SettingsPage form input
 * is "the truth of" stay as component-local draft state.
 *
 * One-shot {@link SettingsSlice.hydrateSettings} action is called on
 * app boot (or whenever the underlying settings API resolves) — it
 * mirrors the GET /api/settings response into the slice. Narrow
 * selectors live alongside so consumer components subscribe to one
 * field at a time, preventing render storms when an unrelated field
 * changes (e.g. the Council pairing-availability gate consumer doesn't
 * re-render on every Anthropic-model edit).
 *
 * Per Fowler refactoring.md Principle 5 (anti-speculative-generality):
 * we do NOT pre-import every settings field — only the server-
 * authoritative ones used by ≥2 consumers OR the ones the council
 * pairing-availability gate actually depends on. Adding more fields
 * is cheap and reviewable; the floor stays narrow.
 */

import type { StateCreator } from "zustand";
import type { AppState } from "./index.js";

/**
 * Subset of the GET /api/settings response shape this slice mirrors.
 * Kept structural (not imported from `api.ts`) so the slice owns the
 * field set it cares about + is independent of unrelated API changes.
 */
export interface SettingsHydratePayload {
  /** Server reports "configured" booleans without echoing the secret value. */
  anthropicApiKeyConfigured?: boolean;
  claudeCodeOAuthTokenConfigured?: boolean;
  openaiApiKeyConfigured?: boolean;
  aiValidationEnabled?: boolean;
  aiValidationAutoApprove?: boolean;
  aiValidationAutoDeny?: boolean;
}

export interface SettingsSlice {
  // ── Server-authoritative facts (null = unhydrated) ────────────────────
  /** Anthropic API key has been saved server-side. Drives the "configured" badge. */
  anthropicApiKeyConfigured: boolean | null;
  /** Claude Code OAuth token has been saved server-side. */
  claudeCodeOAuthTokenConfigured: boolean | null;
  /** OpenAI API key has been saved server-side. Drives the Codex pairing gate. */
  openaiApiKeyConfigured: boolean | null;
  /** Permission AI-validator toggle (server-stored, user-facing). */
  aiValidationEnabled: boolean | null;
  aiValidationAutoApprove: boolean | null;
  aiValidationAutoDeny: boolean | null;

  /**
   * Whether `hydrateSettings` has been called at least once this session.
   * Lets late-mounting consumers distinguish "no value because we haven't
   * fetched yet" from "no value because server says false" without
   * tracking three-state-tristate locally.
   */
  settingsHydrated: boolean;

  /**
   * One-shot setter. Idempotent — callable from multiple mount sites
   * (SettingsPage's initial fetch, the New Session modal's pairing
   * availability gate) without re-hitting the API; the latest payload
   * wins.
   */
  hydrateSettings: (payload: SettingsHydratePayload) => void;

  /**
   * Mutate a single server-authoritative flag after a successful update
   * (e.g. POST /api/settings response). Mirrors the server response
   * fields without re-fetching the whole settings blob.
   */
  setProviderConfigured: (next: {
    claudeCodeOAuthTokenConfigured?: boolean;
    openaiApiKeyConfigured?: boolean;
    anthropicApiKeyConfigured?: boolean;
  }) => void;
}

export const createSettingsSlice: StateCreator<AppState, [], [], SettingsSlice> = (set) => ({
  anthropicApiKeyConfigured: null,
  claudeCodeOAuthTokenConfigured: null,
  openaiApiKeyConfigured: null,
  aiValidationEnabled: null,
  aiValidationAutoApprove: null,
  aiValidationAutoDeny: null,
  settingsHydrated: false,

  hydrateSettings: (payload) =>
    set((s) => ({
      anthropicApiKeyConfigured:
        typeof payload.anthropicApiKeyConfigured === "boolean"
          ? payload.anthropicApiKeyConfigured
          : s.anthropicApiKeyConfigured,
      claudeCodeOAuthTokenConfigured:
        typeof payload.claudeCodeOAuthTokenConfigured === "boolean"
          ? payload.claudeCodeOAuthTokenConfigured
          : s.claudeCodeOAuthTokenConfigured,
      openaiApiKeyConfigured:
        typeof payload.openaiApiKeyConfigured === "boolean"
          ? payload.openaiApiKeyConfigured
          : s.openaiApiKeyConfigured,
      aiValidationEnabled:
        typeof payload.aiValidationEnabled === "boolean"
          ? payload.aiValidationEnabled
          : s.aiValidationEnabled,
      aiValidationAutoApprove:
        typeof payload.aiValidationAutoApprove === "boolean"
          ? payload.aiValidationAutoApprove
          : s.aiValidationAutoApprove,
      aiValidationAutoDeny:
        typeof payload.aiValidationAutoDeny === "boolean"
          ? payload.aiValidationAutoDeny
          : s.aiValidationAutoDeny,
      settingsHydrated: true,
    })),

  setProviderConfigured: (next) =>
    set((s) => ({
      claudeCodeOAuthTokenConfigured:
        typeof next.claudeCodeOAuthTokenConfigured === "boolean"
          ? next.claudeCodeOAuthTokenConfigured
          : s.claudeCodeOAuthTokenConfigured,
      openaiApiKeyConfigured:
        typeof next.openaiApiKeyConfigured === "boolean"
          ? next.openaiApiKeyConfigured
          : s.openaiApiKeyConfigured,
      anthropicApiKeyConfigured:
        typeof next.anthropicApiKeyConfigured === "boolean"
          ? next.anthropicApiKeyConfigured
          : s.anthropicApiKeyConfigured,
    })),
});

// ── Narrow selectors (PLAN Task 6 — prevent render storms) ────────────────
//
// Each selector reads ONE field. Consumers `useStore(selectFoo)` subscribe
// only to that field's identity — unrelated slice updates don't re-render.
//
// Exported as named functions (not arrows) so the React DevTools profiler
// labels them by name when inspecting subscription churn.

export function selectClaudeCodeOAuthTokenConfigured(s: AppState): boolean | null {
  return s.claudeCodeOAuthTokenConfigured;
}
export function selectOpenaiApiKeyConfigured(s: AppState): boolean | null {
  return s.openaiApiKeyConfigured;
}
export function selectAnthropicApiKeyConfigured(s: AppState): boolean | null {
  return s.anthropicApiKeyConfigured;
}
export function selectAiValidationEnabled(s: AppState): boolean | null {
  return s.aiValidationEnabled;
}
export function selectSettingsHydrated(s: AppState): boolean {
  return s.settingsHydrated;
}
