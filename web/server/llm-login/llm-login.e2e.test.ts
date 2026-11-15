import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The launcher's Codex home seeding reads the "legacy" (primary) Codex home;
// here it is the isolated live HOME, never the real ~/.codex.
const legacy = vi.hoisted(() => ({ path: "" }));
vi.mock("../codex-home.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../codex-home.js")>()),
  getLegacyCodexHome: () => legacy.path,
}));

import { knownField, unknownField, type ProviderAuthStatus, type ProviderId } from "../auth-status/auth-types.js";
import { codexTokenFingerprintAt } from "../auth-status/credential-locator.js";
import { CliLauncher } from "../cli-launcher.js";
import { CredentialRenewal, type RenewalSession } from "../credential-renewal.js";
import type { CredentialRenewalRecord } from "../session-types.js";
import { readEpoch, type PromotionDeps } from "./credential-promotion.js";
import { LoginAttempts } from "./login-attempt.js";
import { promoteAndRenew } from "./login-wiring.js";
import { planCheck } from "./plan-check.js";

/**
 * LLM auth phase 2, task 15 — one end-to-end regression per incident of the
 * spec's Context, plus Claude/Codex parity and a Council pair (claude
 * orchestrator + codex observer) surviving a re-login. Everything runs
 * against the FAKE official CLI (`fixtures/fake-login-cli.mjs`) and an
 * isolated "live" HOME under tmp with generated SYNTH-CANARY credentials;
 * the launcher/bridge side is a fake session table driven by the REAL
 * `CredentialRenewal` and the REAL `CliLauncher.prepareCodexHome`.
 *
 *  (a) dead Claude refresh: expired live file; the UI sign-in leaves it
 *      byte-for-byte until success; then the new file, epoch 1, and the
 *      failed session is moved to the new sign-in (restored, Retry only on click);
 *  (b) Codex on the server + stale per-session copies: device-auth, promotion,
 *      the session's own (newer!) copy becomes a symlink to the new primary
 *      after its relaunch;
 *  (c) PRO instead of MAX: expecting Max, signing in Pro → mismatch, never match;
 *  (d) another user / HOME: refused before any CLI starts, live files untouched;
 *  plus S3-AC4 (rejected sign-in → nothing relaunched) and the Council pair.
 */

const FAKE_CLI = join(import.meta.dirname, "fixtures", "fake-login-cli.mjs");
const linux = process.platform === "linux";

let root: string;
let liveHome: string;
let stateDir: string;
let registry: LoginAttempts | null;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "llm-login-e2e-"));
  liveHome = join(root, "live");
  stateDir = join(root, "state");
  mkdirSync(join(liveHome, ".claude"), { recursive: true, mode: 0o700 });
  mkdirSync(join(liveHome, ".codex"), { recursive: true, mode: 0o700 });
  legacy.path = join(liveHome, ".codex");
  registry = null;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  await registry?.shutdown();
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const liveClaude = () => join(liveHome, ".claude", ".credentials.json");
const liveCodex = () => join(liveHome, ".codex", "auth.json");

function fakeCli(scenario: string): string {
  const path = join(root, `fake-${scenario}.sh`);
  writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLI}" --scenario=${scenario} "$@"\n`);
  chmodSync(path, 0o755);
  return path;
}

async function waitFor(pred: () => boolean, ms = 8_000): Promise<void> {
  const until = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > until) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}

function seedExpiredLive(): void {
  writeFileSync(liveClaude(), JSON.stringify({ claudeAiOauth: { accessToken: "SYNTH-CANARY-old", refreshToken: "SYNTH-CANARY-old-r", expiresAt: 1 } }), { mode: 0o600 });
  writeFileSync(liveCodex(), JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "SYNTH-CANARY-old", refresh_token: "SYNTH-CANARY-old-r" } }), { mode: 0o600 });
}

interface FakeSession extends RenewalSession {
  busy: boolean;
  peers: string[];
  /** The session's own CODEX_HOME (Codex only). */
  codexHome?: string;
  failedSignIn?: boolean;
}

/**
 * The service as the renewal sees it: a session table, a launcher whose
 * relaunch runs the REAL `prepareCodexHome` with the epoch the session ran
 * on, an intentional-kill set and the published records.
 */
