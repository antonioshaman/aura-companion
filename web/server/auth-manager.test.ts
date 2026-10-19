import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { chmodSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import type { NetworkInterfaceInfo } from "node:os";

// networkInterfaces is wrapped so the address tests can feed fixed
// interfaces; every other test gets the real implementation.
const osMock = vi.hoisted(() => ({ networkInterfaces: null as null | (() => NodeJS.Dict<NetworkInterfaceInfo[]>) }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, networkInterfaces: () => (osMock.networkInterfaces ?? actual.networkInterfaces)() };
});

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
    // Point the module at the temp auth.json so no test reads (or, since
    // FIX-P7-REVIEW, chmods) the real ~/.companion/auth.json.
    authManager._resetForTest(TEST_AUTH_FILE);
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
    authManager._resetForTest(TEST_AUTH_FILE);
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
    authManager._resetForTest(TEST_AUTH_FILE);
    expect(authManager.verifyToken("env-token-abc")).toBe(true);
    expect(authManager.verifyToken("wrong")).toBe(false);
  });

  // SEC-S6: the startup banner used to print the raw token, which then lived
  // in journald / CI logs. describeTokenSource() is the log-safe replacement:
  // it names where the token comes from and must never contain the token.
  it("describeTokenSource names the env var, never the env token value", () => {
    process.env.COMPANION_AUTH_TOKEN = "env-secret-token-xyz";
    authManager._resetForTest(TEST_AUTH_FILE);
    const desc = authManager.describeTokenSource();
    expect(desc).toBe("COMPANION_AUTH_TOKEN env var");
    expect(desc).not.toContain("env-secret-token-xyz");
  });

  it("describeTokenSource returns the auth.json path, never the file token", () => {
    // Without the env var the token is persisted in ~/.companion/auth.json;
    // the description is that path, and the 64-hex token is not in it.
    const token = authManager.getToken();
    const desc = authManager.describeTokenSource();
    expect(desc).toBe(TEST_AUTH_FILE);
    expect(desc).not.toContain(token);
    // Default location, checked without reading the real file.
    authManager._resetForTest();
    expect(authManager.describeTokenSource()).toMatch(/[\\/]\.companion[\\/]auth\.json$/);
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

  // FIX-P7-REVIEW (3): auth.json holds the login token. writeFileSync's
  // `mode` only applied on create, so a file born 0o644 stayed readable by
  // other UIDs even after regenerateToken() rewrote it.
  describe("auth.json file mode", () => {
    const LEGACY_TOKEN = "b".repeat(64);

    it("re-tightens an existing 0o644 auth.json when the token is read", () => {
      writeFileSync(TEST_AUTH_FILE, JSON.stringify({ token: LEGACY_TOKEN, createdAt: 1 }));
      chmodSync(TEST_AUTH_FILE, 0o644);
      authManager._resetForTest(TEST_AUTH_FILE);
      expect(authManager.getToken()).toBe(LEGACY_TOKEN);
      expect(statSync(TEST_AUTH_FILE).mode & 0o777).toBe(0o600);
    });

    it("regenerateToken leaves auth.json at 0o600 even if it was 0o644", () => {
      writeFileSync(TEST_AUTH_FILE, JSON.stringify({ token: LEGACY_TOKEN, createdAt: 1 }));
      chmodSync(TEST_AUTH_FILE, 0o644);
      authManager._resetForTest(TEST_AUTH_FILE);
      const fresh = authManager.regenerateToken();
      expect(fresh).not.toBe(LEGACY_TOKEN);
      expect(JSON.parse(readFileSync(TEST_AUTH_FILE, "utf-8")).token).toBe(fresh);
      expect(statSync(TEST_AUTH_FILE).mode & 0o777).toBe(0o600);
    });

    it("a freshly generated auth.json is 0o600", () => {
      rmSync(TEST_AUTH_FILE, { force: true });
      authManager._resetForTest(TEST_AUTH_FILE);
      authManager.getToken();
      expect(statSync(TEST_AUTH_FILE).mode & 0o777).toBe(0o600);
    });
  });

  // Token persistence must not take the server down: a failed write is
  // logged and the in-memory token is still served for this process.
  describe("persist failure", () => {
    it("getToken and regenerateToken still return a token when auth.json cannot be written", () => {
      // A regular file where the parent directory should be → mkdir fails.
      const blocker = join(TEST_DIR, "not-a-dir");
      writeFileSync(blocker, "x");
      authManager._resetForTest(join(blocker, "auth.json"));
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        expect(authManager.getToken()).toMatch(/^[a-f0-9]{64}$/);
        expect(authManager.regenerateToken()).toMatch(/^[a-f0-9]{64}$/);
        expect(err).toHaveBeenCalledTimes(2);
      } finally {
        err.mockRestore();
      }
    });
  });

  // QR/login addresses: LAN = first external IPv4, Tailscale = 100.64.0.0/10.
  describe("getAllAddresses / getLanAddress", () => {
    const v4 = (address: string, internal = false) =>
      ({ address, family: "IPv4", internal, netmask: "255.255.255.0", mac: "00:00:00:00:00:00", cidr: null }) as NetworkInterfaceInfo;

    afterEach(() => {
      osMock.networkInterfaces = null;
    });

    it("lists localhost, the first LAN IPv4 and the Tailscale CGNAT IPv4", () => {
      osMock.networkInterfaces = () => ({
        lo: [v4("127.0.0.1", true)],
        eth0: [{ ...v4("fe80::1"), family: "IPv6" } as NetworkInterfaceInfo, v4("192.168.1.10"), v4("192.168.1.11")],
        tailscale0: [v4("100.101.5.6")],
        none: undefined,
      });
      expect(authManager.getAllAddresses()).toEqual([
        { label: "Localhost", ip: "localhost" },
        { label: "LAN", ip: "192.168.1.10" },
        { label: "Tailscale", ip: "100.101.5.6" },
      ]);
      expect(authManager.getLanAddress()).toBe("192.168.1.10");
    });

    it("treats 100.x outside 100.64.0.0/10 as LAN, and falls back to localhost with no external IPv4", () => {
      osMock.networkInterfaces = () => ({ eth0: [v4("100.20.0.1")] });
      expect(authManager.getAllAddresses()).toEqual([
        { label: "Localhost", ip: "localhost" },
        { label: "LAN", ip: "100.20.0.1" },
      ]);
      osMock.networkInterfaces = () => ({ lo: [v4("127.0.0.1", true)] });
      expect(authManager.getAllAddresses()).toEqual([{ label: "Localhost", ip: "localhost" }]);
      expect(authManager.getLanAddress()).toBe("localhost");
    });
  });
});
