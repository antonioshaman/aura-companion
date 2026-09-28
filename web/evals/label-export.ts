/**
 * Label-queue export (P3/B3) — pure selection logic behind `eval:label-export`.
 *
 * Given findings recovered from recordings and every label log a human (or
 * the orchestrator) has already filled, return only the findings nobody has
 * judged yet, each exactly once. Two label shapes exist in the wild:
 *
 *   - `EvalLabelRecord` (`judge-calibration/human-labels.jsonl`, written by
 *     `eval:label-ingest`) — joins on `finding_id`.
 *   - hand-kept diet logs (`$WORK/labeling/observer-labels.jsonl`) — no
 *     finding id, joins on `(checkpoint_id, severity, evidence_path)`.
 *
 * A line matching neither is ignored (it cannot name a finding). Records with
 * a null severity (false_negative / true_negative rows) label a checkpoint,
 * not a finding, and never suppress one.
 *
 * Firewall-clean: no `server/` imports, no disk.
 */

import type { ExtractedFinding } from "./scorers/findings-extractor.js";

export interface LabelKeys {
  findingIds: Set<string>;
  coords: Set<string>;
}

function coordKey(checkpointId: string, severity: string, evidencePath: string): string {
  return `${checkpointId}\0${severity.toUpperCase()}\0${evidencePath}`;
}

/** Collect join keys from any number of JSONL label logs. Malformed lines are
 *  skipped: a truncated log must not make already-labeled work reappear
 *  wholesale, but it also must not abort the export. */
export function collectLabelKeys(logs: string[]): LabelKeys {
  const keys: LabelKeys = { findingIds: new Set(), coords: new Set() };
  for (const text of logs) {
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      let v: unknown;
      try {
        v = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof v !== "object" || v === null) continue;
      const r = v as Record<string, unknown>;
      if (typeof r.finding_id === "string" && r.finding_id !== "") keys.findingIds.add(r.finding_id);
      if (
        typeof r.checkpoint_id === "string" &&
        typeof r.severity === "string" &&
        typeof r.evidence_path === "string"
      ) {
        keys.coords.add(coordKey(r.checkpoint_id, r.severity, r.evidence_path));
      }
    }
  }
  return keys;
}

export interface ExportSelection {
  queue: ExtractedFinding[];
  /** Same finding seen again (other recording, mirrored frame). */
  duplicates: number;
  /** Already carries a label in one of the logs. */
  alreadyLabeled: number;
}

export function selectUnlabeled(findings: ExtractedFinding[], keys: LabelKeys): ExportSelection {
  const seen = new Set<string>();
  const queue: ExtractedFinding[] = [];
  let duplicates = 0;
  let alreadyLabeled = 0;
  for (const f of findings) {
    if (seen.has(f.id)) {
      duplicates++;
      continue;
    }
    seen.add(f.id);
    if (keys.findingIds.has(f.id) || keys.coords.has(coordKey(f.checkpoint_id, f.severity, f.evidence_path))) {
      alreadyLabeled++;
      continue;
    }
    queue.push(f);
  }
  return { queue, duplicates, alreadyLabeled };
}

export interface LabeledStops {
  /** Distinct STOP findings carrying a decisive verdict. */
  stops: number;
  /** Of those, verdict exactly `true_positive`. A `partial_true_positive`
   *  counts toward `stops` but NOT here — the gate is fail-closed. */
  truePositive: number;
  /** truePositive / stops, or "unavailable" at zero. */
  precision: number | "unavailable";
}

/**
 * Labeled STOPs — the denominator of the B3 sufficiency verdict. Counts
 * decisive verdicts (true/false positive, incl. `partial_true_positive`) on
 * STOP findings, each distinct finding once even if labeled in both logs
 * (last verdict wins).
 *
 * Coordinate-keyed rows carry their own severity. An `EvalLabelRecord` has
 * none, so its `finding_id` is resolved against `findings`; an id that does
 * not resolve is NOT counted — undercounting keeps the verdict "unproven",
 * which is the fail-closed direction.
 */
export function countLabeledStops(logs: string[], findings: ExtractedFinding[]): LabeledStops {
  const byId = new Map(findings.map((f) => [f.id, f] as const));
  const verdicts = new Map<string, string>();
  for (const text of logs) {
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      let r: Record<string, unknown>;
      try {
        const v: unknown = JSON.parse(line);
        if (typeof v !== "object" || v === null) continue;
        r = v as Record<string, unknown>;
      } catch {
        continue;
      }
      const verdict = typeof r.verdict === "string" ? r.verdict : typeof r.label === "string" ? r.label : "";
      if (!/(^|_)(true|false)_positive$/.test(verdict)) continue;
      if (typeof r.finding_id === "string" && r.finding_id !== "") {
        // Resolve to coordinates so the same finding labeled in both logs
        // collapses to one key.
        const f = byId.get(r.finding_id);
        if (f?.severity === "STOP") verdicts.set(coordKey(f.checkpoint_id, "STOP", f.evidence_path), verdict);
      } else if (
        typeof r.severity === "string" &&
        r.severity.toUpperCase() === "STOP" &&
        typeof r.checkpoint_id === "string" &&
        typeof r.evidence_path === "string"
      ) {
        verdicts.set(coordKey(r.checkpoint_id, "STOP", r.evidence_path), verdict);
      }
    }
  }
  const stops = verdicts.size;
  const truePositive = [...verdicts.values()].filter((v) => v === "true_positive").length;
  return { stops, truePositive, precision: stops === 0 ? "unavailable" : truePositive / stops };
}
