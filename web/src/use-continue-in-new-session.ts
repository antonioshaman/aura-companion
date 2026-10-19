/**
 * Continue-in-new-session — the one browser flow behind both the sidebar
 * "..." menu item and the context-overflow banner in the chat.
 *
 * The server (`POST /sessions/:id/continue-in-new`) extracts a text-only
 * handoff brief from the old session's persisted messageHistory, writes it as
 * `.aura-handoff-<ts>.md` into the workspace and spawns a fresh session in the
 * same cwd — a new Council pair (same pairing and models) when the source was
 * a pair half, otherwise a solo session on the same backend and model. It
 * never talks to the old CLI, so this works even when that CLI is dead or
 * unresponsive (the overflow case). The browser then pre-fills the new
 * (orchestrator) session's composer with the pickup draft and switches.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import { useStore } from "./store.js";
import { navigateToSession } from "./utils/routing.js";

/** Reason codes the server tailors the brief + pickup draft for. */
export type ContinueInNewReason = "context_too_large" | "image_limit";

/**
 * Run the flow once. Resolves with the new session id; rejects with the
 * server/network error (callers decide how to surface it).
 */
export async function continueInNewSession(
  sessionId: string,
  opts: { reason?: ContinueInNewReason } = {},
): Promise<string> {
  const result = await api.continueInNewSession(sessionId, opts.reason ? { reason: opts.reason } : undefined);
  const store = useStore.getState();
  store.setPickupDraft(result.newSessionId, result.draft);
  navigateToSession(result.newSessionId);
  if (typeof window !== "undefined" && window.innerWidth < 768) {
    store.setSidebarOpen(false);
  }
  return result.newSessionId;
}

/** Hook wrapper with loading + error state for UI that shows both. */
export function useContinueInNewSession() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const inFlightRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const run = useCallback(
    async (sessionId: string, opts: { reason?: ContinueInNewReason } = {}): Promise<string | null> => {
      // A double click must not spawn two sessions + two handoff files.
      if (inFlightRef.current) return null;
      inFlightRef.current = true;
      setPending(true);
      setError(null);
      try {
        return await continueInNewSession(sessionId, opts);
      } catch (err) {
        if (mountedRef.current) {
          setError(err instanceof Error && err.message ? err.message : "the request failed");
        }
        return null;
      } finally {
        inFlightRef.current = false;
        if (mountedRef.current) setPending(false);
      }
    },
    [],
  );

  return { run, pending, error };
}
