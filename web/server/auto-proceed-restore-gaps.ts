/**
 * Auto-proceed hold restore gaps (aura-meta-diet P4/FIX-AP-4).
 *
 * After a restart the auto-proceed controller restores the group's STOP hold
 * from `.council/reviews/`. A review file it cannot read or parse leaves the
 * restore incomplete, and auto-proceed stays held (fail-closed). This module
 * makes that hold visible and releasable:
 *
 *  - {@link describeRestoreGap} turns a gap code (`review_unparseable:<file>`,
 *    `verdicts_invalid-json`, …) into what the ObserverPanel shows: a reason
 *    in words and, for a review file, the file name plus a fingerprint of the
 *    exact content the human saw.
 *  - A human may "ignore this file". The decision is persisted per group at
 *    `<workspace>/.council/state/<group>-ignored-restore-gaps.json`, keyed by
 *    file name AND content fingerprint: a rewritten file that is still broken
 *    blocks again (the human never saw that content), and a file that becomes
 *    parseable is read normally (an ignore never hides a real STOP).
 *
 * Only review-file gaps are ignorable. A broken verdicts file or a failed
 * readdir is a workspace problem the human has to repair; it stays a visible,
 * non-ignorable gap.
 *
 * Foreign / legacy rule (documented here, applied in `council-lifecycle.ts`):
 * a review file that fails the strict parser but is a JSON object naming a
 * DIFFERENT `session_group_id` belongs to another pair sharing the workspace
 * and is skipped (never a gap for this group — the live path rejects it the
 * same way). A file without any `session_group_id` (legacy, written before the
 * field existed) cannot be attributed: it stays a gap, shown with "ignore".
 *
 * Written only by the server; the observer's write allow-list excludes
 * `.council/state/`.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeAtomicJson } from "./atomic-write.js";
import { resolveCouncilStatePath } from "./council-state-path.js";

export const IGNORED_RESTORE_GAPS_SCHEMA_VERSION = 1;
/** Oldest entries are evicted past this count (bounded file). */
export const MAX_IGNORED_RESTORE_GAPS_PER_GROUP = 256;
const IGNORED_SUFFIX = "-ignored-restore-gaps.json";

/** Pinned review filename shape from review-watcher: `<phase>-<provider>-observer.md`. */
export const OBSERVER_REVIEW_FILENAME_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9_.\-]{0,63}-(claude|codex)-observer\.md$/;

/** Fingerprint of a file the server could not read at all. */
export const UNREADABLE_FINGERPRINT = "unreadable";

/** sha256 of the review content, or {@link UNREADABLE_FINGERPRINT}. */
export function fingerprintReview(raw: string | null): string {
  return raw === null ? UNREADABLE_FINGERPRINT : createHash("sha256").update(raw).digest("hex");
}

function isFingerprint(v: unknown): v is string {
  return typeof v === "string" && (v === UNREADABLE_FINGERPRINT || /^[a-f0-9]{64}$/.test(v));
}

/** What the ObserverPanel shows for one gap (wire shape). */
export interface RestoreGapView {
  /** The raw gap code, as logged in `auto-proceed.hold-restore-incomplete`. */
  gap: string;
  /** Human-readable reason. */
  reason: string;
  /** Review file name (only for review-file gaps). */
  file?: string;
  /** Present iff the gap is ignorable; sent back with the ignore request. */
  fingerprint?: string;
}

const VERDICT_REASONS: Record<string, string> = {
  "path-error": "the review verdicts file path could not be resolved",
  unreadable: "the review verdicts file could not be read",
  "invalid-json": "the review verdicts file is not valid JSON",
  "invalid-shape": "the review verdicts file has an unexpected shape",
};

/**
 * Describe a gap code. `fingerprints` maps review file name → fingerprint of
 * the content that produced the gap; a file gap without one is shown but not
 * ignorable.
 */
