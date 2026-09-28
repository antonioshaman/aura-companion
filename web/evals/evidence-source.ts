/**
 * Evidence source resolver — the code a finding points at, twice:
 *
 *   - AT THE CHECKPOINT: `git show <sha>:<path>` where `<sha>` is the last
 *     commit on the workspace's HEAD line at or before the review time. That
 *     is the closest durable record of what the observer read (a checkpoint
 *     may also include uncommitted edits — the note says "commit at-or-before
 *     review", never "exact checkpoint state").
 *   - CURRENT: the working-tree file now, for "is it still like this?".
 *
 * Shared by `eval:label-sheet` (per-workspace reviews) and `eval:label-export`
 * (recordings, workspace = the recording header's `cwd`). Reads git and disk
 * but never writes; paths are bounded to the workspace.
 *
 * Firewall-clean: no `server/` imports.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { resolveWithinWorkspace } from "./schema/eval-paths.js";

export interface ResolvedSnippet {
  /** Line-numbered text; `▶` marks the evidence range. */
  snippet: string;
  note: string;
}

export interface ResolvedEvidence {
  atCheckpoint: (ResolvedSnippet & { sha: string }) | null;
  current: ResolvedSnippet | null;
  /** Why a side is missing (no git, path outside workspace, deleted, …). */
  missing: string[];
}

const shaCache = new Map<string, string | null>();

/** Commit sha at-or-before `reviewedAt` on the workspace's HEAD line, or null
 *  when git/timestamp unavailable. Cached per (workspace, reviewedAt). */
