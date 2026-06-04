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
import type { BackendType } from "../types.js";
import { api } from "../api.js";
import { toModelOptions, type ModelOption } from "../utils/backends.js";

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
  /**
   * Council Review 2026-06-04-0823 P1 #1 (Friedman): user's saved Anthropic
   * model preference. Plumbed through `pickSessionDefaultModel` at every
   * session-create call site so a switchBackend toggle does NOT silently
   * flip the user away from their pinned model. Non-null string when the
   * user has saved one; `null` when never set.
   */
  anthropicModel?: string | null;
}

/**
 * Status enum for the dynamic backend models fetch lifecycle. Internal
 * to the slice today (UI consumers fall back to static lists silently);
 * exposed for future surfaces (loading skeleton, "could not reach
 * Anthropic" inline hint, etc.) without a follow-up slice change.
 */
/**
 * Per-backend fetch lifecycle status. PR #91 burndown Task 2 — convention
 * EC-44: when a code change introduces a semantically distinct state that
 * previously was implicit, widen the union, don't overload an existing
 * variant with a sentinel-data-shape. `"rejected"` and `"rejected-stale"`
 * are now distinguishable from the status field alone — no need to combine
 * with `dynamicBackendModels[backend] !== undefined` at the call site.
 *
 *  - `idle` — never fetched (default).
 *  - `pending` — fetch in flight.
 *  - `resolved` — last fetch succeeded; `dynamicBackendModels[backend]` populated.
 *  - `rejected` — last fetch failed AND no prior successful result is held
 *    (`dynamicBackendModels[backend]` is `undefined`). Hard reject.
 *  - `rejected-stale` — last fetch failed BUT prior successful result is
 *    preserved in `dynamicBackendModels[backend]`. Soft reject.
 */
export type DynamicModelsStatus =
  | "idle"
  | "pending"
  | "resolved"
  | "rejected"
  | "rejected-stale";

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
   * User's saved Anthropic model preference (the "sticky" preference).
   * Council Review 2026-06-04-0823 P1 #1: plumbed through
   * `pickSessionDefaultModel` so a switchBackend toggle preserves the
   * user's explicit choice when present. `null` = unhydrated or unset.
   */
  anthropicModel: string | null;

  /**
   * Whether `hydrateSettings` has been called at least once this session.
   * Lets late-mounting consumers distinguish "no value because we haven't
   * fetched yet" from "no value because server says false" without
   * tracking three-state-tristate locally.
   */
  settingsHydrated: boolean;

  /**
   * Dynamic backend model lists (PLAN-aura-dynamic-model-list Task 8).
   *
   * Per backend, holds the `ModelOption[]` returned from
   * `GET /api/backends/:id/models` and converted via `toModelOptions`.
   * `undefined` while idle/pending/rejected — consumers fall back to
   * static `CLAUDE_MODELS` / `CODEX_MODELS` from `utils/backends.ts`.
   *
   * **Note on slice cohesion** — this field stretches the "server-
   * authoritative settings facts only" invariant the slice header
   * documents (Fowler P5 narrow scope). PLAN parked Fowler R4
   * (separate `backend-models-slice.ts`) because the refetch trigger
   * naturally fires off Settings save (the slice already owns the
   * post-save handler surface). Revisit if `dynamicBackendModels` grows
   * additional lifecycle (manual refresh button, periodic poll, etc.) —
   * those would clearly belong in their own slice.
   */
  dynamicBackendModels: { claude?: ModelOption[]; codex?: ModelOption[] };

  /** Per-backend fetch lifecycle status. See {@link DynamicModelsStatus}. */
  dynamicBackendModelsStatus: {
    claude: DynamicModelsStatus;
    codex: DynamicModelsStatus;
  };

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

  /**
   * Fetch the dynamic model list for `backend` and update the slice.
   *
   * Inflight-token guard (Frontend R1): concurrent calls collapse to the
   * latest token's result — a slow first fetch cannot clobber a fresh
   * post-save refetch that lands second. Token lives in module scope,
   * NOT Zustand state, so two-tab/multi-mount scenarios share one
   * canonical counter.
   *
   * Silent error fallback: REST failures do NOT throw to caller — the
   * slice flips status to "rejected" and leaves `dynamicBackendModels[backend]`
   * `undefined` so consumers render the static fallback transparently.
   *
   * Idempotent: safe to call from every consumer's `useEffect` mount
   * (HomePage, CronManager, ModelSwitcher) — token guard + server-side
   * cache means concurrent calls land on one upstream fetch.
   */
  loadBackendModels: (backend: BackendType) => Promise<void>;
}

/**
 * Module-level inflight tokens — NOT in Zustand state so multiple
 * `useStore.getState().loadBackendModels(...)` calls across components
 * share one canonical counter. Each call increments the counter for its
 * backend; only the call whose token still matches at resolution time
 * commits its result.
 */
const inflightModelLoadTokens: Record<BackendType, number> = {
  claude: 0,
  codex: 0,
};

