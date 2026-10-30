import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupScanProcesses, SCAN_OWNER_ENV } from "./a11y-process-cleanup.js";
import { runGrouped } from "./a11y-scan.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "a11y-proc-test-")); roots.push(root);
  const proc = join(root, "proc"); mkdirSync(proc);
  const session = "aura-a11y-test-123";
  function process(pid: number, executable: string, owner = session, ticks = "99") {
    const dir = join(proc, String(pid)); mkdirSync(dir);
    symlinkSync(executable, join(dir, "exe"));
    writeFileSync(join(dir, "environ"), `${SCAN_OWNER_ENV}=${owner}\0`);
    writeFileSync(join(dir, "stat"), `${pid} (name with spaces) S ${Array(18).fill("0").join(" ")} ${ticks}`);
  }
  return { root, proc, session, process };
}

describe("scan process ownership", () => {
  it("cleans orphan Chrome and sidecars without a living daemon, leaving other scans alone", () => {
    const f = fixture();
    f.process(23, "/opt/chrome/chrome");
    f.process(24, "/opt/chrome/chrome", "aura-a11y-other");
    f.process(25, "/usr/bin/bash"); // marker alone is insufficient
    writeFileSync(join(f.root, `${f.session}.pid`), "9999");
    const kill = vi.fn();
    cleanupScanProcesses(f.session, f.root, f.proc, kill);
    expect(kill.mock.calls).toEqual([[23]]);
    expect(existsSync(join(f.root, `${f.session}.pid`))).toBe(false);
  });

  it("refuses reused or malformed process identities and unsafe names", () => {
    const f = fixture(); f.process(23, "/usr/bin/agent-browser", f.session, "bad");
    const kill = vi.fn();
    cleanupScanProcesses(f.session, f.root, f.proc, kill);
    cleanupScanProcesses("../escape", f.root, f.proc, kill);
    expect(kill).not.toHaveBeenCalled();
  });

  it("settles a timed out subprocess without waiting for inherited pipes to close", async () => {
    const result = await runGrouped(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 50 });
    expect(result.timedOut).toBe(true);
    expect(result.code).toBeNull();
  });
});
