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
 *  - `HOST=127.0.0.1`: not reachable from outside;
 *  - `COMPANION_TELEMETRY=0` + a dead-end `COMPANION_STATS_URL`: the settings
 *    default is `telemetryEnabled: true`, so without the override a bench or
 *    smoke instance mints its own instance id and heartbeats into the public
 *    install/online counter (it did in pilot 1). Forced, not inherited.
 *
 * The bench HOME gets `.claude/.credentials.json` + a dereferenced copy of
 * `.claude/skills` (the council skills are user-level) — NOT `settings.json`
 * (its hooks write into the real `~/.claude`). `.codex` is the bench's OWN
 * directory holding only an `auth.json` symlink to the real one — the server
 * seeds per-session Codex homes from `~/.codex`, so this is what F/G sessions
 * see: no config, memories, skills or AGENTS.md, same as naked B. (Pilot 1
 * symlinked the whole real `~/.codex` here; an old link is replaced.)
 *
 * Firewall-clean (spawns the server as a process; imports nothing from it).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, openSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { benchChildEnv } from "./proc.js";
import { CODEX_AUTH_FILE } from "./codex-home.js";

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
    COMPANION_TELEMETRY: "0",
    // Belt and braces: even if the flag were ignored, beats go nowhere.
    COMPANION_STATS_URL: "http://127.0.0.1:9",
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
  prepareBenchCodexHome(join(paths.home, ".codex"), join(realHome, ".codex"));
}

/** The bench HOME's `.codex`: a real directory with only an `auth.json`
 *  symlink. A pilot-1 symlink to the whole real `~/.codex` is unlinked (the
 *  link only — never its target). Idempotent. */
export function prepareBenchCodexHome(benchCodex: string, realCodexDir: string): void {
  const st = lstatSync(benchCodex, { throwIfNoEntry: false });
  if (st?.isSymbolicLink()) unlinkSync(benchCodex);
  mkdirSync(benchCodex, { recursive: true, mode: 0o700 });
  const link = join(benchCodex, CODEX_AUTH_FILE);
  const realAuth = join(realCodexDir, CODEX_AUTH_FILE);
  if (!lstatSync(link, { throwIfNoEntry: false }) && existsSync(realAuth)) symlinkSync(realAuth, link);
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
      telemetry: "off",
      codex_home: "bench-owned ~/.codex (auth.json symlink only)",
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
