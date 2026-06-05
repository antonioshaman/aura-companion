// AURA-LOCAL
// Cgroup PSI (memory.pressure) capability probe + reader. PLAN task T6.
//
// Production symptom (per feedback_cgroup_memoryhigh_throttle_ui_hang):
// `MemoryHigh=4G` cgroup throttle stalls the bun event loop without
// killing it — RSS gauges stay green, UI freezes seconds-to-minutes.
// The canary is `/sys/fs/cgroup/<unit>/memory.pressure` PSI `full`
// readings; if `full.avg300` climbs we know the process is being
// memory-throttled and operators get a 5-minute heads-up before the
// next OOM cycle. This module resolves the right pressure file ONCE
// at boot (different shapes on bare-metal systemd vs. Docker
// cgroupv2-unified vs. macOS-dev), caches the resolution, and the
// 5-minute diagnostic tick consults the cached resolver each tick.
//
// EC-7: every fs touch routes through a realpath+bounds wrapper. The
// resolver lives at one site (resolveProbePath); readers trust the
// resolved path and the wrapper has already proven it lives under
// `/sys/fs/cgroup`. Sibling shape to `resolveCleanupPath` in
// cleanup-paths.ts.
//
// AP-17: the module-scope `probeResolution` cache + `probeAttempted`
// once-per-process flag come bundled with `__resetPressureProbeForTests`
// + warn-path test coverage + beforeEach reset in the suite.
//
// EC-22: the boot `event:"memory.pressure.probe"` WARN is asserted by
// behavioural test (positive: linux-bare-metal stub → "available";
// negative: macOS stub → "unavailable + platform").
//
// EC-23 exemption: the resolved-path field IS logged on the boot WARN
// because operators MUST know which file we found (the whole point of
// the probe is operator-visible capability advertising). `/sys/fs/
// cgroup/...` is sysfs topology — service-unit names already known to
// the operator and unrelated to user data. Justified divergence from
// the EC-23 default of `(present, depth)` pair.
//
// Test seam: `__setFsAdapterForTests` swaps the fs reads/realpaths so
// the three-environment test (Deploy R3) can stub bare-metal systemd /
// Docker cgroupv2 unified / macOS unavailable without touching the
// real `/sys/fs/cgroup` tree.

import {
  existsSync as defaultExistsSync,
  readFileSync as defaultReadFileSync,
  realpathSync as defaultRealpathSync,
} from "node:fs";
import { log } from "../logger.js";

const SYS_FS_CGROUP_ROOT = "/sys/fs/cgroup" as const;
const SYS_FS_CGROUP_PREFIX = `${SYS_FS_CGROUP_ROOT}/` as const;
const PROC_SELF_CGROUP = "/proc/self/cgroup" as const;
const MEMORY_PRESSURE_FILENAME = "memory.pressure" as const;

interface FsAdapter {
  readFileSync: (path: string, encoding: "utf8") => string;
  realpathSync: (path: string) => string;
  existsSync: (path: string) => boolean;
}

const DEFAULT_FS: FsAdapter = {
  readFileSync: (p, enc) => defaultReadFileSync(p, enc),
  realpathSync: (p) => defaultRealpathSync(p),
  existsSync: (p) => defaultExistsSync(p),
};

let fsAdapter: FsAdapter = DEFAULT_FS;

/** Cached probe result; computed lazily on first access. */
type ProbeResolution =
  | { readonly available: false; readonly platform: string }
  | { readonly available: true; readonly resolvedPath: string };

let probeResolution: ProbeResolution | null = null;
let probeAttempted = false;

/** Test seam: swap fs primitives. AP-17 + EC-40 (static import shape). */
export function __setFsAdapterForTests(fs: Partial<FsAdapter>): void {
  fsAdapter = { ...DEFAULT_FS, ...fs };
}

/**
 * Test seam: clear the cached probe + the once-per-process WARN latch +
 * restore the default fs adapter. Pair with `afterEach` in every suite
 * per AP-17.
 */
export function __resetPressureProbeForTests(): void {
  probeResolution = null;
  probeAttempted = false;
  fsAdapter = DEFAULT_FS;
}

export type MemoryPressureReading =
  | { readonly available: false }
  | { readonly available: true; readonly fullAvg300Us: number };

/**
 * Walk candidate `/sys/fs/cgroup/...` paths and return the first that
 * resolves to a real `memory.pressure` file under the sysfs root.
 *
 * The candidate order:
 *   1. The cgroup v2 path advertised by `/proc/self/cgroup` (line shape
 *      `0::<path>`) — primary on bare-metal systemd, where each service
 *      lives at `/system.slice/<unit>.service/`. Cgroup v1's per-controller
 *      lines (`<id>:memory:<path>`) are deliberately ignored because PSI
 *      ships only on v2.
 *   2. `/sys/fs/cgroup/memory.pressure` — the cgroupns-unified root
 *      visible inside a Docker container where the host's cgroup tree is
 *      not exposed and the container sees its own slice at the root.
 *
 * Realpath + bounds-check per EC-7: every candidate is `realpathSync`d
 * AND verified to live under `/sys/fs/cgroup/` BEFORE we trust it. A
 * path that escapes the sysfs root via symlink (theoretical but cheap to
 * defend) is rejected.
 *
 * Returns `null` if no candidate resolves. Caller branches on the result
 * and stamps `platform` for the unavailable case (so the operator sees
 * `linux-no-psi` vs `darwin` vs `win32`).
 */
