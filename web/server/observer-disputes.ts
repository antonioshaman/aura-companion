/**
 * Disputed observer claims (meta-diet B2b).
 *
 * Before B2b, dismissing a STOP lived only in the browser (`dismissedStopIds`,
 * in-memory, per tab). The observer never learns a claim was rejected, so it
 * re-raises it at the next checkpoint under a fresh finding id. That is how the
 * already-refuted `bun run --cwd web` claim (diet-A2-103) came back as a STOP
 * at diet-A3-104, and a reload even resurrects the original banner.
 *
 * This module is the host-side memory of those judgements: a per-group,
 * persistent list at `<workspace>/.council/state/<group>-disputes.json`
 * (written only by the server; the observer's write allow-list excludes
 * `.council/state/`). A later STOP that matches a dispute stays a STOP and
 * stays in the findings log, but it is marked `disputed` and never raises the
 * blocker banner again. Like B2's weak evidence, this never changes severity
 * or drops the finding: the recall-side cost of a wrong match is one blocker
 * that shows only in the log.
 *
 * Matching is deterministic and deliberately coarse, because a re-raised claim
 * is re-worded and usually cites a different file (each phase has its own diff):
 *   - `same_claim`: the normalised claim text equals a disputed one (any path);
 *   - `shared_anchor`: both claims quote the same distinctive code span in
 *     backticks, e.g. `bun run --cwd web kb:record`. Short single tokens such
 *     as `kb:record` are not anchors: they are too common to identify a claim.
 */

import { readFileSync } from "node:fs";
import { writeAtomicJson } from "./atomic-write.js";
import { resolveCouncilStatePath } from "./council-state-path.js";
import type { BrowserObserverDisputeMatch, BrowserObserverFinding } from "./session-types.js";

export const OBSERVER_DISPUTES_SCHEMA_VERSION = 1;
/** Oldest disputes are evicted past this count (bounded file, bounded match loop). */
export const MAX_DISPUTES_PER_GROUP = 64;
export const MAX_DISPUTE_CLAIM_LEN = 4_000;
export const MAX_DISPUTE_PATH_LEN = 1_024;
/** A backtick span shorter than this is only an anchor if it contains whitespace. */
const MIN_SINGLE_TOKEN_ANCHOR_LEN = 12;
const MIN_ANCHOR_LEN = 6;
const DISPUTES_SUFFIX = "-disputes.json";

export type DisputeSource = "browser_dismiss";
export type DisputeMatchKind = BrowserObserverDisputeMatch;

export interface DisputeRecord {
  claim: string;
  evidencePath: string;
  /** Finding id that was disputed (forensics only; ids change per checkpoint). */
  findingId?: string;
  source: DisputeSource;
  /** ISO timestamp, server clock. */
  disputedAt: string;
}

export interface DisputeMatch {
  record: DisputeRecord;
  via: DisputeMatchKind;
}

/** Lowercase, Unicode-normalised, whitespace-collapsed, trailing punctuation dropped. */
export function normalizeClaim(claim: string): string {
  return claim
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\s.,;:!?]+$/u, "");
}

/**
 * Distinctive code spans quoted in backticks. A span is an anchor when it
 * contains whitespace (a command / expression) or is at least
 * {@link MIN_SINGLE_TOKEN_ANCHOR_LEN} characters long.
 */
