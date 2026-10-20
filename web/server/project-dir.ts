import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir, rmdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { log } from "./logger.js";

/**
 * Make sure a new session's working directory exists before the CLI spawns.
 *
 * A folder typed into the picker that does not exist on the server used to
 * reach `Bun.spawn({ cwd })`, which reports a missing cwd as
 * `ENOENT … posix_spawn '<claude binary>'` — blaming the binary, not the
 * folder. Now a missing folder is created (or cloned from `repoUrl`) first.
 *
 * Guard rails:
 * - only absolute paths inside the fs allowlist (home, server cwd,
 *   `COMPANION_FS_ALLOWED_BASES`) — the same bases the folder picker may browse;
 * - an existing folder is never touched (no clone into it, no mkdir);
 * - the repo URL is a plain https/ssh git URL and goes to `git` as an argv
 *   element after `--`, never through a shell;
 * - when the service user cannot create the folder (e.g. projects live in a
 *   root-owned `/root`), `COMPANION_PROJECT_DIR_SUDO=1` lets the server create
 *   it with `sudo -n install -d -o <service user>`; otherwise the error names
 *   the exact command to run.
 */

export type ProjectDirResult =
  | { ok: true; created: boolean; cloned: boolean }
  | { ok: false; error: string; status: 400 | 403 | 500 };

export interface CommandResult {
  ok: boolean;
  output: string;
}

/** Runs a command with an argv array (no shell). Injected in tests. */
export type CommandRunner = (
  file: string,
  args: string[],
  opts: { timeoutMs: number; env?: NodeJS.ProcessEnv },
) => Promise<CommandResult>;

export interface EnsureProjectDirOptions {
  cwd: string;
  repoUrl?: string;
  env?: NodeJS.ProcessEnv;
  allowedBases?: string[];
  run?: CommandRunner;
}

const CLONE_TIMEOUT_MS = 5 * 60_000;
const SUDO_TIMEOUT_MS = 15_000;

// https://host/owner/repo(.git) or git@host:owner/repo(.git). No spaces,
// quotes, or a leading "-" (which git would read as an option).
const REPO_URL_RE = /^(?:https:\/\/[A-Za-z0-9.-]+(?::\d+)?\/[A-Za-z0-9._~\/-]+|git@[A-Za-z0-9.-]+:[A-Za-z0-9._~\/-]+)$/;

export function isValidRepoUrl(url: string): boolean {
  return REPO_URL_RE.test(url) && !url.includes("..");
}

/** Allowlist for filesystem access — mirrors `registerFsRoutes`. */
export function resolveAllowedBases(env: NodeJS.ProcessEnv = process.env): string[] {
  const extras = (env.COMPANION_FS_ALLOWED_BASES ?? "")
    .split(":")
    .map((s) => s.trim())
    .filter((p) => p && isAbsolute(p));
  return [homedir(), process.cwd(), ...extras];
}

function isInsideBases(abs: string, bases: string[]): boolean {
  return bases.some((base) => abs === base || abs.startsWith(base.endsWith("/") ? base : base + "/"));
}

export const defaultRunner: CommandRunner = (file, args, opts) =>
  new Promise((resolveRun) => {
    execFile(
      file,
      args,
      { timeout: opts.timeoutMs, env: opts.env ?? process.env, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const output = `${stdout ?? ""}${stderr ?? ""}`.trim();
        resolveRun({ ok: !err, output: output || (err ? err.message : "") });
      },
    );
  });

/** Whether the session folder is already there (any file type). */
export function projectDirExists(cwd: string): boolean {
  return existsSync(cwd);
}

function errnoCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

export async function ensureProjectDir(opts: EnsureProjectDirOptions): Promise<ProjectDirResult> {
  const env = opts.env ?? process.env;
  const run = opts.run ?? defaultRunner;
  // The create routes forward the request body untyped; a non-string is a
  // client bug worth a 400, not a crash on `.trim()`.
  if (opts.repoUrl !== undefined && opts.repoUrl !== null && typeof opts.repoUrl !== "string") {
    return { ok: false, error: "repoUrl must be a string", status: 400 };
  }
  const repoUrl = opts.repoUrl?.trim() || undefined;

  if (!isAbsolute(opts.cwd)) {
    return { ok: false, error: `Project folder must be an absolute path: ${opts.cwd}`, status: 400 };
  }
  const abs = resolve(opts.cwd);

  if (existsSync(abs)) {
    if (!statSync(abs).isDirectory()) {
      return { ok: false, error: `Project path exists but is not a folder: ${abs}`, status: 400 };
    }
    return { ok: true, created: false, cloned: false };
  }

  if (repoUrl && !isValidRepoUrl(repoUrl)) {
    return { ok: false, error: `Invalid git repository URL: ${repoUrl}`, status: 400 };
  }
  const bases = opts.allowedBases ?? resolveAllowedBases(env);
  if (!isInsideBases(abs, bases)) {
    return {
      ok: false,
      error: `Folder ${abs} does not exist and is outside the allowed directories (${bases.join(", ")}), so it was not created`,
      status: 403,
    };
  }

  try {
    await mkdir(abs, { recursive: true });
  } catch (err) {
    const code = errnoCode(err);
    if (code !== "EACCES" && code !== "EPERM") {
      return { ok: false, error: `Could not create folder ${abs}: ${(err as Error).message}`, status: 500 };
    }
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    const manual = `sudo install -d -o ${uid ?? "$USER"} -g ${gid ?? "$USER"} ${abs}`;
    if (env.COMPANION_PROJECT_DIR_SUDO !== "1" || uid === undefined || gid === undefined) {
      return {
        ok: false,
        error: `No permission to create ${abs}. Create it on the server (${manual}) or set COMPANION_PROJECT_DIR_SUDO=1`,
        status: 403,
      };
    }
    const sudo = await run("sudo", ["-n", "install", "-d", "-o", String(uid), "-g", String(gid), "--", abs], {
      timeoutMs: SUDO_TIMEOUT_MS,
    });
    if (!sudo.ok) {
      return { ok: false, error: `Could not create ${abs} via sudo: ${sudo.output}`, status: 500 };
    }
  }
  log.info("project-dir", "created missing project folder", { event: "project_dir.created", cwd: abs });

  if (!repoUrl) return { ok: true, created: true, cloned: false };

  // GIT_TERMINAL_PROMPT=0: a private repo without credentials must fail fast,
  // not hang the create request waiting for a password on a TTY nobody sees.
  const clone = await run("git", ["clone", "--", repoUrl, abs], {
    timeoutMs: CLONE_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (!clone.ok) {
    // Leave no empty shell behind so a retry starts clean; rmdir refuses a
    // non-empty dir, so nothing but our own empty folder can be removed.
    await rmdir(abs).catch(() => {});
    log.warn("project-dir", "git clone failed", { event: "project_dir.clone_failed", cwd: abs, repoUrl });
    return { ok: false, error: `git clone ${repoUrl} failed: ${clone.output}`, status: 500 };
  }
  log.info("project-dir", "cloned repository into project folder", { event: "project_dir.cloned", cwd: abs, repoUrl });
  return { ok: true, created: true, cloned: true };
}
