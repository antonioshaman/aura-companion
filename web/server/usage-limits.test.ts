import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockExecSync = vi.hoisted(() => vi.fn());
const mockExecFileSync = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execSync: mockExecSync,
  execFileSync: mockExecFileSync,
}));

// Settings are mocked so the API-key branch never depends on the real ~/.companion.
const mockSettings = vi.hoisted(() => ({ anthropicApiKey: "", claudeCodeOAuthToken: "" }));
vi.mock("./settings-manager.js", () => ({ getSettings: () => ({ ...mockSettings }) }));

// Mock global fetch at the module level (persists across tests)
const mockFetch = vi.fn();
globalThis.fetch = mockFetch as unknown as typeof fetch;

// ---------------------------------------------------------------------------
// Module under test - re-imported each time to reset module-level cache
// ---------------------------------------------------------------------------
let mod: typeof import("./usage-limits.js");
const originalPlatform = process.platform;

beforeEach(async () => {
  vi.resetModules();
  mockExecSync.mockReset();
  mockExecFileSync.mockReset();
  mockFetch.mockReset();
  mod = await import("./usage-limits.js");
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SAMPLE_TOKEN = "sk-ant-fake-token-123";

function makeCredentialsJson(token: string, opts?: { expired?: boolean }): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: token,
      refreshToken: "sk-ant-ort01-fake-refresh-token",
      expiresAt: opts?.expired ? Date.now() - 1000 : Date.now() + 3_600_000,
    },
  });
}

function makeCredentialsHex(token: string): string {
  return Buffer.from(makeCredentialsJson(token), "utf-8").toString("hex");
}

function makeFetchResponse(body: object, ok = true) {
  return Promise.resolve({
    ok,
    json: () => Promise.resolve(body),
  });
}

const SAMPLE_LIMITS = {
  five_hour: { utilization: 42, resets_at: "2025-01-01T12:00:00Z" },
  seven_day: { utilization: 15, resets_at: null },
  extra_usage: null,
};

// ===========================================================================
// getCredentials (macOS - Keychain)
// ===========================================================================
describe("getCredentials (macOS)", () => {
  beforeEach(() => {
    // Force macOS platform so the Keychain (execSync) path is used
    Object.defineProperty(process, "platform", { value: "darwin" });
  });

  it("extracts token from plain JSON output", async () => {
    vi.resetModules();
    mockFetch.mockReset();
    const darwinMod = await import("./usage-limits.js");
    mockExecSync.mockReturnValue(makeCredentialsJson(SAMPLE_TOKEN));
    expect(darwinMod.getCredentials()).toBe(SAMPLE_TOKEN);
  });

  it("extracts token from hex-encoded output", async () => {
    vi.resetModules();
    mockFetch.mockReset();
    const darwinMod = await import("./usage-limits.js");
    mockExecSync.mockReturnValue(makeCredentialsHex(SAMPLE_TOKEN));
    expect(darwinMod.getCredentials()).toBe(SAMPLE_TOKEN);
  });

  it("returns null when execSync throws (e.g. no keychain entry)", async () => {
    vi.resetModules();
    mockFetch.mockReset();
    const darwinMod = await import("./usage-limits.js");
    mockExecSync.mockImplementation(() => {
      throw new Error("security: command not found");
    });
    expect(darwinMod.getCredentials()).toBeNull();
  });

  it("returns null when JSON has no claudeAiOauth field", async () => {
    vi.resetModules();
    mockFetch.mockReset();
    const darwinMod = await import("./usage-limits.js");
    mockExecSync.mockReturnValue(JSON.stringify({ other: "data" }));
    expect(darwinMod.getCredentials()).toBeNull();
  });

  it("returns token even when format does not match sk-ant-*", async () => {
    vi.resetModules();
    mockFetch.mockReset();
    const darwinMod = await import("./usage-limits.js");
    mockExecSync.mockReturnValue(
      JSON.stringify({ claudeAiOauth: { accessToken: "not-a-valid-token" } }),
    );
    expect(darwinMod.getCredentials()).toBe("not-a-valid-token");
  });
});

