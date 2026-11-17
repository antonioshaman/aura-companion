import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBinary } from "../path-resolver.js";
import { LoginTranscript } from "./login-transcript.js";
import { sessionMembers, spawnLoginProcess, type LoginProcess } from "./login-runner.js";

/**
 * REAL-CLI sign-in contract (opt-in; council review 2026-11-15, beck B-1).
 *
 *   AURA_REAL_CLI_LOGIN_E2E=1 bunx vitest run server/llm-login/real-login-cli.e2e.test.ts
 *
 * The unit tests run a hand-written fake CLI. #465 showed how that drifts: the
 * fake created CODEX_HOME itself, real codex 0.162.1 refused a missing one,
 * and the first real sign-in on prod failed while CI was green. This test
 * spawns the REAL `claude` / `codex` sign-in through the production runner
 * (same argv, same env allowlist incl. TERM=dumb, a fresh staging HOME + config
 * dir), waits for the transcript verdict `ready` (the sign-in link is shown),
 * then kills it. It never completes a sign-in and never touches the live
 * credential files: everything happens in a temp staging home.
 *
 * Run it whenever a CLI version is added to the proven login versions. Do NOT
 * run it as root, and not on a box where the CLI's network calls are unwanted.
 */
const enabled = process.env.AURA_REAL_CLI_LOGIN_E2E === "1" && process.platform === "linux";

for (const provider of ["claude", "codex"] as const) {
  const cli = enabled ? resolveBinary(provider) : null;
  describe.runIf(enabled && cli !== null)(`real ${provider} sign-in reaches "ready" through spawnLoginProcess`, () => {
    it("shows the sign-in prompt, then is taken down completely", async () => {
      const root = mkdtempSync(join(tmpdir(), `real-login-${provider}-`));
      let proc: LoginProcess | null = null;
      try {
        const stagingHome = join(root, "home");
        mkdirSync(stagingHome, { mode: 0o700 });
        const transcript = new LoginTranscript(provider);
        const r = await spawnLoginProcess(
          { provider, cliPath: cli!, stagingHome, serviceEnv: process.env, hardTtlMs: 120_000, killGraceMs: 2_000 },
          (chunk, stream) => transcript.push(chunk, stream),
        );
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        proc = r.process;
        const until = Date.now() + 60_000;
        while (transcript.verdict().kind !== "ready" && transcript.verdict().kind !== "failed" && Date.now() < until) {
          await new Promise((res) => setTimeout(res, 200));
        }
        expect(transcript.verdict().kind).toBe("ready");
        await proc.kill();
        expect(sessionMembers(proc.pid)).toEqual([]);
      } finally {
        if (proc) await proc.kill();
        rmSync(root, { recursive: true, force: true });
      }
    }, 90_000);
  });
}

// Keeps the file a valid suite when disabled (the default, and in CI).
describe.skipIf(enabled)("real sign-in CLI contract (opt-in)", () => {
  it("is skipped unless AURA_REAL_CLI_LOGIN_E2E=1", () => {
    expect(enabled).toBe(false);
  });
});
