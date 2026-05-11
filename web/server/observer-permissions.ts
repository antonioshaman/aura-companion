/**
 * Tool-set restrictions for the observer half of a Council Mode pair.
 *
 * The observer reads artifacts and writes a single review file per checkpoint;
 * it must never gain the orchestrator's full agent toolkit. Same-uid same-
 * workspace pairing means a prompt-injected observer (Hunt P5 — "shrink the
 * attack surface") could otherwise `rm -rf`, exfiltrate via network, or invoke
 * unscoped MCP servers.
 *
 * Symmetric env between halves is fine; symmetric tool access is not.
 *
 * The allowlist and denylist are intentionally redundant: omitting a tool
 * from {@link OBSERVER_ALLOWED_TOOLS} already denies it, but the explicit
 * {@link OBSERVER_DISALLOWED_TOOLS} list acts as a static-grep canary — a
 * future change accidentally appending "Bash" to allowed will surface a
 * denylist conflict via {@link findObserverToolPolicyIntersection} at boot.
 */

/**
 * Tools the observer is allowed to invoke. Curated to read-only operations
 * plus a single Write (the review file). Edit and TodoWrite are explicitly
 * out — the observer's job is one fresh write per checkpoint, not amending
 * prior artifacts and not maintaining agentic plans.
 */
export const OBSERVER_ALLOWED_TOOLS: readonly string[] = Object.freeze([
  "Read",
  "Grep",
  "Glob",
  "Write",
] as const);

/**
 * Tools that must never reach the observer. Listed explicitly so a
 * regression that adds them to {@link OBSERVER_ALLOWED_TOOLS} fails
 * the boot-time consistency check.
 */
export const OBSERVER_DISALLOWED_TOOLS: readonly string[] = Object.freeze([
  "Bash",
  "BashOutput",
  "KillShell",
  "WebFetch",
  "WebSearch",
  "NotebookEdit",
  "Edit",
  "MultiEdit",
  "TodoWrite",
] as const);

export const OBSERVER_PERMISSION_MODE = "default" as const;

export interface ObserverSpawnOverrides {
  allowedTools: string[];
  disallowedTools: string[];
  permissionMode: string;
}

/**
 * Build the spawn overrides for the observer subprocess. Returns fresh
 * array copies so callers cannot mutate the frozen source lists.
 */
export function getObserverSpawnOverrides(): ObserverSpawnOverrides {
  return {
    allowedTools: [...OBSERVER_ALLOWED_TOOLS],
    disallowedTools: [...OBSERVER_DISALLOWED_TOOLS],
    permissionMode: OBSERVER_PERMISSION_MODE,
  };
}

/**
 * Pure intersection helper — exported separately from
 * {@link assertObserverToolPolicyConsistent} so callers (and tests) can
 * exercise both the empty-intersection and conflict cases.
 */
export function findObserverToolPolicyIntersection(allowed: readonly string[], disallowed: readonly string[]): string[] {
  const allowedSet = new Set(allowed);
  return disallowed.filter((t) => allowedSet.has(t));
}

/**
 * Boot-time canary. Throws if {@link OBSERVER_ALLOWED_TOOLS} and
 * {@link OBSERVER_DISALLOWED_TOOLS} intersect.
 *
 * Runs once at module load (see below) so even callers that forget to
 * invoke it explicitly get the safety check. Exported for tests and for
 * explicit re-validation after a hot-reload-style config change.
 */
export function assertObserverToolPolicyConsistent(
  allowed: readonly string[] = OBSERVER_ALLOWED_TOOLS,
  disallowed: readonly string[] = OBSERVER_DISALLOWED_TOOLS,
): void {
  const intersect = findObserverToolPolicyIntersection(allowed, disallowed);
  if (intersect.length > 0) {
    throw new Error(
      `observer-permissions: tool(s) appear in both allow and deny lists: ${intersect.join(", ")}`,
    );
  }
}

// Module-load canary — runs once per process. A regression that breaks
// the invariant fails server boot, not "production after the first call".
assertObserverToolPolicyConsistent();