// ===========================================================================
// getCredentials - Windows path
// ===========================================================================
describe("getCredentials (Windows)", () => {
  let tempDir: string;

  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "win32" });
    tempDir = mkdtempSync(join(tmpdir(), "usage-limits-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("reads token from credentials file on Windows", async () => {
    const claudeDir = join(tempDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, ".credentials.json"),
      makeCredentialsJson(SAMPLE_TOKEN),
    );
    process.env.USERPROFILE = tempDir;

    // Re-import to pick up the mocked platform
    vi.resetModules();
    mockFetch.mockReset();
    const winMod = await import("./usage-limits.js");
    expect(winMod.getCredentials()).toBe(SAMPLE_TOKEN);

    delete process.env.USERPROFILE;
  });

  it("returns null when credentials file does not exist on Windows", async () => {
    process.env.USERPROFILE = tempDir;

    vi.resetModules();
    const winMod = await import("./usage-limits.js");
    expect(winMod.getCredentials()).toBeNull();

    delete process.env.USERPROFILE;
  });

  it("returns null when credentials file has invalid JSON on Windows", async () => {
    const claudeDir = join(tempDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, ".credentials.json"), "NOT VALID JSON{{{");
    process.env.USERPROFILE = tempDir;

    vi.resetModules();
    const winMod = await import("./usage-limits.js");
    expect(winMod.getCredentials()).toBeNull();

    delete process.env.USERPROFILE;
  });
});

// ===========================================================================
// getCredentials - Linux / Docker path
// ===========================================================================
describe("getCredentials (Linux / Docker)", () => {
  let tempDir: string;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    // Force Linux platform so the file-based credential path is used
    Object.defineProperty(process, "platform", { value: "linux" });
    tempDir = mkdtempSync(join(tmpdir(), "usage-limits-linux-test-"));
  });

  afterEach(() => {
    // Restore original HOME to avoid cross-test environment pollution
    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    } else {
      delete process.env.HOME;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("reads token from .credentials.json on Linux", async () => {
    const claudeDir = join(tempDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, ".credentials.json"),
      makeCredentialsJson(SAMPLE_TOKEN),
    );
    process.env.HOME = tempDir;

    vi.resetModules();
    mockFetch.mockReset();
    const linuxMod = await import("./usage-limits.js");
    expect(linuxMod.getCredentials()).toBe(SAMPLE_TOKEN);
  });

  it("falls back to alternative credential file names", async () => {
    // Only auth.json exists (not .credentials.json)
    const claudeDir = join(tempDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, "auth.json"),
      makeCredentialsJson(SAMPLE_TOKEN),
    );
    process.env.HOME = tempDir;

    vi.resetModules();
    mockFetch.mockReset();
    const linuxMod = await import("./usage-limits.js");
    expect(linuxMod.getCredentials()).toBe(SAMPLE_TOKEN);
  });

  it("returns null when no credential files exist on Linux", async () => {
    process.env.HOME = tempDir;

    vi.resetModules();
    mockFetch.mockReset();
    const linuxMod = await import("./usage-limits.js");
    expect(linuxMod.getCredentials()).toBeNull();
  });

  it("returns null when credentials file has invalid JSON on Linux", async () => {
    const claudeDir = join(tempDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, ".credentials.json"), "NOT VALID JSON{{{");
    process.env.HOME = tempDir;

    vi.resetModules();
    mockFetch.mockReset();
    const linuxMod = await import("./usage-limits.js");
    expect(linuxMod.getCredentials()).toBeNull();
  });

  it("does not call macOS security command on Linux", async () => {
    const claudeDir = join(tempDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, ".credentials.json"),
      makeCredentialsJson(SAMPLE_TOKEN),
    );
    process.env.HOME = tempDir;

    vi.resetModules();
    mockFetch.mockReset();
    const linuxMod = await import("./usage-limits.js");
    linuxMod.getCredentials();
    // security command should never be invoked on Linux
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it("never refreshes or writes back an expired token (owner default (a))", async () => {
    // Before LLM-auth phase 1 task 6 this module refreshed the token itself and
    // wrote it back — racing live CLIs for the single-use refresh token. Now an
    // expired token is a reason, the file is byte-identical and nothing is fetched.
    const claudeDir = join(tempDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    const original = makeCredentialsJson(SAMPLE_TOKEN, { expired: true });
    writeFileSync(join(claudeDir, "auth.json"), original);
    process.env.HOME = tempDir;

    vi.resetModules();
    mockFetch.mockReset();
    const linuxMod = await import("./usage-limits.js");

    const result = await linuxMod.getUsageLimits();
    expect(result).toEqual({ five_hour: null, seven_day: null, extra_usage: null, reason: "auth_invalid" });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockExecFileSync).not.toHaveBeenCalled();
    expect(readFileSync(join(claudeDir, "auth.json"), "utf-8")).toBe(original);
  });
});

