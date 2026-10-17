/**
 * handoff-files — the filename lifecycle of continue-in-new handoff briefs.
 *
 * `POST /sessions/:id/continue-in-new` writes the prior session's brief into
 * the workspace as `.aura-handoff-<YYYY-MM-DD>T<HH-MM-SS>.md`. This module is
 * the ONE place that knows that shape (filename-contract convention: one
 * exported pattern for consumers + one builder for producers, reference
 * `OBSERVER_REVIEW_FILE_PATTERN` / `buildObserverReviewFilename`), and it owns
 * the only code that ever deletes such a file.
 *
 * Why the pattern is this strict: operators also keep hand-written session
 * notes next to these files, named `.aura-handoff-2026-10-17.md` (date only,
 * no time). The pruner's allow-list is this exact regex, so those notes fail
 * the match by shape — not by a "skip known names" list. A looser pattern
 * here would delete someone's notes, so widening it is a deliberate,
 * reviewed act, never a convenience edit.
 */
import { lstatSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { log } from "./logger.js";

/**
 * Exact endpoint filename shape. Anchored both ends; the `T` + three dashed
 * two-digit groups are what distinguish an endpoint file from an operator's
 * date-only note. Lower-case `.md` only.
 */
export const HANDOFF_FILE_PATTERN = /^\.aura-handoff-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})\.md$/;

/**
 * Producer helper. Throws on an invalid date and self-asserts the result
 * against {@link HANDOFF_FILE_PATTERN}, so a drift between builder and
 * pattern fails loudly at the write site instead of silently putting every
 * new file outside the pruner's allow-list.
 */
export function buildHandoffFilename(date: Date): string {
  if (Number.isNaN(date.getTime())) throw new Error("buildHandoffFilename: invalid date");
  // 2026-10-17T16:58:46.123Z → 2026-10-17T16-58-46
  const ts = date.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const name = `.aura-handoff-${ts}.md`;
  if (!HANDOFF_FILE_PATTERN.test(name)) {
    throw new Error(`buildHandoffFilename: produced a name outside HANDOFF_FILE_PATTERN: ${name}`);
  }
  return name;
}

/**
 * Epoch ms of the timestamp embedded in an endpoint filename, or `null` when
 * the name does not match the pattern or encodes an impossible date (month
 * 13, 31 Feb…). Ordering for retention uses THIS value, not mtime: editors,
 * `git checkout` and rsync all touch mtime, the name never changes.
 */
export function parseHandoffTimestamp(name: string): number | null {
  const m = HANDOFF_FILE_PATTERN.exec(name);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  const back = new Date(ms);
  const roundTrips =
    back.getUTCFullYear() === y &&
    back.getUTCMonth() === mo - 1 &&
    back.getUTCDate() === d &&
    back.getUTCHours() === h &&
    back.getUTCMinutes() === mi &&
    back.getUTCSeconds() === s;
  return roundTrips ? ms : null;
}

export interface HandoffPrunePolicy {
  /** Newest files (by embedded timestamp) that are never pruned. */
  keepNewest: number;
  /** A file younger than this — by embedded timestamp OR by mtime — is never pruned. */
  minAgeMs: number;
  /** Hard cap on deletions per call; beyond it the rest is left and reported as `capped`. */
  maxDeletions: number;
}

export const DEFAULT_HANDOFF_PRUNE_POLICY: HandoffPrunePolicy = {
  keepNewest: 3,
  minAgeMs: 7 * 24 * 60 * 60 * 1000,
  maxDeletions: 20,
};

export interface HandoffFileEntry {
  /** Basename, already matched against {@link HANDOFF_FILE_PATTERN} by the caller or not — the selector re-checks. */
  name: string;
  mtimeMs: number;
}

export interface HandoffPruneSelection {
  /** Entries to delete, oldest first. */
  prune: HandoffFileEntry[];
  /** More files were eligible than `maxDeletions`; the overflow was left in place. */
  capped: boolean;
}

/**
 * Pure retention decision. Deletes only when BOTH hold:
 *   1. the file is outside the newest `keepNewest` by embedded timestamp, AND
 *   2. it is older than `minAgeMs` by the MORE RECENT of (embedded timestamp,
 *      mtime) — a brief the operator edited last week stays even if its name
 *      says it is a month old.
 * Unparseable names are never candidates (defence in depth: the caller should
 * have filtered by the pattern already). `exclude` (the file just written by
 * the current request) is never pruned regardless of where it sorts — if the
 * clock stepped backwards it can sort "older" than existing files.
 */
