/**
 * Precision-corpus scorer — the deterministic, zero-LLM bridge that lets the CI
 * gate measure observer STOP precision/recall (launch criterion #1 + Story 3.1)
 * the same way it already measures cost/latency: score a checked-in synthetic
 * corpus, reduce to a stable summary, diff against a committed baseline.
 *
 * The corpus is a directory of:
 *   - `*.sidecar.json` — each an {@link EvalSidecarArtifact} (the frozen
 *     grounding INPUTS: raw findings + manifest delta + per-path existence).
 *   - `labels.jsonl` — append-only {@link EvalLabelRecord} log (human verdicts +
 *     expected_blocker_missed rows).
 *
 * Why grounded severity is RECOMPUTED, not read from the sidecar: a synthetic
 * fixture is frozen, so trusting its recorded downgrades would make the gate a
 * tautology that catches no code change. Instead we re-drive the LIVE grounding
 * gate via {@link rerunGrounding} — so a regression in grounding logic (e.g. one
 * that silences a real blocker, or stops downgrading a false STOP) actually
 * moves grounded precision/recall and trips the gate. That is the whole point of
 * a synthetic precision corpus.
 *
 * Firewall note: this module imports `grounding-rerun`, which is the single
 * allow-listed `server/` coupling. This file itself imports no `server/` path,
 * so it stays on the clean side of the import firewall.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseLabelLog, parseSidecarArtifact } from "../schema/parse-artifact.js";
import type { EvalLabelRecord, EvalSidecarArtifact } from "../schema/eval-artifact.js";
import { computeFindingId } from "./findings-extractor.js";
import { rerunGrounding } from "./grounding-rerun.js";
import {
  scoreObserverPrecision,
  type ObserverPrecisionScore,
  type Ratio,
  type ScorableFinding,
} from "./observer-precision.js";

/** Filename of the label log inside a precision-corpus directory. */
export const PRECISION_LABELS_FILE = "labels.jsonl";

/**
 * Turn one sidecar into its scorable findings. `raw_severity` is the observer's
 * claim as emitted; `grounded_severity` is recomputed by re-running the live
 * grounding gate — a downgraded index becomes NOTE (the gate's only downgrade
 * target), everything else keeps its raw tier. The id is the SAME `efnd_<hex>`
 * the findings extractor produces, so labels authored against extracted findings
 * join cleanly here.
 */
export function buildScorableFindings(sidecar: EvalSidecarArtifact): ScorableFinding[] {
  const rerun = rerunGrounding(sidecar);
  const downgradedIndices = new Set(rerun.recomputed.map((d) => d.index));
  return sidecar.raw_findings.map((f, i) => ({
    id: computeFindingId(
      sidecar.session_group_id,
      sidecar.checkpoint_id,
      sidecar.observer_provider,
      f.evidence_path,
      f.claim,
    ),
    checkpoint_id: sidecar.checkpoint_id,
    evidence_path: f.evidence_path,
    raw_severity: f.severity,
    grounded_severity: downgradedIndices.has(i) ? "NOTE" : f.severity,
  }));
}

/** A {@link Ratio} reduced to a serialization-stable value: the numeric ratio,
 *  or the string "unavailable" (absent-vs-zero — NOT 0, NOT 1). */
export type SerialRatio = number | "unavailable";

const serialRatio = (r: Ratio): SerialRatio => (r.kind === "value" ? r.value : "unavailable");

/** One tier (raw or grounded) reduced to the comparable subset the gate diffs. */
export interface SerialTier {
  surfaced: number;
  true_positive: number;
  false_positive: number;
  unlabeled: number;
  precision: SerialRatio;
  false_stop_rate: SerialRatio;
  recall: SerialRatio;
}

/** The full precision score reduced to a flat, byte-stable shape for baselining. */
export interface PrecisionSummary {
  raw: SerialTier;
  grounded: SerialTier;
  delta: ObserverPrecisionScore["delta"];
  missed_blockers: number;
  orphan_verdict_labels: number;
  /** Sidecars contributing findings — surfaced so an accidentally-empty corpus
   *  is visible in the baseline rather than silently scoring nothing. */
  sidecars: number;
  /** Total findings scored across the corpus. */
  findings: number;
  /** tp/fp/expected_blocker_missed label rows in scope. */
  labels: number;
}

