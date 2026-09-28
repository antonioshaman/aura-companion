/**
 * Isolation proof for the naked Claude variant (P6/D2). The cell's
 * `system/init` stream-json frame is the evidence: under a clean
 * `CLAUDE_CONFIG_DIR` the agent must see none of the user's skills, none of
 * the Aura repo's own project skills (`.claude/skills`, `.agents/skills` —
 * scrubbed from the cell, so seeing one means the CLI read another checkout),
 * no non-builtin plugins, no MCP servers, no hooks firing, and an auto-memory
 * path outside the real `~/.claude` whose project key is the cell checkout
 * itself (a different key means the CLI resolved the project elsewhere — the
 * pilot's linked-worktree leak). The evidence (not just the verdict) is
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
  opts: {
    userSkillNames: readonly string[];
    /** Skills shipped by the Aura repo itself; scrubbed, so never legitimately visible. */
    projectSkillNames?: readonly string[];
    realClaudeDir: string;
    hookEvents: number;
    /** The cell checkout the agent ran in; auto-memory must be keyed on it. */
    cwd?: string;
  },
): IsolationVerdict {
  if (!init) {
    return { isolated: false, violations: ["no system/init frame (cannot prove isolation)"], evidence: {} };
  }
  const violations: string[] = [];
  const skills = strings(init.skills);
  const userSkills = new Set(opts.userSkillNames);
  const leakedSkills = skills.filter((s) => userSkills.has(s));
  if (leakedSkills.length) violations.push(`user skills visible: ${leakedSkills.join(", ")}`);
  const projectSkills = new Set(opts.projectSkillNames ?? []);
  const leakedProject = skills.filter((s) => projectSkills.has(s) && !userSkills.has(s));
  if (leakedProject.length) violations.push(`Aura project skills visible: ${leakedProject.join(", ")}`);

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
  if (opts.cwd) {
    const key = `/projects/${claudeProjectKey(opts.cwd)}/`;
    const foreign = Object.values(memoryPaths as Obj).filter((p) => typeof p === "string" && !p.includes(key));
    if (foreign.length) violations.push(`auto-memory keyed on another project (expected ${key}): ${String(foreign[0])}`);
  }

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

/** Claude Code's per-project directory name: every non-alphanumeric → `-`. */
export function claudeProjectKey(path: string): string {
  return path.replace(/\/+$/, "").replace(/[^A-Za-z0-9]/g, "-");
}