/**
 * Test-only reset of the inflight token counters. Tests that exercise
 * the load action across multiple cases need to start each from a
 * clean counter; without this they accumulate across the test file.
 */
export function __resetBackendModelInflightForTests(): void {
  inflightModelLoadTokens.claude = 0;
  inflightModelLoadTokens.codex = 0;
}

export const createSettingsSlice: StateCreator<AppState, [], [], SettingsSlice> = (set) => ({
  anthropicApiKeyConfigured: null,
  claudeCodeOAuthTokenConfigured: null,
  openaiApiKeyConfigured: null,
  aiValidationEnabled: null,
  aiValidationAutoApprove: null,
  aiValidationAutoDeny: null,
  anthropicModel: null,
  settingsHydrated: false,
  dynamicBackendModels: {},
  dynamicBackendModelsStatus: { claude: "idle", codex: "idle" },

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
      // Sticky model preference — accept null (explicit clear) AND string,
      // but reject non-string non-null. Forward-compat for a future API
      // shape that ships `"expired" | "default"` discriminator strings.
      anthropicModel:
        typeof payload.anthropicModel === "string" || payload.anthropicModel === null
          ? payload.anthropicModel
          : s.anthropicModel,
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

  loadBackendModels: async (backend) => {
    const myToken = ++inflightModelLoadTokens[backend];
    set((s) => ({
      dynamicBackendModelsStatus: {
        ...s.dynamicBackendModelsStatus,
        [backend]: "pending" as const,
      },
    }));
    try {
      const fetched = await api.getBackendModels(backend);
      // Inflight check: a newer call may have superseded this one (e.g.,
      // user saves a fresh API key while a prior fetch is still pending).
      // Drop our result silently rather than clobber.
      if (inflightModelLoadTokens[backend] !== myToken) return;
      const models = fetched.length > 0 ? toModelOptions(fetched) : undefined;
      set((s) => ({
        dynamicBackendModels: {
          ...s.dynamicBackendModels,
          [backend]: models,
        },
        dynamicBackendModelsStatus: {
          ...s.dynamicBackendModelsStatus,
          [backend]: "resolved" as const,
        },
      }));
    } catch {
      // Silent error fallback (per scope summary). Status flips so future
      // UI surfaces can render a "could not reach upstream" inline hint
      // if they want; today every consumer falls through to static.
      //
      // Council Review 2026-06-04-0823 P2 #9 (Backend × React — EC-41):
      // when a NEWER token (`myToken < counter`) is still pending OR the
      // slice already holds a successful list from a prior call, this
      // failing call MUST NOT clobber state to "rejected". The naive
      // `if (token !== myToken) return` shape on its own is insufficient
      // because B (fast reject) and A (slow success) both pass the
      // counter check at their own resolution moments — B's reject lands
      // first and flips status, then A's success lands but is silently
      // dropped because `myToken !== counter` after B already incremented.
      // New shape: skip the rejected-state commit if a newer call has
      // already begun (myToken < counter — A is slow, B started). Keep
      // status "pending" so A's success can still commit when it lands.
      if (inflightModelLoadTokens[backend] !== myToken) return;
      set((s) => {
        const currentSlot = s.dynamicBackendModels[backend];
        // PR #91 burndown Task 2 (EC-44): the two branches now mutate
        // genuinely-different literal status values, replacing the
        // prior overload-via-JSDoc shape. EC-42 mutation-resistance:
        // collapsing the if/else makes one of the two re-write tests
        // go RED.
        if (currentSlot !== undefined && currentSlot.length > 0) {
          // Soft-reject — last known data preserved.
          return {
            dynamicBackendModelsStatus: {
              ...s.dynamicBackendModelsStatus,
              [backend]: "rejected-stale" as const,
            },
          };
        }
        // Hard-reject — no prior data; slot stays undefined.
        return {
          dynamicBackendModelsStatus: {
            ...s.dynamicBackendModelsStatus,
            [backend]: "rejected" as const,
          },
        };
      });
    }
  },
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

/**
 * Council Review 2026-06-04-0823 P1 #1 — sticky-preference selector.
 * Returns the user's saved Anthropic model preference or `null` when
 * unset/unhydrated. `pickSessionDefaultModel` accepts both.
 */
export function selectAnthropicModel(s: AppState): string | null {
  return s.anthropicModel;
}

// ── Dynamic-model selectors (Task 8) ──────────────────────────────────────

/**
 * One-field selector returning the dynamic model list for `backend`, or
 * `undefined` while idle / pending / failed. Consumers compose with the
 * static fallback themselves so the selector remains stateless:
 *
 *   `useStore(s => selectDynamicBackendModels(s, "claude")) ?? getModelsForBackend("claude")`
 */
export function selectDynamicBackendModels(
  s: AppState,
  backend: BackendType,
): ModelOption[] | undefined {
  return s.dynamicBackendModels[backend];
}

/** Status selector — typically only loading/error UX consumes this. */
export function selectDynamicBackendModelsStatus(
  s: AppState,
  backend: BackendType,
): DynamicModelsStatus {
  return s.dynamicBackendModelsStatus[backend];
}
