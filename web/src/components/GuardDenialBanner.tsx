/**
 * GuardDenialBanner — in-chat card for a command the guards pack blocked.
 *
 * CLAUDE-ONLY. The guards pack (packs/guards) is a Claude Code PreToolUse hook.
 * In Aura "agent" mode (permissionMode bypassPermissions) a hook "ask" is
 * auto-denied by the CLI without ever prompting, so before this card only the
 * agent saw the block. The server turns the CLI `permission_denied` frame into
 * a `guard_denied` message; this card shows the rule, the reason and the exact
 * command, with "Allow once" (ask-level rules only — the server writes a
 * single-use, 5-minute approval for exactly this command and tells the agent to
 * re-run it) and "Dismiss". Codex sessions never run Claude hooks, so the frame
 * — and this card — never appear there; no backend gating is needed.
 *
 * `GuardDenialBanner` is presentational (Playground renders it with mock
 * props); `GuardDenialCard` wires it to the API and the store.
 */
import { useCallback, useId, useState } from "react";
import { api } from "../api.js";
import { useStore } from "../store.js";
import type { GuardDenial } from "../types.js";

/** Mirrors GUARD_DENIAL_MAX_AGE_MS in server/guard-denial.ts (the server enforces it). */
export const GUARD_DENIAL_ALLOW_WINDOW_MS = 10 * 60 * 1000;

/** Reason lines without the `[guards:<rule>] ` tags and the agent-facing guidance footer. */
export function displayReason(reason: string): string {
  return reason
    .split("\n")
    .filter((line) => !line.startsWith("(guards decision:") && !line.startsWith("(Disable with GUARDS_DISABLE="))
    .map((line) => line.replace(/^\[guards:[a-z0-9-]+\]\s*/, ""))
    .join("\n")
    .trim();
}

type View = "actionable" | "deny" | "expired" | "no-command" | "allowed" | "dismissed";

function viewOf(denial: GuardDenial, now: number): View {
  if (denial.status === "allowed") return "allowed";
  if (denial.status === "dismissed") return "dismissed";
  if (denial.level === "deny") return "deny";
  if (!denial.command) return "no-command";
  if (now - denial.deniedAt > GUARD_DENIAL_ALLOW_WINDOW_MS) return "expired";
  return "actionable";
}

const NOTE: Record<Exclude<View, "actionable">, string> = {
  allowed: "Allowed once. The agent was asked to re-run exactly this command; the approval is single-use and expires in 5 minutes.",
  dismissed: "Dismissed. The command stays blocked.",
  deny: "This rule is a hard deny and cannot be allowed once.",
  expired: "The approval window (10 minutes) has passed. Ask the agent to run the command again if you still want it.",
  "no-command": "The exact command was not recorded, so it cannot be allowed once.",
};

export interface GuardDenialBannerProps {
  denial: GuardDenial;
  onAllowOnce?: () => void;
  onDismiss?: () => void;
  /** A request is in flight — both actions disabled. */
  pending?: boolean;
  error?: string | null;
  /** Clock for the expiry check (tests / Playground). */
  now?: number;
}

export function GuardDenialBanner({
  denial,
  onAllowOnce,
  onDismiss,
  pending = false,
  error,
  now = Date.now(),
}: GuardDenialBannerProps) {
  const view = viewOf(denial, now);
  const titleId = useId();
  const resolved = view === "allowed" || view === "dismissed";
  const reason = displayReason(denial.reason);
  return (
    <div
      role={view === "actionable" ? "alert" : "status"}
      aria-labelledby={titleId}
      data-testid="guard-denial-banner"
      data-state={view}
      className={`my-1 rounded-lg border px-3 py-2.5 ${
        resolved ? "border-cc-border bg-cc-card/40" : "border-cc-warning/30 bg-cc-warning/10"
      }`}
    >
      <div className="flex items-start gap-2">
        <div className="w-6 h-6 rounded-md flex items-center justify-center shrink-0 mt-0.5 bg-cc-warning/15 border border-cc-warning/30">
          <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5 text-cc-warning" aria-hidden="true">
            <path fillRule="evenodd" d="M10 1.944A11.954 11.954 0 012.166 5C2.056 5.649 2 6.319 2 7c0 5.225 3.34 9.67 8 11.317C14.66 16.67 18 12.225 18 7c0-.682-.057-1.35-.166-2.001A11.954 11.954 0 0110 1.944zM11 14a1 1 0 11-2 0 1 1 0 012 0zm0-7a1 1 0 10-2 0v3a1 1 0 102 0V7z" clipRule="evenodd" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <div id={titleId} className="text-xs font-semibold text-cc-fg mb-0.5">
            Guard blocked a command
            <span className="ml-1.5 font-mono-code font-normal text-cc-muted">[{denial.rules.join(", ")}]</span>
          </div>
          {denial.command && (
            <pre
              className="my-1.5 px-2 py-1.5 rounded bg-cc-code-bg text-cc-code-fg text-[12px] font-mono-code whitespace-pre-wrap break-all"
              data-testid="guard-denial-command"
            >
              {denial.command}
            </pre>
          )}
          <p className="text-xs text-cc-fg/80 leading-snug whitespace-pre-wrap break-words">{reason}</p>
          {view !== "actionable" && (
            <p className="mt-1.5 text-[11px] text-cc-muted leading-snug" data-testid="guard-denial-note">
              {NOTE[view]}
            </p>
          )}
          {error && (
            <p className="mt-1.5 text-[11px] text-cc-error" role="alert">
              {error}
            </p>
          )}
          {!resolved && (
            <div className="mt-2 flex flex-wrap gap-2">
              {view === "actionable" && (
                <button
                  type="button"
                  onClick={onAllowOnce}
                  disabled={pending || !onAllowOnce}
                  className="px-2.5 py-1 text-xs font-medium rounded-md bg-cc-warning/20 text-cc-fg border border-cc-warning/40 hover:bg-cc-warning/30 disabled:opacity-50 cursor-pointer disabled:cursor-default"
                >
                  Allow once
                </button>
              )}
              <button
                type="button"
                onClick={onDismiss}
                disabled={pending || !onDismiss}
                className="px-2.5 py-1 text-xs rounded-md text-cc-muted border border-cc-border hover:text-cc-fg disabled:opacity-50 cursor-pointer disabled:cursor-default"
              >
                Dismiss
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Store/API-wired card rendered by MessageBubble for `message.guardDenial`. */
export function GuardDenialCard({ denial }: { denial: GuardDenial }) {
  const resolveGuardDenial = useStore((s) => s.resolveGuardDenial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (action: "allowed" | "dismissed") => {
      setPending(true);
      setError(null);
      try {
        if (action === "allowed") await api.guardAllowOnce(denial.sessionId, denial.toolUseId);
        else await api.guardDismiss(denial.sessionId, denial.toolUseId);
        // The server also broadcasts guard_denial_resolved; applying it locally is idempotent.
        resolveGuardDenial(denial.sessionId, denial.toolUseId, action);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setPending(false);
      }
    },
    [denial.sessionId, denial.toolUseId, resolveGuardDenial],
  );

  return (
    <GuardDenialBanner
      denial={denial}
      pending={pending}
      error={error}
      onAllowOnce={() => void run("allowed")}
      onDismiss={() => void run("dismissed")}
    />
  );
}
