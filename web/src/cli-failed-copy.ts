// AURA-LOCAL — PLAN T12 (Phase G, Story 2c).
//
// User-facing copy for each `CliFailedReason`. Friedman R1 mandate:
// every variant carries cause + agency + next step. Friedman R2:
// `browser_closed_no_reconnect` uses past-tense second-person so
// the user reads it as something that happened to THEIR tab, not
// an active server condition.
//
// The exhaustive `switch(reason)` with `const _: never = reason;`
// tail is the EC-37/AP-14 sibling on the frontend: adding a sixth
// `CliFailedReason` is a TYPECHECK error here. The wire union is
// closed at 5 variants in `web/server/cli-failed-frame.ts`; this
// helper closes the read side.

import type { CliFailedReason } from "./types.js";

export interface CliFailedCopy {
  /** Short, plain-language headline. Used as the banner title +
   *  Sidebar tooltip + browser-tab notification alike. */
  headline: string;
  /** One-sentence explanation of CAUSE + AGENCY (what happened,
   *  who/what is responsible — the agent, the container, the tab).
   *  Plain prose, no Markdown. */
  body: string;
  /** Primary recovery affordance label. Friedman P5: every variant
   *  resolves to the same surface — start a fresh session, optionally
   *  carrying the user’s typed draft. */
  action: string;
}

/**
 * Pure: map a closed `CliFailedReason` to its user-facing copy.
 *
 * Friedman R1 invariant: each branch independently spells out
 * (cause -> agency -> next step). Sharing strings via a table would
 * collapse the divergent recoveries into a falsely-symmetric shape;
 * the literal switch is the explicit-intent contract.
 */
export function cliFailedCopy(reason: CliFailedReason): CliFailedCopy {
  switch (reason) {
    case "relaunch_exhausted":
      return {
        headline: "This session can’t recover",
        body:
          "The agent process exited repeatedly and used up its retry budget. Aura stopped relaunching it to protect your workspace from a crash loop.",
        action: "Start a new session with this draft",
      };
    case "container_missing":
      return {
        headline: "The Docker container is gone",
        body:
          "Aura could not find the container that hosted this session. Something outside the app removed it, so the agent has nowhere to run.",
        action: "Start a new session with this draft",
      };
    case "container_stopped":
      return {
        headline: "The Docker container won’t start",
        body:
          "The container that hosted this session is stopped and Aura could not restart it. The agent process can no longer attach.",
        action: "Start a new session with this draft",
      };
    case "binary_missing":
      return {
        headline: "The agent binary is missing",
        body:
          "The container is running, but the `claude` or `codex` binary that this session needs is no longer installed inside it. Rebuilding the image will restore it.",
        action: "Start a new session with this draft",
      };
    case "browser_closed_no_reconnect":
      // Friedman R2: past-tense second-person. The TAB closed; the
      // server queued messages, waited the grace window, and gave up.
      // "You" is the actor whose action produced the state.
      return {
        headline: "You closed this tab too long",
        body:
          "This tab disconnected and didn’t come back before the queue grace window expired. Your queued messages were saved here so you can continue them in a fresh session.",
        action: "Start a new session with this draft",
      };
    default: {
      // Exhaustiveness tripwire — adding a sixth variant to
      // `CliFailedReason` without updating this switch is a
      // typecheck error here.
      const _: never = reason;
      void _;
      throw new Error(`cliFailedCopy: unhandled reason ${String(reason)}`);
    }
  }
}
