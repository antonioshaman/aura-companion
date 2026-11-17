import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ChatMessage } from "../../types.js";
import type { AuthAction, TurnFailure } from "../../../server/auth-status/auth-types.js";
import {
  describeSignInRestored,
  describeTurnFailure,
  describeTurnNeedsRetry,
  formatAction,
  turnFailureFacts,
} from "../../../server/auth-status/auth-catalog.js";
import { useStore } from "../../store.js";
import { api } from "../../api.js";
import { createClientMessageId, sendToSession } from "../../ws.js";
import { SignInButton } from "../llm-login/SignInButton.js";
import { ensurePromotedAtLoaded, turnFailureRecovery } from "../llm-login/sign-in-restored.js";
import { secondaryButtonClass } from "../ui/buttons.js";

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
 * Phase 2c (task 12): the `sign_in` action opens the sign-in window. After a
 * later successful sign-in the card turns into "sign-in restored" with Retry
 * as the main action (`recovery: "restored"`, computed by a selector — the
 * stored failure is never rewritten, a failed or cancelled sign-in changes
 * nothing). `retry_needed` = the turn ran while the sign-in changed (S3-AC3;
 * the signal arrives in phase 2d). An observer of a Council pair is labelled.
 *
 * Survives a reload: the server keeps `error` frames that carry a
 * `turnFailure` in the session history, and ws.ts rebuilds the card from it.
 */

export type RetryState = "ready" | "sent" | "unavailable";
/** none = the failure as classified; restored / retry_needed = after a sign-in (phase 2c/2d). */
export type FailureRecovery = "none" | "restored" | "retry_needed";
export type RestartState = { tag: "idle" } | { tag: "pending" } | { tag: "done" } | { tag: "failed"; message: string };

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}


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
      if (retry === "sent") return <Outcome text="Sent again." />;
      return (
        <button type="button" className={secondaryButtonClass} onClick={onRetry} disabled={retry === "unavailable" || !onRetry}>
          {formatAction(action)}
        </button>
      );
    case "restart_session":
      if (restart.tag === "done") return <Outcome text="Restart requested." />;
      return (
        <div className="space-y-1">
          {/* aria-disabled while pending: `disabled` on the focused button drops focus to <body> (watson P2-4). */}
          <button
            type="button"
            className={secondaryButtonClass}
            onClick={restart.tag === "pending" ? undefined : onRestart}
            disabled={!onRestart}
            aria-disabled={restart.tag === "pending" || undefined}
          >
            {restart.tag === "pending" ? "Restarting…" : formatAction(action)}
          </button>
          {restart.tag === "failed" && <p role="alert" className="text-xs text-cc-error">Restart failed: {restart.message}</p>}
        </div>
      );
    case "open_status":
      return (
        <a href="#/diagnostics" className="text-xs font-medium link-primary-aa underline underline-offset-2">
          {formatAction(action)}
        </a>
      );
    case "sign_in":
      return <SignInButton provider={action.provider} mode="sign_in_again" className={secondaryButtonClass} />;
    case "update_cli":
    case "install_cli":
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

/**
 * What replaces a Retry / Restart button once it did its job. Spoken (status),
 * and it takes focus when the clicked button vanished from under it — else
 * focus would fall to <body> (watson P2-4).
 */
function Outcome({ text }: { text: string }) {
  return (
    <p
      role="status"
      tabIndex={-1}
      ref={(el) => {
        if (el && (document.activeElement === null || document.activeElement === document.body)) el.focus();
      }}
      className="text-xs text-cc-muted outline-none"
    >
      {text}
    </p>
  );
}

function recoveryEntry(recovery: FailureRecovery, failure: TurnFailure) {
  switch (recovery) {
    case "none":
      return describeTurnFailure(failure.kind, failure.provider);
    case "restored":
      return describeSignInRestored(failure.provider);
    case "retry_needed":
      return describeTurnNeedsRetry(failure.provider);
    default: {
      const never: never = recovery;
      throw new Error(`unhandled turn-failure recovery ${String(never)}`);
    }
  }
}

