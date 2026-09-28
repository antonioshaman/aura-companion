/**
 * Recognise the result frame Claude Code emits to close a turn that was cut
 * off by a process restart.
 *
 * When the server relaunches a Claude session with `--resume` (server restart,
 * auto-relaunch, keepalive), the CLI replays the transcript, finds the last
 * turn never finished, and closes it right after `system/init` with a
 * ~100–500 ms result frame:
 *
 *   { subtype: "error_during_execution", is_error: true,
 *     terminal_reason: "aborted_streaming", stop_reason: null,
 *     errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null"] }
 *
 * That is bookkeeping, not a failure of the current work — every one of the 84
 * such frames in the local recordings has exactly this shape and follows
 * `system/init` (or `session_ack`) + the replayed user frame. The chat used to
 * render each as "Error: [ede_diagnostic] …", so a long-lived session collects
 * dozens of them.
 *
 * The match is deliberately narrow (fail-closed toward "real error"): the
 * `aborted_streaming` terminal reason AND a non-empty `errors` list made only
 * of `[ede_diagnostic]` lines. Any other error text — even with the same
 * terminal reason — keeps the red error rendering.
 *
 * Codex: the adapter synthesises its result frames (`handleTurnCompleted` in
 * `server/codex-adapter.ts`) without `errors` or `terminal_reason`, and the
 * chat renders no error line for a result without `errors`, so there is no
 * Codex counterpart of this noise. The predicate never matches a Codex frame.
 */

export const RESUME_INTERRUPTED_LABEL = "Previous turn was interrupted by a restart";

const EDE_DIAGNOSTIC_PREFIX = "[ede_diagnostic]";

export interface ResultFrameLike {
  is_error?: boolean;
  terminal_reason?: string;
  errors?: string[];
}

export function isResumeInterruptedResult(r: ResultFrameLike | null | undefined): boolean {
  if (!r || r.is_error !== true) return false;
  if (r.terminal_reason !== "aborted_streaming") return false;
  const errors = r.errors;
  if (!Array.isArray(errors) || errors.length === 0) return false;
  return errors.every((e) => typeof e === "string" && e.startsWith(EDE_DIAGNOSTIC_PREFIX));
}
