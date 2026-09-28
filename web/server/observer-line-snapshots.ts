/**
 * Checkpoint line snapshots — the host-side source of the line facts the
 * grounding gate needs for B2 (meta-diet) line checks: "does the cited line
 * exist" and "did this checkpoint change it".
 *
 * On each accepted checkpoint the host reads the checkpoint's artifact files
 * (workspace-bounded, size-capped) and diffs each against the content the SAME
 * group last captured for that path. The result is frozen per checkpoint id,
 * so a review that lands after the orchestrator kept editing is still checked
 * against the bytes the observer was woken for.
 *
 * Honest unknowns, never guesses:
 *   - A path this group never captured before (first checkpoint, first time a
 *     file enters scope, server restart) has `changedRanges: null` — the
 *     unchanged-lines check is skipped for it, never "everything unchanged".
 *   - A review for a checkpoint with no snapshot (restart, evicted, bootstrap)
 *     falls back to reading the live file for line text with
 *     `changedRanges: null`.
 *   - Unreadable / binary / oversized files yield `null` facts → the gate marks
 *     a line-citing STOP as weak evidence, never downgrades it.
 *
 * In-memory only and bounded (per-group checkpoint ring + file size cap):
 * this is a grounding aid, not a persistence layer.
 */

import { readFileSync } from "node:fs";
import { diffArrays } from "diff";
import {
  createWorkspaceResolver,
  type EvidenceLineFacts,
  type EvidenceLineFactsProvider,
} from "./observer-grounding.js";

/** Files above this size are not snapshotted (facts → null). */
export const SNAPSHOT_MAX_FILE_BYTES = 512 * 1024;
/** Checkpoints kept per group — a review normally answers the newest one. */
export const SNAPSHOT_MAX_CHECKPOINTS_PER_GROUP = 4;
/** Artifact paths snapshotted per checkpoint; the rest get live-read facts. */
export const SNAPSHOT_MAX_PATHS_PER_CHECKPOINT = 200;

export type LineRange = [number, number];

interface FileSnapshot {
  lines: string[];
  changedRanges: LineRange[] | null;
}

interface GroupSnapshots {
  /** Last captured content per path, the baseline for the next diff. */
  latestByPath: Map<string, string[]>;
  /** checkpoint id → path → snapshot (`null` = unreadable at capture). Insertion-ordered ring. */
  checkpoints: Map<string, Map<string, FileSnapshot | null>>;
}

/** Split file content into lines; a trailing newline does not add a line. */
export function splitLines(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * 1-indexed inclusive ranges of `next` lines that are not in the longest
 * common subsequence with `prev` (i.e. added or modified lines). Pure
 * deletions leave no line in `next`; they are not ranges.
 */
export function changedLineRanges(prev: readonly string[], next: readonly string[]): LineRange[] {
  const ranges: LineRange[] = [];
  let line = 1;
  for (const part of diffArrays(prev as string[], next as string[])) {
    const count = part.value.length;
    if (part.removed) continue;
    if (part.added && count > 0) {
      const last = ranges[ranges.length - 1];
      if (last && last[1] === line - 1) last[1] = line + count - 1;
      else ranges.push([line, line + count - 1]);
    }
    line += count;
  }
  return ranges;
}

/** Read a workspace file as lines, or `null` if missing/escaping/binary/oversized. */
function readLinesWithin(resolveRel: (rel: string) => string | null, relPath: string): string[] | null {
  const abs = resolveRel(relPath);
  if (!abs) return null;
  let buf: Buffer;
  try {
    buf = readFileSync(abs);
  } catch {
    return null;
  }
  if (buf.length > SNAPSHOT_MAX_FILE_BYTES) return null;
  if (buf.subarray(0, 8000).includes(0)) return null;
  return splitLines(buf.toString("utf8"));
}

function toFacts(lines: string[], changedRanges: LineRange[] | null): EvidenceLineFacts {
  return {
    lineCount: lines.length,
    lineText: (n) => (Number.isInteger(n) && n >= 1 && n <= lines.length ? lines[n - 1] : undefined),
    changedRanges,
  };
}

export class CheckpointLineSnapshots {
  private groups = new Map<string, GroupSnapshots>();

  /**
   * Snapshot a checkpoint's artifact files. Idempotent per checkpoint id: a
   * second capture (failsafe re-scan of the same checkpoint) is ignored so it
   * cannot collapse the diff base to N-vs-N.
   */
  capture(sessionGroupId: string, checkpointId: string, workspaceRoot: string, paths: readonly string[]): void {
    let group = this.groups.get(sessionGroupId);
    if (!group) {
      group = { latestByPath: new Map(), checkpoints: new Map() };
      this.groups.set(sessionGroupId, group);
    }
    if (group.checkpoints.has(checkpointId)) return;

    const resolveRel = createWorkspaceResolver(workspaceRoot);
    const files = new Map<string, FileSnapshot | null>();
    for (const relPath of [...new Set(paths)].slice(0, SNAPSHOT_MAX_PATHS_PER_CHECKPOINT)) {
      const lines = readLinesWithin(resolveRel, relPath);
      if (!lines) {
        files.set(relPath, null);
        group.latestByPath.delete(relPath);
        continue;
      }
      const prev = group.latestByPath.get(relPath);
      files.set(relPath, { lines, changedRanges: prev ? changedLineRanges(prev, lines) : null });
      group.latestByPath.set(relPath, lines);
    }
    group.checkpoints.set(checkpointId, files);
    while (group.checkpoints.size > SNAPSHOT_MAX_CHECKPOINTS_PER_GROUP) {
      const oldest = group.checkpoints.keys().next().value;
      if (oldest === undefined) break;
      group.checkpoints.delete(oldest);
    }
  }

  /**
   * Line facts for one review: the checkpoint snapshot when the path was
   * captured, else the live file with unknown changed ranges.
   */
  providerFor(sessionGroupId: string, checkpointId: string, workspaceRoot: string): EvidenceLineFactsProvider {
    const files = this.groups.get(sessionGroupId)?.checkpoints.get(checkpointId);
    const resolveRel = createWorkspaceResolver(workspaceRoot);
    return (relPath) => {
      if (files?.has(relPath)) {
        const snap = files.get(relPath);
        return snap ? toFacts(snap.lines, snap.changedRanges) : null;
      }
      const lines = readLinesWithin(resolveRel, relPath);
      return lines ? toFacts(lines, null) : null;
    };
  }

  /** Drop everything held for a group (teardown). */
  forget(sessionGroupId: string): void {
    this.groups.delete(sessionGroupId);
  }
}
