/**
 * Eval artifact contracts — the on-disk shapes the Council Eval Harness
 * reads and writes:
 *
 *  1. {@link EvalSidecarArtifact} — the opt-in `.council/eval/<checkpoint>.json`
 *     sidecar the server emits alongside each observer review. It freezes
 *     the grounding INPUTS the WebSocket recording omits (raw findings, the
 *     manifest partition, and the per-path existence answers the grounding
 *     gate consumed) so recall scoring and a hermetic grounding rerun become
 *     possible from disk alone.
 *  2. {@link EvalLabelRecord} — one human-curated ground-truth row. The
 *     `expected_blocker_missed` verdict deliberately has NO matching observer
 *     finding: it enumerates the should-have-caught set so recall /
 *     missed_blocker_rate is a counted set-difference, not an inferred absence.
 *
 * This is NOT in council-types.ts on purpose. The live orchestrator↔observer
 * wire protocol and this version-portable analysis format have different
 * lifecycles: a scorer must read a v1 sidecar produced by an old Aura build
 * without dragging the current wire schema. Versioning is therefore
 * independent — {@link EVAL_ARTIFACT_VERSION} / {@link EVAL_LABEL_VERSION}.
 *
 * Pure types + constants + a version guard. No `server/` imports — this file
 * lives inside the eval import firewall.
 */

/**
 * Sidecar schema version. First field of every artifact so a reader sees the
 * discriminator before any content. Bump ONLY on a breaking shape change;
 * additive fields do not bump (readers tolerate unknown extra keys).
 */
export const EVAL_ARTIFACT_VERSION = 1 as const;

/** Human-label schema version. Independent of the sidecar — labels are
 *  authored by hand and evolve on their own cadence. */
export const EVAL_LABEL_VERSION = 1 as const;

/** Hard size cap for a single sidecar artifact. Larger than the 256 KB
 *  council-artifact default because the sidecar embeds the raw review plus
 *  the manifest partition; writeAtomicJson must be called with this explicit
 *  maxBytes or the embed throws against the smaller default. */
export const EVAL_SIDECAR_MAX_BYTES = 1024 * 1024;

/** Severity tiers, mirrored from council-types so the eval format is
 *  self-contained (a scorer never imports the wire schema to read a
 *  severity). Kept as a string union, validated structurally on read. */
export type EvalFindingSeverity = "STOP" | "WARN" | "NOTE" | "INFO";

/** Grounding downgrade reasons, mirrored from observer-grounding. */
export type EvalGroundingFailReason =
  | "evidence_not_in_modified_set"
  | "evidence_missing_on_disk";

/**
 * The manifest partition the observer reviewed, captured as SORTED arrays so
 * two semantically-identical sidecars serialize byte-identically (stable
 * diffs across Aura versions). `delta` doubles as the modified-file set the
 * grounding gate used.
 */
export interface EvalManifestPartition {
  /** Paths newly in scope this checkpoint — the grounding "modified set". */
  delta: string[];
  /** Paths carried from the previous checkpoint. */
  carried: string[];
  /** Paths dropped from scope this cycle. */
  dropped: string[];
}

/** One raw observer finding as emitted PRE-grounding (the model's claim). */
export interface EvalRawFinding {
  severity: EvalFindingSeverity;
  claim: string;
  evidence_path: string;
  evidence_lines?: [number, number];
  confidence?: "high" | "medium" | "low";
}

/** One grounding downgrade the gate applied, by index into the raw findings. */
export interface EvalGroundingDowngrade {
  /** Index into {@link EvalSidecarArtifact.raw_findings}. */
  index: number;
  /** Severity before the downgrade (always "STOP" in the current gate). */
  original_severity: EvalFindingSeverity;
  reason: EvalGroundingFailReason;
}

/**
 * The frozen filesystem-facing inputs to the grounding gate: for each
 * evidence_path the gate consulted, whether it existed within the workspace
 * at review time. Recording this makes a later grounding rerun hermetic — it
 * recomputes the downgrade set from this map instead of re-statting the live
 * (now-changed) disk.
 */
export interface EvalGroundingInputs {
  /** Workspace-relative evidence_path → existed-within-bounds at review time. */
  existence_by_path: Record<string, boolean>;
}

export interface EvalSidecarArtifact {
  /** MUST be the first field — schema discriminator. */
  eval_artifact_version: typeof EVAL_ARTIFACT_VERSION;
  session_group_id: string;
  checkpoint_id: string;
  phase: string;
  observer_provider: string;
  observer_model: string;
  /** CLI binary version that produced the review (audit/cohorting). */
  observer_cli_version: string;
  /** Hash of the observer system prompt at spawn (cohorting — a prompt edit
   *  must not read as a phantom quality regression). */
  observer_prompt_sha256: string;
  /** Wallclock ISO 8601 (T-separated) when the sidecar was emitted. */
  emitted_at: string;
  /** The manifest partition the observer reviewed (sorted arrays). */
  manifest_partition: EvalManifestPartition;
  /** Findings exactly as the observer emitted them, pre-grounding. */
  raw_findings: EvalRawFinding[];
  /** Downgrades the grounding gate recorded at review time. The rerun
   *  RECOMPUTES rather than trusts these — they are kept for diffing. */
  grounding_downgrades: EvalGroundingDowngrade[];
  /** Frozen fs inputs so the rerun is hermetic. */
  grounding_inputs: EvalGroundingInputs;
}

/** Ground-truth verdict for a single labeled finding/expectation. */
export type EvalLabelVerdict =
  | "true_positive"
  | "false_positive"
  /** A blocker the observer SHOULD have emitted but did not — has no
   *  matching observer finding; powers recall / missed_blocker_rate. */
  | "expected_blocker_missed";

export interface EvalLabelRecord {
  eval_label_version: typeof EVAL_LABEL_VERSION;
  /** Deterministic content-derived id for first/last-write-wins dedup across
   *  the append-only label log (set by the writer, see Risks/Persistence). */
  id: string;
  session_group_id: string;
  checkpoint_id: string;
  /** Workspace-relative path the label is about. */
  evidence_path: string;
  /** Stable issue class — the third component of the finding↔label join key
   *  `(checkpoint_id, evidence_path, issue_class)`. */
  issue_class: string;
  verdict: EvalLabelVerdict;
  /** Who/what produced the label (human handle, or a calibration source). */
  labeler?: string;
  /** Wallclock ISO 8601 (T-separated) when the label was authored. */
  labeled_at?: string;
  note?: string;
}

/**
 * Version guard used by every reader before structural parsing. A locally
 * produced artifact with an unknown version is a hard reject (fail loud —
 * we wrote it, so a mismatch is a bug), distinct from unknown extra FIELDS
 * which readers tolerate. Kept tiny and dependency-free so it sits at the
 * very top of the parse path.
 */
export function isSupportedEvalArtifactVersion(v: unknown): v is typeof EVAL_ARTIFACT_VERSION {
  return v === EVAL_ARTIFACT_VERSION;
}

export function isSupportedEvalLabelVersion(v: unknown): v is typeof EVAL_LABEL_VERSION {
  return v === EVAL_LABEL_VERSION;
}
