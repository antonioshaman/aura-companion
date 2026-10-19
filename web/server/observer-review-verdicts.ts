/**
 * Frozen grounding verdicts of observer findings (aura-meta-diet P4/FIX-AP-2).
 *
 * The grounding gate (B2) judges a finding against the checkpoint it was
 * written for: that checkpoint's changed files and the file lines at that
 * moment. Re-running it later — against the LATEST checkpoint and the
 * current lines — can turn a STOP from checkpoint A into NOTE / weak evidence
 * only because A's file is not in checkpoint B or its lines moved. After a
 * server restart that silently released the auto-proceed STOP hold.
 *
 * So the host records the verdict it reached at review time, per finding id,
 * at `<workspace>/.council/state/<group>-review-verdicts.json`. The REST
 * bootstrap (blocker banner) and the auto-proceed hold restore both read the
 * frozen verdict instead of re-grounding. Disputes are not frozen: they are
 * re-applied from `observer-disputes.ts`, and they only ever release.
 *
 * Written only by the server; the observer's write allow-list excludes
 * `.council/state/`.
 */

import { readFileSync } from "node:fs";
import { writeAtomicJson } from "./atomic-write.js";
import { resolveCouncilStatePath } from "./council-state-path.js";
import type { BrowserObserverFinding } from "./session-types.js";

export const REVIEW_VERDICTS_SCHEMA_VERSION = 1;
/** Oldest verdicts are evicted past this count (bounded file). An evicted
 *  finding falls back to its raw severity in the hold restore (fail-closed). */
export const MAX_REVIEW_VERDICTS_PER_GROUP = 2048;
const MAX_ID_LEN = 256;
const VERDICTS_SUFFIX = "-review-verdicts.json";
const SEVERITIES = new Set(["STOP", "WARN", "NOTE", "INFO"]);

/** The grounding result of one finding, as the host saw it at review time. */
export interface FrozenVerdict {
  checkpointId: string;
  severity: BrowserObserverFinding["severity"];
  weakEvidence?: NonNullable<BrowserObserverFinding["weakEvidence"]>;
  wasDowngraded?: true;
  downgradeReason?: NonNullable<BrowserObserverFinding["downgradeReason"]>;
}

export type ReviewVerdictsReadResult =
  | { ok: true; verdicts: Map<string, FrozenVerdict> }
  | { ok: false; reason: "path-error" | "unreadable" | "invalid-json" | "invalid-shape" };

function parseVerdict(v: unknown): FrozenVerdict | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.checkpointId !== "string" || typeof o.severity !== "string" || !SEVERITIES.has(o.severity)) return null;
  const out: FrozenVerdict = { checkpointId: o.checkpointId, severity: o.severity as FrozenVerdict["severity"] };
  // Host-written reason codes; the browser renders unknown ones as text.
  if (typeof o.weakEvidence === "string") out.weakEvidence = o.weakEvidence as FrozenVerdict["weakEvidence"];
  if (o.wasDowngraded === true) out.wasDowngraded = true;
  if (typeof o.downgradeReason === "string") out.downgradeReason = o.downgradeReason as FrozenVerdict["downgradeReason"];
  return out;
}

/**
 * Read a group's frozen verdicts. A missing file is an empty map (no review
 * recorded yet). Any other failure is reported so callers can fail closed.
 */
export function readReviewVerdicts(workspaceRoot: string, groupId: string): ReviewVerdictsReadResult {
  const p = resolveCouncilStatePath(workspaceRoot, groupId, VERDICTS_SUFFIX);
  if (!p.ok) return { ok: false, reason: "path-error" };
  let raw: string;
  try {
    raw = readFileSync(p.value.absolutePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, verdicts: new Map() };
    return { ok: false, reason: "unreadable" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "invalid-json" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "invalid-shape" };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.schemaVersion !== REVIEW_VERDICTS_SCHEMA_VERSION || !Array.isArray(obj.verdicts)) {
    return { ok: false, reason: "invalid-shape" };
  }
  const verdicts = new Map<string, FrozenVerdict>();
  for (const row of obj.verdicts) {
    if (!Array.isArray(row) || row.length !== 2) continue;
    const [id, v] = row as [unknown, unknown];
    if (typeof id !== "string" || id.length === 0 || id.length > MAX_ID_LEN) continue;
    const verdict = parseVerdict(v);
    // One bad row only loses its own verdict; that finding then fails closed.
    if (verdict) verdicts.set(id, verdict);
  }
  return { ok: true, verdicts };
}

/** The grounding fields of a live finding, frozen. */
export function freezeVerdict(checkpointId: string, finding: BrowserObserverFinding): FrozenVerdict {
  return {
    checkpointId,
    severity: finding.severity,
    ...(finding.weakEvidence !== undefined ? { weakEvidence: finding.weakEvidence } : {}),
    ...(finding.wasDowngraded ? { wasDowngraded: true as const } : {}),
    ...(finding.downgradeReason !== undefined ? { downgradeReason: finding.downgradeReason } : {}),
  };
}

export type RecordReviewVerdictsResult =
  | { ok: true; recorded: number }
  | { ok: false; reason: "path-error" | "unreadable-existing" | "write-failed"; detail?: string };

/**
 * Record the verdicts of one processed review and persist atomically. A
 * re-review of the same finding id overwrites its verdict (latest review
 * wins, as on the live WS path). An unreadable existing file is NOT
 * overwritten: that would drop every earlier verdict.
 */
export function recordReviewVerdicts(
  workspaceRoot: string,
  groupId: string,
  checkpointId: string,
  findings: readonly BrowserObserverFinding[],
): RecordReviewVerdictsResult {
  const p = resolveCouncilStatePath(workspaceRoot, groupId, VERDICTS_SUFFIX);
  if (!p.ok) return { ok: false, reason: "path-error" };
  const existing = readReviewVerdicts(workspaceRoot, groupId);
  if (!existing.ok) return { ok: false, reason: "unreadable-existing", detail: existing.reason };
  const verdicts = existing.verdicts;
  let recorded = 0;
  for (const f of findings) {
    if (typeof f.id !== "string" || f.id.length === 0 || f.id.length > MAX_ID_LEN) continue;
    verdicts.delete(f.id); // re-insert at the end: eviction is oldest-first
    verdicts.set(f.id, freezeVerdict(checkpointId, f));
    recorded++;
  }
  const rows = [...verdicts.entries()].slice(-MAX_REVIEW_VERDICTS_PER_GROUP);
  try {
    writeAtomicJson(
      p.value.absolutePath,
      { schemaVersion: REVIEW_VERDICTS_SCHEMA_VERSION, sessionGroupId: groupId, verdicts: rows },
      { maxBytes: 2 * 1024 * 1024 },
    );
  } catch (err) {
    return { ok: false, reason: "write-failed", detail: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true, recorded };
}

/**
 * Replace a re-grounded finding's grounding fields with the frozen ones.
 * `disputed` and everything else are kept.
 */
export function applyFrozenVerdict(finding: BrowserObserverFinding, verdict: FrozenVerdict): BrowserObserverFinding {
  const { weakEvidence: _w, wasDowngraded: _d, downgradeReason: _r, ...rest } = finding;
  return {
    ...rest,
    severity: verdict.severity,
    ...(verdict.weakEvidence !== undefined ? { weakEvidence: verdict.weakEvidence } : {}),
    ...(verdict.wasDowngraded ? { wasDowngraded: true } : {}),
    ...(verdict.downgradeReason !== undefined ? { downgradeReason: verdict.downgradeReason } : {}),
  };
}
