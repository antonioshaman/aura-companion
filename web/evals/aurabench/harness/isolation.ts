/**
 * Isolation proof for the naked Claude variant (P6/D2). The cell's
 * `system/init` stream-json frame is the evidence: under a clean
 * `CLAUDE_CONFIG_DIR` the agent must see none of the user's skills, no
 * non-builtin plugins, no MCP servers, no hooks firing, and an auto-memory
 * path outside the real `~/.claude`. The evidence (not just the verdict) is
 * stored in the cell record so the report can show it.
 *
 * Also the workspace scrub list — the Aura files removed from a naked
 * worktree — lives here so naked-Claude and naked-Codex share one definition.
 *
 * Pure. Firewall-clean.
 */

/** Repo-relative paths deleted from a naked worktree before the agent runs. */
export const NAKED_SCRUB_PATHS = [
  "CLAUDE.md",
  "AGENTS.md",
  ".agents",
  ".council",
  ".claude",
  ".codex",
  ".learnings",
  "SELF-LEARNING.md",
  "web/CLAUDE.md",
  "web/AGENTS.md",
] as const;

export interface IsolationVerdict {
  isolated: boolean;
  violations: string[];
  evidence: Record<string, unknown>;
}

type Obj = Record<string, unknown>;
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

export function checkNakedClaudeIsolation(
  init: Obj | null,
  opts: { userSkillNames: readonly string[]; realClaudeDir: string; hookEvents: number },
): IsolationVerdict {
  if (!init) {
    return { isolated: false, violations: ["no system/init frame (cannot prove isolation)"], evidence: {} };
  }
  const violations: string[] = [];
  const skills = strings(init.skills);
  const userSkills = new Set(opts.userSkillNames);
  const leakedSkills = skills.filter((s) => userSkills.has(s));
  if (leakedSkills.length) violations.push(`user skills visible: ${leakedSkills.join(", ")}`);

  const plugins = Array.isArray(init.plugins) ? (init.plugins as unknown[]) : [];
  const nonBuiltin = plugins.filter((p) => !(typeof p === "object" && p !== null && (p as Obj).path === "builtin"));
  if (nonBuiltin.length) violations.push(`non-builtin plugins: ${JSON.stringify(nonBuiltin).slice(0, 200)}`);

  const mcp = Array.isArray(init.mcp_servers) ? init.mcp_servers : [];
  if (mcp.length) violations.push(`MCP servers configured: ${mcp.length}`);

  if (opts.hookEvents > 0) violations.push(`${opts.hookEvents} hook event(s) fired`);

  const memoryPaths = typeof init.memory_paths === "object" && init.memory_paths !== null ? init.memory_paths : {};
  const realDir = opts.realClaudeDir.replace(/\/+$/, "") + "/";
  const leakedMemory = Object.values(memoryPaths as Obj).filter((p) => typeof p === "string" && p.startsWith(realDir));
  if (leakedMemory.length) violations.push("auto-memory path points into the real ~/.claude");

  return {
    isolated: violations.length === 0,
    violations,
    evidence: {
      claude_code_version: init.claude_code_version ?? null,
      model: init.model ?? null,
      skills,
      plugins,
      mcp_servers: mcp,
      agents: strings(init.agents),
      memory_paths: memoryPaths,
      hook_events: opts.hookEvents,
      apiKeySource: init.apiKeySource ?? null,
    },
  };
}
