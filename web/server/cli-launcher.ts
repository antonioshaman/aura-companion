import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  existsSync,
  copyFileSync,
  cpSync,
  realpathSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Subprocess } from "bun";
import type { SessionStore } from "./session-store.js";
import type { BackendType } from "./session-types.js";
import type { RecorderManager } from "./recorder.js";
import { CodexAdapter } from "./codex-adapter.js";
import { resolveBinary, getEnrichedPath } from "./path-resolver.js";
import { resolveObserverPromptForSpawn } from "./observer-prompt-spawn.js";
import { assertExhaustiveObserverPromptSource } from "./observer-prompt.js";
import { log } from "./logger.js";
import { verifyProcessIdentity, readProcessStartMs } from "./process-identity.js";
// AURA-LOCAL — PLAN T7. Per-session runtime sidecar carrying spawn-time
// pid + processStartMs + argvSha256. Phase D upgrades the boot probe
// from Phase A's interim two-factor to three-factor and feeds the
// orphan-reaper's PID-reuse classification.
import {
  SIDECAR_SCHEMA_VERSION,
  argvSha256,
  readRuntimeSidecar,
  writeRuntimeSidecar,
} from "./cli-runtime-sidecar.js";
import {
  OBSERVER_ALLOWED_TOOLS,
  OBSERVER_DISALLOWED_TOOLS,
  OBSERVER_PERMISSION_MODE,
} from "./observer-permissions.js";
import { containerManager } from "./container-manager.js";
import { companionBus } from "./event-bus.js";
import type { RelaunchExhaustedReason } from "./event-bus-types.js";
import { selectLaunchableCodexModel } from "./codex-models.js";
import { getSuppressedModelIds } from "./model-availability.js";
import {
  getLegacyCodexHome,
  resolveCompanionCodexSessionHome,
} from "./codex-home.js";

/** Whether WebSocket transport is enabled for Codex sessions. */
function isCodexWsTransportEnabled(): boolean {
  const val = (process.env.COMPANION_CODEX_TRANSPORT || "ws").toLowerCase();
  return val === "ws" || val === "websocket";
}

/** Find a free TCP port in the given range by attempting to listen on each. */
async function findFreePort(
  start = 4500,
  end = 4600,
  isReserved?: (port: number) => boolean,
): Promise<number> {
  for (let port = start; port <= end; port++) {
    if (isReserved?.(port)) continue;
    try {
      const server = Bun.listen({
        hostname: "127.0.0.1",
        port,
        socket: {
          data() {},
          open() {},
          close() {},
        },
      });
      server.stop(true);
      return port;
    } catch {
      // Port in use, try next
    }
  }
  throw new Error(`No free port found in range ${start}-${end}`);
}

function sanitizeSpawnArgsForLog(args: string[]): string {
  const secretKeyPattern = /(token|key|secret|password)/i;
  const out = [...args];
  for (let i = 0; i < out.length; i++) {
    if (out[i] === "-e" && i + 1 < out.length) {
      const envPair = out[i + 1];
      const eqIdx = envPair.indexOf("=");
      if (eqIdx > 0) {
        const k = envPair.slice(0, eqIdx);
        if (secretKeyPattern.test(k)) {
          out[i + 1] = `${k}=***`;
        }
      }
    }
  }
  return out.join(" ");
}

const CODEX_WS_PROXY_PATH = fileURLToPath(new URL("./codex-ws-proxy.cjs", import.meta.url));
const CODEX_CONTAINER_WS_PORT = Number(process.env.COMPANION_CODEX_CONTAINER_WS_PORT || "4502");

export interface SdkSessionInfo {
  sessionId: string;
  pid?: number;
  state: "starting" | "connected" | "running" | "exited";
  exitCode?: number | null;
  model?: string;
  permissionMode?: string;
  cwd: string;
  createdAt: number;
  /** The CLI's internal session ID (from system.init), used for --resume */
  cliSessionId?: string;
  archived?: boolean;
  /** User-facing session name */
  name?: string;
  /** Which backend this session uses */
  backendType?: BackendType;
  /** Git branch from bridge state (enriched by REST API) */
  gitBranch?: string;
  /** Git ahead count (enriched by REST API) */
  gitAhead?: number;
  /** Git behind count (enriched by REST API) */
  gitBehind?: number;
  /** Total lines added (enriched by REST API) */
  totalLinesAdded?: number;
  /** Total lines removed (enriched by REST API) */
  totalLinesRemoved?: number;
  /** Whether internet/web search is enabled for Codex sessions */
  codexInternetAccess?: boolean;
  /** Sandbox mode selected for Codex sessions */
  codexSandbox?: "workspace-write" | "danger-full-access";
  /** If this session was spawned by a cron job */
  cronJobId?: string;
  /** Human-readable name of the cron job that spawned this session */
  cronJobName?: string;
  /** If session was created from an existing Claude thread/session. */
  resumeSessionAt?: string;
  /** Whether the resumed session used --fork-session. */
  forkSession?: boolean;
  /** Codex models that this account/session has already rejected. */
  rejectedCodexModels?: string[];
  /** If this session was spawned by an agent */
  agentId?: string;
  /** Human-readable name of the agent that spawned this session */
  agentName?: string;
  /** Sandbox profile slug used for this session */
  sandboxSlug?: string;

  // Codex WebSocket transport fields
  /** Port used for Codex WebSocket transport (host mode). */
  codexWsPort?: number;
  /** Full WebSocket URL for the Codex app-server. */
  codexWsUrl?: string;

  // Container fields
  /** Docker container ID when session runs inside a container */
  containerId?: string;
  /** Docker container name */
  containerName?: string;
  /** Docker image used for the container */
  containerImage?: string;
  /** Runtime cwd inside container for agent RPC calls (e.g. "/workspace"). */
  containerCwd?: string;

  // ── Council Mode pairing ──────────────────────────────────────────────────
  /** Server-generated group id when this session is part of a Council pair. */
  sessionGroupId?: string;
  /** Role within the Council pair. */
  sessionGroupRole?: import("./session-types.js").SessionGroupRole;
  /** SHA-256 of the observer system-prompt artifact at spawn time
   *  (observer role only). Used by the recorder + invocation log so a
   *  forensic re-run can identify which prompt revision the model saw. */
  observerPromptSha256?: string;
  /**
   * Provenance of the observer prompt resolved at spawn time:
   * - `"workspace"` — loaded from `<cwd>/.council/prompts/observer-system.md`
   * - `"bundled"` — workspace file absent (ENOENT); fell back to the
   *    bundled artifact shipped with aura-companion
   * (Council Plan PLAN-aura-observer-prompt-bundled-fallback.md Task 4)
   *
   * Consumers (recorder attribution, EC-9 invocation log, UI provenance
   * display, replay determinism) MUST distinguish on THIS field rather
   * than infer from `observerPromptSha256` alone — the two can coincide
   * if a workspace copies the bundled body verbatim, but the policy
   * intent (custom override vs default) is the same the field reflects.
   */
  observerPromptSource?: "workspace" | "bundled";
  /**
   * Schema version parsed from the observer prompt's header sentinel at
   * spawn time (`<!-- observer-system-prompt vN -->`). Council Review
   * 2026-05-15-1015 CR-13 (Willison W1): forward-compat for v2 migration —
   * recordings and EC-9 logs need this to distinguish observer behaviour
   * across schema bumps, otherwise the corpus silently mixes v1 and v2
   * evidence and the deterministic-regression-test property is lost.
   */
  observerPromptVersion?: number;
}

export interface LaunchOptions {
  model?: string;
  permissionMode?: string;
  cwd?: string;
  claudeBinary?: string;
  codexBinary?: string;
  allowedTools?: string[];
  /** Tools to explicitly forbid (Council Mode observer profile). Maps to
   *  `--disallowedTools` on Claude argv; Codex tool restrictions are
   *  driven by the role's system-prompt artifact rather than CLI flags. */
  disallowedTools?: string[];
  /** When set, Claude `--resume <id>` is passed to restore conversation
   *  context on relaunch. Internal to launcher relaunch path. */
  resumeSessionId?: string;
  env?: Record<string, string>;
  backendType?: BackendType;
  /** Codex sandbox mode. */
  codexSandbox?: "workspace-write" | "danger-full-access";
  /** Whether Codex internet/web search should be enabled for this session. */
  codexInternetAccess?: boolean;
  /** Optional override for CODEX_HOME used by Codex sessions. */
  codexHome?: string;
  /** Docker container ID — when set, CLI runs inside container via docker exec */
  containerId?: string;
  /** Docker container name */
  containerName?: string;
  /** Docker image used for the container */
  containerImage?: string;
  /** Runtime cwd inside the container (typically "/workspace"). */
  containerCwd?: string;
  /** Start from a specific prior Claude session/thread point. */
  resumeSessionAt?: string;
  /** Fork a new Claude session when resuming from prior context. */
  forkSession?: boolean;
  /** Optional system prompt to inject into Codex sessions (e.g. Linear context). */
  systemPrompt?: string;
  /** Sandbox profile slug used for this session */
  sandboxSlug?: string;
  /** Council Mode — group this session belongs to, if any. */
  sessionGroupId?: string;
  /** Council Mode — role within the group. The observer role does NOT alter
   *  spawn argv in this commit; it tags the SdkSessionInfo so the bridge can
   *  route observer-specific messages on first WS attach. Spawn-time system
   *  prompt injection is the follow-up commit. */
  sessionGroupRole?: import("./session-types.js").SessionGroupRole;
  /** Task 11 — recordings exclusion. Defaults to `true` (recorded). Set
   *  to `false` for short-lived auth-probe spawns (Codex smoke check,
   *  MAX 20x tier verification) so their init frames — which carry the
   *  raw token before any redactor sees it — never reach disk. The
   *  launcher disables the recorder for this sessionId before the
   *  adapter wires its first `record()` call. */
  record?: boolean;
}

/**
 * Manages CLI backend processes (Claude Code via --sdk-url WebSocket,
 * or Codex via app-server stdio/WebSocket).
 */
export class CliLauncher {
  private sessions = new Map<string, SdkSessionInfo>();
  private processes = new Map<string, Subprocess>();
  /** Sidecar Node proxy processes used by Codex WebSocket transport. */
  private codexWsProxies = new Map<string, Subprocess>();
  /** Host-mode Codex WS listen ports currently reserved by active sessions. */
  private claimedCodexWsPorts = new Set<number>();
  /** Account- or runtime-rejected Codex models, remembered per session to avoid retry loops. */
  private rejectedCodexModels = new Map<string, Set<string>>();
  /** Runtime-only env vars per session (kept out of persisted launcher state). */
  private sessionEnvs = new Map<string, Record<string, string>>();
  private port: number;
  private store: SessionStore | null = null;
  private recorder: RecorderManager | null = null;
  constructor(port: number) {
    this.port = port;
  }

