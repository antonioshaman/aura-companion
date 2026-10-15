import type { SdkSessionInfo } from "../types.js";
import type { Route } from "./routing.js";

/**
 * Archived auto-restore bounce — the decision, kept pure so every edge is
 * testable without rendering App (review 2026-10-14-2248 #2/#9).
 *
 * On reload the app reopens the last session and connects its socket before
 * the session list arrives. If that session was archived meanwhile, the tab
 * would silently reconnect to it and park it as the main panel. Once the
 * server's list is in, an archived restored session is dropped and the tab
 * goes home. Exited (non-archived) sessions are kept on purpose: sending a
 * message resumes them.
 */
export interface ArmedRestore {
  sessionId: string;
  /**
   * Whether the route has shown this session since arming. The hash-less
   * restore arms while the route is still `home` (its `navigateToSession`
   * lands a render later), so "route ≠ this session" only means "the user
   * moved away" once the session route has been seen.
   */
  sawSessionRoute: boolean;
}

export type RestoreBounceDecision =
  | { kind: "wait"; armed: ArmedRestore }
  | { kind: "settle"; bounce: boolean };

export function decideRestoreBounce(
  armed: ArmedRestore,
  route: Route,
  sessions: readonly SdkSessionInfo[],
  sessionsLoaded: boolean,
): RestoreBounceDecision {
  const onSession = route.page === "session" && route.sessionId === armed.sessionId;
  // The user navigated elsewhere before the list arrived: their choice wins.
  if (!onSession && armed.sawSessionRoute) return { kind: "settle", bounce: false };
  const next = onSession && !armed.sawSessionRoute ? { ...armed, sawSessionRoute: true } : armed;
  if (!sessionsLoaded) return { kind: "wait", armed: next };
  // Decided once the server's list is in — found or not (an unknown id is not
  // ours to bounce; keeping the ref armed would re-scan every poll).
  const info = sessions.find((s) => s.sessionId === armed.sessionId);
  return { kind: "settle", bounce: info?.archived === true };
}

/**
 * True when this document load is a browser reload (F5 / Cmd-R / PWA
 * relaunch-as-reload), as opposed to following or pasting a link. A reload of
 * `#/session/<id>` is the same "reopen what I had" restore as the hash-less
 * path; a pasted deep link is explicit intent and is never bounced.
 */
export function isReloadNavigation(perf: Pick<Performance, "getEntriesByType"> | undefined = globalThis.performance): boolean {
  try {
    const nav = perf?.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    return nav?.type === "reload";
  } catch {
    return false;
  }
}