function serialTier(t: ObserverPrecisionScore["raw"]): SerialTier {
  return {
    surfaced: t.surfaced,
    true_positive: t.true_positive,
    false_positive: t.false_positive,
    unlabeled: t.unlabeled,
    precision: serialRatio(t.precision),
    false_stop_rate: serialRatio(t.false_stop_rate),
    recall: serialRatio(t.recall),
  };
}

export function summarizePrecision(
  score: ObserverPrecisionScore,
  counts: { sidecars: number; findings: number; labels: number },
): PrecisionSummary {
  return {
    raw: serialTier(score.raw),
    grounded: serialTier(score.grounded),
    delta: score.delta,
    missed_blockers: score.missed_blockers,
    orphan_verdict_labels: score.orphan_verdict_labels,
    sidecars: counts.sidecars,
    findings: counts.findings,
    labels: counts.labels,
  };
}

export interface PrecisionCorpus {
  sidecars: EvalSidecarArtifact[];
  labels: EvalLabelRecord[];
  findings: ScorableFinding[];
  /** Sidecar files that failed to parse, with the reason. Surfaced, not thrown,
   *  so one corrupt fixture is visible rather than aborting the whole load. */
  rejected_sidecars: { file: string; reason: string }[];
  /** Label lines that failed to parse (from parseLabelLog's skipped count). */
  skipped_labels: number;
}

/**
 * Load a precision corpus from `dir`: every `*.sidecar.json` plus the
 * `labels.jsonl` log. Sidecars are scored in sorted (byte-stable) filename
 * order so concatenated findings are deterministic. A sidecar that fails to
 * parse is recorded in `rejected_sidecars` rather than thrown — the caller
 * (the CI gate) decides whether a rejection is fatal.
 */
export function loadPrecisionCorpus(dir: string): PrecisionCorpus {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sidecar.json"))
    .sort();
  const sidecars: EvalSidecarArtifact[] = [];
  const findings: ScorableFinding[] = [];
  const rejected_sidecars: { file: string; reason: string }[] = [];
  for (const f of files) {
    const parsed = parseSidecarArtifact(readFileSync(join(dir, f), "utf8"));
    if (!parsed.ok) {
      rejected_sidecars.push({ file: f, reason: parsed.reason });
      continue;
    }
    sidecars.push(parsed.value);
    findings.push(...buildScorableFindings(parsed.value));
  }
  let labels: EvalLabelRecord[] = [];
  let skipped_labels = 0;
  try {
    const log = parseLabelLog(readFileSync(join(dir, PRECISION_LABELS_FILE), "utf8"));
    labels = log.records;
    skipped_labels = log.skipped;
  } catch {
    // Missing label log → empty labels; the CI gate's unlabeled-corpus guard
    // turns this into a hard failure (a passing unlabeled result is forbidden).
    labels = [];
  }
  return { sidecars, labels, findings, rejected_sidecars, skipped_labels };
}

export interface PrecisionCorpusResult {
  summary: PrecisionSummary;
  corpus: PrecisionCorpus;
}

/** Load + score a precision corpus directory into a stable summary. Pure aside
 *  from the directory read: no clock, no network, no randomness. */
export function scorePrecisionCorpus(dir: string): PrecisionCorpusResult {
  const corpus = loadPrecisionCorpus(dir);
  const score = scoreObserverPrecision(corpus.findings, corpus.labels);
  const summary = summarizePrecision(score, {
    sidecars: corpus.sidecars.length,
    findings: corpus.findings.length,
    labels: corpus.labels.length,
  });
  return { summary, corpus };
}

/** Field-level diff between a freshly-scored summary and the committed baseline.
 *  Empty array ⇔ no regression. Each line names the metric path that drifted so
 *  the CI failure points straight at stop_precision / stop_recall / etc. */
export function diffPrecisionSummary(
  current: PrecisionSummary,
  baseline: PrecisionSummary,
): string[] {
  const diffs: string[] = [];
  const walk = (path: string, c: unknown, b: unknown): void => {
    if (
      typeof c === "object" &&
      c !== null &&
      typeof b === "object" &&
      b !== null &&
      !Array.isArray(c) &&
      !Array.isArray(b)
    ) {
      const keys = [
        ...new Set([...Object.keys(c as object), ...Object.keys(b as object)]),
      ].sort();
      for (const k of keys) {
        walk(path ? `${path}.${k}` : k, (c as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]);
      }
      return;
    }
    if (JSON.stringify(c) !== JSON.stringify(b)) {
      diffs.push(`${path}: baseline=${JSON.stringify(b)} current=${JSON.stringify(c)}`);
    }
  };
  walk("", current, baseline);
  return diffs;
}