  /** Attach a persistent store for surviving server restarts. */
  setStore(store: SessionStore): void {
    this.store = store;
  }

  /** Attach a recorder for raw message capture. */
  setRecorder(recorder: RecorderManager): void {
    this.recorder = recorder;
  }

  /** Persist launcher state to disk. */
  private persistState(): void {
    if (!this.store) return;
    const data = Array.from(this.sessions.values());
    this.store.saveLauncher(data);
  }

  private syncRejectedCodexModels(sessionId: string, rejected: Set<string>): void {
    const next = Array.from(rejected);
    if (next.length === 0) {
      this.rejectedCodexModels.delete(sessionId);
    } else {
      this.rejectedCodexModels.set(sessionId, new Set(next));
    }
    const info = this.sessions.get(sessionId);
    if (!info) return;
    if (next.length === 0) {
      delete info.rejectedCodexModels;
      return;
    }
    info.rejectedCodexModels = next;
  }

  private resolveCodexLaunchModel(
    sessionId: string,
    requestedModel: string | undefined,
  ): { ok: true; model: string; fallbackFrom?: string } | { ok: false; error: string } {
    const info = this.sessions.get(sessionId);
    // Union the per-session runtime rejections with the registry's
    // suppressed (`retired`/`blocked`) Codex slugs (Task 4). Precedence is a
    // pure union: a model forbidden by EITHER source is excluded — neither can
    // resurrect what the other forbids. An empty union flows through unchanged;
    // if it eliminates every candidate, `selectLaunchableCodexModel` returns
    // `unavailable` and the caller keeps the live session (no-kill abort).
    const rejected = Array.from(
      new Set([
        ...(this.rejectedCodexModels.get(sessionId) ?? info?.rejectedCodexModels ?? []),
        ...getSuppressedModelIds("codex"),
      ]),
    );
    const selection = selectLaunchableCodexModel(requestedModel, { rejectModels: rejected });
    if (selection.kind === "unavailable") {
      return { ok: false, error: selection.message };
    }
    return {
      ok: true,
      model: selection.model.slug,
      fallbackFrom: selection.fallbackFrom,
    };
  }

  /**
   * Council review P1 #1 — spawn-generation guard.
   *
   * Codex sessions can be re-spawned in place under the SAME `sessionId`
   * (fallback-respawn after an init error, or `relaunch()`), which replaces
   * the entry in `this.processes`. The OLD generation's `proc.exited` /
   * `onInitError` handlers still fire afterwards when the old subprocess is
   * SIGTERM'd. Without this guard those stale handlers would set
   * `state = "exited"`, delete the (now newer) map entries, persist, and
   * emit `session:exited` — clobbering the live replacement process and
   * triggering a false degraded / orphaned-process scenario.
   *
   * A handler is "superseded" when this session's `processes` slot no longer
   * holds the process the handler was created for. Superseded handlers must
   * clean up only their OWN transport and never touch shared session state.
   */
  private isSupersededGeneration(sessionId: string, ownProc: Subprocess): boolean {
    return this.processes.get(sessionId) !== ownProc;
  }

  private markCodexModelRejected(sessionId: string, model: string | undefined): void {
    if (!model) return;
    const info = this.sessions.get(sessionId);
    const next = new Set(this.rejectedCodexModels.get(sessionId) ?? info?.rejectedCodexModels ?? []);
    next.add(model);
    this.syncRejectedCodexModels(sessionId, next);
  }

  private isCodexModelAvailabilityError(error: string): boolean {
    return /model/i.test(error) && /(available|unsupported|access|account|not found|rejected)/i.test(error);
  }

  /**
   * AURA-LOCAL — PLAN T7/T8. Route EVERY "skip relaunch" early-return in
   * `relaunch()` through this helper. The four required mutations:
   *
   *   1. `info.pid = undefined` — the stale PID was the head of the
   *      live-symptom chain (boot probe + auto-relaunch treating the
   *      reused PID as "ours"). Nulling it terminates the chain.
   *   2. `info.state = "exited"` — gives the orchestrator, idle-timer,
   *      eviction sweep, and group-reconnect listeners a coherent
   *      shared view.
   *   3. `persistState()` — debounced disk write. The persist call
   *      fires BEFORE the caller's `return`, so a crash inside the
   *      caller between mutate and return doesn't lose the state
   *      update.
   *   4. `companionBus.emit("session:relaunch-exhausted", ...)` — Phase F
   *      drain-dispatch reads this to fire the `cli_failed` browser
   *      frame + clear pending message queues. Distinct from
   *      `session:relaunch-failed` (which fires on ANY relaunch
   *      failure, transient + structural); this channel is the
   *      narrower "permanent loss" subset.
   *
   *      Phase F (PLAN T10+T11) wiring: the `WsBridge` constructor
   *      subscribes to this event and routes each fire through
   *      `WsBridge.dispatchCliFailedDrain`, which builds the
   *      `cli_failed` frame via `buildCliFailedFrame`
   *      (`cli-failed-frame.ts`, AP-14 sole assembly site) and
   *      executes the inline 4-step dispatch (snapshot pendingMsgs
   *      length -> clear + persist BEFORE broadcast per Persistence
   *      R7 -> broadcastToBrowsers -> recordCleanupEvent
   *      "drained_pending"). The reason argument here is mapped to
   *      the closed `CliFailedReason` union by
   *      `mapClearReasonToCliFailedReason` in ws-bridge.ts:
   *        - container_missing             -> container_missing
   *        - container_start_failed        -> container_stopped
   *        - container_binary_missing      -> binary_missing
   *        - observer_prompt_config_failed -> relaunch_exhausted
   *        - observer_prompt_source_drift_refused -> relaunch_exhausted
   *      `subprocessAlive: false` for every reason here — the
   *      structural failure means the CLI is permanently dead.
   *
   * EC-19 floor: every `return { ok: false, ... }` in `relaunch()` MUST
   * be preceded by a `clearPidAndPersist(sessionId, reason)` call. The
   * matching static-grep canary in `cli-launcher.test.ts` (
   * `EC-19 — clearPidAndPersist routing in relaunch()`) enforces this
   * at test time via regex-anchored brace-counted body extraction.
   *
   * NOT called on the `return { ok: true }` success path — that path
   * leaves `state="starting"` for the spawn handshake. Also NOT called
   * on the very first `if (!info) return` (session missing entirely;
   * no state to mutate).
   */
  private clearPidAndPersist(sessionId: string, reason: RelaunchExhaustedReason): void {
    const info = this.sessions.get(sessionId);
    if (!info) {
      // Defensive: caller already filtered out the "session not found"
      // case; structural arrival here means a race. Log + bail.
      log.warn("cli-launcher", "clearPidAndPersist: session vanished mid-relaunch", {
        event: "cli_launcher.clear_pid.missing_session",
        sessionId,
        reason,
      });
      return;
    }
    info.pid = undefined;
    info.state = "exited";
    if (info.exitCode == null) info.exitCode = 1;
    this.persistState();
    companionBus.emit("session:relaunch-exhausted", { sessionId, reason });
    log.info("cli-launcher", "relaunch path cleared; pid nulled and session marked exited", {
      event: "cli_launcher.relaunch_exhausted",
      sessionId,
      reason,
    });
  }

  /**
   * AURA-LOCAL — PLAN T7. Persist the per-session runtime sidecar
   * (`<sessionId>.runtime.json`) right after `Bun.spawn` returns so the
   * spawn-time anchor (pid + processStartMs + argv hash) is durable.
   * Boot recovery reads this on the next restart; the orphan reaper
   * reads it to authoritatively classify PPID=1 candidates.
   *
   * Errors are logged but DO NOT fail the spawn — the sidecar is
   * forensic forward-recovery, not a hard prerequisite. The boot probe
   * degrades to the Phase A two-factor path when a session has no
   * sidecar (still strictly stronger than the bare `kill(pid, 0)`).
   */
  private writeRuntimeSidecarForSpawn(
    sessionId: string,
    pid: number,
    argv: readonly string[],
  ): void {
    if (!this.store) return;
    try {
      // EC-49 — anchor on the KERNEL start instant (same quantity the
      // verifier reads from /proc/<pid>/stat field-22), not Date.now().
      // The JS wallclock and the kernel clock-of-record diverge under a
      // GC pause / event-loop stall / cgroup MemoryHigh throttle between
      // fork and this read, which can exceed the verifier's ±2s window
      // and false-flag a live session as mismatch(starttime) — precisely
      // under the memory pressure where boot recovery matters most.
      // Fall back to Date.now() only when the kernel read is unavailable
      // (non-Linux), where the starttime factor is skipped anyway.
      const kernelStartMs = readProcessStartMs(pid);
      writeRuntimeSidecar(this.store.directory, sessionId, {
        schemaVersion: SIDECAR_SCHEMA_VERSION,
        pid,
        processStartMs: kernelStartMs ?? Date.now(),
        argvSha256: argvSha256(argv),
      });
    } catch (e) {
      log.warn("cli-launcher", "runtime sidecar write failed", {
        event: "cli_launcher.sidecar_write_failed",
        sessionId,
        error_code: (e as NodeJS.ErrnoException).code ?? "unknown",
      });
    }
  }

