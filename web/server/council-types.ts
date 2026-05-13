/**
 * Shared types and validators for Council Mode artifacts written by the
 * orchestrator (`.council/checkpoints/<phase>.json`) and the observer
 * (`.council/reviews/<phase>-observer.md` — frontmatter block parsed via
 * `ObserverReviewPayload`).
 *
 * One definition, two consumers (writer + reader). This is the single
 * cross-process contract — drift here desyncs the pair silently.
 */

export const COUNCIL_SCHEMA_VERSION = 1 as const;

/** Hard size cap for any single council artifact (defence against runaway writers OOM'ing the watcher). */
export const COUNCIL_ARTIFACT_MAX_BYTES = 256 * 1024;

/**
 * Wake-payload schema version. Independent of {@link COUNCIL_SCHEMA_VERSION}
 * — the writer is the server (not the orchestrator process), the reader is
 * the observer's autoregressive parse, and the lifecycle of "what bytes we
 * push into the observer's stdin" can evolve separately from "what JSON
 * the orchestrator writes to disk". A bump here MUST be paired with a
 * matching prompt-artifact header bump in `.council/prompts/observer-system.md`
 * (see Task 10) so a v2 server cannot silently misalign with a v1 prompt.
 */
export const OBSERVER_WAKE_PAYLOAD_VERSION = 1 as const;

/** Hard size cap for the assembled wake message body (hybrid preamble +
 *  fenced JSON + terminator). Generous — the manifest carries paths only,
 *  not file contents — but capped so a pathological checkpoint cannot
 *  produce a multi-megabyte NDJSON line that wedges the recorder or the
 *  observer's stream-json reader. */
export const OBSERVER_WAKE_MAX_BYTES = 32 * 1024;

/** Per-section cap for delta/carried/dropped arrays inside the wake
 *  payload. Each section is bounded independently so a runaway `delta`
 *  cannot displace `carried`/`dropped` from the observer's view. */
export const OBSERVER_WAKE_MAX_PATHS_PER_SECTION = 50;

/**
 * Council Mode auto-wake — frontend-side timeout bound for the
 * `reviewing` panel state. Published on the `group_created` wire frame
 * so the frontend deriver bounds the interval; past this deadline
 * without an `observer_review` arrival, the deriver yields
 * `reviewing-stalled` rather than silently reverting to `sleeping`.
 *
 * Lives in council-types.ts so both the orchestrator (emit site) and
 * the bridge's hydration path (deriveGroupCreatedForBrowser) read from
 * the same constant.
 *
 * Council Review 2026-05-13 Friedman #18: bumped 90s → 300s (5 min).
 * Opus reviewing a rich manifest (30+ files) routinely takes 2-3
 * minutes; the 90s bound false-tripped on every legitimate long
 * review. The bound is a UX cue (panel pill flips to "stalled"), not
 * a correctness gate — a real stuck observer surfaces a bit later,
 * which is acceptable vs the false-alarm cost. Tune via incident-
 * driven measurement.
 */
export const OBSERVER_WAKE_TIMEOUT_MS = 300_000;

// `MAX_PHASE_LEN` is documented via the PHASE_PATTERN regex below
// (length-bounded to 64 by the trailing `{0,63}` quantifier); keeping
// the literal here for readers' reference would trip the deadcode guard.
const MAX_CLAIM_LEN = 4_000;
const MAX_PATH_LEN = 1_024;

/** Distinct caps for the two different list axes — context budget (input) vs output shape. */
export const MAX_ARTIFACT_PATHS = 50;
export const MAX_FINDINGS_PER_REVIEW = 50;

const PHASE_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9_.\-]{0,63}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
/** Workspace-relative path segments that hold secrets or VCS state — observer must never be directed to read these. */
const DENIED_LEADING_DOT_SEGMENTS = new Set([".git", ".env", ".ssh", ".companion", ".aws", ".npmrc", ".docker"]);

/** Severity tiers for an observer finding. Bipolar (STOP|NOTE) caused alert fatigue
 * and self-censorship in early experiments — four tiers + an optional confidence
 * field give the observer expressive room without burdening the orchestrator. */