function resolveProbePath(): string | null {
  const candidates: string[] = [];

  // (1) Walk /proc/self/cgroup for the v2 path. Failures here are
  // recoverable — we fall through to candidate (2).
  try {
    const procSelf = fsAdapter.readFileSync(PROC_SELF_CGROUP, "utf8");
    const v2Line = procSelf.split("\n").find((line) => line.startsWith("0::"));
    if (v2Line) {
      const cgPath = v2Line.slice(3).trim();
      if (cgPath && cgPath !== "/") {
        candidates.push(`${SYS_FS_CGROUP_ROOT}${cgPath}/${MEMORY_PRESSURE_FILENAME}`);
      }
    }
  } catch {
    // /proc/self/cgroup unreadable — fall through to candidate (2).
  }

  // (2) Container/unified root.
  candidates.push(`${SYS_FS_CGROUP_ROOT}/${MEMORY_PRESSURE_FILENAME}`);

  for (const candidate of candidates) {
    const resolved = resolveSysFsPath(candidate);
    if (resolved !== null) return resolved;
  }
  return null;
}

/**
 * EC-7 resolving wrapper for `/sys/fs/cgroup` paths. Realpath +
 * startsWith bounds-check. Returns the resolved path on success, `null`
 * on any failure (missing file, escapes root after realpath, fs error).
 */
function resolveSysFsPath(candidate: string): string | null {
  let resolved: string;
  try {
    resolved = fsAdapter.realpathSync(candidate);
  } catch {
    return null;
  }
  if (resolved !== SYS_FS_CGROUP_ROOT && !resolved.startsWith(SYS_FS_CGROUP_PREFIX)) {
    return null;
  }
  if (!fsAdapter.existsSync(resolved)) return null;
  return resolved;
}

/**
 * Initialise the probe (idempotent). On first call, resolves the
 * candidate path + emits the boot `event:"memory.pressure.probe"` WARN
 * naming either the resolved path (available) or the platform string
 * (unavailable). Subsequent calls return the cached result without
 * re-resolving and without re-emitting.
 *
 * Returns the cached `ProbeResolution` so callers can branch.
 */
export function initMemoryPressureProbe(): ProbeResolution {
  if (probeResolution !== null) return probeResolution;
  const resolved = resolveProbePath();
  probeResolution = resolved !== null
    ? { available: true, resolvedPath: resolved }
    : { available: false, platform: derivePlatformLabel() };

  if (!probeAttempted) {
    probeAttempted = true;
    if (probeResolution.available) {
      log.warn("memory-pressure", "PSI probe available", {
        event: "memory.pressure.probe",
        available: true,
        // EC-23 exemption documented at module-header: sysfs topology is
        // operator-known, not user data; the whole point of the probe
        // WARN is to make resolution visible.
        resolvedPath: probeResolution.resolvedPath,
      });
    } else {
      log.warn("memory-pressure", "PSI probe unavailable", {
        event: "memory.pressure.probe",
        available: false,
        platform: probeResolution.platform,
      });
    }
  }
  return probeResolution;
}

/** Lazily-initialised capability flag. */
export function pressureMonitorAvailable(): boolean {
  return initMemoryPressureProbe().available;
}

/**
 * Read the current PSI `full` line and return `fullAvg300Us` — the
 * stalled-microseconds equivalent of the kernel's `avg300` percentage
 * over the last 300-second window:
 *
 *   fullAvg300Us = (avg300 / 100) * 300_000_000
 *
 * Comparison with `AURA_MEMORY_PRESSURE_WARN_THRESHOLD_US` (default
 * 10_000_000 µs ≈ 10s stalled in last 5 min ≈ 3.33%) gives a
 * memory-throttle WARN well before the next OOM cycle.
 *
 * Fail-CLOSED on any read or parse error — returns
 * `{ available: false }` so the caller's gate (`if (!reading.available)
 * skip`) never accidentally fires the WARN on bogus data. Sibling
 * shape to `verifyProcessIdentity` in process-identity.ts.
 */
export function readMemoryPressure(): MemoryPressureReading {
  const probe = initMemoryPressureProbe();
  if (!probe.available) return { available: false };
  let raw: string;
  try {
    raw = fsAdapter.readFileSync(probe.resolvedPath, "utf8");
  } catch {
    return { available: false };
  }
  const fullLine = raw.split("\n").find((line) => line.startsWith("full"));
  if (!fullLine) return { available: false };
  const match = /\bavg300=([0-9]+(?:\.[0-9]+)?)\b/.exec(fullLine);
  if (!match) return { available: false };
  const avg300Pct = parseFloat(match[1]);
  if (!Number.isFinite(avg300Pct) || avg300Pct < 0) return { available: false };
  // avg300 is "% of time stalled in the last 300s window" — convert to
  // microseconds in the same window so the operator threshold is in a
  // unit they can reason about (10_000_000 µs ≈ 10s stalled / 5 min).
  const fullAvg300Us = Math.round((avg300Pct / 100) * 300_000_000);
  return { available: true, fullAvg300Us };
}

/**
 * Best-effort platform label for the unavailable-WARN payload. On Linux
 * an unavailable probe means PSI isn't exposed (cgroup v1 / kernel
 * <4.20 / sandboxed namespace); the label distinguishes that from
 * macOS/Windows where the file shape never existed.
 */
function derivePlatformLabel(): string {
  if (process.platform === "linux") return "linux-no-psi";
  return process.platform;
}

