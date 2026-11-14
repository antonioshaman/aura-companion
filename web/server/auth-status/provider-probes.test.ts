import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeOAuthLocation, CodexAuthLocation, CredentialFileMeta } from "./credential-locator.js";
import type { BoundedProbeResult, ProbeOptions } from "./probe-runner.js";
import {
  EXPIRY_MARGIN_MS,
  PROVEN_STATUS_PROBE_VERSIONS,
  STATUS_PROBE_ARGV,
  _resetRotationGuardForTests,
  parseClaudeAuthStatus,
  parseCliVersion,
  parseCodexLoginStatus,
  probeClaudeAuth,
  probeCodexAuth,
  type ProviderProbeDeps,
} from "./provider-probes.js";

// Provider probes decide what the status surfaces will claim. Under test:
//  - S1-AC1 working with all fields; S1-AC2 rejected → invalid;
//    S1-AC3 network → no_network (never invalid);
//  - S1-AC4 fail-closed: constant argv only, no model call (the only network
//    call is the token-free usage request), unparsable → not_verified,
//    unproven CLI version or locally expired token → status command NOT spawned;
//  - rotation guard 3: a credential-file change during the probe trips the
//    guard for the rest of the process;
//  - Codex parity for every case that applies to Codex.
// Everything here is a fake: no real CLI, no network, no real credentials.

const NOW = 1_800_000_000_000;
const FRESH = NOW + 60 * 60 * 1000;
const SYNTH_TOKEN = "synthetic-access-token-not-real";

const meta = (over: Partial<CredentialFileMeta> = {}): CredentialFileMeta => ({
  path: "/home/svc/.x/creds.json", uid: 1001, gid: 1001, mode: 0o600, size: 100, mtimeMs: 1, dev: 1, ino: 1, ...over,
});

const claudeLoc = (over: Partial<ClaudeOAuthLocation> = {}): ClaudeOAuthLocation => ({
  meta: meta(), expiresAt: FRESH, refreshTokenExpiresAt: null, hasRefreshToken: true, subscriptionType: "pro", ...over,
});

const codexLoc = (over: Partial<CodexAuthLocation> = {}): CodexAuthLocation => ({
  meta: meta(), authMode: "chatgpt", lastRefreshAt: null, accessTokenExpiresAt: FRESH,
  email: "codex@example.invalid", planType: "plus", credentialFingerprint: "fp-primary", ...over,
});

const exited = (stdout: string, exitCode = 0, stderr = ""): BoundedProbeResult => ({
  kind: "exited", exitCode, stdout, stderr, truncated: false,
});

const CLAUDE_JSON = JSON.stringify({
  loggedIn: true, authMethod: "claude.ai", email: "owner@example.invalid", orgId: "org", subscriptionType: "max",
  configDirectory: "/home/svc/.claude",
});

function makeDeps(over: Partial<ProviderProbeDeps> = {}) {
  const runProbe = vi.fn(async (_path: string, args: readonly string[], _opts?: ProbeOptions): Promise<BoundedProbeResult> => {
    if (args[0] === "--version") return exited("2.1.283 (Claude Code)");
    return exited(CLAUDE_JSON);
  });
  const requestClaudeUsage = vi.fn(async () => ({ kind: "ok" as const, body: {} }));
  const deps: ProviderProbeDeps = {
    env: { HOME: "/home/svc", PATH: "/usr/bin" },
    settings: { claudeCodeOAuthToken: "", anthropicApiKey: "", openaiApiKey: "" },
    now: () => NOW,
    resolveBinary: (name) => `/usr/bin/${name}`,
    runProbe,
    locateClaude: () => claudeLoc(),
    locateCodex: () => codexLoc(),
    readClaudeSecret: () => ({ accessToken: SYNTH_TOKEN, expiresAt: FRESH }),
    requestClaudeUsage,
    statMeta: () => meta(),
    ...over,
  };
  return { deps, runProbe: (over.runProbe as typeof runProbe | undefined) ?? runProbe, requestClaudeUsage };
}

