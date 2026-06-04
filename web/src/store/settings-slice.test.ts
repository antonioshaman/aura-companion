import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "./index.js";
import {
  selectAiValidationEnabled,
  selectAnthropicApiKeyConfigured,
  selectClaudeCodeOAuthTokenConfigured,
  selectOpenaiApiKeyConfigured,
  selectSettingsHydrated,
  selectDynamicBackendModels,
  selectDynamicBackendModelsStatus,
  __resetBackendModelInflightForTests,
} from "./settings-slice.js";

// PLAN-aura-dynamic-model-list Task 15 — mock the REST client surface
// the slice action calls into. `vi.hoisted` is required because the
// slice's `api.getBackendModels` is imported at module-eval time.
const { mockGetBackendModels } = vi.hoisted(() => ({
  mockGetBackendModels: vi.fn(),
}));
vi.mock("../api.js", () => ({
  api: { getBackendModels: mockGetBackendModels },
}));

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
    settingsHydrated: false,
    dynamicBackendModels: {},
    dynamicBackendModelsStatus: { claude: "idle", codex: "idle" },
  });
  __resetBackendModelInflightForTests();
  mockGetBackendModels.mockReset();
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

// ── PLAN Task 8 / Task 15 — dynamicBackendModels lifecycle ─────────────────

describe("settings-slice — loadBackendModels (happy path)", () => {
  it("populates dynamicBackendModels.claude on successful fetch", async () => {
    mockGetBackendModels.mockResolvedValueOnce([
      { value: "claude-opus-4-8", label: "Opus 4.8", description: "" },
    ]);

    await useStore.getState().loadBackendModels("claude");

    const s = useStore.getState();
    expect(s.dynamicBackendModels.claude).toHaveLength(1);
    expect(s.dynamicBackendModels.claude?.[0]?.value).toBe("claude-opus-4-8");
    expect(selectDynamicBackendModels(s, "claude")?.[0]?.value).toBe("claude-opus-4-8");
    expect(selectDynamicBackendModelsStatus(s, "claude")).toBe("resolved");
    expect(mockGetBackendModels).toHaveBeenCalledWith("claude");
  });

  it("leaves dynamicBackendModels.claude undefined when the server returns an empty list", async () => {
    // Backend's empty-list outcome (no models passed filter) is materially
    // the same as 'unavailable' to the consumer — fall through to static.
    mockGetBackendModels.mockResolvedValueOnce([]);

    await useStore.getState().loadBackendModels("claude");

    const s = useStore.getState();
    expect(s.dynamicBackendModels.claude).toBeUndefined();
    expect(selectDynamicBackendModelsStatus(s, "claude")).toBe("resolved");
  });
});

describe("settings-slice — loadBackendModels (silent fallback)", () => {
  it("flips status to 'rejected' on REST failure (does NOT throw to caller)", async () => {
    mockGetBackendModels.mockRejectedValueOnce(new Error("network"));

    // The action must NOT propagate — consumers (HomePage / ModelSwitcher /
    // CronManager) call it fire-and-forget and rely on the silent
    // fallback contract.
    await expect(useStore.getState().loadBackendModels("claude")).resolves.toBeUndefined();

    const s = useStore.getState();
    expect(s.dynamicBackendModels.claude).toBeUndefined();
    expect(selectDynamicBackendModelsStatus(s, "claude")).toBe("rejected");
  });
});

describe("settings-slice — loadBackendModels (inflight-token guard)", () => {
  // PLAN Frontend R1 — concurrent N requests for the same backend must
  // collapse: only the LATEST call's result commits. Without the guard, a
  // slow first fetch lands after a faster post-save refetch and clobbers
  // fresh data with stale.
  it("only the last call's result commits when two are in flight simultaneously", async () => {
    let resolveFirst!: (v: unknown) => void;
    let resolveSecond!: (v: unknown) => void;
    mockGetBackendModels
      .mockReturnValueOnce(new Promise((res) => { resolveFirst = res; }))
      .mockReturnValueOnce(new Promise((res) => { resolveSecond = res; }));

    const p1 = useStore.getState().loadBackendModels("claude");
    const p2 = useStore.getState().loadBackendModels("claude");

    // Resolve in REVERSE order: second resolves first, then first.
    resolveSecond([
      { value: "claude-opus-4-8", label: "Opus 4.8", description: "" },
    ]);
    resolveFirst([
      { value: "claude-stale-old", label: "Stale", description: "" },
    ]);

    await Promise.all([p1, p2]);

    const s = useStore.getState();
    // The second call (newer token) wins; first call's result dropped.
    expect(s.dynamicBackendModels.claude).toHaveLength(1);
    expect(s.dynamicBackendModels.claude?.[0]?.value).toBe("claude-opus-4-8");
  });

  it("two backends do not share an inflight token (codex is independent of claude)", async () => {
    mockGetBackendModels.mockImplementation(async (id: string) =>
      id === "claude"
        ? [{ value: "claude-opus-4-8", label: "Opus 4.8", description: "" }]
        : [{ value: "gpt-5", label: "GPT-5", description: "" }],
    );

    await Promise.all([
      useStore.getState().loadBackendModels("claude"),
      useStore.getState().loadBackendModels("codex"),
    ]);

    const s = useStore.getState();
    expect(s.dynamicBackendModels.claude?.[0]?.value).toBe("claude-opus-4-8");
    expect(s.dynamicBackendModels.codex?.[0]?.value).toBe("gpt-5");
  });
});
