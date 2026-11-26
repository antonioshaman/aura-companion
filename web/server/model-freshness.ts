import { execFile } from "node:child_process";
import { resolveBinary } from "./path-resolver.js";

export interface ModelFreshness {
  status: "fresh" | "stale" | "missing" | "malformed" | "no-key";
  fetchedAt: number | null; catalogClientVersion: string | null; installedCliVersion: string | null;
  refresh: "upstream" | "local-only"; scope: "installation";
}
/** Freshness says nothing about entitlement. A missing/invalid date is not fresh. */
export function modelFreshness(input: { present: boolean; fetchedAt: unknown; valid: boolean; clientVersion?: string | null; keyConfigured?: boolean }, backend: "claude" | "codex", now = Date.now()): ModelFreshness {
  const n = typeof input.fetchedAt === "number" ? input.fetchedAt : typeof input.fetchedAt === "string" ? Date.parse(input.fetchedAt) : NaN;
  const date = Number.isFinite(n) && n > 0 && n <= now + 60_000 ? n : null;
  return {
    status: input.keyConfigured === false ? "no-key" : !input.present ? "missing" : !input.valid ? "malformed" : date === null || now - date > 86_400_000 ? "stale" : "fresh",
    fetchedAt: date, catalogClientVersion: input.clientVersion ?? null, installedCliVersion: null,
    refresh: backend === "claude" ? "upstream" : "local-only", scope: "installation",
  };
}
const versionCache = new Map<string, { until: number; value: Promise<string | null> }>();
/** Identical installation reads share one bounded probe, including unavailable observations. */
export function installedCliVersion(backend: "claude" | "codex"): Promise<string | null> {
  const cached = versionCache.get(backend);
  if (cached && cached.until > Date.now()) return cached.value;
  const value = probeCliVersion(backend);
  versionCache.set(backend, { until: Date.now() + 60_000, value });
  return value;
}
/** Trusted executable and fixed argv only. This probe never starts a session. */
async function probeCliVersion(backend: "claude" | "codex"): Promise<string | null> {
  try {
    const binary = resolveBinary(backend);
    if (!binary) return null;
    return await new Promise(resolve => {
      execFile(binary, ["--version"], { timeout: 2000, maxBuffer: 4096, encoding: "utf8" }, (error, stdout) => {
        resolve(error ? null : stdout.trim().slice(0, 100));
      });
    });
  } catch { return null; }
}
