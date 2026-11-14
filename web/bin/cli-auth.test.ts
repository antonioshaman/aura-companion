import { describe, expect, it, vi } from "vitest";
import { describeAuthState, describeDoctorFinding, describeDoctorUnchecked, formatAction } from "../server/auth-status/auth-catalog.js";
import type { DoctorReport, ProviderAuthStatus } from "../server/auth-status/auth-types.js";
import type { StatusSnapshot } from "../server/auth-status/status-core.js";
import { cliPort, fullPath, runAuthStatusCommand, runDoctorCommand, type CliAuthDeps } from "./cli-auth.js";

/**
 * `aura-companion auth status` / `aura-companion doctor` (plan task 9).
 * - S1-AC5: with a live server the CLI prints the server's payload, worded by
 *   the same catalog the UI uses (asserted against the catalog functions).
 * - Offline / unreachable → the same core computed locally.
 * - S2-AC5: exit code 0 clean, 1 findings, 2 not fully checked.
 * - REST paths are home-relative; the CLI expands them to full paths.
 */

function status(provider: "claude" | "codex", over: Partial<ProviderAuthStatus> = {}): ProviderAuthStatus {
  return {
    provider,
    state: "working",
    reason: null,
    account: { known: true, value: "owner@example.com" },
    plan: { known: true, value: "max" },
    method: { known: true, value: "subscription" },
    tokenExpiresAt: { known: false },
    lastSuccessAt: 1_700_000_000_000,
    checkedAt: 1_700_000_000_000,
    verifiedBy: "provider",
    cli: { path: { known: true, value: "~/.local/bin/claude" }, version: { known: true, value: "2.1.283" } },
    ...over,
  };
}

const snap = (claude: Partial<ProviderAuthStatus> = {}, codex: Partial<ProviderAuthStatus> = {}): StatusSnapshot => ({
  providers: { claude: status("claude", claude), codex: status("codex", { plan: { known: false }, ...codex }) },
  computedBy: "service",
});

function emptyReport(): DoctorReport {
  return {
    checkedAt: 1_700_000_000_000,
    computedBy: "service",
    serviceUser: "svc",
    providers: {
      claude: { provider: "claude", launched: null, requiredVersion: { known: true, value: "2.1.280" }, findings: [], unchecked: [] },
      codex: { provider: "codex", launched: null, requiredVersion: { known: false }, findings: [], unchecked: [] },
    },
  };
}

function harness(server: (path: string, method: string) => { status: number; body: unknown } | "down") {
  const lines: string[] = [];
  const deps: CliAuthDeps = {
    fetchJson: vi.fn(async (path: string, init?: { method?: string }) => {
      const r = server(path, init?.method ?? "GET");
      if (r === "down") throw new TypeError("fetch failed: ECONNREFUSED");
      return r;
    }),
    localStatus: vi.fn(async () => snap({ state: "not_verified", reason: "wrong_user", serviceUser: "svc", verifiedBy: "local" })),
    localDoctor: vi.fn(async () => emptyReport()),
    homeOf: (user) => ({ root: "/root", svc: "/home/svc" } as Record<string, string>)[user] ?? null,
    out: (line) => lines.push(line),
  };
  return { deps, lines, text: () => lines.join("\n") };
}

describe("auth status", () => {
  it("S1-AC5: prints the server's result with the UI catalog's words, account and plan", async () => {
    const h = harness((path) => (path === "/api/llm-auth/recheck" ? { status: 200, body: { status: snap({ state: "invalid" }) } } : "down"));
    const code = await runAuthStatusCommand([], h.deps);
    const invalid = describeAuthState("invalid", "claude");
    expect(h.text()).toContain("Source: running server");
    expect(h.lines).toContain(invalid.title);
    expect(h.text()).toContain(invalid.detail);
    expect(h.text()).toContain(`Action: ${formatAction(invalid.action)}`);
    expect(h.lines).toContain(describeAuthState("working", "codex").title);
    expect(h.text()).toContain("Account: owner@example.com · Plan: max · Sign-in: subscription");
    // Codex parity: a field the provider does not report reads "unknown", never blank.
    expect(h.text()).toContain("Plan: unknown");
    expect(h.deps.localStatus).not.toHaveBeenCalled();
    // Rejected credentials make the command fail for scripts.
    expect(code).toBe(1);
  });

  it("uses the cached status when the recheck is rate-limited and carried none", async () => {
    const h = harness((path) =>
      path === "/api/llm-auth/recheck" ? { status: 429, body: { status: null } } : { status: 200, body: { status: snap() } },
    );
    expect(await runAuthStatusCommand([], h.deps)).toBe(0);
    expect(h.deps.fetchJson).toHaveBeenCalledWith("/api/llm-auth/status");
    expect(h.text()).toContain("Source: running server");
  });

  it("falls back to the local core when the server is down, and says so", async () => {
    const h = harness(() => "down");
    const code = await runAuthStatusCommand([], h.deps);
    expect(h.deps.localStatus).toHaveBeenCalled();
    expect(h.text()).toContain("Source: computed locally as service user svc (server not reachable)");
    expect(h.lines).toContain(describeAuthState("not_verified", "claude", "wrong_user").title);
    expect(code).toBe(0);
  });

  it("--offline never contacts the server; --json is machine-readable", async () => {
    const h = harness(() => ({ status: 200, body: { status: snap() } }));
    await runAuthStatusCommand(["--offline", "--json"], h.deps);
    expect(h.deps.fetchJson).not.toHaveBeenCalled();
    const parsed = JSON.parse(h.text());
    expect(parsed.source).toBe("local");
    expect(parsed.providers.claude.reason).toBe("wrong_user");
  });
});