export function describeRestoreGap(gap: string, fingerprints: ReadonlyMap<string, string>): RestoreGapView {
  const sep = gap.indexOf(":");
  const kind = sep === -1 ? gap : gap.slice(0, sep);
  const file = sep === -1 ? undefined : gap.slice(sep + 1);
  if ((kind === "review_unreadable" || kind === "review_unparseable") && file) {
    const fingerprint = fingerprints.get(file);
    return {
      gap,
      reason: kind === "review_unreadable"
        ? "review file could not be read"
        : "review file is not a valid review for this pair (unparseable or legacy format)",
      file,
      ...(fingerprint ? { fingerprint } : {}),
    };
  }
  if (kind.startsWith("verdicts_")) {
    return { gap, reason: VERDICT_REASONS[kind.slice("verdicts_".length)] ?? "the review verdicts file is unusable" };
  }
  if (kind === "reviews_readdir_failed") return { gap, reason: "the reviews folder could not be listed" };
  return { gap, reason: "restore incomplete" };
}

export interface IgnoredRestoreGap {
  file: string;
  fingerprint: string;
}

export type IgnoredRestoreGapsReadResult =
  | { ok: true; entries: IgnoredRestoreGap[] }
  | { ok: false; reason: "path-error" | "unreadable" | "invalid-json" | "invalid-shape" };

/**
 * Read a group's ignored gaps. A missing file is an empty list. Any other
 * failure is reported; callers treat it as empty, which keeps every gap
 * blocking (fail-closed).
 */
export function readIgnoredRestoreGaps(workspaceRoot: string, groupId: string): IgnoredRestoreGapsReadResult {
  const p = resolveCouncilStatePath(workspaceRoot, groupId, IGNORED_SUFFIX);
  if (!p.ok) return { ok: false, reason: "path-error" };
  let raw: string;
  try {
    raw = readFileSync(p.value.absolutePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, entries: [] };
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
  if (obj.schemaVersion !== IGNORED_RESTORE_GAPS_SCHEMA_VERSION || !Array.isArray(obj.entries)) {
    return { ok: false, reason: "invalid-shape" };
  }
  // One bad row must not discard the other decisions.
  const entries: IgnoredRestoreGap[] = [];
  for (const e of obj.entries) {
    if (e === null || typeof e !== "object") continue;
    const { file, fingerprint } = e as Record<string, unknown>;
    if (typeof file === "string" && OBSERVER_REVIEW_FILENAME_PATTERN.test(file) && isFingerprint(fingerprint)) {
      entries.push({ file, fingerprint });
    }
  }
  return { ok: true, entries };
}

/** True when a human ignored exactly this file content. */
export function isRestoreGapIgnored(
  entries: readonly IgnoredRestoreGap[],
  file: string,
  fingerprint: string,
): boolean {
  return entries.some((e) => e.file === file && e.fingerprint === fingerprint);
}

export type AddIgnoredRestoreGapResult =
  | { ok: true; added: boolean }
  | { ok: false; reason: "invalid-input" | "path-error" | "write-failed"; detail?: string };

/** Append an ignore decision (idempotent) and persist atomically. */
export function addIgnoredRestoreGap(
  workspaceRoot: string,
  groupId: string,
  entry: IgnoredRestoreGap,
): AddIgnoredRestoreGapResult {
  if (!OBSERVER_REVIEW_FILENAME_PATTERN.test(entry.file) || !isFingerprint(entry.fingerprint)) {
    return { ok: false, reason: "invalid-input" };
  }
  const p = resolveCouncilStatePath(workspaceRoot, groupId, IGNORED_SUFFIX);
  if (!p.ok) return { ok: false, reason: "path-error" };
  const existing = readIgnoredRestoreGaps(workspaceRoot, groupId);
  const entries = existing.ok ? existing.entries : [];
  if (isRestoreGapIgnored(entries, entry.file, entry.fingerprint)) return { ok: true, added: false };
  entries.push({ file: entry.file, fingerprint: entry.fingerprint });
  try {
    writeAtomicJson(
      p.value.absolutePath,
      {
        schemaVersion: IGNORED_RESTORE_GAPS_SCHEMA_VERSION,
        sessionGroupId: groupId,
        entries: entries.slice(-MAX_IGNORED_RESTORE_GAPS_PER_GROUP),
      },
      { maxBytes: 256 * 1024 },
    );
  } catch (err) {
    return { ok: false, reason: "write-failed", detail: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true, added: true };
}

/**
 * Foreign/legacy probe for a review file that failed the strict parser: the
 * `session_group_id` it names, or null when it names none (legacy / not JSON).
 */
export function claimedGroupIdOf(raw: string): string | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const id = (parsed as Record<string, unknown>).session_group_id;
    return typeof id === "string" && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}
