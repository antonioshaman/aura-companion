import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

/**
 * Council review 2026-11-15, hunt #4: the settings fields that decide which
 * account sessions use (anthropicApiKey, claudeCodeOAuthToken, openaiApiKey)
 * are a second "swap the account" route. They get the sign-in routes' guard
 * — Aura token ALWAYS (no localhost bypass), allowed Origin, JSON only — and a
 * secret-free audit line (field, set/cleared, caller). Other settings fields
 * are unaffected. Synthetic values only.
 */

const TOKEN = "a".repeat(64);

vi.mock("../auth-manager.js", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  verifyToken: (t: string | null | undefined) => t === TOKEN,
}));

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { log } from "../logger.js";
import { _resetForTest, getSettings } from "../settings-manager.js";
import { registerSettingsRoutes } from "./settings-routes.js";

let app: Hono;
let logged: Array<Record<string, unknown>>;
let dir: string;

afterEach(() => {
  _resetForTest();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.restoreAllMocks();
  // Real settings manager on a temp file: never the user's ~/.companion.
  dir = mkdtempSync(join(tmpdir(), "settings-guard-"));
  _resetForTest(join(dir, "settings.json"));
  logged = [];
  for (const level of ["info", "warn"] as const) {
    vi.spyOn(log, level).mockImplementation((_m: string, _e: string, fields?: Record<string, unknown>) => {
      if (fields) logged.push(fields);
    });
  }
  app = new Hono();
  const api = new Hono();
  registerSettingsRoutes(api);
  app.route("/api", api);
});

function put(body: unknown, headers: Record<string, string> = {}) {
  return app.request("http://localhost:3456/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("PUT /api/settings — credential fields (hunt #4)", () => {
  it("refuses without the Aura token (no localhost bypass) and logs the refusal, never the value", async () => {
    const res = await put({ claudeCodeOAuthToken: "SYNTH-should-not-be-saved" });
    expect(res.status).toBe(401);
    expect(getSettings().claudeCodeOAuthToken).toBe("");
    expect(logged).toContainEqual(expect.objectContaining({ event: "settings.credential_change_refused", fields: "claudeCodeOAuthToken", why: "token" }));
    expect(JSON.stringify(logged)).not.toContain("SYNTH-should-not-be-saved");
  });

  it("refuses a foreign Origin and a non-JSON body even with the token", async () => {
    const auth = { Authorization: `Bearer ${TOKEN}` };
    expect((await put({ openaiApiKey: "sk-synth" }, { ...auth, Origin: "https://evil.example.test" })).status).toBe(403);
    expect((await put(JSON.stringify({ openaiApiKey: "sk-synth" }), { ...auth, "Content-Type": "text/plain" })).status).toBe(415);
    expect(getSettings().openaiApiKey).toBe("");
  });

  it("with token + own Origin + JSON: saves and writes an audit line per field (set / cleared), without the value", async () => {
    const res = await put(
      { openaiApiKey: "sk-synth-secret", claudeCodeOAuthToken: "" },
      { Authorization: `Bearer ${TOKEN}`, Origin: "http://localhost:3456" },
    );
    expect(res.status).toBe(200);
    expect(getSettings().openaiApiKey).toBe("sk-synth-secret");
    expect(logged).toContainEqual(expect.objectContaining({ event: "settings.credential_changed", field: "openaiApiKey", action: "set", auth: "bearer", origin: "http://localhost:3456" }));
    expect(logged).toContainEqual(expect.objectContaining({ event: "settings.credential_changed", field: "claudeCodeOAuthToken", action: "cleared" }));
    expect(JSON.stringify(logged)).not.toContain("sk-synth-secret");
  });

  it("leaves non-credential fields alone: no token needed here (the global auth middleware still applies in the app)", async () => {
    const res = await put({ onboardingCompleted: true });
    expect(res.status).toBe(200);
    expect(logged.some((f) => String(f.event).startsWith("settings.credential"))).toBe(false);
  });
});
