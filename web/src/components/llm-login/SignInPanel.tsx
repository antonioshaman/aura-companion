import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { api, type RestLoginAttempt } from "../../api.js";
import { useStore } from "../../store.js";
import { isTerminalLoginState, type AuthAction, type ProviderAuthStatus, type ProviderId } from "../../../server/auth-status/auth-types.js";
import {
  describeSessionRenewal,
  describeEffectiveMethod,
  describeLoginAttempt,
  describeLoginFailure,
  describeLoginInProgressElsewhere,
  describePlanCheck,
  formatAction,
  formatKnown,
  providerLabel,
  verifiedByLabel,
} from "../../../server/auth-status/auth-catalog.js";
import { useLoginAttempt, type LoginAttemptView, type LoginNotice } from "./useLoginAttempt.js";
import { notePromotedFromStatus } from "./sign-in-restored.js";
import { linkButtonClass, primaryButtonClass, secondaryButtonClass } from "../ui/buttons.js";

/**
 * The sign-in window (LLM auth phase 2c, task 11; spec story 1). ONE window
 * and one state machine for every entry point (Diagnostics card, turn-failure
 * card, usage-limits reason): they all call `openLoginDialog(provider)` and
 * `SignInHost` (mounted once in App) renders this panel.
 *
 * Non-modal. "Close" hides it while the attempt runs (a chip stays: "Sign-in
 * in progress · until 14:35 · Continue / Cancel sign-in"); "Cancel sign-in"
 * ends the attempt on the server. The link and codes appear only here: never
 * in toasts, the document title, notifications or any stored state; the
 * server stops sending them once the attempt ends. Texts come from the
 * shared catalog (the same words `aura-companion auth login` prints).
 */


/** After this long in `starting`, say so (the CLI is slow, not stuck). */
export const SLOW_START_MS = 10_000;

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** "Valid until 14:35 · 12 min left" (whole minutes, rounded up). */
export function expiryText(expiresAt: number, now: number): string {
  const left = expiresAt - now;
  if (left <= 0) return `Valid until ${clock(expiresAt)} · time is up`;
  return `Valid until ${clock(expiresAt)} · ${Math.ceil(left / 60_000)} min left`;
}

function noticeText(n: LoginNotice): string {
  switch (n.kind) {
    case "unauthorized":
      return "This browser has no Aura access token, so it cannot sign in. Open Aura with its token link (run `aura-companion token` on the server, as the user Aura runs as) and try again.";
    case "forbidden":
      return "This page's address is not allowed to sign in. Add it to COMPANION_ALLOWED_ORIGIN or open Aura at its usual address.";
    case "cooldown":
      return `A sign-in just ended. You can start a new one in ${Math.max(1, Math.ceil(n.retryAfterMs / 1000))} s.`;
    case "network":
      return "No connection to Aura — the window may be out of date. Retrying…";
    case "http":
      return `The sign-in request failed (HTTP ${n.status}${n.error ? `: ${n.error}` : ""}).`;
    default: {
      const never: never = n;
      throw new Error(`unhandled sign-in notice ${JSON.stringify(never)}`);
    }
  }
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const onClick = () => {
    const clip = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    if (!clip) {
      setState("failed");
      return;
    }
    clip.writeText(value).then(
      () => setState("copied"),
      () => setState("failed"),
    );
  };
  return (
    <button type="button" className={secondaryButtonClass} onClick={onClick}>
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed — select it by hand" : label}
    </button>
  );
}

/** The one recovery action of a finished attempt. `sign_in` is a button; the rest are instructions. */
function RecoveryAction({ action, onStartAgain }: { action: AuthAction; onStartAgain?: () => void }) {
  switch (action.kind) {
    case "sign_in":
      return (
        <button type="button" className={primaryButtonClass} onClick={onStartAgain} disabled={!onStartAgain}>
          Start again
        </button>
      );
    case "update_cli":
    case "install_cli":
    case "run_as_service_user":
    case "run_as_root":
    case "restart_session":
    case "open_status":
    case "retry":
      return <p className="text-xs text-cc-fg break-words">{formatAction(action)}</p>;
    case "none":
      return null;
    default: {
      const never: never = action;
      throw new Error(`unhandled sign-in action ${JSON.stringify(never)}`);
    }
  }
}

