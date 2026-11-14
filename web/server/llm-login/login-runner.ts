import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assertNever, type LoginFailureReason, type ProviderId } from "../auth-status/auth-types.js";
import { escalateKill, type KillEscalation } from "../auth-status/probe-runner.js";

/**
 * Long-lived runner for the official sign-in CLIs (phase 2 plan task 4).
 * `runBoundedProbe` does not fit: it closes stdin and buffers until exit,
 * while a sign-in prints a link, waits minutes for the owner and (Claude)
 * reads a reply code from stdin.
 *
 * Guarantees (ritchie §A, EC-45, EC-53):
 *  - fixed argv per provider, absolute CLI path, `shell: false`;
 *  - environment by allowlist only — HOME and the CLI config dir point at the
 *    attempt's staging home, so the CLI's destructive start (Claude rewrites
 *    an expired file, Codex deletes auth.json) can only hit the staging dir;
 *    no API keys, OAuth env tokens or the Aura token reach the CLI;
 *  - its own session + process group (`detached`), TERM→KILL to the whole
 *    group, and on Linux a `timeout --kill-after` wrapper so the kernel side
 *    ends the sign-in even if the server is restarted (`KillMode=process`);
 *  - both streams are read for the whole life with a 64KB cap each; the raw
 *    output is handed to `onOutput` and never stored or logged here;
 *  - "exited" only on `close` (process gone and pipes drained), then any
 *    leftover member of its session is swept.
 */

export const LOGIN_ARGV: Readonly<Record<ProviderId, readonly string[]>> = {
  claude: ["auth", "login"],
  codex: ["login", "--device-auth"],
};

export const LOGIN_KILL_GRACE_MS = 5_000;
export const LOGIN_MAX_STREAM_BYTES = 64 * 1024;
/** One reply line at most; the attempt validates the code shape before this. */
const MAX_INPUT_LINE = 1024;

