/**
 * ModelFallbackNotice — Task A.2. The single persistent in-session notice that
 * this session runs on a different model than the one the user chose.
 *
 * Sources (a client notice wins — it is the most recent in-tab decision):
 *   1. `modelSubstitutionNotices` — the set_model gate substituted the target
 *      (registry / broken-model table) or a runtime failure reverted it.
 *   2. `session.model_fallback` — recorded by the SERVER (spawn substitution,
 *      Codex rejection, chain fallback, silence rotation). It lives on the
 *      session state, so it is replayed on reload — unlike the old toasts.
 *
 * "Switch back" is offered only when retrying can actually work (overloaded,
 * unresponsive) and the original model is not retired/blocked in the
 * catalogue. For the other reasons a retry is guaranteed to hit the same
 * wall (the gate re-substitutes, the account re-rejects), so the banner just
 * states the cause and the user picks another model in the selector.
 *
 * Dismissing a server record clears it server-side (`dismiss_model_fallback`,
 * all devices) and is also remembered per event (`at`) in localStorage so it
 * stays hidden even before the server's clear round-trips. The server also
 * clears the record itself once the session confirms a different model.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../store.js";
import { api } from "../api.js";
import { sendToSession } from "../ws.js";
import { getModelsForBackend } from "../utils/backends.js";
import type { ModelFallbackReason } from "../types.js";
import { ModelFallbackBanner } from "./ModelFallbackBanner.js";

const RETRYABLE: ReadonlySet<ModelFallbackReason> = new Set<ModelFallbackReason>([
  "overloaded",
  "unresponsive",
]);

function dismissKey(sessionId: string): string {
  return `cc-model-fallback-dismissed:${sessionId}`;
}

function readDismissedAt(sessionId: string): number | null {
  try {
    const raw = localStorage.getItem(dismissKey(sessionId));
    const n = raw === null ? NaN : Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function ModelFallbackNotice({ sessionId }: { sessionId: string }) {
  const clientNotice = useStore((s) => s.modelSubstitutionNotices.get(sessionId));
  const serverFallback = useStore((s) => s.sessions.get(sessionId)?.model_fallback);
  const runtimeModel = useStore((s) => s.sessions.get(sessionId)?.model);
  const runtimeBackend = useStore((s) => s.sessions.get(sessionId)?.backend_type);
  const sdkSession = useStore((s) => s.sdkSessions.find((sdk) => sdk.sessionId === sessionId));
  const cliConnected = useStore((s) => s.cliConnected.get(sessionId) ?? false);
  const backendType = sdkSession?.backendType ?? runtimeBackend ?? "claude";
  const dynamicModels = useStore((s) => s.dynamicBackendModels[backendType]);
  const catalog = dynamicModels ?? getModelsForBackend(backendType);
  const [dismissedAt, setDismissedAt] = useState<number | null>(() => readDismissedAt(sessionId));
  // Codex switch-back is an async relaunch REQUEST: keep the notice until it
  // succeeds; on failure keep it and show why (observer WARN, PR #367).
  const [switchingBack, setSwitchingBack] = useState(false);
  const [switchBackError, setSwitchBackError] = useState<string | undefined>(undefined);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Show whichever event is NEWER: a client notice (firedAt) or the server
  // record (at). An older in-tab notice must not hide a fresh server fallback.
  const liveServer = serverFallback && serverFallback.at !== dismissedAt ? serverFallback : null;
  const useClient = clientNotice && (!liveServer || clientNotice.firedAt >= liveServer.at);
  const notice = useClient
    ? { from: clientNotice.requested, to: clientNotice.applied, reason: clientNotice.reason, detail: undefined as string | undefined }
    : liveServer
      ? { from: liveServer.from, to: liveServer.to, reason: liveServer.reason, detail: liveServer.detail }
      : null;

  const label = useCallback(
    (id: string) => catalog.find((m) => m.value === id)?.label ?? id,
    [catalog],
  );

  const dismiss = useCallback(() => {
    if (clientNotice) useStore.getState().clearModelSubstitutionNotice(sessionId);
    if (serverFallback) {
      try {
        localStorage.setItem(dismissKey(sessionId), String(serverFallback.at));
      } catch {
        /* storage unavailable — dismissal lasts for this mount only */
      }
      setDismissedAt(serverFallback.at);
      // Clear the shared record so other devices/tabs drop the banner too.
      sendToSession(sessionId, { type: "dismiss_model_fallback", at: serverFallback.at });
    }
  }, [clientNotice, serverFallback, sessionId]);

  const switchBack = useCallback(() => {
    if (!notice) return;
    const target = notice.from;
    const store = useStore.getState();
    if (backendType === "codex") {
      if (switchingBack) return;
      store.setPendingCodexModelSwitch(sessionId, target);
      setSwitchingBack(true);
      setSwitchBackError(undefined);
      api.relaunchSession(sessionId, { model: target }).then(
        () => {
          if (!mountedRef.current) return;
          setSwitchingBack(false);
          dismiss();
        },
        (err: unknown) => {
          useStore.getState().clearPendingCodexModelSwitch(sessionId);
          if (!mountedRef.current) return;
          setSwitchingBack(false);
          setSwitchBackError(err instanceof Error && err.message ? err.message : "the relaunch request failed");
        },
      );
      return;
    } else {
      // Same single-marker optimistic path as ModelSwitcher: if the original
      // model fails again on the next turn, ws.ts reverts to the current one.
      const current = runtimeModel ?? sdkSession?.model ?? notice.to;
      store.setPendingClaudeModelSwitch(sessionId, target, current);
      sendToSession(sessionId, { type: "set_model", model: target });
      store.updateSession(sessionId, { model: target });
      store.setSdkSessions(
        store.sdkSessions.map((sdk) => (sdk.sessionId === sessionId ? { ...sdk, model: target } : sdk)),
      );
    }
    dismiss();
  }, [notice, backendType, sessionId, runtimeModel, sdkSession?.model, dismiss, switchingBack]);

  if (!notice) return null;

  const fromStatus = catalog.find((m) => m.value === notice.from)?.status;
  const canSwitchBack =
    RETRYABLE.has(notice.reason) &&
    fromStatus !== "retired" &&
    fromStatus !== "blocked" &&
    (backendType === "codex" || cliConnected);

  return (
    <div className="shrink-0 border-t border-cc-border bg-cc-card">
      <ModelFallbackBanner
        fromModel={label(notice.from)}
        toModel={label(notice.to)}
        reason={notice.reason}
        detail={notice.detail}
        onSwitchBack={canSwitchBack ? switchBack : undefined}
        switchingBack={switchingBack}
        switchBackError={switchBackError}
        onDismiss={dismiss}
      />
    </div>
  );
}