export function selectHandoffFilesToPrune(
  entries: readonly HandoffFileEntry[],
  nowMs: number,
  opts: { policy?: HandoffPrunePolicy; exclude?: string } = {},
): HandoffPruneSelection {
  const policy = opts.policy ?? DEFAULT_HANDOFF_PRUNE_POLICY;
  const dated = entries
    .map((e) => ({ entry: e, ts: parseHandoffTimestamp(e.name) }))
    .filter((x): x is { entry: HandoffFileEntry; ts: number } => x.ts !== null)
    // Newest first; name as a total-order tiebreak so the result is deterministic.
    .sort((a, b) => b.ts - a.ts || (a.entry.name < b.entry.name ? 1 : a.entry.name > b.entry.name ? -1 : 0));
  const beyondKeep = dated.slice(Math.max(0, policy.keepNewest));
  const eligible = beyondKeep
    .filter((x) => x.entry.name !== opts.exclude)
    .filter((x) => nowMs - Math.max(x.ts, x.entry.mtimeMs) > policy.minAgeMs)
    .map((x) => x.entry)
    .reverse(); // oldest first
  const capped = eligible.length > policy.maxDeletions;
  return { prune: capped ? eligible.slice(0, policy.maxDeletions) : eligible, capped };
}

export interface HandoffPruneResult {
  deleted: string[];
  failed: string[];
  capped: boolean;
}

/**
 * Thin impure wrapper around {@link selectHandoffFilesToPrune}. Reads ONE
 * directory non-recursively, considers only regular-file dirents (symlinks
 * are skipped, never followed, never unlinked) whose name matches the exact
 * pattern, `lstat`s only those, and unlinks the selection with per-file
 * isolation (ENOENT counts as success: a second tab may have pruned first).
 * Never throws — a cleanup failure must never turn a successful handoff into
 * an error response. Every unlink and every failure is one structured log line
 * carrying the basename only, never file contents.
 */
export function pruneHandoffFiles(args: {
  cwd: string;
  sessionId: string;
  /** The file this request just wrote; never pruned. */
  keep?: string;
  nowMs?: number;
  policy?: HandoffPrunePolicy;
}): HandoffPruneResult {
  const { cwd, sessionId } = args;
  const nowMs = args.nowMs ?? Date.now();
  const result: HandoffPruneResult = { deleted: [], failed: [], capped: false };
  try {
    const root = resolve(cwd);
    const entries: HandoffFileEntry[] = [];
    for (const dirent of readdirSync(cwd, { withFileTypes: true })) {
      const name = dirent.name;
      if (!dirent.isFile()) continue; // directories, symlinks, sockets: never
      if (!HANDOFF_FILE_PATTERN.test(name)) continue;
      try {
        const st = lstatSync(join(cwd, name));
        if (!st.isFile()) continue;
        entries.push({ name, mtimeMs: st.mtimeMs });
      } catch {
        // Vanished between readdir and lstat — not a candidate.
      }
    }
    const selection = selectHandoffFilesToPrune(entries, nowMs, { policy: args.policy, exclude: args.keep });
    result.capped = selection.capped;
    if (selection.capped) {
      log.warn("handoff-files", "handoff prune hit the per-request deletion cap", {
        event: "handoff.prune_capped",
        sessionId,
        cwd,
        matched: entries.length,
        maxDeletions: (args.policy ?? DEFAULT_HANDOFF_PRUNE_POLICY).maxDeletions,
      });
    }
    for (const entry of selection.prune) {
      const target = join(cwd, entry.name);
      // Tripwire: the name came from readdir and matched an anchored pattern,
      // so this can never fire — which is exactly why it belongs here.
      if (entry.name.includes("/") || entry.name.includes("\\") || entry.name.includes("\0")
        || resolve(dirname(target)) !== root) {
        result.failed.push(entry.name);
        log.error("handoff-files", "handoff prune refused a candidate outside cwd", {
          event: "handoff.prune_refused",
          sessionId,
          cwd,
          file: entry.name,
        });
        continue;
      }
      try {
        unlinkSync(target);
        result.deleted.push(entry.name);
        log.info("handoff-files", "pruned an old handoff brief", {
          event: "handoff.pruned",
          sessionId,
          cwd,
          file: entry.name,
          ageMs: nowMs - Math.max(parseHandoffTimestamp(entry.name) ?? 0, entry.mtimeMs),
        });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === "ENOENT") {
          // Already gone (a concurrent prune won the race) — the goal state holds.
          result.deleted.push(entry.name);
          continue;
        }
        result.failed.push(entry.name);
        log.warn("handoff-files", "could not prune an old handoff brief", {
          event: "handoff.prune_failed",
          sessionId,
          cwd,
          file: entry.name,
          code: code ?? "unknown",
        });
      }
    }
  } catch (err) {
    log.warn("handoff-files", "handoff prune aborted", {
      event: "handoff.prune_failed",
      sessionId,
      cwd,
      code: (err as NodeJS.ErrnoException)?.code ?? "unknown",
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return result;
}
