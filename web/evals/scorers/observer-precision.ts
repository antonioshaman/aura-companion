/**
 * Observer-precision scorer — the M2 quality metric: does the council
 * observer's BLOCKER (STOP) signal actually correspond to real problems, and
 * does it catch the ones that matter? This is measured at THREE layers, which
 * is the whole point:
 *
 *   1. raw      — the observer's claims exactly as emitted, pre-grounding.
 *   2. grounded — after the server's grounding gate downgraded ungrounded
 *                 STOPs to NOTE (evidence not in the modified set / missing on
 *                 disk).
 *   3. delta    — what grounding CHANGED: of the STOPs it downgraded, how many
 *                 were genuine false positives (grounding helped precision) vs
 *                 genuine true positives it wrongly silenced (grounding hurt
 *                 recall). The delta is the verdict on whether the gate earns
 *                 its keep.
 *
 * Ground truth comes from human labels, NOT from the model. A `true_positive`
 * / `false_positive` label attaches to an emitted finding by its `finding_id`
 * (the exact `efnd_<hex>` the extractor produced) — an unambiguous identity
 * join, so a re-worded claim never collides with a different finding. An
 * `expected_blocker_missed` label deliberately has NO matching finding — it
 * enumerates the should-have-caught set so recall is a COUNTED set-difference,
 * never an inferred absence.
 *
 * The absent-vs-zero discipline is load-bearing here for one specific trap:
 * "wake-version drift", where a manifest mismatch downgrades EVERY finding.
 * That leaves the grounded layer with zero surfaced STOPs — which must read as
 * `unavailable` precision (0 denominator) and a real recall COLLAPSE, NEVER as
 * a perfect-precision true-negative win. The three-state {@link Ratio} makes
 * that impossible to average in as a phantom 1.0.
 *
 * Pure + firewall-clean: a flat `(findings, labels) => score` over already-
 * extracted data. Imports only the eval schema. Never `server/`.
 */

import type { EvalFindingSeverity, EvalLabelRecord } from "../schema/eval-artifact.js";

/**
 * One finding reduced to exactly what scoring needs: its identity (`id`, the
 * label join key) plus the severity it carried BEFORE and AFTER the grounding
 * gate. The label/replay tooling supplies the id and both severities; the
 * scorer stays agnostic to how they were produced.
 */
export interface ScorableFinding {
  /** The finding's stable extractor id (`efnd_<hex>`) — the label join key. */
  id: string;
  checkpoint_id: string;
  evidence_path: string;
  /** Severity as the observer emitted it (pre-grounding). */
  raw_severity: EvalFindingSeverity;
  /** Severity after the server's grounding downgrade pass. */
  grounded_severity: EvalFindingSeverity;
  /**
   * Severity after the PATH-ONLY gate (pre-B2: modified set + on disk, no line
   * checks) — the "before" of the B2 before/after. Defaults to
   * `grounded_severity` when absent (no line facts → both gates agree).
   */
  path_only_grounded_severity?: EvalFindingSeverity;
  /** True when the gate kept this STOP but marked it weak evidence (B2) — it
   *  stays STOP for recall, but never reaches the blocker banner. */
  weak_evidence?: boolean;
}

/** A ratio that knows its numerator/denominator, or is unavailable because the
 *  denominator was zero (no population to measure — NOT a 0 or a 1). */
export type Ratio =
  | { kind: "value"; value: number; numerator: number; denominator: number }
  | { kind: "unavailable"; why: string };

function ratio(numerator: number, denominator: number, whyEmpty: string): Ratio {
  if (denominator === 0) return { kind: "unavailable", why: whyEmpty };
  return { kind: "value", value: numerator / denominator, numerator, denominator };
}

/** Score for one layer (raw or grounded), restricted to the STOP tier. */
export interface TierScore {
  /** Findings surfaced AS STOP at this layer. */
  surfaced: number;
  /** Surfaced STOPs labeled true_positive. */
  true_positive: number;
  /** Surfaced STOPs labeled false_positive. */
  false_positive: number;
  /** Surfaced STOPs with no human verdict yet — excluded from precision. */
  unlabeled: number;
  /** tp / (tp + fp) — unavailable when nothing labeled was surfaced. */
  precision: Ratio;
  /** fp / (tp + fp) — the false-STOP rate. */
  false_stop_rate: Ratio;
  /** tp / (tp + missed) — caught blockers over all blockers that should fire. */
  recall: Ratio;
}

