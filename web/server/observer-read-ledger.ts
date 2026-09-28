/**
 * Host-observed observer reads (P3/CONV-HONEST).
 *
 * The convergence counter used to fold every STOP-free review as a clean
 * cycle — including reviews of the spawn checkpoint (no changed files) and
 * reviews where the observer never opened a single changed file. Three such
 * "clean" reviews flipped a pair to "ready to ship" while nothing had been
 * looked at.
 *
 * This ledger records, per observer session, the tool calls the observer made
 * since the wake for a checkpoint was dispatched. It is fed from the same
 * `message:assistant` frames the reply capture reads, so it is the HOST's view
 * of what the observer did — never the model's own account. At review time
 * {@link countArtifactsRead} intersects those calls with the checkpoint's
 * changed files; a clean review with zero reads is not counted.
 *
 * Provider-agnostic: the Claude bridge emits `Read` / `Grep` / `Bash`
 * tool_use blocks; the Codex adapter maps every `commandExecution` to a
 * `Bash` tool_use with the command string, so both land in the same shape.
 *
 * What counts as reading a changed file `p` (workspace-relative):
 *   - `Read` / `NotebookRead` whose path resolves to `p`;
 *   - `Grep` whose `path` resolves to `p` (a directory grep does not count);
 *   - `Bash` whose command names `p` (relative or absolute) as a token;
 *   - `Bash` running a bare `git diff` / `git show` (no pathspec, no
 *     `--stat`/`--name-only`-style summary flag): it prints every change.
 * Globs, directory listings and file-name-only summaries are not reads.
 */

import { isAbsolute, resolve } from "node:path";

export interface ObserverToolTouch {
  name: string;
  /** Resolved file argument (Read / NotebookRead / Grep path), if any. */
  path?: string;
  /** Raw shell command (Bash), if any. */
  command?: string;
}

type ToolUseBlock = { type?: unknown; name?: unknown; input?: unknown };

/** Pull tool_use touches out of a `message:assistant` frame (any provider). */
export function extractToolTouches(message: unknown): ObserverToolTouch[] {
  if (typeof message !== "object" || message === null) return [];
  const m = message as { type?: unknown; message?: { content?: unknown } };
  if (m.type !== "assistant" || !m.message || !Array.isArray(m.message.content)) return [];
  const out: ObserverToolTouch[] = [];
  for (const block of m.message.content as ToolUseBlock[]) {
    if (block?.type !== "tool_use" || typeof block.name !== "string") continue;
    const input = (typeof block.input === "object" && block.input !== null ? block.input : {}) as Record<string, unknown>;
    const touch: ObserverToolTouch = { name: block.name };
    const path = input.file_path ?? input.notebook_path ?? input.path;
    if (typeof path === "string" && path.length > 0) touch.path = path;
    if (typeof input.command === "string" && input.command.length > 0) touch.command = input.command;
    out.push(touch);
  }
  return out;
}

const FILE_READ_TOOLS = new Set(["Read", "NotebookRead", "Grep"]);
const GIT_SUMMARY_FLAGS = /--(?:stat|shortstat|numstat|name-only|name-status|dirstat|summary)\b/;
const BARE_GIT_DIFF = /(?:^|[;&|(]\s*|\s)git\s+(?:-C\s+\S+\s+)?(?:diff|show)\b([^;&|]*)/g;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `true` when `command` names `target` as a whole path token. */
function commandNamesPath(command: string, target: string): boolean {
  // Boundaries: start/whitespace/quote/`=`/`:`/`./` before; end/whitespace/
  // quote/`:` (line suffix, e.g. `file.ts:12`) or shell punctuation after.
  const re = new RegExp(`(?:^|[\\s'"=:(]|\\./)${escapeRegExp(target)}(?=$|[\\s'":;&|)<>])`);
  return re.test(command);
}

/** `true` when `command` runs `git diff`/`git show` over all changes. */
function commandIsBareGitDiff(command: string): boolean {
  for (const match of command.matchAll(BARE_GIT_DIFF)) {
    const args = match[1] ?? "";
    if (GIT_SUMMARY_FLAGS.test(args)) continue;
    // A `--` pathspec restricts the diff; named paths are matched separately.
    if (/(?:^|\s)--(?:\s|$)/.test(args)) continue;
    return true;
  }
  return false;
}

/**
 * How many of `changedFiles` (workspace-relative) the recorded touches read.
 * Pure — the unit the convergence gate and its tests share.
 */
export function countArtifactsRead(
  touches: readonly ObserverToolTouch[],
  changedFiles: Iterable<string>,
  workspaceRoot: string,
): number {
  const changed = [...new Set(changedFiles)].filter((p) => p.length > 0);
  if (changed.length === 0 || touches.length === 0) return 0;
  const read = new Set<string>();
  for (const t of touches) {
    if (t.path !== undefined && FILE_READ_TOOLS.has(t.name)) {
      const abs = isAbsolute(t.path) ? resolve(t.path) : resolve(workspaceRoot, t.path);
      for (const p of changed) if (resolve(workspaceRoot, p) === abs) read.add(p);
    }
    if (t.command !== undefined) {
      if (commandIsBareGitDiff(t.command)) {
        for (const p of changed) read.add(p);
        continue;
      }
      for (const p of changed) {
        if (commandNamesPath(t.command, p) || commandNamesPath(t.command, resolve(workspaceRoot, p))) read.add(p);
      }
    }
  }
  return read.size;
}

interface LedgerSlot {
  checkpointId: string;
  touches: ObserverToolTouch[];
}

/** Upper bound on touches kept per wake — a runaway turn can't grow memory. */
export const MAX_TOUCHES_PER_WAKE = 2000;

/**
 * Per-observer-session tool-call ledger, scoped to the checkpoint whose wake
 * was dispatched last. A newer wake replaces the slot; the review handler
 * asks for the touches of ITS checkpoint and gets none if the slot moved on
 * (or the server restarted) — an unverifiable review is never counted.
 */
export class ObserverReadLedger {
  private readonly slots = new Map<string, LedgerSlot>();

  begin(observerSessionId: string, checkpointId: string): void {
    this.slots.set(observerSessionId, { checkpointId, touches: [] });
  }

  /** Cheap no-op for every session without a dispatched wake. */
  onAssistant(sessionId: string, message: unknown): void {
    const slot = this.slots.get(sessionId);
    if (!slot) return;
    for (const t of extractToolTouches(message)) {
      if (slot.touches.length >= MAX_TOUCHES_PER_WAKE) return;
      slot.touches.push(t);
    }
  }

  touchesFor(observerSessionId: string, checkpointId: string): readonly ObserverToolTouch[] {
    const slot = this.slots.get(observerSessionId);
    return slot && slot.checkpointId === checkpointId ? slot.touches : [];
  }

  forget(sessionId: string): void {
    this.slots.delete(sessionId);
  }
}
