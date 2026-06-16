// AURA-LOCAL — PLAN T12 (Phase G, Story 2c).
//
// Per-session terminal-failure axis. DISTINCT from `cliConnected`
// (EC-44 + Frontend R1): a CLI being unreachable transiently is the
// `cliConnected = false` axis (yellow banner, reconnect affordance);
// a CLI being PERMANENTLY DEAD (relaunch budget spent, container
// gone, browser-close drain expired) is THIS axis — non-recoverable
// inside the existing session, requires a fresh session spawn.
//
// Folding both into one boolean would collapse the recovery paths.
// The wire frame source of truth is `CliFailedFrame` (Phase F
// `web/server/cli-failed-frame.ts`); the ws.ts dispatcher calls
// `setCliFailure` on `cli_failed` arrival, and session-archive /
// relaunch flows call `clearCliFailure` so a fresh subprocess does
// not inherit the prior failure state.

import type { StateCreator } from "zustand";
import type { CliFailedReason } from "../types.js";
import type { AppState } from "./index.js";

/**
 * In-store representation of a terminal CLI failure for a session.
 * Mirrors `CliFailedFrame` minus the wire-protocol envelope fields
 * (`type`, `seq`, `sessionId`, `origin`) — those are routing concerns
 * consumed by ws.ts and never reach this slice.
 */
export interface CliFailure {
  reason: CliFailedReason;
  drainedCount: number;
  subprocessAlive: boolean;
  firedAt: number;
  lastErrorSha256?: string;
}

export interface PendingCodexModelSwitch {
  requestedModel: string;
  requestedAt: number;
}

/**
 * In-flight Claude in-session model switch. Unlike Codex (which relaunches),
 * the Claude `set_model` path is optimistic + fire-and-forget: the CLI accepts
 * the model WITHOUT validating access, so an unusable model only fails on the
 * NEXT real turn (a `result` frame with `api_error_status: 404`). We retain
 * `previousModel` so ws.ts can revert the optimistic label AND re-issue
 * `set_model` back to the last working model when that 404 arrives.
 */
export interface PendingClaudeModelSwitch {
  requestedModel: string;
  previousModel: string;
  requestedAt: number;
}

/**
 * Model Registry Task 9 — proactive-substitution notice. When the server's
 * pre-send gate (`claude-adapter.handleOutgoingSetModel`) silently swaps a
 * `retired`/`blocked` target for its same-tier registry replacement, it emits
 * a `model_substitution` frame and the frontend surfaces ONE calm, persistent,
 * dismissible banner (NOT a chat message — that channel is the reactive-revert
 * path). Holds the `substituted` outcome only: `applied` is the model now
 * running. The `unavailable` outcome (no usable replacement) keeps the current
 * model and rides the existing system-message channel for copy parity with the
 * reactive revert. `reason` reuses the runtime-failure enum so the banner copy
 * reads identically to `modelFailureNotice`.
 */
export interface ModelSubstitutionNotice {
  requested: string;
  applied: string;
  reason: "retired" | "blocked" | "overloaded";
  firedAt: number;
}

/**
 * Model Registry Task 9 — pending cross-tier confirmation. A cross-tier swap is
 * never silent (it changes cost): the server emits `needs-user-action` WITHOUT
 * sending any frame, the optimistic switch is rolled back to `previousModel`,
 * and this holds the proposal until the user confirms via the APG dialog. On
 * confirm the switch re-runs through the normal optimistic `set_model` path
 * toward `replacement`; on cancel the session stays on `previousModel`.
 */
export interface PendingCrossTierSwitch {
  requested: string;
  replacement: string;
  previousModel: string;
  firedAt: number;
}

/**
 * Model Registry Task 10 — transient screen-reader announcement for a model
 * availability event (substituted / reverted / unavailable). None of these
 * three surfaces is reliably announced by default: the substitution notice is
 * a visual banner, and the reactive-revert / unavailable system messages render
 * in `MessageFeed`, which carries no live region. The `ModelAvailabilityAnnouncer`
 * sr-only `role="log"` polite region reads this per-session string and speaks it
 * once. `firedAt` is the announcement key — a fresh value re-announces even when
 * the text is byte-identical (two reverts to the same model in a row).
 */
export interface ModelAvailabilityAnnouncement {
  text: string;
  firedAt: number;
}