export interface ObserverPrecisionScore {
  raw: TierScore;
  /** Path-only gate (before B2 line checks). */
  grounded_path_only: TierScore;
  /** Full gate (after B2): path + line checks. */
  grounded: TierScore;
  /** What actually raises the blocker banner: grounded STOP, not weak evidence. */
  banner: TierScore;
  /** What the grounding gate changed, STOP tier only. */
  delta: {
    /** STOPs that were downgraded out of the STOP tier by grounding. */
    downgraded: number;
    /** Of those, labeled false_positive — grounding HELPED precision. */
    downgraded_false_positive: number;
    /** Of those, labeled true_positive — grounding HURT recall (silenced a
     *  real blocker). This is the number to watch. */
    downgraded_true_positive: number;
    /** Of those, unlabeled — verdict unknown, can't attribute the downgrade. */
    downgraded_unlabeled: number;
  };
  /** expected_blocker_missed labels in scope — the recall denominator add. */
  missed_blockers: number;
  /** TP/FP labels that matched no emitted finding — a labeling inconsistency,
   *  surfaced rather than silently dropped. */
  orphan_verdict_labels: number;
}

const STOP: EvalFindingSeverity = "STOP";

type Verdict = "true_positive" | "false_positive";

/**
 * Score observer STOP precision/recall across three layers from already-
 * extracted findings + human labels. Pure and deterministic — same inputs
 * always yield the same score, no disk, no clock.
 */
export function scoreObserverPrecision(
  findings: ScorableFinding[],
  labels: EvalLabelRecord[],
): ObserverPrecisionScore {
  // Index verdict labels by their finding_id for O(1) lookup; track which were
  // consumed so we can report orphans. A tp/fp label always carries a
  // finding_id (enforced at the parse boundary); guard anyway.
  const verdictByFindingId = new Map<string, Verdict>();
  let missedBlockers = 0;
  let totalTpLabels = 0;
  for (const l of labels) {
    if (l.verdict === "expected_blocker_missed") {
      missedBlockers++;
      continue;
    }
    // true_positive | false_positive
    if (l.verdict === "true_positive") totalTpLabels++;
    if (l.finding_id) verdictByFindingId.set(l.finding_id, l.verdict);
  }
  // All blockers that SHOULD fire, layer-independent: every real blocker the
  // observer emitted (true_positive labels) plus every one it missed
  // (expected_blocker_missed). Recall's numerator is the layer-surfaced tp;
  // this denominator stays fixed, so a grounding downgrade of a real blocker
  // drops recall instead of vanishing from the population.
  const totalKnownBlockers = totalTpLabels + missedBlockers;

  const consumedKeys = new Set<string>();

  const tier = (surfacedAt: (f: ScorableFinding) => boolean): TierScore => {
    let surfaced = 0;
    let tp = 0;
    let fp = 0;
    let unlabeled = 0;
    for (const f of findings) {
      if (!surfacedAt(f)) continue;
      surfaced++;
      const v = verdictByFindingId.get(f.id);
      if (v === "true_positive") {
        tp++;
        consumedKeys.add(f.id);
      } else if (v === "false_positive") {
        fp++;
        consumedKeys.add(f.id);
      } else {
        unlabeled++;
      }
    }
    const labeled = tp + fp;
    return {
      surfaced,
      true_positive: tp,
      false_positive: fp,
      unlabeled,
      precision: ratio(tp, labeled, "no labeled STOPs surfaced at this layer"),
      false_stop_rate: ratio(fp, labeled, "no labeled STOPs surfaced at this layer"),
      recall: ratio(tp, totalKnownBlockers, "no known blockers in scope"),
    };
  };

  const raw = tier((f) => f.raw_severity === STOP);
  const groundedPathOnly = tier((f) => (f.path_only_grounded_severity ?? f.grounded_severity) === STOP);
  const grounded = tier((f) => f.grounded_severity === STOP);
  const banner = tier((f) => f.grounded_severity === STOP && f.weak_evidence !== true);

  // Delta: STOPs raw-surfaced but grounded-OUT of the STOP tier.
  let downgraded = 0;
  let downFp = 0;
  let downTp = 0;
  let downUnlabeled = 0;
  for (const f of findings) {
    if (f.raw_severity !== STOP || f.grounded_severity === STOP) continue;
    downgraded++;
    const v = verdictByFindingId.get(f.id);
    if (v === "true_positive") downTp++;
    else if (v === "false_positive") downFp++;
    else downUnlabeled++;
  }

  let orphans = 0;
  for (const id of verdictByFindingId.keys()) {
    if (!consumedKeys.has(id)) orphans++;
  }

  return {
    raw,
    grounded_path_only: groundedPathOnly,
    grounded,
    banner,
    delta: {
      downgraded,
      downgraded_false_positive: downFp,
      downgraded_true_positive: downTp,
      downgraded_unlabeled: downUnlabeled,
    },
    missed_blockers: missedBlockers,
    orphan_verdict_labels: orphans,
  };
}
