import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { knownField, unknownField, type ProviderAuthStatus, type ProviderId } from "../auth-status/auth-types.js";
import { codexTokenFingerprintAt } from "../auth-status/credential-locator.js";
import { StatusCore } from "../auth-status/status-core.js";
import { promoteCredentials, readEpoch, type PromotedCredentials } from "./credential-promotion.js";
import { LoginAttempts } from "./login-attempt.js";
import { sessionMembers } from "./login-runner.js";

// End-to-end sign-in against the FAKE official CLI (phase 2a "done when"):
// for Claude and Codex an attempt walks starting → awaiting_user → verifying
// → succeeded, the credentials land in an isolated "live" HOME, and a real
// StatusCore (stub probes reading that HOME) reports `working` through
// `noteCredentialsPromoted` — no recheck. A rejected code / a cancel leave
// the (expired, synthetic) live files byte-for-byte unchanged, no process,
// no attempt dir, no epoch.

const FAKE_CLI = join(import.meta.dirname, "fixtures", "fake-login-cli.mjs");
const linux = process.platform === "linux";

let root: string;
let liveHome: string;
let registry: LoginAttempts | null;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "login-flow-"));
  liveHome = join(root, "live");
  mkdirSync(join(liveHome, ".claude"), { recursive: true });
  mkdirSync(join(liveHome, ".codex"), { recursive: true });
  registry = null;
});

afterEach(async () => {
  await registry?.shutdown();
  rmSync(root, { recursive: true, force: true });
});

const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

function fakeCli(scenario: string): string {
  const path = join(root, `fake-${scenario}.sh`);
  writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLI}" --scenario=${scenario} "$@"\n`);
  chmodSync(path, 0o755);
  return path;
}

async function waitFor(pred: () => boolean, ms = 5_000): Promise<void> {
  const until = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > until) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Stub probe: "working" iff the live file holds the fake CLI's SYNTH-CANARY sign-in (Codex's access token is a JWT, so its refresh token is the marker). */
function probeLive(provider: ProviderId): ProviderAuthStatus {
  const file = provider === "claude" ? join(liveHome, ".claude", ".credentials.json") : join(liveHome, ".codex", "auth.json");
  const fresh = existsSync(file) && /SYNTH-CANARY-(claude-access|codex-refresh)/.test(readFileSync(file, "utf-8"));
  return {
    provider, state: fresh ? "working" : "invalid", reason: null, account: unknownField, plan: unknownField, method: knownField("subscription"),
    tokenExpiresAt: unknownField, lastSuccessAt: null, checkedAt: Date.now(), verifiedBy: fresh && provider === "codex" ? "login" : "provider",
    cli: { path: unknownField, version: unknownField },
  };
}

function setup(scenario: Partial<Record<ProviderId, string>>) {
  const stateDir = join(root, "state");
  const core = new StatusCore({
    identity: { user: "svc", env: {}, source: "service" },
    caller: { uid: 1, username: "svc", env: {} },
    probes: { claude: async () => probeLive("claude"), codex: async () => probeLive("codex") },
    now: Date.now,
    lastCheckPath: join(root, "last-check.json"),
    persist: false,
    computedBy: "service",
  });
  const promoted: PromotedCredentials[] = [];
  const recheck = vi.spyOn(core, "recheck");
  registry = new LoginAttempts({
    attemptsRoot: join(root, "attempts"),
    resolveCli: (p) => (scenario[p] ? fakeCli(scenario[p]!) : null),
    platform: "linux",
    callerUser: "svc",
    callerUid: 1000,
    serviceUser: "svc",
    serviceEnv: { PATH: process.env.PATH, HOME: liveHome },
    cooldownMs: 0,
    killGraceMs: 300,
    timeoutBinary: null,
    promote: (ctx) =>
      promoteCredentials(ctx, {
        serviceEnv: { HOME: liveHome },
        stateDir,
        uid: process.getuid!(),
        probeStaged: async (provider) => ({
          ...probeLive(provider),
          state: "working",
          account: knownField("synthetic-owner@example.test"),
          plan: knownField(provider === "claude" ? "max" : "pro"),
        }),
        codexTokenFingerprint: codexTokenFingerprintAt,
        noteCredentialsPromoted: async (p) => {
          promoted.push(p);
          await core.noteCredentialsPromoted();
        },
      }),
  });
  return { core, stateDir, promoted, recheck, registry };
}

