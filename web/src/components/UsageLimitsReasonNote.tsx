import type { ReactNode } from "react";
import type { CatalogEntry } from "../../server/auth-status/auth-types.js";
import { formatAction } from "../../server/auth-status/auth-catalog.js";
import { SignInButton } from "./llm-login/SignInButton.js";

/**
 * What the usage-limits panel shows instead of nothing (LLM auth phase 1,
 * task 14; spec story 4). The entry comes from the catalog
 * (`describeUsageLimitsReason` for Claude, `describeLimitsPending` for a
 * Codex session with no windows yet); this component only lays it out with
 * its one action: `sign_in` → the sign-in window (phase 2c), `open_status` →
 * the Diagnostics page, `retry` → refetch.
 */
export function UsageLimitsReasonNote({ entry, onRetry }: { entry: CatalogEntry; onRetry?: () => void }) {
  const { action } = entry;
  let actionNode: ReactNode = null;
  switch (action.kind) {
    case "open_status":
      actionNode = (
        <a href="#/diagnostics" className="text-[11px] font-medium link-primary-aa underline underline-offset-2">
          {formatAction(action)}
        </a>
      );
      break;
    case "retry":
      actionNode = onRetry ? (
        <button type="button" onClick={onRetry} className="text-[11px] font-medium link-primary-aa underline underline-offset-2 cursor-pointer">
          {formatAction(action)}
        </button>
      ) : null;
      break;
    case "sign_in":
      actionNode = (
        <SignInButton
          provider={action.provider}
          className="text-[11px] font-medium link-primary-aa underline underline-offset-2 cursor-pointer"
        />
      );
      break;
    case "update_cli":
    case "install_cli":
    case "run_as_root":
    case "run_as_service_user":
    case "restart_session":
      actionNode = <p className="text-[11px] text-cc-muted break-words">{formatAction(action)}</p>;
      break;
    case "none":
      break;
    default: {
      const never: never = action;
      throw new Error(`unhandled usage-limits action ${JSON.stringify(never)}`);
    }
  }
  return (
    <div className="shrink-0 px-4 py-2.5 space-y-1" data-testid="usage-limits-reason">
      <p className="text-[11px] text-cc-muted uppercase tracking-wider">Usage limits</p>
      <p className="text-xs text-cc-fg">{entry.title}</p>
      <p className="text-[11px] text-cc-muted">{entry.detail}</p>
      {actionNode}
    </div>
  );
}
