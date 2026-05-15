/**
 * Tests for `resolveObserverPromptForSpawn` — the extracted free function
 * that decides whether observer spawn uses workspace OR bundled prompt.
 *
 * Council Plan Bug B Cleanup Task 15(a). Standalone tests (no CliLauncher
 * instantiation) — the function is pure, takes (cwd) → resolution metadata,
 * and the four behavioural branches are independently testable.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, symlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveObserverPromptForSpawn } from "./observer-prompt-spawn.js";
import { BUNDLED_OBSERVER_PROMPT_SOURCE_LABEL } from "./observer-prompt.js";
import {
  BUNDLED_OBSERVER_PROMPT,
  BUNDLED_OBSERVER_PROMPT_SHA256,
} from "./observer-prompt-bundled.js";

const MIN_BODY = "x".repeat(512);
function workspaceBody(version = 1): string {
  return `<!-- observer-system-prompt v${version} -->\n\n${MIN_BODY}`;
}

describe("resolveObserverPromptForSpawn", () => {
  let dir: string;
  let promptDir: string;
  let promptPath: string;

  beforeEach(() => {
    // CR-6 fix added `realpathSync(cwd)` inside `resolveObserverPromptForSpawn`
    // for workspace-bounds containment. On macOS `tmpdir()` returns
    // `/var/folders/...` but `realpath` resolves to `/private/var/folders/...`
    // (Linux is identity). Canonicalise the dir HERE so test fixtures and
    // assertions speak the same dialect as the production function.
    dir = realpathSync(mkdtempSync(join(tmpdir(), "obs-spawn-")));
    promptDir = join(dir, ".council", "prompts");
    promptPath = join(promptDir, "observer-system.md");
  });

  afterEach(() => {
    try {
      chmodSync(promptPath, 0o644);
    } catch {
      // best-effort
    }
    rmSync(dir, { recursive: true, force: true });
  });

  // Branch 1 — workspace present + valid → source: "workspace"
  it("returns workspace artifact when the workspace file is present and valid", () => {
    mkdirSync(promptDir, { recursive: true });
    const body = workspaceBody();
    writeFileSync(promptPath, body);

    const resolution = resolveObserverPromptForSpawn({ cwd: dir });
    expect(resolution.artifact.source).toBe("workspace");
    expect(resolution.artifact.body).toBe(body);
    expect(resolution.artifact.sourceLabel).toBe(promptPath);
    expect(resolution.expectedPathPresent).toBe(true);
    expect(resolution.expectedPathDepth).toBeGreaterThan(0);
    expect(resolution.fallbackReason).toBeNull();
  });

  // Branch 2 — workspace cwd is undefined/empty → bundled with reason "no-workspace-cwd"
  it("returns bundled artifact when cwd is undefined (reason: no-workspace-cwd)", () => {
    const resolution = resolveObserverPromptForSpawn({ cwd: undefined });
    expect(resolution.artifact.source).toBe("bundled");
    expect(resolution.artifact.body).toBe(BUNDLED_OBSERVER_PROMPT);
    expect(resolution.artifact.sha256).toBe(BUNDLED_OBSERVER_PROMPT_SHA256);
    expect(resolution.artifact.sourceLabel).toBe(BUNDLED_OBSERVER_PROMPT_SOURCE_LABEL);
    expect(resolution.expectedPathPresent).toBe(false);
    expect(resolution.expectedPathDepth).toBe(0);
    expect(resolution.fallbackReason).toBe("no-workspace-cwd");
  });

  it("returns bundled artifact when cwd is empty string (reason: no-workspace-cwd)", () => {
    // Empty string is semantically equivalent to undefined per the helper.
    const resolution = resolveObserverPromptForSpawn({ cwd: "" });
    expect(resolution.artifact.source).toBe("bundled");
    expect(resolution.fallbackReason).toBe("no-workspace-cwd");
    expect(resolution.expectedPathPresent).toBe(false);
  });

  // Branch 3 — workspace cwd set but file ENOENT → bundled with reason "ENOENT"
  it("returns bundled artifact when workspace file is ENOENT (reason: ENOENT)", () => {
    // Workspace cwd present, but .council/prompts/observer-system.md absent.
    const resolution = resolveObserverPromptForSpawn({ cwd: dir });
    expect(resolution.artifact.source).toBe("bundled");
    expect(resolution.artifact.sha256).toBe(BUNDLED_OBSERVER_PROMPT_SHA256);
    expect(resolution.expectedPathPresent).toBe(true);
    expect(resolution.expectedPathDepth).toBeGreaterThan(0);
    expect(resolution.fallbackReason).toBe("ENOENT");
  });

  // Branch 4 — non-ENOENT fs error throws (does NOT fall back)
  it.skipIf(typeof process.getuid === "function" && process.getuid() === 0)(
    "throws on EACCES (does not fall back to bundled)",
    () => {
      mkdirSync(promptDir, { recursive: true });
      writeFileSync(promptPath, workspaceBody());
      chmodSync(promptPath, 0o000);
      try {
        expect(() => resolveObserverPromptForSpawn({ cwd: dir })).toThrow();
      } finally {
        chmodSync(promptPath, 0o644);
      }
    },
  );

  it("throws on workspace file present but malformed (does not fall back)", () => {
    mkdirSync(promptDir, { recursive: true });
    writeFileSync(promptPath, `no header here\n${MIN_BODY}`);
    expect(() => resolveObserverPromptForSpawn({ cwd: dir })).toThrow(/malformed header/);
  });

  it.skipIf(process.platform === "win32")(
    "throws on ELOOP (symlink loop) — does not fall back",
    () => {
      mkdirSync(promptDir, { recursive: true });
      symlinkSync(promptPath, promptPath);
      try {
        expect(() => resolveObserverPromptForSpawn({ cwd: dir })).toThrow();
      } finally {
        try {
          rmSync(promptPath);
        } catch {
          // best-effort
        }
      }
    },
  );

  // Council Review 2026-05-15-1015 CR-21 (Beck B7): deleted the
  // tautological "expectedPathDepth is non-negative integer" row.
  // The type signature (`expectedPathDepth: number`) plus the
  // production expression (`split("/").filter(Boolean).length`)
  // make both properties unfalsifiable by construction. Coverage
  // is preserved via Branch 1 (asserts `> 0`) + Branch 3 (asserts
  // bundled-with-cwd produces `> 0`).
});
