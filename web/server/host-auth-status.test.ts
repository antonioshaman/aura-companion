/**
 * Host sign-in detection for the New Session auth badge. All inputs (env,
 * companion settings, "now") are injected, and credential files are written
 * into a throwaway HOME, so no real credentials or clock are touched.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getClaudeAuthStatus, getCodexAuthStatus } from "./host-auth-status.js";

let home: string;

/** A settings object with every provider credential empty. */
const NO_SETTINGS = { claudeCodeOAuthToken: "", anthropicApiKey: "", openaiApiKey: "" };

/** Write ~/.claude/.credentials.json with a claudeAiOauth block. */
function writeClaudeOAuth(expiresAt?: number): void {
  mkdirSync(join(home, ".claude"), { recursive: true });
  const body = { claudeAiOauth: { accessToken: "sk-ant-oat-xxx", refreshToken: "r", ...(expiresAt !== undefined ? { expiresAt } : {}) } };
  writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify(body));
}

beforeEach(() => { home = mkdtempSync(join(tmpdir(), "aura-auth-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe("getClaudeAuthStatus", () => {
  it("env auth var wins and reports method=env", () => {
    const env = { HOME: home, ANTHROPIC_API_KEY: "sk-ant-123" } as NodeJS.ProcessEnv;
    expect(getClaudeAuthStatus(env, NO_SETTINGS)).toEqual({ authState: "authorized", authMethod: "env" });
  });

  it("companion OAuth token → authorized (settings_token)", () => {
    const env = { HOME: home } as NodeJS.ProcessEnv;
    expect(getClaudeAuthStatus(env, { ...NO_SETTINGS, claudeCodeOAuthToken: "tok" }))
      .toEqual({ authState: "authorized", authMethod: "settings_token" });
  });

  it("companion Anthropic API key → authorized (api_key)", () => {
    const env = { HOME: home } as NodeJS.ProcessEnv;
    expect(getClaudeAuthStatus(env, { ...NO_SETTINGS, anthropicApiKey: "sk-ant-xyz" }))
      .toEqual({ authState: "authorized", authMethod: "api_key" });
  });

  it("OAuth file with a future expiry → authorized (oauth)", () => {
    writeClaudeOAuth(Date.now() + 3_600_000);
    const env = { HOME: home } as NodeJS.ProcessEnv;
    expect(getClaudeAuthStatus(env, NO_SETTINGS)).toEqual({ authState: "authorized", authMethod: "oauth" });
  });

  it("OAuth file with a PAST expiry → expired (the headless stale-token case)", () => {
    const past = 1_000_000_000_000; // long ago
    writeClaudeOAuth(past);
    const env = { HOME: home } as NodeJS.ProcessEnv;
    expect(getClaudeAuthStatus(env, NO_SETTINGS, past + 1)).toEqual({ authState: "expired", authMethod: "oauth" });
  });

  it("OAuth file with no expiry field → authorized (oauth)", () => {
    writeClaudeOAuth(undefined);
    const env = { HOME: home } as NodeJS.ProcessEnv;
    expect(getClaudeAuthStatus(env, NO_SETTINGS)).toEqual({ authState: "authorized", authMethod: "oauth" });
  });

  it("a live env var beats an EXPIRED OAuth file (precedence matches the CLI)", () => {
    writeClaudeOAuth(1_000); // expired
    const env = { HOME: home, CLAUDE_CODE_OAUTH_TOKEN: "fresh" } as NodeJS.ProcessEnv;
    expect(getClaudeAuthStatus(env, NO_SETTINGS)).toEqual({ authState: "authorized", authMethod: "env" });
  });

  it("nothing anywhere → unauthorized (no method)", () => {
    const env = { HOME: home } as NodeJS.ProcessEnv;
    expect(getClaudeAuthStatus(env, NO_SETTINGS)).toEqual({ authState: "unauthorized" });
  });
});

describe("getCodexAuthStatus", () => {
  it("OPENAI_API_KEY env → authorized (env)", () => {
    const env = { HOME: home, OPENAI_API_KEY: "sk-oai" } as NodeJS.ProcessEnv;
    expect(getCodexAuthStatus(env, NO_SETTINGS)).toEqual({ authState: "authorized", authMethod: "env" });
  });

  it("companion OpenAI key → authorized (api_key)", () => {
    const env = { HOME: home } as NodeJS.ProcessEnv;
    expect(getCodexAuthStatus(env, { ...NO_SETTINGS, openaiApiKey: "sk-oai" }))
      .toEqual({ authState: "authorized", authMethod: "api_key" });
  });

  it("~/.codex/auth.json present → authorized (oauth)", () => {
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "auth.json"), "{}");
    const env = { HOME: home } as NodeJS.ProcessEnv;
    expect(getCodexAuthStatus(env, NO_SETTINGS)).toEqual({ authState: "authorized", authMethod: "oauth" });
  });

  // LLM auth follow-up (1c open question): codex 0.162.1 keeps a stored
  // ChatGPT sign-in even when OPENAI_API_KEY is set (`codex doctor`: "auth
  // mode chatgpt", `codex login status`: "Logged in using ChatGPT"), and
  // Aura injects the settings key as that env var. So the badge must say
  // "oauth" for that case, matching the provider status probe.
  it("ChatGPT auth.json wins over an env or settings OpenAI key (oauth)", () => {
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "synthetic" } }));
    const env = { HOME: home, OPENAI_API_KEY: "sk-oai" } as NodeJS.ProcessEnv;
    expect(getCodexAuthStatus(env, NO_SETTINGS)).toEqual({ authState: "authorized", authMethod: "oauth" });
    expect(getCodexAuthStatus({ HOME: home } as NodeJS.ProcessEnv, { ...NO_SETTINGS, openaiApiKey: "sk-oai" }))
      .toEqual({ authState: "authorized", authMethod: "oauth" });
  });

  it("an API-key auth.json with no env/settings key → authorized (api_key)", () => {
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "auth.json"), JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "synthetic" }));
    expect(getCodexAuthStatus({ HOME: home } as NodeJS.ProcessEnv, NO_SETTINGS)).toEqual({ authState: "authorized", authMethod: "api_key" });
  });

  it("nothing anywhere → unauthorized (Codex has no expired state)", () => {
    const env = { HOME: home } as NodeJS.ProcessEnv;
    expect(getCodexAuthStatus(env, NO_SETTINGS)).toEqual({ authState: "unauthorized" });
  });
});
