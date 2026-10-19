/**
 * Owner decisions on KB-analysis findings (spec §3.4/§3.5; plan Task 12;
 * ritchie B4/B7, fowler 4/14, hunt 3/5, dahl).
 *
 * Validation is pure and covers the WHOLE batch before anything is applied —
 * a 400 never leaves half the batch archived. The current report is the
 * capability: only ids it flagged can be decided, on the runId it was built
 * for (a stale tab gets 409).
 *
 * Application: the decision lines are appended first (durable intent), then
 * `archive` decisions go through `archiveEntries` — the single function that
 * rewrites a KB store. keep / merge / seen write nothing but the ledger;
 * `reviewedAt` / `mergePending` are folded from it, never stamped into the KB.
 * Memory findings accept only "seen" and never touch the memory dir.
 */

import { join } from "node:path";
import { log } from "../logger.js";
import { ARCHIVE_DIR, archiveEntries, archivedIds, entriesOf, KbStoreConflictError, loadKb, type ArchiveOutcome } from "../knowledge/kb-store.js";
import { DECISION_LINE_VERSION, KB_DECISIONS, type Decision, type DecisionLine, type KbAnalysisReport } from "./diagnostics-types.js";
import type { FoldedDecision } from "./kb-analyzer.js";

export const MAX_DECISIONS_PER_BATCH = 500;

export interface ValidDecision {
  entryId: string;
  decision: Decision;
  mergeInto?: string;
  target: "kb" | "memory";
}

export type DecisionValidation =
  | { ok: true; runId: string; items: ValidDecision[] }
  | { ok: false; status: 400 | 409; error: string };

export function validateDecisions(body: unknown, report: KbAnalysisReport | null): DecisionValidation {
  if (!report) return { ok: false, status: 409, error: "no analysis report yet" };
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, status: 400, error: "body must be { runId, decisions: [...] }" };
  const b = body as { runId?: unknown; decisions?: unknown };
  if (typeof b.runId !== "string") return { ok: false, status: 400, error: "runId is required" };
  if (b.runId !== report.runId) return { ok: false, status: 409, error: "the report changed — reload and decide again" };
  if (!Array.isArray(b.decisions) || b.decisions.length === 0) return { ok: false, status: 400, error: "decisions must be a non-empty array" };
  if (b.decisions.length > MAX_DECISIONS_PER_BATCH) return { ok: false, status: 400, error: "too many decisions in one request" };

  const kbFindings = new Map(report.findings.map((f) => [f.entryId, f]));
  const memoryIds = new Set(report.memory?.findings.map((f) => f.findingId) ?? []);
  const seen = new Set<string>();
  const items: ValidDecision[] = [];
  for (const raw of b.decisions) {
    if (typeof raw !== "object" || raw === null) return { ok: false, status: 400, error: "each decision must be an object" };
    const d = raw as { entryId?: unknown; decision?: unknown; mergeInto?: unknown };
    if (typeof d.entryId !== "string") return { ok: false, status: 400, error: "entryId must be a string" };
    if (seen.has(d.entryId)) return { ok: false, status: 400, error: "duplicate entryId in one request" };
    seen.add(d.entryId);

    if (memoryIds.has(d.entryId)) {
      if (d.decision !== "seen" || d.mergeInto !== undefined) {
        return { ok: false, status: 400, error: "memory findings accept only \"seen\"" };
      }
      items.push({ entryId: d.entryId, decision: "seen", target: "memory" });
      continue;
    }
    const finding = kbFindings.get(d.entryId);
    if (!finding) return { ok: false, status: 400, error: "unknown entryId for this report" };
    if (!(KB_DECISIONS as readonly unknown[]).includes(d.decision)) {
      return { ok: false, status: 400, error: "decision must be keep, archive or merge" };
    }
    if (d.decision === "merge") {
      const partners = new Set(finding.signals.filter((s) => s.signal === "duplicate").map((s) => s.partnerId));
      if (typeof d.mergeInto !== "string" || d.mergeInto === d.entryId || !partners.has(d.mergeInto)) {
        return { ok: false, status: 400, error: "mergeInto must name this finding's duplicate partner" };
      }
      items.push({ entryId: d.entryId, decision: "merge", mergeInto: d.mergeInto, target: "kb" });
      continue;
    }
    if (d.mergeInto !== undefined) return { ok: false, status: 400, error: "mergeInto is only valid with merge" };
    items.push({ entryId: d.entryId, decision: d.decision as Decision, target: "kb" });
  }
  return { ok: true, runId: report.runId, items };
}