describe("doctor", () => {
  it("S2-AC5: clean report → 'no problems found' per provider and exit 0", async () => {
    const h = harness((path) => (path === "/api/llm-auth/doctor/recheck" ? { status: 200, body: { report: emptyReport() } } : "down"));
    expect(await runDoctorCommand([], h.deps)).toBe(0);
    expect(h.lines).toContain("  ✓ Claude: no problems found");
    expect(h.lines).toContain("  ✓ Codex: no problems found");
    expect(h.text()).toContain("required: 2.1.280 or newer");
    expect(h.text()).toContain("required: unknown");
  });

  it("findings → exit 1, with both binaries, catalog text and full paths expanded from the REST places", async () => {
    const report = emptyReport();
    const bin = (relPath: string, homeUser: string, place: "service_home" | "root_home", version: string) => ({
      location: { place: "system" as const, homeUser: null, relPath: "/usr/bin/claude", owner: "root", mode: 0o777 },
      target: { place, homeUser, relPath, owner: homeUser, mode: 0o755 },
      version: { known: true as const, value: version },
      versionSource: "path" as const,
    });
    report.providers.claude.findings.push({
      kind: "binary_divergence",
      provider: "claude",
      launched: bin(".local/share/claude/versions/2.1.120", "root", "root_home", "2.1.120"),
      reference: bin(".local/share/claude/versions/2.1.283", "svc", "service_home", "2.1.283"),
    });
    report.providers.codex.findings.push({
      kind: "credential_copy",
      provider: "codex",
      copy: { place: "root_home", homeUser: "root", relPath: ".codex/auth.json", owner: "root", mode: 0o600 },
    });
    const h = harness(() => ({ status: 200, body: { report } }));
    expect(await runDoctorCommand([], h.deps)).toBe(1);
    const text = h.text();
    expect(text).toContain(`✗ ${describeDoctorFinding("binary_divergence", "claude").title}`);
    expect(text).toContain("Sessions launch: /usr/bin/claude → /root/.local/share/claude/versions/2.1.120 (version 2.1.120, owner root)");
    expect(text).toContain("Service user's install: /usr/bin/claude → /home/svc/.local/share/claude/versions/2.1.283 (version 2.1.283");
    expect(text).toContain("Copy: /root/.codex/auth.json (owner root, mode 0600, root's home)");
    expect(text).toContain(formatAction(describeDoctorFinding("binary_divergence", "claude").action));
  });

  it("only unchecked items → exit 2, worded 'not checked' (never 'no problems')", async () => {
    const report = emptyReport();
    report.providers.claude.unchecked.push({
      provider: "claude",
      check: "credential_copies",
      reason: "permission_denied",
      place: { place: "other_user_home", homeUser: "ghost", relPath: ".claude" },
    });
    const h = harness(() => "down");
    h.deps.localDoctor = vi.fn(async () => report);
    expect(await runDoctorCommand([], h.deps)).toBe(2);
    expect(h.text()).toContain(`? ${describeDoctorUnchecked("credential_copies", "permission_denied", "claude").title}: ~ghost/.claude`);
    expect(h.text()).not.toContain("Claude: no problems found");
    expect(h.text()).toContain("Source: computed locally as service user svc (server not reachable)");
  });
});

describe("older server", () => {
  it("a server without the routes (404) falls back to the local core and says why", async () => {
    const h = harness(() => ({ status: 404, body: null }));
    await runDoctorCommand([], h.deps);
    expect(h.deps.localDoctor).toHaveBeenCalled();
    expect(h.text()).toContain("(running server does not support this yet)");
  });
});

describe("helpers", () => {
  it("fullPath prefers absPath, expands homeUser, keeps system paths", () => {
    const homeOf = (u: string) => (u === "svc" ? "/home/svc" : null);
    expect(fullPath({ place: "service_home", homeUser: "svc", relPath: ".codex/auth.json", absPath: "/x/y" }, homeOf)).toBe("/x/y");
    expect(fullPath({ place: "service_home", homeUser: "svc", relPath: ".codex/auth.json" }, homeOf)).toBe("/home/svc/.codex/auth.json");
    expect(fullPath({ place: "system", homeUser: null, relPath: "/usr/bin/codex" }, homeOf)).toBe("/usr/bin/codex");
    // A REST-redacted place renders as a tail, never as a guessed absolute path.
    expect(fullPath({ place: "system", homeUser: null, relPath: "codex", redacted: true }, homeOf)).toBe("…/codex");
  });

  it("cliPort reads --port, then COMPANION_PORT, else 3456", () => {
    expect(cliPort(["--port", "4000"])).toBe(4000);
    expect(cliPort(["--port", "nope"])).toBe(3456);
  });
});
