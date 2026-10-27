import { DEFAULT_KB_ANALYSIS_SETTINGS, normalizeKbAnalysisSettings, type KbAnalysisSettings } from "./diagnostics/kb-analysis-settings.js";
import {
  readFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { COMPANION_HOME } from "./paths.js";
import { tightenFileMode, writeAtomicJson } from "./atomic-write.js";
import {
  type SecondReviewerConfig,
  DEFAULT_SECOND_REVIEWER_CONFIG,
  normalizeSecondReviewerConfig,
} from "./second-reviewer-config.js";

export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";

export type UpdateChannel = "stable" | "prerelease";

/**
 * Default mode for a NEW session created from the UI.
 *  - `solo`    — one agent (the default since aura-diet: AuraBench measured the
 *                observer at +0pp for 2.4x cost and full council at −6pp for 2.9x).
 *  - `council` — the create-session Council toggle starts ON. The REST API is
 *                unaffected: a pair is only ever created on an explicit
 *                `councilMode: "council"` in the request body.
 */
export type DefaultSessionMode = "solo" | "council";

export interface CompanionSettings {
  anthropicApiKey: string;
  anthropicModel: string;
  /** OAuth token obtained via `claude setup-token` — injected as CLAUDE_CODE_OAUTH_TOKEN */
  claudeCodeOAuthToken: string;
  /** OpenAI API key for Codex — injected as OPENAI_API_KEY */
  openaiApiKey: string;
  /** Whether the onboarding wizard has been completed */
  onboardingCompleted: boolean;
  linearApiKey: string;
  linearAutoTransition: boolean;
  linearAutoTransitionStateId: string;
  linearAutoTransitionStateName: string;
  linearArchiveTransition: boolean;
  linearArchiveTransitionStateId: string;
  linearArchiveTransitionStateName: string;
  /** @deprecated Used only as staging during wizard flow. Per-agent credentials are in AgentConfig.triggers.linear. */
  linearOAuthClientId: string;
  /** @deprecated Used only as staging during wizard flow. Per-agent credentials are in AgentConfig.triggers.linear. */
  linearOAuthClientSecret: string;
  /** @deprecated Used only as staging during wizard flow. Per-agent credentials are in AgentConfig.triggers.linear. */
  linearOAuthWebhookSecret: string;
  /** @deprecated Used only as staging during wizard flow. Per-agent credentials are in AgentConfig.triggers.linear. */
  linearOAuthAccessToken: string;
  /** @deprecated Used only as staging during wizard flow. Per-agent credentials are in AgentConfig.triggers.linear. */
  linearOAuthRefreshToken: string;
  aiValidationEnabled: boolean;
  aiValidationAutoApprove: boolean;
  aiValidationAutoDeny: boolean;
  publicUrl: string;
  updateChannel: UpdateChannel;
  dockerAutoUpdate: boolean;
  /** Opt-in: send an anonymous 30-day heartbeat to the global usage counter. Default off. */
  telemetryEnabled: boolean;
  /** UI default for new sessions. Default `solo` — see {@link DefaultSessionMode}. */
  defaultSessionMode: DefaultSessionMode;
  /**
   * Opt-in: append a "consult the knowledge base at session start" directive to
   * new sessions' system prompt (Claude `--append-system-prompt` / Codex
   * `developerInstructions`). Default off — the KB is consulted on demand.
   */
  kbAutoPrime: boolean;
  /**
   * Expose the shipped UI/UX toolkit (`packs/skills`) to new sessions — the
   * default of the `uiux` layer flag. Default on; applies to new sessions only.
   */
  uiuxToolkit: boolean;
  /**
   * When a session stops on a usage limit (Claude session/weekly limit,
   * Codex usage limit), automatically send a continuation prompt shortly
   * after the limit resets. Default ON. See `auto-resume-scheduler.ts`.
   */
  autoResumeAfterLimit: boolean;
  /**
   * W15 multi-model review: global default for the Council "second opinion"
   * reviewer (another backend/model reviewing each in-scope checkpoint next to
   * the observer). A pair's own setting (`.council/state/<group>-second-reviewer.json`)
   * wins. Default off. See `second-reviewer-config.ts`.
   */
  councilSecondReviewer: SecondReviewerConfig;
  /** Accumulation thresholds for the background KB analyzer (diagnostics spec §3.2). */
  kbAnalysis: KbAnalysisSettings;
  /** Report-only memory analysis on the Diagnostics page. Default off; manual runs only. */
  diagnosticsMemoryReport: boolean;
  updatedAt: number;
}

const DEFAULT_PATH = join(COMPANION_HOME, "settings.json");

let loaded = false;
let filePath = DEFAULT_PATH;
let settings: CompanionSettings = {
  anthropicApiKey: "",
  anthropicModel: DEFAULT_ANTHROPIC_MODEL,
  claudeCodeOAuthToken: "",
  openaiApiKey: "",
  onboardingCompleted: false,
  linearApiKey: "",
  linearAutoTransition: false,
  linearAutoTransitionStateId: "",
  linearAutoTransitionStateName: "",
  linearArchiveTransition: false,
  linearArchiveTransitionStateId: "",
  linearArchiveTransitionStateName: "",
  linearOAuthClientId: "",
  linearOAuthClientSecret: "",
  linearOAuthWebhookSecret: "",
  linearOAuthAccessToken: "",
  linearOAuthRefreshToken: "",
  aiValidationEnabled: false,
  aiValidationAutoApprove: true,
  aiValidationAutoDeny: false,
  publicUrl: "",
  updateChannel: "stable",
  dockerAutoUpdate: false,
  telemetryEnabled: true,
  defaultSessionMode: "solo",
  kbAutoPrime: false,
  uiuxToolkit: true,
  autoResumeAfterLimit: true,
  councilSecondReviewer: { ...DEFAULT_SECOND_REVIEWER_CONFIG },
  kbAnalysis: { ...DEFAULT_KB_ANALYSIS_SETTINGS },
  diagnosticsMemoryReport: false,
  updatedAt: 0,
};

function normalize(raw: Partial<CompanionSettings> | null | undefined): CompanionSettings {
  return {
    anthropicApiKey: typeof raw?.anthropicApiKey === "string" ? raw.anthropicApiKey : "",
    anthropicModel:
      typeof raw?.anthropicModel === "string" && raw.anthropicModel.trim()
        ? raw.anthropicModel === "claude-sonnet-4.6" ? DEFAULT_ANTHROPIC_MODEL : raw.anthropicModel
        : DEFAULT_ANTHROPIC_MODEL,
    claudeCodeOAuthToken: typeof raw?.claudeCodeOAuthToken === "string" ? raw.claudeCodeOAuthToken : "",
    openaiApiKey: typeof raw?.openaiApiKey === "string" ? raw.openaiApiKey : "",
    onboardingCompleted: typeof raw?.onboardingCompleted === "boolean" ? raw.onboardingCompleted : false,
    linearApiKey: typeof raw?.linearApiKey === "string" ? raw.linearApiKey : "",
    linearAutoTransition: typeof raw?.linearAutoTransition === "boolean" ? raw.linearAutoTransition : false,
    linearAutoTransitionStateId: typeof raw?.linearAutoTransitionStateId === "string" ? raw.linearAutoTransitionStateId : "",
    linearAutoTransitionStateName: typeof raw?.linearAutoTransitionStateName === "string" ? raw.linearAutoTransitionStateName : "",
    linearArchiveTransition: typeof raw?.linearArchiveTransition === "boolean" ? raw.linearArchiveTransition : false,
    linearArchiveTransitionStateId: typeof raw?.linearArchiveTransitionStateId === "string" ? raw.linearArchiveTransitionStateId : "",
    linearArchiveTransitionStateName: typeof raw?.linearArchiveTransitionStateName === "string" ? raw.linearArchiveTransitionStateName : "",
    linearOAuthClientId: typeof raw?.linearOAuthClientId === "string" ? raw.linearOAuthClientId : "",
    linearOAuthClientSecret: typeof raw?.linearOAuthClientSecret === "string" ? raw.linearOAuthClientSecret : "",
    linearOAuthWebhookSecret: typeof raw?.linearOAuthWebhookSecret === "string" ? raw.linearOAuthWebhookSecret : "",
    linearOAuthAccessToken: typeof raw?.linearOAuthAccessToken === "string" ? raw.linearOAuthAccessToken : "",
    linearOAuthRefreshToken: typeof raw?.linearOAuthRefreshToken === "string" ? raw.linearOAuthRefreshToken : "",
    aiValidationEnabled: typeof raw?.aiValidationEnabled === "boolean" ? raw.aiValidationEnabled : false,
    aiValidationAutoApprove: typeof raw?.aiValidationAutoApprove === "boolean" ? raw.aiValidationAutoApprove : true,
    aiValidationAutoDeny: typeof raw?.aiValidationAutoDeny === "boolean" ? raw.aiValidationAutoDeny : false,
    publicUrl: typeof raw?.publicUrl === "string" ? raw.publicUrl.trim().replace(/\/+$/, "") : "",
    updateChannel: raw?.updateChannel === "prerelease" ? "prerelease" : "stable",
    dockerAutoUpdate: typeof raw?.dockerAutoUpdate === "boolean" ? raw.dockerAutoUpdate : false,
    telemetryEnabled: typeof raw?.telemetryEnabled === "boolean" ? raw.telemetryEnabled : true,
    defaultSessionMode: raw?.defaultSessionMode === "council" ? "council" : "solo",
    kbAutoPrime: typeof raw?.kbAutoPrime === "boolean" ? raw.kbAutoPrime : false,
    uiuxToolkit: typeof raw?.uiuxToolkit === "boolean" ? raw.uiuxToolkit : true,
    autoResumeAfterLimit: typeof raw?.autoResumeAfterLimit === "boolean" ? raw.autoResumeAfterLimit : true,
    councilSecondReviewer: normalizeSecondReviewerConfig(raw?.councilSecondReviewer),
    kbAnalysis: normalizeKbAnalysisSettings(raw?.kbAnalysis),
    diagnosticsMemoryReport: raw?.diagnosticsMemoryReport === true,
    updatedAt: typeof raw?.updatedAt === "number" ? raw.updatedAt : 0,
  };
}

function ensureLoaded(): void {
  if (loaded) return;
  try {
    if (existsSync(filePath)) {
      tightenFileMode(filePath);
      const raw = readFileSync(filePath, "utf-8");
      settings = normalize(JSON.parse(raw) as Partial<CompanionSettings>);
    }
  } catch {
    settings = normalize(null);
  }
  loaded = true;
}

// Secrets live in this file (API keys / OAuth tokens) — write them 0o600 via the atomic helper
// (a rename also re-tightens a file that predates this, unlike writeFileSync's mode).
function persist(): void {
  writeAtomicJson(filePath, settings, { maxBytes: Number.POSITIVE_INFINITY, space: 2 });
}

export function getSettings(): CompanionSettings {
  ensureLoaded();
  return { ...settings };
}

export function updateSettings(
  patch: Partial<Pick<CompanionSettings, "anthropicApiKey" | "anthropicModel" | "claudeCodeOAuthToken" | "openaiApiKey" | "onboardingCompleted" | "linearApiKey" | "linearAutoTransition" | "linearAutoTransitionStateId" | "linearAutoTransitionStateName" | "linearArchiveTransition" | "linearArchiveTransitionStateId" | "linearArchiveTransitionStateName" | "linearOAuthClientId" | "linearOAuthClientSecret" | "linearOAuthWebhookSecret" | "linearOAuthAccessToken" | "linearOAuthRefreshToken" | "aiValidationEnabled" | "aiValidationAutoApprove" | "aiValidationAutoDeny" | "publicUrl" | "updateChannel" | "dockerAutoUpdate" | "telemetryEnabled" | "defaultSessionMode" | "kbAutoPrime" | "uiuxToolkit" | "autoResumeAfterLimit" | "councilSecondReviewer" | "kbAnalysis" | "diagnosticsMemoryReport">>,
): CompanionSettings {
  ensureLoaded();
  settings = normalize({
    anthropicApiKey: patch.anthropicApiKey ?? settings.anthropicApiKey,
    anthropicModel: patch.anthropicModel ?? settings.anthropicModel,
    claudeCodeOAuthToken: patch.claudeCodeOAuthToken ?? settings.claudeCodeOAuthToken,
    openaiApiKey: patch.openaiApiKey ?? settings.openaiApiKey,
    onboardingCompleted: patch.onboardingCompleted ?? settings.onboardingCompleted,
    linearApiKey: patch.linearApiKey ?? settings.linearApiKey,
    linearAutoTransition: patch.linearAutoTransition ?? settings.linearAutoTransition,
    linearAutoTransitionStateId: patch.linearAutoTransitionStateId ?? settings.linearAutoTransitionStateId,
    linearAutoTransitionStateName: patch.linearAutoTransitionStateName ?? settings.linearAutoTransitionStateName,
    linearArchiveTransition: patch.linearArchiveTransition ?? settings.linearArchiveTransition,
    linearArchiveTransitionStateId: patch.linearArchiveTransitionStateId ?? settings.linearArchiveTransitionStateId,
    linearArchiveTransitionStateName: patch.linearArchiveTransitionStateName ?? settings.linearArchiveTransitionStateName,
    linearOAuthClientId: patch.linearOAuthClientId ?? settings.linearOAuthClientId,
    linearOAuthClientSecret: patch.linearOAuthClientSecret ?? settings.linearOAuthClientSecret,
    linearOAuthWebhookSecret: patch.linearOAuthWebhookSecret ?? settings.linearOAuthWebhookSecret,
    linearOAuthAccessToken: patch.linearOAuthAccessToken ?? settings.linearOAuthAccessToken,
    linearOAuthRefreshToken: patch.linearOAuthRefreshToken ?? settings.linearOAuthRefreshToken,
    aiValidationEnabled: patch.aiValidationEnabled ?? settings.aiValidationEnabled,
    aiValidationAutoApprove: patch.aiValidationAutoApprove ?? settings.aiValidationAutoApprove,
    aiValidationAutoDeny: patch.aiValidationAutoDeny ?? settings.aiValidationAutoDeny,
    publicUrl: patch.publicUrl ?? settings.publicUrl,
    updateChannel: patch.updateChannel ?? settings.updateChannel,
    dockerAutoUpdate: patch.dockerAutoUpdate ?? settings.dockerAutoUpdate,
    telemetryEnabled: patch.telemetryEnabled ?? settings.telemetryEnabled,
    defaultSessionMode: patch.defaultSessionMode ?? settings.defaultSessionMode,
    kbAutoPrime: patch.kbAutoPrime ?? settings.kbAutoPrime,
    uiuxToolkit: patch.uiuxToolkit ?? settings.uiuxToolkit,
    autoResumeAfterLimit: patch.autoResumeAfterLimit ?? settings.autoResumeAfterLimit,
    councilSecondReviewer: patch.councilSecondReviewer ?? settings.councilSecondReviewer,
    kbAnalysis: patch.kbAnalysis ?? settings.kbAnalysis,
    diagnosticsMemoryReport: patch.diagnosticsMemoryReport ?? settings.diagnosticsMemoryReport,
    updatedAt: Date.now(),
  });
  persist();
  return { ...settings };
}

export function _resetForTest(customPath?: string): void {
  loaded = false;
  filePath = customPath || DEFAULT_PATH;
  settings = normalize(null);
}
