import { useId } from "react";
/**
 * CouncilBudgetNotice — the pair crossed its token budget (server
 * `council-budget.ts`), so the server paused its AUTOMATIC activity: no
 * observer wakes, no second opinion, no auto-proceed. Nothing was killed and
 * the user can keep chatting with the orchestrator. The notice says why the
 * pair went quiet and offers "Continue", which restarts the spend window and
 * delivers the newest checkpoint queued while paused.
 *
 * Renders nothing unless the budget is exceeded.
 */

import type { BrowserCouncilBudget, CouncilRoleUsage } from "../../types.js";

export interface CouncilBudgetNoticeProps {
  budget: BrowserCouncilBudget | undefined;
  /** A Continue request is in flight. */
  continuing?: boolean;
  /** Last Continue failure, shown next to the button. */
  error?: string;
  onContinue: () => void;
}

/** Compact token count: 950, 1.5K, 20M, 1.2B. */
export function formatTokenCount(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(n >= 10_000_000_000 ? 0 : 1).replace(/\.0$/, "")}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, "")}K`;
  return String(n);
}

function budgeted(u: CouncilRoleUsage): number {
  return u.inputTokens + u.outputTokens + u.cacheCreationTokens;
}

export function CouncilBudgetNotice({ budget, continuing = false, error, onContinue }: CouncilBudgetNoticeProps) {
  const titleId = useId();
  if (!budget || !budget.exceeded) return null;
  const { orchestrator, observer } = budget.byRole;
  const cacheReads = orchestrator.cacheReadTokens + observer.cacheReadTokens;
  return (
    <section
      data-testid="council-budget-notice"
      aria-labelledby={titleId}
      className="shrink-0 px-3 py-2.5 border-b border-cc-warning/25 bg-cc-warning/10"
    >
      <h2 id={titleId} className="text-xs font-medium text-cc-fg">
        Pair paused: token budget reached
      </h2>
      <p className="mt-0.5 text-[11px] text-cc-muted leading-snug">
        This pair used {formatTokenCount(budget.spentTokens)} of its {formatTokenCount(budget.limitTokens)} token
        budget, so automatic observer reviews and auto-proceed are paused. Nothing was stopped — you can keep
        working with the orchestrator.
      </p>
      <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-2 text-[11px] leading-snug" data-testid="council-budget-breakdown">
        <dt className="text-cc-muted">Orchestrator</dt>
        <dd className="text-cc-fg font-mono-code">
          {formatTokenCount(budgeted(orchestrator))} · {orchestrator.turns} turns
        </dd>
        <dt className="text-cc-muted">Observer</dt>
        <dd className="text-cc-fg font-mono-code">
          {formatTokenCount(budgeted(observer))} · {observer.turns} turns
        </dd>
        <dt className="text-cc-muted">Cache reads</dt>
        <dd className="text-cc-fg font-mono-code">{formatTokenCount(cacheReads)} (not counted)</dd>
      </dl>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={onContinue}
          disabled={continuing}
          aria-label="Continue: reset this pair's token budget and resume automatic reviews"
          className="text-[11px] font-medium px-2 py-1 rounded-md bg-cc-warning/20 hover:bg-cc-warning/30 text-cc-fg border border-cc-warning/30 transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-default"
        >
          {continuing ? "Resuming…" : "Continue"}
        </button>
        {error && (
          <span role="alert" className="text-[11px] text-cc-error">
            {error}
          </span>
        )}
      </div>
    </section>
  );
}
