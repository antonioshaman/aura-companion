/**
 * Recognise the silent-stdio drift-recovery notice the server broadcasts as
 * a generic `{ type: "error", message }` frame when the drift detector finds
 * the backend transcript has fallen behind the CLI's own jsonl file and
 * relaunches the subprocess to recover (see `server/session-recovery.ts`,
 * "silent-stdio drift detected" → `Backend transcript ${N}s behind CLI's
 * jsonl — relaunching to recover.`).
 *
 * This is bookkeeping, not a failure of the current work — the same class
 * of noise as the `--resume` bookkeeping frame recognised by
 * `resume-interrupted.ts`. A long-lived session can collect many of these in
 * a row, so `MessageFeed.tsx` collapses runs of 2+ into a single expandable
 * row instead of showing one muted line per recovery.
 *
 * The match is narrow on purpose (fail-closed toward "treat as a distinct
 * line") — it matches only the single current producer's exact wording, so
 * an unrelated error message that happens to mention "behind" or "jsonl"
 * never gets silently folded into the collapse group.
 */
export function isDriftRecoveryMessage(message: string): boolean {
  return /^Backend transcript \d+s behind CLI's jsonl — relaunching to recover\.$/.test(message);
}
