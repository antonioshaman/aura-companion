/**
 * Boundary parsers for the two on-disk eval artifacts: the opt-in sidecar
 * (`.council/eval/<checkpoint>.json`) and the human-curated label log
 * (append-only JSONL). These sit at the trust boundary — a sidecar may have
 * been produced by an OLD Aura build and a label is hand-authored — so every
 * field is validated structurally on read, and the result is a three-state
 * `{ok:true,value} | {ok:false,reason}` rather than a throw. A scorer feeds
 * untrusted disk bytes in and gets back either a fully-typed artifact or a
 * human-readable rejection reason; it never has to wrap a try/catch.
 *
 * Version policy: an unknown VERSION is a hard reject (we wrote the sidecar,
 * so a mismatch is a real incompatibility the caller must opt into), while
 * unknown EXTRA fields are tolerated (additive evolution). This mirrors
 * {@link isSupportedEvalArtifactVersion}'s "fail loud on locally produced"
 * intent.
 *
 * Firewall-clean: imports only the eval schema. Never `server/`.
 */

import {
  EVAL_SIDECAR_MAX_BYTES,
  isSupportedEvalArtifactVersion,
  isSupportedEvalLabelVersion,
  type EvalFindingSeverity,
  type EvalGroundingDowngrade,
  type EvalGroundingFailReason,
  type EvalLabelRecord,
  type EvalLabelVerdict,
  type EvalManifestPartition,
  type EvalRawFinding,
  type EvalSidecarArtifact,
} from "./eval-artifact.js";

/** Three-state parse result — a typed value or a human-readable reason. */
export type ParseResult<T> = { ok: true; value: T } | { ok: false; reason: string };

const ok = <T>(value: T): ParseResult<T> => ({ ok: true, value });
const fail = <T>(reason: string): ParseResult<T> => ({ ok: false, reason });

const SEVERITIES: ReadonlySet<string> = new Set(["STOP", "WARN", "NOTE", "INFO"]);
const FAIL_REASONS: ReadonlySet<string> = new Set([
  "evidence_not_in_modified_set",
  "evidence_missing_on_disk",
]);
const VERDICTS: ReadonlySet<string> = new Set([
  "true_positive",
  "false_positive",
  "expected_blocker_missed",
]);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Every element of `v` is a string (an empty array passes). */
function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === "string");
}

function parseManifestPartition(v: unknown): ParseResult<EvalManifestPartition> {
  if (!isObject(v)) return fail("manifest_partition is not an object");
  if (!isStringArray(v.delta)) return fail("manifest_partition.delta is not a string[]");
  if (!isStringArray(v.carried)) return fail("manifest_partition.carried is not a string[]");
  if (!isStringArray(v.dropped)) return fail("manifest_partition.dropped is not a string[]");
  return ok({ delta: v.delta, carried: v.carried, dropped: v.dropped });
}

function parseEvidenceLines(v: unknown): [number, number] | undefined {
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

function parseRawFinding(v: unknown, i: number): ParseResult<EvalRawFinding> {
  if (!isObject(v)) return fail(`raw_findings[${i}] is not an object`);
  if (typeof v.severity !== "string" || !SEVERITIES.has(v.severity)) {
    return fail(`raw_findings[${i}].severity is not a valid tier`);
  }
  if (typeof v.claim !== "string" || v.claim === "") {
    return fail(`raw_findings[${i}].claim is missing`);
  }
  if (typeof v.evidence_path !== "string" || v.evidence_path === "") {
    return fail(`raw_findings[${i}].evidence_path is missing`);
  }
  const finding: EvalRawFinding = {
    severity: v.severity as EvalFindingSeverity,
    claim: v.claim,
    evidence_path: v.evidence_path,
  };
  const lines = parseEvidenceLines(v.evidence_lines);
  if (lines) finding.evidence_lines = lines;
  if (v.confidence === "high" || v.confidence === "medium" || v.confidence === "low") {
    finding.confidence = v.confidence;
  }
  return ok(finding);
}

function parseDowngrade(
  v: unknown,
  i: number,
  rawFindingCount: number,
): ParseResult<EvalGroundingDowngrade> {
  if (!isObject(v)) return fail(`grounding_downgrades[${i}] is not an object`);
  if (typeof v.index !== "number" || !Number.isInteger(v.index)) {
    return fail(`grounding_downgrades[${i}].index is not an integer`);
  }
  if (v.index < 0 || v.index >= rawFindingCount) {
    return fail(`grounding_downgrades[${i}].index ${v.index} out of raw_findings range`);
  }
  if (typeof v.original_severity !== "string" || !SEVERITIES.has(v.original_severity)) {
    return fail(`grounding_downgrades[${i}].original_severity is not a valid tier`);
  }
  if (typeof v.reason !== "string" || !FAIL_REASONS.has(v.reason)) {
    return fail(`grounding_downgrades[${i}].reason is not a valid downgrade reason`);
  }
  return ok({
    index: v.index,
    original_severity: v.original_severity as EvalFindingSeverity,
    reason: v.reason as EvalGroundingFailReason,
  });
}

function parseExistenceMap(v: unknown): ParseResult<Record<string, boolean>> {
  if (!isObject(v)) return fail("grounding_inputs.existence_by_path is not an object");
  const out: Record<string, boolean> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val !== "boolean") {
      return fail(`grounding_inputs.existence_by_path[${k}] is not a boolean`);
    }
    out[k] = val;
  }
  return ok(out);
}