const statusCalls = (runProbe: ReturnType<typeof vi.fn>) =>
  runProbe.mock.calls.filter((c) => (c[1] as readonly string[])[0] !== "--version");

beforeEach(() => _resetRotationGuardForTests());

describe("proven version table", () => {
  it("lists exactly the versions proven by the isolated-HOME experiment", () => {
    // Changing this table requires re-running the synthetic-credential proof
    // (see the evidence table in provider-probes.ts).
    expect(PROVEN_STATUS_PROBE_VERSIONS).toEqual({ claude: ["2.1.283"], codex: ["0.162.1"] });
    expect(STATUS_PROBE_ARGV).toEqual({ claude: ["auth", "status"], codex: ["login", "status"] });
  });
});

describe("parsers", () => {
  it("parseCliVersion takes the first semver", () => {
    expect(parseCliVersion("2.1.283 (Claude Code)")).toBe("2.1.283");
    expect(parseCliVersion("codex-cli 0.162.1")).toBe("0.162.1");
    expect(parseCliVersion("garbage")).toBeNull();
  });

  it("parseClaudeAuthStatus keeps only allowlisted fields", () => {
    const parsed = parseClaudeAuthStatus(CLAUDE_JSON);
    expect(parsed).toEqual({ loggedIn: true, authMethod: "claude.ai", email: "owner@example.invalid", subscriptionType: "max" });
    expect(parseClaudeAuthStatus("not json")).toBeNull();
    expect(parseClaudeAuthStatus(JSON.stringify({ loggedIn: "yes" }))).toBeNull();
    expect(parseClaudeAuthStatus("[]")).toBeNull();
  });

  it("parseCodexLoginStatus recognises only known lines", () => {
    expect(parseCodexLoginStatus("WARNING: x\nLogged in using ChatGPT")).toBe("chatgpt");
    expect(parseCodexLoginStatus("Logged in using an API key - sk-***")).toBe("api_key");
    expect(parseCodexLoginStatus("Not logged in")).toBe("not_logged_in");
    expect(parseCodexLoginStatus("Signed in somehow")).toBeNull();
  });
});

