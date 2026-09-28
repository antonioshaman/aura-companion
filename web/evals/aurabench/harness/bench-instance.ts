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
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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

/** A prod host:port as the skills spell it (`http://localhost:3456/api/…`,
 *  bare `localhost:3456/api/…`, `ws://…`); the scheme, if any, is kept. */
const PROD_API_URL = new RegExp(`\\b(?:localhost|127\\.0\\.0\\.1):${PROD_PORT}\\b`, "g");

/**
 * Point the bench copy of the skills at the bench instance: the `/council-*`
 * skills hardcode `http://localhost:3456` for their checkpoint emit, so on
 * the bench a skill would query PROD's session list (and never reach its own
 * pair — E would lose its checkpoints). Rewrites text files under `skillsDir`
 * in place (the copy only — never `~/.claude`). Returns what it did + what is
 * left (must be 0), stored as isolation evidence.
 */
export function rewriteSkillProdUrls(skillsDir: string, port: number): { files: number; replaced: number; remaining: number } {
  const out = { files: 0, replaced: 0, remaining: 0 };
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && /\.(md|txt|sh|json|ya?ml|ts|js|py)$/.test(e.name)) {
        const text = readFileSync(p, "utf8");
        const hits = text.match(PROD_API_URL)?.length ?? 0;
        if (!hits) continue;
        const next = text.replace(PROD_API_URL, `127.0.0.1:${port}`);
        writeFileSync(p, next);
        out.files++;
        out.replaced += hits;
        out.remaining += next.match(PROD_API_URL)?.length ?? 0;
      }
    }
  };
  if (existsSync(skillsDir)) walk(skillsDir);
  return out;
}

/**
 * Move the persisted sessions of a previous bench run out of the bench HOME
 * (FIX-D2-3). Every cell deletes its sessions, so anything left there is from
 * an interrupted run — and on boot the server would relaunch those sessions
 * into their cell checkouts, which no longer exist (or, worse, into a cell
 * path reused later). Moved, not deleted, to `<bench-root>/stale-sessions/`.
 * Also covers the legacy `$TMPDIR/vibe-sessions` the server migrates from.
 * Returns how many entries were moved.
 */
export function retireStaleSessions(paths: BenchInstancePaths, stamp: string = new Date().toISOString().replace(/[:.]/g, "-")): number {
  let moved = 0;
  for (const [name, dir] of [
    ["sessions", join(paths.home, ".companion", "sessions")],
    ["vibe-sessions", join(paths.tmp, "vibe-sessions")],
  ] as const) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    if (entries.length === 0) continue;
    const dest = join(paths.benchRoot, "stale-sessions", stamp);
    mkdirSync(dest, { recursive: true });
    renameSync(dir, join(dest, name));
    moved += entries.length;
  }
  return moved;
}

export function prepareBenchHome(
  paths: BenchInstancePaths,
  realHome: string,
  port: number = BENCH_PORT,
): { skillUrlRewrites: ReturnType<typeof rewriteSkillProdUrls>; staleSessionsRetired: number } {
  for (const d of [paths.home, paths.tmp, paths.recordings, paths.councilStats]) mkdirSync(d, { recursive: true });
  const staleSessionsRetired = retireStaleSessions(paths);
  const claude = join(paths.home, ".claude");
  mkdirSync(claude, { recursive: true, mode: 0o700 });
  // Refreshed on every start: prod keeps rotating the real credentials.
  cpSync(join(realHome, ".claude", ".credentials.json"), join(claude, ".credentials.json"));
  const skills = join(realHome, ".claude", "skills");
  if (existsSync(skills)) {
    rmSync(join(claude, "skills"), { recursive: true, force: true });
    cpSync(skills, join(claude, "skills"), { recursive: true, dereference: true });
  }
  const skillUrlRewrites = rewriteSkillProdUrls(join(claude, "skills"), port);
  prepareBenchCodexHome(join(paths.home, ".codex"), join(realHome, ".codex"));
  return { skillUrlRewrites, staleSessionsRetired };
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
  const { skillUrlRewrites, staleSessionsRetired } = prepareBenchHome(paths, opts.realHome, port);
  if (skillUrlRewrites.remaining > 0) throw new Error(`bench skills still reference the prod API after rewrite (${skillUrlRewrites.remaining})`);
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
      skill_prod_url_rewrites: skillUrlRewrites,
      stale_sessions_retired: staleSessionsRetired,
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
