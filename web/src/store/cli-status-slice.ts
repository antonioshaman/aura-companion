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

export interface CliStatusSlice {
  cliFailures: Map<string, CliFailure>;
  pendingCodexModelSwitches: Map<string, PendingCodexModelSwitch>;
  pendingClaudeModelSwitches: Map<string, PendingClaudeModelSwitch>;
  setCliFailure: (sessionId: string, failure: CliFailure) => void;
  clearCliFailure: (sessionId: string) => void;
  setPendingCodexModelSwitch: (sessionId: string, requestedModel: string) => void;
  clearPendingCodexModelSwitch: (sessionId: string) => void;
  setPendingClaudeModelSwitch: (sessionId: string, requestedModel: string, previousModel: string) => void;
  clearPendingClaudeModelSwitch: (sessionId: string) => void;
}

export const createCliStatusSlice: StateCreator<AppState, [], [], CliStatusSlice> = (set) => ({
  cliFailures: new Map(),
  pendingCodexModelSwitches: new Map(),
  pendingClaudeModelSwitches: new Map(),

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
});
