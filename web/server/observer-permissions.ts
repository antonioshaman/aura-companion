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

/**
 * Per-spawn boot canary for the Claude observer half. Inspects the argv
 * array that is about to be passed to `Bun.spawn` and throws if it does
 * not carry `--disallowedTools` immediately followed by `"Bash"`.
 *
 * Defense-in-depth: a future regression that silently disables
 * {@link getObserverSpawnOverrides} OR that re-routes spawn through a
 * code path that bypasses {@link applyCouncilObserverSpawnConfig} would
 * leave the OBSERVER_DISALLOWED_TOOLS list (which includes Bash) absent
 * from the constructed argv. The module-load canary at
 * {@link assertObserverToolPolicyConsistent} catches list-shape drift but
 * cannot catch a regression in the spawn pipeline that never invokes the
 * config helper.
 *
 * Why pick `Bash` specifically: the highest-impact tool in the deny set —
 * a regression that loses Bash loses arbitrary shell execution under the
 * orchestrator's uid + cwd. Any production code path that succeeds in
 * passing this canary AND fails to add the other tools is then a
 * narrower (still fixable) bug, not RCE-class.
 */
export function assertObserverClaudeArgvSafe(argv: readonly string[]): void {
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === "--disallowedTools" && argv[i + 1] === "Bash") return;
  }
  throw new Error(
    "observer-permissions: refusing to spawn observer-role Claude session without `--disallowedTools Bash` in argv (EC-1 boot canary)",
  );
}

/**
 * Per-spawn boot canary for the Codex observer half. The Codex CLI has
 * no `--disallowedTools` argv equivalent — observer tool restrictions
 * land via the system prompt body that
 * {@link applyCouncilObserverSpawnConfig} composes from the workspace
 * `.council/prompts/observer-system.md` artifact. Verifies that the
 * `options.systemPrompt` field is a non-empty string before the Bun.spawn
 * call site so a regression that drops the prompt body cannot produce a
 * default-tooled Codex observer.
 */
export function assertObserverCodexSystemPromptSet(systemPrompt: unknown): void {
  if (typeof systemPrompt !== "string" || systemPrompt.trim().length === 0) {
    throw new Error(
      "observer-permissions: refusing to spawn observer-role Codex session without a non-empty system prompt (EC-1 boot canary)",
    );
  }
}