export function commitAt(workspace: string, reviewedAt: string): string | null {
  if (!reviewedAt) return null;
  const key = `${workspace}\0${reviewedAt}`;
  if (shaCache.has(key)) return shaCache.get(key)!;
  let sha: string | null = null;
  try {
    const out = execFileSync("git", ["-C", workspace, "rev-list", "-1", `--before=${reviewedAt}`, "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    sha = out.length > 0 ? out : null;
  } catch {
    sha = null;
  }
  shaCache.set(key, sha);
  return sha;
}

/** Last commit on ANY ref that touched `relPath` at-or-before `reviewedAt` —
 *  the fallback when the file only existed on a feature branch at review
 *  time. Never looks past the review: a later commit may already hold the fix. */
export function commitTouchingAt(workspace: string, relPath: string, reviewedAt: string): string | null {
  if (!reviewedAt || !isSafeRelPath(relPath)) return null;
  try {
    const out = execFileSync(
      "git",
      ["-C", workspace, "log", "--all", "-1", `--before=${reviewedAt}`, "--format=%H", "--", relPath],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** Lexical bound only (the file may no longer exist on disk): a path that
 *  could escape the workspace is never handed to git. */
function isSafeRelPath(relPath: string): boolean {
  return !(relPath === "" || isAbsolute(relPath) || relPath.includes("\0") || relPath.split(/[\\/]/).includes(".."));
}

export function gitFileAt(workspace: string, relPath: string, sha: string): string[] | null {
  if (!isSafeRelPath(relPath)) return null;
  try {
    const content = execFileSync("git", ["-C", workspace, "show", `${sha}:${relPath}`], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return content.split("\n");
  } catch {
    return null;
  }
}

/** Numbered excerpt: the evidence range ±`context`, or the first 40 lines
 *  when the finding names no range. */
export function sliceLines(all: string[], lines: [number, number] | undefined, context: number): string {
  if (!lines) {
    return all.slice(0, 40).map((l, i) => `${String(i + 1).padStart(5)}  ${l}`).join("\n");
  }
  const [a, b] = lines;
  const from = Math.max(1, a - context);
  const to = Math.min(all.length, b + context);
  const out: string[] = [];
  for (let n = from; n <= to; n++) {
    const marker = n >= a && n <= b ? "▶" : " ";
    out.push(`${marker}${String(n).padStart(5)}  ${all[n - 1] ?? ""}`);
  }
  return out.join("\n");
}

function rangeNote(lines: [number, number] | undefined, context: number): string {
  return lines ? `lines ${lines[0]}–${lines[1]} (±${context})` : "first 40 lines";
}

/** Both sides of the evidence; either may be null (reason in `missing`). */
export function resolveEvidence(
  workspace: string,
  evidencePath: string,
  lines: [number, number] | undefined,
  reviewedAt: string,
  context: number,
): ResolvedEvidence {
  const range = rangeNote(lines, context);
  const missing: string[] = [];
  if (!isAbsolute(workspace)) {
    return { atCheckpoint: null, current: null, missing: [`workspace unknown (${workspace || "no cwd recorded"})`] };
  }

  let atCheckpoint: ResolvedEvidence["atCheckpoint"] = null;
  const sha = commitAt(workspace, reviewedAt);
  const onHead = sha === null ? null : gitFileAt(workspace, evidencePath, sha);
  if (sha !== null && onHead !== null) {
    atCheckpoint = {
      sha,
      snippet: sliceLines(onHead, lines, context),
      note: `${range} as of commit ${sha.slice(0, 8)} (last commit at-or-before the review)`,
    };
  } else {
    // Not on the HEAD line yet: a feature branch may have it.
    const branchSha = commitTouchingAt(workspace, evidencePath, reviewedAt);
    const onBranch = branchSha === null ? null : gitFileAt(workspace, evidencePath, branchSha);
    if (branchSha !== null && onBranch !== null) {
      atCheckpoint = {
        sha: branchSha,
        snippet: sliceLines(onBranch, lines, context),
        note: `${range} as of commit ${branchSha.slice(0, 8)} (last commit on any branch touching the file before the review)`,
      };
    } else if (sha === null) {
      missing.push(reviewedAt ? `no git commit at-or-before ${reviewedAt} in ${workspace}` : "review time unknown");
    } else {
      missing.push(`${evidencePath} not committed anywhere before the review (uncommitted at review time?)`);
    }
  }

  let current: ResolvedSnippet | null = null;
  const abs = resolveWithinWorkspace(workspace, evidencePath);
  if (abs === null) missing.push(`${evidencePath} not found within ${workspace} (deleted, moved, or outside it)`);
  else {
    try {
      current = { snippet: sliceLines(readFileSync(abs, "utf8").split("\n"), lines, context), note: `${range} from the current file` };
    } catch {
      missing.push(`${evidencePath} not readable in the current tree`);
    }
  }
  return { atCheckpoint, current, missing };
}

/** Single best snippet: the review-time commit, else the current file with a
 *  loud drift warning. What `eval:label-sheet` has always shown. */
export function resolveSnippet(
  workspace: string,
  evidencePath: string,
  lines: [number, number] | undefined,
  reviewedAt: string,
  context: number,
): { snippet: string | null; note: string } {
  const ev = resolveEvidence(workspace, evidencePath, lines, reviewedAt, context);
  if (ev.atCheckpoint) return { snippet: ev.atCheckpoint.snippet, note: ev.atCheckpoint.note };
  if (ev.current) return { snippet: ev.current.snippet, note: `${ev.current.note} — ⚠ may have drifted since review` };
  return { snippet: null, note: ev.missing.join("; ") };
}

/**
 * Rewrite a recorded workspace through `from=to` prefix maps (first match
 * wins, whole path segments only). Lets the exporter read a clone instead of
 * the checkout the recording ran in — e.g. never the production checkout.
 */
export function mapWorkspace(cwd: string, maps: ReadonlyArray<[string, string]>): string {
  for (const [from, to] of maps) {
    const f = from.replace(/\/+$/, "");
    if (cwd === f || cwd.startsWith(f + "/")) return to.replace(/\/+$/, "") + cwd.slice(f.length);
  }
  return cwd;
}
