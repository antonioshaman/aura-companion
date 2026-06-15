/**
 * Grounding-rerun oracle — the hermetic determinism check for the council
 * grounding gate. This is the ONE file in the eval tree permitted to import
 * `server/` (see the import-firewall allow-list): proving the gate is
 * deterministic is only meaningful if it re-runs the EXACT production code,
 * not a re-implementation that could drift from it.
 *
 * What it does: take an eval sidecar (which froze the gate's INPUTS at review
 * time — the raw findings, the manifest partition that was the modified set,
 * and the per-path existence answers), re-feed those inputs through the
 * current {@link validateObserverFindings}, and compare the RECOMPUTED
 * downgrade set against the one the sidecar recorded.
 *
 *   - Match → the gate is deterministic: same inputs, same downgrades. A CI
 *     run can assert this across a corpus and catch a non-deterministic
 *     regression (e.g. someone makes grounding depend on iteration order).
 *   - Mismatch → either the grounding LOGIC changed (a legitimate, reviewed
 *     change — bump {@link GROUNDING_RERUN_ORACLE_VERSION} and re-baseline)
 *     or a real non-determinism bug slipped in.
 *
 * Two invariants make this trustworthy:
 *   1. RECOMPUTE, never believe. The sidecar's recorded `grounding_downgrades`
 *      are treated as the EXPECTATION to test against, not as truth to echo.
 *   2. HERMETIC. Existence answers come from the sidecar's frozen
 *      `grounding_inputs.existence_by_path`, NOT the live disk (which has
 *      drifted since review time). The injected predicate means no `realpathSync`
 *      ever touches the real filesystem during a rerun.
 *
 * Firewall: this file's `server/` import is allow-listed precisely because of
 * invariant 1 — re-running the real gate is the whole point.
 */

import {
  validateObserverFindings,
  type GroundingDowngrade,
} from "../../server/observer-grounding.js";
import { COUNCIL_SCHEMA_VERSION, type ObserverReviewPayload } from "../../server/council-types.js";
import type {
  EvalFindingSeverity,
  EvalGroundingFailReason,
  EvalGroundingDowngrade,
  EvalSidecarArtifact,
} from "../schema/eval-artifact.js";

/**
 * Bump when the grounding SEMANTICS change in a way that legitimately alters
 * the downgrade set for the same inputs. A bump signals "re-baseline the
 * recorded sidecars" rather than "a determinism bug". Stamped on every result.
 */
export const GROUNDING_RERUN_ORACLE_VERSION = 1 as const;

/** A downgrade reduced to its comparable identity — no nested finding object,
 *  so two downgrade sets compare structurally and serialize identically. */
export interface NormalizedDowngrade {
  index: number;
  original_severity: EvalFindingSeverity;
  reason: EvalGroundingFailReason;
}

export interface GroundingRerunResult {
  oracle_version: typeof GROUNDING_RERUN_ORACLE_VERSION;
  /** True iff the recomputed downgrade set equals the recorded one exactly. */
  deterministic: boolean;
  /** Recomputed from the current gate, normalized + sorted by index. */
  recomputed: NormalizedDowngrade[];
  /** The sidecar's frozen record, normalized + sorted by index. */
  recorded: NormalizedDowngrade[];
  /** Human-readable per-index discrepancies; empty when deterministic. */
  diffs: string[];
}

/** Synthetic absolute root. The existence predicate is injected, so the gate
 *  never resolves a path against this — it just satisfies the gate's
 *  "workspaceRoot must be absolute and NUL-free" precondition. */
const HERMETIC_ROOT = "/eval-hermetic-rerun";

function normalizeRecomputed(d: GroundingDowngrade): NormalizedDowngrade {
  return {
    index: d.index,
    original_severity: d.original.severity as EvalFindingSeverity,
    reason: d.reason,
  };
}

function normalizeRecorded(d: EvalGroundingDowngrade): NormalizedDowngrade {
  return { index: d.index, original_severity: d.original_severity, reason: d.reason };
}

const byIndex = (a: NormalizedDowngrade, b: NormalizedDowngrade): number => a.index - b.index;

/**
 * Re-run the grounding gate against a sidecar's frozen inputs and compare the
 * result to the recorded downgrade set. Pure + hermetic: no disk, no clock,
 * no network. Same sidecar in → same result out.
 */
export function rerunGrounding(sidecar: EvalSidecarArtifact): GroundingRerunResult {
  // The manifest delta IS the modified-file set the gate used (per schema).
  const modifiedFiles = new Set(sidecar.manifest_partition.delta);
  const existence = sidecar.grounding_inputs.existence_by_path;
  // Hermetic existence: consult the frozen map only. A path the map never
  // recorded defaults to false — matching the live gate, which downgrades on
  // a missing/unstattable file.
  const existsRelative = (relPath: string): boolean => existence[relPath] === true;

  const review: ObserverReviewPayload = {
    schema_version: COUNCIL_SCHEMA_VERSION,
    checkpoint_id: sidecar.checkpoint_id,
    phase: sidecar.phase,
    session_group_id: sidecar.session_group_id,
    reviewed_at: sidecar.emitted_at,
    observer_provider: sidecar.observer_provider,
    observer_model: sidecar.observer_model,
    observer_cli_version: sidecar.observer_cli_version,
    findings: sidecar.raw_findings.map((f) => ({
      severity: f.severity,
      claim: f.claim,
      evidence_path: f.evidence_path,
      ...(f.evidence_lines ? { evidence_lines: f.evidence_lines } : {}),
      ...(f.confidence ? { confidence: f.confidence } : {}),
    })),
  };

  const result = validateObserverFindings(review, {
    workspaceRoot: HERMETIC_ROOT,
    modifiedFiles,
    existsRelative,
  });

  const recomputed = result.downgrades.map(normalizeRecomputed).sort(byIndex);
  const recorded = sidecar.grounding_downgrades.map(normalizeRecorded).sort(byIndex);

  const diffs = diffDowngrades(recomputed, recorded);
  return {
    oracle_version: GROUNDING_RERUN_ORACLE_VERSION,
    deterministic: diffs.length === 0,
    recomputed,
    recorded,
    diffs,
  };
}

/** Produce human-readable discrepancies between the two normalized, sorted
 *  downgrade sets. Keyed by index so a reader can correlate to raw_findings. */
function diffDowngrades(
  recomputed: NormalizedDowngrade[],
  recorded: NormalizedDowngrade[],
): string[] {
  const diffs: string[] = [];
  const recByIndex = new Map(recomputed.map((d) => [d.index, d]));
  const recordedByIndex = new Map(recorded.map((d) => [d.index, d]));
  const allIndices = [...new Set([...recByIndex.keys(), ...recordedByIndex.keys()])].sort(
    (a, b) => a - b,
  );
  for (const i of allIndices) {
    const a = recByIndex.get(i);
    const b = recordedByIndex.get(i);
    if (a && !b) {
      diffs.push(`index ${i}: recomputed downgrade (${a.reason}) not in recorded set`);
    } else if (!a && b) {
      diffs.push(`index ${i}: recorded downgrade (${b.reason}) not recomputed`);
    } else if (a && b && a.reason !== b.reason) {
      diffs.push(`index ${i}: reason drift recomputed=${a.reason} recorded=${b.reason}`);
    } else if (a && b && a.original_severity !== b.original_severity) {
      diffs.push(
        `index ${i}: original_severity drift recomputed=${a.original_severity} recorded=${b.original_severity}`,
      );
    }
  }
  return diffs;
}
