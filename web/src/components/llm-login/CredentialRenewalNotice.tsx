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
export function CredentialRenewalBanner({ record }: { record: CredentialRenewalRecord }) {
  if (record.state === "renewed") return null;
  const failed = record.state === "failed";
  const entry = failed ? describeSessionReconnectFailed(record.provider) : describeSessionReconnecting(record.provider);
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="credential-renewal-notice"
      data-state={record.state}
      className={`flex items-start gap-2 px-4 py-2 text-xs ${failed ? "text-cc-warning" : "text-cc-fg"}`}
    >
      {!failed && (
        <span aria-hidden="true" className="mt-1 inline-block h-2 w-2 shrink-0 rounded-full bg-cc-primary motion-safe:animate-pulse" />
      )}
      <div className="min-w-0">
        <p className="font-medium">{entry.title}</p>
        <p className="text-cc-muted">{entry.detail}</p>
      </div>
    </div>
  );
}

export function CredentialRenewalNotice({ sessionId }: { sessionId: string }) {
  const record = useStore((s) => s.sessions.get(sessionId)?.credential_renewal);
  if (!record || record.state === "renewed") return null;
  return (
    <div className="shrink-0 border-t border-cc-border bg-cc-card">
      <CredentialRenewalBanner record={record} />
    </div>
  );
}
