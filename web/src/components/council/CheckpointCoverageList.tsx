/**
 * CheckpointCoverageList — observer rigor (2026-10-16).
 *
 * Lists the pair's checkpoints that are NOT covered by a real review, so a
 * missing or rubber-stamp review is visible instead of looking like silence
 * or a clean pass:
 *   - "без ревью"     — the checkpoint never got a review (superseded by a
 *                       newer one, the pair degraded, the observer's turn went
 *                       to a liveness probe, …);
 *   - "не проверено"  — the observer returned no findings but read nothing
 *                       beyond the prose artifact (prod checkpoint 148).
 *
 * Newest first; the first {@link COLLAPSED_LIMIT} rows show by default and a
 * toggle reveals the rest. Renders nothing when every checkpoint is covered.
 */

import { useState } from "react";
import type { BrowserCheckpointCoverageGap } from "../../types.js";
import { COVERAGE_KIND_LABEL, coverageGapExplanation } from "../../utils/checkpoint-coverage.js";

export const COLLAPSED_LIMIT = 3;

export interface CheckpointCoverageListProps {
  gaps: readonly BrowserCheckpointCoverageGap[];
}

export function CheckpointCoverageList({ gaps }: CheckpointCoverageListProps) {
  const [expanded, setExpanded] = useState(false);
  if (gaps.length === 0) return null;
  const newestFirst = [...gaps].reverse();
  const visible = expanded ? newestFirst : newestFirst.slice(0, COLLAPSED_LIMIT);
  const hidden = newestFirst.length - visible.length;
  const unreviewed = gaps.filter((g) => g.kind === "unreviewed").length;
  const unverified = gaps.length - unreviewed;
  const summary = [
    unreviewed > 0 ? `${unreviewed} ${COVERAGE_KIND_LABEL.unreviewed}` : null,
    unverified > 0 ? `${unverified} ${COVERAGE_KIND_LABEL.unverified}` : null,
  ].filter(Boolean).join(" · ");

  return (
    <section
      data-testid="checkpoint-coverage"
      aria-labelledby="checkpoint-coverage-title"
      className="shrink-0 px-3 py-2 border-b border-cc-border"
    >
      <h2 id="checkpoint-coverage-title" className="text-[11px] font-medium text-cc-fg">
        Чекпоинты без проверенного ревью
        <span className="ml-1.5 font-normal text-cc-muted">{summary}</span>
      </h2>
      <ul className="mt-1.5 flex flex-col gap-1">
        {visible.map((g) => {
          const explanation = coverageGapExplanation(g);
          return (
            <li
              key={g.checkpointId}
              data-testid="checkpoint-coverage-item"
              data-kind={g.kind}
              {...(g.reason ? { "data-reason": g.reason } : {})}
              className="flex items-start gap-2 text-[11px] leading-snug"
              title={explanation}
            >
              <span
                className={
                  g.kind === "unreviewed"
                    ? "shrink-0 px-1.5 py-0.5 rounded border border-cc-warning/40 bg-cc-warning/10 text-cc-fg font-medium"
                    : "shrink-0 px-1.5 py-0.5 rounded border border-cc-border bg-cc-fg/[0.04] text-cc-fg font-medium"
                }
              >
                {COVERAGE_KIND_LABEL[g.kind]}
              </span>
              <span className="min-w-0 flex-1">
                {g.phase && <span className="text-cc-fg">{g.phase} </span>}
                <span className="font-mono-code text-cc-muted break-all">{g.checkpointId}</span>
                <span className="sr-only"> — {explanation}</span>
              </span>
            </li>
          );
        })}
      </ul>
      {newestFirst.length > COLLAPSED_LIMIT && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="mt-1.5 text-[11px] font-medium text-cc-info hover:text-cc-fg cursor-pointer"
        >
          {expanded ? "Свернуть" : `Показать все (${newestFirst.length}, ещё ${hidden})`}
        </button>
      )}
    </section>
  );
}
