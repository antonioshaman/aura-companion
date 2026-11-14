import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeLegacyProbeRunner, runBoundedProbe } from "./probe-runner.js";

// The bounded probe runner is what stands between a wedged / hostile CLI and
// the server event loop. These tests run REAL child processes (tiny sh
// scripts) because the guarantees under test — SIGKILL escalation, reaping,
// byte caps — are OS behaviour that a mock cannot prove.

let dir: string;
function script(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "probe-runner-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("runBoundedProbe", () => {
  it("returns trimmed stdout/stderr and the exit code", async () => {
    const bin = script("ok.sh", 'echo " hello "; echo warn >&2; exit 3');
    const r = await runBoundedProbe(bin, []);
    expect(r).toEqual({ kind: "exited", exitCode: 3, stdout: "hello", stderr: "warn", truncated: false });
  });

  it("passes argv as an array (no shell interpolation)", async () => {
    const bin = script("args.sh", 'printf "%s|" "$@"');
    const r = await runBoundedProbe(bin, ["a b", "$(id)", ";rm"]);
    expect(r.kind === "exited" && r.stdout).toBe("a b|$(id)|;rm|");
  });

  it("uses exactly the caller-supplied environment", async () => {
    const bin = script("env.sh", 'echo "${PROBE_MARK:-unset}"');
    const r = await runBoundedProbe(bin, [], { env: { PATH: "/usr/bin:/bin", PROBE_MARK: "service-env" } });
    expect(r.kind === "exited" && r.stdout).toBe("service-env");
  });

  it("caps output bytes and flags truncation", async () => {
    const bin = script("big.sh", "head -c 100000 /dev/zero | tr '\\0' x");
    const r = await runBoundedProbe(bin, [], { maxBytes: 1000 });
    expect(r.kind).toBe("exited");
    if (r.kind === "exited") {
      expect(r.stdout.length).toBe(1000);
      expect(r.truncated).toBe(true);
    }
  });

  it("escalates SIGTERM → SIGKILL for a child that ignores SIGTERM, and settles only after reaping", async () => {
    const pidFile = join(dir, "stubborn.pid");
    const bin = script("stubborn.sh", `trap '' TERM; echo $$ > ${pidFile}; while true; do sleep 0.05; done`);
    const r = await runBoundedProbe(bin, [], { timeoutMs: 200, killGraceMs: 200 });
    expect(r).toEqual({ kind: "timeout", killedWith: "SIGKILL" });
    const { readFileSync } = await import("node:fs");
    const pid = Number(readFileSync(pidFile, "utf-8").trim());
    expect(isAlive(pid)).toBe(false);
  });

  it("a SIGTERM-respecting child stops at SIGTERM", async () => {
    const bin = script("sleepy.sh", "exec sleep 30");
    const r = await runBoundedProbe(bin, [], { timeoutMs: 100, killGraceMs: 2_000 });
    expect(r).toEqual({ kind: "timeout", killedWith: "SIGTERM" });
  });

  it("reports spawn failure as spawn_error (never as an exit)", async () => {
    const r = await runBoundedProbe(join(dir, "does-not-exist"), []);
    expect(r).toEqual({ kind: "spawn_error", code: "ENOENT" });
  });
});

describe("makeLegacyProbeRunner", () => {
  it("keeps the preflight-probe contract", async () => {
    const bin = script("ver.sh", 'echo "1.2.3 (Claude Code)"');
    const run = makeLegacyProbeRunner((name) => (name === "claude" ? bin : null));
    expect(await run("claude", ["--version"])).toEqual({ ok: true, stdout: "1.2.3 (Claude Code)", stderr: "", exitCode: 0 });
    expect(await run("codex", ["--version"])).toEqual({ ok: false, stdout: "", stderr: "binary not found", exitCode: null });
  });
});