export function TurnFailureCard({
  failure,
  retry = "unavailable",
  onRetry,
  restart = { tag: "idle" },
  onRestart,
  recovery = "none",
  observer = false,
}: {
  failure: TurnFailure;
  retry?: RetryState;
  onRetry?: () => void;
  restart?: RestartState;
  onRestart?: () => void;
  recovery?: FailureRecovery;
  /** The session is the observer half of a Council pair. */
  observer?: boolean;
}) {
  const titleId = useId();
  const entry = recoveryEntry(recovery, failure);
  const recovered = recovery !== "none";
  const facts = recovered ? [] : turnFailureFacts(failure, formatTime);
  return (
    <div
      role="group"
      aria-labelledby={titleId}
      data-testid="turn-failure-card"
      data-kind={failure.kind}
      data-recovery={recovery}
      className={`my-1 rounded-lg border px-3.5 py-3 space-y-1.5 ${
        recovery === "restored" ? "border-cc-success/40 bg-cc-success/5" : "border-cc-error/40 bg-cc-error/5"
      }`}
    >
      <div className="flex items-start gap-2">
        <p id={titleId} className={`text-[13px] font-semibold ${recovery === "restored" ? "text-cc-success" : "text-cc-error"}`}>
          {entry.title}
        </p>
        {observer && (
          <span className="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium bg-cc-active text-cc-muted">Observer</span>
        )}
      </div>
      <p className="text-xs text-cc-fg">{entry.detail}</p>
      {recovered && (
        <p className="text-[11px] text-cc-muted">Failed earlier: {describeTurnFailure(failure.kind, failure.provider).title}</p>
      )}
      {facts.length > 0 && (
        <ul className="text-xs text-cc-fg space-y-0.5">
          {facts.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      )}
      {/* A restored / retry card keeps its history in "Failed earlier"; the
          raw provider text is a red-world artefact there (saarinen S-12). */}
      {failure.providerMessage && recovery === "none" && (
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
function indexOfId(list: readonly ChatMessage[], id: string): number {
  for (let i = list.length - 1; i >= 0; i--) if (list[i].id === id) return i;
  return -1;
}

/** Id of the newest user message before the card (or in the whole list if the card is not in it). */
function lastUserIdBefore(list: readonly ChatMessage[] | undefined, cardId: string): string | null {
  if (!list) return null;
  const at = indexOfId(list, cardId);
  for (let i = (at >= 0 ? at : list.length) - 1; i >= 0; i--) if (list[i].role === "user") return list[i].id;
  return null;
}

/** A user message came after the card (the turn was already repeated or replaced). */
function userMessageAfter(list: readonly ChatMessage[] | undefined, cardId: string): boolean {
  if (!list) return false;
  const at = indexOfId(list, cardId);
  if (at < 0) return false;
  for (let i = at + 1; i < list.length; i++) if (list[i].role === "user") return true;
  return false;
}

export function TurnFailureNotice({ sessionId, message }: { sessionId: string; message: ChatMessage }) {
  const failure = message.turnFailure;
  // Narrow selectors returning primitives (abramov A3): subscribing to the
  // whole message array re-rendered every failure card on every streamed token.
  const lastUserId = useStore((s) => lastUserIdBefore(s.messages.get(sessionId), message.id));
  const superseded = useStore((s) => userMessageAfter(s.messages.get(sessionId), message.id));
  const cliConnected = useStore((s) => s.cliConnected.get(sessionId) ?? false);
  const observer = useStore((s) => s.sessions.get(sessionId)?.sessionGroupRole) === "observer";
  const promotedAt = useStore((s) => s.llmAuthPromotedAt);
  const signInFailure = failure ? describeTurnFailure(failure.kind, failure.provider).action.kind === "sign_in" || failure.kind === "stale_session_credentials" : false;
  // A sign-in failure card needs the last promotion time (one status read per page).
  useEffect(() => {
    if (signInFailure) void ensurePromotedAtLoaded();
  }, [signInFailure]);
  const [retried, setRetried] = useState(false);
  const [restart, setRestart] = useState<RestartState>({ tag: "idle" });
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const onRetry = useCallback(() => {
    if (retried || !lastUserId) return;
    const lastUser = useStore.getState().messages.get(sessionId)?.find((m) => m.id === lastUserId);
    if (!lastUser) return;
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
  }, [retried, lastUserId, sessionId]);

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
  const retry: RetryState = retried ? "sent" : !lastUserId || superseded || !cliConnected ? "unavailable" : "ready";
  const recovery: FailureRecovery = turnFailureRecovery(failure, message.timestamp, promotedAt);
  return (
    <TurnFailureCard
      failure={failure}
      retry={retry}
      onRetry={onRetry}
      restart={restart}
      onRestart={onRestart}
      recovery={recovery}
      observer={observer}
    />
  );
}
