import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  __resetPressureProbeForTests,
  __setFsAdapterForTests,
  initMemoryPressureProbe,
  pressureMonitorAvailable,
  readMemoryPressure,
  shouldEmitMemoryPressureWarn,
  MEMORY_PRESSURE_WARN_MIN_INTERVAL_MS,
} from "./memory-pressure-probe.js";
import type { MemoryPressureReading } from "./memory-pressure-probe.js";

// AP-17: every suite that exercises the probe MUST reset the module-scope
// cache + warn latch + fs adapter in beforeEach/afterEach so neither
// the cached resolution nor the once-per-process WARN latch leaks between
// tests. Without the reset, the second test in any file sees a "probe
// already initialised" path that doesn't re-emit the WARN and silently
// green-stamps a regression.

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  __resetPressureProbeForTests();
  const loggerModule = await import("../logger.js");
  warnSpy = vi.spyOn(loggerModule.log, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  __resetPressureProbeForTests();
  vi.restoreAllMocks();
});

// ── Three-environment probe path resolution (Deploy R3) ─────────────────
// Per the brief: linux-bare-metal stub, linux-docker-cgroupv2 stub, macOS
// unavailable stub. All three branches green or the probe is silently
// no-op on whichever shape matters most for the deployment.

describe("initMemoryPressureProbe — environment shapes", () => {
  // Bare-metal systemd: each service gets its own slice path under
  // /sys/fs/cgroup/system.slice/<unit>.service/. The /proc/self/cgroup
  // v2 line is `0::/system.slice/companion.service`.
  it("resolves the per-service path on a bare-metal systemd host", () => {
    const expectedPath = "/sys/fs/cgroup/system.slice/companion.service/memory.pressure";
    __setFsAdapterForTests({
      readFileSync: (path) => {
        if (path === "/proc/self/cgroup") return "0::/system.slice/companion.service\n";
        throw new Error(`unexpected read: ${path}`);
      },
      realpathSync: (path) => {
        // Bare-metal: realpath is identity (no symlinks under /sys/fs/cgroup).
        if (path === expectedPath) return expectedPath;
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
      existsSync: (path) => path === expectedPath,
    });

    const probe = initMemoryPressureProbe();
    expect(probe).toEqual({ available: true, resolvedPath: expectedPath });
    expect(pressureMonitorAvailable()).toBe(true);
  });

  // Docker cgroupv2 unified: container sees its slice at the namespace root,
  // /proc/self/cgroup returns `0::/` — the per-service candidate is skipped
  // and the fallback `/sys/fs/cgroup/memory.pressure` is what resolves.
  it("resolves the unified-root path inside a Docker cgroupv2 container", () => {
    const rootPath = "/sys/fs/cgroup/memory.pressure";
    __setFsAdapterForTests({
      readFileSync: (path) => {
        if (path === "/proc/self/cgroup") return "0::/\n";
        throw new Error(`unexpected read: ${path}`);
      },
      realpathSync: (path) => {
        if (path === rootPath) return rootPath;
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
      existsSync: (path) => path === rootPath,
    });

    const probe = initMemoryPressureProbe();
    expect(probe).toEqual({ available: true, resolvedPath: rootPath });
  });

  // macOS dev: no /proc, no /sys/fs/cgroup. Both candidates fail — the
  // probe must return `available: false` with a platform label that
  // distinguishes "Linux without PSI" from "non-Linux platform" so
  // operators can decide whether to invest in a v1 fallback.
  it("returns available=false with platform=<process.platform> on macOS/Windows", () => {
    __setFsAdapterForTests({
      readFileSync: () => {
        const err = new Error("ENOENT");
        Object.assign(err, { code: "ENOENT" });
        throw err;
      },
      realpathSync: () => {
        const err = new Error("ENOENT");
        Object.assign(err, { code: "ENOENT" });
        throw err;
      },
      existsSync: () => false,
    });

    const probe = initMemoryPressureProbe();
    expect(probe.available).toBe(false);
    if (probe.available === false) {
      // process.platform on the CI runner — assert shape rather than the
      // exact string so this test stays green across Linux/Mac CI.
      expect(probe.platform).toMatch(/^(linux-no-psi|darwin|win32|freebsd|openbsd|sunos|aix)$/);
    }
  });
});

// ── Boot WARN (EC-22 behavioural assertion on the typed-channel emit) ──

describe("initMemoryPressureProbe — boot WARN", () => {
  // Positive branch: probe succeeds → WARN names the resolved path so
  // the operator sees which cgroup slice we're monitoring. EC-23
  // exemption documented at module header — sysfs topology is
  // operator-known and not user data.
  it("emits memory.pressure.probe WARN with available=true + resolvedPath on success", () => {
    const path = "/sys/fs/cgroup/system.slice/companion.service/memory.pressure";
    __setFsAdapterForTests({
      readFileSync: () => "0::/system.slice/companion.service\n",
      realpathSync: (p) => (p === path ? path : (() => { throw new Error("nope"); })()),
      existsSync: (p) => p === path,
    });
    initMemoryPressureProbe();

    const warnCall = warnSpy.mock.calls.find((c: unknown[]) => {
      const data = c[2] as Record<string, unknown> | undefined;
      return data?.event === "memory.pressure.probe";
    });
    expect(warnCall).toBeDefined();
    const data = warnCall![2] as Record<string, unknown>;
    expect(data.available).toBe(true);
    expect(data.resolvedPath).toBe(path);
  });

  // Negative branch: probe fails on every candidate → WARN names the
  // platform so operators distinguish kernel-no-psi from non-Linux.
  it("emits memory.pressure.probe WARN with available=false + platform on failure", () => {
    __setFsAdapterForTests({
      readFileSync: () => { throw new Error("ENOENT"); },
      realpathSync: () => { throw new Error("ENOENT"); },
      existsSync: () => false,
    });
    initMemoryPressureProbe();

    const warnCall = warnSpy.mock.calls.find((c: unknown[]) => {
      const data = c[2] as Record<string, unknown> | undefined;
      return data?.event === "memory.pressure.probe";
    });
    expect(warnCall).toBeDefined();
    const data = warnCall![2] as Record<string, unknown>;
    expect(data.available).toBe(false);
    expect(typeof data.platform).toBe("string");
    expect((data.platform as string).length).toBeGreaterThan(0);
  });

  // AP-17: the boot WARN must fire ONCE per process — re-resolution by
  // a second caller does not re-emit. Without this we'd flood the log
  // on every diagnostic-tick read.
  it("emits the boot WARN exactly once across repeated init calls", () => {
    __setFsAdapterForTests({
      readFileSync: () => "0::/\n",
      realpathSync: (p) => p,
      existsSync: () => true,
    });
    initMemoryPressureProbe();
    initMemoryPressureProbe();
    initMemoryPressureProbe();

    const probeWarns = warnSpy.mock.calls.filter((c: unknown[]) => {
      const data = c[2] as Record<string, unknown> | undefined;
      return data?.event === "memory.pressure.probe";
    });
    expect(probeWarns).toHaveLength(1);
  });

  // AP-17 reset coverage: after __reset, the WARN re-fires. Proves the
  // reset is functional and the warn-once flag is reachable from tests.
  it("__resetPressureProbeForTests re-arms the warn-once latch", () => {
    __setFsAdapterForTests({
      readFileSync: () => "0::/\n",
      realpathSync: (p) => p,
      existsSync: () => true,
    });
    initMemoryPressureProbe();
    const firstBatch = warnSpy.mock.calls.filter((c: unknown[]) => (c[2] as { event?: string } | undefined)?.event === "memory.pressure.probe");
    expect(firstBatch).toHaveLength(1);

    __resetPressureProbeForTests();
    // Re-arm adapter (reset cleared it back to DEFAULT_FS).
    __setFsAdapterForTests({
      readFileSync: () => "0::/\n",
      realpathSync: (p) => p,
      existsSync: () => true,
    });
    initMemoryPressureProbe();
    const secondBatch = warnSpy.mock.calls.filter((c: unknown[]) => (c[2] as { event?: string } | undefined)?.event === "memory.pressure.probe");
    expect(secondBatch).toHaveLength(2);
  });
});

// ── readMemoryPressure parsing + unit conversion ────────────────────────

describe("readMemoryPressure — parsing + clamp", () => {
  // Canonical PSI shape: two lines (`some` + `full`), each line has
  // avg10/avg60/avg300/total fields. Reader only consults `full`.
  it("converts the kernel's avg300 percentage to microseconds in the 300s window", () => {
    const path = "/sys/fs/cgroup/memory.pressure";
    const psi = [
      "some avg10=0.50 avg60=0.20 avg300=0.10 total=1000000",
      "full avg10=0.10 avg60=0.05 avg300=2.00 total=600000",
      "",
    ].join("\n");
    __setFsAdapterForTests({
      readFileSync: (p) => {
        if (p === "/proc/self/cgroup") return "0::/\n";
        if (p === path) return psi;
        throw new Error(`unexpected read: ${p}`);
      },
      realpathSync: (p) => (p === path ? path : (() => { throw new Error("nope"); })()),
      existsSync: (p) => p === path,
    });

    const reading = readMemoryPressure();
    expect(reading.available).toBe(true);
    if (reading.available === true) {
      // 2.00% of 300_000_000 µs = 6_000_000 µs
      expect(reading.fullAvg300Us).toBe(6_000_000);
    }
  });

  // Fail-CLOSED: malformed PSI (missing `full` line) → not-available.
  // The 5-min diagnostic gate is "if available && fullAvg300Us > T" so
  // not-available means no WARN fires on bogus data.
  it("returns available=false on malformed PSI (no full line)", () => {
    const path = "/sys/fs/cgroup/memory.pressure";
    __setFsAdapterForTests({
      readFileSync: (p) => {
        if (p === "/proc/self/cgroup") return "0::/\n";
        if (p === path) return "some avg10=0.0\n";
        throw new Error(`unexpected read: ${p}`);
      },
      realpathSync: (p) => (p === path ? path : (() => { throw new Error("nope"); })()),
      existsSync: (p) => p === path,
    });

    expect(readMemoryPressure().available).toBe(false);
  });

  // Fail-CLOSED: read error after probe was previously successful.
  // Proves the readMemoryPressure error boundary swallows fs throws
  // rather than crashing the diagnostic tick.
  it("returns available=false when the resolved path read throws post-init", () => {
    const path = "/sys/fs/cgroup/memory.pressure";
    let throwOnNext = false;
    __setFsAdapterForTests({
      readFileSync: (p) => {
        if (p === "/proc/self/cgroup") return "0::/\n";
        if (throwOnNext) throw new Error("EIO");
        return [
          "some avg10=0.0 avg60=0.0 avg300=0.0 total=0",
          "full avg10=0.0 avg60=0.0 avg300=0.0 total=0",
          "",
        ].join("\n");
      },
      realpathSync: (p) => (p === path ? path : (() => { throw new Error("nope"); })()),
      existsSync: (p) => p === path,
    });

    // Init + first read succeeds.
    expect(readMemoryPressure().available).toBe(true);
    // Subsequent read throws → fail-CLOSED.
    throwOnNext = true;
    expect(readMemoryPressure().available).toBe(false);
  });

  // Skip path: if the probe was never available, readMemoryPressure
  // short-circuits to available=false without touching fs.
  it("short-circuits to available=false when probe is unavailable", () => {
    __setFsAdapterForTests({
      readFileSync: () => { throw new Error("ENOENT"); },
      realpathSync: () => { throw new Error("ENOENT"); },
      existsSync: () => false,
    });
    initMemoryPressureProbe();
    expect(readMemoryPressure().available).toBe(false);
  });
});

// ── EC-7 bounds enforcement ─────────────────────────────────────────────

describe("resolveSysFsPath — EC-7 bounds enforcement", () => {
  // Defence in depth: a candidate path whose realpath escapes
  // /sys/fs/cgroup (theoretical symlink shenanigans) is rejected. Proves
  // the resolver doesn't trust the candidate string blindly.
  it("rejects realpaths that escape the /sys/fs/cgroup root", () => {
    __setFsAdapterForTests({
      readFileSync: () => "0::/system.slice/evil.service\n",
      realpathSync: () => "/etc/passwd", // attacker pre-symlinks the slice
      existsSync: () => true,
    });
    const probe = initMemoryPressureProbe();
    expect(probe.available).toBe(false);
  });
});

// ── shouldEmitMemoryPressureWarn — pure gate boundaries (PLAN T6 review) ──
// The memory-pressure WARN decision was extracted out of index.ts's
// diagnostic-tick lambda (which is structurally untestable) into this pure
// helper so its bug-prone edges get direct coverage: feature-flag,
// capability fail-closed, the strictly-above-threshold compare, and the
// 30-min rate-limit (first-fire / suppressed-within / allowed-after).
// Phase C council review flagged the inline version as having no
// behavioral test.

describe("shouldEmitMemoryPressureWarn — gate boundaries", () => {
  const THRESHOLD = 10_000_000; // µs
  const above: MemoryPressureReading = { available: true, fullAvg300Us: THRESHOLD + 1 };
  const atThreshold: MemoryPressureReading = { available: true, fullAvg300Us: THRESHOLD };
  const NOW = 1_000_000_000_000;

  it("does not fire when the feature flag is disabled", () => {
    expect(
      shouldEmitMemoryPressureWarn({
        reading: above,
        thresholdUs: THRESHOLD,
        enabled: false,
        lastWarnAtMs: null,
        nowMs: NOW,
      }),
    ).toBe(false);
  });

  it("fails closed when the probe reading is unavailable", () => {
    expect(
      shouldEmitMemoryPressureWarn({
        reading: { available: false },
        thresholdUs: THRESHOLD,
        enabled: true,
        lastWarnAtMs: null,
        nowMs: NOW,
      }),
    ).toBe(false);
  });

  it("does NOT fire exactly at the threshold (`>` not `>=`) but DOES fire just above", () => {
    const common = { thresholdUs: THRESHOLD, enabled: true, lastWarnAtMs: null, nowMs: NOW };
    expect(shouldEmitMemoryPressureWarn({ reading: atThreshold, ...common })).toBe(false);
    expect(shouldEmitMemoryPressureWarn({ reading: above, ...common })).toBe(true);
  });

  it("fires on the first qualifying tick (lastWarnAtMs === null)", () => {
    expect(
      shouldEmitMemoryPressureWarn({
        reading: above,
        thresholdUs: THRESHOLD,
        enabled: true,
        lastWarnAtMs: null,
        nowMs: NOW,
      }),
    ).toBe(true);
  });

  it("suppresses a repeat WARN within the 30-min rate-limit window", () => {
    expect(
      shouldEmitMemoryPressureWarn({
        reading: above,
        thresholdUs: THRESHOLD,
        enabled: true,
        // 1ms short of the interval → suppressed.
        lastWarnAtMs: NOW - (MEMORY_PRESSURE_WARN_MIN_INTERVAL_MS - 1),
        nowMs: NOW,
      }),
    ).toBe(false);
  });

  it("allows the WARN once the rate-limit window has elapsed (boundary is inclusive)", () => {
    expect(
      shouldEmitMemoryPressureWarn({
        reading: above,
        thresholdUs: THRESHOLD,
        enabled: true,
        // exactly the interval → age === interval → `>=` allows it.
        lastWarnAtMs: NOW - MEMORY_PRESSURE_WARN_MIN_INTERVAL_MS,
        nowMs: NOW,
      }),
    ).toBe(true);
  });

  it("suppresses (does not fail-open) when the clock jumps backward (EC-38 clamp)", () => {
    // lastWarnAtMs in the future relative to nowMs → ageMs clamps to 0 <
    // interval → suppressed, never a spurious fire on a negative delta.
    expect(
      shouldEmitMemoryPressureWarn({
        reading: above,
        thresholdUs: THRESHOLD,
        enabled: true,
        lastWarnAtMs: NOW + 60_000,
        nowMs: NOW,
      }),
    ).toBe(false);
  });
});
