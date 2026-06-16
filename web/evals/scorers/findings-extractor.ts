/**
 * Observer-findings extractor — the cheap, zero-LLM bridge toward M2
 * (precision/recall). It reads the observer review artifacts that real council
 * pairs ALREADY wrote to disk (`<workspace>/.council/reviews/<phase>-<provider>-observer.md`,
 * JSON despite the `.md` extension) and normalizes every emitted finding into a
 * flat, labelable row.
 *
 * This is the DENOMINATOR population for human labeling: "here is everything the
 * observer actually flagged across these pairs — now mark each true_positive /
 * false_positive." It needs no eval sidecar and no fresh live run — it scores
 * artifacts that already exist. (The `expected_blocker_missed` recall set is
 * authored separately as EvalLabelRecords; it cannot be extracted from observer
 * output by construction.)
 *
 * Firewall-clean: imports only the eval schema + node builtins. Never `server/`.
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { createHash } from "node:crypto";
import type { EvalFindingSeverity } from "../schema/eval-artifact.js";

const SEVERITIES: ReadonlySet<string> = new Set(["STOP", "WARN", "NOTE", "INFO"]);

export interface ExtractedFinding {
  /** Deterministic content id — stable across re-extraction, dedup-friendly. */
  id: string;
  /** Review filename (basename) the finding came from. */
  review_file: string;
  checkpoint_id: string;
  phase: string;
  session_group_id: string;
  observer_provider: string;
  observer_model: string;
  /** ISO timestamp the review was written — used to fetch evidence code as of
   *  review time (the code may have drifted since). "" when absent. */
  reviewed_at: string;
  severity: EvalFindingSeverity;
  claim: string;
  evidence_path: string;
  evidence_lines?: [number, number];
  confidence?: "high" | "medium" | "low";
}

export interface FindingsExtract {
  findings: ExtractedFinding[];
  /** Files that parsed to a review carrying a findings array. */
  reviews: number;
  /** Files that were not parseable as a findings-bearing review (heartbeat,
   *  spawn ack, malformed JSON, no findings array). */
  skipped: number;
  /** Individual finding objects dropped for a bad shape inside a good review. */
  malformed_findings: number;
  by_severity: Record<EvalFindingSeverity, number>;
}

interface ReviewDoc {
  checkpoint_id: string;
  phase: string;
  session_group_id: string;
  observer_provider: string;
  observer_model: string;
  reviewed_at: string;
  findings: unknown[];
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

/**
 * Stable id from the finding's identity tuple. Mirrors the server's intent
 * (deterministic ids so re-extraction dedupes) without importing its scheme.
 *
 * Exported so the precision corpus (which scores SIDECARS, not review files)
 * derives the exact same `efnd_<hex>` join key as this extractor — a single
 * id authority keeps finding↔label joins consistent across both paths.
 */
export function computeFindingId(
  groupId: string,
  checkpointId: string,
  provider: string,
  evidencePath: string,
  claim: string,
): string {
  const h = createHash("sha256");
  h.update(`${groupId}\0${checkpointId}\0${provider}\0${evidencePath}\0${claim}`);
  return "efnd_" + h.digest("hex").slice(0, 12);
}

function parseReviewDoc(text: string): ReviewDoc | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.findings)) return null;
  return {
    checkpoint_id: str(o.checkpoint_id),
    phase: str(o.phase),
    session_group_id: str(o.session_group_id),
    observer_provider: str(o.observer_provider),
    observer_model: str(o.observer_model),
    reviewed_at: str(o.reviewed_at),
    findings: o.findings,
  };
}

function evidenceLines(v: unknown): [number, number] | undefined {
  if (
    Array.isArray(v) &&
    v.length === 2 &&
    typeof v[0] === "number" &&
    typeof v[1] === "number"
  ) {
    return [v[0], v[1]];
  }
  return undefined;
}

function confidence(v: unknown): ExtractedFinding["confidence"] {
  return v === "high" || v === "medium" || v === "low" ? v : undefined;
}

/**
 * Extract + normalize observer findings from a list of review-file paths. A
 * file that is not a findings-bearing review (heartbeat, spawn ack, malformed)
 * is counted in `skipped`, never thrown on. Severity is validated against the
 * canonical tier set; an out-of-vocabulary or shapeless finding inside an
 * otherwise-good review is counted in `malformed_findings`.
 */
export function extractFindings(paths: string[]): FindingsExtract {
  const findings: ExtractedFinding[] = [];
  const by_severity: Record<EvalFindingSeverity, number> = { STOP: 0, WARN: 0, NOTE: 0, INFO: 0 };
  let reviews = 0;
  let skipped = 0;
  let malformed_findings = 0;

  for (const path of paths) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      skipped++;
      continue;
    }
    const doc = parseReviewDoc(text);
    if (doc === null) {
      skipped++;
      continue;
    }
    reviews++;
    const review_file = basename(path);
    for (const raw of doc.findings) {
      if (typeof raw !== "object" || raw === null) {
        malformed_findings++;
        continue;
      }
      const f = raw as Record<string, unknown>;
      const severity = str(f.severity).toUpperCase();
      const evidence_path = str(f.evidence_path);
      const claim = str(f.claim);
      if (!SEVERITIES.has(severity) || evidence_path === "" || claim === "") {
        malformed_findings++;
        continue;
      }
      const sev = severity as EvalFindingSeverity;
      by_severity[sev]++;
      findings.push({
        id: computeFindingId(doc.session_group_id, doc.checkpoint_id, doc.observer_provider, evidence_path, claim),
        review_file,
        checkpoint_id: doc.checkpoint_id,
        phase: doc.phase,
        session_group_id: doc.session_group_id,
        observer_provider: doc.observer_provider,
        observer_model: doc.observer_model,
        reviewed_at: doc.reviewed_at,
        severity: sev,
        claim,
        evidence_path,
        ...(evidenceLines(f.evidence_lines) ? { evidence_lines: evidenceLines(f.evidence_lines) } : {}),
        ...(confidence(f.confidence) ? { confidence: confidence(f.confidence) } : {}),
      });
    }
  }

  return { findings, reviews, skipped, malformed_findings, by_severity };
}
