import { describe, expect, it, vi } from "vitest";
import { probeBinary, probePairingCapability, type ProbeRunner } from "./preflight-probe.js";

function fakeRunner(map: Record<string, { ok: boolean; stdout?: string; stderr?: string; exitCode?: number | null }>): ProbeRunner {
  return async (binary, _args) => {
    const r = map[binary];
    if (!r) throw new Error(`fake-runner: no entry for ${binary}`);
    return {
      ok: r.ok,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      exitCode: r.exitCode ?? (r.ok ? 0 : 1),
    };
  };
}

describe("probeBinary", () => {
  // Happy path: binary present + version line parsed.
  it("marks claude available and captures the version", async () => {
    const cap = await probeBinary("claude", fakeRunner({ claude: { ok: true, stdout: "claude 1.2.3\n" } }));
    expect(cap).toEqual({ binary: "claude", available: true, version: "claude 1.2.3" });
  });

  it("marks codex available and captures the version", async () => {
    const cap = await probeBinary("codex", fakeRunner({ codex: { ok: true, stdout: "codex-cli 0.4.0\n" } }));
    expect(cap.binary).toBe("codex");
    expect(cap.available).toBe(true);
    expect(cap.version).toBe("codex-cli 0.4.0");
  });

  // Subprocess P1-1: probe must NEVER throw — UI gating logic depends on
  // a boolean. A missing binary maps to available:false with a reason.
  it("marks a missing binary unavailable with a runner-error reason", async () => {
    const runner: ProbeRunner = async () => {
      throw new Error("ENOENT");
    };
    const cap = await probeBinary("codex", runner);
    expect(cap.available).toBe(false);
    expect(cap.reason).toMatch(/ENOENT/);
  });

  // Non-zero exit (e.g. binary present but auth broken / corrupted install)
  // is treated as unavailable rather than misreported as "found".
  it("marks a non-zero-exit binary unavailable", async () => {
    const cap = await probeBinary("codex", fakeRunner({ codex: { ok: false, exitCode: 127, stderr: "command not found" } }));
    expect(cap.available).toBe(false);
    expect(cap.reason).toMatch(/127/);
  });

  // Version line bounded — a hostile binary outputting a 1 MB first line
  // must not poison the capability cache. Caller can log stdout separately.
  it("drops version when first line is excessively long", async () => {
    const cap = await probeBinary(
      "claude",
      fakeRunner({ claude: { ok: true, stdout: "a".repeat(300) + "\n" } }),
    );
    expect(cap.available).toBe(true);
    expect(cap.version).toBeUndefined();
  });

  it("drops version when stdout is empty (still marks available because exit=0)", async () => {
    const cap = await probeBinary("claude", fakeRunner({ claude: { ok: true, stdout: "" } }));
    expect(cap.available).toBe(true);
    expect(cap.version).toBeUndefined();
  });
});

describe("probePairingCapability", () => {
  // Aggregation: pairing supported iff both halves available.
  it("marks claude+claude supported when claude is available", async () => {
    const cap = await probePairingCapability(
      "claude",
      "claude",
      fakeRunner({ claude: { ok: true, stdout: "claude 1.0.0" } }),
    );
    expect(cap.supported).toBe(true);
    expect(cap.primary.available).toBe(true);
    expect(cap.observer.available).toBe(true);
  });

  it("marks claude+codex supported when both available", async () => {
    const cap = await probePairingCapability(
      "claude",
      "codex",
      fakeRunner({
        claude: { ok: true, stdout: "claude 1.0.0" },
        codex: { ok: true, stdout: "codex 0.4.0" },
      }),
    );
    expect(cap.supported).toBe(true);
  });

  // The UI must NOT offer claude+codex when codex is missing — this is
  // the single-bit signal the capability endpoint exposes.
  it("marks claude+codex unsupported when codex is unavailable", async () => {
    const runner: ProbeRunner = async (binary) => {
      if (binary === "codex") throw new Error("ENOENT");
      return { ok: true, stdout: "claude 1.0.0", stderr: "", exitCode: 0 };
    };
    const cap = await probePairingCapability("claude", "codex", runner);
    expect(cap.supported).toBe(false);
    expect(cap.primary.available).toBe(true);
    expect(cap.observer.available).toBe(false);
  });

  // The two halves are probed in parallel — the second probe doesn't
  // wait for the first. Verify both runners get called.
  it("probes both halves in parallel", async () => {
    const calls: string[] = [];
    const runner: ProbeRunner = async (binary) => {
      calls.push(binary);
      return { ok: true, stdout: `${binary} 1.0.0`, stderr: "", exitCode: 0 };
    };
    await probePairingCapability("claude", "codex", runner);
    expect(calls.sort()).toEqual(["claude", "codex"]);
  });
});