function service(sessions: FakeSession[]) {
  const byId = new Map(sessions.map((s) => [s.sessionId, s]));
  const currentEpoch = (p: ProviderId) => readEpoch(stateDir, p)?.epoch ?? 0;
  const launcher = new CliLauncher(0);
  launcher.setCredentialEpochReader((p) => currentEpoch(p));
  const intentional = new Set<string>();
  const log: string[] = [];
  const published: Array<{ id: string; record: CredentialRenewalRecord | null }> = [];
  const renewal = new CredentialRenewal({
    listSessions: () => [...byId.values()],
    getSession: (id) => byId.get(id) ?? null,
    currentEpoch,
    readEpoch: (p) => readEpoch(stateDir, p),
    isBusy: (id) => byId.get(id)?.busy ?? false,
    stop: async (id) => {
      log.push(`stop:${id}:marked=${intentional.has(id)}`);
      byId.get(id)!.alive = false;
    },
    relaunch: async (id) => {
      const s = byId.get(id)!;
      log.push(`relaunch:${id}:marked=${[...intentional].sort().join(",")}`);
      if (s.codexHome) {
        // What `CliLauncher.relaunch` does for a host Codex session: remember
        // the previous process's epoch, then seed the session's CODEX_HOME.
        const internal = launcher as unknown as {
          credentialEpochBeforeSpawn: Map<string, number | undefined>;
          prepareCodexHome(home: string, sessionId?: string): void;
        };
        internal.credentialEpochBeforeSpawn.set(id, s.credentialEpochAtLaunch);
        internal.prepareCodexHome(s.codexHome, id);
      }
      s.credentialEpochAtLaunch = currentEpoch(s.provider);
      s.alive = true;
      return { ok: true };
    },
    markIntentional: (id) => {
      if (intentional.has(id)) return false;
      intentional.add(id);
      return true;
    },
    releaseIntentional: (id) => {
      intentional.delete(id);
    },
    groupPeers: (id) => byId.get(id)?.peers ?? [],
    publish: (id, record) => {
      published.push({ id, record });
    },
    // The held input is delivered by the bridge; here: record that it was released (and nothing else).
    releaseHeld: (id) => {
      log.push(`release:${id}`);
    },
    failHeld: (id) => {
      log.push(`fail:${id}`);
    },
    hasPendingSignInRetry: (id) => byId.get(id)?.failedSignIn ?? false,
  });
  return { byId, renewal, intentional, log, published, currentEpoch };
}

function registryFor(scenario: Partial<Record<ProviderId, string>>, svc: ReturnType<typeof service>, opts: { plan?: Partial<Record<ProviderId, string>>; callerUser?: string } = {}) {
  const resolveCli = vi.fn((p: ProviderId) => (scenario[p] ? fakeCli(scenario[p]!) : null));
  const deps: PromotionDeps = {
    serviceEnv: { HOME: liveHome },
    stateDir,
    uid: process.getuid!(),
    probeStaged: async (provider): Promise<ProviderAuthStatus> => ({
      provider, state: "working", reason: null, account: knownField("synthetic-owner@example.test"),
      plan: knownField(opts.plan?.[provider] ?? (provider === "claude" ? "max" : "pro")), method: knownField("subscription"),
      tokenExpiresAt: unknownField, lastSuccessAt: null, checkedAt: Date.now(), verifiedBy: "provider",
      cli: { path: unknownField, version: unknownField },
    }),
    codexTokenFingerprint: codexTokenFingerprintAt,
    beforePromote: (p) => svc.renewal.beforePromote(p),
    noteCredentialsPromoted: () => {},
  };
  registry = new LoginAttempts({
    attemptsRoot: join(root, "attempts"),
    resolveCli,
    platform: "linux",
    callerUser: opts.callerUser ?? "svc",
    callerUid: 1000,
    serviceUser: "svc",
    serviceEnv: { PATH: process.env.PATH, HOME: liveHome },
    cooldownMs: 0,
    killGraceMs: 300,
    timeoutBinary: null,
    promote: (ctx) => promoteAndRenew(ctx, deps, svc.renewal),
  });
  return { registry, resolveCli };
}