export function claimAnchors(claim: string): Set<string> {
  const out = new Set<string>();
  for (const m of claim.normalize("NFKC").matchAll(/`([^`\n]+)`/g)) {
    const span = (m[1] ?? "").replace(/\s+/g, " ").trim();
    if (span.length < MIN_ANCHOR_LEN) continue;
    if (!span.includes(" ") && span.length < MIN_SINGLE_TOKEN_ANCHOR_LEN) continue;
    out.add(span);
  }
  return out;
}

/** First dispute the claim matches, `same_claim` preferred over `shared_anchor`. */
export function matchDispute(
  records: readonly DisputeRecord[],
  claim: string,
): DisputeMatch | null {
  if (records.length === 0) return null;
  const normalized = normalizeClaim(claim);
  for (const record of records) {
    if (normalizeClaim(record.claim) === normalized) return { record, via: "same_claim" };
  }
  const anchors = claimAnchors(claim);
  if (anchors.size === 0) return null;
  for (const record of records) {
    for (const a of claimAnchors(record.claim)) {
      if (anchors.has(a)) return { record, via: "shared_anchor" };
    }
  }
  return null;
}

export interface AppliedDispute {
  /** Index into the findings array passed in. */
  index: number;
  via: DisputeMatchKind;
  record: DisputeRecord;
}

/**
 * Mark every live STOP (not grounding-downgraded) that matches a dispute.
 * Returns a new array (same order, same length) plus the list of marks so the
 * caller can log them. Non-STOP and downgraded findings are never marked: they
 * cannot raise the banner anyway.
 */
export function applyDisputes(
  findings: readonly BrowserObserverFinding[],
  records: readonly DisputeRecord[],
): { findings: BrowserObserverFinding[]; applied: AppliedDispute[] } {
  const applied: AppliedDispute[] = [];
  const out = findings.map((f, index) => {
    if (records.length === 0 || f.severity !== "STOP" || f.wasDowngraded === true) return f;
    const m = matchDispute(records, f.claim);
    if (!m) return f;
    applied.push({ index, via: m.via, record: m.record });
    return { ...f, disputed: m.via };
  });
  return { findings: out, applied };
}

function isBoundedString(v: unknown, max: number): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= max;
}

function parseRecord(v: unknown): DisputeRecord | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (!isBoundedString(o.claim, MAX_DISPUTE_CLAIM_LEN)) return null;
  if (!isBoundedString(o.evidencePath, MAX_DISPUTE_PATH_LEN)) return null;
  if (o.source !== "browser_dismiss") return null;
  if (typeof o.disputedAt !== "string") return null;
  if (o.findingId !== undefined && !isBoundedString(o.findingId, 256)) return null;
  return {
    claim: o.claim,
    evidencePath: o.evidencePath,
    ...(typeof o.findingId === "string" ? { findingId: o.findingId } : {}),
    source: o.source,
    disputedAt: o.disputedAt,
  };
}

export type DisputesReadResult =
  | { ok: true; records: DisputeRecord[] }
  | { ok: false; reason: "path-error" | "unreadable" | "invalid-json" | "invalid-shape" };

/**
 * Read a group's disputes. A missing file is an empty list. Any other failure
 * is reported so the caller can log it; callers then treat the list as empty,
 * which fails toward showing the banner (the pre-B2b behaviour), never toward
 * hiding a blocker.
 */
export function readDisputes(workspaceRoot: string, groupId: string): DisputesReadResult {
  const p = resolveCouncilStatePath(workspaceRoot, groupId, DISPUTES_SUFFIX);
  if (!p.ok) return { ok: false, reason: "path-error" };
  let raw: string;
  try {
    raw = readFileSync(p.value.absolutePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, records: [] };
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
  if (obj.schemaVersion !== OBSERVER_DISPUTES_SCHEMA_VERSION || !Array.isArray(obj.disputes)) {
    return { ok: false, reason: "invalid-shape" };
  }
  const records: DisputeRecord[] = [];
  for (const item of obj.disputes) {
    const r = parseRecord(item);
    // One bad row must not discard every other judgement in the file.
    if (r) records.push(r);
  }
  return { ok: true, records };
}

export interface AddDisputeInput {
  claim: string;
  evidencePath: string;
  findingId?: string;
  source: DisputeSource;
}

export type AddDisputeResult =
  | { ok: true; added: boolean; count: number }
  | { ok: false; reason: "invalid-input" | "path-error" | "write-failed"; detail?: string };

/**
 * Append a dispute (idempotent on normalised claim + evidence path) and
 * persist the list atomically. An unreadable existing file is replaced rather
 * than blocking new disputes; the caller logs the read failure.
 */
export function addDispute(
  workspaceRoot: string,
  groupId: string,
  input: AddDisputeInput,
  now: () => Date = () => new Date(),
): AddDisputeResult {
  if (!isBoundedString(input.claim, MAX_DISPUTE_CLAIM_LEN) || !isBoundedString(input.evidencePath, MAX_DISPUTE_PATH_LEN)) {
    return { ok: false, reason: "invalid-input" };
  }
  if (input.findingId !== undefined && !isBoundedString(input.findingId, 256)) {
    return { ok: false, reason: "invalid-input" };
  }
  const p = resolveCouncilStatePath(workspaceRoot, groupId, DISPUTES_SUFFIX);
  if (!p.ok) return { ok: false, reason: "path-error" };
  const existing = readDisputes(workspaceRoot, groupId);
  const records = existing.ok ? existing.records : [];
  const key = normalizeClaim(input.claim);
  if (records.some((r) => r.evidencePath === input.evidencePath && normalizeClaim(r.claim) === key)) {
    return { ok: true, added: false, count: records.length };
  }
  records.push({
    claim: input.claim,
    evidencePath: input.evidencePath,
    ...(input.findingId !== undefined ? { findingId: input.findingId } : {}),
    source: input.source,
    disputedAt: now().toISOString(),
  });
  const kept = records.slice(-MAX_DISPUTES_PER_GROUP);
  try {
    writeAtomicJson(
      p.value.absolutePath,
      { schemaVersion: OBSERVER_DISPUTES_SCHEMA_VERSION, sessionGroupId: groupId, disputes: kept },
      // 64 × (4 KB claim + 1 KB path), doubled for JSON escaping, fits under 1 MB.
      { maxBytes: 1024 * 1024 },
    );
  } catch (err) {
    return { ok: false, reason: "write-failed", detail: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true, added: true, count: kept.length };
}
