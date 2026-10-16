/**
 * Pre-spawn substitution for models that trigger known upstream CLI bugs.
 *
 * When a specific `--model <id>` argument is known to break the Claude CLI's
 * stdout stream-json emitter (jsonl continues, stdout dead — see
 * `feedback_claude_cli_opus5_stdout_dead_jsonl_alive.md` and PR #175's
 * silent-stdio watchdog), we substitute the model at spawn time so the user
 * never lands in the broken state. The watchdog would otherwise kill and
 * relaunch endlessly on the same broken model — a real production incident
 * (2026-09-09, aura-companion Silent Cliff orchestrator).
 *
 * Substitution is a workaround, not a fix. Each entry MUST document:
 *   - Which upstream CLI version(s) exhibit the bug.
 *   - When to remove the entry (upstream fix landed, feature flag flipped).
 * When the upstream bug is fixed, delete the entry — do not leave stale
 * substitutions in place, because the user's explicit model choice
 * eventually stops being honoured for reasons they can't see.
 *
 * Substitutions apply at BOTH `launch` (fresh session) and `relaunch`
 * (keepalive recovery, model-fallback path). They mutate the persisted
 * session model, so the next spawn on the same session uses the
 * substitute automatically.
 */

/** One entry in the substitution table. Explicit shape — do not shortcut. */
export interface BrokenModelSubstitution {
  /** The `--model` id the CLI trips on. Exact match, case-sensitive. */
  readonly from: string;
  /** The `--model` id we substitute in. Must be a real Claude CLI-accepted id. */
  readonly to: string;
  /**
   * Short human string explaining why. Surfaces in the browser toast so
   * the user can distinguish "server auto-downgraded me" from "server
   * silently ignored my choice".
   */
  readonly reason: string;
}

/**
 * Closed substitution table. Each entry is a workaround for a specific,
 * observed upstream bug. The list is kept small on purpose — adding an
 * entry should be a deliberate act tied to a known incident, not a
 * defensive "just in case" default.
 *
 * EMPTY since 2026-10-16. The three former entries (`claude-opus-5`,
 * `claude-fable-5-1`, `claude-opus-4-7` → `claude-opus-4-8`) worked around
 * the CLI 2.1.265/2.1.266 stdout stream-json emit regression. Re-probed on
 * the prod box with CLI 2.1.283, in the exact transport Aura uses
 * (`-p --input-format stream-json --output-format stream-json --verbose`,
 * two consecutive user turns): all three models emitted `system.init`, both
 * `assistant` frames and both `result` frames on stdout. The upstream bug is
 * fixed, so keeping the rewrite only silently downgraded users who picked
 * Opus 5 (and the dropdown kept offering it). The silent-stdio watchdog +
 * recurring-silence rotation remain the safety net if it regresses.
 *
 * Every consumer reads THIS table (single source of truth): the spawn /
 * relaunch rewrite in `cli-launcher.ts`, the fallback chain, and — via
 * `lookupModel` in `model-registry.ts` — both the `set_model` pre-send gate
 * and the dropdown's status overlay (a listed model renders as `blocked`
 * with `replacement = to`, so the picker never offers what spawn rewrites).
 */
export const BROKEN_MODEL_SUBSTITUTIONS: readonly BrokenModelSubstitution[] = [];

/**
 * Return the substitution entry for `model`, or `null` if the model is
 * not in the broken list. `null` means "spawn as requested, no override".
 *
 * The current CLI version is NOT consulted — the substitutions here are
 * intentionally conservative and remain in force until an operator
 * removes the entry from the table. A version-conditional gate is more
 * code (probing CLI version at spawn time, parsing semver) for
 * marginal value: leaving a workaround in place through the CLI patch
 * cycle costs us one user-visible model downgrade until we notice; the
 * alternative — a runtime probe that silently disables the workaround
 * against an older CLI on some hosts — is worse.
 */
export function resolveModelSubstitution(
  model: string | undefined | null,
  table: readonly BrokenModelSubstitution[] = BROKEN_MODEL_SUBSTITUTIONS,
): BrokenModelSubstitution | null {
  if (!model) return null;
  return table.find((s) => s.from === model) ?? null;
}
