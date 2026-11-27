import { StringDecoder } from "node:string_decoder";
import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { getCodexModelsCachePath } from "./codex-models.js";
import { getLegacyCodexHome } from "./codex-home.js";
import { resolveBinary } from "./path-resolver.js";
import { getSettings } from "./settings-manager.js";
import { reconcileProviderAuthForRelaunch } from "./provider-auth-env.js";
import { escalateKill, type KillEscalation } from "./auth-status/probe-runner.js";

const HOUR = 3_600_000;
/** A fresh CLI-owned cache, not the public documentation, authorizes the picker. */
export function hasFreshCodexCatalog(path = getCodexModelsCachePath(), now = Date.now()): boolean {
  try {
    if (statSync(path).size > 2_000_000) return false;
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const at = typeof raw.fetched_at === "string" ? Date.parse(raw.fetched_at) : NaN;
    return at > 0 && at <= now + 60_000 && now - at < HOUR && Array.isArray(raw.models) && raw.models.length > 0 && raw.models.every((m: { slug?: unknown }) => m && typeof m.slug === "string");
  } catch { return false; }
}

/** Only initialize and model/list: no thread, turn, login or install operation. */
export function probeCodexCatalog(binary: string, env: NodeJS.ProcessEnv, spawnProcess = spawn): Promise<boolean> {
  return new Promise(resolve => {
    let child: ReturnType<typeof spawn>;
    try { child = spawnProcess(binary, ["app-server", "--stdio"], { cwd: homedir(), env, shell: false, stdio: ["pipe", "pipe", "ignore"], windowsHide: true }); }
    catch { resolve(false); return; }
    const decoder = new StringDecoder("utf8");
    let pending = "";
    let bytes = 0;
    let stage = 1;
    let success = false;
    let stopping = false;
    let settled = false;
    let escalation: KillEscalation | undefined;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      escalation = escalateKill(signal => { if (child.exitCode === null && child.signalCode === null) child.kill(signal); }, 1000);
    };
    const deadline = setTimeout(() => { success = false; stop(); }, 15_000);
    const finish = () => { if (settled) return; settled = true; clearTimeout(deadline); escalation?.cancel(); resolve(success); };
    const send = (frame: object) => { child.stdin?.write(JSON.stringify(frame) + "\n"); };
    child.stdin?.on("error", () => { success = false; stop(); });
    child.on("error", () => { success = false; if (child.pid === undefined) finish(); else stop(); });
    child.on("close", finish); // Settle only after the owned process and pipes have closed.
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stopping) return;
      try {
        bytes += chunk.length;
        if (bytes > 1_000_000) throw new Error();
        pending += decoder.write(chunk);
        let newline: number;
        while ((newline = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
          if (!line.trim()) continue;
          const frame: unknown = JSON.parse(line);
          if (!frame || typeof frame !== "object" || Array.isArray(frame)) throw new Error();
          const response = frame as Record<string, unknown>;
          if (typeof response.method === "string" && !("id" in response)) {
            const info = response.params;
            if (!["remoteControl/status/changed", "configWarning", "warning", "deprecationNotice", "account/updated", "account/rateLimits/updated"].includes(response.method) || !info || typeof info !== "object" || Array.isArray(info)) throw new Error();
            // These are informational notifications, not replies or permission requests.
            continue;
          }
          if (response.id !== stage || "error" in response || !response.result || typeof response.result !== "object" || Array.isArray(response.result) || "method" in response) throw new Error();
          if (stage === 1) {
            if (typeof (response.result as { userAgent?: unknown }).userAgent !== "string") throw new Error();
            stage = 2;
            send({ method: "initialized", params: {} });
            send({ id: 2, method: "model/list", params: { limit: 100, includeHidden: false } });
          } else {
            const data = (response.result as { data?: unknown }).data;
            if (!Array.isArray(data) || data.length === 0 || data.length > 100 || !data.every(m => m && typeof m.model === "string" && typeof m.hidden === "boolean")) throw new Error();
            success = true; stop(); break;
          }
        }
      } catch { success = false; stop(); }
    });
    try { send({ id: 1, method: "initialize", params: { clientInfo: { name: "aura_model_catalog", version: "1" }, capabilities: null } }); }
    catch { stop(); }
  });
}

let inFlight: Promise<"ok" | "unavailable"> | null = null;
let lastAttempt = -Infinity;
let lastResult: "ok" | "unavailable" = "unavailable";
/** Shared across routes and tabs; a failing provider is retried at most once/minute. */
export function refreshCodexModels(force = false): Promise<"ok" | "unavailable"> {
  if (inFlight) return inFlight;
  if (!force && hasFreshCodexCatalog()) return Promise.resolve("ok");
  if (Date.now() - lastAttempt < 60_000) return Promise.resolve(lastResult === "ok" && hasFreshCodexCatalog() ? "ok" : "unavailable");
  lastAttempt = Date.now();
  inFlight = (async () => {
    try {
      const binary = resolveBinary("codex");
      if (!binary) return "unavailable" as const;
      const env = { ...process.env, ...reconcileProviderAuthForRelaunch(process.env, "codex", getSettings()), CODEX_HOME: getLegacyCodexHome() };
      return await probeCodexCatalog(binary, env) && hasFreshCodexCatalog() ? "ok" as const : "unavailable" as const;
    } catch { return "unavailable" as const; }
  })().then(result => { lastResult = result; return result; }).finally(() => { inFlight = null; });
  return inFlight;
}
