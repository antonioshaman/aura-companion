import type { BackendType } from "./session-types.js";

/**
 * Capability probe for Council Mode pairings. Before exposing
 * `claude+codex` in the UI, the server must verify the target user
 * actually has both binaries installed AND authenticated. A probe that
 * runs as the wrong uid (e.g. root) will lie — auth tokens live in
 * the spawning user's home (`~/.codex`, `~/.claude`). Inject the runner;
 * the caller is responsible for running it as the correct identity.
 *
 * Pure module: takes a {@link ProbeRunner} dependency so tests inject a
 * fake without spawning real processes. Real wiring (Bun.spawn against
 * `which <binary>` + `<binary> --version`) lives in the orchestrator
 * shutdown/preflight callsite.
 */

export interface ProbeRunResult {
  /** Whether the command exited with code 0. */
  ok: boolean;
  /** Trimmed stdout, bounded so a hostile binary cannot exhaust memory. */
  stdout: string;
  /** Trimmed stderr, bounded similarly. */
  stderr: string;
  /** Exit code, or null if the process was signalled / spawn failed. */
  exitCode: number | null;
}

/** Inject this to keep the probe pure-testable. */
export type ProbeRunner = (binary: string, args: readonly string[]) => Promise<ProbeRunResult>;

export interface BinaryCapability {
  binary: string;
  /** True if the binary was found and `--version` exited 0. */
  available: boolean;
  /** Reported version string (best-effort parse), undefined if unavailable. */
  version?: string;
  /** Human-readable reason if `available === false`. */
  reason?: string;
}

export interface PairingCapability {
  primary: BinaryCapability;
  observer: BinaryCapability;
  /** True iff BOTH halves of the pair are available. */
  supported: boolean;
}

const MAX_VERSION_LINE_LEN = 256;

function binaryNameFor(backend: BackendType): string {
  return backend === "codex" ? "codex" : "claude";
}

/**
 * Probe a single CLI binary. Returns availability + version. Never throws —
 * an absent binary, a non-zero exit, or a runner error all map to
 * `available: false` with a human-readable reason.
 */
export async function probeBinary(backend: BackendType, runner: ProbeRunner): Promise<BinaryCapability> {
  const binary = binaryNameFor(backend);
  let result: ProbeRunResult;
  try {
    result = await runner(binary, ["--version"]);
  } catch (err) {
    return {
      binary,
      available: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  if (!result.ok) {
    return {
      binary,
      available: false,
      reason: `--version exited with code ${result.exitCode ?? "null"}`,
    };
  }
  const firstLine = result.stdout.split(/\r?\n/)[0]?.trim() ?? "";
  const version = firstLine.length > 0 && firstLine.length <= MAX_VERSION_LINE_LEN ? firstLine : undefined;
  return { binary, available: true, version };
}

/**
 * Probe a pairing: probes both halves and aggregates. `supported` is the
 * boolean the UI should gate the pairing option on.
 */
export async function probePairingCapability(
  primary: BackendType,
  observer: BackendType,
  runner: ProbeRunner,
): Promise<PairingCapability> {
  const [primaryCap, observerCap] = await Promise.all([
    probeBinary(primary, runner),
    probeBinary(observer, runner),
  ]);
  return {
    primary: primaryCap,
    observer: observerCap,
    supported: primaryCap.available && observerCap.available,
  };
}
