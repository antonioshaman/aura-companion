/**
 * Browser-side checkpoint coverage list (observer rigor, 2026-10-16).
 *
 * Pure list operations behind `GroupRecord.checkpointCoverage`: the REST
 * bootstrap seeds it from disk (`server/checkpoint-coverage.ts`), live frames
 * keep it current — a superseded queue entry or a degrade mid-review adds an
 * "без ревью" row, an unverified empty review adds a "не проверено" row, and
 * a real review of the checkpoint removes its row.
 */

import type { BrowserCheckpointCoverageGap } from "../types.js";

/** Insert or replace the row for `gap.checkpointId` (newest verdict wins).
 *  A known phase / sequence is never erased by a later id-only row. */
export function upsertCoverageGap(
  list: readonly BrowserCheckpointCoverageGap[] | undefined,
  gap: BrowserCheckpointCoverageGap,
): BrowserCheckpointCoverageGap[] {
  const prior = (list ?? []).find((g) => g.checkpointId === gap.checkpointId);
  const sequence = gap.sequence ?? prior?.sequence;
  const merged: BrowserCheckpointCoverageGap = {
    ...gap,
    phase: gap.phase || prior?.phase || "",
    ...(sequence !== undefined ? { sequence } : {}),
  };
  return [...(list ?? []).filter((g) => g.checkpointId !== gap.checkpointId), merged];
}

export function removeCoverageGap(
  list: readonly BrowserCheckpointCoverageGap[] | undefined,
  checkpointId: string,
): BrowserCheckpointCoverageGap[] {
  return (list ?? []).filter((g) => g.checkpointId !== checkpointId);
}

/** Russian UI copy (the pair's users work in Russian; issue 2026-10-16). */
export const COVERAGE_KIND_LABEL: Record<BrowserCheckpointCoverageGap["kind"], string> = {
  unreviewed: "без ревью",
  unverified: "не проверено",
};

export function coverageGapExplanation(gap: BrowserCheckpointCoverageGap): string {
  if (gap.kind === "unverified") {
    return "Наблюдатель вернул пустое ревью, но не открыл ничего, кроме самого артефакта: код не проверен.";
  }
  switch (gap.reason) {
    case "superseded":
      return "Чекпоинт вытеснен более новым до того, как наблюдатель его прочитал.";
    case "degraded":
      return "Пара деградировала до того, как наблюдатель ответил.";
    case "probe_reply":
      return "Ход наблюдателя ушёл на ответ liveness-пробе, ревью не получено.";
    default:
      return "Для этого чекпоинта нет ни одного ревью наблюдателя.";
  }
}
