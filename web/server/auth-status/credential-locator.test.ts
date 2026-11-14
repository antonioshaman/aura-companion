import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLAUDE_CREDENTIAL_FILE_NAMES,
  codexAuthPath,
  credentialFingerprint,
  locateClaudeOAuth,
  locateCodexAuth,
  readClaudeOAuthSecret,
} from "./credential-locator.js";

// The locator is the single source of "which credential file is in effect"
// for both CLIs. These tests pin (a) lookup order identical to the CLI's,
// (b) metadata-only results from the locate* functions (no token bytes), and
// (c) the one narrow token-returning exception. All credentials are synthetic.

let home: string;
const env = () => ({ HOME: home }) as NodeJS.ProcessEnv;
const SYNTH_ACCESS = "synthetic-access-token-not-real";
const SYNTH_REFRESH = "synthetic-refresh-token-not-real";

function writeClaude(fileName: string, oauth: Record<string, unknown> | string): string {
  mkdirSync(join(home, ".claude"), { recursive: true });
  const path = join(home, ".claude", fileName);
  writeFileSync(path, typeof oauth === "string" ? oauth : JSON.stringify({ claudeAiOauth: oauth }));
  return path;
}

function writeCodex(content: Record<string, unknown> | string): string {
  mkdirSync(join(home, ".codex"), { recursive: true });
  const path = join(home, ".codex", "auth.json");
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cred-locator-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("locateClaudeOAuth", () => {
  it("returns metadata for the first usable candidate and never the token", () => {
    const path = writeClaude(".credentials.json", {
      accessToken: SYNTH_ACCESS,
      refreshToken: SYNTH_REFRESH,
      expiresAt: 1_900_000_000_000,
      refreshTokenExpiresAt: 1_950_000_000_000,
      subscriptionType: "max",
    });
    chmodSync(path, 0o600);
    const loc = locateClaudeOAuth(env());
    expect(loc).not.toBeNull();
    expect(loc!.meta.path).toBe(path);
    expect(loc!.meta.mode).toBe(0o600);
    expect(loc!.meta.uid).toBe(process.getuid!());
    expect(loc!.expiresAt).toBe(1_900_000_000_000);
    expect(loc!.refreshTokenExpiresAt).toBe(1_950_000_000_000);
    expect(loc!.hasRefreshToken).toBe(true);
    expect(loc!.subscriptionType).toBe("max");
    // Leak canary: no token bytes anywhere in the metadata.
    const serialized = JSON.stringify(loc);
    expect(serialized).not.toContain(SYNTH_ACCESS);
    expect(serialized).not.toContain(SYNTH_REFRESH);
  });

  it("follows the CLI candidate order, skipping malformed and token-less files", () => {
    expect(CLAUDE_CREDENTIAL_FILE_NAMES[0]).toBe(".credentials.json");
    writeClaude(".credentials.json", "{not json");
    writeClaude("auth.json", { accessToken: "" });
    const third = writeClaude(".auth.json", { accessToken: SYNTH_ACCESS });
    const loc = locateClaudeOAuth(env());
    expect(loc!.meta.path).toBe(third);
    // Missing optional fields degrade to explicit null/false, not undefined.
    expect(loc!.expiresAt).toBeNull();
    expect(loc!.hasRefreshToken).toBe(false);
    expect(loc!.subscriptionType).toBeNull();
  });

  it("returns null when no candidate exists", () => {
    expect(locateClaudeOAuth(env())).toBeNull();
  });
});

describe("locateCodexAuth", () => {
  it("classifies a ChatGPT login and parses last_refresh", () => {
    const path = writeCodex({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: { access_token: SYNTH_ACCESS, refresh_token: SYNTH_REFRESH },
      last_refresh: "2026-11-13T10:00:00Z",
    });
    const loc = locateCodexAuth(env());
    expect(loc!.meta.path).toBe(path);
    expect(codexAuthPath(env())).toBe(path);
    expect(loc!.authMode).toBe("chatgpt");
    expect(loc!.lastRefreshAt).toBe(Date.parse("2026-11-13T10:00:00Z"));
    expect(JSON.stringify(loc)).not.toContain(SYNTH_ACCESS);
  });

  it("extracts expiry, email and plan from JWT claims without exposing tokens", () => {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const jwt = (claims: object) => `${b64({ alg: "none" })}.${b64(claims)}.sig`;
    const access = jwt({ exp: 1_800_000_000 });
    const id = jwt({ email: "synthetic@example.invalid", "https://api.openai.com/auth": { chatgpt_plan_type: "plus" } });
    writeCodex({ auth_mode: "chatgpt", tokens: { access_token: access, id_token: id } });
    const loc = locateCodexAuth(env())!;
    expect(loc.accessTokenExpiresAt).toBe(1_800_000_000_000);
    expect(loc.email).toBe("synthetic@example.invalid");
    expect(loc.planType).toBe("plus");
    // Generation fingerprint: a 16-hex sha256 prefix, stable for the same token.
    expect(loc.credentialFingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(loc.credentialFingerprint).toBe(credentialFingerprint(access));
    expect(JSON.stringify(loc)).not.toContain(access);
  });

  it("classifies an API-key login", () => {
    writeCodex({ OPENAI_API_KEY: "sk-synthetic-not-real", tokens: null });
    expect(locateCodexAuth(env())!.authMode).toBe("api_key");
  });

  it("still locates a present-but-unparsable file (presence is what the CLI keys on)", () => {
    writeCodex("garbage");
    const loc = locateCodexAuth(env());
    expect(loc!.authMode).toBe("unknown");
    expect(loc!.lastRefreshAt).toBeNull();
  });

  it("returns null when ~/.codex/auth.json is absent", () => {
    expect(locateCodexAuth(env())).toBeNull();
  });
});

describe("readClaudeOAuthSecret (narrow usage-limits exception)", () => {
  it("returns the access token and source path on Linux", () => {
    const path = writeClaude(".credentials.json", { accessToken: SYNTH_ACCESS, expiresAt: 123 });
    const secret = readClaudeOAuthSecret(env(), "linux");
    expect(secret!.accessToken).toBe(SYNTH_ACCESS);
    expect(secret!.expiresAt).toBe(123);
    expect(secret!.refreshToken).toBeNull();
    expect(secret!.sourcePath).toBe(path);
  });

  it("returns null without credentials", () => {
    expect(readClaudeOAuthSecret(env(), "linux")).toBeNull();
  });
});