async function signInClaude(r: LoginAttempts, code: (state: string) => string): Promise<void> {
  const id = (await r.start("claude")).attempt!.id;
  await waitFor(() => r.current("claude")?.state === "awaiting_user");
  const prompt = r.current("claude")!.prompt;
  if (prompt?.provider !== "claude") throw new Error("no prompt");
  await r.submitCode("claude", id, code(prompt.state));
}

async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 10));
}

const session = (id: string, provider: ProviderId, over: Partial<FakeSession> = {}): FakeSession => ({
  sessionId: id, provider, alive: true, archived: false, containerized: false, credentialEpochAtLaunch: 0, busy: false, peers: [], ...over,
});

describe.skipIf(!linux)("LLM sign-in incidents, end to end (fake CLI, isolated HOME)", () => {
  it("(a) dead Claude refresh: live file untouched until success; then new sign-in, epoch 1, the failed session moved over", async () => {
    seedExpiredLive();
    const before = sha(liveClaude());
    const svc = service([session("k-failed", "claude", { failedSignIn: true })]);
    const { registry: r } = registryFor({ claude: "success" }, svc);
    const id = (await r.start("claude")).attempt!.id;
    await waitFor(() => r.current("claude")?.state === "awaiting_user");
    // The CLI's destructive start ran in the staging home: the live file is unchanged.
    expect(sha(liveClaude())).toBe(before);
    const prompt = r.current("claude")!.prompt;
    if (prompt?.provider !== "claude") throw new Error("no prompt");
    await r.submitCode("claude", id, `SYNTHcode#${prompt.state}`);
    await waitFor(() => r.current("claude")?.state === "succeeded");
    expect(readFileSync(liveClaude(), "utf-8")).toContain("SYNTH-CANARY-claude-access");
    const epoch = readEpoch(stateDir, "claude")!;
    expect(epoch.epoch).toBe(1);
    await settle();
    // Barrier stopped the Claude process (marked first), relaunch after the rename.
    expect(svc.log).toEqual(["stop:k-failed:marked=true", "relaunch:k-failed:marked=k-failed", "release:k-failed"]);
    expect(svc.published.at(-1)).toEqual({ id: "k-failed", record: { provider: "claude", promotedAt: epoch.promotedAt, state: "renewed" } });
    // The failed card is "restored" (it fired before promotedAt) and waits for the user's Retry.
    expect(svc.renewal.summary("claude").awaitingRetry).toBe(1);
    expect(svc.intentional.size).toBe(0);
  });

  it("(b) Codex on the server + stale per-session copies: after the device sign-in, the session's own newer copy becomes a symlink to the new primary", async () => {
    seedExpiredLive();
    const copyHome = join(root, "codex-home", "c-copy");
    mkdirSync(copyHome, { recursive: true });
    // The session refreshed its own copy DURING the sign-in: newer mtime than anything.
    writeFileSync(join(copyHome, "auth.json"), JSON.stringify({ tokens: { access_token: "SYNTH-CANARY-old-account-refreshed" } }), { mode: 0o600 });
    const future = Date.now() / 1000 + 3600;
    utimesSync(join(copyHome, "auth.json"), future, future);
    const svc = service([session("c-copy", "codex", { codexHome: copyHome })]);
    const { registry: r } = registryFor({ codex: "success" }, svc);
    await r.start("codex");
    await waitFor(() => r.current("codex")?.state === "succeeded");
    expect(readFileSync(liveCodex(), "utf-8")).toContain("SYNTH-CANARY-codex-refresh");
    await settle();
    expect(svc.log).toContain("relaunch:c-copy:marked=c-copy");
    expect(lstatSync(join(copyHome, "auth.json")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(copyHome, "auth.json"), "utf-8")).toContain("SYNTH-CANARY-codex-refresh");
    // Codex has no barrier: nothing was stopped before the rename.
    expect(svc.log.some((l) => l.startsWith("stop:"))).toBe(false);
  });

  it("(c) PRO instead of MAX: expecting Max, a Pro sign-in is promoted but flagged mismatch — never 'match'", async () => {
    seedExpiredLive();
    const svc = service([]);
    const { registry: r } = registryFor({ claude: "success" }, svc, { plan: { claude: "pro" } });
    await signInClaude(r, (state) => `SYNTHcode#${state}`);
    await waitFor(() => r.current("claude")?.state === "succeeded");
    const plan = r.current("claude")!.result!.plan;
    expect(plan).toEqual(knownField("pro"));
    expect(planCheck("claude", plan, "max")).toBe("mismatch");
    expect(planCheck("claude", knownField("max_20x"), "max")).toBe("match");
  });

  it("(d) another system user / HOME: refused before any CLI starts; live files byte-for-byte", async () => {
    seedExpiredLive();
    const before = [sha(liveClaude()), sha(liveCodex())];
    const svc = service([session("k1", "claude")]);
    const { registry: r } = registryFor({ claude: "success", codex: "success" }, svc, { callerUser: "someone-else" });
    for (const p of ["claude", "codex"] as const) {
      const out = await r.start(p);
      expect(out.kind).toBe("refused");
      expect(out.attempt?.failure).toBe("wrong_service_user");
    }
    // No attempt dir, so no staging home and no CLI process was ever created.
    expect(existsSync(join(root, "attempts")) ? readdirSync(join(root, "attempts")) : []).toEqual([]);
    expect([sha(liveClaude()), sha(liveCodex())]).toEqual(before);
    expect(svc.log).toEqual([]);
  });

  it("S3-AC4: a code the provider rejects (Claude) and a cancelled device sign-in (Codex) change nothing — no stop, no relaunch, live files and epochs untouched", async () => {
    seedExpiredLive();
    const before = [sha(liveClaude()), sha(liveCodex())];
    const svc = service([session("k1", "claude"), session("c1", "codex")]);
    const { registry: r } = registryFor({ claude: "reject", codex: "wait" }, svc);
    await signInClaude(r, (state) => `SYNTHcode#${state}`);
    await waitFor(() => r.current("claude")?.state === "failed");
    const codexId = (await r.start("codex")).attempt!.id;
    await waitFor(() => r.current("codex")?.state === "awaiting_user");
    await r.cancel("codex", codexId);
    await waitFor(() => r.current("codex")?.state === "cancelled");
    await settle();
    expect([sha(liveClaude()), sha(liveCodex())]).toEqual(before);
    expect(readEpoch(stateDir, "claude")).toBeNull();
    expect(readEpoch(stateDir, "codex")).toBeNull();
    expect(svc.log).toEqual([]);
    expect(svc.published).toEqual([]);
    expect(svc.renewal.holdUserMessage("k1")).toBe(false);
  });

  it("Council pair (claude orchestrator + codex observer) survives a Codex re-login: only the observer is relaunched, both halves marked, binding kept, the held wake delivered once", async () => {
    seedExpiredLive();
    const obsHome = join(root, "codex-home", "obs");
    mkdirSync(obsHome, { recursive: true });
    const svc = service([
      session("orch", "claude", { peers: ["obs"] }),
      session("obs", "codex", { peers: ["orch"], codexHome: obsHome, busy: true }),
    ]);
    const { registry: r } = registryFor({ codex: "success" }, svc);
    await r.start("codex");
    await waitFor(() => r.current("codex")?.state === "succeeded");
    await settle();
    // The observer is mid-review: no relaunch yet; a wake for it is held.
    expect(svc.log).toEqual([]);
    expect(svc.renewal.isHolding("obs")).toBe(true);
    expect(svc.renewal.holdUserMessage("obs")).toBe(true);
    expect(svc.renewal.isHolding("orch")).toBe(false);
    // Its turn ends → relaunch with BOTH halves marked intentional (EC-2), then the held input released once.
    svc.byId.get("obs")!.busy = false;
    svc.renewal.notePhase("obs", "ready");
    await settle();
    expect(svc.log).toEqual(["relaunch:obs:marked=obs,orch", "release:obs"]);
    expect(svc.intentional.size).toBe(0);
    // Same ids, same pairing — nothing recreated.
    expect(svc.byId.get("obs")!.peers).toEqual(["orch"]);
    expect(svc.byId.get("orch")!.credentialEpochAtLaunch).toBe(0);
    expect(lstatSync(join(obsHome, "auth.json")).isSymbolicLink()).toBe(true);
  });
});
