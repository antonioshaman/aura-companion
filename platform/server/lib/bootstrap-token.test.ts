import { describe, expect, it } from "vitest";
import {
  DEFAULT_BOOTSTRAP_TOKEN_TTL_MS,
  bootstrapTokenTtlMs,
  generateBootstrapToken,
  hashBootstrapToken,
} from "./bootstrap-token";

// The DB stores only the hash of the one-time token; these pin that the hash
// is deterministic, differs from the token, and that tokens are unguessable.
describe("bootstrap token helpers", () => {
  it("generates distinct high-entropy tokens", () => {
    const a = generateBootstrapToken();
    const b = generateBootstrapToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(43); // 32 bytes base64url
  });

  it("hashes deterministically to sha256 hex, never echoing the token", () => {
    const h = hashBootstrapToken("tok");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(hashBootstrapToken("tok"));
    expect(h).not.toContain("tok");
  });

  it("reads the TTL from env and falls back to the default on bad input", () => {
    expect(bootstrapTokenTtlMs({ PLATFORM_BOOTSTRAP_TOKEN_TTL_MS: "60000" } as NodeJS.ProcessEnv)).toBe(60000);
    expect(bootstrapTokenTtlMs({ PLATFORM_BOOTSTRAP_TOKEN_TTL_MS: "nope" } as NodeJS.ProcessEnv)).toBe(
      DEFAULT_BOOTSTRAP_TOKEN_TTL_MS,
    );
    expect(bootstrapTokenTtlMs({} as NodeJS.ProcessEnv)).toBe(DEFAULT_BOOTSTRAP_TOKEN_TTL_MS);
  });
});
