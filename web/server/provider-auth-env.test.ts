import { describe, it, expect } from "vitest";
import {
  CLAUDE_AUTH_ENV_VARS,
  hasNonEmptyEnvVar,
  hasAnyClaudeAuthEnv,
  reconcileProviderAuthForRelaunch,
  effectiveSessionAuthMethod,
} from "./provider-auth-env.js";

describe("hasNonEmptyEnvVar", () => {
  it("returns true only for present, non-blank string values", () => {
    expect(hasNonEmptyEnvVar({ K: "v" }, "K")).toBe(true);
    expect(hasNonEmptyEnvVar({ K: "  " }, "K")).toBe(false);
    expect(hasNonEmptyEnvVar({ K: "" }, "K")).toBe(false);
    expect(hasNonEmptyEnvVar({ K: undefined }, "K")).toBe(false);
    expect(hasNonEmptyEnvVar({}, "K")).toBe(false);
    expect(hasNonEmptyEnvVar(undefined, "K")).toBe(false);
  });
});

describe("hasAnyClaudeAuthEnv", () => {
  it("detects any non-empty Claude auth var", () => {
    expect(hasAnyClaudeAuthEnv({ ANTHROPIC_API_KEY: "k" })).toBe(true);
    expect(hasAnyClaudeAuthEnv({ CLAUDE_CODE_OAUTH_TOKEN: "t" })).toBe(true);
    expect(hasAnyClaudeAuthEnv({ ANTHROPIC_API_KEY: "" })).toBe(false);
    expect(hasAnyClaudeAuthEnv({ UNRELATED: "x" })).toBe(false);
    expect(hasAnyClaudeAuthEnv(undefined)).toBe(false);
  });

  it("covers every var in the canonical list", () => {
    for (const key of CLAUDE_AUTH_ENV_VARS) {
      expect(hasAnyClaudeAuthEnv({ [key]: "value" })).toBe(true);
    }
  });
});

