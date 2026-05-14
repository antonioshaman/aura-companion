import { beforeEach, describe, expect, it } from "vitest";
import { useStore } from "./index.js";
import {
  selectAiValidationEnabled,
  selectAnthropicApiKeyConfigured,
  selectAnthropicOrganizationId,
  selectClaudeCodeOAuthTokenConfigured,
  selectClaudeTier,
  selectOpenaiApiKeyConfigured,
  selectSettingsHydrated,
  type ClaudeTierState,
} from "./settings-slice.js";

beforeEach(() => {
  // The slice has no reset path — re-initialise via direct setState so
  // each test starts from the structural zero. Mirrors auth-slice's
  // test pattern; cheaper than rebuilding the whole store.
  useStore.setState({
    anthropicApiKeyConfigured: null,
    claudeCodeOAuthTokenConfigured: null,
    openaiApiKeyConfigured: null,
    aiValidationEnabled: null,
    aiValidationAutoApprove: null,
    aiValidationAutoDeny: null,
    anthropicOrganizationId: null,
    claudeTier: null,
    settingsHydrated: false,
  });
});

describe("settings-slice — initial state", () => {
  // The null floor lets late-mounting consumers distinguish "we haven't
  // fetched yet" from "the server says false" without tristate locally.
  it("starts every server-authoritative flag at null", () => {
    const s = useStore.getState();
    expect(s.anthropicApiKeyConfigured).toBeNull();
    expect(s.claudeCodeOAuthTokenConfigured).toBeNull();
    expect(s.openaiApiKeyConfigured).toBeNull();
    expect(s.aiValidationEnabled).toBeNull();
    expect(s.aiValidationAutoApprove).toBeNull();
    expect(s.aiValidationAutoDeny).toBeNull();
  });

  it("starts settingsHydrated at false", () => {
    expect(useStore.getState().settingsHydrated).toBe(false);
  });
});

describe("settings-slice — hydrateSettings", () => {
  it("mirrors every supplied field from the payload", () => {
    useStore.getState().hydrateSettings({
      anthropicApiKeyConfigured: true,
      claudeCodeOAuthTokenConfigured: false,
      openaiApiKeyConfigured: true,
      aiValidationEnabled: true,
      aiValidationAutoApprove: false,
      aiValidationAutoDeny: true,
    });
    const s = useStore.getState();
    expect(s.anthropicApiKeyConfigured).toBe(true);
    expect(s.claudeCodeOAuthTokenConfigured).toBe(false);
    expect(s.openaiApiKeyConfigured).toBe(true);
    expect(s.aiValidationEnabled).toBe(true);
    expect(s.aiValidationAutoApprove).toBe(false);
    expect(s.aiValidationAutoDeny).toBe(true);
    expect(s.settingsHydrated).toBe(true);
  });

  it("preserves prior values for fields absent from the payload", () => {
    // Two-step hydration — second call doesn't include claudeCode field;
    // the value from the first call must survive (not get null-overwritten).
    useStore.getState().hydrateSettings({ claudeCodeOAuthTokenConfigured: true });
    useStore.getState().hydrateSettings({ openaiApiKeyConfigured: true });
    expect(useStore.getState().claudeCodeOAuthTokenConfigured).toBe(true);
    expect(useStore.getState().openaiApiKeyConfigured).toBe(true);
  });

  it("flips settingsHydrated to true on first call (and stays true)", () => {
    expect(useStore.getState().settingsHydrated).toBe(false);
    useStore.getState().hydrateSettings({});
    expect(useStore.getState().settingsHydrated).toBe(true);
    useStore.getState().hydrateSettings({});
    expect(useStore.getState().settingsHydrated).toBe(true);
  });

  it("rejects non-boolean values silently (preserves prior value)", () => {
    // Forward-compat: a future API surface could ship "configured" as
    // a string ("expired" | "valid") — the slice mustn't blindly coerce.
    useStore.getState().hydrateSettings({ openaiApiKeyConfigured: true });
    useStore.getState().hydrateSettings({
      openaiApiKeyConfigured: "valid" as unknown as boolean,
    });
    // Prior boolean preserved.
    expect(useStore.getState().openaiApiKeyConfigured).toBe(true);
  });
});

describe("settings-slice — setProviderConfigured", () => {
  it("updates only the supplied flags", () => {
    useStore.getState().hydrateSettings({
      claudeCodeOAuthTokenConfigured: false,
      openaiApiKeyConfigured: false,
    });
    useStore.getState().setProviderConfigured({
      openaiApiKeyConfigured: true,
    });
    const s = useStore.getState();
    // Updated:
    expect(s.openaiApiKeyConfigured).toBe(true);
    // Preserved:
    expect(s.claudeCodeOAuthTokenConfigured).toBe(false);
  });

  it("supports the three-field shape used by POST /api/settings response", () => {
    useStore.getState().setProviderConfigured({
      claudeCodeOAuthTokenConfigured: true,
      openaiApiKeyConfigured: true,
      anthropicApiKeyConfigured: true,
    });
    const s = useStore.getState();
    expect(s.claudeCodeOAuthTokenConfigured).toBe(true);
    expect(s.openaiApiKeyConfigured).toBe(true);
    expect(s.anthropicApiKeyConfigured).toBe(true);
  });
});

