import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { api } from "../api.js";
import { useStore } from "../store.js";
import { getTelemetryPreferenceEnabled, setTelemetryPreferenceEnabled } from "../analytics.js";
import { navigateToSession, navigateHome } from "../utils/routing.js";
import type { SdkSessionInfo } from "../types.js";

interface SettingsPageProps {
  embedded?: boolean;
}

const CATEGORIES = [
  { id: "general", label: "General" },
  { id: "webhooks", label: "Webhooks" },
  { id: "authentication", label: "Authentication" },
  { id: "notifications", label: "Notifications" },
  { id: "providers", label: "Providers" },
  { id: "anthropic", label: "Anthropic" },
  { id: "ai-validation", label: "AI Validation" },
  { id: "telemetry", label: "Telemetry" },
  { id: "environments", label: "Environments" },
] as const;

type CategoryId = (typeof CATEGORIES)[number]["id"];

export function SettingsPage({ embedded = false }: SettingsPageProps) {
  const [anthropicApiKey, setAnthropicApiKey] = useState("");
  const [anthropicModel, setAnthropicModel] = useState("claude-sonnet-4-6");
  const [configured, setConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const darkMode = useStore((s) => s.darkMode);
  const toggleDarkMode = useStore((s) => s.toggleDarkMode);
  const diffBase = useStore((s) => s.diffBase);
  const setDiffBase = useStore((s) => s.setDiffBase);
  const notificationSound = useStore((s) => s.notificationSound);
  const toggleNotificationSound = useStore((s) => s.toggleNotificationSound);
  const notificationDesktop = useStore((s) => s.notificationDesktop);
  const setNotificationDesktop = useStore((s) => s.setNotificationDesktop);
  const notificationApiAvailable = typeof Notification !== "undefined";
  const [telemetryEnabled, setTelemetryEnabled] = useState(getTelemetryPreferenceEnabled());
  const [aiValidationEnabled, setAiValidationEnabled] = useState(false);
  const [aiValidationAutoApprove, setAiValidationAutoApprove] = useState(true);
  const [aiValidationAutoDeny, setAiValidationAutoDeny] = useState(false);
  const [publicUrl, setPublicUrl] = useState("");
  const [activeSection, setActiveSection] = useState<CategoryId>("general");
  const [apiKeyFocused, setApiKeyFocused] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<{ valid: boolean; error?: string } | null>(null);

  // Provider tokens state
  const [claudeCodeToken, setClaudeCodeToken] = useState("");
  const [claudeCodeTokenConfigured, setClaudeCodeTokenConfigured] = useState(false);
  const [openaiApiKey, setOpenaiApiKey] = useState("");
  const [openaiApiKeyConfigured, setOpenaiApiKeyConfigured] = useState(false);
  // Task 6: also hydrate the settings-slice so other consumers (the
  // New Session pairing-availability gate, future MAX 20x verifier)
  // read a single source of truth. The local useState above stays so
  // existing SettingsPage tests continue to work against the
  // `vi.mock("../store.js")` selector mock; the wire-up of
  // SettingsPage itself onto the slice is a follow-up PR that needs
  // the test mock upgraded to support Zustand-style subscriptions.
  const hydrateSettingsSlice = useStore((s) => s.hydrateSettings);
  const setProviderConfiguredSlice = useStore((s) => s.setProviderConfigured);
  const sdkSessions = useStore((s) => s.sdkSessions);
  // Council groups carry the authoritative observer identity
  // (`observerSessionId`). The client `SdkSessionInfo` has no role field, so we
  // derive the observer set here and exclude those halves from provider
  // relaunch (P1/P2 #2).
  const councilGroups = useStore((s) => s.groups);
  // PLAN-aura-dynamic-model-list Task 8: re-fetch the dynamic Claude
  // model list after a successful Anthropic API key save. The store
  // action is idempotent + inflight-token-guarded so the trigger is safe
  // to fire alongside any other consumer's mount-time fetch.
  const loadBackendModelsSlice = useStore((s) => s.loadBackendModels);
  const [providerSaving, setProviderSaving] = useState(false);
  const [providerSaved, setProviderSaved] = useState(false);
  const [providerRelaunchNotice, setProviderRelaunchNotice] = useState("");
  const [providerError, setProviderError] = useState("");
  const [providerRelaunching, setProviderRelaunching] = useState<null | "claude" | "codex">(null);

  // Auth section state
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [tokenRevealed, setTokenRevealed] = useState(false);
  const [qrCodes, setQrCodes] = useState<{ label: string; url: string; qrDataUrl: string }[] | null>(null);
  const [selectedQrIndex, setSelectedQrIndex] = useState(0);
  const [qrLoading, setQrLoading] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [tokenCopied, setTokenCopied] = useState(false);

  const contentRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});

  // IntersectionObserver to track which section is in view
  useEffect(() => {
    const container = contentRef.current;
    if (!container) return;

    const observer = new IntersectionObserver(
      (entries) => {
        // Find the topmost visible section
        let topEntry: IntersectionObserverEntry | null = null;
        for (const entry of entries) {
          if (entry.isIntersecting) {
            if (!topEntry || entry.boundingClientRect.top < topEntry.boundingClientRect.top) {
              topEntry = entry;
            }
          }
        }
        if (topEntry?.target?.id) {
          setActiveSection(topEntry.target.id as CategoryId);
        }
      },
      {
        root: container,
        rootMargin: "-10% 0px -70% 0px",
        threshold: 0,
      },
    );

    for (const cat of CATEGORIES) {
      const el = sectionRefs.current[cat.id];
      if (el) observer.observe(el);
    }

    return () => observer.disconnect();
  }, [loading]); // re-attach after loading completes and sections render

  const scrollToSection = useCallback((id: CategoryId) => {
    setActiveSection(id);
    const el = sectionRefs.current[id];
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, []);

  useEffect(() => {
    api
      .getSettings()
      .then((s) => {
        setConfigured(s.anthropicApiKeyConfigured);
        setClaudeCodeTokenConfigured(s.claudeCodeOAuthTokenConfigured);
        setOpenaiApiKeyConfigured(s.openaiApiKeyConfigured);
        // Task 6: dual-write the server-authoritative facts to the
        // settings-slice. The local state above remains the source for
        // THIS component (test-mock compatibility); the slice is what
        // other consumers (New Session pairing-availability gate)
        // read. When the SettingsPage test infrastructure is upgraded
        // to support Zustand subscriptions, the locals collapse into
        // slice selectors and this dual-write becomes single-write.
        if (typeof hydrateSettingsSlice === "function") {
          hydrateSettingsSlice({
            anthropicApiKeyConfigured: s.anthropicApiKeyConfigured,
            claudeCodeOAuthTokenConfigured: s.claudeCodeOAuthTokenConfigured,
            openaiApiKeyConfigured: s.openaiApiKeyConfigured,
            aiValidationEnabled: s.aiValidationEnabled,
            aiValidationAutoApprove: s.aiValidationAutoApprove,
            aiValidationAutoDeny: s.aiValidationAutoDeny,
            // Council Review 2026-06-04-0823 P1 #1: hydrate the sticky
            // preference into the slice so HomePage / CronManager's
            // switchBackend can preserve user choice across backend toggles.
            anthropicModel: typeof s.anthropicModel === "string" && s.anthropicModel.length > 0
              ? s.anthropicModel
              : null,
          });
        }
        setAnthropicModel(s.anthropicModel || "claude-sonnet-4-6");
        if (typeof s.aiValidationEnabled === "boolean") setAiValidationEnabled(s.aiValidationEnabled);
        if (typeof s.aiValidationAutoApprove === "boolean") setAiValidationAutoApprove(s.aiValidationAutoApprove);
        if (typeof s.aiValidationAutoDeny === "boolean") setAiValidationAutoDeny(s.aiValidationAutoDeny);
        if (typeof s.publicUrl === "string") {
          setPublicUrl(s.publicUrl);
          useStore.getState().setPublicUrl(s.publicUrl);
        }
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));

    // Fetch auth token in parallel (non-blocking)
    api.getAuthToken().then((res) => setAuthToken(res.token)).catch(() => {});
  }, []);

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const nextKey = anthropicApiKey.trim();
      const payload: { anthropicApiKey?: string; anthropicModel: string } = {
        anthropicModel: anthropicModel.trim() || "claude-sonnet-4-6",
      };
      if (nextKey) {
        payload.anthropicApiKey = nextKey;
      }

      const res = await api.updateSettings(payload);
      setConfigured(res.anthropicApiKeyConfigured);
      setAnthropicApiKey("");
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
      // Council Review 2026-06-04-0823 P1 #1: surface the saved sticky
      // preference into the slice immediately after save so the next
      // switchBackend / new-session call site reads the fresh value
      // instead of the pre-save slice snapshot.
      if (typeof hydrateSettingsSlice === "function") {
        hydrateSettingsSlice({
          anthropicApiKeyConfigured: res.anthropicApiKeyConfigured,
          anthropicModel: payload.anthropicModel,
        });
      }
      // PLAN Task 8: refetch dynamic Claude models after a key was
      // submitted. Skip when `nextKey` is empty (user only changed the
      // model preference without rotating the key) — the existing cache
      // is still valid under the same fingerprint.
      if (nextKey && typeof loadBackendModelsSlice === "function") {
        void loadBackendModelsSlice("claude");
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function toggleAiValidation(field: "aiValidationEnabled" | "aiValidationAutoApprove" | "aiValidationAutoDeny") {
    const current = field === "aiValidationEnabled" ? aiValidationEnabled
      : field === "aiValidationAutoApprove" ? aiValidationAutoApprove
      : aiValidationAutoDeny;
    const newValue = !current;
    // Optimistic UI update
    if (field === "aiValidationEnabled") setAiValidationEnabled(newValue);
    else if (field === "aiValidationAutoApprove") setAiValidationAutoApprove(newValue);
    else setAiValidationAutoDeny(newValue);

    try {
      await api.updateSettings({ [field]: newValue });
    } catch {
      // Revert on failure
      if (field === "aiValidationEnabled") setAiValidationEnabled(current);
      else if (field === "aiValidationAutoApprove") setAiValidationAutoApprove(current);
      else setAiValidationAutoDeny(current);
    }
  }

  // Council-aware (P1/P2 #2): never relaunch a council OBSERVER half from
  // Settings — it is a server-managed companion, not user-driven work, and
  // restarting it independently of its orchestrator can interrupt an in-flight
  // review. Its auth is refreshed on the server's own relaunch path.
  function getSessionsToRelaunchForProviders(
    sessions: SdkSessionInfo[],
    providers: Array<"claude" | "codex">,
    observerSessionIds: Set<string>,
  ): SdkSessionInfo[] {
    const wanted = new Set(providers);
    return sessions.filter((session) => {
      if (session.archived) return false;
      if (observerSessionIds.has(session.sessionId)) return false;
      const backend = session.backendType === "codex" ? "codex" : "claude";
      return wanted.has(backend);
    });
  }

  // Observer halves of council groups are server-managed companions; never
  // relaunch them from Settings (P1/P2 #2).
  const observerSessionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const group of councilGroups.values()) ids.add(group.observerSessionId);
    return ids;
  }, [councilGroups]);

  // Memoised counts so the disabled/label/className expressions don't re-filter
  // the session list four times per render (P3 #15).
  const claudeRelaunchCount = useMemo(
    () => getSessionsToRelaunchForProviders(sdkSessions, ["claude"], observerSessionIds).length,
    [sdkSessions, observerSessionIds],
  );
  const codexRelaunchCount = useMemo(
    () => getSessionsToRelaunchForProviders(sdkSessions, ["codex"], observerSessionIds).length,
    [sdkSessions, observerSessionIds],
  );

  async function relaunchProviderSessions(
    providers: Array<"claude" | "codex">,
    options: { showNoSessionsNotice?: boolean } = {},
  ): Promise<void> {
    // Read the live session list at action time, not the render-snapshot the
    // closure captured — a session may have ended/spawned during the await (#15).
    const liveState = useStore.getState();
    const liveSessions = liveState.sdkSessions;
    const liveObserverIds = new Set<string>();
    for (const group of liveState.groups.values()) liveObserverIds.add(group.observerSessionId);
    const sessionsToRelaunch = getSessionsToRelaunchForProviders(liveSessions, providers, liveObserverIds);
    if (sessionsToRelaunch.length === 0) {
      if (options.showNoSessionsNotice) {
        const label = providers.length === 1 ? providers[0] : "selected";
        setProviderRelaunchNotice(`No active ${label} sessions to relaunch.`);
      }
      return;
    }

    const results = await Promise.allSettled(
      sessionsToRelaunch.map((session) => api.relaunchSession(session.sessionId)),
    );
    const failedCount = results.filter((result) => result.status === "rejected").length;
    const relaunchedCount = sessionsToRelaunch.length - failedCount;
    // Partial failure is the actionable case: surface ONE message in the error
    // register rather than a conflicting info+error pair (Friedman F5 / #11).
    if (failedCount > 0) {
      setProviderError(
        `Relaunched ${relaunchedCount} of ${sessionsToRelaunch.length} session(s); ${failedCount} could not be relaunched and may still use the old credentials.`,
      );
    } else {
      setProviderRelaunchNotice(`Relaunched ${relaunchedCount} session(s) to apply credentials.`);
    }
  }

  const setSectionRef = useCallback((id: string) => (el: HTMLElement | null) => {
    sectionRefs.current[id] = el;
  }, []);

  return (
    <div className={`${embedded ? "h-full" : "h-[100dvh]"} bg-cc-bg text-cc-fg font-sans-ui antialiased flex flex-col`}>
      {/* Header */}
      <div className="shrink-0 max-w-5xl w-full mx-auto px-4 sm:px-8 pt-6 sm:pt-10">
        <div className="flex items-start justify-between gap-3 mb-6">
          <div>
            <h1 className="text-xl font-semibold text-cc-fg">Settings</h1>
            <p className="mt-1 text-sm text-cc-muted">
              Configure API access, notifications, appearance, and workspace defaults.
            </p>
          </div>
          {!embedded && (
            <button
              onClick={() => {
                const sessionId = useStore.getState().currentSessionId;
                if (sessionId) {
                  navigateToSession(sessionId);
                } else {
                  navigateHome();
                }
              }}
              className="px-3 py-2.5 min-h-[44px] rounded-lg text-sm text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
            >
              Back
            </button>
          )}
        </div>
      </div>

      {/* Mobile horizontal nav */}
      <div className="sm:hidden shrink-0 border-b border-cc-border">
        <nav
          className="flex gap-1 px-4 py-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          aria-label="Settings categories"
        >
          {CATEGORIES.map((cat) => (
            <button
              key={cat.id}
              type="button"
              onClick={() => scrollToSection(cat.id)}
              className={`shrink-0 px-3 py-2 min-h-[44px] rounded-lg text-sm font-medium transition-colors cursor-pointer ${
                activeSection === cat.id
                  ? "text-cc-primary bg-cc-primary/8"
                  : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
              }`}
            >
              {cat.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Body: desktop sidebar + content */}
      <div className="flex-1 min-h-0 flex max-w-5xl w-full mx-auto">
        {/* Desktop sidebar nav */}
        <nav
          className="hidden sm:flex flex-col gap-0.5 w-44 shrink-0 pt-2 pr-6 pl-8 sticky top-0 self-start"
          aria-label="Settings categories"
        >
          {CATEGORIES.map((cat) => (
            <button
              key={cat.id}
              type="button"
              onClick={() => scrollToSection(cat.id)}
              className={`text-left px-3 py-2 min-h-[44px] rounded-lg text-sm font-medium transition-colors cursor-pointer ${
                activeSection === cat.id
                  ? "text-cc-primary bg-cc-primary/8"
                  : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
              }`}
            >
              {cat.label}
            </button>
          ))}
        </nav>

        {/* Scrollable content */}
        <div ref={contentRef} className="flex-1 min-w-0 overflow-y-auto px-4 sm:px-8 sm:pl-0 pb-safe">
          <div className="space-y-10 py-4 sm:py-2">
            {/* General */}
            <section id="general" ref={setSectionRef("general")}>
              <h2 className="text-sm font-semibold text-cc-fg mb-4">General</h2>
              <div className="space-y-3">
                <button
                  type="button"
                  onClick={toggleDarkMode}
                  className="w-full flex items-center justify-between px-3 py-3 min-h-[44px] rounded-lg text-sm bg-cc-hover text-cc-fg hover:bg-cc-active transition-colors cursor-pointer"
                >
                  <span>Theme</span>
                  <span className="text-xs text-cc-muted">{darkMode ? "Dark" : "Light"}</span>
                </button>

                <button
                  type="button"
                  onClick={() => setDiffBase(diffBase === "last-commit" ? "default-branch" : "last-commit")}
                  className="w-full flex items-center justify-between px-3 py-3 min-h-[44px] rounded-lg text-sm bg-cc-hover text-cc-fg hover:bg-cc-active transition-colors cursor-pointer"
                >
                  <span>Diff compare against</span>
                  <span className="text-xs text-cc-muted">
                    {diffBase === "last-commit" ? "Last commit (HEAD)" : "Default branch"}
                  </span>
                </button>
                <p className="text-xs text-cc-muted px-1">
                  Last commit shows only uncommitted changes. Default branch shows all changes since diverging from main.
                </p>
              </div>
            </section>

            {/* Webhooks */}
            <section id="webhooks" ref={setSectionRef("webhooks")}>
              <h2 className="text-sm font-semibold text-cc-fg mb-4">Webhooks</h2>
              <div className="space-y-4">
                <p className="text-xs text-cc-muted">
                  The public URL is used for webhook URLs that external services (Linear, GitHub) send events to.
                  Set this to the externally-reachable address of your Companion instance.
                </p>
                <p className="text-xs text-cc-muted">
                  Tip:{" "}
                  <a
                    href="#/integrations/tailscale"
                    className="text-cc-primary hover:underline"
                  >
                    Use the Tailscale integration
                  </a>{" "}
                  to get an HTTPS URL automatically.
                </p>
                <div>
                  <label className="block text-xs font-medium text-cc-fg mb-1.5" htmlFor="public-url">
                    Public URL
                  </label>
                  <input
                    id="public-url"
                    type="url"
                    aria-label="Public URL"
                    value={publicUrl}
                    onChange={(e) => setPublicUrl(e.target.value)}
                    placeholder="https://your-domain.example.com"
                    className="w-full px-3 py-2.5 min-h-[44px] text-sm bg-cc-bg rounded-lg border border-cc-border text-cc-fg placeholder:text-cc-muted focus:outline-none focus:ring-1 focus:ring-cc-primary font-mono-code"
                  />
                  <p className="mt-1.5 text-[10px] text-cc-muted">
                    {publicUrl
                      ? `Using: ${publicUrl}`
                      : `Fallback: ${typeof window !== "undefined" ? window.location.origin : "http://localhost:3456"}`}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={async () => {
                    setSaving(true);
                    setError("");
                    try {
                      const res = await api.updateSettings({ publicUrl: publicUrl.trim() });
                      setPublicUrl(res.publicUrl);
                      useStore.getState().setPublicUrl(res.publicUrl);
                      setSaved(true);
                      setTimeout(() => setSaved(false), 1800);
                    } catch (err: unknown) {
                      setError(err instanceof Error ? err.message : String(err));
                    } finally {
                      setSaving(false);
                    }
                  }}
                  disabled={saving}
                  className="px-4 py-2 min-h-[44px] rounded-lg text-sm font-medium bg-cc-primary text-white hover:opacity-90 transition-opacity disabled:opacity-50 cursor-pointer"
                >
                  {saving ? "Saving..." : saved ? "Saved!" : "Save Public URL"}
                </button>
              </div>
            </section>

            {/* Authentication */}
            <section id="authentication" ref={setSectionRef("authentication")}>
              <h2 className="text-sm font-semibold text-cc-fg mb-4">Authentication</h2>
              <div className="space-y-4">
                <p className="text-xs text-cc-muted">
                  Use the auth token or QR code to connect additional devices (e.g. mobile over Tailscale).
                </p>

                {/* Token display */}
                <div>
                  <label className="block text-sm font-medium mb-1.5">Auth Token</label>
                  <div className="flex items-center gap-2">
                    <div className="flex-1 px-3 py-2.5 min-h-[44px] text-sm bg-cc-bg rounded-lg text-cc-fg font-mono-code select-all break-all flex items-center">
                      {authToken
                        ? tokenRevealed
                          ? authToken
                          : "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022"
                        : <span className="text-cc-muted">Loading...</span>}
                    </div>
                    <button
                      type="button"
                      onClick={() => setTokenRevealed((v) => !v)}
                      className="px-3 py-2.5 min-h-[44px] rounded-lg text-sm bg-cc-hover hover:bg-cc-active text-cc-fg transition-colors cursor-pointer"
                      title={tokenRevealed ? "Hide token" : "Show token"}
                    >
                      {tokenRevealed ? "Hide" : "Show"}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (authToken) {
                          navigator.clipboard.writeText(authToken).then(() => {
                            setTokenCopied(true);
                            setTimeout(() => setTokenCopied(false), 1500);
                          });
                        }
                      }}
                      disabled={!authToken}
                      className="px-3 py-2.5 min-h-[44px] rounded-lg text-sm bg-cc-hover hover:bg-cc-active text-cc-fg transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                      title="Copy token to clipboard"
                    >
                      {tokenCopied ? "Copied" : "Copy"}
                    </button>
                  </div>
                </div>

                {/* QR code with address tabs */}
                <div>
                  <label className="block text-sm font-medium mb-1.5">Mobile Login QR</label>
                  {qrCodes && qrCodes.length > 0 ? (
                    <div className="space-y-3">
                      {/* Address tabs — pick which network to use */}
                      {qrCodes.length > 1 && (
                        <div className="flex gap-1">
                          {qrCodes.map((qr, i) => (
                            <button
                              key={qr.label}
                              type="button"
                              onClick={() => setSelectedQrIndex(i)}
                              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                                i === selectedQrIndex
                                  ? "bg-cc-primary text-white"
                                  : "bg-cc-hover text-cc-muted hover:text-cc-fg"
                              }`}
                            >
                              {qr.label}
                            </button>
                          ))}
                        </div>
                      )}
                      <div className="inline-block rounded-lg bg-white p-2">
                        <img
                          src={qrCodes[selectedQrIndex].qrDataUrl}
                          alt={`QR code for ${qrCodes[selectedQrIndex].label} login`}
                          className="w-48 h-48"
                        />
                      </div>
                      <div className="px-3 py-2 rounded-lg bg-cc-bg text-sm font-mono-code text-cc-fg break-all select-all">
                        {qrCodes[selectedQrIndex].url}
                      </div>
                      <p className="text-xs text-cc-muted">
                        Scan with your phone&apos;s camera app — it will open the URL and auto-authenticate.
                      </p>
                    </div>
                  ) : qrCodes && qrCodes.length === 0 ? (
                    <p className="text-xs text-cc-muted">
                      No remote addresses detected (LAN or Tailscale). Connect to a network to generate a QR code.
                    </p>
                  ) : (
                    <button
                      type="button"
                      onClick={async () => {
                        setQrLoading(true);
                        try {
                          const data = await api.getAuthQr();
                          setQrCodes(data.qrCodes);
                        } catch {
                          // QR generation failed silently — user can retry
                        } finally {
                          setQrLoading(false);
                        }
                      }}
                      disabled={qrLoading}
                      className={`px-3 py-2 min-h-[44px] rounded-lg text-sm font-medium transition-colors ${
                        qrLoading
                          ? "bg-cc-hover text-cc-muted cursor-not-allowed"
                          : "bg-cc-hover hover:bg-cc-active text-cc-fg cursor-pointer"
                      }`}
                    >
                      {qrLoading ? "Generating..." : "Show QR Code"}
                    </button>
                  )}
                </div>

                {/* Regenerate token */}
                <div className="pt-2">
                  <button
                    type="button"
                    onClick={async () => {
                      if (!confirm("Regenerate auth token? All existing sessions on other devices will be signed out.")) return;
                      setRegenerating(true);
                      try {
                        const res = await api.regenerateAuthToken();
                        setAuthToken(res.token);
                        setTokenRevealed(true);
                        setQrCodes(null); // invalidate old QR
                      } catch {
                        // Regeneration failed
                      } finally {
                        setRegenerating(false);
                      }
                    }}
                    disabled={regenerating}
                    className={`px-3 py-2 min-h-[44px] rounded-lg text-sm font-medium transition-colors ${
                      regenerating
                        ? "bg-cc-hover text-cc-muted cursor-not-allowed"
                        : "bg-cc-error/10 hover:bg-cc-error/20 text-cc-error cursor-pointer"
                    }`}
                  >
                    {regenerating ? "Regenerating..." : "Regenerate Token"}
                  </button>
                  <p className="mt-1.5 text-xs text-cc-muted">
                    Creates a new token. All other signed-in devices will need to re-authenticate.
                  </p>
                </div>
              </div>
            </section>

            {/* Notifications */}
            <section id="notifications" ref={setSectionRef("notifications")}>
              <h2 className="text-sm font-semibold text-cc-fg mb-4">Notifications</h2>
              <div className="space-y-3">
                <button
                  type="button"
                  onClick={toggleNotificationSound}
                  className="w-full flex items-center justify-between px-3 py-3 min-h-[44px] rounded-lg text-sm bg-cc-hover text-cc-fg hover:bg-cc-active transition-colors cursor-pointer"
                >
                  <span>Sound</span>
                  <span className="text-xs text-cc-muted">{notificationSound ? "On" : "Off"}</span>
                </button>
                {notificationApiAvailable && (
                  <button
                    type="button"
                    onClick={async () => {
                      if (!notificationDesktop) {
                        if (Notification.permission !== "granted") {
                          const result = await Notification.requestPermission();
                          if (result !== "granted") return;
                        }
                        setNotificationDesktop(true);
                      } else {
                        setNotificationDesktop(false);
                      }
                    }}
                    className="w-full flex items-center justify-between px-3 py-3 min-h-[44px] rounded-lg text-sm bg-cc-hover text-cc-fg hover:bg-cc-active transition-colors cursor-pointer"
                  >
                    <span>Desktop Alerts</span>
                    <span className="text-xs text-cc-muted">{notificationDesktop ? "On" : "Off"}</span>
                  </button>
                )}
              </div>
            </section>

            {/* Providers */}
            <section id="providers" ref={setSectionRef("providers")}>
              <h2 className="text-sm font-semibold text-cc-fg mb-4">Providers</h2>
              <div className="space-y-6">
                <p className="text-xs text-cc-muted">
                  Configure authentication tokens for Claude Code and Codex. These are injected into sessions automatically.
                </p>

                {/* Claude Code OAuth Token */}
                <div className="space-y-2">
                  <label className="block text-sm font-medium" htmlFor="claude-code-token">
                    Claude Code OAuth Token
                  </label>
                  <p className="text-xs text-cc-muted">
                    Run <code className="font-mono-code bg-cc-code-bg px-1 py-0.5 rounded text-cc-code-fg">claude setup-token</code> in your terminal, then paste the token here.
                  </p>
                  <input
                    id="claude-code-token"
                    type="password"
                    value={claudeCodeToken}
                    onChange={(e) => setClaudeCodeToken(e.target.value)}
                    placeholder={claudeCodeTokenConfigured ? "••••••••••••••••  (enter a new token to replace)" : "Paste token from claude setup-token"}
                    className="w-full px-3 py-2.5 min-h-[44px] text-sm bg-cc-bg rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:ring-1 focus:ring-cc-primary/40 transition-shadow"
                    aria-describedby="claude-code-token-status"
                  />
                  <p id="claude-code-token-status" className="text-xs text-cc-muted">
                    {claudeCodeTokenConfigured ? "Claude Code token configured" : "Claude Code token not configured"}
                  </p>
                </div>

                {/* OpenAI API Key (Codex) */}
                <div className="space-y-2">
                  <label className="block text-sm font-medium" htmlFor="openai-api-key">
                    OpenAI API Key (Codex)
                  </label>
                  <p className="text-xs text-cc-muted">
                    Used to authenticate Codex sessions. You can also use <code className="font-mono-code bg-cc-code-bg px-1 py-0.5 rounded text-cc-code-fg">codex --login</code> for device-based auth.
                  </p>
                  <input
                    id="openai-api-key"
                    type="password"
                    value={openaiApiKey}
                    onChange={(e) => setOpenaiApiKey(e.target.value)}
                    placeholder={openaiApiKeyConfigured ? "••••••••••••••••  (enter a new key to replace)" : "sk-..."}
                    className="w-full px-3 py-2.5 min-h-[44px] text-sm bg-cc-bg rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:ring-1 focus:ring-cc-primary/40 transition-shadow"
                    aria-describedby="openai-api-key-status"
                  />
                  <p id="openai-api-key-status" className="text-xs text-cc-muted">
                    {openaiApiKeyConfigured ? "OpenAI key configured" : "OpenAI key not configured"}
                  </p>
                </div>

                {/* Live regions persist in the DOM so async status changes are
                    announced (a11y F1 / Friedman F3). Only the inner text toggles. */}
                <div role="alert" aria-live="assertive" aria-atomic="true">
                  {providerError && (
                    <div className="px-3 py-2 rounded-lg bg-cc-error/10 border border-cc-error/20 text-xs text-cc-error">
                      {providerError}
                    </div>
                  )}
                </div>

                <div role="status" aria-live="polite" aria-atomic="true" className="space-y-2 empty:hidden">
                  {providerSaved && (
                    <div className="px-3 py-2 rounded-lg bg-cc-success/10 border border-cc-success/20 text-xs text-cc-success">
                      Provider settings saved.
                    </div>
                  )}

                  {providerRelaunchNotice && (
                    <div className="px-3 py-2 rounded-lg bg-cc-info/10 border border-cc-info/20 text-xs text-cc-info">
                      {providerRelaunchNotice}
                    </div>
                  )}
                </div>

                <button
                  type="button"
                  aria-busy={providerSaving}
                  disabled={providerSaving || (!claudeCodeToken.trim() && !openaiApiKey.trim())}
                  onClick={async () => {
                    setProviderSaving(true);
                    setProviderError("");
                    setProviderSaved(false);
                    setProviderRelaunchNotice("");
                    try {
                      const payload: { claudeCodeOAuthToken?: string; openaiApiKey?: string } = {};
                      if (claudeCodeToken.trim()) payload.claudeCodeOAuthToken = claudeCodeToken.trim();
                      if (openaiApiKey.trim()) payload.openaiApiKey = openaiApiKey.trim();
                      const res = await api.updateSettings(payload);
                      setClaudeCodeTokenConfigured(res.claudeCodeOAuthTokenConfigured);
                      setOpenaiApiKeyConfigured(res.openaiApiKeyConfigured);
                      // Task 6: dual-write to slice so other consumers
                      // see the post-save state without a re-fetch.
                      if (typeof setProviderConfiguredSlice === "function") {
                        setProviderConfiguredSlice({
                          claudeCodeOAuthTokenConfigured: res.claudeCodeOAuthTokenConfigured,
                          openaiApiKeyConfigured: res.openaiApiKeyConfigured,
                        });
                      }
                      setClaudeCodeToken("");
                      setOpenaiApiKey("");
                      setProviderSaved(true);
                      setTimeout(() => setProviderSaved(false), 1800);
                      const changedProviders: Array<"claude" | "codex"> = [];
                      if (payload.claudeCodeOAuthToken) changedProviders.push("claude");
                      if (payload.openaiApiKey) changedProviders.push("codex");
                      // Credential-only save (Friedman F1 / #3): saving must NOT
                      // silently kill live sessions. Disclose how many still run
                      // on the old credentials and let the user apply them via
                      // the explicit Relaunch button(s) below.
                      const affectedState = useStore.getState();
                      const affectedObserverIds = new Set<string>();
                      for (const group of affectedState.groups.values()) {
                        affectedObserverIds.add(group.observerSessionId);
                      }
                      const affected = getSessionsToRelaunchForProviders(
                        affectedState.sdkSessions,
                        changedProviders,
                        affectedObserverIds,
                      ).length;
                      if (affected > 0) {
                        setProviderRelaunchNotice(
                          `${affected} active session(s) still use the previous credentials. Use the Relaunch button(s) below to apply them.`,
                        );
                      }
                    } catch (err: unknown) {
                      setProviderError(err instanceof Error ? err.message : String(err));
                    } finally {
                      setProviderSaving(false);
                    }
                  }}
                  className={`px-4 py-2 min-h-[44px] rounded-lg text-sm font-medium transition-colors ${
                    providerSaving || (!claudeCodeToken.trim() && !openaiApiKey.trim())
                      ? "bg-cc-hover text-cc-muted cursor-not-allowed"
                      : "bg-cc-primary hover:bg-cc-primary-hover text-white cursor-pointer"
                  }`}
                >
                  {providerSaving ? "Saving..." : "Save Provider Settings"}
                </button>
                <p id="provider-relaunch-help" className="text-xs text-cc-muted">
                  Saving stores credentials only. Running sessions keep their old
                  credentials until relaunched — use the buttons below to apply
                  new credentials to active sessions.
                </p>

                <div className="grid gap-2 sm:grid-cols-2">
                  {(() => {
                    const claudeBusy = providerRelaunching === "claude";
                    const claudeDisabled = providerRelaunching !== null || claudeRelaunchCount === 0;
                    return (
                      <button
                        type="button"
                        aria-disabled={claudeDisabled}
                        aria-busy={claudeBusy}
                        aria-describedby="provider-relaunch-help"
                        onClick={async () => {
                          // Guard replaces native `disabled` so the control stays
                          // focusable/discoverable for keyboard+SR users (a11y F3).
                          if (claudeDisabled) return;
                          setProviderError("");
                          setProviderSaved(false);
                          setProviderRelaunchNotice("Relaunching Claude sessions…");
                          setProviderRelaunching("claude");
                          try {
                            await relaunchProviderSessions(["claude"], { showNoSessionsNotice: true });
                          } catch (err: unknown) {
                            setProviderError(err instanceof Error ? err.message : String(err));
                          } finally {
                            setProviderRelaunching(null);
                          }
                        }}
                        className={`px-4 py-2 min-h-[44px] rounded-lg text-sm font-medium transition-colors ${
                          claudeDisabled
                            ? "bg-cc-hover text-cc-muted cursor-not-allowed"
                            : "bg-cc-hover hover:bg-cc-active text-cc-fg cursor-pointer"
                        }`}
                      >
                        {claudeBusy
                          ? "Relaunching Claude…"
                          : claudeRelaunchCount === 0
                            ? "No Active Claude Sessions"
                            : `Relaunch ${claudeRelaunchCount} Active Claude Session(s)`}
                      </button>
                    );
                  })()}
                  {(() => {
                    const codexBusy = providerRelaunching === "codex";
                    const codexDisabled = providerRelaunching !== null || codexRelaunchCount === 0;
                    return (
                      <button
                        type="button"
                        aria-disabled={codexDisabled}
                        aria-busy={codexBusy}
                        aria-describedby="provider-relaunch-help"
                        onClick={async () => {
                          if (codexDisabled) return;
                          setProviderError("");
                          setProviderSaved(false);
                          setProviderRelaunchNotice("Relaunching Codex sessions…");
                          setProviderRelaunching("codex");
                          try {
                            await relaunchProviderSessions(["codex"], { showNoSessionsNotice: true });
                          } catch (err: unknown) {
                            setProviderError(err instanceof Error ? err.message : String(err));
                          } finally {
                            setProviderRelaunching(null);
                          }
                        }}
                        className={`px-4 py-2 min-h-[44px] rounded-lg text-sm font-medium transition-colors ${
                          codexDisabled
                            ? "bg-cc-hover text-cc-muted cursor-not-allowed"
                            : "bg-cc-hover hover:bg-cc-active text-cc-fg cursor-pointer"
                        }`}
                      >
                        {codexBusy
                          ? "Relaunching Codex…"
                          : codexRelaunchCount === 0
                            ? "No Active Codex Sessions"
                            : `Relaunch ${codexRelaunchCount} Active Codex Session(s)`}
                      </button>
                    );
                  })()}
                </div>
              </div>
            </section>

            {/* Anthropic */}
            <section id="anthropic" ref={setSectionRef("anthropic")}>
              <h2 className="text-sm font-semibold text-cc-fg mb-4">Anthropic</h2>
              <form onSubmit={onSave} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium mb-1.5" htmlFor="anthropic-key">
                    Anthropic API Key
                  </label>
                  <input
                    id="anthropic-key"
                    type="password"
                    value={configured && !apiKeyFocused && !anthropicApiKey ? "••••••••••••••••" : anthropicApiKey}
                    onChange={(e) => { setAnthropicApiKey(e.target.value); setVerifyResult(null); }}
                    onFocus={() => setApiKeyFocused(true)}
                    onBlur={() => setApiKeyFocused(false)}
                    placeholder={configured ? "Enter a new key to replace" : "sk-ant-api03-..."}
                    className="w-full px-3 py-2.5 min-h-[44px] text-sm bg-cc-bg rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:ring-1 focus:ring-cc-primary/40 transition-shadow"
                  />
                  <p className="mt-1.5 text-xs text-cc-muted">
                    Auto-renaming is disabled until this key is configured.
                  </p>
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1.5" htmlFor="anthropic-model">
                    Anthropic Model
                  </label>
                  <input
                    id="anthropic-model"
                    type="text"
                    value={anthropicModel}
                    onChange={(e) => setAnthropicModel(e.target.value)}
                    placeholder="claude-sonnet-4-6"
                    className="w-full px-3 py-2.5 min-h-[44px] text-sm bg-cc-bg rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:ring-1 focus:ring-cc-primary/40 transition-shadow"
                  />
                </div>

                {error && (
                  <div className="px-3 py-2 rounded-lg bg-cc-error/10 border border-cc-error/20 text-xs text-cc-error">
                    {error}
                  </div>
                )}

                {saved && (
                  <div className="px-3 py-2 rounded-lg bg-cc-success/10 border border-cc-success/20 text-xs text-cc-success">
                    Settings saved.
                  </div>
                )}

                <div className="flex items-center justify-between">
                  <span className="text-xs text-cc-muted">
                    {loading ? "Loading..." : configured ? "Anthropic key configured" : "Anthropic key not configured"}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={verifying || !anthropicApiKey.trim()}
                      onClick={async () => {
                        setVerifying(true);
                        setVerifyResult(null);
                        try {
                          const result = await api.verifyAnthropicKey(anthropicApiKey.trim());
                          setVerifyResult(result);
                          setTimeout(() => setVerifyResult(null), 5000);
                        } catch (err: unknown) {
                          setVerifyResult({ valid: false, error: err instanceof Error ? err.message : String(err) });
                          setTimeout(() => setVerifyResult(null), 5000);
                        } finally {
                          setVerifying(false);
                        }
                      }}
                      className={`px-3 py-2 min-h-[44px] rounded-lg text-sm font-medium transition-colors ${
                        verifying || !anthropicApiKey.trim()
                          ? "bg-cc-hover text-cc-muted cursor-not-allowed"
                          : "bg-cc-hover hover:bg-cc-active text-cc-fg cursor-pointer"
                      }`}
                    >
                      {verifying ? "Verifying..." : "Verify"}
                    </button>
                    <button
                      type="submit"
                      disabled={saving || loading}
                      className={`px-3 py-2 min-h-[44px] rounded-lg text-sm font-medium transition-colors ${
                        saving || loading
                          ? "bg-cc-hover text-cc-muted cursor-not-allowed"
                          : "bg-cc-primary hover:bg-cc-primary-hover text-white cursor-pointer"
                      }`}
                    >
                      {saving ? "Saving..." : "Save"}
                    </button>
                  </div>
                </div>

                {verifyResult && (
                  <div className={`px-3 py-2 rounded-lg text-xs ${
                    verifyResult.valid
                      ? "bg-cc-success/10 border border-cc-success/20 text-cc-success"
                      : "bg-cc-error/10 border border-cc-error/20 text-cc-error"
                  }`}>
                    {verifyResult.valid ? "API key is valid." : `Invalid API key${verifyResult.error ? `: ${verifyResult.error}` : "."}`}
                  </div>
                )}
              </form>
            </section>

            {/* AI Validation */}
            <section id="ai-validation" ref={setSectionRef("ai-validation")}>
              <h2 className="text-sm font-semibold text-cc-fg mb-4">AI Validation</h2>
              <div className="space-y-3">
                <p className="text-xs text-cc-muted leading-relaxed">
                  When enabled, an AI model evaluates tool calls before they execute.
                  Safe operations are auto-approved, dangerous ones are blocked,
                  and uncertain cases are shown to you with a recommendation.
                  Requires an Anthropic API key. These settings serve as defaults
                  for new sessions. Each session can override AI validation
                  independently via the shield icon in the session header.
                </p>

                <button
                  type="button"
                  onClick={() => toggleAiValidation("aiValidationEnabled")}
                  disabled={!configured}
                  className={`w-full flex items-center justify-between px-3 py-3 min-h-[44px] rounded-lg transition-colors ${
                    !configured
                      ? "bg-cc-hover text-cc-muted cursor-not-allowed opacity-60"
                      : "bg-cc-hover hover:bg-cc-active text-cc-fg cursor-pointer"
                  }`}
                >
                  <span className="text-sm">AI Validation Mode</span>
                  <span className={`text-xs font-medium ${aiValidationEnabled && configured ? "text-cc-success" : "text-cc-muted"}`}>
                    {aiValidationEnabled && configured ? "On" : "Off"}
                  </span>
                </button>
                {!configured && (
                  <p className="text-[11px] text-cc-warning">Configure an Anthropic API key above to enable AI validation.</p>
                )}

                {aiValidationEnabled && configured && (
                  <>
                    <button
                      type="button"
                      onClick={() => toggleAiValidation("aiValidationAutoApprove")}
                      className="w-full flex items-center justify-between px-3 py-3 min-h-[44px] rounded-lg bg-cc-hover hover:bg-cc-active text-cc-fg transition-colors cursor-pointer"
                    >
                      <div>
                        <span className="text-sm">Auto-approve safe tools</span>
                        <p className="text-[11px] text-cc-muted mt-0.5">Automatically allow read-only tools and benign commands</p>
                      </div>
                      <span className={`text-xs font-medium ${aiValidationAutoApprove ? "text-cc-success" : "text-cc-muted"}`}>
                        {aiValidationAutoApprove ? "On" : "Off"}
                      </span>
                    </button>

                    <button
                      type="button"
                      onClick={() => toggleAiValidation("aiValidationAutoDeny")}
                      className="w-full flex items-center justify-between px-3 py-3 min-h-[44px] rounded-lg bg-cc-hover hover:bg-cc-active text-cc-fg transition-colors cursor-pointer"
                    >
                      <div>
                        <span className="text-sm">Auto-deny dangerous tools</span>
                        <p className="text-[11px] text-cc-muted mt-0.5">Automatically block destructive commands like rm -rf</p>
                      </div>
                      <span className={`text-xs font-medium ${aiValidationAutoDeny ? "text-cc-success" : "text-cc-muted"}`}>
                        {aiValidationAutoDeny ? "On" : "Off"}
                      </span>
                    </button>
                  </>
                )}
              </div>
            </section>

            {/* Telemetry */}
            <section id="telemetry" ref={setSectionRef("telemetry")}>
              <h2 className="text-sm font-semibold text-cc-fg mb-4">Telemetry</h2>
              <div className="space-y-3">
                <p className="text-xs text-cc-muted">
                  Anonymous product analytics and crash reports via PostHog to improve reliability.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    const next = !telemetryEnabled;
                    setTelemetryPreferenceEnabled(next);
                    setTelemetryEnabled(next);
                  }}
                  className="w-full flex items-center justify-between px-3 py-3 min-h-[44px] rounded-lg text-sm bg-cc-hover text-cc-fg hover:bg-cc-active transition-colors cursor-pointer"
                >
                  <span>Usage analytics and errors</span>
                  <span className="text-xs text-cc-muted">{telemetryEnabled ? "On" : "Off"}</span>
                </button>
                <p className="text-xs text-cc-muted">
                  Browser Do Not Track is respected automatically.
                </p>
              </div>
            </section>

            {/* Environments */}
            <section id="environments" ref={setSectionRef("environments")}>
              <h2 className="text-sm font-semibold text-cc-fg mb-4">Environments</h2>
              <div className="space-y-3">
                <p className="text-xs text-cc-muted">
                  Manage reusable environment profiles used when creating sessions.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    window.location.hash = "#/environments";
                  }}
                  className="px-3 py-2 min-h-[44px] rounded-lg text-sm font-medium bg-cc-primary hover:bg-cc-primary-hover text-white transition-colors cursor-pointer"
                >
                  Open Environments Page
                </button>
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
