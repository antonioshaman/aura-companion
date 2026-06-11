import type { ServerWebSocket } from "bun";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SocketData } from "./ws-bridge.js";
import { COMPANION_HOME } from "./paths.js";
import { readProcessStartMs } from "./process-identity.js";
import {
  writeTerminalSidecar,
  deleteTerminalSidecar,
  argvSha256,
} from "./terminal-runtime-sidecar.js";

/** Bun's PTY terminal handle exposed on proc when spawned with `terminal` option */
interface BunTerminalHandle {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

interface TerminalInstance {
  id: string;
  cwd: string;
  containerId?: string;
  proc: ReturnType<typeof Bun.spawn>;
  terminal: BunTerminalHandle;
  browserSockets: Set<ServerWebSocket<SocketData>>;
  cols: number;
  rows: number;
  orphanTimer: ReturnType<typeof setTimeout> | null;
}

function resolveShell(): string {
  if (process.env.SHELL && existsSync(process.env.SHELL)) return process.env.SHELL;
  if (existsSync("/bin/bash")) return "/bin/bash";
  return "/bin/sh";
}

export class TerminalManager {
  private instances = new Map<string, TerminalInstance>();

  /**
   * `terminalsRoot` is where per-terminal provenance sidecars
   * (`<terminalId>.terminal.json`) live so the boot-reconcile reaper can
   * find PTYs stranded across a `KillMode=process` server restart.
   */
  constructor(private readonly terminalsRoot: string = join(COMPANION_HOME, "terminals")) {}

  /** Spawn a terminal in the given directory (host or container). */
  spawn(cwd: string, cols = 80, rows = 24, options?: { containerId?: string }): string {
    const id = randomUUID();
    const containerId = options?.containerId?.trim() || undefined;
    const sockets = new Set<ServerWebSocket<SocketData>>();
    const shell = resolveShell();
    const cmd = containerId
      ? [
          "docker",
          "exec",
          "-i",
          "-t",
          "-w",
          cwd,
          containerId,
          "sh",
          "-lc",
          "if command -v bash >/dev/null 2>&1; then exec bash -l; else exec sh -l; fi",
        ]
      : [shell, "-l"];

    const proc = Bun.spawn(cmd, {
      cwd: containerId ? undefined : cwd,
      env: { ...process.env, TERM: "xterm-256color", CLAUDECODE: undefined },
      terminal: {
        cols,
        rows,
        data: (_terminal, data) => {
          // Broadcast raw PTY output as binary to all connected browsers
          for (const ws of sockets) {
            try {
              ws.sendBinary(data);
            } catch {
              // socket may have closed
            }
          }
        },
        exit: () => {
          // PTY stream closed — get exit code from proc
          const inst = this.instances.get(id);
          if (inst) {
            const exitMsg = JSON.stringify({ type: "exit", exitCode: proc.exitCode ?? 0 });
            for (const ws of inst.browserSockets) {
              try {
                ws.send(exitMsg);
              } catch {
                // socket may have closed
              }
            }
          }
        },
      },
    });

    // Extract the terminal handle from the proc — Bun attaches it when spawned with `terminal` option
    const terminal = (proc as any).terminal as BunTerminalHandle;
    this.instances.set(id, {
      id,
      cwd,
      containerId,
      proc,
      terminal,
      browserSockets: sockets,
      cols,
      rows,
      orphanTimer: null,
    });
    console.log(
      `[terminal] Spawned terminal ${id} in ${cwd}${containerId ? ` (container ${containerId.slice(0, 12)})` : ""} (${containerId ? "docker-shell" : shell}, ${cols}x${rows})`,
    );

    // Best-effort provenance sidecar — restart-survival only. The in-memory
    // orphanTimer still covers the live case; a failed write must NOT abort
    // the spawn. `pid` is the host process (host shell OR host-side docker-
    // exec client — FLAG B). `processStartMs` closes PID-reuse across
    // restarts; null (non-Linux / unreadable) → skip the sidecar entirely.
    try {
      const processStartMs = readProcessStartMs(proc.pid);
      if (processStartMs !== null) {
        writeTerminalSidecar(this.terminalsRoot, {
          schemaVersion: 1,
          terminalId: id,
          pid: proc.pid,
          processStartMs,
          argvSha256: argvSha256(cmd),
          kind: containerId ? "docker" : "host",
        });
      }
    } catch (e) {
      console.warn(`[terminal] sidecar write failed for ${id}: ${(e as Error).message}`);
    }

    // Handle process exit
    proc.exited.then((exitCode) => {
      const inst = this.instances.get(id);
      if (!inst) return;
      console.log(`[terminal] Terminal ${id} exited with code ${exitCode}`);
      this.cleanupInstance(id);
    });

    return id;
  }

  private getTerminalIdFromSocket(ws: ServerWebSocket<SocketData>): string | null {
    const data = ws.data;
    if (data.kind !== "terminal") return null;
    return data.terminalId;
  }

  private cleanupInstance(terminalId: string): void {
    const inst = this.instances.get(terminalId);
    if (!inst) return;
    if (inst.orphanTimer) clearTimeout(inst.orphanTimer);
    this.instances.delete(terminalId);
    deleteTerminalSidecar(this.terminalsRoot, terminalId);
  }

