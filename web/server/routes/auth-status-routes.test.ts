import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { DoctorReport, ProviderAuthStatus } from "../auth-status/auth-types.js";
import type { StatusSnapshot } from "../auth-status/status-core.js";

// The real router is mounted in the middleware test below; the singletons are
// replaced so the test can prove no handler ran on a 401.
const statusCoreSpy = { peek: vi.fn(() => null), recheck: vi.fn() };
const doctorSpy = { peek: vi.fn(() => null), recheck: vi.fn() };
vi.mock("../auth-status/service-status.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth-status/service-status.js")>()),
  getServiceAuthStatusCore: () => statusCoreSpy,
}));
vi.mock("../auth-status/doctor-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth-status/doctor-service.js")>()),
  getServiceDoctorRunner: () => doctorSpy,
}));

import { createRoutes } from "../routes.js";
import { _resetForTest } from "../auth-manager.js";
import {
  homeRelativePath,
  projectBackendAuthState,
  registerAuthStatusRoutes,
  type AuthStatusRoutesDeps,
} from "./auth-status-routes.js";

/**
 * LLM-auth REST (plan task 8, spec S1 + S2 surfaces). What is pinned:
 * - every route sits behind the shared `/api` auth middleware (remote, no
 *   token → 401, handler never runs) — hunt #4 / dahl A3;
 * - GET is cache-only (never a probe or doctor run);
 * - rejected credentials are 200 + `state: "invalid"`, never 401/403;
 * - provider ids come from a closed set (400 otherwise);
 * - recheck is rate-limited (429 + Retry-After);
 * - no absolute path in any payload.
 */

const originalToken = process.env.COMPANION_AUTH_TOKEN;
afterEach(() => {
  if (originalToken === undefined) delete process.env.COMPANION_AUTH_TOKEN;
  else process.env.COMPANION_AUTH_TOKEN = originalToken;
  _resetForTest();
  vi.clearAllMocks();
});

function status(provider: "claude" | "codex", over: Partial<ProviderAuthStatus> = {}): ProviderAuthStatus {
  return {
    provider,
    state: "working",
    reason: null,
    account: { known: true, value: "owner@example.com" },
    plan: { known: true, value: "max" },
    method: { known: true, value: "subscription" },
    tokenExpiresAt: { known: true, value: 1_800_000_000_000 },
    lastSuccessAt: 1_700_000_000_000,
    checkedAt: 1_700_000_000_000,
    verifiedBy: "provider",
    cli: { path: { known: true, value: `/home/svc/.local/bin/${provider}` }, version: { known: true, value: "1.0.0" } },
    ...over,
  };
}

function snapshot(claude: Partial<ProviderAuthStatus> = {}): StatusSnapshot {
  return { providers: { claude: status("claude", claude), codex: status("codex") }, computedBy: "service" };
}

const doctorReport: DoctorReport = {
  checkedAt: 1,
  computedBy: "service",
  serviceUser: "svc",
  providers: {
    claude: { provider: "claude", launched: null, requiredVersion: { known: true, value: "2.1.280" }, findings: [], unchecked: [] },
    codex: {
      provider: "codex",
      launched: null,
      requiredVersion: { known: false },
      findings: [{ kind: "credential_copy", provider: "codex", copy: { place: "root_home", homeUser: "root", relPath: ".codex/auth.json", absPath: "/root/.codex/auth.json", owner: "root", mode: 0o600 } }],
      unchecked: [],
    },
  },
};

function app(over: Partial<AuthStatusRoutesDeps> = {}) {
  const core = { peek: vi.fn((): StatusSnapshot | null => snapshot()), recheck: vi.fn() };
  const doctor = { peek: vi.fn((): DoctorReport | null => doctorReport), recheck: vi.fn() };
  const api = new Hono();
  registerAuthStatusRoutes(api, { statusCore: () => core, doctor: () => doctor, serviceHome: "/home/svc", ...over });
  const root = new Hono();
  root.route("/api", api);
  return { root, core, doctor };
}

