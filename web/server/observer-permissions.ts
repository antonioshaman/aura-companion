/**
 * Tool-set restrictions for the observer half of a Council Mode pair.
 *
 * The observer reads artifacts and writes review files; it must never
 * gain the orchestrator's full agent toolkit. Same-uid same-workspace
 * pairing means a prompt-injected observer (Hunt P5 — "shrink the
 * attack surface") could otherwise `rm -rf`, exfiltrate via network,
 * or invoke unscoped MCP servers.
 *
 * Symmetric env between halves is fine; symmetric tool access is not.
 *
 * The allowlist and denylist are intentionally redundant: omitting a
 * tool from {@link OBSERVER_ALLOWED_TOOLS} already denies it, but the
 * explicit {@link OBSERVER_DISALLOWED_TOOLS} list acts as a static-grep
 * canary — a future change accidentally appending "Bash" to allowed
 * will surface a denylist conflict instead of silently widening the
 * surface.
 */

/**
 * Tools the observer is allowed to invoke. Curated to exactly what's
 * needed to read artifacts, navigate the codebase, and write review
 * files (further bounded by {@link isObserverWriteAllowed}).
 */
export const OBSERVER_ALLOWED_TOOLS: readonly string[] = Object.freeze([
  "Read",
  "Grep",
  "Glob",
  "Write",
  "Edit",
  "TodoWrite",
] as const);

/**
 * Tools that must never reach the observer. Listed explicitly so a
 * regression that adds them to {@link OBSERVER_ALLOWED_TOOLS} fails
 * the {@link assertObserverToolPolicyConsistent} canary at boot.
 */
export const OBSERVER_DISALLOWED_TOOLS: readonly string[] = Object.freeze([
  "Bash",
  "BashOutput",
  "KillShell",
  "WebFetch",
  "WebSearch",
  "NotebookEdit",
] as const);

/**
 * SDK permission mode the observer subprocess runs under. `default`
 * forces tool-by-tool approval prompts — Council Mode wires these
 * straight to deny so the observer cannot escalate at runtime.
 */
export const OBSERVER_PERMISSION_MODE = "default" as const;

/** Spawn-time overrides applied to the observer half. */
export interface ObserverSpawnOverrides {
  allowedTools: string[];
  disallowedTools: string[];
  permissionMode: string;
}

/**
 * Build the spawn overrides for the observer subprocess. Returns
 * fresh array copies so callers cannot mutate the frozen source lists.
 */
export function getObserverSpawnOverrides(): ObserverSpawnOverrides {
  return {
    allowedTools: [...OBSERVER_ALLOWED_TOOLS],
    disallowedTools: [...OBSERVER_DISALLOWED_TOOLS],
    permissionMode: OBSERVER_PERMISSION_MODE,
  };
}

/**
 * Boot-time canary: the allow and deny lists must be disjoint. Throws
 * if they intersect — call from server startup so an accidentally
 * widened allowlist surfaces immediately, not silently in production.
 */
export function assertObserverToolPolicyConsistent(): void {
  const allowed = new Set(OBSERVER_ALLOWED_TOOLS);
  const intersect = OBSERVER_DISALLOWED_TOOLS.filter((t) => allowed.has(t));
  if (intersect.length > 0) {
    throw new Error(
      `observer-permissions: tool(s) appear in both allow and deny lists: ${intersect.join(", ")}`,
    );
  }
}