describe("probeClaudeAuth", () => {
  it("S1-AC1: working with account, plan, method, expiry, check time and CLI identity", async () => {
    const { deps, runProbe, requestClaudeUsage } = makeDeps();
    const s = await probeClaudeAuth(deps);
    expect(s).toMatchObject({
      provider: "claude", state: "working", reason: null, verifiedBy: "provider",
      account: { known: true, value: "owner@example.invalid" },
      plan: { known: true, value: "max" },
      method: { known: true, value: "subscription" },
      tokenExpiresAt: { known: true, value: FRESH },
      lastSuccessAt: NOW, checkedAt: NOW,
      cli: { path: { known: true, value: "/usr/bin/claude" }, version: { known: true, value: "2.1.283" } },
    });
    // S1-AC4: constant argv, the env passed explicitly, one token-free request.
    expect(runProbe.mock.calls.map((c) => c[1])).toEqual([["--version"], ["auth", "status"]]);
    expect(runProbe.mock.calls[1][2]).toEqual({ env: deps.env });
    expect(requestClaudeUsage).toHaveBeenCalledTimes(1);
    // Leak canary: the token never appears in the status payload.
    expect(JSON.stringify(s)).not.toContain(SYNTH_TOKEN);
  });

  it("S1-AC2: provider rejects the token → invalid", async () => {
    const { deps } = makeDeps({ requestClaudeUsage: async () => ({ kind: "rejected", status: 401 }) });
    expect((await probeClaudeAuth(deps)).state).toBe("invalid");
  });

  it("S1-AC3: network failure → no_network, not invalid", async () => {
    const { deps } = makeDeps({ requestClaudeUsage: async () => ({ kind: "network", error: new Error("ECONNRESET") }) });
    const s = await probeClaudeAuth(deps);
    expect(s.state).toBe("no_network");
    expect(s.lastSuccessAt).toBeNull();
  });

  it("S1-AC4: unproven CLI version → not_verified, status command never spawned, no provider call", async () => {
    const runProbe = vi.fn(async (): Promise<BoundedProbeResult> => exited("2.1.999 (Claude Code)"));
    const { deps, requestClaudeUsage } = makeDeps({ runProbe });
    const s = await probeClaudeAuth(deps);
    expect(s).toMatchObject({ state: "not_verified", reason: "cli_version_unproven", cli: { version: { known: true, value: "2.1.999" } } });
    expect(statusCalls(runProbe)).toHaveLength(0);
    expect(requestClaudeUsage).not.toHaveBeenCalled();
  });

  it.each([
    ["expired", NOW - 1],
    ["inside the margin", NOW + EXPIRY_MARGIN_MS - 1],
    ["unknown (fail-closed)", null],
  ])("S1-AC4: locally %s token → nothing spawned, nothing requested", async (_label, expiresAt) => {
    const { deps, runProbe, requestClaudeUsage } = makeDeps({ locateClaude: () => claudeLoc({ expiresAt }) });
    const s = await probeClaudeAuth(deps);
    expect(s).toMatchObject({ state: "not_verified", reason: "token_expired_locally", verifiedBy: "local" });
    expect(runProbe).not.toHaveBeenCalled();
    expect(requestClaudeUsage).not.toHaveBeenCalled();
  });

  it("S1-AC4: unparsable or non-zero status output → not_verified", async () => {
    for (const out of [exited("Some new human format"), exited(CLAUDE_JSON, 1)]) {
      const runProbe = vi.fn(async (_p: string, args: readonly string[]) => (args[0] === "--version" ? exited("2.1.283") : out));
      const { deps, requestClaudeUsage } = makeDeps({ runProbe });
      expect(await probeClaudeAuth(deps)).toMatchObject({ state: "not_verified", reason: "probe_inconclusive" });
      expect(requestClaudeUsage).not.toHaveBeenCalled();
    }
  });

  it("a probe timeout is not_verified, never invalid", async () => {
    const runProbe = vi.fn(async (_p: string, args: readonly string[]): Promise<BoundedProbeResult> =>
      args[0] === "--version" ? exited("2.1.283") : { kind: "timeout", killedWith: "SIGTERM" });
    const { deps } = makeDeps({ runProbe });
    expect((await probeClaudeAuth(deps)).state).toBe("not_verified");
  });

  it("rotation guard 3: a credential-file change during the probe trips the guard until restart", async () => {
    let calls = 0;
    const onEvent = vi.fn();
    const { deps, runProbe } = makeDeps({ statMeta: () => meta({ mtimeMs: ++calls }), onEvent });
    expect(await probeClaudeAuth(deps)).toMatchObject({ state: "not_verified", reason: "rotation_detected" });
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "auth_probe.rotation_detected", provider: "claude" }));
    runProbe.mockClear();
    expect(await probeClaudeAuth({ ...deps, statMeta: () => meta() })).toMatchObject({ reason: "rotation_detected" });
    expect(runProbe).not.toHaveBeenCalled();
    // Structured events carry no path bytes (EC-23).
    expect(JSON.stringify(onEvent.mock.calls)).not.toContain("/home/");
  });

  it("missing CLI → not_verified cli_missing", async () => {
    const { deps } = makeDeps({ resolveBinary: () => null });
    expect(await probeClaudeAuth(deps)).toMatchObject({ state: "not_verified", reason: "cli_missing" });
  });

  it("no credential source → not_signed_in", async () => {
    const { deps, runProbe } = makeDeps({ locateClaude: () => null });
    expect((await probeClaudeAuth(deps)).state).toBe("not_signed_in");
    expect(runProbe).not.toHaveBeenCalled();
  });

  it("env / API-key logins have no token-free provider check", async () => {
    const env = makeDeps({ env: { ANTHROPIC_API_KEY: "sk-synthetic" } });
    expect(await probeClaudeAuth(env.deps)).toMatchObject({ state: "not_verified", reason: "no_provider_check", method: { known: true, value: "env_token" } });
    const key = makeDeps({ settings: { claudeCodeOAuthToken: "", anthropicApiKey: "sk-synthetic", openaiApiKey: "" } });
    expect(await probeClaudeAuth(key.deps)).toMatchObject({ method: { known: true, value: "api_key" } });
    expect(env.runProbe).not.toHaveBeenCalled();
  });
});

