/**
 * The isolated Companion instance for the Aura variants (P6/D2).
 *
 * Runs `bun server/index.ts` from the bench clone (`$WORK/repo/web`,
 * `diet/main`) — NEVER the prod checkout, NEVER port 3456 — with its own:
 *
 *  - `HOME` (`<benchRoot>/aura-home`): the server keeps sessions, auth,
 *    settings and cron under `~/.companion` via `homedir()`, so HOME is the
 *    only switch that separates ALL of it from prod's `~/.companion`;
 *  - `TMPDIR`, `COMPANION_RECORDINGS_DIR`, `COMPANION_COUNCIL_STATS_DIR`,
 *    `COMPANION_ALLOWED_ORIGIN`;
 *  - `COMPANION_ORPHAN_REAPER=off`: the reaper scans all of `/proc` and would
 *    SIGTERM prod's orphaned CLIs as "unknown";
 *  - `HOST=127.0.0.1`: not reachable from outside.
 *
 * The bench HOME gets `.claude/.credentials.json` + a dereferenced copy of
 * `.claude/skills` (the council skills are user-level) — NOT `settings.json`
 * (its hooks write into the real `~/.claude`). `.codex` is a symlink to the
 * real `~/.codex`, i.e. exactly how prod shares Codex auth (per-session
 * `auth.json` symlinks, see cli-launcher); nothing is copied or edited.
 *
 * Firewall-clean (spawns the server as a process; imports nothing from it).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, openSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { benchChildEnv } from "./proc.js";

export const BENCH_PORT = 3499;
export const PROD_PORT = 3456;

export interface BenchInstancePaths {
  benchRoot: string;
  home: string;
  tmp: string;
  recordings: string;
  councilStats: string;
  log: string;
}

export function benchInstancePaths(benchRoot: string): BenchInstancePaths {
  return {
    benchRoot,
    home: join(benchRoot, "aura-home"),
    tmp: join(benchRoot, "aura-home", "tmp"),
    recordings: join(benchRoot, "recordings"),
    councilStats: join(benchRoot, "council-stats"),
    log: join(benchRoot, "instance.log"),
  };
}

/** The instance env. Throws on the prod port — a hard guard, not a default. */
export function benchInstanceEnv(
  base: Record<string, string | undefined>,
  paths: BenchInstancePaths,
  port: number = BENCH_PORT,
): Record<string, string> {
  if (port === PROD_PORT) throw new Error(`refusing to start the bench instance on the prod port ${PROD_PORT}`);
  const origin = `http://127.0.0.1:${port}`;
  return benchChildEnv(base, {
    HOME: paths.home,
    TMPDIR: paths.tmp,
    PORT: String(port),
    HOST: "127.0.0.1",
    NODE_ENV: "production",
    COMPANION_RECORDINGS_DIR: paths.recordings,
    COMPANION_COUNCIL_STATS_DIR: paths.councilStats,
    COMPANION_ALLOWED_ORIGIN: origin,
    COMPANION_ORPHAN_REAPER: "off",
  });
}

export function prepareBenchHome(paths: BenchInstancePaths, realHome: string): void {
  for (const d of [paths.home, paths.tmp, paths.recordings, paths.councilStats]) mkdirSync(d, { recursive: true });
  const claude = join(paths.home, ".claude");
  mkdirSync(claude, { recursive: true, mode: 0o700 });
  // Refreshed on every start: prod keeps rotating the real credentials.
  cpSync(join(realHome, ".claude", ".credentials.json"), join(claude, ".credentials.json"));
  const skills = join(realHome, ".claude", "skills");
  if (existsSync(skills)) {
    rmSync(join(claude, "skills"), { recursive: true, force: true });
    cpSync(skills, join(claude, "skills"), { recursive: true, dereference: true });
  }
  const codexLink = join(paths.home, ".codex");
  if (!existsSync(codexLink)) symlinkSync(join(realHome, ".codex"), codexLink);
}

export interface RunningInstance {
  baseUrl: string;
  facts: Record<string, unknown>;
  stop: () => Promise<void>;
}

/** Start the instance and wait until `GET /api/sessions` answers. */
export async function startBenchInstance(opts: {
  webDir: string;
  benchRoot: string;
  realHome: string;
  port?: number;
  readyTimeoutMs?: number;
}): Promise<RunningInstance> {
  const port = opts.port ?? BENCH_PORT;
  const paths = benchInstancePaths(opts.benchRoot);
  prepareBenchHome(paths, opts.realHome);
  const env = benchInstanceEnv(process.env, paths, port);
  const baseUrl = `http://127.0.0.1:${port}`;
  // Refuse to attach to something already listening there (could be anything).
  if (await ping(baseUrl)) throw new Error(`port ${port} is already in use; stop that instance first`);
  const logFd = openSync(paths.log, "a");
  const child: ChildProcess = spawn("nice", ["-n", "5", "bun", "server/index.ts"], {
    cwd: opts.webDir,
    env,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  const deadline = Date.now() + (opts.readyTimeoutMs ?? 120_000);
  while (!(await ping(baseUrl))) {
    if (child.exitCode !== null || Date.now() > deadline) {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // gone
      }
      throw new Error(`bench instance did not become ready (see ${paths.log})`);
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return {
    baseUrl,
    facts: {
      instance_port: port,
      instance_home: paths.home,
      recordings_dir: paths.recordings,
      orphan_reaper: "off",
      prod_port: PROD_PORT,
    },
    stop: async () => {
      if (!child.pid || child.exitCode !== null) return;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        return;
      }
      for (let i = 0; i < 30 && child.exitCode === null; i++) await new Promise((r) => setTimeout(r, 500));
      try {
        if (child.exitCode === null) process.kill(-child.pid, "SIGKILL");
      } catch {
        // gone
      }
    },
  };
}

async function ping(baseUrl: string): Promise<boolean> {
  try {
    const r = await fetch(`${baseUrl}/api/sessions`, { signal: AbortSignal.timeout(2_000) });
    return r.status === 200;
  } catch {
    return false;
  }
}