export interface CliStatusSlice {
  cliFailures: Map<string, CliFailure>;
  pendingCodexModelSwitches: Map<string, PendingCodexModelSwitch>;
  pendingClaudeModelSwitches: Map<string, PendingClaudeModelSwitch>;
  modelSubstitutionNotices: Map<string, ModelSubstitutionNotice>;
  pendingCrossTierSwitches: Map<string, PendingCrossTierSwitch>;
  modelAvailabilityAnnouncements: Map<string, ModelAvailabilityAnnouncement>;
  setCliFailure: (sessionId: string, failure: CliFailure) => void;
  clearCliFailure: (sessionId: string) => void;
  setPendingCodexModelSwitch: (sessionId: string, requestedModel: string) => void;
  clearPendingCodexModelSwitch: (sessionId: string) => void;
  setPendingClaudeModelSwitch: (sessionId: string, requestedModel: string, previousModel: string) => void;
  clearPendingClaudeModelSwitch: (sessionId: string) => void;
  setModelSubstitutionNotice: (sessionId: string, notice: Omit<ModelSubstitutionNotice, "firedAt">) => void;
  clearModelSubstitutionNotice: (sessionId: string) => void;
  setPendingCrossTierSwitch: (sessionId: string, pending: Omit<PendingCrossTierSwitch, "firedAt">) => void;
  clearPendingCrossTierSwitch: (sessionId: string) => void;
  announceModelAvailability: (sessionId: string, text: string) => void;
}

export const createCliStatusSlice: StateCreator<AppState, [], [], CliStatusSlice> = (set) => ({
  cliFailures: new Map(),
  pendingCodexModelSwitches: new Map(),
  pendingClaudeModelSwitches: new Map(),
  modelSubstitutionNotices: new Map(),
  pendingCrossTierSwitches: new Map(),
  modelAvailabilityAnnouncements: new Map(),

  setCliFailure: (sessionId, failure) =>
    set((s) => {
      const cliFailures = new Map(s.cliFailures);
      cliFailures.set(sessionId, failure);
      return { cliFailures };
    }),

  clearCliFailure: (sessionId) =>
    set((s) => {
      if (!s.cliFailures.has(sessionId)) return {};
      const cliFailures = new Map(s.cliFailures);
      cliFailures.delete(sessionId);
      return { cliFailures };
    }),

  setPendingCodexModelSwitch: (sessionId, requestedModel) =>
    set((s) => {
      const pendingCodexModelSwitches = new Map(s.pendingCodexModelSwitches);
      pendingCodexModelSwitches.set(sessionId, {
        requestedModel,
        requestedAt: Date.now(),
      });
      return { pendingCodexModelSwitches };
    }),

  clearPendingCodexModelSwitch: (sessionId) =>
    set((s) => {
      if (!s.pendingCodexModelSwitches.has(sessionId)) return {};
      const pendingCodexModelSwitches = new Map(s.pendingCodexModelSwitches);
      pendingCodexModelSwitches.delete(sessionId);
      return { pendingCodexModelSwitches };
    }),

  setPendingClaudeModelSwitch: (sessionId, requestedModel, previousModel) =>
    set((s) => {
      const pendingClaudeModelSwitches = new Map(s.pendingClaudeModelSwitches);
      pendingClaudeModelSwitches.set(sessionId, {
        requestedModel,
        previousModel,
        requestedAt: Date.now(),
      });
      return { pendingClaudeModelSwitches };
    }),

  clearPendingClaudeModelSwitch: (sessionId) =>
    set((s) => {
      if (!s.pendingClaudeModelSwitches.has(sessionId)) return {};
      const pendingClaudeModelSwitches = new Map(s.pendingClaudeModelSwitches);
      pendingClaudeModelSwitches.delete(sessionId);
      return { pendingClaudeModelSwitches };
    }),

  setModelSubstitutionNotice: (sessionId, notice) =>
    set((s) => {
      const modelSubstitutionNotices = new Map(s.modelSubstitutionNotices);
      modelSubstitutionNotices.set(sessionId, { ...notice, firedAt: Date.now() });
      return { modelSubstitutionNotices };
    }),

  clearModelSubstitutionNotice: (sessionId) =>
    set((s) => {
      if (!s.modelSubstitutionNotices.has(sessionId)) return {};
      const modelSubstitutionNotices = new Map(s.modelSubstitutionNotices);
      modelSubstitutionNotices.delete(sessionId);
      return { modelSubstitutionNotices };
    }),

  setPendingCrossTierSwitch: (sessionId, pending) =>
    set((s) => {
      const pendingCrossTierSwitches = new Map(s.pendingCrossTierSwitches);
      pendingCrossTierSwitches.set(sessionId, { ...pending, firedAt: Date.now() });
      return { pendingCrossTierSwitches };
    }),

  clearPendingCrossTierSwitch: (sessionId) =>
    set((s) => {
      if (!s.pendingCrossTierSwitches.has(sessionId)) return {};
      const pendingCrossTierSwitches = new Map(s.pendingCrossTierSwitches);
      pendingCrossTierSwitches.delete(sessionId);
      return { pendingCrossTierSwitches };
    }),

  announceModelAvailability: (sessionId, text) =>
    set((s) => {
      const modelAvailabilityAnnouncements = new Map(s.modelAvailabilityAnnouncements);
      modelAvailabilityAnnouncements.set(sessionId, { text, firedAt: Date.now() });
      return { modelAvailabilityAnnouncements };
    }),
});