export type CouncilFindingSeverity = "STOP" | "WARN" | "NOTE" | "INFO";

export type CouncilFindingConfidence = "high" | "medium" | "low";

export interface CheckpointPayload {
  schema_version: typeof COUNCIL_SCHEMA_VERSION;
  /** Stable id for this checkpoint emission — used by observer for dedup. */
  checkpoint_id: string;
  /** Carmack-Council phase name, e.g. "council-plan", "council-implement". */
  phase: string;
  /** Monotonic position of this checkpoint within the group. */
  sequence: number;
  /** Group this checkpoint belongs to. */
  session_group_id: string;
  /** Wallclock ISO 8601 (T-separated) timestamp when the orchestrator finished the phase. */
  emitted_at: string;
  /** Paths the observer should read for this checkpoint (relative to workspace). */
  artifact_paths: string[];
}

export interface ObserverReviewFinding {
  severity: CouncilFindingSeverity;
  /** Short claim — the verdict in one or more sentences. Spaces permitted. */
  claim: string;
  /** Workspace-relative path the finding is grounded in. */
  evidence_path: string;
  /** Optional `[start, end]` 1-indexed line range in `evidence_path`. */
  evidence_lines?: [number, number];
  /** Observer's self-reported confidence in this finding. */
  confidence?: CouncilFindingConfidence;
}

/**
 * Outbound wake payload — the JSON object server-side code stuffs inside
 * the fenced block of the `user`-message body sent to the observer's CLI
 * subprocess on each checkpoint arrival.
 *
 * Key ordering is load-bearing: `observer_wake_payload_version` first so
 * the observer's autoregressive parse sees the schema discriminator
 * before any content; then the four echo fields (`session_group_id`,
 * `checkpoint_id`, `phase`, `checkpoint_seq`) so the observer's review
 * can copy-paste them rather than synthesise (Willison Principle 8 —
 * context propagation; AP-3 — writer and reader colocate). Content
 * arrays (`delta`/`carried`/`dropped`) follow last.
 *
 * Type lives here even though no reader-side parser consumes it — the
 * observer's "reader" is its model context, not a structured parser.
 * Co-locating the type with the on-disk schemas keeps wake-frame edits
 * inside the same AP-3 single-source-of-truth file.
 */
export interface ObserverWakePayload {
  observer_wake_payload_version: typeof OBSERVER_WAKE_PAYLOAD_VERSION;
  session_group_id: string;
  checkpoint_id: string;
  phase: string;
  checkpoint_seq: number;
  /** Paths newly added in this checkpoint vs the previous one — the
   *  primary review surface. */
  delta: string[];
  /** Paths carried over from the previous checkpoint. Observer MAY
   *  re-read for cross-cut consistency checks. */
  carried: string[];
  /** Paths dropped from scope this cycle. Observer MUST NOT re-read these. */
  dropped: string[];
}

export interface ObserverReviewPayload {
  schema_version: typeof COUNCIL_SCHEMA_VERSION;
  /** Mirrors the checkpoint this review answers — observer must echo it. */
  checkpoint_id: string;
  phase: string;
  session_group_id: string;
  /** Wallclock ISO 8601 (T-separated) timestamp when the observer finished the review. */
  reviewed_at: string;
  /** Provider that produced the review. Token form, no spaces (e.g. "claude", "codex"). */
  observer_provider: string;
  /** Model id (e.g. "claude-opus-4-7"). Required for forensic re-run. */
  observer_model: string;
  /** CLI binary version that produced the review. Free-form, used as audit field only. */
  observer_cli_version: string;
  findings: ObserverReviewFinding[];
  /**
   * Task 10: observer-echoed copy of `observer_wake_payload_version`
   * from the wake message. Optional — back-compat with v1 reviews that
   * predate the echo contract. The reader (handleCouncilReview) checks
   * this against the version it dispatched; a present-but-mismatched
   * value downgrades all findings to NOTE severity, defending against
   * silent schema drift between a server that ships a new wake shape
   * and a stale prompt that still parses against the old one.
   */
  observer_wake_payload_version_echo?: number;
}

