/**
 * W15 multi-model review — fold near-identical claims from the two reviewers.
 *
 * When the observer and the second-opinion reviewer flag the same defect on
 * the same checkpoint, the panel should show ONE finding ("also flagged by
 * <model>"), and the blocker banner should raise it once. The finding that
 * reached the host LATER is marked `duplicateOf: <earlier id>`; it is never
 * dropped (the log keeps it, folded), and never marked when it is MORE
 * severe than the earlier one — a STOP that the other reviewer only called
 * a WARN is a disagreement worth seeing, not a duplicate.
 *
 * Deterministic and conservative: same normalised evidence file, line ranges
 * overlap (or either side cites the whole file), and the claims share most
 * of their words (Jaccard ≥ {@link DUPLICATE_CLAIM_SIMILARITY}). A missed
 * duplicate costs one extra row; a false duplicate would hide a distinct bug
 * behind another finding, so the bar is high.
 */

export const DUPLICATE_CLAIM_SIMILARITY = 0.5;

export interface DedupFinding {
  id: string;
  severity: "STOP" | "WARN" | "NOTE" | "INFO";
  claim: string;
  evidence_path: string;
  evidence_lines?: [number, number];
}

const SEVERITY_RANK: Record<DedupFinding["severity"], number> = { STOP: 3, WARN: 2, NOTE: 1, INFO: 0 };

function normPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/").toLowerCase();
}

/** Words of ≥ 3 letters/digits (any script), lower-cased. */
export function claimTokens(claim: string): Set<string> {
  const out = new Set<string>();
  for (const m of claim.toLowerCase().matchAll(/[\p{L}\p{N}_]{3,}/gu)) out.add(m[0]);
  return out;
}

export function claimSimilarity(a: string, b: string): number {
  const ta = claimTokens(a);
  const tb = claimTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

function linesOverlap(a?: [number, number], b?: [number, number]): boolean {
  if (!a || !b) return true;
  return a[0] <= b[1] && b[0] <= a[1];
}

export function isNearDuplicate(later: DedupFinding, earlier: DedupFinding): boolean {
  if (SEVERITY_RANK[later.severity] > SEVERITY_RANK[earlier.severity]) return false;
  if (normPath(later.evidence_path) !== normPath(earlier.evidence_path)) return false;
  if (!linesOverlap(later.evidence_lines, earlier.evidence_lines)) return false;
  return claimSimilarity(later.claim, earlier.claim) >= DUPLICATE_CLAIM_SIMILARITY;
}

/**
 * For each finding of the later review, the id of the first earlier finding
 * it near-duplicates (index-aligned; `undefined` = distinct). Each earlier
 * finding absorbs at most one later finding, so two distinct later claims
 * never fold into the same row.
 */
export function findCrossReviewerDuplicates(
  later: readonly DedupFinding[],
  earlier: readonly DedupFinding[],
): Array<string | undefined> {
  const used = new Set<string>();
  return later.map((f) => {
    const hit = earlier.find((e) => !used.has(e.id) && isNearDuplicate(f, e));
    if (!hit) return undefined;
    used.add(hit.id);
    return hit.id;
  });
}