  /**
   * EC-45 — decide whether the relaunch path may SIGTERM `info.pid`, a PID
   * inherited from a previous server instance (no live in-process handle).
   *
   * The asymmetry favours NOT killing when identity cannot be positively
   * confirmed: a skipped kill leaks an orphan the next-boot reaper
   * reclaims, but a wrong kill SIGTERMs an unrelated process that reused
   * the PID. So:
   *   • Claude on Linux → run the three-factor probe. `match` → kill;
   *     `mismatch`/`gone` → SKIP (the PID is not ours / already dead).
   *   • `unavailable` (non-Linux, no /proc) → kill best-effort: identity is
   *     unknowable and there is no stronger signal than the prior behaviour.
   *   • Codex host-mode → kill best-effort: the argv factor recognises only
   *     Claude's `--sdk-url` token, so the probe can't verify Codex; a
   *     Codex argv/port identity factor is future work.
   */
  private shouldSignalPreviousInstancePid(info: SdkSessionInfo): boolean {
    if (typeof info.pid !== "number") return false;
    // Codex has no argv identity factor — preserve prior best-effort kill.
    if (info.backendType === "codex") return true;
    let expectedStartMs: number | null = null;
    if (this.store) {
      try {
        const sidecar = readRuntimeSidecar(this.store.directory, info.sessionId);
        if (sidecar.kind === "present") expectedStartMs = sidecar.payload.processStartMs;
      } catch {
        // Corrupt/absent sidecar → degrade to the two-factor probe
        // (liveness + argv), still strictly stronger than a blind kill.
      }
    }
    const verdict = verifyProcessIdentity(info.pid, info.sessionId, expectedStartMs);
    switch (verdict.kind) {
      case "match":
        return true;
      case "unavailable":
        return true; // identity unknowable off-Linux — best-effort kill
      case "mismatch":
        log.warn("cli-launcher", "relaunch declined to SIGTERM a PID-reuse mismatch", {
          event: "relaunch.kill_declined",
          sessionId: info.sessionId,
          pid: info.pid,
          reason: verdict.reason,
        });
        return false;
      case "gone":
        return false; // already dead — nothing to signal
    }
  }

  private claimCodexWsPort(port: number): void {
    this.claimedCodexWsPorts.add(port);
  }

  private releaseCodexWsPort(info: SdkSessionInfo | undefined): void {
    if (!info || info.containerId) return;
    if (typeof info.codexWsPort !== "number") return;
    this.claimedCodexWsPorts.delete(info.codexWsPort);
    info.codexWsPort = undefined;
    info.codexWsUrl = undefined;
  }

  /**
   * Restore sessions from disk and check which PIDs are still alive.
   * Returns the number of recovered sessions.
   */
  restoreFromDisk(): number {
    if (!this.store) return 0;
    const data = this.store.loadLauncher<SdkSessionInfo[]>();
    if (!data || !Array.isArray(data)) return 0;

    let recovered = 0;
    for (const info of data) {
      if (this.sessions.has(info.sessionId)) continue;
      if (info.backendType === "codex" && Array.isArray(info.rejectedCodexModels)) {
        this.syncRejectedCodexModels(info.sessionId, new Set(info.rejectedCodexModels));
      }

      // Check if the process is still alive
      if (info.state !== "exited") {
        if (info.containerId) {
          // Any containerized session (Codex Docker-WS OR Claude): the
          // stored PID is the HOST-side `docker exec` wrapper, never the
          // in-container CLI. The argv identity factor is structurally
          // unable to verify a `docker exec -i … bash -lc 'claude --sdk-url …'`
          // wrapper (the --sdk-url token is buried inside the single
          // bash -lc string arg → indexOf returns -1 → false mismatch →
          // relaunch storm). Container liveness is the only valid signal
          // for both backends. (Previously gated on `&& info.codexWsPort`,
          // which let containerized Claude fall through to the PID probe.)
          const containerState = containerManager.isContainerAlive(info.containerId);
          if (containerState === "running") {
            info.state = "starting";
            this.sessions.set(info.sessionId, info);
            recovered++;
          } else {
            info.state = "exited";
            info.exitCode = -1;
            this.sessions.set(info.sessionId, info);
          }
        } else if (info.pid) {
          // PLAN T3 (Phase A) + T7 (Phase D): three-factor identity
          // probe — closes the live symptom where alive subprocesses
          // don't match Map `pid` fields (PID reuse → false-positive
          // liveness → relaunch storm).
          //
          // Phase D: the runtime sidecar (`<sessionId>.runtime.json`)
          // carries the spawn-time `processStartMs` anchor. The boot
          // probe loads it AND passes the anchor into
          // `verifyProcessIdentity` so the third factor (starttime
          // ±2s) engages. Closes PID-reuse-across-reboot which the
          // Phase A interim two-factor (liveness + argv) couldn't.
          //
          // When the sidecar is absent (Phase A-era sessions migrating
          // forward; sidecar write failed at spawn time), we degrade
          // to the Phase A two-factor — still strictly stronger than
          // the bare `process.kill(pid, 0)` it replaces.
          //
          // On `unavailable` (macOS dev box, no /proc) the helper emits
          // a one-time boot WARN and we conservatively trust the old
          // liveness-only check — degraded but no worse than today.
          //
          // Dual-backend contract: the probe's argv factor recognizes only
          // Claude's `--sdk-url ws/cli/<sessionId>` token. Host-mode Codex
          // (`app-server`, no `--sdk-url`) would always fail that factor →
          // false `mismatch` → a live Codex app-server reaped on every
          // restart (regression vs the prior bare `process.kill`). Route
          // Codex host-mode through the liveness-only fallback; the identity
          // probe is Claude-only until a Codex argv/port identity lands.
          let expectedStartMs: number | null = null;
          if (this.store && info.backendType !== "codex") {
            try {
              const sidecar = readRuntimeSidecar(this.store.directory, info.sessionId);
              if (sidecar.kind === "present") {
                expectedStartMs = sidecar.payload.processStartMs;
              }
            } catch (e) {
              // Corrupt sidecar — degrade to two-factor probe but log
              // structurally so operators see the corruption. Sibling
              // shape to the observer-prompt loader's ENOENT-vs-malformed
              // contract.
              log.warn("cli-launcher", "runtime sidecar load failed — degrading to two-factor probe", {
                event: "boot_probe.sidecar_corrupt",
                sessionId: info.sessionId,
                error_code: (e as NodeJS.ErrnoException).code ?? "unknown",
              });
            }
          }
          const verdict =
            info.backendType === "codex"
              ? null
              : verifyProcessIdentity(info.pid, info.sessionId, expectedStartMs);
          if (verdict && verdict.kind === "match") {
            info.state = "starting"; // WS not yet re-established, wait for CLI to reconnect
            this.sessions.set(info.sessionId, info);
            recovered++;
          } else if (!verdict || verdict.kind === "unavailable") {
            // Codex host-mode OR non-Linux fallback: legacy liveness-only probe.
            try {
              process.kill(info.pid, 0);
              info.state = "starting";
              this.sessions.set(info.sessionId, info);
              recovered++;
            } catch {
              info.state = "exited";
              info.exitCode = -1;
              this.sessions.set(info.sessionId, info);
            }
          } else {
            // "gone" | "mismatch" → not the process we spawned.
            if (verdict.kind === "mismatch") {
              log.warn("cli-launcher", "Boot probe rejected PID reuse / argv mismatch", {
                event: "boot_probe.mismatch",
                sessionId: info.sessionId,
                pid: info.pid,
                reason: verdict.reason,
              });
            }
            info.state = "exited";
            info.exitCode = -1;
            this.sessions.set(info.sessionId, info);
          }
        } else {
          this.sessions.set(info.sessionId, info);
        }
      } else {
        // Already exited
        this.sessions.set(info.sessionId, info);
      }

      // Avoid reusing ports already owned by recovered host-mode Codex sessions.
      if (
        info.backendType === "codex"
        && !info.containerId
        && info.state !== "exited"
        && typeof info.codexWsPort === "number"
      ) {
        this.claimCodexWsPort(info.codexWsPort);
      }
    }
    if (recovered > 0) {
      console.log(`[cli-launcher] Recovered ${recovered} live session(s) from disk`);
    }
    return recovered;
  }

  /**
   * Launch a new CLI session (Claude Code or Codex).
   */
  launch(options: LaunchOptions = {}): SdkSessionInfo {
    const sessionId = randomUUID();
    // Council Plan Bug B Review P1 #2 — for council-role sessions
    // (orchestrator/observer), an explicit `cwd` is REQUIRED. The prior
    // `options.cwd || process.cwd()` default silently fired the
    // bundled-fallback under Docker (`cwd=/app`, no `.council/prompts/`)
    // because by the time `buildObserverSpawnOverrides` ran (formerly
    // `applyCouncilObserverSpawnConfig`), `info.cwd` was already populated
    // and its "no-workspace-cwd" branch
    // was structurally unreachable. Fail-loud here closes the silent-
    // bundled trap. Solo (non-council) sessions retain the
    // `process.cwd()` default — they're not subject to the bundled-prompt
    // fallback path and the default is operationally useful for
    // single-shot launches.
    if (options.sessionGroupRole && !options.cwd) {
      throw new Error(
        `cli-launcher.launch: explicit cwd is required for council-role sessions (role=${options.sessionGroupRole}); refusing to fall back to process.cwd()`,
      );
    }
    const cwd = options.cwd || process.cwd();
    const backendType = options.backendType || "claude";
    let launchModel = options.model;

    if (backendType === "codex") {
      // Best-effort verified-model selection: when the models cache is present
      // we upgrade to a known-launchable slug; when it's absent/unavailable
      // (codex never run, fresh machine, CI) we pass the requested model
      // through rather than blocking the spawn. The hard validate-before-kill
      // gate lives on the relaunch path (P1 #2), where a LIVE process is at
      // risk — an initial launch has nothing to strand, so failing loud here
      // would only break fresh-account/CI launches for no protective benefit.
      const resolved = this.resolveCodexLaunchModel(sessionId, options.model);
      if (resolved.ok) {
        launchModel = resolved.model;
      }
      this.syncRejectedCodexModels(sessionId, new Set());
    }

    const info: SdkSessionInfo = {
      sessionId,
      state: "starting",
      model: launchModel,
      permissionMode: options.permissionMode,
      cwd,
      createdAt: Date.now(),
      backendType,
    };

    if (options.resumeSessionAt) {
      info.resumeSessionAt = options.resumeSessionAt;
      info.forkSession = options.forkSession === true;
    }

    // Council Mode — persist group identity into the SdkSessionInfo so
    // sidebar/store/restart-reconciliation can read the role without
    // re-deriving from coordinator state. Observer system-prompt injection
    // at spawn argv is deferred to a follow-up commit; for now the observer
    // subprocess starts as a plain CLI session and receives its role via
    // the first WS user-message sent by the bridge on checkpoint arrival.
    if (options.sessionGroupId) {
      info.sessionGroupId = options.sessionGroupId;
    }
    if (options.sessionGroupRole) {
      info.sessionGroupRole = options.sessionGroupRole;
    }

    if (backendType === "codex") {
      info.codexInternetAccess = options.codexInternetAccess === true;
      info.codexSandbox = options.codexSandbox;
    }

    // Store sandbox slug if provided
    if (options.sandboxSlug) {
      info.sandboxSlug = options.sandboxSlug;
    }

    // Store container metadata if provided
    if (options.containerId) {
      info.containerId = options.containerId;
      info.containerName = options.containerName;
      info.containerImage = options.containerImage;
      info.containerCwd = options.containerCwd || "/workspace";
    }

    // Council Mode observer spawn config (council review #1 P1#1) is
    // applied uniformly across both backends and reused on relaunch so
    // the council context isn't lost on every non-initial spawn (#4).
    const effectiveOptions = this.buildObserverSpawnOverrides(sessionId, info, {
      ...options,
      model: launchModel,
    });

    this.sessions.set(sessionId, info);
    if (effectiveOptions.env) {
      this.sessionEnvs.set(sessionId, { ...effectiveOptions.env });
    }

    // Task 11 — auth-probe spawns (record: false) opt out of recording.
    // Must fire BEFORE the adapter wires its first record() call so the
    // RecorderManager's lazy-create path never opens a file for this id.
    if (effectiveOptions.record === false) {
      this.recorder?.disableForSession(sessionId);
    }

    if (backendType === "codex") {
      this.spawnCodex(sessionId, info, effectiveOptions);
    } else {
      this.spawnCLI(sessionId, info, effectiveOptions);
    }
    return info;
  }

