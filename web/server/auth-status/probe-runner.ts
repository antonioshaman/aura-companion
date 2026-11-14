import { spawn } from "node:child_process";

/**
 * Bounded runner for short CLI probes (`--version`, `auth status`,
 * `login status`), shared by the server and the offline CLI.
 *
 * Guarantees (ritchie A3/A7):
 *  - timeout → SIGTERM, then SIGKILL after `killGraceMs`, and the promise only
 *    settles once the child has actually exited (reaped) — no zombie, no
 *    orphan still holding credential files open;
 *  - stdout / stderr are capped at `maxBytes` each; overflow is dropped and
 *    flagged, never buffered unbounded;
 *  - stdin is closed, argv is passed as an array (no shell), and the caller
 *    supplies the environment explicitly (the same auth env a real session
 *    gets) — nothing is inherited implicitly beyond what the caller passes.
 *
 * A timeout or spawn failure is reported as such. Callers MUST map it to
 * "no network / not verified", never to "credentials invalid".
 */

export const PROBE_DEFAULT_TIMEOUT_MS = 5_000;
export const PROBE_DEFAULT_KILL_GRACE_MS = 1_000;
export const PROBE_DEFAULT_MAX_BYTES = 64 * 1024;

export interface ProbeOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  killGraceMs?: number;
  maxBytes?: number;
}

export type BoundedProbeResult =
  | {
      kind: "exited";
      /** Null when the child died from a signal. */
      exitCode: number | null;
      stdout: string;
      stderr: string;
      /** True if either stream exceeded `maxBytes` and was cut. */
      truncated: boolean;
    }
  | { kind: "timeout"; killedWith: "SIGTERM" | "SIGKILL" }
  | { kind: "spawn_error"; code: string };

class CappedBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  truncated = false;
  constructor(private readonly max: number) {}
  push(chunk: Buffer): void {
    if (this.size >= this.max) {
      this.truncated = true;
      return;
    }
    const room = this.max - this.size;
    const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
    if (piece.length < chunk.length) this.truncated = true;
    this.chunks.push(piece);
    this.size += piece.length;
  }
  text(): string {
    return Buffer.concat(this.chunks).toString("utf-8").trim();
  }
}

/**
 * Run `binaryPath args…` with the bounds above. `binaryPath` must already be
 * resolved to an absolute path by the caller; `args` should be module
 * constants — never request-derived.
 */
export function runBoundedProbe(
  binaryPath: string,
  args: readonly string[],
  opts: ProbeOptions = {},
): Promise<BoundedProbeResult> {
  const timeoutMs = opts.timeoutMs ?? PROBE_DEFAULT_TIMEOUT_MS;
  const killGraceMs = opts.killGraceMs ?? PROBE_DEFAULT_KILL_GRACE_MS;
  const maxBytes = opts.maxBytes ?? PROBE_DEFAULT_MAX_BYTES;

  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(binaryPath, [...args], {
        env: opts.env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
      });
    } catch (err) {
      resolve({ kind: "spawn_error", code: errorCode(err) });
      return;
    }

    const out = new CappedBuffer(maxBytes);
    const errBuf = new CappedBuffer(maxBytes);
    child.stdout?.on("data", (c: Buffer) => out.push(c));
    child.stderr?.on("data", (c: Buffer) => errBuf.push(c));

    let timedOut: "SIGTERM" | "SIGKILL" | null = null;
    let spawnError: string | null = null;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const timer = setTimeout(() => {
      timedOut = "SIGTERM";
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
      killTimer = setTimeout(() => {
        timedOut = "SIGKILL";
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
      }, killGraceMs);
    }, timeoutMs);

    let settled = false;
    const settle = (r: BoundedProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve(r);
    };

    child.on("error", (err) => {
      spawnError = errorCode(err);
      // Never started (ENOENT/EACCES): there is no process to reap.
      if (child.pid === undefined) settle({ kind: "spawn_error", code: spawnError });
    });

    // `close` fires after exit AND both pipes drained — the reap point.
    child.on("close", (code) => {
      if (spawnError !== null && code === null && !timedOut) {
        settle({ kind: "spawn_error", code: spawnError });
      } else if (timedOut) {
        settle({ kind: "timeout", killedWith: timedOut });
      } else {
        settle({
          kind: "exited",
          exitCode: code,
          stdout: out.text(),
          stderr: errBuf.text(),
          truncated: out.truncated || errBuf.truncated,
        });
      }
    });
  });
}

function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "UNKNOWN";
}

/** Legacy `ProbeRunner` shape (`preflight-probe.ts`) on top of the bounded runner. */
export interface LegacyProbeRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export function makeLegacyProbeRunner(
  resolveBinary: (name: string) => string | null,
  opts: ProbeOptions = {},
): (binary: string, args: readonly string[]) => Promise<LegacyProbeRunResult> {
  return async (binary, args) => {
    const resolved = resolveBinary(binary);
    if (!resolved) return { ok: false, stdout: "", stderr: "binary not found", exitCode: null };
    const r = await runBoundedProbe(resolved, args, opts);
    switch (r.kind) {
      case "exited":
        return { ok: r.exitCode === 0, stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
      case "timeout":
        return { ok: false, stdout: "", stderr: `probe timed out after ${opts.timeoutMs ?? PROBE_DEFAULT_TIMEOUT_MS}ms`, exitCode: null };
      case "spawn_error":
        return { ok: false, stdout: "", stderr: `probe failed to start (${r.code})`, exitCode: null };
    }
  };
}
