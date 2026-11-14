import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LoginTranscript } from "./login-transcript.js";
import {
  configDirFor,
  defaultTimeoutBinary,
  loginEnv,
  loginPreflight,
  readProcStat,
  sessionMembers,
  spawnLoginProcess,
  type LoginProcess,
  type LoginProcessSpec,
} from "./login-runner.js";

// The sign-in runner (phase 2 plan task 4; S1-AC5, Boundaries "only the
// service user", "no leaks"). Runs the FAKE official CLI
// (fixtures/fake-login-cli.mjs) — never the real one — through a
// per-scenario shell wrapper, because the runner hands the CLI an
// environment allowlist only. Pins:
//  - the environment: staging HOME + config dir, no API keys / OAuth env
//    tokens / Aura token even when the service env carries them;
//  - the CLI's destructive start only ever hits the staging dir (live files
//    are byte-for-byte unchanged, sha256);
//  - stdin EOF does not end Claude's sign-in → the kernel-side `timeout`
//    wrapper ends it (server-restart backstop);
//  - kill() takes the whole session down, including a grandchild and a CLI
//    that ignores SIGTERM; a natural exit sweeps leftovers too — nothing
//    remains in /proc;
//  - preflight refuses the wrong user, Claude on macOS (D6), a missing CLI.

const FAKE_CLI = join(import.meta.dirname, "fixtures", "fake-login-cli.mjs");
const linux = process.platform === "linux";

let root: string;
const live: LoginProcess[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "login-runner-"));
});

afterEach(async () => {
  for (const p of live.splice(0)) await p.kill();
  rmSync(root, { recursive: true, force: true });
});

function fakeCli(scenario: string, extra: string[] = []): string {
  const path = join(root, `fake-${scenario}${extra.join("")}.sh`);
  writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLI}" --scenario=${scenario} ${extra.join(" ")} "$@"\n`);
  chmodSync(path, 0o755);
  return path;
}

function stagingHome(): string {
  const home = join(root, "attempt", "home");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return home;
}

const serviceEnv: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  HOME: "/home/should-not-leak",
  ANTHROPIC_API_KEY: "SYNTH-CANARY-anthropic-key",
  CLAUDE_CODE_OAUTH_TOKEN: "SYNTH-CANARY-oauth-env",
  OPENAI_API_KEY: "SYNTH-CANARY-openai-key",
  COMPANION_AUTH_TOKEN: "SYNTH-CANARY-aura-token",
  HTTPS_PROXY: "http://proxy.example.test:3128",
};

async function start(spec: Partial<LoginProcessSpec> & Pick<LoginProcessSpec, "provider" | "cliPath">) {
  const out: { stdout: string; stderr: string } = { stdout: "", stderr: "" };
  const transcript = new LoginTranscript(spec.provider);
  const r = await spawnLoginProcess(
    { stagingHome: stagingHome(), serviceEnv, hardTtlMs: null, killGraceMs: 300, ...spec },
    (chunk, stream) => {
      out[stream] += chunk.toString();
      transcript.push(chunk, stream);
    },
  );
  if (!r.ok) throw new Error(`spawn failed: ${r.reason}`);
  live.push(r.process);
  return { proc: r.process, out, transcript };
}

async function waitFor(pred: () => boolean, ms = 5_000): Promise<void> {
  const until = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > until) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

describe("loginEnv / loginPreflight (pure)", () => {
  it("passes only the allowlist; HOME and the config dir point at the staging home", () => {
    const claude = loginEnv("claude", "/s/home", serviceEnv);
    expect(claude).toEqual({
      HOME: "/s/home",
      TERM: "dumb",
      PATH: serviceEnv.PATH,
      HTTPS_PROXY: "http://proxy.example.test:3128",
      CLAUDE_CONFIG_DIR: "/s/home/.claude",
    });
    const codex = loginEnv("codex", "/s/home", serviceEnv);
    expect(codex.CODEX_HOME).toBe("/s/home/.codex");
    expect(codex.CLAUDE_CONFIG_DIR).toBeUndefined();
    for (const env of [claude, codex]) expect(JSON.stringify(env)).not.toContain("SYNTH-CANARY");
  });

  it("refuses the wrong user, Claude on macOS, a missing or relative CLI path; Codex on macOS is fine", () => {
    const base = { platform: "linux" as const, callerUser: "svc", serviceUser: "svc", cliPath: "/usr/bin/x" };
    expect(loginPreflight({ ...base, provider: "claude", callerUser: "root" })).toBe("wrong_service_user");
    expect(loginPreflight({ ...base, provider: "codex", callerUser: "other" })).toBe("wrong_service_user");
    expect(loginPreflight({ ...base, provider: "claude", platform: "darwin" })).toBe("unsupported_platform");
    expect(loginPreflight({ ...base, provider: "codex", platform: "darwin" })).toBeNull();
    expect(loginPreflight({ ...base, provider: "codex", cliPath: null })).toBe("cli_missing");
    expect(loginPreflight({ ...base, provider: "codex", cliPath: "codex" })).toBe("cli_missing");
    // Dev without a unit: service user unknown → the caller is the service.
    expect(loginPreflight({ ...base, provider: "claude", serviceUser: null })).toBeNull();
  });
});

