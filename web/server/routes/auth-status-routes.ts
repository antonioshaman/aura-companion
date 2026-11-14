import type { Hono } from "hono";
import { homedir } from "node:os";
import { basename, relative, sep } from "node:path";
import { PROVIDER_IDS, type ProviderAuthStatus, type ProviderId } from "../auth-status/auth-types.js";
import { toRestDoctorReport } from "../auth-status/doctor-checks.js";
import type { DoctorRunner } from "../auth-status/doctor-service.js";
import type { StatusCore, StatusSnapshot } from "../auth-status/status-core.js";
import type { AuthState, BackendAuthStatus } from "../host-auth-status.js";

/**
 * LLM-auth status + doctor REST (plan task 8). Registered AFTER the shared
 * `/api` auth middleware, so a non-local request without the Aura token is
 * 401 before any handler runs.
 *
 * - GET = cache only. A cross-site `<img src>` can reach a localhost GET, so
 *   no GET ever starts a provider probe or a doctor run (hunt #4).
 * - POST = recheck, single-flight, at most one per 30 s (owner default b).
 * - Credentials the provider rejects are `200` + `state: "invalid"`, never
 *   401/403: the browser reads 401 as "Aura login expired".
 * - No absolute paths: doctor places are class + home-relative path (or a
 *   redacted tail); a CLI path is `~/…`, `~user/…` or `…/name`. Full paths
 *   exist only in the CLI.
 */

export interface AuthStatusRoutesDeps {
  statusCore: () => Pick<StatusCore, "peek" | "recheck">;
  doctor: () => Pick<DoctorRunner, "peek" | "recheck">;
  /** Service HOME for `~/` rendering of CLI paths. */
  serviceHome?: string;
}

function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}

/**
 * `/home/svc/.local/bin/claude` → `~/.local/bin/claude`; `/root/x` → `~root/x`;
 * any other absolute path keeps only its file name (`…/codex`) — no absolute
 * path leaves the server (observer review 198 STOP).
 */
export function homeRelativePath(path: string, serviceHome: string): string {
  const under = (root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
  if (serviceHome && under(serviceHome)) return `~/${relative(serviceHome, path)}`;
  if (under("/root")) return `~root/${relative("/root", path)}`;
  if (under("/home")) {
    const [user, ...rest] = relative("/home", path).split(sep);
    if (user) return `~${user}/${rest.join("/")}`;
  }
  return `…/${basename(path)}`;
}

export function toRestProviderStatus(status: ProviderAuthStatus, serviceHome: string): ProviderAuthStatus {
  const path = status.cli.path;
  return path.known ? { ...status, cli: { ...status.cli, path: { known: true, value: homeRelativePath(path.value, serviceHome) } } } : status;
}

export function toRestStatusSnapshot(snapshot: StatusSnapshot | null, serviceHome: string): StatusSnapshot | null {
  if (!snapshot) return null;
  const providers = Object.fromEntries(
    PROVIDER_IDS.map((id) => [id, toRestProviderStatus(snapshot.providers[id], serviceHome)]),
  ) as StatusSnapshot["providers"];
  return { ...snapshot, providers };
}

/**
 * Strangler fig: `/api/backends` `authState` becomes a projection of the new
 * status where the new status knows better (provider verdict, or nothing
 * signed in); otherwise the legacy local check stands.
 */
export function projectBackendAuthState(status: ProviderAuthStatus | null | undefined, legacy: BackendAuthStatus): BackendAuthStatus {
  if (!status) return legacy;
  let authState: AuthState | null = null;
  if (status.state === "working" && status.verifiedBy === "provider") authState = "authorized";
  else if (status.state === "invalid") authState = "expired";
  else if (status.state === "not_signed_in") authState = "unauthorized";
  return authState ? { ...legacy, authState } : legacy;
}

export function registerAuthStatusRoutes(api: Hono, deps: AuthStatusRoutesDeps): void {
  const home = () => deps.serviceHome ?? process.env.HOME ?? homedir();

  api.get("/llm-auth/status", (c) => {
    return c.json({ status: toRestStatusSnapshot(deps.statusCore().peek(), home()) });
  });

  api.get("/llm-auth/status/:provider", (c) => {
    const provider = c.req.param("provider");
    if (!isProviderId(provider)) return c.json({ error: "unknown provider" }, 400);
    const snapshot = deps.statusCore().peek();
    return c.json({ status: snapshot ? toRestProviderStatus(snapshot.providers[provider], home()) : null });
  });

  api.post("/llm-auth/recheck", async (c) => {
    const outcome = await deps.statusCore().recheck();
    if (outcome.kind === "too_soon") {
      c.header("Retry-After", String(Math.ceil(outcome.retryAfterMs / 1000)));
      return c.json({ error: "too_soon", retryAfterMs: outcome.retryAfterMs, status: toRestStatusSnapshot(outcome.snapshot, home()) }, 429);
    }
    return c.json({ status: toRestStatusSnapshot(outcome.snapshot, home()) });
  });

  api.get("/llm-auth/doctor", (c) => {
    const report = deps.doctor().peek();
    return c.json({ report: report ? toRestDoctorReport(report) : null });
  });

  api.post("/llm-auth/doctor/recheck", async (c) => {
    const outcome = await deps.doctor().recheck();
    if (outcome.kind === "too_soon") {
      c.header("Retry-After", String(Math.ceil(outcome.retryAfterMs / 1000)));
      return c.json({ error: "too_soon", retryAfterMs: outcome.retryAfterMs, report: outcome.report ? toRestDoctorReport(outcome.report) : null }, 429);
    }
    return c.json({ report: toRestDoctorReport(outcome.report) });
  });
}