/**
 * Parse a sidecar artifact from its raw on-disk text. Size-caps BEFORE the
 * JSON parse (a hostile or corrupt file must not be able to make us allocate
 * an arbitrary string), hard-rejects an unknown version, then validates every
 * field structurally. Unknown extra keys are ignored.
 */
export function parseSidecarArtifact(
  text: string,
  maxBytes: number = EVAL_SIDECAR_MAX_BYTES,
): ParseResult<EvalSidecarArtifact> {
  if (typeof text !== "string") return fail("sidecar text is not a string");
  // Byte length, not char length — a UTF-8 file's size cap is in bytes.
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    return fail(`sidecar exceeds ${maxBytes}-byte cap`);
  }
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return fail("sidecar is not valid JSON");
  }
  if (!isObject(v)) return fail("sidecar is not an object");
  if (!isSupportedEvalArtifactVersion(v.eval_artifact_version)) {
    return fail(`unsupported eval_artifact_version: ${String(v.eval_artifact_version)}`);
  }

  const stringFields = [
    "session_group_id",
    "checkpoint_id",
    "phase",
    "observer_provider",
    "observer_model",
    "observer_cli_version",
    "observer_prompt_sha256",
    "emitted_at",
  ] as const;
  for (const f of stringFields) {
    if (typeof v[f] !== "string") return fail(`sidecar.${f} is not a string`);
  }

  const partition = parseManifestPartition(v.manifest_partition);
  if (!partition.ok) return partition;

  if (!Array.isArray(v.raw_findings)) return fail("sidecar.raw_findings is not an array");
  const rawFindings: EvalRawFinding[] = [];
  for (let i = 0; i < v.raw_findings.length; i++) {
    const r = parseRawFinding(v.raw_findings[i], i);
    if (!r.ok) return r;
    rawFindings.push(r.value);
  }

  if (!Array.isArray(v.grounding_downgrades)) {
    return fail("sidecar.grounding_downgrades is not an array");
  }
  const downgrades: EvalGroundingDowngrade[] = [];
  for (let i = 0; i < v.grounding_downgrades.length; i++) {
    const d = parseDowngrade(v.grounding_downgrades[i], i, rawFindings.length);
    if (!d.ok) return d;
    downgrades.push(d.value);
  }

  if (!isObject(v.grounding_inputs)) return fail("sidecar.grounding_inputs is not an object");
  const existence = parseExistenceMap((v.grounding_inputs as Record<string, unknown>).existence_by_path);
  if (!existence.ok) return existence;

  return ok({
    eval_artifact_version: v.eval_artifact_version,
    session_group_id: v.session_group_id as string,
    checkpoint_id: v.checkpoint_id as string,
    phase: v.phase as string,
    observer_provider: v.observer_provider as string,
    observer_model: v.observer_model as string,
    observer_cli_version: v.observer_cli_version as string,
    observer_prompt_sha256: v.observer_prompt_sha256 as string,
    emitted_at: v.emitted_at as string,
    manifest_partition: partition.value,
    raw_findings: rawFindings,
    grounding_downgrades: downgrades,
    grounding_inputs: { existence_by_path: existence.value },
  });
}

/**
 * Parse a single label record (one already-JSON.parse'd object). The label log
 * is append-only JSONL, so the per-line caller owns the line split and the
 * tolerant skip of malformed lines; this validates one object's shape.
 */
export function parseLabelRecord(v: unknown): ParseResult<EvalLabelRecord> {
  if (!isObject(v)) return fail("label is not an object");
  if (!isSupportedEvalLabelVersion(v.eval_label_version)) {
    return fail(`unsupported eval_label_version: ${String(v.eval_label_version)}`);
  }
  const stringFields = [
    "id",
    "session_group_id",
    "checkpoint_id",
    "evidence_path",
    "issue_class",
  ] as const;
  for (const f of stringFields) {
    if (typeof v[f] !== "string" || v[f] === "") return fail(`label.${f} is missing`);
  }
  if (typeof v.verdict !== "string" || !VERDICTS.has(v.verdict)) {
    return fail("label.verdict is not a valid verdict");
  }
  const record: EvalLabelRecord = {
    eval_label_version: v.eval_label_version,
    id: v.id as string,
    session_group_id: v.session_group_id as string,
    checkpoint_id: v.checkpoint_id as string,
    evidence_path: v.evidence_path as string,
    issue_class: v.issue_class as string,
    verdict: v.verdict as EvalLabelVerdict,
  };
  if (typeof v.labeler === "string") record.labeler = v.labeler;
  if (typeof v.labeled_at === "string") record.labeled_at = v.labeled_at;
  if (typeof v.note === "string") record.note = v.note;
  return ok(record);
}

export interface LabelLogParse {
  /** Successfully parsed, deduped records (last-write-wins by id). */
  records: EvalLabelRecord[];
  /** Lines that were not parseable as a label (blank-skipped lines excluded). */
  skipped: number;
}

/**
 * Parse an append-only label JSONL log. Tolerant line-split (a malformed or
 * truncated line is counted in `skipped`, never thrown on) mirroring the
 * recording reader. Dedup is LAST-write-wins by `id`: the log is append-only,
 * so a later row supersedes an earlier one with the same content-derived id.
 */
export function parseLabelLog(text: string): LabelLogParse {
  const byId = new Map<string, EvalLabelRecord>();
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      skipped++;
      continue;
    }
    const r = parseLabelRecord(parsed);
    if (!r.ok) {
      skipped++;
      continue;
    }
    byId.set(r.value.id, r.value);
  }
  return { records: [...byId.values()], skipped };
}
