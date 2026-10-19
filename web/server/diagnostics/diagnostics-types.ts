/**
 * Wire + disk shapes for the Diagnostics page and the KB / memory analyzer
 * (spec `specs/diagnostics-page-and-kb-analyzer-v1.md`, plan
 * `PLAN-aura-diagnostics-kb-analyzer.md`).
 *
 * Writer and reader live in one file (AP-3): the server builds these objects,
 * and `web/src/api.ts` imports the same types (type-only), so the browser
 * cannot drift from the server's shape.
 */

// ─── Per-card envelope ───────────────────────────────────────────────────────

/**
 * Every Diagnostics card is either available (with data and when it was
 * fetched) or explicitly unavailable (closed reason + since when). A card is
 * never just "null" — that silent disappearance is what the page exists to
 * end (memory `feedback_silent_null_render_hides_upstream_failure`).
 */
export type CardSource<T> =
  | { status: "available"; data: T; fetchedAt: number }
  | { status: "unavailable"; reason: string; since: number | null };

// ─── Backend card ────────────────────────────────────────────────────────────

export interface RuntimeSnapshotView {
  pid: number;
  uptimeMs: number;
  version: string;
  bunVersion: string;
  /** The same keys the 5-minute `[diagnostics] Runtime snapshot` log line carries. */
  snapshot: Record<string, string | number>;
  /** When the 5-minute tick last logged a snapshot (null before the first tick). */
  lastLoggedAt: number | null;
}

// ─── Pairs card ──────────────────────────────────────────────────────────────

export interface PairHalfView {
  sessionId: string;
  role: "orchestrator" | "observer";
  backendType: string;
  state: string | null;
  pid: number | null;
  exitCode: number | null;
  /** Epoch ms of the last inbound CLI frame; null = no frame recorded yet / not tracked for this backend. */
  lastInboundFrameAt: number | null;
}

export interface PairView {
  sessionGroupId: string;
  /** Group status straight from the state machine (AP-2). */
  status: string;
  /** Present only when status is "degraded". */
  deadRole?: string;
  degradedReason?: string;
  pairing: string;
  lastCheckpointAt: number | null;
  lastWakeAt: number | null;
  halves: PairHalfView[];
}

// ─── Drift card ──────────────────────────────────────────────────────────────

export interface DriftEventView {
  ts: number;
  /** Verbatim log event name, e.g. `silent_stdio_drift.withheld_open_tool_call`. */
  event: string;
  sessionId: string;
  reason?: string;
  fields: Record<string, string | number | boolean>;
}

export interface DriftFeedView {
  events: DriftEventView[];
  /** The ring is in-memory: it starts at server start and drops the oldest when full. */
  windowStart: number;
  wrapped: boolean;
  capacity: number;
}

// ─── Context advisory card ───────────────────────────────────────────────────

export interface ContextAdvisoryView {
  sessionId: string;
  backendType: string;
  /** The persisted advisory record, decoded on the client by `utils/context-advisory.ts`. */
  advisory: unknown;
}

// ─── Usage upstream card ─────────────────────────────────────────────────────

export type UpstreamFailureKind =
  | "kv-quota"
  | "http"
  | "timeout"
  | "network"
  | "parse"
  | "oauth-expired"
  | "no-credentials";

export interface UpstreamStatus {
  ok: boolean;
  lastOkAt: number | null;
  failure: { kind: UpstreamFailureKind; httpStatus?: number; since: number } | null;
}

export interface UsageUpstreamView {
  globalStats: UpstreamStatus;
  usageLimits: UpstreamStatus;
}

// ─── KB analysis ─────────────────────────────────────────────────────────────

export const KB_SIGNALS = [
  "never-used",
  "dead-reference",
  "duplicate",
  "contradiction",
  "outdated-reports",
  "stale-promoted",
  "bitter-pill",
] as const;
export type KbSignal = (typeof KB_SIGNALS)[number];

/** Signals that are heuristics by the spec's own admission: shown as "verify", no suggestion. */
export const HEURISTIC_SIGNALS: readonly KbSignal[] = ["contradiction", "bitter-pill"];

export type SuggestedDecision = "archive" | "merge" | null;

