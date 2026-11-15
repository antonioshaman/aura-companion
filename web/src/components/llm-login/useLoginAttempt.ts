import { useCallback, useEffect, useRef, useState } from "react";
import { api, type LlmLoginResponse, type RestLoginAttempt } from "../../api.js";
import { isTerminalLoginState, type ProviderId } from "../../../server/auth-status/auth-types.js";

/**
 * One provider's sign-in attempt as the window sees it (LLM auth phase 2c,
 * task 11). The server owns the attempt; this hook only reads it — POST on
 * open (`start`) or GET (`resume`), then a GET every 1.5 s while it runs
 * (D4: REST polling, never WS — browser WS frames are recorded and fanned out
 * to every tab). The link and codes live only in this hook's state: nothing
 * here touches the store, the title, toasts or storage.
 *
 * Late answers (EC-41): every request takes a number; a response older than
 * the newest one already applied is dropped, and within one attempt a lower
 * `version` never replaces a higher one. A failed request is NOT a result:
 * it only sets a notice and never clears an attempt a slower request (or the
 * previous poll) delivered — "latest applied wins", errors never clobber.
 */

export const LOGIN_POLL_MS = 1500;

export type LoginNotice =
  /** No Aura token even after the localhost hand-out (D9: required everywhere). */
  | { kind: "unauthorized" }
  /** This page's origin is not allowed to drive a sign-in. */
  | { kind: "forbidden" }
  /** A sign-in ended moments ago; the server asks to wait. */
  | { kind: "cooldown"; retryAfterMs: number }
  /** The request did not reach Aura (polling continues). */
  | { kind: "network"; message: string }
  | { kind: "http"; status: number; error: string | null };

export type LoginPending = "none" | "start" | "code" | "cancel";

export interface LoginAttemptView {
  attempt: RestLoginAttempt | null;
  /** At least one answer arrived (null attempt before that = still loading). */
  loaded: boolean;
  /** The server said the attempt was already running (another tab or the CLI). */
  existing: boolean;
  notice: LoginNotice | null;
  /** When the last poll answered — Codex shows "checked N s ago". */
  lastPolledAt: number | null;
  pending: LoginPending;
}

export const INITIAL_LOGIN_VIEW: LoginAttemptView = {
  attempt: null,
  loaded: false,
  existing: false,
  notice: null,
  lastPolledAt: null,
  pending: "none",
};

/** Whether `next` may replace `prev` (same attempt: version must not go back). */
export function acceptAttempt(prev: RestLoginAttempt | null, next: RestLoginAttempt | null): boolean {
  if (!prev || !next || prev.id !== next.id) return true;
  return next.version >= prev.version;
}

function noticeFor(status: number, body: LlmLoginResponse): LoginNotice | null {
  if (status === 200 || status === 201) return null;
  if (status === 401) return { kind: "unauthorized" };
  if (status === 403) return { kind: "forbidden" };
  if (status === 429 && body.error === "cooldown") return { kind: "cooldown", retryAfterMs: body.retryAfterMs ?? 0 };
  // 409 attempt_mismatch / not_awaiting / busy and 429 limit carry the
  // current attempt: showing it IS the answer, no extra notice.
  if ((status === 409 || status === 429) && body.attempt !== undefined) return null;
  return { kind: "http", status, error: body.error ?? null };
}

const errText = (e: unknown) => (e instanceof Error && e.message ? e.message : String(e));

export function useLoginAttempt(provider: ProviderId, intent: "start" | "resume") {
  const [view, setView] = useState<LoginAttemptView>(INITIAL_LOGIN_VIEW);
  const seq = useRef(0);
  const applied = useRef(0);
  const inflightPoll = useRef(false);
  const mounted = useRef(true);
  const attemptRef = useRef<RestLoginAttempt | null>(null);
  // Polls pause while a start/code/cancel is in flight: the action's answer
  // is the newer truth, and a GET racing a slow start could show "nothing
  // running" and drop the "already in progress" flag.
  const mutating = useRef(0);

  const run = useCallback(
    async (kind: "poll" | LoginPending, request: () => Promise<{ status: number; body: LlmLoginResponse }>) => {
      const mine = ++seq.current;
      const action = kind !== "poll" && kind !== "none";
      if (action) {
        mutating.current += 1;
        setView((v) => ({ ...v, pending: kind }));
      }
      try {
        const { status, body } = await request();
        if (!mounted.current || mine < applied.current) return;
        applied.current = mine;
        setView((v) => {
          let attempt = v.attempt;
          if (body.attempt !== undefined && acceptAttempt(v.attempt, body.attempt)) attempt = body.attempt;
          attemptRef.current = attempt;
          return {
            attempt,
            loaded: true,
            existing: kind === "start" ? body.existing === true : v.existing && attempt?.id === v.attempt?.id,
            notice: noticeFor(status, body),
            lastPolledAt: Date.now(),
            pending: kind === "poll" ? v.pending : "none",
          };
        });
      } catch (e) {
        if (!mounted.current) return;
        // Not a result: keep whatever attempt is shown, say why it may be stale.
        setView((v) => ({ ...v, notice: { kind: "network", message: errText(e) }, pending: kind === "poll" ? v.pending : "none" }));
      } finally {
        if (action) mutating.current -= 1;
      }
    },
    [],
  );

  const start = useCallback(() => run("start", () => api.llmLoginStart(provider)), [run, provider]);

  const poll = useCallback(async () => {
    if (inflightPoll.current || mutating.current > 0) return;
    inflightPoll.current = true;
    try {
      await run("poll", () => api.llmLoginGet(provider));
    } finally {
      inflightPoll.current = false;
    }
  }, [run, provider]);

  const submitCode = useCallback(
    (code: string) => {
      const a = attemptRef.current;
      if (!a) return;
      void run("code", () => api.llmLoginCode(provider, a.id, code));
    },
    [run, provider],
  );

  const cancel = useCallback(() => {
    const a = attemptRef.current;
    if (!a) return;
    void run("cancel", () => api.llmLoginCancel(provider, a.id));
  }, [run, provider]);

  useEffect(() => {
    mounted.current = true;
    if (intent === "start") void start();
    else void poll();
    return () => {
      mounted.current = false;
    };
  }, [intent, start, poll]);

  // Poll while the attempt runs (or before the first answer); stop on a
  // finished attempt, on "nothing running" and on a refused token/origin.
  const running = view.attempt ? !isTerminalLoginState(view.attempt.state) : !view.loaded;
  const blocked = view.notice?.kind === "unauthorized" || view.notice?.kind === "forbidden";
  useEffect(() => {
    if (!running || blocked) return;
    const t = setInterval(() => void poll(), LOGIN_POLL_MS);
    return () => clearInterval(t);
  }, [running, blocked, poll]);

  return { view, start, submitCode, cancel };
}
