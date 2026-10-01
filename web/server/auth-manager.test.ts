import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
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