// ── Validators ───────────────────────────────────────────────────────────────

/**
 * Reason tags emitted by the council-payload parsers when they reject a
 * raw string. The drop reporter is the protocol-frame_dropped observability
 * signal (Task 13) — upstream drift in the orchestrator's writer OR the
 * observer's writer becomes visible from the first frame rather than
 * after a silent state divergence.
 *
 * Coarse enough that a new validator can be added without enlarging the
 * union; the optional `field` argument carries the specific identifier
 * for `invalid-field` drops.
 */
export type CouncilParserDropReason =
  | "oversize"
  | "json-parse-error"
  | "schema-mismatch"
  | "invalid-field";

/**
 * Drop reporter callback. Parsers call this just before returning `null`.
 * Production callers wire it to a structured `log.warn("protocol.frame_dropped", ...)`
 * emit; tests inject a spy to assert the rejection took the expected branch.
 * Optional everywhere — back-compat with existing callers.
 */
export type CouncilParserDropReporter = (reason: CouncilParserDropReason, field?: string) => void;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Token-shaped string: non-empty, bounded, no whitespace, no NUL byte.
 * Use for IDs, providers, methods — anywhere a single opaque identifier lives.
 */
export function isBoundedToken(v: unknown, max: number): v is string {
  if (typeof v !== "string") return false;
  if (v.length === 0 || v.length > max) return false;
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c <= 0x20 || c === 0x7f) return false; // ASCII control or space
  }
  return true;
}

/**
 * Text-shaped string: non-empty, bounded, allows spaces. Rejects control
 * characters (incl. NUL, tab if undesired… but tabs allowed for code excerpts).
 * Use for human-readable claims, descriptions, error messages.
 */
export function isBoundedText(v: unknown, max: number): v is string {
  if (typeof v !== "string") return false;
  if (v.length === 0 || v.length > max) return false;
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c === 0x00) return false; // NUL byte
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) return false; // other controls
  }
  return true;
}

/**
 * ISO 8601 timestamp validator: must parse as a valid Date AND match the
 * T-separated shape we emit. Space-separated RFC 3339 form is intentionally
 * NOT accepted — the validator is the contract, and producers must agree.
 */
export function isIsoTimestamp(v: unknown): v is string {
  if (typeof v !== "string" || v.length === 0 || v.length > 64) return false;
  if (!ISO_TIMESTAMP_PATTERN.test(v)) return false;
  return !Number.isNaN(Date.parse(v));
}

function isValidPhase(v: unknown): v is string {
  return typeof v === "string" && PHASE_PATTERN.test(v);
}

function isRelativeWorkspacePath(v: unknown): v is string {
  if (typeof v !== "string" || v.length === 0 || v.length > MAX_PATH_LEN) return false;
  if (v.includes("\0")) return false;
  if (v.startsWith("/")) return false;
  const segments = v.split(/[\\/]/);
  for (const seg of segments) {
    if (seg === "..") return false;
    // Reject path traversal into known-sensitive dotted directories at any depth.
    if (DENIED_LEADING_DOT_SEGMENTS.has(seg)) return false;
  }
  return true;
}

function parseLineRange(v: unknown): { ok: true; value: [number, number] } | { ok: true; value: undefined } | { ok: false } {
  if (v === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(v) || v.length !== 2) return { ok: false };
  const [a, b] = v;
  if (typeof a !== "number" || typeof b !== "number") return { ok: false };
  if (!Number.isInteger(a) || !Number.isInteger(b)) return { ok: false };
  if (a < 1 || b < a) return { ok: false };
  return { ok: true, value: [a, b] };
}

/** Byte-count for the size cap. JS string length is UTF-16 code units —
 *  using it as a byte budget under-counts multibyte content by up to 3×. */
