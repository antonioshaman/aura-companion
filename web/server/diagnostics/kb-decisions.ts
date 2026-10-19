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

import { log } from "../logger.js";
import { ARCHIVE_DIR, archiveEntries, KbStoreConflictError, type ArchiveOutcome } from "../knowledge/kb-store.js";
import { clearArchivePending, readArchivePending, type ArchivePending } from "./kb-analysis-store.js";
import { DECISION_LINE_VERSION, KB_DECISIONS, type Decision, type DecisionLine, type KbAnalysisReport } from "./diagnostics-types.js";

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
  /**
   * An archive did not complete. Its intent is kept in the pending sentinel
   * (finished at the next server start) and NO decision line was written, so
   * the page keeps showing the finding instead of claiming "archived".
   */
  | { ok: false; recorded: true; error: string; applied: AppliedDecision[] };

export interface ApplyDeps {
  kbRoot: string;
  append: (lines: DecisionLine[]) => void;
  pending: { write: (p: ArchivePending) => void; clear: () => void };
  now: () => number;
}

const COMPLETED: ReadonlySet<ArchiveOutcome["status"]> = new Set(["archived", "completed-partial", "already-archived"]);

/**
 * Order (ritchie B-1/B-2, review 2026-10-19-1110):
 *   keep / merge / seen — one ledger line each, nothing else is written;
 *   archive — pending sentinel → archiveEntries → ledger line for each id that
 *   really moved → clear the sentinel. The ledger therefore never claims an
 *   archive that did not happen, and the boot reconcile only ever finishes
 *   what the sentinel proves was interrupted.
 */
export function applyDecisions(v: { runId: string; items: ValidDecision[] }, deps: ApplyDeps): ApplyResult {
  const ts = deps.now();
  const line = (i: ValidDecision): DecisionLine => ({
    v: DECISION_LINE_VERSION,
    ts,
    runId: v.runId,
    entryId: i.entryId,
    decision: i.decision,
    ...(i.mergeInto ? { mergeInto: i.mergeInto } : {}),
    by: "owner",
  });
  const applied: AppliedDecision[] = v.items.map((i) => ({ entryId: i.entryId, decision: i.decision }));
  const others = v.items.filter((i) => i.decision !== "archive");
  if (others.length > 0) deps.append(others.map(line));

  const archives = v.items.filter((i) => i.decision === "archive");
  if (archives.length === 0) {
    logApplied(v.runId, v.items.length, 0);
    return { ok: true, applied };
  }
  deps.pending.write({ v: 1, runId: v.runId, ts, ids: archives.map((i) => i.entryId) });
  let outcomes: ArchiveOutcome[];
  try {
    outcomes = archiveWithRetry(deps.kbRoot, archives.map((i) => ({ id: i.entryId, reason: `owner decision (diagnostics report ${v.runId})` })), ts);
  } catch (err) {
    const conflict = err instanceof KbStoreConflictError;
    log.warn("kb-analysis", "archive decision not applied; kept as pending", {
      event: conflict ? "kb_analysis.archive_conflict" : "kb_analysis.archive_failed",
      runId: v.runId,
      count: archives.length,
    });
    return {
      ok: false,
      recorded: true,
      error: conflict ? "the KB file changed while archiving — press Archive again" : "archive failed — check that the server can write .agents/knowledge",
      applied,
    };
  }
  const done: ValidDecision[] = [];
  const refused: string[] = [];
  for (const o of outcomes) {
    const a = applied.find((x) => x.entryId === o.id);
    if (!a) continue;
    a.archive = o.status;
    if ("file" in o) a.archivedTo = `.agents/knowledge/${ARCHIVE_DIR}/${o.file}`;
    const item = archives.find((i) => i.entryId === o.id);
    if (item && COMPLETED.has(o.status)) done.push(item);
    else refused.push(o.status === "ambiguous" ? `${o.id} is on more than one line (${o.files.join(", ")})` : `${o.id} was not found`);
  }
  if (done.length > 0) deps.append(done.map(line));
  deps.pending.clear();
  logApplied(v.runId, v.items.length, done.length);
  if (refused.length > 0) return { ok: false, recorded: true, error: `not archived: ${refused.join("; ")}`, applied };
  return { ok: true, applied };
}

function logApplied(runId: string, count: number, archived: number): void {
  log.info("kb-analysis", "owner decisions applied", { event: "kb_analysis.decision_applied", runId, count, archived });
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
 * Boot reconcile: finish an archive the pending sentinel proves was
 * interrupted (crash, kill, unwritable KB), then write its decision lines and
 * clear the sentinel. Without a sentinel nothing happens — a restored entry
 * is the owner's choice, never undone at boot.
 */
export function reconcileArchivePending(kbRoot: string, reportsRoot: string, append: (lines: DecisionLine[]) => void): string[] {
  const p = readArchivePending(reportsRoot);
  if (!p) return [];
  const outcomes = archiveEntries(kbRoot, p.ids.map((id) => ({ id, reason: `owner decision (diagnostics report ${p.runId}, finished at boot)` })));
  const done = outcomes.filter((o) => COMPLETED.has(o.status)).map((o) => o.id);
  if (done.length > 0) {
    append(done.map((entryId) => ({ v: DECISION_LINE_VERSION, ts: p.ts, runId: p.runId, entryId, decision: "archive" as const, by: "owner" as const })));
  }
  clearArchivePending(reportsRoot);
  log.warn("kb-analysis", "finished an archive decision interrupted before it completed", {
    event: "kb_analysis.archive_reconciled",
    runId: p.runId,
    finished: done.length,
    requested: p.ids.length,
  });
  return done;
}