function seedExpiredLive(): { claude: string; codex: string } {
  const claude = join(liveHome, ".claude", ".credentials.json");
  const codex = join(liveHome, ".codex", "auth.json");
  writeFileSync(claude, JSON.stringify({ claudeAiOauth: { accessToken: "SYNTH-CANARY-old", refreshToken: "SYNTH-CANARY-old-r", expiresAt: 1 } }), { mode: 0o600 });
  writeFileSync(codex, JSON.stringify({ tokens: { access_token: "SYNTH-CANARY-old" } }), { mode: 0o600 });
  return { claude, codex };
}

describe.skipIf(!linux)("sign-in end to end (fake CLI → attempt → promotion → status)", () => {
  it("claude: starting → awaiting_user → verifying → succeeded; live file replaced; status working without recheck", async () => {
    const live = seedExpiredLive();
    const { core, stateDir, promoted, recheck, registry: r } = setup({ claude: "success" });
    await core.get();
    expect(core.peek()!.providers.claude.state).toBe("invalid");
    const seen: string[] = [];
    const id = (await r.start("claude")).attempt!.id;
    const track = setInterval(() => { const s = r.current("claude")?.state; if (s && seen.at(-1) !== s) seen.push(s); }, 1);
    await waitFor(() => r.current("claude")?.state === "awaiting_user");
    const prompt = r.current("claude")!.prompt;
    if (prompt?.provider !== "claude") throw new Error("no prompt");
    await r.submitCode("claude", id, `SYNTHcode#${prompt.state}`);
    await waitFor(() => r.current("claude")?.state === "succeeded");
    clearInterval(track);
    // Observed states follow the machine's order (fast steps may be skipped by the 1 ms sampler).
    const order = ["starting", "awaiting_user", "verifying", "succeeded"];
    expect(seen.map((s) => order.indexOf(s))).toEqual([...seen.map((s) => order.indexOf(s))].sort());
    expect(seen).toContain("awaiting_user");
    expect(seen.at(-1)).toBe("succeeded");
    expect(r.current("claude")!.result).toEqual({ account: knownField("synthetic-owner@example.test"), plan: knownField("max") });
    expect(readFileSync(live.claude, "utf-8")).toMatch(/SYNTH-CANARY-claude-access/);
    expect(JSON.parse(readFileSync(join(liveHome, ".claude.json"), "utf-8")).oauthAccount.emailAddress).toBe("synthetic-owner@example.test");
    expect(readEpoch(stateDir, "claude")?.epoch).toBe(1);
    expect(promoted).toHaveLength(1);
    expect(core.peek()!.providers.claude.state).toBe("working");
    expect(recheck).not.toHaveBeenCalled();
    await waitFor(() => readdirSync(join(root, "attempts")).length === 0);
  });

  it("codex: device code → succeeded; live auth.json replaced; D8 evidence key recorded; status working (verifiedBy login) without recheck", async () => {
    const live = seedExpiredLive();
    const { core, promoted, recheck, registry: r } = setup({ codex: "success" });
    await r.start("codex");
    await waitFor(() => r.current("codex")?.state === "succeeded");
    expect(readFileSync(live.codex, "utf-8")).toMatch(/SYNTH-CANARY-codex-refresh/);
    expect(promoted[0]).toMatchObject({ provider: "codex", tokenFingerprint: codexTokenFingerprintAt(live.codex) });
    expect(core.peek()!.providers.codex).toMatchObject({ state: "working", verifiedBy: "login" });
    expect(recheck).not.toHaveBeenCalled();
  });

  it("S1-AC3/AC5: a rejected code and a cancel leave the expired live files byte-for-byte; no process, dir or epoch", async () => {
    const live = seedExpiredLive();
    const before = [sha(live.claude), sha(live.codex)];
    const { stateDir, registry: r } = setup({ claude: "reject", codex: "wait" });
    const claudeId = (await r.start("claude")).attempt!.id;
    const codexId = (await r.start("codex")).attempt!.id;
    await waitFor(() => r.current("claude")?.state === "awaiting_user" && r.current("codex")?.state === "awaiting_user");
    const pids = readdirSync(join(root, "attempts")).map((d) => JSON.parse(readFileSync(join(root, "attempts", d, "attempt.json"), "utf-8")).pid as number);
    const prompt = r.current("claude")!.prompt;
    if (prompt?.provider !== "claude") throw new Error("no prompt");
    await r.submitCode("claude", claudeId, `SYNTHcode#${prompt.state}`);
    await r.cancel("codex", codexId);
    await waitFor(() => r.current("claude")?.state === "failed");
    await waitFor(() => readdirSync(join(root, "attempts")).length === 0);
    expect([sha(live.claude), sha(live.codex)]).toEqual(before);
    expect(readEpoch(stateDir, "claude")).toBeNull();
    expect(readEpoch(stateDir, "codex")).toBeNull();
    for (const pid of pids) expect(sessionMembers(pid)).toEqual([]);
  });
});