describe("reconcileProviderAuthForRelaunch — claude (global authoritative)", () => {
  it("injects OAuth token and clears every other auth var (precedence-trap fix #1)", () => {
    const result = reconcileProviderAuthForRelaunch(
      { ANTHROPIC_API_KEY: "stale-key", ANTHROPIC_AUTH_TOKEN: "stale-2" },
      "claude",
      { claudeCodeOAuthToken: "fresh-oauth" },
    );
    expect(result?.CLAUDE_CODE_OAUTH_TOKEN).toBe("fresh-oauth");
    // The stale key that would otherwise SHADOW the OAuth token is cleared.
    expect(result?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(result?.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(result?.CLAUDE_CODE_AUTH_TOKEN).toBeUndefined();
  });

  it("falls back to ANTHROPIC_API_KEY when no OAuth token is configured", () => {
    const result = reconcileProviderAuthForRelaunch(
      {},
      "claude",
      { anthropicApiKey: "sk-ant-fallback" },
    );
    expect(result?.ANTHROPIC_API_KEY).toBe("sk-ant-fallback");
    expect(result?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it("prefers OAuth over API key when both are configured", () => {
    const result = reconcileProviderAuthForRelaunch(
      {},
      "claude",
      { claudeCodeOAuthToken: "oauth", anthropicApiKey: "key" },
    );
    expect(result?.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth");
    expect(result?.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("clears ALL auth vars (incl. OAuth, symmetric per Hunt F2) when global has no Claude credential", () => {
    const result = reconcileProviderAuthForRelaunch(
      { ANTHROPIC_API_KEY: "stale-key", CLAUDE_CODE_OAUTH_TOKEN: "stale-tok" },
      "claude",
      {},
    );
    // Explicit `undefined` (not delete) so the spawn-env merge drops inherited
    // process.env values too (#7).
    for (const key of CLAUDE_AUTH_ENV_VARS) {
      expect(result).toHaveProperty(key);
      expect(result?.[key]).toBeUndefined();
    }
  });

  it("preserves non-auth env vars untouched", () => {
    const result = reconcileProviderAuthForRelaunch(
      { MY_CUSTOM_VAR: "keep-me", ANTHROPIC_API_KEY: "stale" },
      "claude",
      { claudeCodeOAuthToken: "oauth" },
    );
    expect(result?.MY_CUSTOM_VAR).toBe("keep-me");
  });
});

describe("reconcileProviderAuthForRelaunch — codex (inject-if-absent)", () => {
  it("injects OPENAI_API_KEY when absent", () => {
    const result = reconcileProviderAuthForRelaunch(
      {},
      "codex",
      { openaiApiKey: "sk-openai" },
    );
    expect(result?.OPENAI_API_KEY).toBe("sk-openai");
  });

  it("does NOT overwrite an explicit env-profile OPENAI_API_KEY (precedence-skip #10b)", () => {
    const result = reconcileProviderAuthForRelaunch(
      { OPENAI_API_KEY: "profile-key" },
      "codex",
      { openaiApiKey: "global-key" },
    );
    expect(result?.OPENAI_API_KEY).toBe("profile-key");
  });

  it("does not touch Claude auth vars on the codex path", () => {
    const result = reconcileProviderAuthForRelaunch(
      { ANTHROPIC_API_KEY: "untouched" },
      "codex",
      { openaiApiKey: "sk-openai" },
    );
    expect(result?.ANTHROPIC_API_KEY).toBe("untouched");
  });
});

describe("reconcileProviderAuthForRelaunch — edge cases", () => {
  it("returns undefined when there is nothing to spawn with", () => {
    expect(reconcileProviderAuthForRelaunch(undefined, undefined, {})).toBeUndefined();
  });

  it("leaves env untouched for an unknown backend type", () => {
    const result = reconcileProviderAuthForRelaunch(
      { ANTHROPIC_API_KEY: "k" },
      undefined,
      { claudeCodeOAuthToken: "oauth" },
    );
    expect(result?.ANTHROPIC_API_KEY).toBe("k");
    expect(result?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });
});

/**
 * effectiveSessionAuthMethod (phase 2 task 7, D5, spec S2-AC4): which
 * credentials a session of this provider really uses, by the CLI's proven
 * precedence. Pinned:
 * - Claude: a service env var or an Aura-settings token/key overrides the
 *   sign-in → reported with its NAME and place (never its value);
 * - Codex 0.162.1: a stored ChatGPT sign-in wins over OPENAI_API_KEY (proven in
 *   phase 1, #459) → `sign_in`, with the ignored key only noted (`alsoSet`);
 * - when nothing overrides, the sign-in is what sessions use.
 * If a CLI release changes this precedence, these cases must go red.
 */
describe("effectiveSessionAuthMethod", () => {
  const noSettings = { claudeCodeOAuthToken: "", anthropicApiKey: "", openaiApiKey: "" };
  const SECRET = "SYNTH-CANARY-effective-method";

  it("claude: nothing set → the stored sign-in", () => {
    expect(effectiveSessionAuthMethod("claude", noSettings, {}, null)).toEqual({ method: "subscription", source: "sign_in" });
  });

  it("claude: a service env token overrides the sign-in — named, value never returned", () => {
    const result = effectiveSessionAuthMethod("claude", noSettings, { CLAUDE_CODE_OAUTH_TOKEN: SECRET }, null);
    expect(result).toEqual({ method: "env_token", source: "environment", variable: "CLAUDE_CODE_OAUTH_TOKEN" });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("claude: ANTHROPIC_API_KEY in the env → api_key from the environment", () => {
    expect(effectiveSessionAuthMethod("claude", noSettings, { ANTHROPIC_API_KEY: SECRET }, null))
      .toEqual({ method: "api_key", source: "environment", variable: "ANTHROPIC_API_KEY" });
  });

  it("claude: settings token, then settings key, override the sign-in (env first)", () => {
    expect(effectiveSessionAuthMethod("claude", { ...noSettings, claudeCodeOAuthToken: SECRET }, {}, null))
      .toEqual({ method: "env_token", source: "settings", variable: "CLAUDE_CODE_OAUTH_TOKEN" });
    expect(effectiveSessionAuthMethod("claude", { ...noSettings, anthropicApiKey: SECRET }, {}, null))
      .toEqual({ method: "api_key", source: "settings", variable: "ANTHROPIC_API_KEY" });
    expect(effectiveSessionAuthMethod("claude", { ...noSettings, anthropicApiKey: SECRET }, { ANTHROPIC_AUTH_TOKEN: SECRET }, null).source)
      .toBe("environment");
  });

  it("codex: ChatGPT sign-in + settings key → uses the sign-in; the key is only noted", () => {
    const result = effectiveSessionAuthMethod("codex", { ...noSettings, openaiApiKey: SECRET }, {}, "chatgpt");
    expect(result).toEqual({ method: "subscription", source: "sign_in", alsoSet: { source: "settings", variable: "OPENAI_API_KEY" } });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("codex: ChatGPT sign-in + env key → uses the sign-in; the env key is noted", () => {
    expect(effectiveSessionAuthMethod("codex", noSettings, { OPENAI_API_KEY: SECRET }, "chatgpt"))
      .toEqual({ method: "subscription", source: "sign_in", alsoSet: { source: "environment", variable: "OPENAI_API_KEY" } });
  });

  it("codex: no ChatGPT sign-in → env key, then settings key, are what sessions use", () => {
    expect(effectiveSessionAuthMethod("codex", { ...noSettings, openaiApiKey: SECRET }, { CODEX_API_KEY: SECRET }, null))
      .toEqual({ method: "api_key", source: "environment", variable: "CODEX_API_KEY" });
    expect(effectiveSessionAuthMethod("codex", { ...noSettings, openaiApiKey: SECRET }, {}, null))
      .toEqual({ method: "api_key", source: "settings", variable: "OPENAI_API_KEY" });
  });

  it("codex: an API-key auth.json is the stored sign-in, with the api_key method", () => {
    expect(effectiveSessionAuthMethod("codex", noSettings, {}, "api_key")).toEqual({ method: "api_key", source: "sign_in" });
    expect(effectiveSessionAuthMethod("codex", noSettings, {}, null)).toEqual({ method: "subscription", source: "sign_in" });
  });
});