// ===========================================================================
// fetchUsageLimits
// ===========================================================================
describe("fetchUsageLimits", () => {
  it("returns parsed limits on success", async () => {
    mockFetch.mockReturnValue(makeFetchResponse(SAMPLE_LIMITS));

    const result = await mod.fetchUsageLimits(SAMPLE_TOKEN);
    expect(result).toEqual(SAMPLE_LIMITS);

    // Verify correct headers
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.anthropic.com/api/oauth/usage",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: `Bearer ${SAMPLE_TOKEN}`,
        }),
      }),
    );
  });

  it("returns null on non-ok response", async () => {
    mockFetch.mockReturnValue(makeFetchResponse({}, false));
    const result = await mod.fetchUsageLimits(SAMPLE_TOKEN);
    expect(result).toBeNull();
  });

  it("returns null on network error", async () => {
    mockFetch.mockRejectedValue(new Error("network error"));
    const result = await mod.fetchUsageLimits(SAMPLE_TOKEN);
    expect(result).toBeNull();
  });

  // Diagnostics AC3 (plan Task 7): failures are recorded for the Usage card
  // (closed kind + status only, never the response body).
  it("records the upstream outcome for Diagnostics: 401 → oauth-expired, then ok", async () => {
    const { usageLimitsUpstream } = await import("./diagnostics/upstream-status.js");
    usageLimitsUpstream.reset();
    mockFetch.mockReturnValue(Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) }));
    await mod.fetchUsageLimits(SAMPLE_TOKEN);
    expect(usageLimitsUpstream.view().failure).toMatchObject({ kind: "oauth-expired", httpStatus: 401 });
    mockFetch.mockReturnValue(makeFetchResponse(SAMPLE_LIMITS));
    await mod.fetchUsageLimits(SAMPLE_TOKEN);
    expect(usageLimitsUpstream.view()).toMatchObject({ ok: true, failure: null });
  });

  it("normalizes missing fields to null", async () => {
    mockFetch.mockReturnValue(
      makeFetchResponse({ five_hour: { utilization: 10, resets_at: null } }),
    );
    const result = await mod.fetchUsageLimits(SAMPLE_TOKEN);
    expect(result).toEqual({
      five_hour: { utilization: 10, resets_at: null },
      seven_day: null,
      extra_usage: null,
    });
  });
});

