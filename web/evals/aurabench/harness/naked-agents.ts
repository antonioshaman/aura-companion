/**
 * Naked agent runners (variants A and B, P6/D2).
 *
 * A — `claude -p` with a FRESH, EMPTY per-cell `CLAUDE_CONFIG_DIR` (no
 *     settings, hooks, skills, plugins, memory, CLAUDE.md — and no
 *     `.credentials.json`: P6/FIX-D2-CLAUDE-AUTH, a copied refresh token
 *     rotated prod out of its login). Auth is the bare access token in
 *     `CLAUDE_CODE_OAUTH_TOKEN` (see `claude-auth.ts`); the cell records that
 *     its config dir still holds no credentials file afterwards.
 *     `--strict-mcp-config` drops account MCP connectors,
 *     `--include-hook-events` makes any hook visible, and the init frame is
 *     checked by {@link checkNakedClaudeIsolation}.
 * B — `codex exec --json --ignore-user-config` with a FRESH
 *     per-cell `CODEX_HOME` holding only an `auth.json` symlink to the real
 *     one ({@link prepareIsolatedCodexHome}): no config, memories, skills,
 *     AGENTS.md or state from the real `~/.codex`, and nothing written back
 *     to it except a rotated OAuth token ({@link propagateRotatedCodexAuth}).
 *     That the real `~/.codex` stayed untouched is PROVEN per cell by
 *     `guardRealCodexHome` (wired in the runner for every variant).
 *     NOT `--ephemeral`: the `--json` stream never names the model, so the
 *     session rollout (kept in the per-cell home, never in `~/.codex`) is
 *     where the ACTUALLY used model is read from ({@link codexModelsFromRollouts}).
 *     No rollout / no model in it → `models: []` (unknown), never the pinned
 *     `-m` value (that is what was asked for, not what ran).
 *
 * The worktree was already scrubbed of Aura files by `runCell`. The process
 * factory is injected (tests script it); fs probes too. Firewall-clean.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { codexModelsFromRollouts, detectLimit, summarizeClaudeStream, summarizeCodexStream } from "./agent-metrics.js";
import { checkNakedClaudeIsolation } from "./isolation.js";
import { CLAUDE_TOKEN_ENV, claudeCredentialCopyEvidence } from "./claude-auth.js";
import { prepareIsolatedCodexHome, propagateRotatedCodexAuth, realAuthSha } from "./codex-home.js";
import type { AgentContext, AgentRun, AgentRunner } from "./run-cell.js";
import type { SpawnOptions, SpawnResult } from "./proc.js";

export type Spawner = (cmd: string, args: string[], o: SpawnOptions) => Promise<SpawnResult>;

export interface NakedDeps {
  spawn: Spawner;
  env: (extra: Record<string, string>) => Record<string, string>;
  /** The real `~/.claude` (isolation reference; never copied from). */
  realClaudeDir: string;
  /** The real `~/.codex` (auth source; written only to propagate a rotated token). */
  realCodexDir: string;
  /** Names of the user's Claude skills (must be invisible to naked A). */
  userSkillNames: () => string[];
  /** Skills the Aura repo ships (`.claude/skills`, `.agents/skills`) — must never reach a naked cell. */
  projectSkillNames?: () => string[];
  /** Create a fresh, EMPTY config dir (mode 0700) — no credentials file. */
  prepareClaudeConfig: (dir: string) => void;
  /** The current prod access token (never a refresh token); throws when none. */
  claudeAccessToken: () => string;
  /** Credentials files present in these dirs (default {@link claudeCredentialCopyEvidence}). */
  credentialCopies?: (dirs: string[]) => string[];
  /** Non-empty directory / existing file probe. */
  present: (path: string) => boolean;
  /** Fresh per-cell Codex home (default {@link prepareIsolatedCodexHome}). */
  prepareCodexHome?: (home: string, realCodexDir: string) => Record<string, unknown>;
  /** Register the cell home for write-back WHILE the cell runs (the runner's
   *  `CodexAuthKeeper.watch`); absent → only the post-cell write-back. */
  watchCodexHome?: (home: string, authShaAtStart: string | null) => void;
  /** Post-cell auth write-back, run in `finally` (default {@link propagateRotatedCodexAuth}). */
  finishCodexHome?: (home: string, realCodexDir: string, authShaAtStart: string | null) => string;
  /** sha256 of the real auth.json (default {@link realAuthSha}). */
  authSha?: (realCodexDir: string) => string | null;
  /** Contents of the session rollouts in a Codex home (default {@link readCodexRollouts}). */
  readRollouts?: (codexHome: string) => string[];
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
    d.prepareClaudeConfig(configDir);
    const r = await d.spawn(d.claudeBin ?? "claude", claudeNakedArgs(ctx.task.prompt, d.claudeModel), {
      cwd: ctx.worktree,
      timeoutMs: ctx.timeoutMs,
      env: d.env({ CLAUDE_CONFIG_DIR: configDir, [CLAUDE_TOKEN_ENV]: d.claudeAccessToken() }),
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
    const copies = (d.credentialCopies ?? ((dirs) => claudeCredentialCopyEvidence(dirs).credential_copies))([configDir]);
    const violations = [...iso.violations, ...copies.map((c) => `Claude credentials file in the cell config: ${c}`)];
    const isolation = {
      isolated: iso.isolated && copies.length === 0,
      violations,
      ...iso.evidence,
      claude_auth: `${CLAUDE_TOKEN_ENV} access token only (no refresh token)`,
      credential_copies: copies,
    };
    if (r.timedOut) return { kind: "done", status: "timeout", metrics: s.metrics, isolation, confounds: [] };
    if (s.finishedOk && r.code === 0) return { kind: "done", status: "completed", metrics: s.metrics, isolation, confounds: [] };
    const limit = detectLimit(`${s.resultText}\n${tail(r.stderr)}`, (d.now ?? Date.now)(), s.limitResult);
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

/** What a Codex home may inject into a "naked" run (probed in the cell's
 *  isolated home — expected empty; anything found is a confound). */
export function codexConfounds(codexHome: string, present: (p: string) => boolean): string[] {
  const out: string[] = [];
  for (const [rel, label] of [
    ["AGENTS.md", "CODEX_HOME/AGENTS.md (global instructions)"],
    ["skills", "CODEX_HOME/skills (user skills)"],
    ["memories", "CODEX_HOME/memories (codex memories)"],
    ["plugins", "CODEX_HOME/plugins"],
    ["config.toml", "CODEX_HOME/config.toml"],
  ] as const) {
    if (present(join(codexHome, rel))) out.push(label);
  }
  return out;
}

export function nakedCodexRunner(d: NakedDeps): AgentRunner {
  return async (ctx: AgentContext): Promise<AgentRun> => {
    const codexHome = join(ctx.artifactDir, "codex-home");
    const authShaAtStart = (d.authSha ?? realAuthSha)(d.realCodexDir);
    const seeded = (d.prepareCodexHome ?? prepareIsolatedCodexHome)(codexHome, d.realCodexDir);
    d.watchCodexHome?.(codexHome, authShaAtStart);
    // Probed before the run: what the agent could see at start.
    const confounds = codexConfounds(codexHome, d.present);
    let r: SpawnResult;
    let auth: string;
    try {
      r = await d.spawn(d.codexBin ?? "codex", codexNakedArgs(ctx.task.prompt, ctx.worktree, d.codexModel), {
        cwd: ctx.worktree,
        timeoutMs: ctx.timeoutMs,
        env: d.env({ CODEX_HOME: codexHome }),
        stdoutFile: join(ctx.artifactDir, "agent.jsonl"),
        stderrFile: join(ctx.artifactDir, "agent.stderr"),
      });
    } finally {
      auth = (d.finishCodexHome ?? propagateRotatedCodexAuth)(codexHome, d.realCodexDir, authShaAtStart);
    }
    const s = summarizeCodexStream(r.stdout);
    let rollouts: string[] = [];
    try {
      rollouts = (d.readRollouts ?? readCodexRollouts)(codexHome);
    } catch {
      // unreadable → model stays unknown
    }
    s.metrics.models = codexModelsFromRollouts(rollouts);
    const isolation = {
      isolated: confounds.length === 0,
      violations: confounds.map((c) => `visible to the agent: ${c}`),
      ...seeded,
      auth,
      flags: ["--ignore-user-config"],
      model_source: s.metrics.models.length ? "rollout turn_context" : "unknown (no rollout model)",
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

/** Every `*.jsonl` under `<codexHome>/sessions` (Codex writes
 *  `sessions/YYYY/MM/DD/rollout-*.jsonl`); missing dir → []. */
export function readCodexRollouts(codexHome: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(readFileSync(p, "utf8"));
    }
  };
  walk(join(codexHome, "sessions"));
  return out;
}
