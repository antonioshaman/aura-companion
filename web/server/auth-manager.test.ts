import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

// Use a temp directory so tests don't touch the real ~/.companion/auth.json
const TEST_DIR = join(tmpdir(), `companion-auth-test-${Date.now()}`);
const TEST_AUTH_FILE = join(TEST_DIR, "auth.json");

// Monkey-patch the module's file path before importing
// We test the exported functions indirectly via env var and file manipulation
describe("auth-manager", () => {
  let authManager: typeof import("./auth-manager.js");

  beforeEach(async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    // Clear env var
    delete process.env.COMPANION_AUTH_TOKEN;
    // Re-import with fresh module state
    authManager = await import("./auth-manager.js");
    authManager._resetForTest();
  });

  afterEach(() => {
    delete process.env.COMPANION_AUTH_TOKEN;
    try {
      rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {
      // cleanup best-effort
    }
  });

  it("generates a 64-character hex token", () => {
    // getToken should return a valid hex string
    const token = authManager.getToken();
    expect(token).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns the same token on repeated calls", () => {
    // Token should be cached after first generation
    const first = authManager.getToken();
    const second = authManager.getToken();
    expect(first).toBe(second);
  });

  it("uses COMPANION_AUTH_TOKEN env var when set", () => {
    // Env var should override any persisted or generated token
    process.env.COMPANION_AUTH_TOKEN = "my-custom-token-123";
    authManager._resetForTest();
    expect(authManager.getToken()).toBe("my-custom-token-123");
  });

  it("verifyToken returns true for correct token", () => {
    const token = authManager.getToken();
    expect(authManager.verifyToken(token)).toBe(true);
  });

  it("verifyToken returns false for incorrect token", () => {
    authManager.getToken(); // ensure token is generated
    expect(authManager.verifyToken("wrong-token")).toBe(false);
  });

  it("verifyToken returns false for null/undefined", () => {
    authManager.getToken();
    expect(authManager.verifyToken(null)).toBe(false);
    expect(authManager.verifyToken(undefined)).toBe(false);
    expect(authManager.verifyToken("")).toBe(false);
  });

  it("verifyToken works with env var token", () => {
    process.env.COMPANION_AUTH_TOKEN = "env-token-abc";
    authManager._resetForTest();
    expect(authManager.verifyToken("env-token-abc")).toBe(true);
    expect(authManager.verifyToken("wrong")).toBe(false);
  });

  // SEC-S6: the startup banner used to print the raw token, which then lived
  // in journald / CI logs. describeTokenSource() is the log-safe replacement:
  // it names where the token comes from and must never contain the token.
  it("describeTokenSource names the env var, never the env token value", () => {
    process.env.COMPANION_AUTH_TOKEN = "env-secret-token-xyz";
    authManager._resetForTest();
    const desc = authManager.describeTokenSource();
    expect(desc).toBe("COMPANION_AUTH_TOKEN env var");
    expect(desc).not.toContain("env-secret-token-xyz");
  });

  it("describeTokenSource returns the auth.json path, never the file token", () => {
    // Without the env var the token is persisted in ~/.companion/auth.json;
    // the description is that path, and the 64-hex token is not in it.
    const token = authManager.getToken();
    const desc = authManager.describeTokenSource();
    expect(desc).toMatch(/[\\/]\.companion[\\/]auth\.json$/);
    expect(desc).not.toContain(token);
  });

  it("describeTokenSource treats a whitespace-only env var as unset (same rule as getToken)", () => {
    process.env.COMPANION_AUTH_TOKEN = "   ";
    expect(authManager.describeTokenSource()).toMatch(/auth\.json$/);
  });

  it("server startup banner logs the token source, not the token (source canary)", () => {
    // index.ts runs Bun.serve at import time, so it is checked at source level:
    // no console.* line may interpolate getToken()/authToken, and the banner
    // must go through describeTokenSource().
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "index.ts"), "utf8");
    const logLines = src.split("\n").filter((l) => /console\.(log|info|warn|error)\(/.test(l));
    for (const line of logLines) {
      expect(line).not.toMatch(/getToken\(\)|\bauthToken\b/);
    }
    expect(src).toMatch(/console\.log\(`\s*Auth token: \$\{describeTokenSource\(\)\}`\)/);
  });

  it("getLanAddress returns a string", () => {
    // Should return either an IP address or "localhost"
    const addr = authManager.getLanAddress();
    expect(typeof addr).toBe("string");
    expect(addr.length).toBeGreaterThan(0);
  });

  // SEC-S1: the localhost bypass must not trust a local reverse proxy that
  // relays remote clients from 127.0.0.1 (Tailscale Funnel exploit path).
  describe("isDirectLocalRequest", () => {
    it("accepts every loopback form with no proxy headers", () => {
      for (const addr of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
        expect(authManager.isDirectLocalRequest(addr, new Headers())).toBe(true);
      }
    });

    it("rejects non-loopback and missing addresses", () => {
      expect(authManager.isDirectLocalRequest("192.168.1.5", new Headers())).toBe(false);
      expect(authManager.isDirectLocalRequest("", new Headers())).toBe(false);
      expect(authManager.isDirectLocalRequest(undefined, new Headers())).toBe(false);
    });

    it("rejects loopback carrying any forwarding header (case-insensitive)", () => {
      for (const h of ["X-Forwarded-For", "Forwarded", "X-Real-IP", "x-forwarded-for"]) {
        expect(authManager.isDirectLocalRequest("127.0.0.1", new Headers({ [h]: "203.0.113.7" }))).toBe(false);
      }
    });

    it("rejects loopback carrying any Tailscale-* header", () => {
      for (const h of ["Tailscale-User-Login", "Tailscale-User-Name", "Tailscale-Funnel-Request"]) {
        expect(authManager.isDirectLocalRequest("::1", new Headers({ [h]: "?1" }))).toBe(false);
      }
    });
  });
});
