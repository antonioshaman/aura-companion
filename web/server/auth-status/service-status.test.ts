import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Production wiring of the status core. Settings are mocked so the test never
// reads the real ~/.companion, and HOME/PATH point at an empty temp dir, so no
// real credentials or CLIs are touched.
vi.mock("../settings-manager.js", () => ({
  getSettings: () => ({ claudeCodeOAuthToken: "", anthropicApiKey: "", openaiApiKey: "" }),
}));

import { createAuthStatusCore, readUnitTexts, resolveInPath } from "./service-status.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "service-status-"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("readUnitTexts", () => {
  it("reads the unit then its .conf drop-ins in lexical order", () => {
    const unit = join(dir, "aura.service");
    writeFileSync(unit, "[Service]\nUser=a\n");
    mkdirSync(`${unit}.d`);
    writeFileSync(join(`${unit}.d`, "20-b.conf"), "B");
    writeFileSync(join(`${unit}.d`, "10-a.conf"), "A");
    writeFileSync(join(`${unit}.d`, "ignored.txt"), "X");
    expect(readUnitTexts(unit)).toEqual(["[Service]\nUser=a\n", "A", "B"]);
    expect(readUnitTexts(join(dir, "missing.service"))).toEqual([]);
  });
});

describe("resolveInPath", () => {
  it("finds executables only within the given PATH, ignoring relative entries", () => {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "claude"), "#!/bin/sh\n");
    chmodSync(join(bin, "claude"), 0o755);
    writeFileSync(join(bin, "codex"), "not executable");
    expect(resolveInPath("claude", { PATH: `relative:${bin}` })).toBe(join(bin, "claude"));
    expect(resolveInPath("codex", { PATH: bin })).toBeNull();
    expect(resolveInPath("claude", {})).toBeNull();
  });
});

describe("createAuthStatusCore", () => {
  it("local_cli mode without credentials reports not_signed_in for both and persists nothing", async () => {
    for (const key of ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_AUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY"]) {
      vi.stubEnv(key, "");
    }
    vi.stubEnv("HOME", dir);
    vi.stubEnv("USERPROFILE", "");
    const core = createAuthStatusCore({ mode: "local_cli", unitTexts: [], companionHome: join(dir, ".companion") });
    const snap = await core.get();
    expect(snap.computedBy).toBe("local_cli");
    expect(snap.providers.claude.state).toBe("not_signed_in");
    expect(snap.providers.codex.state).toBe("not_signed_in");
    // Only the service process persists the last check.
    expect(existsSync(join(dir, ".companion", "auth-status", "last-check.json"))).toBe(false);
  });
});