describe("llm-auth routes behind the shared auth middleware", () => {
  it("rejects remote requests without (or with a wrong) token before any handler runs", async () => {
    process.env.COMPANION_AUTH_TOKEN = "llm-auth-route-test-token-123456789";
    const root = new Hono();
    root.route("/api", createRoutes({} as never, {} as never, {} as never, {} as never));
    const endpoints = [
      ["GET", "/llm-auth/status"], ["GET", "/llm-auth/status/claude"], ["POST", "/llm-auth/recheck"],
      ["GET", "/llm-auth/doctor"], ["POST", "/llm-auth/doctor/recheck"],
    ] as const;
    for (const [method, path] of endpoints) {
      for (const token of [undefined, "wrong-token"]) {
        const res = await root.request(`http://remote.test/api${path}`, {
          method,
          headers: { "X-Forwarded-For": "203.0.113.9", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        });
        expect(res.status, `${method} ${path}`).toBe(401);
      }
    }
    expect(statusCoreSpy.peek).not.toHaveBeenCalled();
    expect(statusCoreSpy.recheck).not.toHaveBeenCalled();
    expect(doctorSpy.peek).not.toHaveBeenCalled();
    expect(doctorSpy.recheck).not.toHaveBeenCalled();

    // With the real token the same router serves the (cache-only) GET.
    const ok = await root.request("http://remote.test/api/llm-auth/status", {
      headers: { Authorization: `Bearer ${process.env.COMPANION_AUTH_TOKEN}` },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ status: null });
    expect(statusCoreSpy.recheck).not.toHaveBeenCalled();
  });
});

describe("GET /llm-auth/status", () => {
  it("serves the cache only and never starts a probe", async () => {
    const { root, core } = app();
    const res = await root.request("/api/llm-auth/status");
    expect(res.status).toBe(200);
    expect(core.peek).toHaveBeenCalled();
    expect(core.recheck).not.toHaveBeenCalled();
  });

  it("returns rejected credentials as 200 + invalid (never 401/403, which the browser reads as an Aura logout)", async () => {
    const { root, core } = app();
    core.peek.mockReturnValue(snapshot({ state: "invalid", verifiedBy: "provider" }));
    const res = await root.request("/api/llm-auth/status/claude");
    expect(res.status).toBe(200);
    expect((await res.json()).status.state).toBe("invalid");
  });

  it("accepts only known provider ids", async () => {
    const { root } = app();
    expect((await root.request("/api/llm-auth/status/gemini")).status).toBe(400);
    expect((await root.request("/api/llm-auth/status/..%2Fetc")).status).toBe(400);
    expect((await root.request("/api/llm-auth/status/codex")).status).toBe(200);
  });

  it("renders CLI paths relative to HOME — no absolute path leaves the server", async () => {
    const { root } = app();
    const body = await (await root.request("/api/llm-auth/status")).json();
    expect(body.status.providers.claude.cli.path).toEqual({ known: true, value: "~/.local/bin/claude" });
    expect(JSON.stringify(body)).not.toContain("/home/svc");
  });
});

describe("POST /llm-auth/recheck", () => {
  it("rechecks and returns the fresh snapshot", async () => {
    const { root, core } = app();
    core.recheck.mockResolvedValue({ kind: "ok", snapshot: snapshot() });
    const res = await root.request("/api/llm-auth/recheck", { method: "POST" });
    expect(res.status).toBe(200);
    expect((await res.json()).status.providers.codex.state).toBe("working");
  });

  it("is rate-limited: 429 + Retry-After + the cached snapshot", async () => {
    const { root, core } = app();
    core.recheck.mockResolvedValue({ kind: "too_soon", retryAfterMs: 12_300, snapshot: snapshot() });
    const res = await root.request("/api/llm-auth/recheck", { method: "POST" });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("13");
    const body = await res.json();
    expect(body.retryAfterMs).toBe(12_300);
    expect(body.status.providers.claude.state).toBe("working");
  });
});

describe("doctor routes", () => {
  it("GET serves the cached report without absolute paths", async () => {
    const { root, doctor } = app();
    const res = await root.request("/api/llm-auth/doctor");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("absPath");
    expect(text).not.toContain("/root/.codex");
    expect(JSON.parse(text).report.providers.codex.findings[0].copy).toMatchObject({ place: "root_home", relPath: ".codex/auth.json", owner: "root" });
    expect(doctor.recheck).not.toHaveBeenCalled();
  });

  it("POST recheck runs it (rate-limited like the status recheck)", async () => {
    const { root, doctor } = app();
    doctor.recheck.mockResolvedValueOnce({ kind: "ok", report: doctorReport });
    expect((await root.request("/api/llm-auth/doctor/recheck", { method: "POST" })).status).toBe(200);
    doctor.recheck.mockResolvedValueOnce({ kind: "too_soon", retryAfterMs: 1000, report: doctorReport });
    const limited = await root.request("/api/llm-auth/doctor/recheck", { method: "POST" });
    expect(limited.status).toBe(429);
    expect(await limited.text()).not.toContain("absPath");
  });
});

describe("helpers", () => {
  it("homeRelativePath maps service, root and other homes; other paths keep only the file name", () => {
    expect(homeRelativePath("/home/svc/.local/bin/claude", "/home/svc")).toBe("~/.local/bin/claude");
    expect(homeRelativePath("/root/.local/share/claude/versions/2.1.120", "/home/svc")).toBe("~root/.local/share/claude/versions/2.1.120");
    expect(homeRelativePath("/home/other/bin/codex", "/home/svc")).toBe("~other/bin/codex");
    // Outside every HOME only the file name survives (observer review 198 STOP).
    expect(homeRelativePath("/usr/bin/codex", "/home/svc")).toBe("…/codex");
    expect(homeRelativePath("/srv/companion/bin/claude", "/home/svc")).toBe("…/claude");
  });

  it("/api/backends authState is a projection: provider verdicts win, local-only states keep the legacy value", () => {
    // Strangler fig (plan task 8): the New Session picker must not say
    // "authorized" for credentials the provider just rejected.
    const legacy = { authState: "authorized" as const, authMethod: "oauth" as const };
    expect(projectBackendAuthState(null, legacy)).toEqual(legacy);
    expect(projectBackendAuthState(status("claude", { state: "invalid" }), legacy)).toEqual({ authState: "expired", authMethod: "oauth" });
    expect(projectBackendAuthState(status("claude", { state: "not_signed_in" }), legacy).authState).toBe("unauthorized");
    expect(projectBackendAuthState(status("claude", { state: "no_network" }), legacy)).toEqual(legacy);
    expect(projectBackendAuthState(status("claude", { state: "not_verified", reason: "cli_version_unproven", verifiedBy: "local" }), { authState: "expired" })).toEqual({ authState: "expired" });
    expect(projectBackendAuthState(status("codex", { state: "working", verifiedBy: "provider" }), { authState: "expired" }).authState).toBe("authorized");
  });
});
