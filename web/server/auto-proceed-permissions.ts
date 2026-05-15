/**
 * Auto-proceed synthetic-frame permissions denylist.
 *
 * PLAN-aura-orchestrator-idle-auto-proceed Task 11.5: when the
 * orchestrator's idle-timer fires a synthetic `[auto-proceed:idle-timeout]`
 * frame to nudge a stalled session, the resulting CLI tool uses should be
 * **prohibited from invoking publish-to-others operations** — `git push`,
 * `git commit`, `gh pr create`, `gh pr merge`. These commands all
 * communicate outcomes to other humans / shared remotes; the user being
 * AFK (the synthetic's precondition) means there's no chance to review
 * before publication. (Council Review #10 — prose was previously
 * "destructive" but the list is publish-only; "destructive" implies
 * `rm -rf` shapes that are NOT on this list and are out of scope.)
 *
 * Rationale: an auto-proceed nudge is an unattended-operation signal —
 * the user is AFK by design (the synthetic only fires after a
 * configurable idle-timeout). Production-side operations that publish
 * code or open PRs are too consequential to run without affirmative
 * user presence. The denylist is a behavioural guardrail; the user can
 * always engage manually to perform the action.
 *
 * The gate consumer (claude-adapter's `can_use_tool` handler — wired in
 * Task 11.8) reads {@link IdleTimerManager.isSyntheticTurnInFlight} for
 * the sticky-token check before consulting the denylist. The combination
 * is the race-defence: if the user types `git push` mid-synthetic-turn,
 * the gate still denies because the synthetic's tool-use window is open.
 *
 * Sister module: `observer-permissions.ts` (Council Mode observer-side
 * tool allow/deny lists, applied at spawn argv via
 * `applyCouncilObserverSpawnConfig`). The observer permissions module
 * is permission-mode-level (gates what the observer-half CLI can be
 * invoked WITH); this module is per-tool-use-level (gates what an
 * already-spawned orchestrator can DO).
 */

/**
 * Bash-style denylist entries — semantic shape `<ToolName>:<commandPrefix>`.
 *
 * Each `"Bash:"`-prefixed entry encodes a prefix-match against the Bash
 * tool's `command` input. Empty inputs / non-Bash tools never match.
 *
 * Limitations (documented for honesty, not as bugs):
 *   - Prefix-match only; doesn't catch `bash -c "git push"`, `eval ...`,
 *     command substitution (`$(git push)`, `` `git push` ``), shell
 *     chaining (`; git push`, `&& git push`, etc.). A determined CLI
 *     could route around this with one extra step. The denylist is a
 *     behavioural guardrail, not a security boundary — the user can
 *     yank the synthetic feature entirely via the auto-proceed config
 *     boundary in `auto-proceed-config-validator.ts` if precision
 *     matters.
 *   - Determined Unicode-evasion attacks (homoglyph substitutions for
 *     letters in "git" or "push") would not match the literal prefix.
 *     The denylist is deliberately simple to keep the gate fast — a
 *     bash AST parser is out of scope. Note: `String.prototype.trimStart`
 *     DOES strip all Unicode whitespace (incl. NBSP U+00A0) per ECMA-262,
 *     so leading-whitespace evasion via NBSP / TAB / etc. does NOT slip
 *     past — only homoglyphs or shell indirection do.
 *
 * Add to this set only if the new entry passes the bar:
 *   - Operation is consequential and visible to others (push, publish,
 *     transition Linear, send Slack, etc.);
 *   - User would reasonably expect to be in the loop, not AFK;
 *   - The command's leading-prefix shape is stable enough that a literal
 *     match is meaningful.
 */
export const SYNTHETIC_FRAME_TOOL_DENYLIST: ReadonlySet<string> = new Set([
  "Bash:git push",
  "Bash:git commit",
  "Bash:gh pr create",
  "Bash:gh pr merge",
]);