function utf8ByteLength(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/**
 * Parse and validate a {@link CheckpointPayload} from a raw string.
 *
 * Returns `null` if the input is oversized, not JSON, or any field fails
 * validation. Never throws — callers (the FS watcher) treat null as "drop
 * this event silently and log".
 *
 * The optional `onDrop` reporter (Task 13) fires once per rejection with
 * the categorical reason and (where applicable) the offending field name.
 * Production callers wire it to a structured `log.warn` emit so upstream
 * writer drift is observable from the first malformed frame instead of
 * silently after state divergence.
 */
export function parseCheckpointPayload(
  raw: string,
  onDrop?: CouncilParserDropReporter,
): CheckpointPayload | null {
  if (utf8ByteLength(raw) > COUNCIL_ARTIFACT_MAX_BYTES) { onDrop?.("oversize"); return null; }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    onDrop?.("json-parse-error");
    return null;
  }
  if (!isObject(parsed)) { onDrop?.("schema-mismatch", "not-object"); return null; }
  if (parsed.schema_version !== COUNCIL_SCHEMA_VERSION) { onDrop?.("schema-mismatch", "schema_version"); return null; }
  if (!isBoundedToken(parsed.checkpoint_id, 128)) { onDrop?.("invalid-field", "checkpoint_id"); return null; }
  if (!isValidPhase(parsed.phase)) { onDrop?.("invalid-field", "phase"); return null; }
  if (typeof parsed.sequence !== "number" || !Number.isInteger(parsed.sequence) || parsed.sequence < 0) {
    onDrop?.("invalid-field", "sequence");
    return null;
  }
  if (!isBoundedToken(parsed.session_group_id, 128)) { onDrop?.("invalid-field", "session_group_id"); return null; }
  if (!isIsoTimestamp(parsed.emitted_at)) { onDrop?.("invalid-field", "emitted_at"); return null; }
  if (!Array.isArray(parsed.artifact_paths)) { onDrop?.("invalid-field", "artifact_paths"); return null; }
  if (parsed.artifact_paths.length > MAX_ARTIFACT_PATHS) { onDrop?.("invalid-field", "artifact_paths"); return null; }
  for (const p of parsed.artifact_paths) {
    if (!isRelativeWorkspacePath(p)) { onDrop?.("invalid-field", "artifact_paths"); return null; }
  }
  return {
    schema_version: COUNCIL_SCHEMA_VERSION,
    checkpoint_id: parsed.checkpoint_id,
    phase: parsed.phase,
    sequence: parsed.sequence,
    session_group_id: parsed.session_group_id,
    emitted_at: parsed.emitted_at,
    artifact_paths: parsed.artifact_paths as string[],
  };
}

const VALID_SEVERITIES: ReadonlySet<CouncilFindingSeverity> = new Set(["STOP", "WARN", "NOTE", "INFO"]);
const VALID_CONFIDENCES: ReadonlySet<CouncilFindingConfidence> = new Set(["high", "medium", "low"]);

/**
 * Parse and validate an {@link ObserverReviewPayload}. Same contract as
 * {@link parseCheckpointPayload} — returns `null` on any validation failure.
 * Optional `onDrop` reporter fires once with the rejection reason (Task 13).
 */