function ReplyCodeForm({
  attempt,
  pending,
  onSubmitCode,
}: {
  attempt: RestLoginAttempt;
  pending: boolean;
  onSubmitCode?: (code: string) => void;
}) {
  const [code, setCode] = useState("");
  const inputId = useId();
  const hintId = useId();
  const errorId = useId();
  const busy = pending || attempt.submitting;
  const err = attempt.codeError ? describeLoginFailure(attempt.codeError, attempt.provider) : null;
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const value = code.trim();
    if (!value || busy || !onSubmitCode) return;
    // The input keeps its value: a refused code stays editable.
    onSubmitCode(value);
  };
  return (
    <form onSubmit={onSubmit} className="space-y-1.5" data-testid="sign-in-reply-code">
      <label htmlFor={inputId} className="block text-xs font-medium text-cc-fg">
        Code from the sign-in page
      </label>
      <div className="flex gap-2">
        <input
          id={inputId}
          type="text"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          aria-describedby={err ? `${hintId} ${errorId}` : hintId}
          aria-invalid={err ? true : undefined}
          className="min-w-0 flex-1 rounded-md border border-cc-border bg-cc-bg px-2 py-1.5 text-xs font-mono-code text-cc-fg"
        />
        {/* aria-disabled while checking, not `disabled`: a disabled focused
            button drops keyboard focus to <body> (watson P2-3/P2-4); onSubmit
            already ignores a submit while busy. */}
        <button
          type="submit"
          className={primaryButtonClass}
          disabled={code.trim() === "" || !onSubmitCode}
          aria-disabled={busy || undefined}
        >
          {busy ? "Checking…" : "Submit code"}
        </button>
      </div>
      <p id={hintId} className="text-[11px] text-cc-muted">
        Paste the whole code, including the part after “#”.
      </p>
      {err && (
        // role="alert": a refused code is spoken at once, not only when the
        // input is focused again (watson P2-3).
        <div id={errorId} role="alert" className="text-xs text-cc-error">
          <p className="font-medium">{err.title}</p>
          <p>
            {err.detail} {attempt.submissionsLeft > 0 ? `${attempt.submissionsLeft} tries left.` : "No tries left — start again."}
          </p>
        </div>
      )}
    </form>
  );
}

function AwaitingUser({
  attempt,
  view,
  now,
  onSubmitCode,
}: {
  attempt: RestLoginAttempt;
  view: LoginAttemptView;
  now: number;
  onSubmitCode?: (code: string) => void;
}) {
  const prompt = attempt.prompt;
  return (
    <div className="space-y-3">
      {prompt && (
        <div className="flex flex-wrap gap-2">
          <a href={prompt.url} target="_blank" rel="noopener noreferrer" className={primaryButtonClass}>
            Open the sign-in page
          </a>
          <CopyButton value={prompt.url} label="Copy link" />
        </div>
      )}
      {attempt.steps.deviceCode && prompt?.userCode && (
        <div className="space-y-1" data-testid="sign-in-device-code">
          <p className="text-xs text-cc-muted">Enter this code on the page</p>
          <div className="flex items-center gap-3">
            <p className="text-2xl font-mono-code font-semibold tracking-widest text-cc-fg">{prompt.userCode}</p>
            <CopyButton value={prompt.userCode} label="Copy code" />
          </div>
        </div>
      )}
      {attempt.steps.replyCode && <ReplyCodeForm attempt={attempt} pending={view.pending === "code"} onSubmitCode={onSubmitCode} />}
      <p className="text-xs text-cc-muted tabular-nums" data-testid="sign-in-expiry">
        {expiryText(attempt.expiresAt, now)}
        {/* Codex has no code to submit: the window polls the provider's answer. */}
        {!attempt.steps.replyCode && view.lastPolledAt !== null
          ? ` · checked ${Math.max(0, Math.round((now - view.lastPolledAt) / 1000))} s ago`
          : ""}
      </p>
    </div>
  );
}

/**
 * What the live sessions do about this sign-in (phase 2d): during
 * `verifying` the Claude barrier may wait for running turns; after success,
 * how many sessions move to the new sign-in and how many wait for Retry.
 */
