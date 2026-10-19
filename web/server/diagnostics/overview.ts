/**
 * GET /api/diagnostics/overview assembly (plan Task 8; fowler 11, dahl).
 *
 * A dumb map over independent suppliers. Each supplier is called inside its
 * own error boundary and comes back as a `CardSource` — one failing source
 * marks only its own card unavailable, the response is still 200 and the
 * other cards render. Every list is capped here so the response stays inside
 * the spec's 50 KB budget by construction (pinned by a test).
 */

import type {
  CardSource,
  ContextAdvisoryView,
  DiagnosticsOverview,
  DriftFeedView,
  PairView,
  RuntimeSnapshotView,
  UsageUpstreamView,
} from "./diagnostics-types.js";

export const OVERVIEW_MAX_DRIFT_EVENTS = 50;
export const OVERVIEW_MAX_PAIRS = 20;
export const OVERVIEW_MAX_ADVISORIES = 30;
export const OVERVIEW_BUDGET_BYTES = 50 * 1024;

export interface DiagnosticsOverviewDeps {
  runtime: () => RuntimeSnapshotView;
  pairs: () => PairView[];
  drift: () => DriftFeedView;
  contextAdvisories: () => ContextAdvisoryView[];
  usage: () => UsageUpstreamView;
  now?: () => number;
  /** Called once per failed supplier (structured log at the wiring site). */
  onSupplierError?: (card: string, err: unknown) => void;
}

function source<T>(
  card: string,
  supply: () => T,
  now: number,
  onError?: (card: string, err: unknown) => void,
): CardSource<T> {
  try {
    return { status: "available", data: supply(), fetchedAt: now };
  } catch (err) {
    onError?.(card, err);
    return { status: "unavailable", reason: "source-error", since: now };
  }
}

export function buildDiagnosticsOverview(deps: DiagnosticsOverviewDeps): DiagnosticsOverview {
  const now = (deps.now ?? Date.now)();
  const onErr = deps.onSupplierError;
  return {
    generatedAt: now,
    backend: source("backend", deps.runtime, now, onErr),
    pairs: source("pairs", () => deps.pairs().slice(0, OVERVIEW_MAX_PAIRS), now, onErr),
    drift: source(
      "drift",
      () => {
        const feed = deps.drift();
        return { ...feed, totalInWindow: feed.events.length, events: feed.events.slice(0, OVERVIEW_MAX_DRIFT_EVENTS) };
      },
      now,
      onErr,
    ),
    contextAdvisory: source(
      "contextAdvisory",
      () => deps.contextAdvisories().slice(0, OVERVIEW_MAX_ADVISORIES),
      now,
      onErr,
    ),
    usage: source("usage", deps.usage, now, onErr),
  };
}