export interface AppliedDecision {
  entryId: string;
  decision: Decision;
  /** archive only: what happened on disk. */
  archive?: ArchiveOutcome["status"];
  /** archive only: where the line went (repo-relative). */
  archivedTo?: string;
}

export type ApplyResult =
  | { ok: true; applied: AppliedDecision[] }
  /** Intent is recorded, the archive move did not complete; boot reconcile or a retry finishes it. */
  | { ok: false; recorded: true; error: string; applied: AppliedDecision[] };

export function applyDecisions(
  v: { runId: string; items: ValidDecision[] },
  deps: { kbRoot: string; append: (lines: DecisionLine[]) => void; now: () => number },
): ApplyResult {
  const ts = deps.now();
  const lines: DecisionLine[] = v.items.map((i) => ({
    v: DECISION_LINE_VERSION,
    ts,
    runId: v.runId,
    entryId: i.entryId,
    decision: i.decision,
    ...(i.mergeInto ? { mergeInto: i.mergeInto } : {}),
    by: "owner",
  }));
  deps.append(lines); // durable intent first

  const applied: AppliedDecision[] = v.items.map((i) => ({ entryId: i.entryId, decision: i.decision }));
  const archives = v.items.filter((i) => i.decision === "archive");
  if (archives.length > 0) {
    const requests = archives.map((i) => ({ id: i.entryId, reason: `owner decision (diagnostics report ${v.runId})` }));
    let outcomes: ArchiveOutcome[];
    try {
      outcomes = archiveWithRetry(deps.kbRoot, requests, ts);
    } catch (err) {
      const error = err instanceof KbStoreConflictError ? "the KB file changed while archiving; retry" : "archive failed";
      log.warn("kb-analysis", "archive decision recorded but not applied", {
        event: err instanceof KbStoreConflictError ? "kb_analysis.archive_conflict" : "kb_analysis.archive_failed",
        runId: v.runId,
        count: archives.length,
      });
      return { ok: false, recorded: true, error, applied };
    }
    for (const o of outcomes) {
      const a = applied.find((x) => x.entryId === o.id);
      if (!a) continue;
      a.archive = o.status;
      if ("file" in o) a.archivedTo = `.agents/knowledge/${ARCHIVE_DIR}/${o.file}`;
    }
  }
  log.info("kb-analysis", "owner decisions applied", {
    event: "kb_analysis.decision_applied",
    runId: v.runId,
    count: v.items.length,
    archived: applied.filter((a) => a.archive === "archived" || a.archive === "completed-partial").length,
  });
  return { ok: true, applied };
}

function archiveWithRetry(kbRoot: string, requests: { id: string; reason: string }[], ts: number): ArchiveOutcome[] {
  try {
    return archiveEntries(kbRoot, requests, { now: new Date(ts) });
  } catch (err) {
    if (!(err instanceof KbStoreConflictError)) throw err;
    return archiveEntries(kbRoot, requests, { now: new Date(ts) }); // reload + retry once
  }
}

/**
 * Boot reconcile for the crash window between "archive appended" and "live
 * store rewritten": finish ONLY ids whose last decision is archive AND that
 * are present in BOTH the live store and the archive. An id that is only live
 * (the owner moved it back by hand) is left alone.
 */
export function reconcileArchiveDecisions(kbRoot: string, decisions: Map<string, FoldedDecision>): string[] {
  const wanted = [...decisions].filter(([, d]) => d.decision === "archive").map(([id]) => id);
  if (wanted.length === 0) return [];
  const load = loadKb(kbRoot);
  const halfDone: string[] = [];
  for (const store of load.stores) {
    const inArchive = archivedIds(join(kbRoot, ARCHIVE_DIR, store.file));
    for (const e of entriesOf({ stores: [store], errors: [] })) {
      if (wanted.includes(e.id) && inArchive.has(e.id)) halfDone.push(e.id);
    }
  }
  if (halfDone.length === 0) return [];
  archiveEntries(kbRoot, halfDone.map((id) => ({ id, reason: "owner decision (reconciled at boot)" })));
  log.warn("kb-analysis", "finished archive decisions interrupted by a crash", { event: "kb_analysis.archive_reconciled", count: halfDone.length });
  return halfDone;
}
