/** A scan may only kill processes bearing its unique inherited ownership marker.
 * Scan /proc rather than following a leader PID: Chrome can outlive its daemon.
 */
import { lstatSync, readFileSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { isAgentBrowserExecutable, processStartTicks } from "../server/agent-browser-process.js";

export const SCAN_OWNER_ENV = "AURA_A11Y_SCAN_SESSION";
const SIDECARS = ["pid", "sock", "engine", "version", "stream"];

export function cleanupScanProcesses(session: string, directory: string, procRoot = "/proc", kill: (pid: number) => void = (pid) => process.kill(pid, "SIGKILL")): void {
  if (!/^aura-a11y-[a-zA-Z0-9-]+$/.test(session)) return;
  const identity = (pid: number): string | null => {
    try {
      const path = join(procRoot, String(pid));
      if (lstatSync(path).uid !== process.getuid?.()) return null;
      const env = readFileSync(join(path, "environ"), "utf8").split("\0");
      if (!env.includes(`${SCAN_OWNER_ENV}=${session}`)) return null;
      const exe = readlinkSync(join(path, "exe"));
      if (!isAgentBrowserExecutable(exe) && !/^(chrome|chromium|chromium-browser|chrome_crashpad_handler)$/.test(basename(exe.replace(/ \(deleted\)$/, "")))) return null;
      const ticks = processStartTicks(readFileSync(join(path, "stat"), "utf8"));
      return ticks ? `${exe}\0${ticks}` : null;
    } catch { return null; }
  };
  try {
    for (const name of readdirSync(procRoot)) {
      if (!/^\d+$/.test(name) || Number(name) <= 1) continue;
      const pid = Number(name);
      const before = identity(pid);
      if (!before || identity(pid) !== before) continue;
      try { kill(pid); } catch { /* exited or no longer signalable */ }
    }
  } catch { /* non-Linux: graceful close remains available */ }
  // Only the exact unique session's files, even when its leader has already exited.
  for (const ext of SIDECARS) {
    try { rmSync(join(directory, `${session}.${ext}`), { force: true }); } catch { /* best effort */ }
  }
}
