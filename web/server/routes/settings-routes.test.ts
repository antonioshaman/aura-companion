import { vi, describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { homedir } from "node:os";
import { join } from "node:path";

// The Codex model cache path the diagnostics/refresh routes probe. Kept in sync
// with settings-routes.ts codexModelsCachePath().
const CODEX_CACHE_PATH = join(homedir(), ".codex", "models_cache.json");

// ── Controllable dependency doubles ─────────────────────────────────────────
// Only the surfaces the two NEW endpoints exercise are swapped; everything else
// in each module is preserved via importActual spread so registering the full
// route table (which also wires GET/PUT /settings) doesn't crash on missing
// named exports.
const mockGetSettings = vi.fn();
const mockGetAnthropicModels = vi.fn();
const mockReadAnthropicCacheFileMeta = vi.fn();
// Codex cache is faked at the fs boundary so we can toggle present/absent
// without touching the real ~/.codex file.
let codexCacheExists = false;
let codexCacheContent = "";

vi.mock("../settings-manager.js", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, getSettings: (...a: unknown[]) => mockGetSettings(...a) };
});

vi.mock("../anthropic-models-cache.js", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    getAnthropicModels: (...a: unknown[]) => mockGetAnthropicModels(...a),
    readAnthropicCacheFileMeta: (...a: unknown[]) => mockReadAnthropicCacheFileMeta(...a),
  };
});

vi.mock("node:fs", async (orig) => {
  const actual = (await orig()) as typeof import("node:fs");
  return {
    ...actual,
    existsSync: (p: import("node:fs").PathLike) =>
      p === CODEX_CACHE_PATH ? codexCacheExists : actual.existsSync(p),
    readFileSync: ((p: import("node:fs").PathOrFileDescriptor, enc?: unknown) =>
      p === CODEX_CACHE_PATH
        ? codexCacheContent
        : (actual.readFileSync as (...args: unknown[]) => unknown)(p, enc)) as typeof actual.readFileSync,
  };
});

import { registerSettingsRoutes } from "./settings-routes.js";

let app: Hono;

beforeEach(() => {
  vi.clearAllMocks();
  codexCacheExists = false;
  codexCacheContent = "";
  // Default: a key is configured so the refresh route reaches the fetch branch.
  mockGetSettings.mockReturnValue({ anthropicApiKey: "sk-ant-api03-test" });
  mockGetAnthropicModels.mockResolvedValue({ kind: "ok", models: [{ id: "claude-opus-4-8" }] });
  mockReadAnthropicCacheFileMeta.mockReturnValue({ present: true, fetchedAt: 1_700_000_000_000, modelCount: 7 });

  app = new Hono();
  const api = new Hono();
  registerSettingsRoutes(api);
  app.route("/api", api);
});

describe("POST /api/settings/models/refresh", () => {
  // With a key present and Codex cache present, the endpoint force-refreshes the
  // Anthropic list (forceRefresh:true) and reports both backends "ok".
  it("force-refreshes Anthropic and reports both backends ok when key + codex cache present", async () => {
    codexCacheExists = true;
    codexCacheContent = JSON.stringify({ models: [{ visibility: "list" }] });

    const res = await app.request("/api/settings/models/refresh", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ claude: "ok", codex: "ok" });

    // The refresh MUST bypass the fresh-memory cache — verified via the flag.
    expect(mockGetAnthropicModels).toHaveBeenCalledTimes(1);
    const [key, opts] = mockGetAnthropicModels.mock.calls[0];
    expect(key).toBe("sk-ant-api03-test");
    expect((opts as { forceRefresh?: boolean }).forceRefresh).toBe(true);
  });

  // No key configured → the fetch branch is skipped entirely and claude reports
  // "no-key" (never a spurious "unavailable" from a doomed keyless fetch).
  it("returns claude:no-key without calling the fetch when no key is configured", async () => {
    mockGetSettings.mockReturnValue({ anthropicApiKey: "   " });

    const res = await app.request("/api/settings/models/refresh", { method: "POST" });
    expect(await res.json()).toEqual({ claude: "no-key", codex: "absent" });
    expect(mockGetAnthropicModels).not.toHaveBeenCalled();
  });

  // Upstream failure surfaces as claude:unavailable (mapped from the cache
  // module's non-ok/non-no-key result kind), not a 500.
  it("maps an upstream failure to claude:unavailable", async () => {
    mockGetAnthropicModels.mockResolvedValue({ kind: "unavailable" });

    const res = await app.request("/api/settings/models/refresh", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ claude: "unavailable" });
  });
});

describe("GET /api/settings/diagnostics", () => {
  // Surfaces COMPANION_HOME + both cache freshness summaries. The Codex count
  // only tallies entries whose visibility is "list" (mirrors the dropdown).
  it("reports config home, anthropic cache meta, and listed codex model count", async () => {
    codexCacheExists = true;
    codexCacheContent = JSON.stringify({
      fetched_at: "2026-07-01T10:00:00.000Z",
      client_version: "0.9.1",
      models: [
        { visibility: "list" },
        { visibility: "list" },
        { visibility: "hidden" },
      ],
    });

    const res = await app.request("/api/settings/diagnostics");
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      companionHome: string;
      anthropic: { keyConfigured: boolean; cachePresent: boolean; cacheFetchedAt: number | null; cacheModelCount: number | null };
      codex: { present: boolean; fetchedAt: string | null; clientVersion: string | null; listedModelCount: number | null };
    };

    expect(typeof json.companionHome).toBe("string");
    expect(json.companionHome.length).toBeGreaterThan(0);
    expect(json.anthropic).toEqual({
      keyConfigured: true,
      cachePresent: true,
      cacheFetchedAt: 1_700_000_000_000,
      cacheModelCount: 7,
    });
    // Only the two visibility:"list" entries are counted; "hidden" is excluded.
    expect(json.codex).toEqual({
      present: true,
      fetchedAt: "2026-07-01T10:00:00.000Z",
      clientVersion: "0.9.1",
      listedModelCount: 2,
    });
  });

  // When the Codex CLI cache file is absent the endpoint reports present:false
  // (the discriminant the client uses to render "not installed").
  it("reports codex present:false when the cache file is absent", async () => {
    codexCacheExists = false;

    const res = await app.request("/api/settings/diagnostics");
    const json = (await res.json()) as { codex: { present: boolean } };
    expect(json.codex).toEqual({ present: false });
  });

  // A corrupt Codex cache must not 500 the diagnostics — it degrades to a
  // present-but-unparseable record with null fields.
  it("degrades gracefully to null fields on a corrupt codex cache", async () => {
    codexCacheExists = true;
    codexCacheContent = "{ not valid json";

    const res = await app.request("/api/settings/diagnostics");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { codex: { present: boolean; listedModelCount: number | null } };
    expect(json.codex).toEqual({
      present: true,
      fetchedAt: null,
      clientVersion: null,
      listedModelCount: null,
    });
  });

  // keyConfigured reflects a trimmed-empty key as false (no phantom "configured"
  // state from whitespace).
  it("reports keyConfigured:false for a whitespace-only key", async () => {
    mockGetSettings.mockReturnValue({ anthropicApiKey: "   " });
    mockReadAnthropicCacheFileMeta.mockReturnValue({ present: false, fetchedAt: null, modelCount: null });

    const res = await app.request("/api/settings/diagnostics");
    const json = (await res.json()) as { anthropic: { keyConfigured: boolean } };
    expect(json.anthropic.keyConfigured).toBe(false);
  });
});
