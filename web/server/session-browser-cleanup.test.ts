import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionBrowserCleanup, readSessionBrowser, type SessionBrowser } from "./session-browser-cleanup.js";

const sessionId = "40f03a1e-2b12-48f0-bf91-7c33c2631c6a";
const browser: SessionBrowser = {
  name: `aura-${sessionId}`, pid: 123, sessionId,
  executable: "/tools/agent-browser-linux-x64", startTicks: "99", registeredAt: 1,
};
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function harness(owner: { archived?: boolean } | undefined = { archived: false }) {
  const deps = {
    scan: vi.fn(async () => [browser]), read: vi.fn(async (): Promise<SessionBrowser | null> => browser),
    getSession: vi.fn((): { archived?: boolean } | undefined => owner),
    close: vi.fn(async (_browser: SessionBrowser) => {}), now: () => 10 * 86400_000,
  };
  return { deps, cleanup: createSessionBrowserCleanup(deps) };
}

describe("session-aware browser cleanup", () => {
  it.each([false, undefined])("keeps an unarchived owner's browser after days without commands (archived=%s)", async (archived) => {
    const { deps, cleanup } = harness({ archived });
    await cleanup.sweep();
    expect(deps.close).not.toHaveBeenCalled();
  });

  it("closes only an archived owner's browser through its graceful close command", async () => {
    const { deps, cleanup } = harness({ archived: true });
    await cleanup.sweep();
    expect(deps.close).toHaveBeenCalledExactlyOnceWith(browser);
  });

  it("closes an old browser whose owning session was deleted", async () => {
    const { deps, cleanup } = harness();
    deps.getSession.mockReturnValue(undefined);
    await cleanup.sweep();
    expect(deps.close).toHaveBeenCalledOnce();
  });

  it("allows a new session time to register before considering its browser orphaned", async () => {
    const { deps, cleanup } = harness();
    deps.getSession.mockReturnValue(undefined);
    deps.scan.mockResolvedValue([{ ...browser, registeredAt: deps.now() - 1000 }]);
    await cleanup.sweep();
    expect(deps.close).not.toHaveBeenCalled();
  });

  it.each([
    { pid: 456 }, { startTicks: "new" }, { sessionId: "different" }, { executable: "/other/agent-browser" },
  ])("does not close a daemon whose identity changed: %s", async (changed) => {
    const { deps, cleanup } = harness({ archived: true });
    deps.read.mockResolvedValue({ ...browser, ...changed });
    await cleanup.sweep();
    expect(deps.close).not.toHaveBeenCalled();
  });

  it("does not close a session unarchived while the sweep was inspecting it", async () => {
    const { deps, cleanup } = harness({ archived: true });
    deps.read.mockImplementation(async () => { deps.getSession.mockReturnValue({ archived: false }); return browser; });
    await cleanup.sweep();
    expect(deps.close).not.toHaveBeenCalled();
  });

  it("skips unreadable or vanished daemons", async () => {
    const { deps, cleanup } = harness({ archived: true });
    deps.read.mockResolvedValue(null);
    await cleanup.sweep();
    expect(deps.close).not.toHaveBeenCalled();
  });

  it("joins concurrent sweeps instead of closing the same browser twice", async () => {
    const { deps, cleanup } = harness({ archived: true });
    await Promise.all([cleanup.sweep(), cleanup.sweep()]);
    expect(deps.close).toHaveBeenCalledOnce();
  });

  it("stops scheduled work on disposal", async () => {
    const { deps, cleanup } = harness({ archived: true });
    cleanup.dispose();
    await cleanup.sweep();
    expect(deps.scan).not.toHaveBeenCalled();
  });

  it("leaves everything alone if scanning fails", async () => {
    const { deps, cleanup } = harness({ archived: true });
    deps.scan.mockRejectedValue(new Error("unreadable"));
    await cleanup.sweep();
    expect(deps.close).not.toHaveBeenCalled();
  });

  it("retries a failed close on a later sweep", async () => {
    const { deps, cleanup } = harness({ archived: true });
    deps.close.mockRejectedValueOnce(new Error("busy"));
    await cleanup.sweep();
    await cleanup.sweep();
    expect(deps.close).toHaveBeenCalledTimes(2);
  });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "session-browser-test-"));
  directories.push(directory);
  const procRoot = join(directory, "proc");
  const processDir = join(procRoot, "123");
  mkdirSync(processDir, { recursive: true });
  writeFileSync(join(directory, `${browser.name}.pid`), "123");
  symlinkSync(browser.executable, join(processDir, "exe"));
  writeFileSync(join(processDir, "environ"), `OTHER=ignored\0AURA_BROWSER_SESSION_ID=${sessionId}\0`);
  const fields = Array.from({ length: 20 }, () => "0");
  fields[19] = "99";
  writeFileSync(join(processDir, "stat"), `123 (agent (browser)) ${fields.join(" ")}`);
  return { directory, procRoot, processDir };
}

describe("browser ownership evidence", () => {
  it("requires daemon executable, owning UID, session marker, pidfile and kernel start time", async () => {
    const { directory, procRoot } = fixture();
    expect(await readSessionBrowser(browser.name, directory, procRoot)).toMatchObject({
      name: browser.name, pid: 123, executable: browser.executable, sessionId, startTicks: "99",
    });
  });

  it("does not claim an unmarked browser", async () => {
    const { directory, procRoot, processDir } = fixture();
    writeFileSync(join(processDir, "environ"), "OTHER=ignored\0");
    expect(await readSessionBrowser(browser.name, directory, procRoot)).toBeNull();
  });

  it("does not claim an unrelated process using the same PID", async () => {
    const { directory, procRoot, processDir } = fixture();
    rmSync(join(processDir, "exe"));
    symlinkSync("/usr/bin/python3", join(processDir, "exe"));
    expect(await readSessionBrowser(browser.name, directory, procRoot)).toBeNull();
  });

  it("rejects a symlink pidfile and path traversal", async () => {
    const { directory, procRoot } = fixture();
    rmSync(join(directory, `${browser.name}.pid`));
    writeFileSync(join(directory, "target"), "123");
    symlinkSync(join(directory, "target"), join(directory, `${browser.name}.pid`));
    expect(await readSessionBrowser(browser.name, directory, procRoot)).toBeNull();
    expect(await readSessionBrowser("../other", directory, procRoot)).toBeNull();
  });
});
