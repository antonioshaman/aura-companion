import { accessSync, constants, readdirSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { log } from "../logger.js";
import { COMPANION_HOME } from "../paths.js";
import { resolveBinary } from "../path-resolver.js";
import { getSettings } from "../settings-manager.js";
import type { ProviderId } from "./auth-types.js";
import { requestClaudeUsage } from "./claude-usage-request.js";
import { locateClaudeOAuth, locateCodexAuth, readClaudeOAuthSecret, statMeta } from "./credential-locator.js";
import { runBoundedProbe } from "./probe-runner.js";
import { probeClaudeAuth, probeCodexAuth, type CodexProviderEvidence, type ProbeEvent, type ProviderProbeDeps } from "./provider-probes.js";
import { LAST_CHECK_FILE, StatusCore, resolveServiceIdentity, type CallerInfo } from "./status-core.js";

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
  unitTexts?: readonly string[];
  companionHome?: string;
}

export function createAuthStatusCore(opts: CreateAuthStatusCoreOptions): StatusCore {
  const me = userInfo();
  const caller: CallerInfo = { uid: me.uid, username: me.username, env: process.env };
  const identity = resolveServiceIdentity({
    isServiceProcess: opts.mode === "service",
    caller,
    unitTexts: opts.mode === "service" ? [] : opts.unitTexts ?? readUnitTexts(),
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
      onEvent: logProbeEvent,
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