export interface SignalHit {
  signal: KbSignal;
  /** The criterion in words with this entry's numbers filled in. */
  criterion: string;
  /** For duplicate / contradiction: the other entry. */
  partnerId?: string;
  similarity?: number;
}

export interface KbEntrySummary {
  id: string;
  file: string;
  type: string;
  fact: string;
  recommendation: string;
  confidence: string;
  tags: string[];
  affectedFiles: { path: string; exists: boolean }[];
  provenance: { source: string; reference: string; date: string }[];
  createdAt: string | null;
  usage: number;
  helpfulCount: number;
  outdatedReports: number;
  promoted: boolean;
}

export interface KbFinding {
  entryId: string;
  signals: SignalHit[];
  suggested: SuggestedDecision;
  entry: KbEntrySummary;
}

export const MEMORY_SIGNALS = ["duplicate", "dead-reference", "age"] as const;
export type MemorySignal = (typeof MEMORY_SIGNALS)[number];

export interface MemoryFinding {
  /** `mem:<file name>` — the id decisions refer to. */
  findingId: string;
  /** File name relative to the memory dir (never an absolute path). */
  file: string;
  name: string;
  description: string;
  signals: { signal: MemorySignal; criterion: string; partnerFile?: string }[];
}

export interface MemoryReport {
  fileCount: number;
  findings: MemoryFinding[];
  truncated: boolean;
}

export const KB_REPORT_SCHEMA_VERSION = 1;

export type AnalysisTrigger = "entries" | "sessions" | "age" | "manual";

export interface KbAnalysisReport {
  schemaVersion: typeof KB_REPORT_SCHEMA_VERSION;
  runId: string;
  generatedAt: number;
  trigger: AnalysisTrigger;
  kbEntryCount: number;
  kbParseErrors: number;
  findings: KbFinding[];
  /** Merge tasks recorded by the owner (v1 never merges text itself). */
  mergeTasks: { entryId: string; mergeInto: string; decidedAt: number }[];
  memory: MemoryReport | null;
}

// ─── Decisions ledger ────────────────────────────────────────────────────────

export const DECISION_LINE_VERSION = 1;
export const KB_DECISIONS = ["keep", "archive", "merge"] as const;
export type KbDecision = (typeof KB_DECISIONS)[number];
export type Decision = KbDecision | "seen";

export interface DecisionLine {
  v: typeof DECISION_LINE_VERSION;
  ts: number;
  runId: string;
  entryId: string;
  decision: Decision;
  mergeInto?: string;
  by: "owner";
}

// ─── Accumulation + status ───────────────────────────────────────────────────

export interface AccumulationProgress {
  newEntries: number;
  newEntriesThreshold: number;
  sessions: number;
  sessionsThreshold: number;
  ageDays: number;
  maxAgeDays: number;
  /** Whole days until the age safety net fires (0 when due). */
  dueInDays: number;
  due: boolean;
  reason: Exclude<AnalysisTrigger, "manual"> | null;
}

export interface KbHealthView {
  total: number;
  used: number;
  helpful: number;
  promoted: number;
  stale: number;
  neverSurfaced: number;
  idle: number;
  parseErrors: number;
}

export interface KbAnalysisStatus {
  inFlight: { runId: string; startedAt: number; trigger: AnalysisTrigger; includeMemory: boolean } | null;
  lastRun: { runId: string; at: number; trigger: AnalysisTrigger } | null;
  lastFailure: { at: number; reason: string } | null;
  /** A previous run died with the server; automatic runs wait for one manual success. */
  autoTriggerSuppressed: boolean;
  progress: AccumulationProgress | null;
  health: KbHealthView | null;
  memoryReportEnabled: boolean;
  report: CardSource<KbAnalysisReport> | null;
  /** Folded from decisions.jsonl: what the owner decided per id in the current report. */
  decisions: Record<string, { decision: Decision; ts: number; mergeInto?: string }>;
}

export interface DiagnosticsOverview {
  generatedAt: number;
  backend: CardSource<RuntimeSnapshotView>;
  pairs: CardSource<PairView[]>;
  drift: CardSource<DriftFeedView>;
  contextAdvisory: CardSource<ContextAdvisoryView[]>;
  usage: CardSource<UsageUpstreamView>;
}
