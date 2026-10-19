/**
 * Deterministic KB analyzer (spec §3.3; plan Task 9). No LLM, no I/O.
 *
 * `analyzeKb` turns loaded entries + the usage index + folded owner decisions
 * into findings — PROPOSALS for a human. It never writes anything; the only
 * filesystem-dependent signal (`dead-reference`) gets an injected `exists`
 * predicate that the caller bounds to the repo root (EC-7).
 *
 * One finding per entry, carrying every signal that fired for it (a card shows
 * all reasons at once). Heuristic signals (`contradiction`, `bitter-pill`)
 * never suggest a decision.
 */

import {
  entriesOf,
  isPromoted,
  usageOf,
  type KbEntry,
  type KbLoad,
  type UsageIndex,
} from "../knowledge/kb-store.js";
import {
  type Decision,
  type KbEntrySummary,
  type KbFinding,
  type KbSignal,
  type SignalHit,
  type SuggestedDecision,
} from "./diagnostics-types.js";

export const NEVER_USED_MIN_AGE_DAYS = 30;
export const DUPLICATE_JACCARD = 0.8;
export const CONTRADICTION_MIN_JACCARD = 0.2;
export const BITTER_PILL_MIN_AGE_DAYS = 180;
export const KEEP_SUPPRESS_DAYS = 90;
const MAX_TEXT = 2000;
const DAY = 86_400_000;

export interface FoldedDecision {
  decision: Decision;
  ts: number;
  mergeInto?: string;
}

export interface AnalyzeKbInput {
  load: KbLoad;
  usage: UsageIndex;
  /** Last decision per entry id (folded from decisions.jsonl). */
  decisions: Map<string, FoldedDecision>;
  now: number;
  /** Repo-relative path existence, bounded to the repo root by the caller. */
  exists: (repoRelativePath: string) => boolean;
}

export interface AnalyzeKbResult {
  findings: KbFinding[];
  mergeTasks: { entryId: string; mergeInto: string; decidedAt: number }[];
  entryCount: number;
  parseErrors: number;
}

// ─── helpers ────────────────────────────────────────────────────────────────

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const clip = (s: string): string => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : s);

