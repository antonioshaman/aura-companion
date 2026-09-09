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
 * When Claude CLI 2.1.266+ fixes the opus-5 stdout emit bug, delete the
 * `claude-opus-5` entry below.
 */
export const BROKEN_MODEL_SUBSTITUTIONS: readonly BrokenModelSubstitution[] = [
  {
    from: "claude-opus-5",
    to: "claude-opus-4-8",
    // See `feedback_claude_cli_opus5_stdout_dead_jsonl_alive.md` and PR
    // #175 for full trace. Reproduced 2026-09-09 on aura-companion prod:
    // subprocess spawns fine, writes assistant frames to
    // `~/.claude/projects/*.jsonl`, but its stdout stream-json emitter
    // never fires. Same session (`--resume`) works instantly when
    // respawned with `--model claude-opus-4-8`.
    reason: "Claude CLI 2.1.265 does not emit opus-5 responses on stdout (jsonl still writes) — auto-downgraded to Opus 4.8 until upstream fix",
  },
];

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
export function resolveModelSubstitution(model: string | undefined | null): BrokenModelSubstitution | null {
  if (!model) return null;
  return BROKEN_MODEL_SUBSTITUTIONS.find((s) => s.from === model) ?? null;
}