describe("probeCodexAuth", () => {
  const codexRun = (status: BoundedProbeResult) =>
    vi.fn(async (_p: string, args: readonly string[]): Promise<BoundedProbeResult> =>
      args[0] === "--version" ? exited("codex-cli 0.162.1") : status);

  it("S1-AC1 (parity): working when a recent rate-limits read used the primary credentials", async () => {
    const runProbe = codexRun(exited("", 0, "Logged in using ChatGPT"));
    const { deps } = makeDeps({ runProbe, codexProviderEvidence: () => ({ checkedAt: NOW - 60_000, credentialFingerprint: "fp-primary" }) });
    const s = await probeCodexAuth(deps);
    expect(s).toMatchObject({
      provider: "codex", state: "working", verifiedBy: "provider",
      // lastSuccessAt is when the provider answered, not when we looked (observer STOP, checkpoint 197).
      lastSuccessAt: NOW - 60_000, checkedAt: NOW,
      account: { known: true, value: "codex@example.invalid" },
      plan: { known: true, value: "plus" },
      method: { known: true, value: "subscription" },
      cli: { version: { known: true, value: "0.162.1" } },
    });
    expect(runProbe.mock.calls.map((c) => c[1])).toEqual([["--version"], ["login", "status"]]);
  });

  it("S1-AC4 (parity): without provider evidence Codex is honestly not_verified", async () => {
    const { deps } = makeDeps({ runProbe: codexRun(exited("", 0, "Logged in using ChatGPT")) });
    expect(await probeCodexAuth(deps)).toMatchObject({ state: "not_verified", reason: "no_provider_check", method: { known: true, value: "subscription" } });
  });

  it("a session on another credential generation does not vouch for the primary sign-in (observer STOP, checkpoint 197)", async () => {
    // Incident: each Codex session keeps its own copy; a live session on an
    // old-but-working copy must not mark a revoked/renewed primary as working.
    const run = () => codexRun(exited("", 0, "Logged in using ChatGPT"));
    const other = makeDeps({ runProbe: run(), codexProviderEvidence: () => ({ checkedAt: NOW - 1000, credentialFingerprint: "fp-session-copy" }) });
    expect(await probeCodexAuth(other.deps)).toMatchObject({ state: "not_verified", reason: "no_provider_check", lastSuccessAt: null });
    const noPrimaryFp = makeDeps({
      runProbe: run(),
      locateCodex: () => codexLoc({ credentialFingerprint: null }),
      codexProviderEvidence: () => ({ checkedAt: NOW - 1000, credentialFingerprint: "fp-primary" }),
    });
    expect((await probeCodexAuth(noPrimaryFp.deps)).state).toBe("not_verified");
  });

  it("EC-38: stale or future-dated evidence is not evidence", async () => {
    for (const checkedAt of [NOW + 60_000, NOW - 6 * 60_000]) {
      const { deps } = makeDeps({
        runProbe: codexRun(exited("", 0, "Logged in using ChatGPT")),
        codexProviderEvidence: () => ({ checkedAt, credentialFingerprint: "fp-primary" }),
      });
      expect((await probeCodexAuth(deps)).state).toBe("not_verified");
    }
  });

  it("S1-AC4 (parity): unproven codex version → login status never spawned", async () => {
    const runProbe = vi.fn(async (): Promise<BoundedProbeResult> => exited("codex-cli 0.200.0"));
    const { deps } = makeDeps({ runProbe });
    expect(await probeCodexAuth(deps)).toMatchObject({ reason: "cli_version_unproven" });
    expect(statusCalls(runProbe)).toHaveLength(0);
  });

  it("S1-AC4 (parity): locally expired ChatGPT token → nothing spawned", async () => {
    const { deps, runProbe } = makeDeps({ locateCodex: () => codexLoc({ accessTokenExpiresAt: NOW - 1 }) });
    expect(await probeCodexAuth(deps)).toMatchObject({ reason: "token_expired_locally" });
    expect(runProbe).not.toHaveBeenCalled();
  });

  it("an API-key auth.json has no expiring token and is not blocked by the expiry guard", async () => {
    const { deps } = makeDeps({
      runProbe: codexRun(exited("", 0, "Logged in using an API key - sk-***")),
      locateCodex: () => codexLoc({ authMode: "api_key", accessTokenExpiresAt: null, email: null, planType: null, credentialFingerprint: null }),
    });
    expect(await probeCodexAuth(deps)).toMatchObject({
      reason: "no_provider_check", method: { known: true, value: "api_key" }, plan: { known: false },
    });
  });

  it("unrecognised login output → not_verified", async () => {
    const { deps } = makeDeps({ runProbe: codexRun(exited("", 0, "Bienvenue")) });
    expect(await probeCodexAuth(deps)).toMatchObject({ reason: "probe_inconclusive" });
  });

  it("rotation guard 3 (parity)", async () => {
    let calls = 0;
    const { deps } = makeDeps({ runProbe: codexRun(exited("", 0, "Logged in using ChatGPT")), statMeta: () => meta({ ino: ++calls }) });
    expect(await probeCodexAuth(deps)).toMatchObject({ reason: "rotation_detected" });
    expect(await probeCodexAuth({ ...deps, statMeta: () => meta() })).toMatchObject({ reason: "rotation_detected" });
  });

  it("no auth.json → not_signed_in; env key without auth.json → no_provider_check", async () => {
    expect((await probeCodexAuth(makeDeps({ locateCodex: () => null }).deps)).state).toBe("not_signed_in");
    // 1c: the env key only counts when there is no stored sign-in (see the next test).
    expect(await probeCodexAuth(makeDeps({ locateCodex: () => null, env: { OPENAI_API_KEY: "sk-synthetic" } }).deps))
      .toMatchObject({ reason: "no_provider_check", method: { known: true, value: "env_token" } });
    expect(await probeCodexAuth(makeDeps({ locateCodex: () => null, settings: { claudeCodeOAuthToken: "", anthropicApiKey: "", openaiApiKey: "sk-synthetic" } }).deps))
      .toMatchObject({ reason: "no_provider_check", method: { known: true, value: "api_key" } });
  });

  it("stored ChatGPT auth.json wins over an env / settings API key (codex 0.162.1, proven 2026-11-14)", async () => {
    // Synthetic CODEX_HOME with a chatgpt auth.json + OPENAI_API_KEY in env,
    // offline: `codex doctor` reported "auth mode chatgpt" and
    // `codex login status` "Logged in using ChatGPT". Aura's settings key is
    // injected as that same env var, so it does not change what the session uses.
    const { deps } = makeDeps({
      env: { OPENAI_API_KEY: "sk-synthetic" },
      settings: { claudeCodeOAuthToken: "", anthropicApiKey: "", openaiApiKey: "sk-synthetic" },
      runProbe: codexRun(exited("", 0, "Logged in using ChatGPT")),
    });
    expect(await probeCodexAuth(deps)).toMatchObject({ method: { known: true, value: "subscription" } });
  });
});
