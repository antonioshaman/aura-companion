import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ChatMessage } from "../../types.js";
import type { AuthAction, TurnFailure } from "../../../server/auth-status/auth-types.js";
import { describeTurnFailure, formatAction, turnFailureFacts } from "../../../server/auth-status/auth-catalog.js";
import { useStore } from "../../store.js";
import { api } from "../../api.js";
import { createClientMessageId, sendToSession } from "../../ws.js";

/**
 * Turn-failure card (LLM auth phase 1, task 14; spec story 3). The server
 * classifies a failed turn from protocol frames into `TurnFailure`; ws.ts
 * appends it as a `systemVariant: "turn-failure"` chat message. This card is
 * its only rendering: title / detail / ONE action from the catalog, the
 * window + reset time and the other facts from `turnFailureFacts`, and the
 * provider's own text as plain text (React escapes it; never markup, never
 * links — the only link is the constant `#/diagnostics`).
 *
 * "Retry" sends the last user message once (one click, one resend, no loop);
 * "Restart the session" is only a button. Neither runs automatically.
 *
 * Not persisted: `error` frames are not in the replayed history, so the card
 * does not survive a page reload (accepted for phase 1).
 */

export type RetryState = "ready" | "sent" | "unavailable";
export type RestartState = { tag: "idle" } | { tag: "pending" } | { tag: "done" } | { tag: "failed"; message: string };

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const buttonClass =
  "px-3 py-1.5 min-h-[36px] rounded-md text-xs font-medium bg-cc-active text-cc-fg hover:bg-cc-hover cursor-pointer disabled:opacity-50 disabled:cursor-default";

function ActionRow({
  action,
  retry,
  onRetry,
  restart,
  onRestart,
}: {
  action: AuthAction;
  retry: RetryState;
  onRetry?: () => void;
  restart: RestartState;
  onRestart?: () => void;
}) {
  switch (action.kind) {
    case "retry":
      if (retry === "sent") return <p className="text-xs text-cc-muted">Sent again.</p>;
      return (
        <button type="button" className={buttonClass} onClick={onRetry} disabled={retry === "unavailable" || !onRetry}>
          {formatAction(action)}
        </button>
      );
    case "restart_session":
      if (restart.tag === "done") return <p className="text-xs text-cc-muted">Restart requested.</p>;
      return (
        <div className="space-y-1">
          <button type="button" className={buttonClass} onClick={onRestart} disabled={restart.tag === "pending" || !onRestart}>
            {restart.tag === "pending" ? "Restarting…" : formatAction(action)}
          </button>
          {restart.tag === "failed" && <p className="text-xs text-cc-error">Restart failed: {restart.message}</p>}
        </div>
      );
    case "open_status":
      return (
        <a href="#/diagnostics" className="text-xs font-medium text-cc-primary underline underline-offset-2">
          {formatAction(action)}
        </a>
      );
    case "relogin":
    case "update_cli":
    case "run_as_root":
    case "run_as_service_user":
      return <p className="text-xs text-cc-fg break-words">{formatAction(action)}</p>;
    case "none":
      return null;
    default: {
      const never: never = action;
      throw new Error(`unhandled turn-failure action ${JSON.stringify(never)}`);
    }
  }
}

export function TurnFailureCard({
  failure,
  retry = "unavailable",
  onRetry,
  restart = { tag: "idle" },
  onRestart,
}: {
  failure: TurnFailure;
  retry?: RetryState;
  onRetry?: () => void;
  restart?: RestartState;
  onRestart?: () => void;
}) {
  const titleId = useId();
  const entry = describeTurnFailure(failure.kind, failure.provider);
  const facts = turnFailureFacts(failure, formatTime);
  return (
    <div
      role="group"
      aria-labelledby={titleId}
      data-testid="turn-failure-card"
      data-kind={failure.kind}
      className="my-1 rounded-lg border border-cc-error/40 bg-cc-error/5 px-3.5 py-3 space-y-1.5"
    >
      <p id={titleId} className="text-[13px] font-semibold text-cc-error">
        {entry.title}
      </p>
      <p className="text-xs text-cc-fg">{entry.detail}</p>
      {facts.length > 0 && (
        <ul className="text-xs text-cc-fg space-y-0.5">
          {facts.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      )}
      {failure.providerMessage && (
        <p className="text-[11px] text-cc-muted font-mono-code whitespace-pre-wrap break-words" data-testid="turn-failure-provider-message">
          {failure.providerMessage}
        </p>
      )}
      <ActionRow action={entry.action} retry={retry} onRetry={onRetry} restart={restart} onRestart={onRestart} />
    </div>
  );
}

/**
 * Store-connected card for one chat message. Retry is offered only while the
 * failed turn is still the latest one (no user message after the card) and
 * the CLI is connected; after one click the button is gone.
 */
export function TurnFailureNotice({ sessionId, message }: { sessionId: string; message: ChatMessage }) {
  const failure = message.turnFailure;
  const messages = useStore((s) => s.messages.get(sessionId));
  const cliConnected = useStore((s) => s.cliConnected.get(sessionId) ?? false);
  const [retried, setRetried] = useState(false);
  const [restart, setRestart] = useState<RestartState>({ tag: "idle" });
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const list = messages ?? [];
  const at = list.findIndex((m) => m.id === message.id);
  const before = at >= 0 ? list.slice(0, at) : list;
  const lastUser = [...before].reverse().find((m) => m.role === "user") ?? null;
  const superseded = at >= 0 && list.slice(at + 1).some((m) => m.role === "user");

  const onRetry = useCallback(() => {
    if (retried || !lastUser) return;
    setRetried(true);
    const clientMsgId = createClientMessageId();
    sendToSession(sessionId, {
      type: "user_message",
      content: lastUser.content,
      session_id: sessionId,
      images: lastUser.images && lastUser.images.length > 0 ? lastUser.images : undefined,
      client_msg_id: clientMsgId,
    });
    useStore.getState().appendMessage(sessionId, {
      id: clientMsgId,
      role: "user",
      content: lastUser.content,
      images: lastUser.images,
      timestamp: Date.now(),
    });
  }, [retried, lastUser, sessionId]);

  const onRestart = useCallback(() => {
    setRestart({ tag: "pending" });
    api.relaunchSession(sessionId).then(
      () => {
        if (mounted.current) setRestart({ tag: "done" });
      },
      (err: unknown) => {
        if (mounted.current) setRestart({ tag: "failed", message: err instanceof Error && err.message ? err.message : "the request failed" });
      },
    );
  }, [sessionId]);

  if (!failure) return null;
  const retry: RetryState = retried ? "sent" : !lastUser || superseded || !cliConnected ? "unavailable" : "ready";
  return <TurnFailureCard failure={failure} retry={retry} onRetry={onRetry} restart={restart} onRestart={onRestart} />;
}
