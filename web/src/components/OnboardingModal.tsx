import { useState, useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { api } from "../api.js";
import type { ProviderAuthStatus, ProviderId } from "../../server/auth-status/auth-types.js";
import { describeAuthState } from "../../server/auth-status/auth-catalog.js";
import { EmbeddedSignIn } from "./llm-login/SignInPanel.js";
import { CopyButton } from "./ui/CopyButton.js";

type Step = "welcome" | "claude" | "codex" | "done";

const STEPS: Step[] = ["welcome", "claude", "codex", "done"];

/** Shared selector for focusable, non-disabled elements (M1 fix) */
/** The current step's heading: names the dialog and takes focus on each step change. */
const STEP_HEADING_ID = "onboarding-step-heading";
const FOCUSABLE_SELECTOR =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

interface OnboardingModalProps {
  onComplete: () => void;
}

/** Check if the user prefers reduced motion */
function prefersReducedMotion(): boolean {
  return typeof window !== "undefined"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function OnboardingModal({ onComplete }: OnboardingModalProps) {
  const [step, setStep] = useState<Step>("welcome");
  const [claudeToken, setClaudeToken] = useState("");
  const [openaiKey, setOpenaiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [statuses, setStatuses] = useState<Partial<Record<ProviderId, ProviderAuthStatus>>>({});
  const [statusLoaded, setStatusLoaded] = useState(false);
  // Set by a credential saved in this wizard (token / API key): the status
  // check cannot vouch for those until a session uses them.
  const [savedOverride, setSavedOverride] = useState<Record<ProviderId, boolean>>({ claude: false, codex: false });
  const [entered, setEntered] = useState(prefersReducedMotion);
  const dialogRef = useRef<HTMLDivElement>(null);

  // What is already signed in on this machine — the wizard starts from it.
  const loadStatus = useCallback(async () => {
    try {
      const r = await api.llmAuthStatus();
      if (r.status) setStatuses(r.status.providers);
    } catch {
      // No status: the steps still offer sign-in.
    } finally {
      setStatusLoaded(true);
    }
  }, []);

  const recheck = useCallback(async () => {
    setStatusLoaded(false);
    try {
      await api.llmAuthRecheck();
    } catch {
      // fall through to a plain read
    }
    await loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    if (!entered) {
      requestAnimationFrame(() => setEntered(true));
    }
  }, [entered]);

  const finishOnboarding = useCallback(async () => {
    try {
      await api.updateSettings({ onboardingCompleted: true });
    } catch {
      // non-fatal
    }
    setStep("done");
  }, []);

  const handleSkipAll = useCallback(async () => {
    await finishOnboarding();
    onComplete();
  }, [finishOnboarding, onComplete]);

  // Focus trap: keep Tab cycling within the dialog. Escape = "set up later"
  // (the sign-in panel inside handles its own Escape first and stops it).
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        void handleSkipAll();
        return;
      }
      if (e.key !== "Tab") return;

      const focusable = dialog!.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      // Focus fell out of the dialog (a control disabled itself while saving
      // → <body>): pull it back instead of letting Tab reach the app behind
      // the overlay (watson P2-8).
      if (!dialog!.contains(document.activeElement)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
        return;
      }

      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleSkipAll]);

  // On every step change focus the step's heading, so a screen reader reads
  // where the user is before any control (watson P2-7); the dialog is named
  // by the same heading.
  useEffect(() => {
    const dialog = dialogRef.current;
    const heading = dialog?.querySelector<HTMLElement>(`#${STEP_HEADING_ID}`);
    (heading ?? dialog?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR))?.focus();
  }, [step]);

  const handleSaveClaude = useCallback(async () => {
    if (!claudeToken.trim()) return;
    setSaving(true);
    setError("");
    try {
      await api.updateSettings({ claudeCodeOAuthToken: claudeToken.trim() });
      setSavedOverride((o) => ({ ...o, claude: true }));
      setStep("codex");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save token");
    } finally {
      setSaving(false);
    }
  }, [claudeToken]);

  const handleSaveCodexApiKey = useCallback(async () => {
    if (!openaiKey.trim()) return;
    setSaving(true);
    setError("");
    try {
      await api.updateSettings({ openaiApiKey: openaiKey.trim() });
      setSavedOverride((o) => ({ ...o, codex: true }));
      await finishOnboarding();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save API key");
    } finally {
      setSaving(false);
    }
  }, [openaiKey, finishOnboarding]);

  const handleSignedIn = useCallback((provider: ProviderId, s: ProviderAuthStatus | null) => {
    if (s) setStatuses((prev) => ({ ...prev, [provider]: s }));
    else void loadStatus();
  }, [loadStatus]);

  const handleDone = useCallback(() => {
    onComplete();
  }, [onComplete]);

  // Clear shared error state when navigating between steps
  const goToStep = useCallback((s: Step) => {
    setError("");
    setStep(s);
  }, []);

  const ready = (p: ProviderId) => statuses[p]?.state === "working" || savedOverride[p];

  const stepIndex = STEPS.indexOf(step);
  const skipMotion = prefersReducedMotion();

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{
        // Plain page ground, short fade: the first screen speaks the same calm
        // language as the sign-in window and Diagnostics (saarinen S-6).
        background: "var(--color-cc-bg)",
        opacity: entered ? 1 : 0,
        transition: skipMotion ? "none" : "opacity 200ms ease-out",
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={STEP_HEADING_ID}
        className="w-full max-w-[520px] mx-6"
        style={{
          transform: entered ? "translateY(0)" : "translateY(12px)",
          opacity: entered ? 1 : 0,
          transition: skipMotion
            ? "none"
            : "transform 250ms cubic-bezier(0.16, 1, 0.3, 1), opacity 200ms ease-out",
        }}
      >
        {/* Step indicator */}
        {step !== "done" && (
          <div
            className="flex items-center gap-1.5 mb-6 justify-center"
            role="status"
          >
            {/* Live regions announce content, not aria-label (watson P2-7). */}
            <span className="sr-only">{`Step ${stepIndex + 1} of ${STEPS.length - 1}`}</span>
            {STEPS.slice(0, 3).map((s, i) => (
              <div
                key={s}
                className="h-[3px] rounded-full transition-[transform,background,opacity] duration-300"
                style={{
                  width: 32,
                  transform: i === stepIndex ? "scaleX(1)" : "scaleX(0.375)",
                  transformOrigin: "center",
                  background: i <= stepIndex
                    ? "var(--color-cc-primary)"
                    : "var(--color-cc-border)",
                  opacity: i <= stepIndex ? 1 : 0.5,
                }}
              />
            ))}
          </div>
        )}

        {/* Content card */}
        <div
          className="bg-cc-elevated border border-cc-border overflow-hidden rounded-xl shadow-lg"
        >
          {step === "welcome" && (
            <WelcomeStep
              claudeReady={ready("claude")}
              codexReady={ready("codex")}
              statusLoaded={statusLoaded}
              onSetupClaude={() => goToStep("claude")}
              onSetupCodex={() => goToStep("codex")}
            />
          )}
          {step === "claude" && (
            <ProviderSetupStep
              provider="claude"
              status={statuses.claude ?? null}
              statusLoaded={statusLoaded}
              advancedValue={claudeToken}
              onAdvancedChange={setClaudeToken}
              onSaveAdvanced={handleSaveClaude}
              onSignedIn={(s) => handleSignedIn("claude", s)}
              onRecheck={() => void recheck()}
              onContinue={() => goToStep("codex")}
              onSkip={() => goToStep("codex")}
              saving={saving}
              error={error}
            />
          )}
          {step === "codex" && (
            <ProviderSetupStep
              provider="codex"
              status={statuses.codex ?? null}
              statusLoaded={statusLoaded}
              advancedValue={openaiKey}
              onAdvancedChange={setOpenaiKey}
              onSaveAdvanced={handleSaveCodexApiKey}
              onSignedIn={(s) => handleSignedIn("codex", s)}
              onRecheck={() => void recheck()}
              onContinue={() => void finishOnboarding()}
              onSkip={() => void finishOnboarding()}
              onBack={() => goToStep("claude")}
              saving={saving}
              error={error}
            />
          )}
          {step === "done" && (
            <DoneStep
              claudeConfigured={ready("claude")}
              codexConfigured={ready("codex")}
              onDone={handleDone}
            />
          )}
        </div>

        {/* Skip link — outside card, feels less important */}
        {step === "welcome" && (
          <button
            type="button"
            onClick={handleSkipAll}
            className="w-full text-center text-xs text-cc-muted hover:text-cc-fg transition-colors mt-4 min-h-[44px] flex items-center justify-center"
          >
            Skip setup — I'll configure this later in Settings
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
}

/* ── Welcome ──────────────────────────────────────────────────────────────── */

function ReadyBadge({ ready, loaded }: { ready: boolean; loaded: boolean }) {
  if (!loaded) return null;
  return ready ? (
    <span className="text-[11px] font-medium text-cc-success">Signed in</span>
  ) : (
    <span className="text-[11px] text-cc-muted">Not signed in</span>
  );
}

function WelcomeStep({
  claudeReady,
  codexReady,
  statusLoaded,
  onSetupClaude,
  onSetupCodex,
}: {
  claudeReady: boolean;
  codexReady: boolean;
  statusLoaded: boolean;
  onSetupClaude: () => void;
  onSetupCodex: () => void;
}) {
  return (
    <div className="p-7 pb-6">
      {/* Header */}
      <div className="mb-6">
        <div className="text-[10px] uppercase tracking-[0.12em] text-cc-muted font-medium mb-2">
          First time setup
        </div>
        <h2 id={STEP_HEADING_ID} tabIndex={-1} className="text-xl font-semibold text-cc-fg leading-tight outline-none">
          Welcome to Aura Companion
        </h2>
        <p className="text-sm text-cc-muted mt-1.5 leading-relaxed">
          Sign in to at least one coding agent — Claude Code or Codex. Everything happens here in the browser; no terminal needed.
        </p>
      </div>

      {/* Provider cards */}
      <div className="space-y-2.5">
        <button
          type="button"
          onClick={onSetupClaude}
          className="provider-card--claude group w-full flex items-center gap-3.5 p-3.5 min-h-[52px] rounded-xl border border-cc-border bg-cc-bg text-left transition-[transform,border-color,box-shadow] duration-150"
        >
          <div
            className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 font-semibold text-sm bg-cc-primary/10 text-cc-primary"
          >
            C
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-medium text-cc-fg">Claude Code</div>
            <div className="text-[11px] text-cc-muted leading-snug mt-0.5">Anthropic's coding agent — sign in with your Claude account</div>
          </div>
          <ReadyBadge ready={claudeReady} loaded={statusLoaded} />
          <svg
            className="w-4 h-4 text-cc-muted flex-shrink-0 transition-transform duration-150 group-hover:translate-x-0.5"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        </button>

        <button
          type="button"
          onClick={onSetupCodex}
          className="provider-card--codex group w-full flex items-center gap-3.5 p-3.5 min-h-[52px] rounded-xl border border-cc-border bg-cc-bg text-left transition-[transform,border-color,box-shadow] duration-150"
        >
          <div
            className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 font-semibold text-sm bg-cc-codex/10 text-cc-codex"
          >
            X
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-medium text-cc-fg">Codex</div>
            <div className="text-[11px] text-cc-muted leading-snug mt-0.5">OpenAI's coding agent — sign in with your ChatGPT account</div>
          </div>
          <ReadyBadge ready={codexReady} loaded={statusLoaded} />
          <svg
            className="w-4 h-4 text-cc-muted flex-shrink-0 transition-transform duration-150 group-hover:translate-x-0.5"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>
    </div>
  );
}

/* ── Provider step (Claude / Codex) ───────────────────────────────────────── */

/** Install command when the provider's CLI is not on the server's PATH. */
export const CLI_INSTALL_COMMAND: Record<ProviderId, string> = {
  claude: "npm install -g @anthropic-ai/claude-code",
  codex: "npm install -g @openai/codex",
};

/** Wizard wording: the product names the welcome step uses. */
const PROVIDER_NAME: Record<ProviderId, string> = { claude: "Claude Code", codex: "Codex" };

const PROVIDER_PITCH: Record<ProviderId, string> = {
  claude: "Sign in with your Claude account (Pro, Max, Team or Enterprise). A sign-in link opens in a new tab; paste the code it shows back here.",
  codex: "Sign in with your ChatGPT account. A sign-in link opens in a new tab; enter the one-time code it shows there.",
};

function ProviderSetupStep({
  provider,
  status,
  statusLoaded,
  advancedValue,
  onAdvancedChange,
  onSaveAdvanced,
  onSignedIn,
  onRecheck,
  onContinue,
  onSkip,
  onBack,
  saving,
  error,
}: {
  provider: ProviderId;
  status: ProviderAuthStatus | null;
  statusLoaded: boolean;
  advancedValue: string;
  onAdvancedChange: (v: string) => void;
  onSaveAdvanced: () => void;
  onSignedIn: (status: ProviderAuthStatus | null) => void;
  onRecheck: () => void;
  onContinue: () => void;
  onSkip: () => void;
  onBack?: () => void;
  saving: boolean;
  error: string;
}) {
  const [signingIn, setSigningIn] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const name = PROVIDER_NAME[provider];
  const errorId = `${provider}-setup-error`;
  const inputId = `${provider}-advanced-credential`;
  const signedIn = status?.state === "working";
  const cliMissing = status?.state === "not_verified" && status.reason === "cli_missing";
  const describe = status ? describeAuthState(status.state, provider, status.reason) : null;
  const isCodex = provider === "codex";

  return (
    <div className="p-7 pb-6" data-testid={`onboarding-step-${provider}`}>
      <div className="mb-5">
        <h2 id={STEP_HEADING_ID} tabIndex={-1} className="text-xl font-semibold text-cc-fg leading-tight outline-none">Set up {name}</h2>
        <p className="text-sm text-cc-muted mt-1.5 leading-relaxed">{PROVIDER_PITCH[provider]}</p>
      </div>

      {/* Current status — read from the server, never guessed. */}
      <div className="mb-4 rounded-lg border border-cc-border bg-cc-bg px-3.5 py-3" aria-live="polite" data-testid={`onboarding-status-${provider}`}>
        {!statusLoaded ? (
          <p className="text-xs text-cc-muted">Checking {name}…</p>
        ) : signedIn ? (
          <p className="text-sm font-medium text-cc-success">
            {name} is signed in{status && status.account.known ? ` as ${status.account.value}` : ""}.
          </p>
        ) : cliMissing ? (
          <div className="space-y-2">
            <p className="text-sm font-medium text-cc-fg">The {name} CLI is not installed on this machine yet.</p>
            <p className="text-xs text-cc-muted">Install it in a terminal on the machine where Aura runs, then press “Check again”:</p>
            <CommandBlock command={CLI_INSTALL_COMMAND[provider]} />
            <button type="button" onClick={onRecheck} className="text-xs font-medium text-cc-primary underline underline-offset-2 min-h-[44px]">
              Check again
            </button>
          </div>
        ) : (
          <p className="text-xs text-cc-muted">{describe ? describe.title : `${name}: status unknown`}</p>
        )}
      </div>

      {!signedIn && !cliMissing && statusLoaded && (
        <div className="mb-4">
          {signingIn ? (
            <EmbeddedSignIn
              provider={provider}
              onClose={() => setSigningIn(false)}
              onSucceeded={(s) => onSignedIn(s)}
            />
          ) : (
            <button
              type="button"
              onClick={() => setSigningIn(true)}
              className={`${isCodex ? "btn-codex-aa" : "btn-primary-aa"} w-full px-4 py-2.5 min-h-[44px] rounded-lg text-sm font-medium text-white`}
            >
              Sign in to {name}
            </button>
          )}
        </div>
      )}

      {error && (
        <div id={errorId} role="alert" className="flex items-start gap-2 mb-4 text-xs text-cc-error">
          <span>{error}</span>
        </div>
      )}

      {/* Advanced override — a token / API key instead of the account sign-in. */}
      {!signedIn && (
        <div className="mb-4">
          <button
            type="button"
            onClick={() => setShowAdvanced(!showAdvanced)}
            aria-expanded={showAdvanced}
            className="text-xs text-cc-muted hover:text-cc-fg transition-colors flex items-center gap-1 min-h-[44px]"
          >
            Advanced: {isCodex ? "use an OpenAI API key instead" : "paste an OAuth token instead"}
          </button>
          {showAdvanced && (
            <div className="mt-2 space-y-2">
              <p className="text-xs text-cc-muted leading-relaxed">
                {isCodex
                  ? "Pay-as-you-go API billing instead of your ChatGPT plan."
                  : <>For headless setups: run <code className="font-mono-code text-cc-fg">claude setup-token</code> in a terminal and paste the token it prints.</>}
              </p>
              <label htmlFor={inputId} className="text-xs text-cc-muted block">
                {isCodex ? "OpenAI API key" : "Claude OAuth token"}
              </label>
              <input
                id={inputId}
                type="password"
                autoComplete="off"
                value={advancedValue}
                onChange={(e) => onAdvancedChange(e.target.value)}
                placeholder={isCodex ? "sk-..." : "Paste the token…"}
                aria-describedby={error ? errorId : undefined}
                aria-invalid={error ? true : undefined}
                className="w-full px-3 py-2.5 min-h-[44px] text-sm bg-cc-bg rounded-lg border border-cc-border text-cc-fg placeholder:text-cc-muted focus:outline-none focus:ring-1 focus:ring-cc-primary font-mono-code"
              />
              <button
                type="button"
                onClick={onSaveAdvanced}
                disabled={saving || !advancedValue.trim()}
                className="px-4 py-2 min-h-[44px] rounded-lg text-sm font-medium bg-cc-active text-cc-fg hover:bg-cc-hover disabled:opacity-50"
              >
                {saving ? "Saving..." : isCodex ? "Save API key" : "Save token"}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2 pt-1">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="px-3 py-2.5 min-h-[44px] min-w-[44px] rounded-lg text-sm text-cc-muted hover:text-cc-fg transition-colors"
          >
            Back
          </button>
        )}
        <div className="flex-1" />
        {signedIn ? (
          <button
            type="button"
            onClick={onContinue}
            className="btn-primary-aa px-5 py-2.5 min-h-[44px] rounded-lg text-sm font-medium text-white"
          >
            Continue
          </button>
        ) : (
          <button
            type="button"
            onClick={onSkip}
            className="px-4 py-2.5 min-h-[44px] rounded-lg text-sm text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors"
          >
            Skip
          </button>
        )}
      </div>
    </div>
  );
}

function CommandBlock({ command }: { command: string }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border border-cc-border px-3 py-1" style={{ background: "var(--color-cc-code-bg)" }}>
      <code className="text-[12px] font-mono-code text-cc-fg select-all break-all">{command}</code>
      <CopyButton value={command} label="Copy" ariaLabel="Copy command" />
    </div>
  );
}

/* ── Done ─────────────────────────────────────────────────────────────────── */

function DoneStep({
  claudeConfigured,
  codexConfigured,
  onDone,
}: {
  claudeConfigured: boolean;
  codexConfigured: boolean;
  onDone: () => void;
}) {
  const noneConfigured = !claudeConfigured && !codexConfigured;
  const skipMotion = prefersReducedMotion();
  const [visible, setVisible] = useState(skipMotion);

  useEffect(() => {
    if (!visible) {
      requestAnimationFrame(() => setVisible(true));
    }
  }, [visible]);

  return (
    <div
      className="p-7 pb-6 text-center"
      style={{
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0)" : "translateY(8px)",
        transition: skipMotion
          ? "none"
          : "opacity 200ms ease-out, transform 250ms cubic-bezier(0.16, 1, 0.3, 1)",
      }}
    >
      {/* Success icon */}
      <div
        className="w-14 h-14 mx-auto rounded-2xl flex items-center justify-center mb-5"
        style={{
          background: noneConfigured
            ? "var(--color-cc-hover)"
            : "color-mix(in srgb, var(--color-cc-success) 12%, transparent)",
        }}
      >
        {noneConfigured ? (
          <svg className="w-6 h-6 text-cc-muted" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        ) : (
          <svg className="w-6 h-6 text-cc-success" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        )}
      </div>

      <h2 id={STEP_HEADING_ID} tabIndex={-1} className="text-xl font-semibold text-cc-fg mb-2 outline-none">
        {noneConfigured ? "Setup Skipped" : "You're all set!"}
      </h2>

      <div className="text-sm text-cc-muted leading-relaxed mb-6">
        {noneConfigured
          ? "You can configure providers anytime in Settings."
          : (
            <>
              {claudeConfigured && <span className="block">Claude Code is ready.</span>}
              {codexConfigured && <span className="block">Codex is ready.</span>}
              <span className="block mt-1 text-xs">You can update these anytime in Settings.</span>
            </>
          )
        }
      </div>

      <button
        onClick={onDone}
        className="btn-primary-aa w-full px-4 py-2.5 min-h-[44px] rounded-lg text-sm font-medium text-white transition-[background] duration-150"
      >
        Get Started
      </button>
    </div>
  );
}

