/**
 * Naked agent runners (variants A and B, P6/D2).
 *
 * A — `claude -p` with a FRESH per-cell `CLAUDE_CONFIG_DIR` holding only a
 *     copy of `.credentials.json` (no settings, hooks, skills, plugins,
 *     memory, CLAUDE.md). `--strict-mcp-config` drops account MCP connectors,
 *     `--include-hook-events` makes any hook visible, and the init frame is
 *     checked by {@link checkNakedClaudeIsolation}.
 * B — `codex exec --json --ephemeral --ignore-user-config`. `~/.codex` is
 *     NEVER copied or edited (refresh-token rotation would break prod), so
 *     whatever it still injects (global AGENTS.md, skills, memories) is
 *     recorded as a confound instead.
 *
 * The worktree was already scrubbed of Aura files by `runCell`. The process
 * factory is injected (tests script it); fs probes too. Firewall-clean.
 */

import { join } from "node:path";
import { detectLimit, summarizeClaudeStream, summarizeCodexStream } from "./agent-metrics.js";
import { checkNakedClaudeIsolation } from "./isolation.js";
import type { AgentContext, AgentRun, AgentRunner } from "./run-cell.js";
import type { SpawnOptions, SpawnResult } from "./proc.js";

export type Spawner = (cmd: string, args: string[], o: SpawnOptions) => Promise<SpawnResult>;

export interface NakedDeps {
  spawn: Spawner;
  env: (extra: Record<string, string>) => Record<string, string>;
  /** The real `~/.claude` (credentials source; isolation reference). */
  realClaudeDir: string;
  /** The real `~/.codex` (confound probe only — never written). */
  realCodexDir: string;
  /** Names of the user's Claude skills (must be invisible to naked A). */
  userSkillNames: () => string[];
  /** Skills the Aura repo ships (`.claude/skills`, `.agents/skills`) — must never reach a naked cell. */
  projectSkillNames?: () => string[];
  /** Create a fresh config dir with only the credentials copied (mode 0600). */
  prepareClaudeConfig: (dir: string, credentialsFrom: string) => void;
  /** Non-empty directory / existing file probe. */
  present: (path: string) => boolean;
  /** Pinned models — every variant of a provider must run the same model. */
  claudeModel?: string;
  codexModel?: string;
  /** Absolute CLI paths (the same binaries the Aura variants get). */
  claudeBin?: string;
  codexBin?: string;
  now?: () => number;
}

const tail = (s: string, n = 2000) => (s.length <= n ? s : s.slice(s.length - n));

export function claudeNakedArgs(prompt: string, model?: string): string[] {
  return [
    ...(model ? ["--model", model] : []),
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "bypassPermissions",
    "--include-hook-events",
    "--no-session-persistence",
    "--strict-mcp-config",
  ];
}

export function codexNakedArgs(prompt: string, worktree: string, model?: string): string[] {
  return [
    "exec",
    ...(model ? ["-m", model] : []),
    "--json",
    "--ephemeral",
    "--ignore-user-config",
    "--dangerously-bypass-approvals-and-sandbox",
    "--skip-git-repo-check",
    "-C",
    worktree,
    prompt,
  ];
}

export function nakedClaudeRunner(d: NakedDeps): AgentRunner {
  return async (ctx: AgentContext): Promise<AgentRun> => {
    const configDir = join(ctx.artifactDir, "claude-config");
    d.prepareClaudeConfig(configDir, join(d.realClaudeDir, ".credentials.json"));
    const r = await d.spawn(d.claudeBin ?? "claude", claudeNakedArgs(ctx.task.prompt, d.claudeModel), {
      cwd: ctx.worktree,
      timeoutMs: ctx.timeoutMs,
      env: d.env({ CLAUDE_CONFIG_DIR: configDir }),
      stdoutFile: join(ctx.artifactDir, "agent.jsonl"),
      stderrFile: join(ctx.artifactDir, "agent.stderr"),
    });
    const s = summarizeClaudeStream(r.stdout);
    const iso = checkNakedClaudeIsolation(s.init, {
      userSkillNames: d.userSkillNames(),
      projectSkillNames: d.projectSkillNames?.() ?? [],
      realClaudeDir: d.realClaudeDir,
      cwd: ctx.worktree,
      hookEvents: s.hookEvents,
    });
    const isolation = { isolated: iso.isolated, violations: iso.violations, ...iso.evidence };
    if (r.timedOut) return { kind: "done", status: "timeout", metrics: s.metrics, isolation, confounds: [] };
    if (s.finishedOk && r.code === 0) return { kind: "done", status: "completed", metrics: s.metrics, isolation, confounds: [] };
    const limit = detectLimit(`${s.resultText}\n${tail(r.stderr)}`, (d.now ?? Date.now)());
    if (limit) return { kind: "limit", limit };
    return {
      kind: "done",
      status: "agent_error",
      metrics: s.metrics,
      isolation,
      confounds: [],
      error: tail(s.resultText || r.stderr || `exit ${r.code}`, 500),
    };
  };
}

/** What a shared `~/.codex` may still inject into a "naked" Codex run. */
export function codexConfounds(realCodexDir: string, present: (p: string) => boolean): string[] {
  const out: string[] = [];
  for (const [rel, label] of [
    ["AGENTS.md", "~/.codex/AGENTS.md (global instructions)"],
    ["skills", "~/.codex/skills (user skills)"],
    ["memories", "~/.codex/memories (codex memories)"],
    ["plugins", "~/.codex/plugins"],
  ] as const) {
    if (present(join(realCodexDir, rel))) out.push(label);
  }
  return out;
}

export function nakedCodexRunner(d: NakedDeps): AgentRunner {
  return async (ctx: AgentContext): Promise<AgentRun> => {
    const r = await d.spawn(d.codexBin ?? "codex", codexNakedArgs(ctx.task.prompt, ctx.worktree, d.codexModel), {
      cwd: ctx.worktree,
      timeoutMs: ctx.timeoutMs,
      env: d.env({}),
      stdoutFile: join(ctx.artifactDir, "agent.jsonl"),
      stderrFile: join(ctx.artifactDir, "agent.stderr"),
    });
    const s = summarizeCodexStream(r.stdout);
    const confounds = codexConfounds(d.realCodexDir, d.present);
    const isolation = {
      isolated: true,
      codex_home: "shared ~/.codex (read by codex, never copied/edited by the harness)",
      flags: ["--ephemeral", "--ignore-user-config"],
    };
    if (r.timedOut) return { kind: "done", status: "timeout", metrics: s.metrics, isolation, confounds };
    if (s.finishedOk && r.code === 0) return { kind: "done", status: "completed", metrics: s.metrics, isolation, confounds };
    const limit = detectLimit(`${s.errorText}\n${tail(r.stderr)}`, (d.now ?? Date.now)());
    if (limit) return { kind: "limit", limit };
    return {
      kind: "done",
      status: "agent_error",
      metrics: s.metrics,
      isolation,
      confounds,
      error: tail(s.errorText || r.stderr || `exit ${r.code}`, 500),
    };
  };
}