function provenanceOf(e: KbEntry): { source: string; reference: string; date: string }[] {
  const pv = e.provenance;
  if (!Array.isArray(pv)) return [];
  return pv.flatMap((p) =>
    typeof p === "object" && p !== null
      ? [{ source: str((p as Record<string, unknown>).source), reference: str((p as Record<string, unknown>).reference), date: str((p as Record<string, unknown>).date) }]
      : typeof p === "string"
        ? [{ source: "", reference: p, date: "" }]
        : [],
  );
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/**
 * The repo-relative path a reference names, or null when it is not a path we
 * can check: prose, PR numbers, URLs, home (`~`) or absolute paths, `..`.
 * Those are never reported dead — an unverifiable reference is not evidence.
 */
export function referencedPath(ref: string): string | null {
  const first = ref.trim().split(/\s+/, 1)[0] ?? "";
  const cleaned = first.replace(/[:#]L?\d+(-\d+)?$/, "").replace(/[),.;:]+$/, "");
  if (cleaned === "" || cleaned.startsWith("~") || cleaned.startsWith("/") || /^[a-z]+:\/\//i.test(cleaned)) return null;
  if (cleaned.split("/").includes("..")) return null;
  if (!/^[A-Za-z0-9_.@-]+(\/[A-Za-z0-9_.@-]+)*\/?$/.test(cleaned)) return null;
  const looksLikeFile = /\.[A-Za-z0-9]{1,6}$/.test(cleaned);
  if (!cleaned.includes("/") && !looksLikeFile) return null;
  return cleaned.replace(/\/$/, "");
}

export function normalizeFact(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

function tokens(e: KbEntry): Set<string> {
  const words = normalizeFact(str(e.fact)).split(" ").filter((w) => w.length > 2);
  return new Set([...words, ...stringList(e.tags).map((t) => `#${t.toLowerCase()}`)]);
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

const NEGATIVE = /\b(never|do not|don't|dont|avoid|must not|mustn't|stop)\b/i;
const POSITIVE = /\b(always|must|should|prefer|use)\b/i;
function polarity(text: string): -1 | 0 | 1 {
  if (NEGATIVE.test(text)) return -1;
  if (POSITIVE.test(text)) return 1;
  return 0;
}

const MODEL_TOPIC = /\b(claude|codex|model|cli|llm|opus|sonnet|haiku|gpt)\b/i;

function createdMs(e: KbEntry): number | null {
  const t = Date.parse(str(e.createdAt));
  return Number.isFinite(t) ? t : null;
}

function newestProvenanceMs(e: KbEntry): number | null {
  let best: number | null = null;
  for (const p of provenanceOf(e)) {
    const t = Date.parse(p.date);
    if (Number.isFinite(t) && (best === null || t > best)) best = t;
  }
  return best ?? createdMs(e);
}

// ─── analysis ───────────────────────────────────────────────────────────────

export function analyzeKb(input: AnalyzeKbInput): AnalyzeKbResult {
  const { usage, decisions, now, exists } = input;
  const all = entriesOf(input.load);
  const fileOf = new Map<string, string>();
  for (const s of input.load.stores) for (const l of s.lines) if (l.kind === "entry") fileOf.set(l.entry.id, s.file);

  const mergeTasks: AnalyzeKbResult["mergeTasks"] = [];
  const active = all.filter((e) => {
    const d = decisions.get(e.id);
    if (!d) return true;
    if (d.decision === "merge" && d.mergeInto) {
      mergeTasks.push({ entryId: e.id, mergeInto: d.mergeInto, decidedAt: d.ts });
      return false;
    }
    if (d.decision === "keep") {
      const changedSince = (Date.parse(str(e.updatedAt)) || 0) > d.ts;
      return changedSince || now - d.ts >= KEEP_SUPPRESS_DAYS * DAY;
    }
    return d.decision !== "archive";
  });

  const hits = new Map<string, SignalHit[]>();
  const add = (id: string, hit: SignalHit) => hits.set(id, [...(hits.get(id) ?? []), hit]);
  const affected = new Map<string, { path: string; exists: boolean }[]>();

  for (const e of active) {
    const used = usageOf(e, usage);
    const created = createdMs(e);
    const ageDays = created === null ? null : Math.floor((now - created) / DAY);

    if (used === 0 && (usage.counts.get(e.id) ?? 0) === 0 && ageDays !== null && ageDays >= NEVER_USED_MIN_AGE_DAYS) {
      add(e.id, {
        signal: "never-used",
        criterion: `usageCount 0, not in usage.log, created ${str(e.createdAt).slice(0, 10)} (${ageDays} days ≥ ${NEVER_USED_MIN_AGE_DAYS})`,
      });
    }

    const paths = [
      ...stringList(e.affectedFiles),
      ...provenanceOf(e).map((p) => p.reference),
    ]
      .map(referencedPath)
      .filter((p): p is string => p !== null);
    const unique = [...new Set(paths)];
    const checked = unique.map((p) => ({ path: p, exists: exists(p) }));
    affected.set(
      e.id,
      stringList(e.affectedFiles).map((f) => {
        const p = referencedPath(f);
        return { path: f, exists: p === null ? true : checked.find((c) => c.path === p)?.exists ?? true };
      }),
    );
    const missing = checked.filter((c) => !c.exists).map((c) => c.path);
    if (missing.length > 0) {
      add(e.id, { signal: "dead-reference", criterion: `missing in the repo: ${missing.join(", ")}` });
      if (isPromoted(e)) add(e.id, { signal: "stale-promoted", criterion: "promoted, but it cites files that no longer exist" });
    }

    const outdated = num(e.outdatedReports);
    if (outdated >= 1) add(e.id, { signal: "outdated-reports", criterion: `outdatedReports ${outdated} ≥ 1` });

    const type = str(e.type);
    const newest = newestProvenanceMs(e);
    if (
      (type === "gotcha" || type === "pattern") &&
      MODEL_TOPIC.test(`${str(e.fact)} ${stringList(e.tags).join(" ")}`) &&
      newest !== null &&
      now - newest >= BITTER_PILL_MIN_AGE_DAYS * DAY
    ) {
      add(e.id, {
        signal: "bitter-pill",
        criterion: `about model/CLI behaviour, last confirmed ${Math.floor((now - newest) / DAY)} days ago (≥ ${BITTER_PILL_MIN_AGE_DAYS}) — the model may do this on its own now`,
      });
    }
  }

  // Pairwise: duplicate + contradiction (152 entries → ~11k pairs; cheap).
  const tok = new Map(active.map((e) => [e.id, tokens(e)]));
  const norm = new Map(active.map((e) => [e.id, normalizeFact(str(e.fact))]));
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i];
      const b = active[j];
      const sim = jaccard(tok.get(a.id)!, tok.get(b.id)!);
      const identical = norm.get(a.id) !== "" && norm.get(a.id) === norm.get(b.id);
      if (identical || sim >= DUPLICATE_JACCARD) {
        const criterion = identical ? "identical normalised fact" : `Jaccard ${sim.toFixed(2)} on fact + tags (≥ ${DUPLICATE_JACCARD})`;
        add(a.id, { signal: "duplicate", criterion, partnerId: b.id, similarity: identical ? 1 : sim });
        add(b.id, { signal: "duplicate", criterion, partnerId: a.id, similarity: identical ? 1 : sim });
        continue;
      }
      const filesA = new Set(stringList(a.affectedFiles));
      const shared = stringList(b.affectedFiles).filter((f) => filesA.has(f));
      if (shared.length === 0 || sim < CONTRADICTION_MIN_JACCARD) continue;
      const pa = polarity(str(a.recommendation));
      const pb = polarity(str(b.recommendation));
      if (pa !== 0 && pb !== 0 && pa !== pb) {
        const criterion = `opposite advice on ${shared.join(", ")} (one says do, the other says don't) — heuristic, check by hand`;
        add(a.id, { signal: "contradiction", criterion, partnerId: b.id, similarity: sim });
        add(b.id, { signal: "contradiction", criterion, partnerId: a.id, similarity: sim });
      }
    }
  }

  const findings: KbFinding[] = [];
  for (const e of active) {
    const signals = hits.get(e.id);
    if (!signals) continue;
    findings.push({ entryId: e.id, signals, suggested: suggest(signals), entry: summarize(e, fileOf.get(e.id) ?? "", usage, affected.get(e.id) ?? []) });
  }
  findings.sort((x, y) => x.entryId.localeCompare(y.entryId));
  return { findings, mergeTasks, entryCount: all.length, parseErrors: input.load.errors.length };
}

const ARCHIVE_SIGNALS: readonly KbSignal[] = ["never-used", "dead-reference", "outdated-reports"];

function suggest(signals: SignalHit[]): SuggestedDecision {
  const kinds = new Set(signals.map((s) => s.signal));
  if (kinds.has("duplicate")) return "merge";
  // A promoted entry with dead references needs an update, not an archive;
  // heuristic-only findings (contradiction, bitter-pill) suggest nothing.
  if (ARCHIVE_SIGNALS.some((s) => kinds.has(s)) && !kinds.has("stale-promoted")) return "archive";
  return null;
}

function summarize(
  e: KbEntry,
  file: string,
  usage: UsageIndex,
  affectedFiles: { path: string; exists: boolean }[],
): KbEntrySummary {
  return {
    id: e.id,
    file,
    type: str(e.type),
    fact: clip(str(e.fact)),
    recommendation: clip(str(e.recommendation)),
    confidence: str(e.confidence),
    tags: stringList(e.tags).slice(0, 20),
    affectedFiles: affectedFiles.slice(0, 20),
    provenance: provenanceOf(e).slice(0, 10).map((p) => ({ ...p, reference: clip(p.reference) })),
    createdAt: str(e.createdAt) || null,
    usage: usageOf(e, usage),
    helpfulCount: num(e.helpfulCount),
    outdatedReports: num(e.outdatedReports),
    promoted: isPromoted(e),
  };
}