function RenewalLines({ attempt, phase }: { attempt: RestLoginAttempt; phase: "verifying" | "succeeded" }) {
  if (!attempt.renewal) return null;
  const lines = describeSessionRenewal(attempt.provider, attempt.renewal, phase);
  if (lines.length === 0) return null;
  return (
    <ul className="space-y-0.5 text-xs" data-testid="sign-in-renewal">
      {lines.map((l) => (
        <li key={l.text} className={l.warning ? "text-cc-warning" : "text-cc-muted"}>
          {l.text}
        </li>
      ))}
    </ul>
  );
}

function Succeeded({
  attempt,
  status,
  onStartAgain,
}: {
  attempt: RestLoginAttempt;
  status: ProviderAuthStatus | null;
  onStartAgain?: () => void;
}) {
  const plan = status && status.planCheck ? describePlanCheck(status.planCheck, attempt.provider, status.expectedPlan ?? null, status.plan) : null;
  const method = status?.effectiveMethod ? describeEffectiveMethod(status.effectiveMethod, attempt.provider) : null;
  const methodWarn = status?.effectiveMethod ? status.effectiveMethod.source !== "sign_in" : false;
  const methodNote = status?.effectiveMethod ? methodWarn || Boolean(status.effectiveMethod.alsoSet) : false;
  return (
    <div className="space-y-2">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        <dt className="text-cc-muted">Account</dt>
        <dd className="text-cc-fg break-all">{formatKnown(attempt.result?.account ?? { known: false })}</dd>
        <dt className="text-cc-muted">Plan</dt>
        <dd className="text-cc-fg">{formatKnown(attempt.result?.plan ?? { known: false })}</dd>
        {status && (
          <>
            <dt className="text-cc-muted">Status</dt>
            <dd className="text-cc-fg">
              {status.state === "working" ? "working" : status.state} · checked {verifiedByLabel(status.verifiedBy)}
            </dd>
          </>
        )}
      </dl>
      {plan && status?.planCheck !== "unset" && (
        <div
          data-testid="sign-in-plan-check"
          data-check={status?.planCheck}
          className={`text-xs ${status?.planCheck === "mismatch" ? "text-cc-warning" : "text-cc-muted"}`}
        >
          <p className="font-medium">{plan.title}</p>
          <p className="text-cc-muted">{plan.detail}</p>
          {status?.planCheck === "mismatch" && (
            <div className="mt-1.5 space-y-1">
              <button type="button" className={secondaryButtonClass} onClick={onStartAgain} disabled={!onStartAgain}>
                Sign in with another account
              </button>
              <p className="text-[11px] text-cc-muted">Sign out at the provider first, or open the link in a private window.</p>
            </div>
          )}
        </div>
      )}
      <RenewalLines attempt={attempt} phase="succeeded" />
      {method && methodNote && (
        <div data-testid="sign-in-effective-method" className={`text-xs ${methodWarn ? "text-cc-warning" : "text-cc-muted"}`}>
          <p className="font-medium">{method.title}</p>
          <p className="text-cc-muted">{method.detail}</p>
        </div>
      )}
    </div>
  );
}

function StateBody({
  view,
  now,
  status,
  onSubmitCode,
  onStartAgain,
}: {
  view: LoginAttemptView;
  now: number;
  status: ProviderAuthStatus | null;
  onSubmitCode?: (code: string) => void;
  onStartAgain?: () => void;
}) {
  const a = view.attempt;
  if (!a) {
    if (!view.loaded) return null;
    return (
      <div className="space-y-2">
        <p className="text-xs text-cc-muted">No sign-in is running.</p>
        <button type="button" className={primaryButtonClass} onClick={onStartAgain} disabled={!onStartAgain}>
          Start sign-in
        </button>
      </div>
    );
  }
  switch (a.state) {
    case "starting":
      return now - a.startedAt > SLOW_START_MS ? <p className="text-xs text-cc-muted">Still starting… The CLI is taking longer than usual.</p> : null;
    case "awaiting_user":
      return <AwaitingUser attempt={a} view={view} now={now} onSubmitCode={onSubmitCode} />;
    case "verifying":
      return <RenewalLines attempt={a} phase="verifying" />;
    case "succeeded":
      return <Succeeded attempt={a} status={status} onStartAgain={onStartAgain} />;
    case "failed": {
      const e = a.failure ? describeLoginFailure(a.failure, a.provider) : describeLoginAttempt("failed", a.provider);
      return (
        <div className="space-y-2" data-testid="sign-in-failure" data-reason={a.failure ?? undefined}>
          <p className="text-xs text-cc-fg">{e.detail}</p>
          <RecoveryAction action={e.action} onStartAgain={onStartAgain} />
        </div>
      );
    }
    case "cancelled":
    case "expired":
      return <RecoveryAction action={describeLoginAttempt(a.state, a.provider).action} onStartAgain={onStartAgain} />;
    default: {
      const never: never = a.state;
      throw new Error(`unhandled sign-in state ${String(never)}`);
    }
  }
}