/**
 * Predicate: should this tool-use be denied when a synthetic
 * auto-proceed turn is in-flight on the calling session?
 *
 * The caller (claude-adapter's `can_use_tool` handler) consults this
 * AFTER confirming `idleTimerManager.isSyntheticTurnInFlight(sessionId)`
 * is true; if the synthetic turn is NOT in flight, the denylist does
 * not apply at all (user-typed sessions face only the normal Claude
 * permission gate).
 *
 * @param toolName  e.g. `"Bash"`, `"Read"`, `"Edit"`. Matched literally.
 * @param toolInput The `input` object the CLI proposes to invoke the
 *                  tool with. For `Bash` the relevant field is
 *                  `{command: string}`. Other tools may carry other
 *                  shapes; current denylist only encodes `Bash:` prefix
 *                  patterns and returns false for non-Bash.
 * @returns         True iff the proposed tool use matches any denylist
 *                  entry. Caller should respond to the CLI with
 *                  `{behavior:"deny", message: ...}`.
 */
export function isToolUseDeniedForSynthetic(toolName: unknown, toolInput: unknown): boolean {
  // Council Review #11 — fail-CLOSED on non-string toolName. The TypeScript
  // signature has historically been `toolName: string`, but the wire boundary
  // (NDJSON from the CLI) is `unknown` by construction — a malformed frame
  // could send a number, null, or object. Treat any non-string as a denied
  // operation: the gate is a behavioural guardrail, and the safe default
  // when type-narrowing fails is "deny, ask the user manually."
  if (typeof toolName !== "string") return true;
  if (toolName === "Bash") {
    if (typeof toolInput !== "object" || toolInput === null) return false;
    const command = (toolInput as { command?: unknown }).command;
    if (typeof command !== "string") return false;
    // ASCII leading-whitespace normalisation + Council Review #15 ZW-class
    // stripping. The ZW class (U+200B ZWSP, U+200C ZWNJ, U+200D ZWJ,
    // U+FEFF ZWNBSP/BOM, U+2060 WORD JOINER) renders invisible in editors
    // and many terminals — embedded in `g​it push` it would bypass
    // a literal `startsWith("git push")` check while still rendering and
    // (in shells that tolerate it) potentially executing as `git push`.
    // Strip pre-match so the prefix comparison sees the canonical form.
    const cleaned = command.replace(/[\u200B\u200C\u200D\uFEFF\u2060]/g, "");
    const trimmed = cleaned.trimStart();
    for (const entry of SYNTHETIC_FRAME_TOOL_DENYLIST) {
      if (!entry.startsWith("Bash:")) continue;
      const prefix = entry.slice("Bash:".length);
      if (trimmed.startsWith(prefix)) return true;
    }
  }
  return false;
}

/**
 * Human-readable rejection message produced when the gate denies a tool
 * use. Surfaced in the `can_use_tool` `{behavior:"deny", message: ...}`
 * response so the CLI's user-visible chat thread shows WHY the tool was
 * blocked. Keep concise — appears inline in the CLI's tool-use feedback.
 */
export function denialMessageForSynthetic(toolName: unknown, toolInput: unknown): string {
  if (toolName === "Bash" && typeof toolInput === "object" && toolInput !== null) {
    const command = (toolInput as { command?: unknown }).command;
    if (typeof command === "string") {
      // Council Review #14 — strip backticks from the embedded command
      // head. The denial message uses a markdown code span (`` `...` ``)
      // to wrap the rejected command for readability in the CLI's chat
      // surface; if `command` itself contains a backtick, the span breaks
      // and downstream markdown renderers misinterpret the rest of the
      // message. Replace with a Unicode look-alike (U+2018) which renders
      // safely in any context.
      const head = command.trimStart().split("\n", 1)[0]?.slice(0, 80).replace(/`/g, "‘") ?? "";
      return `Auto-proceed synthetic frame may not invoke publish-to-others operations (denied: \`${head}\`). Engage manually to push / commit / open PRs.`;
    }
  }
  return "Auto-proceed synthetic frame may not invoke this operation. Engage manually to proceed.";
}
