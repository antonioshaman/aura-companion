import { describe, expect, it } from "vitest";
import { formatTokenOutput, validTokenArgs } from "./cli-token.js";

/**
 * `aura-companion token` (council review 2026-11-15, friedman P2-1): a remote
 * user's first screen is the token login, and nothing pointed at a working way
 * to get the token. The command prints it with links that sign a browser in,
 * and — for any non-localhost link — the exact COMPANION_ALLOWED_ORIGIN line,
 * since a missing origin otherwise shows up as a bare "Connection timeout"
 * (friedman P2-2). Synthetic token only.
 */
const TOKEN = "0".repeat(64);
const base = { token: TOKEN, port: 3456, allowedOrigins: "", regenerated: false, authFile: "/home/u/.companion/auth.json" };

describe("formatTokenOutput", () => {
  it("prints the token, where it is stored and one sign-in link per address", () => {
    const out = formatTokenOutput({ ...base, addresses: [{ label: "Localhost", ip: "localhost" }, { label: "LAN", ip: "192.168.1.5" }] });
    expect(out).toContain(`Current Aura access token: ${TOKEN}`);
    expect(out).toContain("Stored at: /home/u/.companion/auth.json");
    expect(out).toContain(`http://localhost:3456/?token=${TOKEN}`);
    expect(out).toContain(`http://192.168.1.5:3456/?token=${TOKEN}`);
  });

  it("names the exact COMPANION_ALLOWED_ORIGIN line for remote addresses that are not allowed yet, keeping existing ones", () => {
    const out = formatTokenOutput({
      ...base,
      allowedOrigins: "https://aura.example.test",
      addresses: [{ label: "Localhost", ip: "localhost" }, { label: "LAN", ip: "192.168.1.5" }, { label: "Tailscale", ip: "100.64.0.9" }],
    });
    expect(out).toContain("COMPANION_ALLOWED_ORIGIN=https://aura.example.test,http://192.168.1.5:3456,http://100.64.0.9:3456");
  });

  it("says nothing about origins when only localhost is reachable or every remote origin is allowed", () => {
    expect(formatTokenOutput({ ...base, addresses: [{ label: "Localhost", ip: "localhost" }] })).not.toContain("COMPANION_ALLOWED_ORIGIN");
    expect(formatTokenOutput({ ...base, allowedOrigins: "http://192.168.1.5:3456", addresses: [{ label: "Localhost", ip: "localhost" }, { label: "LAN", ip: "192.168.1.5" }] })).not.toContain("COMPANION_ALLOWED_ORIGIN=");
  });

  it("says 'New' after --regenerate", () => {
    expect(formatTokenOutput({ ...base, regenerated: true, addresses: [{ label: "Localhost", ip: "localhost" }] })).toContain("New Aura access token");
  });
});

describe("validTokenArgs", () => {
  it("accepts --regenerate and --port <n> only", () => {
    expect(validTokenArgs([])).toBe(true);
    expect(validTokenArgs(["--regenerate"])).toBe(true);
    expect(validTokenArgs(["--port", "4000", "--regenerate"])).toBe(true);
    expect(validTokenArgs(["--port"])).toBe(false);
    expect(validTokenArgs(["--port", "x"])).toBe(false);
    expect(validTokenArgs(["--force"])).toBe(false);
  });
});