/** Title + detail line for the live region: the attempt's state, or "starting" before the first answer. */
function headline(provider: ProviderId, view: LoginAttemptView) {
  const a = view.attempt;
  if (!a) return view.loaded ? null : describeLoginAttempt("starting", provider);
  if (a.state === "failed" && a.failure) return { ...describeLoginFailure(a.failure, provider), detail: "" };
  const e = describeLoginAttempt(a.state, provider);
  // failed/cancelled/expired print their detail inside the body.
  return a.state === "failed" ? { ...e, detail: "" } : e;
}

export interface SignInPanelProps {
  provider: ProviderId;
  view: LoginAttemptView;
  now: number;
  /** The provider's status after a successful sign-in (plan check, method). */
  status?: ProviderAuthStatus | null;
  onSubmitCode?: (code: string) => void;
  onCancel?: () => void;
  /** Hide (running attempt) or dismiss (finished / nothing running). */
  onClose?: () => void;
  onStartAgain?: () => void;
  headingRef?: RefObject<HTMLHeadingElement | null>;
  containerRef?: RefObject<HTMLElement | null>;
}

/** Presentational: everything the window shows, for tests and the Playground. */
export function SignInPanel({ provider, view, now, status = null, onSubmitCode, onCancel, onClose, onStartAgain, headingRef, containerRef }: SignInPanelProps) {
  const headingId = useId();
  const [ackElsewhere, setAckElsewhere] = useState(false);
  const a = view.attempt;
  const running = a ? !isTerminalLoginState(a.state) : false;
  const head = headline(provider, view);
  const cancellable = a !== null && (a.state === "starting" || a.state === "awaiting_user");
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && onClose) {
      e.stopPropagation();
      onClose();
    }
  };
  return (
    <section
      ref={containerRef}
      role="dialog"
      aria-modal="false"
      aria-labelledby={headingId}
      onKeyDown={onKeyDown}
      data-testid="sign-in-panel"
      data-provider={provider}
      data-state={a?.state ?? (view.loaded ? "none" : "loading")}
      className="w-[min(28rem,calc(100vw-2rem))] rounded-xl border border-cc-border bg-cc-elevated p-4 shadow-lg space-y-3"
    >
      <div className="flex items-start justify-between gap-3">
        <h2 id={headingId} ref={headingRef} tabIndex={-1} className="text-sm font-semibold text-cc-fg outline-none">
          Sign in to {providerLabel(provider)}
        </h2>
        <button type="button" className={secondaryButtonClass} onClick={onClose} disabled={!onClose}>
          Close
        </button>
      </div>

      {view.existing && running && !ackElsewhere && (
        <div className="rounded-md border border-cc-border bg-cc-bg px-3 py-2 space-y-1.5" data-testid="sign-in-elsewhere">
          <p className="text-xs font-medium text-cc-fg">{describeLoginInProgressElsewhere(provider).title}</p>
          <p className="text-[11px] text-cc-muted">{describeLoginInProgressElsewhere(provider).detail}</p>
          <div className="flex gap-2">
            <button type="button" className={secondaryButtonClass} onClick={() => setAckElsewhere(true)}>
              Continue here
            </button>
            <button type="button" className={secondaryButtonClass} onClick={onCancel} disabled={!onCancel || view.pending === "cancel"}>
              Cancel sign-in
            </button>
          </div>
        </div>
      )}

      <div aria-live="polite" className="space-y-0.5">
        {head && (
          <>
            <p className={`text-[13px] font-medium ${a?.state === "succeeded" ? "text-cc-success" : a && isTerminalLoginState(a.state) ? "text-cc-error" : "text-cc-fg"}`}>
              {head.title}
            </p>
            {head.detail && <p className="text-xs text-cc-muted">{head.detail}</p>}
          </>
        )}
      </div>

      <StateBody view={view} now={now} status={status} onSubmitCode={onSubmitCode} onStartAgain={onStartAgain} />

      {view.notice && (
        <p className="text-[11px] text-cc-warning" role="status">
          {noticeText(view.notice)}
        </p>
      )}

      <div className="flex justify-end gap-2 pt-1">
        {cancellable && (
          <button type="button" className={secondaryButtonClass} onClick={onCancel} disabled={!onCancel || view.pending === "cancel"}>
            {view.pending === "cancel" ? "Cancelling…" : "Cancel sign-in"}
          </button>
        )}
        {a?.state === "succeeded" && (
          <button type="button" className={secondaryButtonClass} onClick={onClose} disabled={!onClose}>
            Done
          </button>
        )}
      </div>
    </section>
  );
}