export function parseObserverReviewPayload(
  raw: string,
  onDrop?: CouncilParserDropReporter,
): ObserverReviewPayload | null {
  if (utf8ByteLength(raw) > COUNCIL_ARTIFACT_MAX_BYTES) { onDrop?.("oversize"); return null; }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    onDrop?.("json-parse-error");
    return null;
  }
  if (!isObject(parsed)) { onDrop?.("schema-mismatch", "not-object"); return null; }
  if (parsed.schema_version !== COUNCIL_SCHEMA_VERSION) { onDrop?.("schema-mismatch", "schema_version"); return null; }
  if (!isBoundedToken(parsed.checkpoint_id, 128)) { onDrop?.("invalid-field", "checkpoint_id"); return null; }
  if (!isValidPhase(parsed.phase)) { onDrop?.("invalid-field", "phase"); return null; }
  if (!isBoundedToken(parsed.session_group_id, 128)) { onDrop?.("invalid-field", "session_group_id"); return null; }
  if (!isIsoTimestamp(parsed.reviewed_at)) { onDrop?.("invalid-field", "reviewed_at"); return null; }
  if (!isBoundedToken(parsed.observer_provider, 32)) { onDrop?.("invalid-field", "observer_provider"); return null; }
  if (!isBoundedToken(parsed.observer_model, 128)) { onDrop?.("invalid-field", "observer_model"); return null; }
  if (!isBoundedToken(parsed.observer_cli_version, 64)) { onDrop?.("invalid-field", "observer_cli_version"); return null; }
  if (!Array.isArray(parsed.findings)) { onDrop?.("invalid-field", "findings"); return null; }
  if (parsed.findings.length > MAX_FINDINGS_PER_REVIEW) { onDrop?.("invalid-field", "findings"); return null; }
  const findings: ObserverReviewFinding[] = [];
  for (const f of parsed.findings) {
    if (!isObject(f)) { onDrop?.("invalid-field", "findings"); return null; }
    if (typeof f.severity !== "string" || !VALID_SEVERITIES.has(f.severity as CouncilFindingSeverity)) {
      onDrop?.("invalid-field", "findings.severity");
      return null;
    }
    // Council Review 2026-05-13 Hunt #22: strip backtick triplets at
    // the validation boundary. `isBoundedText` allows them (claims can
    // include code excerpts conceptually), but the claim is echoed
    // verbatim into the orchestrator's chat surface — fence-triplet
    // content would render as a fake code block in markdown.
    //
    // Council Review 2026-05-13-0150 Hunt #12: reorder — strip BEFORE
    // the length check, because the replacement is +33% per occurrence
    // and could push a borderline claim over MAX_CLAIM_LEN otherwise.
    if (typeof f.claim !== "string") { onDrop?.("invalid-field", "findings.claim"); return null; }
    const claim = f.claim.replace(/```/g, "ʼ`ʼ`ʼ`");
    if (!isBoundedText(claim, MAX_CLAIM_LEN)) { onDrop?.("invalid-field", "findings.claim"); return null; }
    if (!isRelativeWorkspacePath(f.evidence_path)) { onDrop?.("invalid-field", "findings.evidence_path"); return null; }
    const lines = parseLineRange(f.evidence_lines);
    if (!lines.ok) { onDrop?.("invalid-field", "findings.evidence_lines"); return null; }
    if (f.confidence !== undefined && (typeof f.confidence !== "string" || !VALID_CONFIDENCES.has(f.confidence as CouncilFindingConfidence))) {
      onDrop?.("invalid-field", "findings.confidence");
      return null;
    }
    findings.push({
      severity: f.severity as CouncilFindingSeverity,
      claim,
      evidence_path: f.evidence_path,
      ...(lines.value !== undefined ? { evidence_lines: lines.value } : {}),
      ...(f.confidence !== undefined ? { confidence: f.confidence as CouncilFindingConfidence } : {}),
    });
  }
  // Task 10: parse optional observer_wake_payload_version_echo. Reject
  // on present-but-malformed (non-integer or negative); absent is fine
  // for back-compat with v1 reviews.
  let wakeEcho: number | undefined;
  if (parsed.observer_wake_payload_version_echo !== undefined) {
    const v = parsed.observer_wake_payload_version_echo;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
      onDrop?.("invalid-field", "observer_wake_payload_version_echo");
      return null;
    }
    wakeEcho = v;
  }
  return {
    schema_version: COUNCIL_SCHEMA_VERSION,
    checkpoint_id: parsed.checkpoint_id,
    phase: parsed.phase,
    session_group_id: parsed.session_group_id,
    reviewed_at: parsed.reviewed_at,
    observer_provider: parsed.observer_provider,
    observer_model: parsed.observer_model,
    observer_cli_version: parsed.observer_cli_version,
    findings,
    ...(wakeEcho !== undefined ? { observer_wake_payload_version_echo: wakeEcho } : {}),
  };
}
