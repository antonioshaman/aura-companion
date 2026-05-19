import { useMemo, useState, useCallback, useRef, useEffect } from "react";
import { useStore } from "../store.js";
import { api } from "../api.js";
import { captureException } from "../analytics.js";
import { MessageFeed } from "./MessageFeed.js";
import { Composer } from "./Composer.js";
import { PermissionBanner } from "./PermissionBanner.js";
import { AiValidationBadge } from "./AiValidationBadge.js";
import { BlockerBanner } from "./council/index.js";
import { findUnresolvedStops } from "../observer-panel-state.js";

export function ChatView({ sessionId }: { sessionId: string }) {
  const sessionPerms = useStore((s) => s.pendingPermissions.get(sessionId));
  const aiResolved = useStore((s) => s.aiResolvedPermissions.get(sessionId));
  const clearAiResolvedPermissions = useStore((s) => s.clearAiResolvedPermissions);
  const connStatus = useStore(
    (s) => s.connectionStatus.get(sessionId) ?? "disconnected"
  );
  const cliConnected = useStore((s) => s.cliConnected.get(sessionId) ?? false);
  const cliReconnecting = useStore(
    (s) => s.cliReconnecting.get(sessionId) ?? false
  );
  const setCliReconnecting = useStore((s) => s.setCliReconnecting);

  const [reconnectError, setReconnectError] = useState<string | null>(null);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Clear stale error when switching sessions or when CLI reconnects
  useEffect(() => {
    setReconnectError(null);
    clearTimeout(errorTimerRef.current);
  }, [sessionId, cliConnected]);

  // Clean up error auto-clear timer on unmount
  useEffect(() => () => clearTimeout(errorTimerRef.current), []);

  const handleReconnect = useCallback(async () => {
    setReconnectError(null);
    clearTimeout(errorTimerRef.current);
    setCliReconnecting(sessionId, true);
    try {
      await api.relaunchSession(sessionId);
    } catch (err) {
      captureException(err);
      setCliReconnecting(sessionId, false);
      const msg =
        err instanceof Error ? err.message : "Reconnection failed";
      setReconnectError(msg);
      errorTimerRef.current = setTimeout(() => setReconnectError(null), 4000);
    }
  }, [sessionId, setCliReconnecting]);

  const perms = useMemo(
    () => (sessionPerms ? Array.from(sessionPerms.values()) : []),
    [sessionPerms]
  );

  // Council Mode: the most recent unresolved STOP for this session's group
  // surfaces as a BlockerBanner in the same DOM slot as PermissionBanner.
  // Permission-first stacking (PLAN T15.3): if a permission is pending,
  // the blocker hides and waits its turn — observer findings are
  // important but never preempt a tool-call decision.
  const groupId = useStore((s) => s.groupBySessionId.get(sessionId));
  const findings = useStore((s) => (groupId ? s.findings.get(groupId) : undefined));
  const dismissedStopIds = useStore((s) => s.dismissedStopIds);
  const dismissStop = useStore((s) => s.dismissStop);
  const topBlocker = useMemo(() => {
    if (!findings || findings.length === 0) return null;
    const live = findUnresolvedStops(findings, dismissedStopIds);
    if (live.length === 0) return null;
    return live[live.length - 1] ?? null;
  }, [findings, dismissedStopIds]);

  const showCliBanner = connStatus === "connected" && !cliConnected;

  // Council Mode: observer half has its permission-mode locked at spawn
  // (EC-1, applyCouncilObserverSpawnConfig). Mounting Composer under the
  // observer would expose a toggle that the server-side gate (ws-bridge)
  // rejects anyway — better not to render it. Strict equality so non-council
  // sessions (role === undefined) keep their Composer.
  const isObserver =
    useStore((s) => s.sessions.get(sessionId)?.sessionGroupRole) === "observer";

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* CLI disconnected / reconnecting / error banner */}
      {showCliBanner && (
        <div className="px-4 py-2 bg-cc-warning/10 border-b border-cc-warning/20 text-center flex items-center justify-center gap-3">
          {reconnectError ? (
            <>
              <span className="text-xs text-cc-error font-medium">
                {reconnectError}
              </span>
              <button
                onClick={handleReconnect}
                className="text-xs font-medium px-3 py-1.5 rounded-md bg-cc-error/15 hover:bg-cc-error/25 text-cc-error transition-colors cursor-pointer"
              >
                Retry
              </button>
            </>
          ) : cliReconnecting ? (
            <>
              <span className="w-3 h-3 rounded-full border-2 border-cc-warning/30 border-t-cc-warning animate-spin" />
              <span className="text-xs text-cc-warning font-medium">
                Reconnecting&hellip;
              </span>
            </>
          ) : (
            <>
              <span className="text-xs text-cc-warning font-medium">
                CLI disconnected
              </span>
              <button
                onClick={handleReconnect}
                className="text-xs font-medium px-3 py-1.5 rounded-md bg-cc-warning/20 hover:bg-cc-warning/30 text-cc-warning transition-colors cursor-pointer"
              >
                Reconnect
              </button>
            </>
          )}
        </div>
      )}

      {/* WebSocket disconnected banner */}
      {connStatus === "disconnected" && (
        <div className="px-4 py-2.5 bg-gradient-to-r from-cc-warning/8 to-cc-warning/4 border-b border-cc-warning/15 flex items-center justify-center gap-2 animate-[fadeSlideIn_0.3s_ease-out]">
          <span className="w-3 h-3 rounded-full border-2 border-cc-warning/30 border-t-cc-warning animate-spin" />
          <span className="text-xs text-cc-warning font-medium">
            Reconnecting to session...
          </span>
        </div>
      )}

      {/* Message feed */}
      <MessageFeed sessionId={sessionId} />

      {/* AI auto-resolved notification (most recent only) */}
      {aiResolved && aiResolved.length > 0 && (
        <div className="shrink-0 border-t border-cc-border bg-cc-card">
          <AiValidationBadge
            entry={aiResolved[aiResolved.length - 1]}
            onDismiss={() => clearAiResolvedPermissions(sessionId)}
          />
        </div>
      )}

      {/* Permission banners OR BlockerBanner — only one occupies this slot.
          Permission-first stacking (PLAN T15.3): tool-call decisions trump
          findings; the blocker waits in the Observer panel until permission
          is resolved. */}
      {perms.length > 0 ? (
        <div className="shrink-0 max-h-[60dvh] overflow-y-auto border-t border-cc-border bg-cc-card">
          {perms.map((p) => (
            <PermissionBanner key={p.request_id} permission={p} sessionId={sessionId} />
          ))}
        </div>
      ) : topBlocker ? (
        <div className="shrink-0 border-t border-cc-border bg-cc-card">
          <BlockerBanner finding={topBlocker} onDismiss={dismissStop} />
        </div>
      ) : null}

      {/* Composer — suppressed for the observer half of a Council pair.
          The toggle's set_permission_mode would be rejected server-side
          (ws-bridge observer-guard) and the observer has no user-driven
          chat input by design. */}
      {!isObserver && <Composer sessionId={sessionId} />}
    </div>
  );
}