/** The chip a closed-but-running window leaves behind. */
export function SignInChip({
  provider,
  attempt,
  onOpen,
  onCancel,
  onDismiss,
  openRef,
}: {
  provider: ProviderId;
  attempt: RestLoginAttempt | null;
  onOpen?: () => void;
  onCancel?: () => void;
  onDismiss?: () => void;
  openRef?: RefObject<HTMLButtonElement | null>;
}) {
  const running = attempt ? !isTerminalLoginState(attempt.state) : true;
  let text: ReactNode;
  if (!attempt) text = `${providerLabel(provider)} sign-in`;
  else if (running) text = `${providerLabel(provider)} sign-in in progress · until ${clock(attempt.expiresAt)}`;
  else text = describeLoginAttempt(attempt.state, provider).title;
  return (
    <div
      role="region"
      aria-label={`${providerLabel(provider)} sign-in`}
      data-testid="sign-in-chip"
      className="flex flex-wrap items-center gap-2 rounded-full border border-cc-border bg-cc-elevated px-3 py-1.5 shadow-lg text-xs text-cc-fg"
    >
      {/* A status region mounted with the chip: once the window is closed to
          the chip, "Signed in" / "Sign-in failed" is spoken (watson P2-2). */}
      <span role="status" className="tabular-nums">{text}</span>
      <button ref={openRef} type="button" className={linkButtonClass} onClick={onOpen}>
        {running ? "Continue" : "Show"}
      </button>
      {running ? (
        attempt && (
          <button type="button" className={linkButtonClass} onClick={onCancel}>
            Cancel sign-in
          </button>
        )
      ) : (
        <button type="button" className={linkButtonClass} onClick={onDismiss}>
          Dismiss
        </button>
      )}
    </div>
  );
}

/**
 * Where focus goes when the window disappears and its opener is gone (the
 * page changed under it): another sign-in entry point, else the chat input,
 * else the first focusable control — never <body> (EC-39, observer review 204).
 */
function fallbackFocusTarget(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return (
    document.querySelector<HTMLElement>('[data-testid^="sign-in-button-"]') ??
    document.querySelector<HTMLElement>("textarea:not([disabled])") ??
    document.querySelector<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')
  );
}

