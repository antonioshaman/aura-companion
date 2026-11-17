import { accessSync, constants, readdirSync, readFileSync } from "node:fs";
import { latestCodexLoginEvidence, latestCodexProviderEvidence } from "./codex-provider-evidence.js";
import { homedir, userInfo } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { log } from "../logger.js";
import { COMPANION_HOME } from "../paths.js";
import { resolveBinary } from "../path-resolver.js";
import { getSettings } from "../settings-manager.js";
import type { ProviderAuthStatus, ProviderId } from "./auth-types.js";
import { requestClaudeUsage } from "./claude-usage-request.js";
import { locateClaudeOAuth, locateCodexAuth, readClaudeOAuthSecret, statMeta } from "./credential-locator.js";
import { runBoundedProbe } from "./probe-runner.js";
import { probeClaudeAuth, probeCodexAuth, type CodexProviderEvidence, type ProbeEvent, type ProviderProbeDeps } from "./provider-probes.js";
import { LAST_CHECK_FILE, StatusCore, parseSystemdUnit, resolveServiceIdentity, type CallerInfo } from "./status-core.js";

/**
 * Production wiring of the status core. Phase 1b's REST routes call
 * `createAuthStatusCore({ mode: "service", ... })` once at boot; the offline
 * CLI calls it with `mode: "local_cli"` (reads the unit, never persists).
 */

export const DEFAULT_UNIT_PATH = "/etc/systemd/system/aura-companion.service";

/** Unit file + `<unit>.d/*.conf` drop-ins in systemd's (lexical) order; missing → []. */
export function readUnitTexts(unitPath: string = DEFAULT_UNIT_PATH): string[] {
  const texts: string[] = [];
  try {
    texts.push(readFileSync(unitPath, "utf-8"));
  } catch {
    return [];
  }
  try {
    for (const name of readdirSync(`${unitPath}.d`).filter((n) => n.endsWith(".conf")).sort()) {
      try {
        texts.push(readFileSync(join(`${unitPath}.d`, name), "utf-8"));
      } catch { /* unreadable drop-in: skip */ }
    }
  } catch { /* no drop-in dir */ }
  return texts;
}

/**
 * The user unit `aura-companion install` writes (service.ts UNIT_PATH). It has
 * no `User=` line: it runs as the user whose home it is in.
 */
export const USER_UNIT_PATH = join(homedir(), ".config", "systemd", "user", "aura-companion.service");

/**
 * The installed unit's texts — the system unit if present, else the user unit
 * (council review 2026-11-15, fowler #2: only the system path was read, so a
 * unit installed by `aura-companion install` was invisible and the service
 * user silently fell back to "unknown", switching off the wrong-user check).
 */
export function readServiceUnit(paths: { system: string; user: string } = { system: DEFAULT_UNIT_PATH, user: USER_UNIT_PATH }): { texts: string[]; kind: "system" | "user" | null } {
  const system = readUnitTexts(paths.system);
  if (system.length > 0) return { texts: system, kind: "system" };
  const user = readUnitTexts(paths.user);
  if (user.length > 0) return { texts: user, kind: "user" };
  return { texts: [], kind: null };
}

/** The user the installed service runs as; null when no unit is installed (dev) or a system unit names none. */
export function serviceUnitUser(
  paths?: { system: string; user: string },
  owner: () => string = () => userInfo().username,
): string | null {
  const unit = readServiceUnit(paths);
  const named = parseSystemdUnit(unit.texts).user;
  if (named) return named;
  return unit.kind === "user" ? owner() : null;
}

/** Resolve a binary strictly within `env.PATH` (the service's PATH, not ours). */
export function resolveInPath(name: string, env: NodeJS.ProcessEnv): string | null {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch { /* next */ }
  }
  return null;
}

function logProbeEvent(event: ProbeEvent): void {
  // EC-9/EC-23: structured, no paths, no tokens.
  const line = { ...event };
  if (event.event === "auth_probe.rotation_detected") log.warn("auth-status", event.event, line);
  else log.info("auth-status", event.event, line);
}

export interface CreateAuthStatusCoreOptions {
  mode: "service" | "local_cli";
  /** Live-session evidence for Codex (`account/rateLimits/read`), service mode only (wired in 1b/1c). */
  codexProviderEvidence?: () => CodexProviderEvidence | null;
  /** Phase 2 D8: evidence of a just-completed official Codex sign-in. */
  codexLoginEvidence?: () => CodexProviderEvidence | null;
  unitTexts?: readonly string[];
  companionHome?: string;
}