// ===========================================================================
// getUsageLimits (orchestrator with cache)
// These tests use macOS platform to exercise the execSync/keychain path
// ===========================================================================
describe("getUsageLimits", () => {
  const EMPTY = { five_hour: null, seven_day: null, extra_usage: null };
  const withReason = (reason: string) => ({ ...EMPTY, reason });

  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "darwin" });
  });

  it("returns empty when no credentials are available", async () => {
    vi.resetModules();
    mockFetch.mockReset();
    const darwinMod = await import("./usage-limits.js");
    mockExecSync.mockImplementation(() => {
      throw new Error("no keychain");
    });
    const result = await darwinMod.getUsageLimits();
    // S4: a typed reason instead of a silent all-null panel.
    expect(result).toEqual(withReason("no_credentials"));
  });

  it("S4-AC2: an API-key sign-in without OAuth reports api_key_login", async () => {
    vi.resetModules();
    mockFetch.mockReset();
    const darwinMod = await import("./usage-limits.js");
    mockExecSync.mockImplementation(() => {
      throw new Error("no keychain");
    });
    expect(await darwinMod.getUsageLimits({ env: { ANTHROPIC_API_KEY: "sk-synthetic" } })).toEqual(withReason("api_key_login"));
    expect(await darwinMod.getUsageLimits({ env: {}, settings: { anthropicApiKey: "sk-synthetic", claudeCodeOAuthToken: "" } })).toEqual(withReason("api_key_login"));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("S4-AC2: an active API key wins over a leftover OAuth file (observer STOP, checkpoint 197)", async () => {
    // A stale OAuth file next to an active ANTHROPIC_API_KEY must not be used:
    // neither its (old subscription's) windows nor its expired-token reason.
    vi.resetModules();
    mockFetch.mockReset();
    const darwinMod = await import("./usage-limits.js");
    mockExecSync.mockReturnValue(makeCredentialsJson(SAMPLE_TOKEN));
    expect(await darwinMod.getUsageLimits({ env: { ANTHROPIC_API_KEY: "sk-synthetic" } })).toEqual(withReason("api_key_login"));
    mockExecSync.mockReturnValue(makeCredentialsJson(SAMPLE_TOKEN, { expired: true }));
    expect(await darwinMod.getUsageLimits({ env: { ANTHROPIC_API_KEY: "sk-synthetic" } })).toEqual(withReason("api_key_login"));
    expect(mockFetch).not.toHaveBeenCalled();
    // A companion-managed OAuth token outranks a companion-managed API key (CLI precedence).
    mockExecSync.mockReturnValue(makeCredentialsJson(SAMPLE_TOKEN));
    mockFetch.mockReturnValueOnce(makeFetchResponse(SAMPLE_LIMITS));
    expect(await darwinMod.getUsageLimits({ env: {}, settings: { anthropicApiKey: "sk-synthetic", claudeCodeOAuthToken: "synthetic-oauth" } })).toEqual(SAMPLE_LIMITS);
  });

  it("S4-AC1: a rejected token reports auth_invalid and is not cached", async () => {
    vi.resetModules();
    mockFetch.mockReset();
    const darwinMod = await import("./usage-limits.js");
    mockExecSync.mockReturnValue(makeCredentialsJson(SAMPLE_TOKEN));
    mockFetch.mockReturnValueOnce(Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) }));
    expect(await darwinMod.getUsageLimits()).toEqual(withReason("auth_invalid"));
    mockFetch.mockReturnValueOnce(makeFetchResponse(SAMPLE_LIMITS));
    expect(await darwinMod.getUsageLimits()).toEqual(SAMPLE_LIMITS);
  });

  it("a network failure reports network, not auth_invalid", async () => {
    vi.resetModules();
    mockFetch.mockReset();
    const darwinMod = await import("./usage-limits.js");
    mockExecSync.mockReturnValue(makeCredentialsJson(SAMPLE_TOKEN));
    mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(await darwinMod.getUsageLimits()).toEqual(withReason("network"));
  });

  it("EC-38: a cache stamped in the future (clock went back) is a miss", async () => {
    vi.resetModules();
    mockFetch.mockReset();
    const darwinMod = await import("./usage-limits.js");
    mockExecSync.mockReturnValue(makeCredentialsJson(SAMPLE_TOKEN));
    mockFetch.mockReturnValue(makeFetchResponse(SAMPLE_LIMITS));
    await darwinMod.getUsageLimits();
    await darwinMod.getUsageLimits({ now: Date.now() - 3_600_000 });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("returns limits and caches the result", async () => {
    vi.resetModules();
    mockFetch.mockReset();
    const darwinMod = await import("./usage-limits.js");
    mockExecSync.mockReturnValue(makeCredentialsJson(SAMPLE_TOKEN));
    mockFetch.mockReturnValue(makeFetchResponse(SAMPLE_LIMITS));

    const first = await darwinMod.getUsageLimits();
    expect(first).toEqual(SAMPLE_LIMITS);

    // Second call should use cache - fetch should not be called again
    const second = await darwinMod.getUsageLimits();
    expect(second).toEqual(SAMPLE_LIMITS);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("refreshes cache after TTL expires", async () => {
    vi.resetModules();
    mockFetch.mockReset();
    const darwinMod = await import("./usage-limits.js");
    mockExecSync.mockReturnValue(makeCredentialsJson(SAMPLE_TOKEN));
    mockFetch.mockReturnValue(makeFetchResponse(SAMPLE_LIMITS));

    await darwinMod.getUsageLimits();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Manually expire the cache by advancing Date.now via spy
    const realNow = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(realNow + 61_000);

    const updated = {
      ...SAMPLE_LIMITS,
      five_hour: { utilization: 99, resets_at: null },
    };
    mockFetch.mockReturnValue(makeFetchResponse(updated));

    const result = await darwinMod.getUsageLimits();
    expect(result).toEqual(updated);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    vi.spyOn(Date, "now").mockRestore();
  });

  it("returns empty when fetch fails", async () => {
    vi.resetModules();
    mockFetch.mockReset();
    const darwinMod = await import("./usage-limits.js");
    mockExecSync.mockReturnValue(makeCredentialsJson(SAMPLE_TOKEN));
    mockFetch.mockReturnValue(makeFetchResponse({}, false));

    const result = await darwinMod.getUsageLimits();
    expect(result).toEqual(withReason("unknown"));
  });
});

// ===========================================================================
// Expired tokens (owner default (a), LLM-auth phase 1 task 6): getUsageLimits
// NEVER refreshes — no call to the OAuth token endpoint, no Keychain/file
// writeback. These replace the former "token refresh" tests, whose behaviour
// was removed on purpose. macOS platform exercises the Keychain read path.
// ===========================================================================
describe("expired token (no refresh)", () => {
  const AUTH_INVALID = { five_hour: null, seven_day: null, extra_usage: null, reason: "auth_invalid" };

  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "darwin" });
  });

  it("does not call the token endpoint or write the Keychain for an expired token", async () => {
    vi.resetModules();
    mockFetch.mockReset();
    mockExecSync.mockReset();
    mockExecFileSync.mockReset();
    const darwinMod = await import("./usage-limits.js");
    mockExecSync.mockReturnValue(makeCredentialsJson(SAMPLE_TOKEN, { expired: true }));

    expect(await darwinMod.getUsageLimits()).toEqual(AUTH_INVALID);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it("treats a token inside the 5-minute buffer as expired", async () => {
    vi.resetModules();
    mockFetch.mockReset();
    mockExecSync.mockReset();
    const darwinMod = await import("./usage-limits.js");
    mockExecSync.mockReturnValue(JSON.stringify({
      claudeAiOauth: { accessToken: SAMPLE_TOKEN, refreshToken: "r", expiresAt: Date.now() + 60_000 },
    }));
    expect(await darwinMod.getUsageLimits()).toEqual(AUTH_INVALID);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("treats a token without expiresAt as unusable (fail-closed)", async () => {
    vi.resetModules();
    mockFetch.mockReset();
    mockExecSync.mockReset();
    const darwinMod = await import("./usage-limits.js");
    mockExecSync.mockReturnValue(JSON.stringify({ claudeAiOauth: { accessToken: SAMPLE_TOKEN } }));
    expect(await darwinMod.getUsageLimits()).toEqual(AUTH_INVALID);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("uses valid (non-expired) token without refreshing", async () => {
    vi.resetModules();
    mockFetch.mockReset();
    mockExecSync.mockReset();
    const darwinMod = await import("./usage-limits.js");

    // Token has a future expiry (default in makeCredentialsJson)
    mockExecSync.mockReturnValue(makeCredentialsJson(SAMPLE_TOKEN));
    mockFetch.mockReturnValueOnce(makeFetchResponse(SAMPLE_LIMITS));

    const result = await darwinMod.getUsageLimits();
    expect(result).toEqual(SAMPLE_LIMITS);
    // Only one fetch call (usage API), no refresh call
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("oauth/usage");
  });
});