  /**
   * Compose the LaunchOptions overrides for a Council Mode observer
   * spawn — applies (a) the observer system-prompt artifact AND (b) the
   * narrow observer tool profile (EC-1). Called from both `launch()` and
   * `relaunch()` so an auto-relaunched observer keeps its role + restrictions.
   *
   * Resolution policy lives in {@link resolveObserverPromptForSpawn} —
   * this method owns ONLY the spawn-options composition. Council Review
   * 2026-05-15-0820 P2 #5 (Fowler): the prior `applyCouncilObserverSpawnConfig`
   * shape grew to ~110 LOC interleaving (i) artifact resolution, (ii) log
   * emission, (iii) options composition. Extracting (i) to its own free
   * function leaves this method as ~40 LOC of straight-line composition;
   * renamed `buildObserverSpawnOverrides` because the new name no longer
   * promises side-effect-heavy "apply" behavior.
   *
   * Returns `options` unchanged when the session isn't an observer.
   */
  private buildObserverSpawnOverrides(
    sessionId: string,
    info: SdkSessionInfo,
    options: LaunchOptions,
  ): LaunchOptions {
    if (options.sessionGroupRole !== "observer") return options;
    try {
      const resolution = resolveObserverPromptForSpawn({
        cwd: options.cwd || info.cwd,
      });

      info.observerPromptSha256 = resolution.artifact.sha256;
      info.observerPromptSource = resolution.artifact.source;
      info.observerPromptVersion = resolution.artifact.version;

      // Council Plan Task 5 + Council Review 2026-05-15-0820 P2 #8/#9:
      // structured WARN log on bundled-fallback path. Operator visibility —
      // workspace-present is the happy path; the bundled branch is an
      // opt-in misconfiguration deserving notice. Path fields are
      // categorical (`present` + `depth`), NOT the raw workspace path —
      // raw paths leaked operator topology if logs egressed to a shared
      // sink (Hunt P3 #4). SHA field renamed `bundledSha256` →
      // `observerPromptSha256` to match `SdkSessionInfo.observerPromptSha256`
      // (Backend P3 #3 — consistent field names across modules).
      // Council Review 2026-05-15-1015 CR-10: switch + never tripwire on
      // the source discriminator. A future "remote"/"cache" source would
      // otherwise silently no-op the WARN-on-fallback branch.
      switch (resolution.artifact.source) {
        case "workspace":
          break;
        case "bundled":
          if (resolution.fallbackReason !== null) {
            log.warn("council.observer-prompt.bundled-fallback", "observer prompt fell back to bundled", {
              event: "council.observer-prompt.bundled-fallback",
              sessionGroupId: options.sessionGroupId,
              sessionId,
              role: "observer",
              expectedPathPresent: resolution.expectedPathPresent,
              expectedPathDepth: resolution.expectedPathDepth,
              observerPromptSha256: resolution.artifact.sha256,
              observerPromptSource: resolution.artifact.source,
              observerPromptVersion: resolution.artifact.version,
              reason: resolution.fallbackReason,
            });
          }
          break;
        default:
          assertExhaustiveObserverPromptSource(resolution.artifact.source);
      }

      // Compose with any orchestrator-side systemPrompt that flowed in
      // (no caller does this today; preserved for forward-compat).
      const composedSystemPrompt = options.systemPrompt
        ? `${resolution.artifact.body}\n\n${options.systemPrompt}`
        : resolution.artifact.body;
      // Caller-supplied allowedTools intersect with the observer profile —
      // never widened.
      const callerAllowed = options.allowedTools ?? [];
      const intersectedAllowed = callerAllowed.length > 0
        ? callerAllowed.filter((t) => OBSERVER_ALLOWED_TOOLS.includes(t))
        : [...OBSERVER_ALLOWED_TOOLS];
      info.permissionMode = OBSERVER_PERMISSION_MODE;
      return {
        ...options,
        systemPrompt: composedSystemPrompt,
        allowedTools: intersectedAllowed,
        disallowedTools: [...OBSERVER_DISALLOWED_TOOLS],
        permissionMode: OBSERVER_PERMISSION_MODE,
      };
    } catch (err) {
      throw new Error(
        `observer spawn config load failed for session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Relaunch a CLI process for an existing session.
   * Kills the old process if still alive, then spawns a fresh CLI
   * that connects back to the same session in the WsBridge.
   */
  async relaunch(
    sessionId: string,
    opts: { model?: string } = {},
  ): Promise<{ ok: boolean; error?: string }> {
    const info = this.sessions.get(sessionId);
    // EC-19-EXEMPT: session missing entirely — there is no pid/state to
    // clear, so clearPidAndPersist does not apply at this entry guard.
    if (!info) return { ok: false, error: "Session not found" };

    // Council Review 2026-05-15-1015 CR-20 (Subprocess P3): capture the
    // drift baseline BEFORE the old proc is killed. Today's exit handler
    // doesn't clear observerPromptSha256/Source, so the post-kill snapshot
    // is safe by accident — but a future "exit handler clears state"
    // cleanup would silently disable drift detection. Move the snapshot
    // here so the baseline always reflects the pre-relaunch state.
    const previousObserverPromptSha = info.observerPromptSha256;
    const previousObserverPromptSource = info.observerPromptSource;
    const previousObserverPromptVersion = info.observerPromptVersion;

    // Council review P1 #2: for Codex, resolve the requested model BEFORE
    // we kill the live process. If the requested model is stale/unsupported
    // and no launchable fallback exists, abort the relaunch WITHOUT
    // destroying the running session — the user keeps their working session
    // instead of losing it to a doomed relaunch. (Claude has no per-account
    // launch-time model gating here, so this guard is Codex-only.)
    let validatedCodexModel: string | undefined;
    if (info.backendType === "codex") {
      const requestedModel =
        typeof opts.model === "string" && opts.model.trim().length > 0
          ? opts.model.trim()
          : info.model;
      const resolved = this.resolveCodexLaunchModel(sessionId, requestedModel);
      if (!resolved.ok) {
        // EC-19-EXEMPT: pre-kill validation failure. No process was killed
        // and no session state was mutated, so the live session is fully
        // intact. clearPidAndPersist (which nulls pid, flips state to
        // "exited", and fires session:relaunch-exhausted) is for the
        // abandon-the-session paths — applying it here would destroy the
        // very session this guard exists to protect.
        return { ok: false, error: resolved.error };
      }
      validatedCodexModel = resolved.model;
    }

    // Kill old process(es) if still alive.
    // Snapshot both handles first because killing the proxy can trigger the
    // WS session exit handler, which clears `this.processes`.
    const oldProc = this.processes.get(sessionId);
    const oldProxy = this.codexWsProxies.get(sessionId);
    if (oldProxy) {
      try {
        oldProxy.kill("SIGTERM");
        await Promise.race([
          oldProxy.exited,
          new Promise((r) => setTimeout(r, 2000)),
        ]);
      } catch {}
      this.codexWsProxies.delete(sessionId);
    }
    if (oldProc) {
      try {
        oldProc.kill("SIGTERM");
        await Promise.race([
          oldProc.exited,
          new Promise((r) => setTimeout(r, 2000)),
        ]);
      } catch {}
      this.processes.delete(sessionId);
    } else if (info.pid) {
      // EC-45 — a PID from a previous server instance is no proof of
      // identity. The original CLI may have exited and the kernel handed
      // its PID to an unrelated process; an unconditional SIGTERM would be
      // a silent collateral kill. Re-verify at the signal instant and skip
      // the kill on a mismatch/gone verdict.
      if (this.shouldSignalPreviousInstancePid(info)) {
        try { process.kill(info.pid, "SIGTERM"); } catch {}
      }
    }

    // Release any host-mode Codex port claim before picking a new one.
    this.releaseCodexWsPort(info);

    // Pre-flight validation for containerized sessions
    if (info.containerId) {
      const containerLabel = info.containerName || info.containerId.slice(0, 12);
      const containerState = containerManager.isContainerAlive(info.containerId);

      if (containerState === "missing") {
        console.error(`[cli-launcher] Container ${containerLabel} no longer exists for session ${sessionId}`);
        info.exitCode = 1;
        // PLAN T7 (Phase D): structural failure — container is gone and
        // will never come back via the retry budget. Route through
        // `clearPidAndPersist` so `pid` is nulled (kills the boot-probe
        // false-positive chain), `state` flips exited, persist fires,
        // and `session:relaunch-exhausted` fans out for Phase F drain.
        this.clearPidAndPersist(sessionId, "container_missing");
        return {
          ok: false,
          error: `Container "${containerLabel}" was removed externally. Please create a new session.`,
        };
      }

      if (containerState === "stopped") {
        try {
          containerManager.startContainer(info.containerId);
          console.log(`[cli-launcher] Restarted stopped container ${containerLabel} for session ${sessionId}`);
        } catch (e) {
          info.exitCode = 1;
          // PLAN T7 (Phase D): docker startContainer threw — structural
          // failure. Route through `clearPidAndPersist`.
          this.clearPidAndPersist(sessionId, "container_start_failed");
          return {
            ok: false,
            error: `Container "${containerLabel}" is stopped and could not be restarted: ${e instanceof Error ? e.message : String(e)}`,
          };
        }
      }

      // Validate the CLI binary exists inside the container
      const binary = info.backendType === "codex" ? "codex" : "claude";
      if (!containerManager.hasBinaryInContainer(info.containerId, binary)) {
        console.error(`[cli-launcher] "${binary}" not found in container ${containerLabel} for session ${sessionId}`);
        info.exitCode = 127;
        // PLAN T7 (Phase D): CLI binary missing inside the container —
        // structural failure that won't fix itself across retries.
        this.clearPidAndPersist(sessionId, "container_binary_missing");
        return {
          ok: false,
          error: `"${binary}" command not found inside container "${containerLabel}". The container image may need to be rebuilt.`,
        };
      }
    }

    info.state = "starting";

    // Model already validated pre-kill (council review P1 #2). Commit the
    // resolved slug (may be a fallback) now that the relaunch is committed.
    if (info.backendType === "codex" && validatedCodexModel !== undefined) {
      info.model = validatedCodexModel;
    }

    const runtimeEnv = this.sessionEnvs.get(sessionId);

    // Subprocess P1#4: pass council context back into the relaunch
    // options so the observer prompt + tool restrictions get re-applied
    // by `buildObserverSpawnOverrides` (formerly `applyCouncilObserverSpawnConfig`).
    // Without this, every auto-relaunched observer spawned as a plain
    // unrole-d session with full default tools.
    const baseRelaunchOptions: LaunchOptions = info.backendType === "codex"
      ? {
        model: info.model,
        permissionMode: info.permissionMode,
        cwd: info.cwd,
        codexSandbox: info.codexSandbox,
        codexInternetAccess: info.codexInternetAccess,
        containerId: info.containerId,
        containerName: info.containerName,
        containerImage: info.containerImage,
        containerCwd: info.containerCwd,
        env: runtimeEnv,
        sessionGroupId: info.sessionGroupId,
        sessionGroupRole: info.sessionGroupRole,
      }
      : {
        model: info.model,
        permissionMode: info.permissionMode,
        cwd: info.cwd,
        resumeSessionId: info.cliSessionId,
        containerId: info.containerId,
        containerName: info.containerName,
        containerImage: info.containerImage,
        env: runtimeEnv,
        sessionGroupId: info.sessionGroupId,
        sessionGroupRole: info.sessionGroupRole,
      };
    // Council Review 2026-05-15-0820 P2 #7: detect drift in observer
    // prompt provenance across the relaunch boundary. Snapshot captured
    // BEFORE the old proc kill (CR-20) — see relaunch() entry. Drift is
    // only observable on the fresh-fallback path; the --resume path is
    // gated below (CR-3).
    let effectiveRelaunchOptions: LaunchOptions;
    try {
      effectiveRelaunchOptions = this.buildObserverSpawnOverrides(sessionId, info, baseRelaunchOptions);
    } catch (err) {
      info.exitCode = 1;
      // Council Review 2026-05-15-0820 P2 #8 (D4): emit `session:relaunch-failed`
      // (NOT `session:exited`). The typed channel exists at
      // `event-bus-types.ts:28` and is already wired in
      // `session-orchestrator.ts:711` to fast-fail the coordinator's
      // reconnecting state through `reconnect_failed → group:degraded`.
      // Without this emit, the coordinator sits in `reconnecting` for the
      // full 45s grace window for a recovery that has zero chance —
      // observer prompt-config will fail identically on every retry.
      if (info.sessionGroupRole === "observer") {
        const reason = `observer-prompt-config-failed: ${err instanceof Error ? err.message : String(err)}`;
        companionBus.emit("session:relaunch-failed", { sessionId, reason });
      }
      // PLAN T7 (Phase D): observer-prompt-config load failure is
      // deterministic — retrying won't fix it. Route through
      // `clearPidAndPersist` so the pid is nulled, state persisted,
      // and Phase F's drain dispatch listener wakes.
      this.clearPidAndPersist(sessionId, "observer_prompt_config_failed");
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // Council Review 2026-05-15-0820 P2 #7 (D7 / drift detection): when the
    // re-resolved (source, sha) differs from the previous spawn's stamp,
    // emit a structured drift WARN. Operator visibility into a transition
    // that would otherwise be invisible — workspace file appeared, was
    // deleted, or got edited between initial spawn and this relaunch.
    // Identity transitions (same source, same sha) are noise — skip.
    //
    // Council Review 2026-05-15-1015 CR-3: gate on `!resumeSessionId`.
    // On `--resume` the model still sees the prompt baked at original
    // spawn; emitting drift WARN would advertise a transition that did
    // not happen model-side. Drift is only observable on the fresh
    // fallback path (cliSessionId cleared, no resume).
    if (
      info.sessionGroupRole === "observer" &&
      !effectiveRelaunchOptions.resumeSessionId &&
      previousObserverPromptSha !== undefined &&
      previousObserverPromptSource !== undefined &&
      (info.observerPromptSha256 !== previousObserverPromptSha ||
        info.observerPromptSource !== previousObserverPromptSource)
    ) {
      const crossedSourceBoundary = info.observerPromptSource !== previousObserverPromptSource;
      log.warn("council.observer-prompt.source-drift", "observer prompt source drifted across relaunch", {
        event: "council.observer-prompt.source-drift",
        sessionGroupId: info.sessionGroupId,
        sessionId,
        role: "observer",
        backend: info.backendType,
        previous: {
          sha256: previousObserverPromptSha,
          source: previousObserverPromptSource,
          version: previousObserverPromptVersion,
        },
        current: {
          sha256: info.observerPromptSha256,
          source: info.observerPromptSource,
          version: info.observerPromptVersion,
        },
        cause: "session_exited",
        crossedSourceBoundary,
      });
      // Council Review 2026-05-15-1015 CR-17 (Hunt P3): hard refusal on
      // workspace↔bundled source crossing. The transition swaps the
      // observer's role definition, tool policy, and review schema —
      // potentially in response to hostile workspace mutation on a
      // multi-tenant host. Operator must restart the group to acknowledge
      // the policy change. SHA-only drift within the same source
      // (workspace artifact edited in place) stays WARN-only.
      if (crossedSourceBoundary) {
        info.exitCode = 1;
        const reason = `observer-prompt-source-drift-refused: ${previousObserverPromptSource} → ${info.observerPromptSource}`;
        companionBus.emit("session:relaunch-failed", { sessionId, reason });
        // PLAN T7 (Phase D): operator must restart the group to ack the
        // policy change; we route through `clearPidAndPersist` to
        // surface the structural failure to Phase F's drain listener.
        this.clearPidAndPersist(sessionId, "observer_prompt_source_drift_refused");
        return { ok: false, error: reason };
      }
    }
    if (info.backendType === "codex") {
      this.spawnCodex(sessionId, info, effectiveRelaunchOptions);
    } else {
      this.spawnCLI(sessionId, info, effectiveRelaunchOptions);
    }
    return { ok: true };
  }

  /** Forward declaration for the relaunch options builder. Defined as a
   *  type alias so the `LaunchOptions` extension stays in one place. */
  // (none — uses LaunchOptions directly above)

  /**
   * Get all sessions in "starting" state (awaiting CLI WebSocket connection).
   */
  getStartingSessions(): SdkSessionInfo[] {
    return Array.from(this.sessions.values()).filter((s) => s.state === "starting");
  }

  private spawnCLI(sessionId: string, info: SdkSessionInfo, options: LaunchOptions): void {
    const isContainerized = !!options.containerId;

    // For containerized sessions, the CLI binary lives inside the container.
    // For host sessions, resolve the binary on the host.
    let binary = options.claudeBinary || "claude";
    if (!isContainerized) {
      const resolved = resolveBinary(binary);
      if (resolved) {
        binary = resolved;
      } else {
        console.error(`[cli-launcher] Binary "${binary}" not found in PATH`);
        info.state = "exited";
        info.exitCode = 127;
        this.persistState();
        return;
      }
    }

    // Allow overriding the host alias used by containerized Claude sessions.
    // Useful when host.docker.internal is unavailable in a given Docker setup.
    const containerSdkHost = (process.env.COMPANION_CONTAINER_SDK_HOST || "host.docker.internal").trim()
      || "host.docker.internal";

    // When running inside a container, the SDK URL should target the host alias
    // so the CLI can connect back to the Hono server running on the host.
    const sdkUrl = isContainerized
      ? `ws://${containerSdkHost}:${this.port}/ws/cli/${sessionId}`
      : `ws://localhost:${this.port}/ws/cli/${sessionId}`;

    // Claude Code rejects bypassPermissions when running with root/sudo.
    // Container sessions are downgraded by default; host sessions are only
    // downgraded when this server itself runs as root.
    let effectivePermissionMode = options.permissionMode;
    const isRootProcess = typeof process.getuid === "function" && process.getuid() === 0;
    const shouldDowngradeContainerBypass =
      isContainerized
      && options.permissionMode === "bypassPermissions"
      && process.env.COMPANION_FORCE_BYPASS_IN_CONTAINER !== "1";
    const shouldDowngradeRootBypass =
      !isContainerized
      && isRootProcess
      && options.permissionMode === "bypassPermissions"
      && process.env.COMPANION_FORCE_BYPASS_AS_ROOT !== "1";

    if (shouldDowngradeContainerBypass || shouldDowngradeRootBypass) {
      const scope = isContainerized ? "container" : "root";
      console.warn(
        `[cli-launcher] Session ${sessionId}: downgrading ${scope} permission mode ` +
        `from bypassPermissions to acceptEdits.`,
      );
      effectivePermissionMode = "acceptEdits";
      info.permissionMode = "acceptEdits";
    }

    const args: string[] = [
      "--sdk-url", sdkUrl,
      "--print",
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      // Required on newer Claude Code versions to emit streaming chunk events.
      "--include-partial-messages",
      "--verbose",
    ];

    if (options.model) {
      args.push("--model", options.model);
    }
    if (effectivePermissionMode) {
      args.push("--permission-mode", effectivePermissionMode);
    }
    if (options.allowedTools) {
      for (const tool of options.allowedTools) {
        args.push("--allowedTools", tool);
      }
    }
    if (options.resumeSessionAt) {
      args.push("--resume-session-at", options.resumeSessionAt);
    }
    if (options.forkSession) {
      args.push("--fork-session");
    }
    // Council Mode observer-role wiring (council review #1): the prompt
    // body + tool restrictions are populated by `launch()` BEFORE
    // dispatch so both Claude and Codex receive them; spawnCLI consumes
    // `options.systemPrompt` and `options.disallowedTools` for its
    // backend-specific argv shape.
    //
    // Council Review 2026-05-15-1015 CR-3 (Subprocess P2 → P1): skip on
    // `--resume`. Claude `--resume` bakes the system prompt at the
    // original spawn; re-emitting `--append-system-prompt` on resume has
    // no runtime effect on the model but would make the drift WARN lie
    // about provenance ("source transitioned" when the model still sees
    // the old prompt). Only the fresh-fallback path (uptime<5000ms
    // cleared cliSessionId → no resume) actually re-applies the prompt.
    if (
      options.systemPrompt &&
      options.sessionGroupRole === "observer" &&
      !options.resumeSessionId
    ) {
      args.push("--append-system-prompt", options.systemPrompt);
    }
    if (options.disallowedTools && options.disallowedTools.length > 0) {
      for (const tool of options.disallowedTools) {
        args.push("--disallowedTools", tool);
      }
    }

    // Always pass -p "" for headless mode. When relaunching, also pass --resume
    // to restore the CLI's conversation context.
    if (options.resumeSessionId) {
      args.push("--resume", options.resumeSessionId);
    }

    args.push("-p", "");

    let spawnCmd: string[];
    let spawnEnv: Record<string, string | undefined>;
    let spawnCwd: string | undefined;

    if (isContainerized) {
      // Run CLI inside the container via docker exec -i.
      // Keeping stdin open avoids premature EOF-driven exits in SDK mode.
      // Environment variables are passed via -e flags to docker exec.
      const dockerArgs = ["docker", "exec", "-i"];

      // Pass env vars via -e flags
      if (options.env) {
        for (const [k, v] of Object.entries(options.env)) {
          dockerArgs.push("-e", `${k}=${v}`);
        }
      }
      // Ensure CLAUDECODE is unset inside container
      dockerArgs.push("-e", "CLAUDECODE=");

      dockerArgs.push(options.containerId!);
      // Use a login shell so ~/.bashrc is sourced and nvm/bun/deno/etc are on PATH
      const innerCmd = [binary, ...args].map(a => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
      dockerArgs.push("bash", "-lc", innerCmd);

      spawnCmd = dockerArgs;
      // Host env for the docker CLI itself
      spawnEnv = { ...process.env, PATH: getEnrichedPath() };
      spawnCwd = undefined; // cwd is set inside the container via -w at creation
    } else {
      // Host-based spawn (original behavior)
      // On Windows, .cmd/.bat files cannot be spawned directly by Bun.spawn;
      // they must be invoked via cmd.exe /c.
      const isCmdScript = process.platform === "win32" && (binary.endsWith(".cmd") || binary.endsWith(".bat"));
      spawnCmd = isCmdScript ? ["cmd.exe", "/c", binary, ...args] : [binary, ...args];
      spawnEnv = {
        ...process.env,
        CLAUDECODE: undefined,
        ...options.env,
        PATH: getEnrichedPath(),
      };
      spawnCwd = info.cwd;
    }

    console.log(
      `[cli-launcher] Spawning session ${sessionId}${isContainerized ? " (container)" : ""}: ` +
      sanitizeSpawnArgsForLog(spawnCmd),
    );

    const proc = Bun.spawn(spawnCmd, {
      cwd: spawnCwd,
      env: spawnEnv,
      stdout: "pipe",
      stderr: "pipe",
    });

    info.pid = proc.pid;
    this.processes.set(sessionId, proc);
    // PLAN T7 (Phase D): persist the spawn-time identity anchor — pid +
    // processStartMs + argv hash — to `<sessionId>.runtime.json`.
    // Boot-recovery + orphan-reaper read this to authoritatively
    // classify the running process across bun restarts. Errors are
    // logged but don't fail the spawn (sidecar is forensic forward-
    // recovery, not a hard prerequisite).
    this.writeRuntimeSidecarForSpawn(sessionId, proc.pid, spawnCmd);

    // Stream stdout/stderr for debugging
    this.pipeOutput(sessionId, proc);

    // Monitor process exit
    const spawnedAt = Date.now();
    proc.exited.then((exitCode) => {
      console.log(`[cli-launcher] Session ${sessionId} exited (code=${exitCode})`);
      const session = this.sessions.get(sessionId);
      if (session) {
        session.state = "exited";
        session.exitCode = exitCode;

        // If the process exited almost immediately with --resume, the resume likely failed.
        // Clear cliSessionId so the next relaunch starts fresh.
        const uptime = Date.now() - spawnedAt;
        if (uptime < 5000 && options.resumeSessionId) {
          console.error(`[cli-launcher] Session ${sessionId} exited immediately after --resume (${uptime}ms). Clearing cliSessionId for fresh start.`);
          session.cliSessionId = undefined;
        }
      }
      this.processes.delete(sessionId);
      this.persistState();
      companionBus.emit("session:exited", { sessionId, exitCode });
    });

    this.persistState();
  }

  /**
   * Spawn a Codex app-server subprocess for a session.
   * Transport (stdio vs WebSocket) is selected by `COMPANION_CODEX_TRANSPORT`.
   */
  private prepareCodexHome(codexHome: string): void {
    mkdirSync(codexHome, { recursive: true });

    const legacyHome = getLegacyCodexHome();
    if (resolve(legacyHome) === resolve(codexHome) || !existsSync(legacyHome)) {
      return;
    }

    // Bootstrap only the user-level artifacts Codex needs (auth/config/skills),
    // while intentionally skipping sessions/sqlite to avoid stale rollout indexes.
    const fileSeeds = ["auth.json", "config.toml", "models_cache.json", "version.json"];
    for (const name of fileSeeds) {
      try {
        const src = join(legacyHome, name);
        const dest = join(codexHome, name);
        if (!existsSync(src)) continue;
        // auth.json: OAuth refresh tokens are single-use, so a stale
        // per-session copy fails with "refresh token was already used" after
        // the user re-logs-in (which only rewrites the legacy file). Re-seed
        // whenever the legacy copy is newer; never clobber a fresher
        // session copy (the live CLI may have refreshed it itself).
        const reseedNewerAuth =
          name === "auth.json" &&
          existsSync(dest) &&
          statSync(src).mtimeMs > statSync(dest).mtimeMs;
        if (!existsSync(dest) || reseedNewerAuth) {
          copyFileSync(src, dest);
          if (reseedNewerAuth) {
            console.log(`[cli-launcher] Re-seeded ${name} from legacy home (legacy copy is newer)`);
          }
        }
      } catch (e) {
        console.warn(`[cli-launcher] Failed to bootstrap ${name} from legacy home:`, e);
      }
    }

    const dirSeeds = ["skills", "vendor_imports", "prompts", "rules"];
    for (const name of dirSeeds) {
      try {
        const src = join(legacyHome, name);
        const dest = join(codexHome, name);
        if (!existsSync(dest) && existsSync(src)) {
          cpSync(src, dest, { recursive: true, dereference: true });
        }
      } catch (e) {
        console.warn(`[cli-launcher] Failed to bootstrap ${name}/ from legacy home:`, e);
      }
    }
  }

  private spawnCodex(sessionId: string, info: SdkSessionInfo, options: LaunchOptions): void {
    const useWs = isCodexWsTransportEnabled();
    if (useWs) {
      this.spawnCodexWs(sessionId, info, options);
    } else {
      this.spawnCodexStdio(sessionId, info, options);
    }
  }

  /**
   * Spawn Codex with WebSocket transport.
   * Codex listens on `ws://127.0.0.1:PORT`, Companion connects as a client.
   */
  private async spawnCodexWs(sessionId: string, info: SdkSessionInfo, options: LaunchOptions): Promise<void> {
    const isContainerized = !!options.containerId;
    const connectTimeoutMs = Math.max(1000, parseInt(process.env.COMPANION_CODEX_WS_CONNECT_TIMEOUT_MS ?? "", 10) || 30000);
    const pongTimeoutMs = Math.max(1000, parseInt(process.env.COMPANION_CODEX_PONG_TIMEOUT_MS ?? "", 10) || 30000);

    let binary = options.codexBinary || "codex";
    if (!isContainerized) {
      const resolved = resolveBinary(binary);
      if (resolved) {
        binary = resolved;
      } else {
        console.error(`[cli-launcher] Binary "${binary}" not found in PATH`);
        info.state = "exited";
        info.exitCode = 127;
        this.persistState();
        return;
      }
    }

    // Host mode: choose a free host port. Container mode: use a fixed container port
    // and connect via the container's mapped host port.
    let codexListenPort: number;
    let proxyConnectPort: number;
    if (isContainerized) {
      codexListenPort = CODEX_CONTAINER_WS_PORT;
      const containerInfo = containerManager.getContainerById(options.containerId!);
      const mappedPort = containerInfo?.portMappings.find((p) => p.containerPort === CODEX_CONTAINER_WS_PORT)?.hostPort;
      if (!mappedPort) {
        console.error(
          `[cli-launcher] Missing port mapping for Codex container port ${CODEX_CONTAINER_WS_PORT} ` +
          `on container ${options.containerId}`,
        );
        info.state = "exited";
        info.exitCode = 1;
        this.persistState();
        return;
      }
      proxyConnectPort = mappedPort;
    } else {
      try {
        proxyConnectPort = await findFreePort(
          4500,
          4600,
          (port) => this.claimedCodexWsPorts.has(port),
        );
        this.claimCodexWsPort(proxyConnectPort);
        // Set immediately after claiming so any downstream failure can release it.
        info.codexWsPort = proxyConnectPort;
      } catch (err) {
        console.error(`[cli-launcher] Failed to find free port for Codex WS: ${err}`);
        info.state = "exited";
        info.exitCode = 1;
        this.persistState();
        return;
      }
      codexListenPort = proxyConnectPort;
    }

    const listenAddr = isContainerized
      ? `ws://0.0.0.0:${codexListenPort}`
      : `ws://127.0.0.1:${codexListenPort}`;

    const args: string[] = ["app-server", "--listen", listenAddr];
    // Enable Codex multi-agent mode by default (product decision).
    args.push("--enable", "multi_agent");
    const internetEnabled = options.codexInternetAccess !== false;
    args.push("-c", `tools.webSearch=${internetEnabled ? "true" : "false"}`);
    const codexHome = resolveCompanionCodexSessionHome(
      sessionId,
      options.codexHome,
    );
    if (!isContainerized) {
      this.prepareCodexHome(codexHome);
    }

    let spawnCmd: string[];
    let spawnEnv: Record<string, string | undefined>;
    let spawnCwd: string | undefined;

    if (isContainerized) {
      // Run Codex inside the container via docker exec -d (detached, no stdin pipe needed)
      const dockerArgs = ["docker", "exec", "-d"];
      if (options.env) {
        for (const [k, v] of Object.entries(options.env)) {
          dockerArgs.push("-e", `${k}=${v}`);
        }
      }
      dockerArgs.push("-e", "CLAUDECODE=");
      dockerArgs.push("-e", "CODEX_HOME=/root/.codex");
      dockerArgs.push(options.containerId!);
      const innerCmd = [binary, ...args].map(a => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
      dockerArgs.push("bash", "-lc", innerCmd);

      spawnCmd = dockerArgs;
      spawnEnv = { ...process.env, PATH: getEnrichedPath() };
      spawnCwd = undefined;
    } else {
      const binaryDir = resolve(binary, "..");
      const siblingNode = join(binaryDir, "node");
      const enrichedPath = getEnrichedPath();
      const pathSep = process.platform === "win32" ? ";" : ":";
      const spawnPath = [binaryDir, ...enrichedPath.split(pathSep)].filter(Boolean).join(pathSep);

      if (existsSync(siblingNode)) {
        let codexScript: string;
        try {
          codexScript = realpathSync(binary);
        } catch {
          codexScript = binary;
        }
        spawnCmd = [siblingNode, codexScript, ...args];
      } else {
        // On Windows, .cmd/.bat files cannot be spawned directly by Bun.spawn
        const isCmdScript = process.platform === "win32" && (binary.endsWith(".cmd") || binary.endsWith(".bat"));
        spawnCmd = isCmdScript ? ["cmd.exe", "/c", binary, ...args] : [binary, ...args];
      }

      spawnEnv = {
        ...process.env,
        CLAUDECODE: undefined,
        ...options.env,
        CODEX_HOME: codexHome,
        PATH: spawnPath,
      };
      spawnCwd = info.cwd;
    }

    console.log(
      `[cli-launcher] Spawning Codex WS session ${sessionId}${isContainerized ? " (container)" : ""}: ` +
      sanitizeSpawnArgsForLog(spawnCmd),
    );

    const proc = Bun.spawn(spawnCmd, {
      cwd: spawnCwd,
      env: spawnEnv,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    info.pid = proc.pid;
    this.processes.set(sessionId, proc);
    // PLAN T7 (Phase D): runtime-sidecar write for Codex WS spawn.
    this.writeRuntimeSidecarForSpawn(sessionId, proc.pid, spawnCmd);

    // Pipe stdout/stderr for debugging (JSON-RPC goes over WebSocket now)
    this.pipeOutput(sessionId, proc);

    // Store WS metadata
    const wsUrl = `ws://127.0.0.1:${proxyConnectPort}`;
    if (typeof info.codexWsPort !== "number") {
      info.codexWsPort = proxyConnectPort;
    }
    info.codexWsUrl = wsUrl;

    // Connect to Codex app-server through a Node helper process that uses the
    // `ws` package directly (with perMessageDeflate disabled). This avoids a Bun
    // runtime compatibility issue where the `ws` client can mis-handle a valid
    // 101 upgrade response from Codex's Rust WS server.
    const codexBinaryDir = isContainerized ? undefined : resolve(binary, "..");
    const proxyNodeCandidate = codexBinaryDir ? join(codexBinaryDir, "node") : undefined;
    const proxyNode = proxyNodeCandidate && existsSync(proxyNodeCandidate) ? proxyNodeCandidate : "node";
    const proxyProc = Bun.spawn([proxyNode, CODEX_WS_PROXY_PATH, wsUrl, String(connectTimeoutMs), String(pongTimeoutMs)], {
      cwd: info.cwd,
      env: {
        ...process.env,
        PATH: getEnrichedPath(),
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.codexWsProxies.set(sessionId, proxyProc);
    // proxy stdout is the JSON-RPC protocol stream (consumed by CodexAdapter).
    // Only pipe stderr for diagnostics to avoid locking stdout.
    const proxyStderr = proxyProc.stderr;
    if (proxyStderr && typeof proxyStderr !== "number") {
      this.pipeStream(sessionId, proxyStderr, "stderr");
    }

    // Create CodexAdapter using stdio transport to the proxy process.
    const adapter = new CodexAdapter(proxyProc, sessionId, {
      model: options.model,
      cwd: info.cwd,
      executionCwd: options.containerId ? (info.containerCwd || "/workspace") : info.cwd,
      approvalMode: options.permissionMode,
      threadId: info.cliSessionId,
      sandbox: options.codexSandbox,
      recorder: this.recorder ?? undefined,
      systemPrompt: options.systemPrompt,
      killProcess: async () => {
        try {
          proxyProc.kill("SIGTERM");
        } catch {}
        try {
          proc.kill("SIGTERM");
        } catch {}
        await Promise.race([
          Promise.allSettled([proxyProc.exited, proc.exited]),
          new Promise((r) => setTimeout(r, 5000)),
        ]);
      },
    });

    // Handle init errors
    adapter.onInitError((error) => {
      console.error(`[cli-launcher] Codex WS session ${sessionId} init failed: ${error}`);
      try { proxyProc.kill("SIGTERM"); } catch {}
      try { proc.kill("SIGTERM"); } catch {}
      // P1 #1 generation guard: a newer spawn already owns this session's
      // process slot, so the live proxy/state belongs to it. Our own procs
      // are killed above; bail before deleting the (now newer) proxy entry,
      // re-spawning, or marking the live session exited.
      if (this.isSupersededGeneration(sessionId, proc)) {
        return;
      }
      this.codexWsProxies.delete(sessionId);
      const session = this.sessions.get(sessionId);
      if (session) {
        if (this.isCodexModelAvailabilityError(error)) {
          this.markCodexModelRejected(sessionId, session.model);
          const resolved = this.resolveCodexLaunchModel(sessionId, session.model);
          if (resolved.ok && resolved.model !== session.model) {
            session.state = "starting";
            session.exitCode = undefined;
            session.cliSessionId = undefined;
            session.model = resolved.model;
            this.releaseCodexWsPort(session);
            this.persistState();
            this.spawnCodex(sessionId, session, { ...options, model: resolved.model });
            return;
          }
        }
        session.state = "exited";
        session.exitCode = 1;
        session.cliSessionId = undefined;
        this.releaseCodexWsPort(session);
      }
      this.persistState();
    });

    // Notify the WsBridge to attach this adapter
    companionBus.emit("backend:codex-adapter-created", { sessionId, adapter });

    info.state = "connected";

    // Monitor the proxy connection process as the primary transport liveness.
    // In container mode, `docker exec -d` exits immediately after launching Codex
    // and must not be treated as the backend process lifetime.
    let exitHandled = false;
    const handleWsSessionExit = (exitCode: number | null, source: "proxy" | "codex") => {
      if (exitHandled) return;
      exitHandled = true;
      console.log(`[cli-launcher] Codex WS session ${sessionId} exited via ${source} (code=${exitCode})`);

      // Notify the adapter that the transport is gone so it can clean up
      // pending promises and stop accepting messages immediately.
      adapter.handleTransportClose();

      // Kill the other process too — if the proxy exits, kill Codex and vice versa.
      // This prevents orphaned processes lingering after a partial crash.
      // Note: The SIGTERM will cause the sibling to exit, which fires its own
      // exit handler, but the `exitHandled` guard above ensures it's a no-op.
      if (source === "proxy") {
        try { proc.kill("SIGTERM"); } catch {}
      } else {
        try { proxyProc.kill("SIGTERM"); } catch {}
      }

      // P1 #1 generation guard: a newer spawn already owns this session's
      // process slot (fallback-respawn / relaunch). Our own transport is
      // torn down above; do NOT mutate shared session state, delete the
      // map entries (they belong to the live generation now), persist, or
      // emit session:exited — that would clobber the live process.
      if (this.isSupersededGeneration(sessionId, proc)) {
        return;
      }

      const session = this.sessions.get(sessionId);
      if (session) {
        session.state = "exited";
        session.exitCode = exitCode;
        this.releaseCodexWsPort(session);
      }
      this.processes.delete(sessionId);
      this.codexWsProxies.delete(sessionId);
      this.persistState();
      companionBus.emit("session:exited", { sessionId, exitCode });
    };

    proxyProc.exited.then((exitCode) => {
      handleWsSessionExit(exitCode, "proxy");
    });

    if (!isContainerized) {
      proc.exited.then((exitCode) => {
        handleWsSessionExit(exitCode, "codex");
      });
    } else {
      proc.exited.then((exitCode) => {
        // `docker exec -d` exits immediately after launch in container WS mode.
        // Suppress the expected success case to avoid noisy logs; keep non-zero exits.
        if (exitCode !== 0) {
          console.warn(`[cli-launcher] Codex WS launcher command for ${sessionId} exited (code=${exitCode})`);
        }
      });
    }

    this.persistState();
  }

  /**
   * Spawn Codex with stdio transport (legacy).
   * Unlike Claude Code (which connects back via WebSocket), Codex uses stdin/stdout.
   */
  private spawnCodexStdio(sessionId: string, info: SdkSessionInfo, options: LaunchOptions): void {
    const isContainerized = !!options.containerId;

    let binary = options.codexBinary || "codex";
    if (!isContainerized) {
      const resolved = resolveBinary(binary);
      if (resolved) {
        binary = resolved;
      } else {
        console.error(`[cli-launcher] Binary "${binary}" not found in PATH`);
        info.state = "exited";
        info.exitCode = 127;
        this.persistState();
        return;
      }
    }

    const args: string[] = ["app-server"];
    // Enable Codex multi-agent mode by default (product decision).
    args.push("--enable", "multi_agent");
    const internetEnabled = options.codexInternetAccess !== false;
    args.push("-c", `tools.webSearch=${internetEnabled ? "true" : "false"}`);
    const codexHome = resolveCompanionCodexSessionHome(
      sessionId,
      options.codexHome,
    );
    if (!isContainerized) {
      this.prepareCodexHome(codexHome);
    }

    let spawnCmd: string[];
    let spawnEnv: Record<string, string | undefined>;
    let spawnCwd: string | undefined;

    if (isContainerized) {
      // Run Codex inside the container via docker exec -i (stdin required for JSON-RPC)
      const dockerArgs = ["docker", "exec", "-i"];
      if (options.env) {
        for (const [k, v] of Object.entries(options.env)) {
          dockerArgs.push("-e", `${k}=${v}`);
        }
      }
      dockerArgs.push("-e", "CLAUDECODE=");
      // Point Codex at /root/.codex where container-manager seeded auth/config
      dockerArgs.push("-e", "CODEX_HOME=/root/.codex");
      dockerArgs.push(options.containerId!);
      // Use a login shell so ~/.bashrc is sourced and nvm/bun/deno/etc are on PATH
      const innerCmd = [binary, ...args].map(a => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
      dockerArgs.push("bash", "-lc", innerCmd);

      spawnCmd = dockerArgs;
      spawnEnv = { ...process.env, PATH: getEnrichedPath() };
      spawnCwd = undefined;
    } else {
      // Host-based spawn — resolve node/shebang issues
      const binaryDir = resolve(binary, "..");
      const siblingNode = join(binaryDir, "node");
      const enrichedPath = getEnrichedPath();
      const pathSep = process.platform === "win32" ? ";" : ":";
      const spawnPath = [binaryDir, ...enrichedPath.split(pathSep)].filter(Boolean).join(pathSep);

      if (existsSync(siblingNode)) {
        let codexScript: string;
        try {
          codexScript = realpathSync(binary);
        } catch {
          codexScript = binary;
        }
        spawnCmd = [siblingNode, codexScript, ...args];
      } else {
        // On Windows, .cmd/.bat files cannot be spawned directly by Bun.spawn
        const isCmdScript = process.platform === "win32" && (binary.endsWith(".cmd") || binary.endsWith(".bat"));
        spawnCmd = isCmdScript ? ["cmd.exe", "/c", binary, ...args] : [binary, ...args];
      }

      spawnEnv = {
        ...process.env,
        CLAUDECODE: undefined,
        ...options.env,
        CODEX_HOME: codexHome,
        PATH: spawnPath,
      };
      spawnCwd = info.cwd;
    }

    console.log(
      `[cli-launcher] Spawning Codex session ${sessionId}${isContainerized ? " (container)" : ""}: ` +
      sanitizeSpawnArgsForLog(spawnCmd),
    );

    const proc = Bun.spawn(spawnCmd, {
      cwd: spawnCwd,
      env: spawnEnv,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    info.pid = proc.pid;
    this.processes.set(sessionId, proc);
    // PLAN T7 (Phase D): runtime-sidecar write for Codex stdio spawn.
    this.writeRuntimeSidecarForSpawn(sessionId, proc.pid, spawnCmd);

    // Pipe stderr for debugging (stdout is used for JSON-RPC)
    const stderr = proc.stderr;
    if (stderr && typeof stderr !== "number") {
      this.pipeStream(sessionId, stderr, "stderr");
    }

    // Create the CodexAdapter which handles JSON-RPC and message translation
    // Pass the raw permission mode — the adapter maps it to Codex's approval policy
    const adapter = new CodexAdapter(proc, sessionId, {
      model: options.model,
      cwd: info.cwd,
      executionCwd: options.containerId ? (info.containerCwd || "/workspace") : info.cwd,
      approvalMode: options.permissionMode,
      threadId: info.cliSessionId,
      sandbox: options.codexSandbox,
      recorder: this.recorder ?? undefined,
      systemPrompt: options.systemPrompt,
    });

    // Handle init errors — mark session as exited so UI shows failure.
    // Also clear cliSessionId so the next relaunch starts a fresh thread
    // instead of trying to resume one whose rollout may be missing.
    adapter.onInitError((error) => {
      console.error(`[cli-launcher] Codex session ${sessionId} init failed: ${error}`);
      // P1 #1 generation guard: a newer spawn already owns this session;
      // the old init-error must not respawn or mark the live session exited.
      if (this.isSupersededGeneration(sessionId, proc)) {
        try { proc.kill("SIGTERM"); } catch {}
        return;
      }
      const session = this.sessions.get(sessionId);
      if (session) {
        if (this.isCodexModelAvailabilityError(error)) {
          this.markCodexModelRejected(sessionId, session.model);
          const resolved = this.resolveCodexLaunchModel(sessionId, session.model);
          if (resolved.ok && resolved.model !== session.model) {
            try { proc.kill("SIGTERM"); } catch {}
            session.state = "starting";
            session.exitCode = undefined;
            session.cliSessionId = undefined;
            session.model = resolved.model;
            this.persistState();
            this.spawnCodex(sessionId, session, { ...options, model: resolved.model });
            return;
          }
        }
        session.state = "exited";
        session.exitCode = 1;
        session.cliSessionId = undefined;
      }
      this.persistState();
    });

    // Notify the WsBridge to attach this adapter
    companionBus.emit("backend:codex-adapter-created", { sessionId, adapter });

    // Mark as connected immediately (no WS handshake needed for stdio)
    info.state = "connected";

    // Monitor process exit
    proc.exited.then((exitCode) => {
      console.log(`[cli-launcher] Codex session ${sessionId} exited (code=${exitCode})`);
      // P1 #1 generation guard: if a newer spawn already owns this session's
      // process slot, this stale exit must not mark the live session exited,
      // delete the (now newer) map entry, persist, or emit session:exited.
      if (this.isSupersededGeneration(sessionId, proc)) {
        return;
      }
      const session = this.sessions.get(sessionId);
      if (session) {
        session.state = "exited";
        session.exitCode = exitCode;
      }
      this.processes.delete(sessionId);
      this.persistState();
      companionBus.emit("session:exited", { sessionId, exitCode });
    });

    this.persistState();
  }

  /**
   * Mark a session as connected (called when CLI establishes WS connection).
   */
  markConnected(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session && (session.state === "starting" || session.state === "connected")) {
      session.state = "connected";
      console.log(`[cli-launcher] Session ${sessionId} connected via WebSocket`);
      this.persistState();
    }
  }

  /**
   * Store the CLI's internal session ID (from system.init message).
   * This is needed for --resume on relaunch.
   */
  setCLISessionId(sessionId: string, cliSessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.cliSessionId = cliSessionId;
      this.persistState();
    }
  }

  /**
   * Kill a session's CLI process.
   */
  async kill(sessionId: string): Promise<boolean> {
    const proxy = this.codexWsProxies.get(sessionId);
    if (proxy) {
      try { proxy.kill("SIGTERM"); } catch {}
      this.codexWsProxies.delete(sessionId);
    }

    const session = this.sessions.get(sessionId);
    const proc = this.processes.get(sessionId);
    if (!proc) {
      // No in-process handle. A session that survived a server restart
      // (systemd KillMode=process) keeps its CLI subprocess alive under
      // `info.pid` (re-parented to PPID=1) but was never spawned by THIS
      // bun instance, so `this.processes` is empty. Without this branch,
      // archive/delete would SIGTERM nothing and the CLI would leak forever
      // (`archived:true` + live process — neither orphan-reaper nor
      // restart-reconcile reclaims it). Mirror the relaunch path: EC-45
      // identity-verify the inherited PID, then SIGTERM→grace→SIGKILL.
      if (session?.pid && this.shouldSignalPreviousInstancePid(session)) {
        const pid = session.pid;
        try { process.kill(pid, "SIGTERM"); } catch {}
        const exited = await this.waitForPidExit(pid, 5_000);
        if (!exited) {
          console.log(`[cli-launcher] Force-killing restart-survived session ${sessionId} (pid ${pid})`);
          try { process.kill(pid, "SIGKILL"); } catch {}
        }
        session.state = "exited";
        session.exitCode = -1;
        this.releaseCodexWsPort(session);
        session.pid = undefined;
        this.persistState();
        return true;
      }
      return !!proxy;
    }

    proc.kill("SIGTERM");

    // Wait up to 5s for graceful exit, then force kill
    const exited = await Promise.race([
      proc.exited.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000)),
    ]);

    if (!exited) {
      console.log(`[cli-launcher] Force-killing session ${sessionId}`);
      proc.kill("SIGKILL");
    }

    if (session) {
      session.state = "exited";
      session.exitCode = -1;
      this.releaseCodexWsPort(session);
    }
    this.processes.delete(sessionId);
    this.persistState();
    return true;
  }

  /**
   * Poll `process.kill(pid, 0)` until the process is gone or `timeoutMs`
   * elapses. Used to enforce a SIGTERM→grace→SIGKILL discipline against an
   * inherited PID for which we hold no `Bun.Subprocess.exited` promise.
   */
  private async waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        return true; // ESRCH — process is gone
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }

  /**
   * List all sessions (active + recently exited).
   */
  listSessions(): SdkSessionInfo[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Get a specific session.
   */
  getSession(sessionId: string): SdkSessionInfo | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Check if a session exists and is alive (not exited).
   */
  isAlive(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return !!session && session.state !== "exited";
  }

  /**
   * Set the archived flag on a session.
   */
  setArchived(sessionId: string, archived: boolean): void {
    const info = this.sessions.get(sessionId);
    if (info) {
      info.archived = archived;
      this.persistState();
    }
  }

  /**
   * Remove a session from the internal map (after kill or cleanup).
   */
  removeSession(sessionId: string) {
    this.releaseCodexWsPort(this.sessions.get(sessionId));
    this.sessions.delete(sessionId);
    this.processes.delete(sessionId);
    this.codexWsProxies.delete(sessionId);
    this.sessionEnvs.delete(sessionId);
    this.persistState();
  }

  /**
   * Remove exited sessions from the list.
   */
  pruneExited(): number {
    let pruned = 0;
    for (const [id, session] of this.sessions) {
      if (session.state === "exited") {
        this.releaseCodexWsPort(session);
        this.sessions.delete(id);
        this.sessionEnvs.delete(id);
        this.codexWsProxies.delete(id);
        pruned++;
      }
    }
    return pruned;
  }

  /**
   * Kill all sessions.
   */
  async killAll(): Promise<void> {
    const ids = [...this.processes.keys()];
    await Promise.all(ids.map((id) => this.kill(id)));
  }

  private async pipeStream(
    sessionId: string,
    stream: ReadableStream<Uint8Array> | null,
    label: "stdout" | "stderr",
  ): Promise<void> {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const log = label === "stdout" ? console.log : console.error;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value);
        if (text.trim()) {
          log(`[session:${sessionId}:${label}] ${text.trimEnd()}`);
        }
      }
    } catch {
      // stream closed
    }
  }

  private pipeOutput(sessionId: string, proc: Subprocess): void {
    const stdout = proc.stdout;
    const stderr = proc.stderr;
    if (stdout && typeof stdout !== "number") {
      this.pipeStream(sessionId, stdout, "stdout");
    }
    if (stderr && typeof stderr !== "number") {
      this.pipeStream(sessionId, stderr, "stderr");
    }
  }
}