describe("settings-slice — selectors", () => {
  it("each selector reads its own field unchanged", () => {
    useStore.getState().hydrateSettings({
      anthropicApiKeyConfigured: true,
      claudeCodeOAuthTokenConfigured: false,
      openaiApiKeyConfigured: true,
      aiValidationEnabled: false,
    });
    const s = useStore.getState();
    expect(selectAnthropicApiKeyConfigured(s)).toBe(true);
    expect(selectClaudeCodeOAuthTokenConfigured(s)).toBe(false);
    expect(selectOpenaiApiKeyConfigured(s)).toBe(true);
    expect(selectAiValidationEnabled(s)).toBe(false);
    expect(selectSettingsHydrated(s)).toBe(true);
  });

  it("selectors return null pre-hydration (canonical 'we don't know yet')", () => {
    // Per slice doc: the null floor distinguishes unhydrated from
    // server-says-false. Consumers can short-circuit on null to render
    // a "loading" placeholder rather than a confusing "not configured".
    const s = useStore.getState();
    expect(selectAnthropicApiKeyConfigured(s)).toBeNull();
    expect(selectClaudeCodeOAuthTokenConfigured(s)).toBeNull();
    expect(selectOpenaiApiKeyConfigured(s)).toBeNull();
    expect(selectAiValidationEnabled(s)).toBeNull();
    expect(selectSettingsHydrated(s)).toBe(false);
  });
});

// ─── PLAN Task 7 — claudeTier + anthropicOrganizationId ───────────────────

describe("settings-slice — setClaudeTier (PLAN Task 7)", () => {
  it("stores the verified-tier record and exposes it via the selector", () => {
    // The route handler calls this with the response payload. Consumer
    // UI reads via selectClaudeTier and renders the appropriate pill.
    const tier: ClaudeTierState = {
      tier: "max_20x",
      plan: "Claude Max 20x",
      dailyLimit: 1500,
      cached: false,
      fetchedAt: 1_700_000_000_000,
      latencyMs: 234,
    };
    useStore.getState().setClaudeTier(tier);
    expect(selectClaudeTier(useStore.getState())).toEqual(tier);
  });

  it("accepts null to clear the slot (invalidate-on-credential-save path)", () => {
    // When the user saves new credentials, the SettingsPage calls
    // setClaudeTier(null) AFTER invalidating the server cache so the
    // pill flips back to "not verified" until the user hits Re-verify.
    useStore.getState().setClaudeTier({
      tier: "pro",
      plan: "Claude Pro",
      cached: false,
      fetchedAt: 1,
    });
    expect(selectClaudeTier(useStore.getState())).not.toBeNull();
    useStore.getState().setClaudeTier(null);
    expect(selectClaudeTier(useStore.getState())).toBeNull();
  });

  it("overwrites the prior tier (last-write-wins for re-verify)", () => {
    // Re-verify is a full overwrite — the cache-hit / fresh-probe
    // distinction is captured in the `cached` flag on the new record.
    useStore.getState().setClaudeTier({
      tier: "pro",
      plan: "Claude Pro",
      cached: false,
      fetchedAt: 1,
    });
    useStore.getState().setClaudeTier({
      tier: "max_20x",
      plan: "Claude Max 20x",
      cached: true,
      fetchedAt: 2,
    });
    const current = selectClaudeTier(useStore.getState());
    expect(current?.tier).toBe("max_20x");
    expect(current?.cached).toBe(true);
  });
});

describe("settings-slice — anthropicOrganizationId hydration", () => {
  it("hydrateSettings backfills anthropicOrganizationId from the payload", () => {
    // GET /api/settings echoes the org ID back so the form can display
    // the configured value. Hydration must mirror it onto the slice
    // for cross-component consumers (e.g. New Session pairing-gate
    // could surface org-scoped pairing decisions in the future).
    useStore.getState().hydrateSettings({ anthropicOrganizationId: "bed3566a-uuid" });
    expect(selectAnthropicOrganizationId(useStore.getState())).toBe("bed3566a-uuid");
  });

  it("preserves prior org ID when the payload omits the field", () => {
    // Idempotency invariant — re-hydration that doesn't carry the
    // field must not erase it. Mirrors the per-field "preserve prior"
    // semantics of the existing flags.
    useStore.getState().hydrateSettings({ anthropicOrganizationId: "initial-id" });
    useStore.getState().hydrateSettings({}); // partial hydration
    expect(selectAnthropicOrganizationId(useStore.getState())).toBe("initial-id");
  });

  it("selectAnthropicOrganizationId returns null pre-hydration", () => {
    expect(selectAnthropicOrganizationId(useStore.getState())).toBeNull();
  });

  it("selectClaudeTier returns null pre-verify", () => {
    expect(selectClaudeTier(useStore.getState())).toBeNull();
  });
});