  /** Handle a message from a browser WebSocket */
  handleBrowserMessage(ws: ServerWebSocket<SocketData>, msg: string | Buffer): void {
    const terminalId = this.getTerminalIdFromSocket(ws);
    if (!terminalId) return;
    const inst = this.instances.get(terminalId);
    if (!inst) return;
    try {
      const str = typeof msg === "string" ? msg : msg.toString();
      const parsed = JSON.parse(str);
      if (parsed.type === "input" && typeof parsed.data === "string") {
        inst.terminal.write(parsed.data);
      } else if (parsed.type === "resize" && typeof parsed.cols === "number" && typeof parsed.rows === "number") {
        this.resize(terminalId, parsed.cols, parsed.rows);
      }
    } catch {
      // Malformed message, ignore
    }
  }

  /** Resize the PTY */
  resize(terminalId: string, cols: number, rows: number): void {
    const inst = this.instances.get(terminalId);
    if (!inst) return;
    inst.cols = cols;
    inst.rows = rows;
    try {
      inst.terminal.resize(cols, rows);
    } catch {
      // resize not available or failed
    }
  }

  private killInstance(inst: TerminalInstance): void {
    if (inst.orphanTimer) clearTimeout(inst.orphanTimer);
    this.instances.delete(inst.id);
    deleteTerminalSidecar(this.terminalsRoot, inst.id);

    try {
      inst.proc.kill();
    } catch {
      // process may have already exited
    }

    // SIGKILL fallback if SIGTERM doesn't work within 2 seconds
    const pid = inst.proc.pid;
    setTimeout(() => {
      try {
        process.kill(pid, 0); // check if still alive
        inst.proc.kill(9); // SIGKILL
      } catch {
        // already dead, good
      }
    }, 2_000);

    console.log(`[terminal] Killed terminal ${inst.id}`);
  }

  /** Kill one terminal instance. */
  kill(terminalId: string): void {
    const inst = this.instances.get(terminalId);
    if (!inst) return;
    this.killInstance(inst);
  }

  /** Get current terminal info */
  getInfo(terminalId?: string): { id: string; cwd: string; containerId?: string } | null {
    if (terminalId) {
      const inst = this.instances.get(terminalId);
      if (!inst) return null;
      return { id: inst.id, cwd: inst.cwd, containerId: inst.containerId };
    }
    const first = this.instances.values().next().value as TerminalInstance | undefined;
    if (!first) return null;
    return { id: first.id, cwd: first.cwd, containerId: first.containerId };
  }

  // ─── reclamation seam (resource-reclamation plan Task 4) ──────────────────
  //
  // The cleanup subsystem queries + acts on terminals through these public
  // methods rather than reaching into the private `instances` Map. `has` feeds
  // the terminal reaper's `isLocallyTracked` guard so a periodic reconcile
  // never SIGTERMs a terminal this process still owns.

  /** Whether the current process still tracks this terminal in-memory. */
  has(terminalId: string): boolean {
    return this.instances.has(terminalId);
  }

  /** All terminalIds the current process tracks — feeds `isLocallyTracked`. */
  activeTerminalIds(): string[] {
    return [...this.instances.keys()];
  }

  /**
   * In-process reclamation candidates: live terminals with NO browser socket
   * attached. These are the same population the per-terminal 5s `orphanTimer`
   * targets — this method is the backstop the cleanup scheduler can sweep when
   * a timer was cleared by a reconnect that then closed without re-arming.
   */
  getReclaimableTerminals(): string[] {
    const ids: string[] = [];
    for (const inst of this.instances.values()) {
      if (inst.browserSockets.size === 0) ids.push(inst.id);
    }
    return ids;
  }

  /**
   * Public reap of one terminal. Delegates to the same teardown as `kill`
   * (SIGTERM → 2s → SIGKILL, sidecar deleted). Returns whether a terminal was
   * present to act on, so the scheduler can count reclaimed terminals.
   */
  reapTerminal(terminalId: string): boolean {
    const inst = this.instances.get(terminalId);
    if (!inst) return false;
    this.killInstance(inst);
    return true;
  }

  /** Attach a browser WebSocket to the terminal */
  addBrowserSocket(ws: ServerWebSocket<SocketData>): void {
    const terminalId = this.getTerminalIdFromSocket(ws);
    if (!terminalId) return;
    const inst = this.instances.get(terminalId);
    if (!inst) return;

    // Cancel orphan kill timer if any
    if (inst.orphanTimer) {
      clearTimeout(inst.orphanTimer);
      inst.orphanTimer = null;
    }

    inst.browserSockets.add(ws);
  }

  /** Remove a browser WebSocket from the terminal */
  removeBrowserSocket(ws: ServerWebSocket<SocketData>): void {
    const terminalId = this.getTerminalIdFromSocket(ws);
    if (!terminalId) return;
    const inst = this.instances.get(terminalId);
    if (!inst) return;
    inst.browserSockets.delete(ws);

    // If no browsers remain, start a grace timer to kill the orphaned terminal
    if (inst.browserSockets.size === 0) {
      const id = inst.id;
      inst.orphanTimer = setTimeout(() => {
        const alive = this.instances.get(id);
        if (alive && alive.browserSockets.size === 0) {
          console.log(`[terminal] No browsers connected, killing orphaned terminal ${id}`);
          this.kill(id);
        }
      }, 5_000);
    }
  }
}
