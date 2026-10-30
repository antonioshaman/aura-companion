import { execFile } from "node:child_process";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { log } from "./logger.js";

import { isAgentBrowserExecutable, processStartTicks } from "./agent-browser-process.js";

const execFileAsync = promisify(execFile);

export interface SessionBrowser {
  name: string;
  pid: number;
  sessionId: string;
  executable: string;
  startTicks: string;
  registeredAt: number;
}

export async function readSessionBrowser(
  name: string,
  directory = join(homedir(), ".agent-browser"),
  procRoot = "/proc",
): Promise<SessionBrowser | null> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) return null;
  try {
    const pidfile = join(directory, `${name}.pid`);
    const metadata = await lstat(pidfile);
    if (!metadata.isFile() || metadata.uid !== process.getuid?.()) return null;
    const pid = Number((await readFile(pidfile, "utf8")).trim());
    if (!Number.isSafeInteger(pid) || pid <= 1) return null;
    const processDir = join(procRoot, String(pid));
    if ((await lstat(processDir)).uid !== metadata.uid) return null;
    const executable = await readlink(join(processDir, "exe"));
    if (!isAgentBrowserExecutable(executable)) return null;
    const environment = (await readFile(join(processDir, "environ"), "utf8")).split("\0");
    const sessionId = environment.find((entry) => entry.startsWith("AURA_BROWSER_SESSION_ID="))?.split("=")[1];
    if (!sessionId || !/^[a-f0-9-]{36}$/.test(sessionId)) return null;
    const stat = await readFile(join(processDir, "stat"), "utf8");
    const startTicks = processStartTicks(stat);
    if (!startTicks || !/^\d+$/.test(startTicks)) return null;
    return { name, pid, sessionId, executable, startTicks, registeredAt: metadata.mtimeMs };
  } catch {
    return null;
  }
}

export interface SessionBrowserCleanupDeps {
  scan: () => Promise<SessionBrowser[]>;
  read: (name: string) => Promise<SessionBrowser | null>;
  getSession: (id: string) => { archived?: boolean } | undefined;
  close: (browser: SessionBrowser) => Promise<void>;
  now: () => number;
}

/** Seams for tests; production uses the real daemon binary and /proc. */
export interface CloseSessionBrowserOptions {
  exec?: (file: string, args: string[], options: { timeout: number; env: NodeJS.ProcessEnv }) => Promise<unknown>;
  read?: (name: string) => Promise<SessionBrowser | null>;
  exitTimeoutMs?: number;
  pollMs?: number;
}

export async function closeSessionBrowser(browser: SessionBrowser, options: CloseSessionBrowserOptions = {}): Promise<void> {
  const exec = options.exec ?? execFileAsync;
  const read = options.read ?? ((name: string) => readSessionBrowser(name));
  await exec(`/proc/${browser.pid}/exe`, ["--session", browser.name, "close"], {
    timeout: 5000,
    env: { ...process.env, AGENT_BROWSER_SESSION: browser.name },
  });
  const deadline = Date.now() + (options.exitTimeoutMs ?? 3000);
  while (Date.now() < deadline) {
    const current = await read(browser.name);
    if (!current || current.pid !== browser.pid || current.startTicks !== browser.startTicks) return;
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 50));
  }
  throw new Error("Browser daemon did not exit after close");
}

export function createSessionBrowserCleanup(deps: SessionBrowserCleanupDeps) {
  let running: Promise<void> | undefined;
  let disposed = false;
  const eligible = (browser: SessionBrowser): boolean => {
    const owner = deps.getSession(browser.sessionId);
    return owner ? owner.archived === true : deps.now() - browser.registeredAt >= 300_000;
  };
  async function run() {
    const candidates = (await deps.scan()).filter(eligible).slice(0, 10);
    for (const browser of candidates) {
      if (disposed) return;
      try {
        const current = await deps.read(browser.name);
        if (!current || current.pid !== browser.pid || current.startTicks !== browser.startTicks
          || current.executable !== browser.executable || current.sessionId !== browser.sessionId
          || !eligible(current)) continue;
        await deps.close(current);
        log.info("session-browser-cleanup", "Closed browser whose session is archived or deleted", {
          event: "session.browser.closed", sessionId: current.sessionId, browserSession: current.name,
        });
      } catch {
        log.warn("session-browser-cleanup", "Browser close failed; retrying on a later sweep", {
          event: "session.browser.close_failed", sessionId: browser.sessionId, browserSession: browser.name,
        });
      }
    }
  }
  return {
    sweep(): Promise<void> {
      if (disposed) return Promise.resolve();
      if (!running) running = run().catch(() => {
        log.warn("session-browser-cleanup", "Browser scan failed; leaving processes untouched", {
          event: "session.browser.scan_failed",
        });
      }).finally(() => { running = undefined; });
      return running;
    },
    dispose() { disposed = true; },
  };
}

/** Every daemon in the pidfile directory that proves ownership by an Aura session. */
export async function scanSessionBrowsers(
  directory = join(homedir(), ".agent-browser"),
  procRoot = "/proc",
  platform: NodeJS.Platform = process.platform,
): Promise<SessionBrowser[]> {
  if (platform !== "linux") return [];
  let names: string[];
  try { names = await readdir(directory); } catch { return []; }
  const browsers = await Promise.all(names.filter((name) => name.endsWith(".pid"))
    .map((name) => readSessionBrowser(name.slice(0, -4), directory, procRoot)));
  return browsers.filter((browser): browser is SessionBrowser => browser !== null);
}

export function startSessionBrowserCleanup(getSession: SessionBrowserCleanupDeps["getSession"]) {
  const directory = join(homedir(), ".agent-browser");
  const cleanup = createSessionBrowserCleanup({
    getSession,
    now: Date.now,
    read: (name) => readSessionBrowser(name, directory),
    scan: () => scanSessionBrowsers(directory),
    close: (browser) => closeSessionBrowser(browser),
  });
  const timer = setInterval(() => { void cleanup.sweep(); }, 60_000);
  timer.unref();
  return { dispose() { clearInterval(timer); cleanup.dispose(); } };
}