/** Variables the CLI may inherit from the service (network egress only; no credentials by design). */
const PASSTHROUGH_ENV = ["PATH", "LANG", "LC_ALL", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy", "ALL_PROXY", "all_proxy"] as const;

/** Where a provider's CLI keeps its credentials inside a (staging) home. */
export function configDirFor(provider: ProviderId, home: string): string {
  switch (provider) {
    case "claude": return join(home, ".claude");
    case "codex": return join(home, ".codex");
    default: return assertNever(provider);
  }
}

/**
 * The CLI's whole environment. `stagingHome` is the attempt's private HOME;
 * `serviceEnv` contributes PATH, locale and proxy settings only.
 */
export function loginEnv(provider: ProviderId, stagingHome: string, serviceEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { HOME: stagingHome, TERM: "dumb" };
  for (const key of PASSTHROUGH_ENV) {
    const value = serviceEnv[key];
    if (value) env[key] = value;
  }
  switch (provider) {
    case "claude": env.CLAUDE_CONFIG_DIR = configDirFor("claude", stagingHome); break;
    case "codex": env.CODEX_HOME = configDirFor("codex", stagingHome); break;
    default: assertNever(provider);
  }
  return env;
}

export type LoginRefusal = Extract<LoginFailureReason, "wrong_service_user" | "unsupported_platform" | "cli_missing">;

/**
 * Checks before any process starts. The sign-in runs only as the service
 * user (never root or another user in its place) and, for Claude, not on
 * macOS where credentials live in the Keychain (D6).
 */
export function loginPreflight(opts: {
  provider: ProviderId;
  platform: NodeJS.Platform;
  /** User this process runs as. */
  callerUser: string;
  /** User the service runs as (`resolveServiceIdentity().user`); null when unknown (dev). */
  serviceUser: string | null;
  cliPath: string | null;
}): LoginRefusal | null {
  if (opts.serviceUser !== null && opts.serviceUser !== opts.callerUser) return "wrong_service_user";
  if (opts.provider === "claude" && opts.platform === "darwin") return "unsupported_platform";
  if (!opts.cliPath || !opts.cliPath.startsWith("/")) return "cli_missing";
  return null;
}

export interface LoginProcessSpec {
  provider: ProviderId;
  /** Absolute path of the official CLI (resolved the way sessions resolve it). */
  cliPath: string;
  stagingHome: string;
  serviceEnv: NodeJS.ProcessEnv;
  /**
   * Kernel-side backstop: on Linux the CLI runs under `timeout --kill-after`
   * with this limit, so it dies even if the server does not. Set it a little
   * above the attempt's own TTL. Null = no wrapper.
   */
  hardTtlMs: number | null;
  /** `timeout` binary; defaults to /usr/bin/timeout when present on Linux. */
  timeoutBinary?: string | null;
  killGraceMs?: number;
}

export interface LoginExit {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** True when `kill()` was called before the exit (cancel / expiry / failure). */
  killedByUs: boolean;
  /** A stream passed the 64KB cap (the rest was read and dropped). */
  outputCapped: boolean;
}

export interface LoginProcess {
  readonly pid: number;
  /** /proc start time (clock ticks since boot) — the identity anchor for the sentinel (EC-45). */
  readonly startTime: string | null;
  /** Writes one line to stdin. False if refused (control chars, too long, stdin closed). */
  writeLine(line: string): boolean;
  /** TERM the group, KILL after the grace period; resolves when the process is reaped and the group swept. */
  kill(): Promise<LoginExit>;
  readonly exited: Promise<LoginExit>;
}

export type SpawnLoginResult = { ok: true; process: LoginProcess } | { ok: false; reason: "cli_missing" | "spawn_failed" };

export function defaultTimeoutBinary(platform: NodeJS.Platform = process.platform): string | null {
  if (platform !== "linux") return null;
  return existsSync("/usr/bin/timeout") ? "/usr/bin/timeout" : null;
}

export function spawnLoginProcess(
  spec: LoginProcessSpec,
  onOutput: (chunk: Buffer, stream: "stdout" | "stderr") => void,
): Promise<SpawnLoginResult> {
  const env = loginEnv(spec.provider, spec.stagingHome, spec.serviceEnv);
  const argv = LOGIN_ARGV[spec.provider];
  const timeoutBinary = spec.timeoutBinary === undefined ? defaultTimeoutBinary() : spec.timeoutBinary;
  const [file, args] =
    timeoutBinary && spec.hardTtlMs !== null
      ? [timeoutBinary, ["--kill-after=5s", `${Math.max(1, Math.ceil(spec.hardTtlMs / 1000))}s`, spec.cliPath, ...argv]]
      : [spec.cliPath, [...argv]];
  const graceMs = spec.killGraceMs ?? LOGIN_KILL_GRACE_MS;

  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(file, args, { env, cwd: spec.stagingHome, stdio: ["pipe", "pipe", "pipe"], shell: false, detached: true, windowsHide: true });
    } catch {
      resolve({ ok: false, reason: "spawn_failed" });
      return;
    }

    let killedByUs = false;
    let outputCapped = false;
    let escalation: KillEscalation | null = null;
    const sizes = { stdout: 0, stderr: 0 };
    const forward = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
      if (sizes[stream] >= LOGIN_MAX_STREAM_BYTES) {
        outputCapped = true;
        return;
      }
      const room = LOGIN_MAX_STREAM_BYTES - sizes[stream];
      const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
      if (piece.length < chunk.length) outputCapped = true;
      sizes[stream] += piece.length;
      try {
        onOutput(piece, stream);
      } catch { /* a consumer bug must not kill the reader (EC-53) */ }
    };
    child.stdout?.on("data", forward("stdout"));
    child.stderr?.on("data", forward("stderr"));
    // EPIPE on a write after exit must not become an unhandled error.
    child.stdin?.on("error", () => {});

    let started = false;
    let resolveExit!: (exit: LoginExit) => void;
    const exited = new Promise<LoginExit>((r) => { resolveExit = r; });

    child.on("error", (err) => {
      if (started) return;
      const code = (err as { code?: unknown }).code;
      resolve({ ok: false, reason: code === "ENOENT" || code === "EACCES" ? "cli_missing" : "spawn_failed" });
    });

    child.on("close", (code, signal) => {
      escalation?.cancel();
      // The CLI is gone; anything it left in its session (grandchildren) goes too.
      if (pgid !== undefined) sweepSession(pgid);
      resolveExit({ exitCode: code, signal, killedByUs, outputCapped });
    });

    const pgid = child.pid;
    child.on("spawn", () => {
      started = true;
      const pid = child.pid!;
      const proc: LoginProcess = {
        pid,
        startTime: readStartTime(pid),
        exited,
        writeLine(line: string): boolean {
          if (line.length === 0 || line.length > MAX_INPUT_LINE || /[\x00-\x1f\x7f]/.test(line)) return false;
          const stdin = child.stdin;
          if (!stdin || stdin.destroyed || !stdin.writable) return false;
          stdin.write(`${line}\n`);
          return true;
        },
        kill(): Promise<LoginExit> {
          if (!killedByUs) {
            killedByUs = true;
            // The group exists while the child (its leader) is unreaped — `close` has not fired.
            escalation = escalateKill((sig) => process.kill(-pid, sig), graceMs);
          }
          return exited;
        },
      };
      resolve({ ok: true, process: proc });
    });
  });
}

// ─── /proc helpers (Linux; no-ops elsewhere) ──────────────────────────────────

interface ProcStat {
  pid: number;
  pgrp: number;
  session: number;
  startTime: string;
}

/** Fields of /proc/<pid>/stat after the parenthesised comm (which may contain spaces). */
export function readProcStat(pid: number): ProcStat | null {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf-8");
    const rest = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
    // rest[0]=state [1]=ppid [2]=pgrp [3]=session … [19]=starttime
    return { pid, pgrp: Number(rest[2]), session: Number(rest[3]), startTime: rest[19] };
  } catch {
    return null;
  }
}

export function readStartTime(pid: number): string | null {
  return readProcStat(pid)?.startTime ?? null;
}

/** Live members of session `sid` (the runner starts each CLI as a session leader). */
export function sessionMembers(sid: number): number[] {
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return [];
  }
  const members: number[] = [];
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const stat = readProcStat(Number(name));
    if (stat && stat.session === sid) members.push(stat.pid);
  }
  return members;
}

/**
 * KILL every process still in the CLI's session after it exited. Members are
 * re-read from /proc right before each signal and must still carry the
 * session id (EC-45): a session id is never reused while any member lives.
 */
function sweepSession(sid: number): void {
  for (const pid of sessionMembers(sid)) {
    if (readProcStat(pid)?.session !== sid) continue;
    try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  }
}