export function createAuthStatusCore(opts: CreateAuthStatusCoreOptions): StatusCore {
  const me = userInfo();
  const caller: CallerInfo = { uid: me.uid, username: me.username, env: process.env };
  const identity = resolveServiceIdentity({
    isServiceProcess: opts.mode === "service",
    caller,
    unitTexts: opts.mode === "service" ? [] : opts.unitTexts ?? readServiceUnit().texts,
  });

  const probeDeps = (env: NodeJS.ProcessEnv): ProviderProbeDeps => {
    const settings = getSettings();
    return {
      env,
      settings: {
        claudeCodeOAuthToken: settings.claudeCodeOAuthToken,
        anthropicApiKey: settings.anthropicApiKey,
        openaiApiKey: settings.openaiApiKey,
      },
      now: Date.now,
      // The service resolves the way session launches do; the CLI resolves in the unit's PATH.
      resolveBinary: identity.source === "service" ? resolveBinary : (name) => resolveInPath(name, env),
      runProbe: runBoundedProbe,
      locateClaude: locateClaudeOAuth,
      locateCodex: locateCodexAuth,
      readClaudeSecret: (e) => readClaudeOAuthSecret(e),
      requestClaudeUsage: (token) => requestClaudeUsage(token),
      statMeta,
      codexProviderEvidence: opts.codexProviderEvidence,
      codexLoginEvidence: opts.codexLoginEvidence,
      // The offline CLI must not print log lines into its output.
      onEvent: opts.mode === "service" ? logProbeEvent : undefined,
    };
  };

  const probes: Record<ProviderId, (env: NodeJS.ProcessEnv) => ReturnType<typeof probeClaudeAuth>> = {
    claude: (env) => probeClaudeAuth(probeDeps(env)),
    codex: (env) => probeCodexAuth(probeDeps(env)),
  };

  return new StatusCore({
    identity,
    caller,
    probes,
    now: Date.now,
    lastCheckPath: join(opts.companionHome ?? COMPANION_HOME, LAST_CHECK_FILE),
    persist: opts.mode === "service",
    computedBy: opts.mode === "service" ? "service" : "local_cli",
  });
}

let serviceCore: StatusCore | null = null;
/** The server's single status core (lazy; `mode: "service"`). */
export function getServiceAuthStatusCore(): StatusCore {
  serviceCore ??= createAuthStatusCore({
    mode: "service",
    codexProviderEvidence: latestCodexProviderEvidence,
    codexLoginEvidence: latestCodexLoginEvidence,
  });
  return serviceCore;
}

/**
 * Phase 2 task 6: the phase-1 probe pointed at a sign-in attempt's staging
 * home (account / plan of the NEW credentials before they go live). Only
 * HOME, PATH and the CLI config dir reach it: no env tokens, no Aura
 * settings keys (they would mask the staged sign-in), no live-session
 * evidence (it belongs to the old credentials).
 */
export function probeStagedCredentials(provider: ProviderId, stagingHome: string, serviceEnv: NodeJS.ProcessEnv): Promise<ProviderAuthStatus> {
  const env: NodeJS.ProcessEnv = {
    HOME: stagingHome,
    PATH: serviceEnv.PATH,
    ...(provider === "claude" ? { CLAUDE_CONFIG_DIR: join(stagingHome, ".claude") } : { CODEX_HOME: join(stagingHome, ".codex") }),
  };
  const deps: ProviderProbeDeps = {
    env,
    settings: { claudeCodeOAuthToken: "", anthropicApiKey: "", openaiApiKey: "" },
    now: Date.now,
    // The sign-in ran with the CLI sessions use; probe with the same one (resolved in the service PATH).
    resolveBinary: (name) => resolveInPath(name, serviceEnv) ?? resolveBinary(name),
    runProbe: runBoundedProbe,
    locateClaude: locateClaudeOAuth,
    locateCodex: locateCodexAuth,
    readClaudeSecret: (e) => readClaudeOAuthSecret(e),
    requestClaudeUsage: (token) => requestClaudeUsage(token),
    statMeta,
    onEvent: logProbeEvent,
  };
  return provider === "claude" ? probeClaudeAuth(deps) : probeCodexAuth(deps);
}
