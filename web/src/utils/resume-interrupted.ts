/**
 * Recognise the result frame Claude Code emits to close a turn that was cut
 * off before it finished — by a process restart OR by the user pressing Stop.
 *
 * The frame does not say which: the same `[ede_diagnostic]` shape is emitted
 * (a) by `--resume` closing a turn a restart killed, and (b) directly after an
 * `interrupt` control_request when the user stops a running tool call. The
 * label therefore names the effect ("turn interrupted"), not a guessed cause.
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

/** Cause-neutral on purpose — the frame cannot distinguish restart from Stop. */
export const RESUME_INTERRUPTED_LABEL = "Turn interrupted (stopped or restarted)";

const EDE_DIAGNOSTIC_PREFIX = "[ede_diagnostic]";

export interface ResultFrameLike {
  is_error?: boolean;
  terminal_reason?: string;
  errors?: string[];
}

/** Terminal reasons the CLI uses for a cut-off turn: `aborted_streaming`
 *  (mid-text; the `--resume` bookkeeping frame after a restart) and
 *  `aborted_tools` (mid-tool-call). The `aborted_tools` frame observed live
 *  2026-10-15 (session 40f03a1e,
 *  `[ede_diagnostic] … stop_reason=tool_use`) was NOT a restart: the recording
 *  shows it 30 ms after the browser's `interrupt` control_request, i.e. the
 *  user pressed Stop during a running Bash tool. A restart mid-tool-call can
 *  produce the same frame on resume. Either way it is the closing bookkeeping
 *  of an interrupted turn, not a failure — same muted rendering, with a
 *  cause-neutral label. Everything else stays fail-closed toward "real error". */
const ABORTED_TERMINAL_REASONS = new Set(["aborted_streaming", "aborted_tools"]);

export function isResumeInterruptedResult(r: ResultFrameLike | null | undefined): boolean {
  if (!r || r.is_error !== true) return false;
  if (typeof r.terminal_reason !== "string" || !ABORTED_TERMINAL_REASONS.has(r.terminal_reason)) return false;
  const errors = r.errors;
  if (!Array.isArray(errors) || errors.length === 0) return false;
  return errors.every((e) => typeof e === "string" && e.startsWith(EDE_DIAGNOSTIC_PREFIX));
}
