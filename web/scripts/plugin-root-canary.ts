// Canary for skills whose SKILL.md runs `${CLAUDE_PLUGIN_ROOT}/...` commands (B5,
// owner answer 2 in HANDOFF-uiux-phase-B4: ui-ux-pro-max ships only while this is green).
//
// Claude Code substitutes `${CLAUDE_PLUGIN_ROOT}` in a plugin skill's SKILL.md with the
// `--plugin-dir` it was given (verified live on 2.1.283). The canary does exactly that
// against an INSTALLED exposure dir and runs every concrete documented command (those
// without `<placeholder>` / `[optional]` parts) from a scratch cwd. It passes only if
// each one exits 0, prints something, and writes nothing into the cwd.
//
//   bun scripts/plugin-root-canary.ts <exposure dir> <skill name>
//
// The documented commands say `python`; hosts that only have `python3` (Debian, the
// Docker image before python-is-python3) get a `python` shim on PATH for the run, and
// the result records it — the path resolution is what the canary proves.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PLUGIN_ROOT_RE = /^python3? "\$\{CLAUDE_PLUGIN_ROOT\}\/[^"]+"/;

/** Concrete documented commands (no placeholders) that run a script under the plugin root. */
export function documentedCommands(skillMd: string): string[] {
  return skillMd
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => PLUGIN_ROOT_RE.test(l) && !/[<[]/.test(l));
}

/** What Claude does to SKILL.md text before the agent sees it. */
export function substitutePluginRoot(cmd: string, pluginDir: string): string {
  return cmd.split("${CLAUDE_PLUGIN_ROOT}").join(pluginDir);
}

export interface CanaryRun {
  command: string;
  status: number | null;
  stdoutBytes: number;
  wroteToCwd: string[];
  stderrTail: string;
}

export interface CanaryResult {
  skill: string;
  ok: boolean;
  runs: CanaryRun[];
  /** Set when `python` was absent and a python3 shim stood in. */
  pythonShim: boolean;
  errors: string[];
}

function which(bin: string): string | null {
  const r = spawnSync("sh", ["-c", `command -v ${bin}`], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

export function runPluginRootCanary(pluginDir: string, skill: string, opts: { timeoutMs?: number } = {}): CanaryResult {
  const errors: string[] = [];
  let md: string;
  try {
    md = readFileSync(join(pluginDir, "skills", skill, "SKILL.md"), "utf8");
  } catch (err) {
    return { skill, ok: false, runs: [], pythonShim: false, errors: [`cannot read the exposed SKILL.md: ${(err as Error).message}`] };
  }
  const cmds = documentedCommands(md);
  if (cmds.length === 0) errors.push("SKILL.md documents no concrete ${CLAUDE_PLUGIN_ROOT} command");

  const scratch = mkdtempSync(join(tmpdir(), "plugin-root-canary-"));
  const env: Record<string, string | undefined> = { ...process.env, PYTHONDONTWRITEBYTECODE: "1" };
  let pythonShim = false;
  if (!which("python")) {
    const py3 = which("python3");
    if (!py3) errors.push("neither python nor python3 is on PATH");
    else {
      const bin = join(scratch, "bin");
      mkdirSync(bin);
      symlinkSync(py3, join(bin, "python"));
      env.PATH = `${bin}:${env.PATH ?? ""}`;
      pythonShim = true;
    }
  }
  const runs: CanaryRun[] = [];
  try {
    for (const cmd of errors.length ? [] : cmds) {
      const cwd = mkdtempSync(join(scratch, "cwd-"));
      const command = substitutePluginRoot(cmd, pluginDir);
      const r = spawnSync("bash", ["-c", command], { cwd, env, encoding: "utf8", timeout: opts.timeoutMs ?? 60_000 });
      const run: CanaryRun = {
        command,
        status: r.status,
        stdoutBytes: Buffer.byteLength(r.stdout ?? ""),
        wroteToCwd: readdirSync(cwd),
        stderrTail: (r.stderr ?? "").trim().split("\n").slice(-3).join(" | "),
      };
      runs.push(run);
      if (run.status !== 0) errors.push(`exit ${run.status}: ${cmd} — ${run.stderrTail}`);
      else if (run.stdoutBytes === 0) errors.push(`no output: ${cmd}`);
      if (run.wroteToCwd.length) errors.push(`wrote ${run.wroteToCwd.join(", ")} into the cwd: ${cmd}`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return { skill, ok: errors.length === 0, runs, pythonShim, errors };
}

/** Skills in a plugin dir whose SKILL.md references ${CLAUDE_PLUGIN_ROOT}. */
export function pluginRootSkills(pluginDir: string): string[] {
  const dir = join(pluginDir, "skills");
  return readdirSync(dir)
    .filter((n) => {
      try {
        return readFileSync(join(dir, n, "SKILL.md"), "utf8").includes("${CLAUDE_PLUGIN_ROOT}");
      } catch {
        return false;
      }
    })
    .sort();
}

if (import.meta.main) {
  const [pluginDir, skill] = process.argv.slice(2);
  if (!pluginDir || !skill) {
    console.error("usage: bun scripts/plugin-root-canary.ts <exposure dir> <skill name>");
    process.exit(2);
  }
  const r = runPluginRootCanary(pluginDir, skill);
  for (const run of r.runs) console.log(`${run.status === 0 ? "✓" : "✗"} ${run.command} (${run.stdoutBytes} bytes)`);
  if (r.pythonShim) console.log("note: `python` absent — ran with a python3 shim");
  if (!r.ok) console.error(`canary FAILED for ${skill}:\n  - ${r.errors.join("\n  - ")}`);
  else console.log(`canary OK for ${skill} (${r.runs.length} documented commands)`);
  process.exit(r.ok ? 0 : 1);
}
