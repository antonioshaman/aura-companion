import { useEffect, useRef, useState } from "react";
import { useStore } from "../../store.js";
import { describeSessionReconnectFailed, describeSessionReconnecting } from "../../../server/auth-status/auth-catalog.js";
import type { CredentialRenewalRecord } from "../../../server/session-types.js";

/**
 * In-session notice while a live session moves to a new sign-in (LLM auth
 * phase 2d, task 14). Driven by the session's persisted `credential_renewal`
 * record, so a reloaded tab shows it too. The composer stays usable: messages
 * typed meanwhile are held by the server and delivered once the session is
 * back — this notice only says so. `renewed` shows nothing.
 */
export function CredentialRenewalBanner({ record, live = true }: { record: CredentialRenewalRecord; live?: boolean }) {
  if (record.state === "renewed") return null;
  const failed = record.state === "failed";
  const entry = failed ? describeSessionReconnectFailed(record.provider) : describeSessionReconnecting(record.provider);
  return (
    <div
      role={live ? "status" : undefined}
      aria-live={live ? "polite" : undefined}
      data-testid="credential-renewal-notice"
      data-state={record.state}
      className={`flex items-start gap-2 px-4 py-2 text-xs ${failed ? "text-cc-warning" : "text-cc-fg"}`}
    >
      {/* A fixed 8px leading slot in both states, so the text never jumps;
          a neutral dot for a background system state (saarinen S-13). */}
      <span
        aria-hidden="true"
        className={`mt-1 inline-block h-2 w-2 shrink-0 rounded-full ${failed ? "bg-cc-warning" : "bg-cc-muted motion-safe:animate-pulse"}`}
      />
      <div className="min-w-0">
        <p className="font-medium">{entry.title}</p>
        <p className="text-cc-muted">{entry.detail}</p>
      </div>
    </div>
  );
}

/** Said once when a session the user saw reconnecting is back on the new sign-in. */
export const SESSION_RECONNECTED_TEXT = "Session reconnected with the new sign-in.";

/**
 * The live region is mounted with the chat, empty, BEFORE any renewal: screen
 * readers reliably speak only changes inside a region that already exists, so
 * a region inserted together with its first message is often missed (watson
 * P2-6). The end of a renewal the user saw is spoken too (screen-reader only).
 */
export function CredentialRenewalNotice({ sessionId }: { sessionId: string }) {
  const record = useStore((s) => s.sessions.get(sessionId)?.credential_renewal);
  const visible = record && record.state !== "renewed" ? record : null;
  const wasVisible = useRef(false);
  const [reconnected, setReconnected] = useState(false);
  useEffect(() => {
    if (visible) {
      wasVisible.current = true;
      setReconnected(false);
    } else if (wasVisible.current) {
      wasVisible.current = false;
      setReconnected(true);
    }
  }, [visible]);
  return (
    <div role="status" aria-live="polite" data-testid="credential-renewal-live" className="shrink-0">
      {visible ? (
        <div className="border-t border-cc-border bg-cc-card">
          <CredentialRenewalBanner record={visible} live={false} />
        </div>
      ) : (
        reconnected && <span className="sr-only">{SESSION_RECONNECTED_TEXT}</span>
      )}
    </div>
  );
}