/** Wallclock for the countdown (EC-11): ticks once a second while mounted. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function SignInSession({ provider, intent, collapsed }: { provider: ProviderId; intent: "start" | "resume"; collapsed: boolean }) {
  const { view, start, submitCode, cancel } = useLoginAttempt(provider, intent);
  const [status, setStatus] = useState<ProviderAuthStatus | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const containerRef = useRef<HTMLElement>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  // The button that opened the window gets focus back on every close path (EC-39).
  const opener = useRef<HTMLElement | null>(null);
  const a = view.attempt;
  const running = a ? !isTerminalLoginState(a.state) : !view.loaded;
  const now = useNow(running && !collapsed);

  useEffect(() => {
    if (collapsed) return;
    const active = typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null;
    if (active && active !== document.body && !containerRef.current?.contains(active)) opener.current = active;
    headingRef.current?.focus();
  }, [collapsed]);

  // A successful sign-in: read the provider's status once for the plan check
  // and the method sessions really use (S2). Nothing else is fetched.
  const succeededId = a?.state === "succeeded" ? a.id : null;
  useEffect(() => {
    if (!succeededId) return;
    let live = true;
    api.llmAuthStatus().then(
      (r) => {
        // Every open chat's sign-in failure card can now say "sign-in restored".
        notePromotedFromStatus(r.status);
        if (live) setStatus(r.status?.providers[provider] ?? null);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [succeededId, provider]);

  const restoreFocus = useCallback((fallback: () => HTMLElement | null) => {
    requestAnimationFrame(() => {
      const target = opener.current?.isConnected ? opener.current : fallback();
      target?.focus();
    });
  }, []);

  const onClose = useCallback(() => {
    const store = useStore.getState();
    if (running) {
      store.collapseLoginDialog();
      restoreFocus(() => chipRef.current);
    } else {
      store.closeLoginDialog();
      restoreFocus(fallbackFocusTarget);
    }
  }, [running, restoreFocus]);

  if (collapsed) {
    return (
      <SignInChip
        provider={provider}
        attempt={a}
        openRef={chipRef}
        onOpen={() => useStore.getState().openLoginDialog(provider, intent)}
        onCancel={cancel}
        onDismiss={() => {
          useStore.getState().closeLoginDialog();
          restoreFocus(fallbackFocusTarget);
        }}
      />
    );
  }
  return (
    <SignInPanel
      provider={provider}
      view={view}
      now={now}
      status={status}
      onSubmitCode={submitCode}
      onCancel={cancel}
      onClose={onClose}
      onStartAgain={() => void start()}
      headingRef={headingRef}
      containerRef={containerRef}
    />
  );
}

/**
 * The same sign-in, embedded in a host that owns its own layout (the
 * first-run wizard). `SignInHost` renders under a modal, so the wizard
 * cannot open the global window; it mounts this instead. Closing here while
 * the attempt runs cancels it — there is no chip to come back to.
 * `onSucceeded` fires once with the provider's fresh status.
 */
export function EmbeddedSignIn({
  provider,
  onClose,
  onSucceeded,
}: {
  provider: ProviderId;
  onClose: () => void;
  onSucceeded: (status: ProviderAuthStatus | null) => void;
}) {
  const { view, start, submitCode, cancel } = useLoginAttempt(provider, "start");
  const [status, setStatus] = useState<ProviderAuthStatus | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const a = view.attempt;
  const running = a ? !isTerminalLoginState(a.state) : !view.loaded;
  const now = useNow(running);
  const onSucceededRef = useRef(onSucceeded);
  onSucceededRef.current = onSucceeded;

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const succeededId = a?.state === "succeeded" ? a.id : null;
  useEffect(() => {
    if (!succeededId) return;
    let live = true;
    api.llmAuthStatus().then(
      (r) => {
        notePromotedFromStatus(r.status);
        const s = r.status?.providers[provider] ?? null;
        if (!live) return;
        setStatus(s);
        onSucceededRef.current(s);
      },
      () => {
        if (live) onSucceededRef.current(null);
      },
    );
    return () => {
      live = false;
    };
  }, [succeededId, provider]);

  const close = useCallback(() => {
    if (a && (a.state === "starting" || a.state === "awaiting_user")) cancel();
    onClose();
  }, [a, cancel, onClose]);

  return (
    <SignInPanel
      provider={provider}
      view={view}
      now={now}
      status={status}
      onSubmitCode={submitCode}
      onCancel={cancel}
      onClose={close}
      onStartAgain={() => void start()}
      headingRef={headingRef}
    />
  );
}

/** Mounted once in App: the window (or chip) for the provider in `loginDialog`. */
export function SignInHost() {
  const dialog = useStore((s) => s.loginDialog);
  if (!dialog) return null;
  return (
    <div className="fixed bottom-4 right-4 z-50 flex justify-end">
      <SignInSession key={`${dialog.provider}:${dialog.intent}`} provider={dialog.provider} intent={dialog.intent} collapsed={dialog.collapsed} />
    </div>
  );
}