describe.skipIf(!linux)("spawnLoginProcess against the fake CLI", () => {
  it("the CLI sees only the allowlisted environment (both providers)", async () => {
    for (const provider of ["claude", "codex"] as const) {
      const { proc, out } = await start({ provider, cliPath: fakeCli("env") });
      await waitFor(() => out.stdout.includes("\n"));
      const env = JSON.parse(out.stdout.slice("FAKE-ENV ".length));
      expect(env.TERM).toBe("dumb");
      expect(env.HOME).toBe(join(root, "attempt", "home"));
      expect(provider === "claude" ? env.CLAUDE_CONFIG_DIR : env.CODEX_HOME).toBe(configDirFor(provider, env.HOME));
      for (const key of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY", "COMPANION_AUTH_TOKEN"]) {
        expect(env.keys).not.toContain(key);
      }
      await proc.kill();
    }
  });

  it("the destructive start hits only the staging dir; live files are byte-for-byte unchanged", async () => {
    // Synthetic "live" service home with an EXPIRED Claude token and a Codex auth.json.
    const liveHome = join(root, "live");
    mkdirSync(join(liveHome, ".claude"), { recursive: true });
    mkdirSync(join(liveHome, ".codex"), { recursive: true });
    const liveClaude = join(liveHome, ".claude", ".credentials.json");
    const liveCodex = join(liveHome, ".codex", "auth.json");
    writeFileSync(liveClaude, JSON.stringify({ claudeAiOauth: { accessToken: "SYNTH-CANARY-old", refreshToken: "SYNTH-CANARY-r", expiresAt: 1 } }));
    writeFileSync(liveCodex, JSON.stringify({ tokens: { access_token: "SYNTH-CANARY-old" } }));
    const before = [sha(liveClaude), sha(liveCodex)];

    const claude = await start({ provider: "claude", cliPath: fakeCli("success"), serviceEnv: { ...serviceEnv, HOME: liveHome } });
    // Same expired file in the staging dir: the fake CLI must destroy THAT one (proves it is destructive).
    const staged = join(root, "attempt", "home", ".claude", ".credentials.json");
    await waitFor(() => claude.transcript.verdict().kind === "ready");
    const codex = await start({ provider: "codex", cliPath: fakeCli("wait"), serviceEnv: { ...serviceEnv, HOME: liveHome } });
    await waitFor(() => codex.transcript.verdict().kind === "ready");
    await claude.proc.kill();
    await codex.proc.kill();
    expect([sha(liveClaude), sha(liveCodex)]).toEqual(before);
    expect(existsSync(staged)).toBe(false);
  });

  it("the fake CLI is destructive inside its own home (the hazard the staging dir contains)", async () => {
    const home = stagingHome();
    mkdirSync(join(home, ".claude"));
    const staged = join(home, ".claude", ".credentials.json");
    writeFileSync(staged, JSON.stringify({ claudeAiOauth: { accessToken: "SYNTH-CANARY-x", refreshToken: "SYNTH-CANARY-y", expiresAt: 1 } }));
    const { proc, transcript } = await start({ provider: "claude", cliPath: fakeCli("success"), stagingHome: home });
    await waitFor(() => transcript.verdict().kind === "ready");
    expect(JSON.parse(readFileSync(staged, "utf-8")).claudeAiOauth.accessToken).toBe("");
    await proc.kill();
  });

  it("S1-AC1/AC2 claude: output parses ready; one reply line with the right state → exit 0 and synthetic credentials in staging", async () => {
    const { proc, transcript } = await start({ provider: "claude", cliPath: fakeCli("success") });
    await waitFor(() => transcript.verdict().kind === "ready");
    const v = transcript.verdict();
    if (v.kind !== "ready" || v.prompt.provider !== "claude") throw new Error("not ready");
    expect(proc.writeLine("bad\nline")).toBe(false);
    expect(proc.writeLine("x\r")).toBe(false);
    expect(proc.writeLine(`SYNTHcode#${v.prompt.state}`)).toBe(true);
    const exit = await proc.exited;
    expect(exit).toMatchObject({ exitCode: 0, killedByUs: false });
    const creds = JSON.parse(readFileSync(join(root, "attempt", "home", ".claude", ".credentials.json"), "utf-8"));
    expect(creds.claudeAiOauth.accessToken).toMatch(/^SYNTH-CANARY-/);
  });

  it("S1-AC3 claude: a rejected code → exit 1 with the provider's 400 line", async () => {
    const { proc, transcript } = await start({ provider: "claude", cliPath: fakeCli("reject") });
    await waitFor(() => transcript.verdict().kind === "ready");
    proc.writeLine("SYNTHcode#wrong-state");
    expect((await proc.exited).exitCode).toBe(1);
    expect(transcript.verdict()).toEqual({ kind: "failed", reason: "code_rejected" });
  });

  it("codex: device-code output parses ready; success exits 0 with auth.json in staging only", async () => {
    const { proc, transcript } = await start({ provider: "codex", cliPath: fakeCli("success") });
    await waitFor(() => transcript.verdict().kind === "ready");
    expect((await proc.exited).exitCode).toBe(0);
    expect(existsSync(join(root, "attempt", "home", ".codex", "auth.json"))).toBe(true);
  });

  it.skipIf(!defaultTimeoutBinary())("S1-AC5: stdin EOF does not end Claude's sign-in — the timeout wrapper does (server-restart backstop)", async () => {
    const { proc, transcript } = await start({ provider: "claude", cliPath: fakeCli("success"), hardTtlMs: 1_000 });
    await waitFor(() => transcript.verdict().kind === "ready");
    // The runner never kills here: only the kernel-side wrapper can end it.
    const exit = await proc.exited;
    expect(exit.killedByUs).toBe(false);
    expect(exit.exitCode).toBe(124);
    expect(sessionMembers(proc.pid)).toEqual([]);
  }, 10_000);

  it("S1-AC5: kill() takes the whole session down — grandchild included; nothing left in /proc", async () => {
    const { proc, transcript } = await start({ provider: "codex", cliPath: fakeCli("wait", ["--grandchild"]) });
    await waitFor(() => transcript.verdict().kind === "ready");
    await waitFor(() => sessionMembers(proc.pid).length >= 2);
    const exit = await proc.kill();
    expect(exit.killedByUs).toBe(true);
    expect(sessionMembers(proc.pid)).toEqual([]);
  });

  it("S1-AC5: a CLI that ignores SIGTERM is KILLed after the grace period", async () => {
    const { proc, transcript } = await start({ provider: "claude", cliPath: fakeCli("ignore_term"), killGraceMs: 200 });
    // Output means the SIGTERM handler is installed (it is set before printing).
    await waitFor(() => transcript.verdict().kind === "ready");
    const exit = await proc.kill();
    expect(exit.signal).toBe("SIGKILL");
    expect(sessionMembers(proc.pid)).toEqual([]);
  });

  it("a natural exit sweeps what the CLI left behind in its session", async () => {
    const { proc } = await start({ provider: "codex", cliPath: fakeCli("no_network", ["--grandchild"]) });
    const exit = await proc.exited;
    expect(exit).toMatchObject({ exitCode: 1, killedByUs: false });
    await waitFor(() => sessionMembers(proc.pid).length === 0);
  });

  it("records the /proc start time as the identity anchor", async () => {
    const { proc } = await start({ provider: "codex", cliPath: fakeCli("wait") });
    expect(proc.startTime).toMatch(/^\d+$/);
    expect(readProcStat(proc.pid)?.startTime).toBe(proc.startTime);
  });

  it("a missing CLI binary → cli_missing, no process", async () => {
    const r = await spawnLoginProcess(
      { provider: "codex", cliPath: join(root, "nope"), stagingHome: stagingHome(), serviceEnv, hardTtlMs: null },
      () => {},
    );
    expect(r).toEqual({ ok: false, reason: "cli_missing" });
  });
});
