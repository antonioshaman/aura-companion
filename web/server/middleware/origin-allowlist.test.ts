import { describe, expect, it } from "vitest";
import { isOriginAllowed } from "./origin-allowlist.js";

describe("isOriginAllowed", () => {
  // ── Rule 1: localhost without Origin header (CLI/curl/test) ─────────────

  it("accepts loopback request with no Origin header (CLI subprocess pattern)", () => {
    expect(isOriginAllowed({ origin: null, localhost: true })).toBe(true);
  });

  // ── Rule 5: Origin: null from non-loopback (cross-origin POST) ──────────

  it("rejects null Origin from a non-loopback caller (sandbox-iframe attack)", () => {
    expect(isOriginAllowed({ origin: null, localhost: false })).toBe(false);
  });

  // ── Rule 2: dev frontend origins ─────────────────────────────────────────

  it.each([
    "http://localhost:5174",
    "http://127.0.0.1:5174",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
  ])("accepts dev frontend origin %s", (origin) => {
    expect(isOriginAllowed({ origin, localhost: true })).toBe(true);
    expect(isOriginAllowed({ origin, localhost: false })).toBe(true);
  });

  // ── Rule 3: env-driven allowlist match ──────────────────────────────────

  it("accepts an origin from the production allowlist", () => {
    expect(
      isOriginAllowed({
        origin: "https://companion.example.com",
        localhost: false,
        allowedOriginsOverride: new Set(["https://companion.example.com"]),
      }),
    ).toBe(true);
  });

  it("supports multi-origin production allowlist (tailscale + LAN pattern)", () => {
    const allow = new Set([
      "https://aura.tailnet.example.ts.net",
      "http://10.0.0.5:3456",
    ]);
    expect(isOriginAllowed({ origin: "https://aura.tailnet.example.ts.net", localhost: false, allowedOriginsOverride: allow })).toBe(true);
    expect(isOriginAllowed({ origin: "http://10.0.0.5:3456", localhost: false, allowedOriginsOverride: allow })).toBe(true);
  });

  // ── Rule 5: cross-origin browser tab ────────────────────────────────────

  it("rejects an arbitrary cross-origin (the canonical attack)", () => {
    expect(
      isOriginAllowed({
        origin: "https://evil.example",
        localhost: true,
        allowedOriginsOverride: new Set(),
      }),
    ).toBe(false);
  });

  it("rejects mismatched scheme even if host matches dev port", () => {
    // https://localhost:5174 isn't in the dev set — only http is. A
    // mismatched scheme indicates either a misconfigured client or an
    // adversarial proxy — reject conservatively.
    expect(isOriginAllowed({ origin: "https://localhost:5174", localhost: true })).toBe(false);
  });

  it("rejects empty-string Origin", () => {
    expect(isOriginAllowed({ origin: "", localhost: true })).toBe(false);
  });

  // ── Env-var parsing surface ─────────────────────────────────────────────

  it("uses COMPANION_ALLOWED_ORIGIN env when no override supplied", () => {
    const prev = process.env.COMPANION_ALLOWED_ORIGIN;
    process.env.COMPANION_ALLOWED_ORIGIN = "https://prod.example.com,https://second.example.com";
    try {
      expect(isOriginAllowed({ origin: "https://prod.example.com", localhost: false })).toBe(true);
      expect(isOriginAllowed({ origin: "https://second.example.com", localhost: false })).toBe(true);
      expect(isOriginAllowed({ origin: "https://other.example.com", localhost: false })).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.COMPANION_ALLOWED_ORIGIN;
      else process.env.COMPANION_ALLOWED_ORIGIN = prev;
    }
  });

  it("returns false on empty env var with non-dev origin", () => {
    // Per feedback_test_env_pollution_explicit_unset — explicit delete
    // rather than relying on shell baseline.
    const prev = process.env.COMPANION_ALLOWED_ORIGIN;
    delete process.env.COMPANION_ALLOWED_ORIGIN;
    try {
      expect(isOriginAllowed({ origin: "https://unknown.example", localhost: false })).toBe(false);
    } finally {
      if (prev !== undefined) process.env.COMPANION_ALLOWED_ORIGIN = prev;
    }
  });
});
