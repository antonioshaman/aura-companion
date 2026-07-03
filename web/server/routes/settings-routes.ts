import type { Hono } from "hono";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_ANTHROPIC_MODEL, getSettings, updateSettings, type UpdateChannel } from "../settings-manager.js";
import { linearCache } from "../linear-cache.js";
import { listConnections } from "../linear-connections.js";
import { hasContainerCodexAuth } from "../codex-container-auth.js";
import { COMPANION_HOME } from "../paths.js";
import { getAnthropicModels, readAnthropicCacheFileMeta } from "../anthropic-models-cache.js";

/** Path to the Codex CLI's own model cache — mirrors routes.ts:/backends/:id/models. */
function codexModelsCachePath(): string {
  return join(homedir(), ".codex", "models_cache.json");
}

export function registerSettingsRoutes(api: Hono): void {
  api.get("/settings", (c) => {
    const settings = getSettings();
    const connections = listConnections();
    return c.json({
      anthropicApiKeyConfigured: !!settings.anthropicApiKey.trim(),
      anthropicModel: settings.anthropicModel || DEFAULT_ANTHROPIC_MODEL,
      claudeCodeOAuthTokenConfigured: !!settings.claudeCodeOAuthToken.trim(),
      openaiApiKeyConfigured: !!settings.openaiApiKey.trim(),
      codexDeviceAuthConfigured: hasContainerCodexAuth(),
      onboardingCompleted: settings.onboardingCompleted,
      linearApiKeyConfigured: !!settings.linearApiKey.trim() || connections.length > 0,
      linearConnectionCount: connections.length,
      linearAutoTransition: settings.linearAutoTransition,
      linearAutoTransitionStateName: settings.linearAutoTransitionStateName,
      linearArchiveTransition: settings.linearArchiveTransition,
      linearArchiveTransitionStateName: settings.linearArchiveTransitionStateName,
      linearOAuthConfigured: !!(settings.linearOAuthClientId.trim() && settings.linearOAuthClientSecret.trim() && settings.linearOAuthAccessToken.trim()),
      linearOAuthCredentialsSaved: !!(settings.linearOAuthClientId.trim() && settings.linearOAuthClientSecret.trim()),
      aiValidationEnabled: settings.aiValidationEnabled,
      aiValidationAutoApprove: settings.aiValidationAutoApprove,
      aiValidationAutoDeny: settings.aiValidationAutoDeny,
      publicUrl: settings.publicUrl,
      updateChannel: settings.updateChannel,
      dockerAutoUpdate: settings.dockerAutoUpdate,
      telemetryEnabled: settings.telemetryEnabled,
    });
  });

  api.put("/settings", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (body.anthropicApiKey !== undefined && typeof body.anthropicApiKey !== "string") {
      return c.json({ error: "anthropicApiKey must be a string" }, 400);
    }
    if (body.anthropicModel !== undefined && typeof body.anthropicModel !== "string") {
      return c.json({ error: "anthropicModel must be a string" }, 400);
    }
    if (body.linearApiKey !== undefined && typeof body.linearApiKey !== "string") {
      return c.json({ error: "linearApiKey must be a string" }, 400);
    }
    if (body.linearAutoTransition !== undefined && typeof body.linearAutoTransition !== "boolean") {
      return c.json({ error: "linearAutoTransition must be a boolean" }, 400);
    }
    if (body.linearAutoTransitionStateId !== undefined && typeof body.linearAutoTransitionStateId !== "string") {
      return c.json({ error: "linearAutoTransitionStateId must be a string" }, 400);
    }
    if (body.linearAutoTransitionStateName !== undefined && typeof body.linearAutoTransitionStateName !== "string") {
      return c.json({ error: "linearAutoTransitionStateName must be a string" }, 400);
    }
    if (body.linearArchiveTransition !== undefined && typeof body.linearArchiveTransition !== "boolean") {
      return c.json({ error: "linearArchiveTransition must be a boolean" }, 400);
    }
    if (body.linearArchiveTransitionStateId !== undefined && typeof body.linearArchiveTransitionStateId !== "string") {
      return c.json({ error: "linearArchiveTransitionStateId must be a string" }, 400);
    }
    if (body.linearArchiveTransitionStateName !== undefined && typeof body.linearArchiveTransitionStateName !== "string") {
      return c.json({ error: "linearArchiveTransitionStateName must be a string" }, 400);
    }
    if (body.aiValidationEnabled !== undefined && typeof body.aiValidationEnabled !== "boolean") {
      return c.json({ error: "aiValidationEnabled must be a boolean" }, 400);
    }
    if (body.aiValidationAutoApprove !== undefined && typeof body.aiValidationAutoApprove !== "boolean") {
      return c.json({ error: "aiValidationAutoApprove must be a boolean" }, 400);
    }
    if (body.aiValidationAutoDeny !== undefined && typeof body.aiValidationAutoDeny !== "boolean") {
      return c.json({ error: "aiValidationAutoDeny must be a boolean" }, 400);
    }
    if (body.publicUrl !== undefined) {
      if (typeof body.publicUrl !== "string") {
        return c.json({ error: "publicUrl must be a string" }, 400);
      }
      const trimmed = body.publicUrl.trim().replace(/\/+$/, "");
      if (trimmed !== "" && !/^https?:\/\/.+/.test(trimmed)) {
        return c.json({ error: "publicUrl must be a valid http/https URL" }, 400);
      }
    }
    if (body.updateChannel !== undefined && body.updateChannel !== "stable" && body.updateChannel !== "prerelease") {
      return c.json({ error: "updateChannel must be 'stable' or 'prerelease'" }, 400);
    }
    if (body.linearOAuthClientId !== undefined && typeof body.linearOAuthClientId !== "string") {
      return c.json({ error: "linearOAuthClientId must be a string" }, 400);
    }
    if (body.linearOAuthClientSecret !== undefined && typeof body.linearOAuthClientSecret !== "string") {
      return c.json({ error: "linearOAuthClientSecret must be a string" }, 400);
    }
    if (body.linearOAuthWebhookSecret !== undefined && typeof body.linearOAuthWebhookSecret !== "string") {
      return c.json({ error: "linearOAuthWebhookSecret must be a string" }, 400);
    }
    if (body.claudeCodeOAuthToken !== undefined && typeof body.claudeCodeOAuthToken !== "string") {
      return c.json({ error: "claudeCodeOAuthToken must be a string" }, 400);
    }
    if (body.openaiApiKey !== undefined && typeof body.openaiApiKey !== "string") {
      return c.json({ error: "openaiApiKey must be a string" }, 400);
    }
    if (body.onboardingCompleted !== undefined && typeof body.onboardingCompleted !== "boolean") {
      return c.json({ error: "onboardingCompleted must be a boolean" }, 400);
    }
    if (body.dockerAutoUpdate !== undefined && typeof body.dockerAutoUpdate !== "boolean") {
      return c.json({ error: "dockerAutoUpdate must be a boolean" }, 400);
    }
    if (body.telemetryEnabled !== undefined && typeof body.telemetryEnabled !== "boolean") {
      return c.json({ error: "telemetryEnabled must be a boolean" }, 400);
    }
    const hasAnyField = body.anthropicApiKey !== undefined || body.anthropicModel !== undefined
      || body.claudeCodeOAuthToken !== undefined || body.openaiApiKey !== undefined
      || body.onboardingCompleted !== undefined
      || body.linearApiKey !== undefined || body.linearAutoTransition !== undefined
      || body.linearAutoTransitionStateId !== undefined || body.linearAutoTransitionStateName !== undefined
      || body.linearArchiveTransition !== undefined || body.linearArchiveTransitionStateId !== undefined
      || body.linearArchiveTransitionStateName !== undefined
      || body.linearOAuthClientId !== undefined || body.linearOAuthClientSecret !== undefined
      || body.linearOAuthWebhookSecret !== undefined
      || body.aiValidationEnabled !== undefined || body.aiValidationAutoApprove !== undefined
      || body.aiValidationAutoDeny !== undefined
      || body.publicUrl !== undefined
      || body.updateChannel !== undefined
      || body.dockerAutoUpdate !== undefined
      || body.telemetryEnabled !== undefined;
    if (!hasAnyField) {
      return c.json({ error: "At least one settings field is required" }, 400);
    }

    if (typeof body.linearApiKey === "string") {
      linearCache.clear();
    }

    const settings = updateSettings({
      anthropicApiKey:
        typeof body.anthropicApiKey === "string"
          ? body.anthropicApiKey.trim()
          : undefined,
      anthropicModel:
        typeof body.anthropicModel === "string"
          ? (body.anthropicModel.trim() || DEFAULT_ANTHROPIC_MODEL)
          : undefined,
      claudeCodeOAuthToken:
        typeof body.claudeCodeOAuthToken === "string"
          ? body.claudeCodeOAuthToken.trim()
          : undefined,
      openaiApiKey:
        typeof body.openaiApiKey === "string"
          ? body.openaiApiKey.trim()
          : undefined,
      onboardingCompleted:
        typeof body.onboardingCompleted === "boolean"
          ? body.onboardingCompleted
          : undefined,
      linearApiKey:
        typeof body.linearApiKey === "string"
          ? body.linearApiKey.trim()
          : undefined,
      linearAutoTransition:
        typeof body.linearAutoTransition === "boolean"
          ? body.linearAutoTransition
          : undefined,
      linearAutoTransitionStateId:
        typeof body.linearAutoTransitionStateId === "string"
          ? body.linearAutoTransitionStateId.trim()
          : undefined,
      linearAutoTransitionStateName:
        typeof body.linearAutoTransitionStateName === "string"
          ? body.linearAutoTransitionStateName.trim()
          : undefined,
      linearArchiveTransition:
        typeof body.linearArchiveTransition === "boolean"
          ? body.linearArchiveTransition
          : undefined,
      linearArchiveTransitionStateId:
        typeof body.linearArchiveTransitionStateId === "string"
          ? body.linearArchiveTransitionStateId.trim()
          : undefined,
      linearArchiveTransitionStateName:
        typeof body.linearArchiveTransitionStateName === "string"
          ? body.linearArchiveTransitionStateName.trim()
          : undefined,
      linearOAuthClientId:
        typeof body.linearOAuthClientId === "string"
          ? body.linearOAuthClientId.trim()
          : undefined,
      linearOAuthClientSecret:
        typeof body.linearOAuthClientSecret === "string"
          ? body.linearOAuthClientSecret.trim()
          : undefined,
      linearOAuthWebhookSecret:
        typeof body.linearOAuthWebhookSecret === "string"
          ? body.linearOAuthWebhookSecret.trim()
          : undefined,
      aiValidationEnabled:
        typeof body.aiValidationEnabled === "boolean"
          ? body.aiValidationEnabled
          : undefined,
      aiValidationAutoApprove:
        typeof body.aiValidationAutoApprove === "boolean"
          ? body.aiValidationAutoApprove
          : undefined,
      aiValidationAutoDeny:
        typeof body.aiValidationAutoDeny === "boolean"
          ? body.aiValidationAutoDeny
          : undefined,
      publicUrl:
        typeof body.publicUrl === "string"
          ? body.publicUrl.trim().replace(/\/+$/, "")
          : undefined,
      updateChannel:
        body.updateChannel === "stable" || body.updateChannel === "prerelease"
          ? (body.updateChannel as UpdateChannel)
          : undefined,
      dockerAutoUpdate:
        typeof body.dockerAutoUpdate === "boolean"
          ? body.dockerAutoUpdate
          : undefined,
      telemetryEnabled:
        typeof body.telemetryEnabled === "boolean"
          ? body.telemetryEnabled
          : undefined,
    });

    const connectionsAfterUpdate = listConnections();
    return c.json({
      anthropicApiKeyConfigured: !!settings.anthropicApiKey.trim(),
      anthropicModel: settings.anthropicModel || DEFAULT_ANTHROPIC_MODEL,
      claudeCodeOAuthTokenConfigured: !!settings.claudeCodeOAuthToken.trim(),
      openaiApiKeyConfigured: !!settings.openaiApiKey.trim(),
      codexDeviceAuthConfigured: hasContainerCodexAuth(),
      onboardingCompleted: settings.onboardingCompleted,
      linearApiKeyConfigured: !!settings.linearApiKey.trim() || connectionsAfterUpdate.length > 0,
      linearConnectionCount: connectionsAfterUpdate.length,
      linearAutoTransition: settings.linearAutoTransition,
      linearAutoTransitionStateName: settings.linearAutoTransitionStateName,
      linearArchiveTransition: settings.linearArchiveTransition,
      linearArchiveTransitionStateName: settings.linearArchiveTransitionStateName,
      linearOAuthConfigured: !!(settings.linearOAuthClientId.trim() && settings.linearOAuthClientSecret.trim() && settings.linearOAuthAccessToken.trim()),
      linearOAuthCredentialsSaved: !!(settings.linearOAuthClientId.trim() && settings.linearOAuthClientSecret.trim()),
      aiValidationEnabled: settings.aiValidationEnabled,
      aiValidationAutoApprove: settings.aiValidationAutoApprove,
      aiValidationAutoDeny: settings.aiValidationAutoDeny,
      publicUrl: settings.publicUrl,
      updateChannel: settings.updateChannel,
      dockerAutoUpdate: settings.dockerAutoUpdate,
      telemetryEnabled: settings.telemetryEnabled,
    });
  });

  api.post("/settings/anthropic/verify", async (c) => {
    const body = await c.req.json().catch(() => ({} as { apiKey?: string }));
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    if (!apiKey) {
      return c.json({ valid: false, error: "API key is required" }, 400);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);

    try {
      const res = await fetch("https://api.anthropic.com/v1/models", {
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        signal: controller.signal,
      });

      if (res.ok) {
        return c.json({ valid: true });
      }
      return c.json({ valid: false, error: `API returned ${res.status}` });
    } catch (err) {
      const isAbort = err instanceof Error && err.name === "AbortError";
      return c.json({ valid: false, error: isAbort ? "Request timed out" : "Request failed" });
    } finally {
      clearTimeout(timer);
    }
  });

  // Operator-triggered model-list refresh. The GET /backends/:id/models
  // handler is deliberately cache-honest (Hunt R4 — no `?force=1` escape
  // hatch), so an explicit refresh is a distinct POST intent: force a fresh
  // Anthropic /v1/models fetch (repopulating the server cache) so the next
  // GET returns the latest catalogue. Codex has no server-side cache to bust
  // — its list is read straight from the CLI's own models_cache.json on
  // every GET — so we only report whether that file is present.
  api.post("/settings/models/refresh", async (c) => {
    const settings = getSettings();
    const key = settings.anthropicApiKey.trim();
    let claude: "ok" | "no-key" | "unavailable";
    if (!key) {
      claude = "no-key";
    } else {
      const result = await getAnthropicModels(key, {
        forceRefresh: true,
        parentSignal: c.req.raw.signal,
      });
      claude = result.kind === "ok" ? "ok" : result.kind === "no-key" ? "no-key" : "unavailable";
    }
    const codex = existsSync(codexModelsCachePath()) ? "ok" : "absent";
    return c.json({ claude, codex });
  });

  // Config/cache diagnostics for the Settings panel. Surfaces WHICH
  // COMPANION_HOME the running server reads (so a key saved under a diverging
  // home is diagnosable, not a mystery) and the freshness of both model
  // caches. This is an authenticated operator-only response body — the raw
  // home path is the feature's whole point here, not a log-line leak (EC-23
  // governs logs, not this response).
  api.get("/settings/diagnostics", (c) => {
    const settings = getSettings();
    const anthropicMeta = readAnthropicCacheFileMeta();

    const codexPath = codexModelsCachePath();
    let codex:
      | { present: false }
      | {
          present: true;
          fetchedAt: string | null;
          clientVersion: string | null;
          listedModelCount: number | null;
        };
    if (!existsSync(codexPath)) {
      codex = { present: false };
    } else {
      try {
        const parsed = JSON.parse(readFileSync(codexPath, "utf-8")) as {
          fetched_at?: unknown;
          client_version?: unknown;
          models?: unknown;
        };
        const listedModelCount = Array.isArray(parsed.models)
          ? parsed.models.filter(
              (m): m is { visibility?: unknown } =>
                typeof m === "object" && m !== null && (m as { visibility?: unknown }).visibility === "list",
            ).length
          : null;
        codex = {
          present: true,
          fetchedAt: typeof parsed.fetched_at === "string" ? parsed.fetched_at : null,
          clientVersion: typeof parsed.client_version === "string" ? parsed.client_version : null,
          listedModelCount,
        };
      } catch {
        codex = { present: true, fetchedAt: null, clientVersion: null, listedModelCount: null };
      }
    }

    return c.json({
      companionHome: COMPANION_HOME,
      anthropic: {
        keyConfigured: !!settings.anthropicApiKey.trim(),
        cachePresent: anthropicMeta.present,
        // epoch ms (server clock at last successful fetch); null when absent.
        cacheFetchedAt: anthropicMeta.fetchedAt,
        cacheModelCount: anthropicMeta.modelCount,
      },
      codex,
    });
  });
}
