import { createHash } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { knownField, unknownField, type ProviderAuthStatus, type ProviderId } from "../auth-status/auth-types.js";
import { codexTokenFingerprintAt } from "../auth-status/credential-locator.js";
import { StatusCore } from "../auth-status/status-core.js";
import {
  CrashSimulation,
  liveCredentialPaths,
  mergeClaudeAccount,
  promoteCredentials,
  readEpoch,
  readJournal,
  recoverPromotions,
  type PromotionDeps,
} from "./credential-promotion.js";
import { STAGING_HOME_DIR, type PromotionContext } from "./login-attempt.js";

// Credential promotion (phase 2 plan task 6; S1-AC2, S1-AC3, S1-AC5; 🚫
// "never overwrite working/current credentials with a failed attempt"). All
// files are synthetic (SYNTH-CANARY) in an isolated "live" HOME under tmp —
// never the service's real credentials. Pins:
//  - success: the staged file is renamed over the live one (same bytes,
//    0600, our uid), Claude's `oauthAccount` is merged into `.claude.json`
//    with every other key intact, the epoch bumps, the status is told;
//  - every refusal (missing / symlink / hard link / unparsable / emptied by
//    the CLI's destructive start / probe rejects / barrier fails) leaves the
//    live files byte-for-byte unchanged (sha256), the epoch untouched and no
//    journal;
//  - the barrier `beforePromote` is awaited BEFORE the rename;
//  - a crash after the rename but before the epoch is finished by startup
//    recovery; a crash before the rename is discarded.

let root: string;
let liveHome: string;
let stateDir: string;
let attemptsRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "promotion-"));
  liveHome = join(root, "live");
  stateDir = join(root, "state");
  attemptsRoot = join(root, "attempts");
  mkdirSync(liveHome);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const ATTEMPT_ID = "0123456789abcdef0123456789abcdef";
const UID = process.getuid!();

const claudeCreds = (label: string, expiresAt = Date.now() + 3_600_000) =>
  JSON.stringify({ claudeAiOauth: { accessToken: `SYNTH-CANARY-${label}-a`, refreshToken: `SYNTH-CANARY-${label}-r`, expiresAt, subscriptionType: "max" } });
const codexAuth = (label: string) => JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: `SYNTH-CANARY-${label}-a`, refresh_token: `SYNTH-CANARY-${label}-r` } });

function seedLive(): { claude: string; claudeConfig: string; codex: string } {
  mkdirSync(join(liveHome, ".claude"), { mode: 0o700 });
  mkdirSync(join(liveHome, ".codex"), { mode: 0o700 });
  const paths = { claude: join(liveHome, ".claude", ".credentials.json"), claudeConfig: join(liveHome, ".claude.json"), codex: join(liveHome, ".codex", "auth.json") };
  // The old sign-in is EXPIRED — "even non-working credentials stay byte-for-byte".
  writeFileSync(paths.claude, claudeCreds("old", 1), { mode: 0o600 });
  writeFileSync(paths.claudeConfig, JSON.stringify({ numStartups: 7, projects: { "/x": {} }, oauthAccount: { emailAddress: "old@example.test" } }), { mode: 0o600 });
  writeFileSync(paths.codex, codexAuth("old"), { mode: 0o600 });
  return paths;
}

function stage(provider: ProviderId, files: { creds?: string; config?: string } = {}): PromotionContext {
  const attemptDir = join(attemptsRoot, ATTEMPT_ID);
  const stagingHome = join(attemptDir, STAGING_HOME_DIR);
  const dir = join(stagingHome, provider === "claude" ? ".claude" : ".codex");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const credPath = join(dir, provider === "claude" ? ".credentials.json" : "auth.json");
  if (files.creds !== undefined) writeFileSync(credPath, files.creds, { mode: 0o600 });
  if (files.config !== undefined) writeFileSync(join(dir, ".claude.json"), files.config, { mode: 0o600 });
  return { attemptId: ATTEMPT_ID, provider, attemptDir, stagingHome };
}

const working = (provider: ProviderId): ProviderAuthStatus => ({
  provider, state: "working", reason: null, account: knownField("synthetic-owner@example.test"), plan: knownField(provider === "claude" ? "max" : "pro"),
  method: knownField("subscription"), tokenExpiresAt: unknownField, lastSuccessAt: 1, checkedAt: 1, verifiedBy: "provider",
  cli: { path: unknownField, version: unknownField },
});

function deps(over: Partial<PromotionDeps> = {}): PromotionDeps & { attemptsRoot: string } {
  return {
    serviceEnv: { HOME: liveHome },
    stateDir,
    attemptsRoot,
    uid: UID,
    probeStaged: vi.fn(async (provider: ProviderId) => working(provider)),
    codexTokenFingerprint: codexTokenFingerprintAt,
    beforePromote: vi.fn(async () => {}),
    noteCredentialsPromoted: vi.fn(),
    now: () => 1_800_000_000_000,
    ...over,
  };
}

describe("promoteCredentials — success", () => {
  it("S1-AC2 claude: credentials renamed into place, oauthAccount merged, other keys intact, epoch 1, status told", async () => {
    const live = seedLive();
    const newCreds = claudeCreds("new");
    const ctx = stage("claude", { creds: newCreds, config: JSON.stringify({ oauthAccount: { emailAddress: "synthetic-owner@example.test" }, numStartups: 0 }) });
    const d = deps();
    const out = await promoteCredentials(ctx, d);
    expect(out).toEqual({ ok: true, account: knownField("synthetic-owner@example.test"), plan: knownField("max") });
    expect(readFileSync(live.claude, "utf-8")).toBe(newCreds);
    const st = statSync(live.claude);
    expect(st.mode & 0o777).toBe(0o600);
    expect(st.uid).toBe(UID);
    const config = JSON.parse(readFileSync(live.claudeConfig, "utf-8"));
    // Only oauthAccount is taken from the sign-in; the live file's own state survives.
    expect(config).toEqual({ numStartups: 7, projects: { "/x": {} }, oauthAccount: { emailAddress: "synthetic-owner@example.test" } });
    expect(readEpoch(stateDir, "claude")).toMatchObject({ epoch: 1, fingerprint: sha(live.claude) });
    expect(readJournal(stateDir, "claude")).toBeNull();
    expect(d.noteCredentialsPromoted).toHaveBeenCalledWith(expect.objectContaining({ provider: "claude", fingerprint: sha(live.claude), tokenFingerprint: null }));
    // Codex untouched by a Claude promotion.
    expect(readFileSync(live.codex, "utf-8")).toBe(codexAuth("old"));
  });

  it("S1-AC2 codex: auth.json renamed into place with the promotion time as mtime; D8 evidence key passed; epochs count up", async () => {
    const live = seedLive();
    const d = deps();
    const ctx = stage("codex", { creds: codexAuth("new1") });
    const expectedTokenFp = codexTokenFingerprintAt(join(ctx.stagingHome, ".codex", "auth.json"));
    expect(await promoteCredentials(ctx, d)).toMatchObject({ ok: true, plan: knownField("pro") });
    expect(readFileSync(live.codex, "utf-8")).toBe(codexAuth("new1"));
    expect(statSync(live.codex).mtimeMs).toBe(1_800_000_000_000);
    expect(d.noteCredentialsPromoted).toHaveBeenCalledWith(expect.objectContaining({ provider: "codex", tokenFingerprint: expectedTokenFp }));
    rmSync(ctx.attemptDir, { recursive: true });
    await promoteCredentials(stage("codex", { creds: codexAuth("new2") }), d);
    expect(readEpoch(stateDir, "codex")?.epoch).toBe(2);
  });

  it("creates the live dir when the service user never signed in", async () => {
    const out = await promoteCredentials(stage("codex", { creds: codexAuth("first") }), deps());
    expect(out.ok).toBe(true);
    expect(readFileSync(join(liveHome, ".codex", "auth.json"), "utf-8")).toBe(codexAuth("first"));
  });

  it("the barrier beforePromote is awaited before the rename (2d stops Claude writers there)", async () => {
    const live = seedLive();
    const before = sha(live.claude);
    const order: string[] = [];
    const d = deps({
      beforePromote: async (provider) => {
        await new Promise((r) => setTimeout(r, 30));
        // Still the old file while the barrier runs.
        order.push(`barrier:${provider}:${sha(live.claude) === before ? "old" : "new"}`);
      },
      noteCredentialsPromoted: () => { order.push(`promoted:${sha(live.claude) === before ? "old" : "new"}`); },
    });
    await promoteCredentials(stage("claude", { creds: claudeCreds("new") }), d);
    expect(order).toEqual(["barrier:claude:old", "promoted:new"]);
  });

  it("honours CLAUDE_CONFIG_DIR / CODEX_HOME of the service (the paths sessions read)", () => {
    expect(liveCredentialPaths("claude", { HOME: "/h", CLAUDE_CONFIG_DIR: "/c" })).toEqual({ credentials: "/c/.credentials.json", accountConfig: "/c/.claude.json" });
    expect(liveCredentialPaths("claude", { HOME: "/h" })).toEqual({ credentials: "/h/.claude/.credentials.json", accountConfig: "/h/.claude.json" });
    expect(liveCredentialPaths("codex", { HOME: "/h", CODEX_HOME: "/x" }).credentials).toBe("/x/auth.json");
  });
});

describe("promoteCredentials — refusals leave the live files byte-for-byte unchanged (S1-AC3, S1-AC5)", () => {
  const cases: { name: string; provider: ProviderId; setup: (ctx: PromotionContext) => void; over?: Partial<PromotionDeps> }[] = [
    { name: "no staged file (cancelled / expired / failed CLI)", provider: "claude", setup: () => {} },
    { name: "staged file is a symlink", provider: "codex", setup: (ctx) => {
      const target = join(root, "elsewhere.json");
      writeFileSync(target, codexAuth("evil"));
      symlinkSync(target, join(ctx.stagingHome, ".codex", "auth.json"));
    } },
    { name: "staged file is hard-linked", provider: "codex", setup: (ctx) => {
      const p = join(ctx.stagingHome, ".codex", "auth.json");
      writeFileSync(p, codexAuth("linked"), { mode: 0o600 });
      linkSync(p, join(root, "second-link.json"));
    } },
    { name: "staged file does not parse", provider: "claude", setup: (ctx) => writeFileSync(join(ctx.stagingHome, ".claude", ".credentials.json"), "{not json") },
    { name: "staged file emptied by the CLI's destructive start", provider: "claude", setup: (ctx) =>
      writeFileSync(join(ctx.stagingHome, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "", refreshToken: "", expiresAt: 0 } })) },
    { name: "the staged-home probe says the provider rejects it", provider: "claude", setup: (ctx) =>
      writeFileSync(join(ctx.stagingHome, ".claude", ".credentials.json"), claudeCreds("new"), { mode: 0o600 }),
      over: { probeStaged: async () => ({ ...working("claude"), state: "invalid" }) } },
    { name: "the barrier fails", provider: "codex", setup: (ctx) =>
      writeFileSync(join(ctx.stagingHome, ".codex", "auth.json"), codexAuth("new"), { mode: 0o600 }),
      over: { beforePromote: async () => { throw new Error("busy"); } } },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      const live = seedLive();
      const before = [sha(live.claude), sha(live.claudeConfig), sha(live.codex)];
      const ctx = stage(c.provider);
      c.setup(ctx);
      const d = deps(c.over);
      expect(await promoteCredentials(ctx, d)).toEqual({ ok: false });
      expect([sha(live.claude), sha(live.claudeConfig), sha(live.codex)]).toEqual(before);
      expect(readEpoch(stateDir, c.provider)).toBeNull();
      expect(readJournal(stateDir, c.provider)).toBeNull();
      expect(d.noteCredentialsPromoted).not.toHaveBeenCalled();
    });
  }

  it("a staged file owned by another uid is refused (checked via the uid the service runs as)", async () => {
    const live = seedLive();
    const before = sha(live.codex);
    const ctx = stage("codex", { creds: codexAuth("new") });
    expect(await promoteCredentials(ctx, deps({ uid: UID + 1 }))).toEqual({ ok: false });
    expect(sha(live.codex)).toBe(before);
  });

  it("a world-readable staged file is tightened to 0600 before it goes live", async () => {
    seedLive();
    const ctx = stage("codex", { creds: codexAuth("new") });
    chmodSync(join(ctx.stagingHome, ".codex", "auth.json"), 0o644);
    await promoteCredentials(ctx, deps());
    expect(statSync(join(liveHome, ".codex", "auth.json")).mode & 0o777).toBe(0o600);
  });
});

describe("promotion journal and startup recovery (observer review 201 STOP)", () => {
  it("crash after the rename, before the epoch → recovery finishes: account merged, epoch written, status told, journal and attempt dir gone", async () => {
    const live = seedLive();
    const newCreds = claudeCreds("new");
    const ctx = stage("claude", { creds: newCreds, config: JSON.stringify({ oauthAccount: { emailAddress: "synthetic-owner@example.test" } }) });
    const crashing = deps({ crashAt: (p) => { if (p === "credentials_renamed") throw new CrashSimulation(p); } });
    await expect(promoteCredentials(ctx, crashing)).rejects.toBeInstanceOf(CrashSimulation);
    // The "dead" process left: new credentials live, no epoch, a journal.
    expect(readFileSync(live.claude, "utf-8")).toBe(newCreds);
    expect(readEpoch(stateDir, "claude")).toBeNull();
    expect(readJournal(stateDir, "claude")).toMatchObject({ attemptId: ATTEMPT_ID, targetEpoch: 1, steps: ["credentials_renamed"] });

    const restarted = deps();
    expect(await recoverPromotions(restarted)).toEqual([{ provider: "claude", action: "completed" }]);
    expect(readEpoch(stateDir, "claude")?.epoch).toBe(1);
    expect(JSON.parse(readFileSync(live.claudeConfig, "utf-8")).oauthAccount).toEqual({ emailAddress: "synthetic-owner@example.test" });
    expect(restarted.noteCredentialsPromoted).toHaveBeenCalledWith(expect.objectContaining({ provider: "claude" }));
    expect(readJournal(stateDir, "claude")).toBeNull();
    expect(existsSync(ctx.attemptDir)).toBe(false);
  });

  it("crash after the account merge → recovery writes the epoch without merging again", async () => {
    const live = seedLive();
    const ctx = stage("claude", { creds: claudeCreds("new"), config: JSON.stringify({ oauthAccount: { emailAddress: "synthetic-owner@example.test" } }) });
    await expect(promoteCredentials(ctx, deps({ crashAt: (p) => { if (p === "account_merged") throw new CrashSimulation(p); } }))).rejects.toThrow();
    // Someone (a live CLI) rewrote .claude.json since; recovery must not re-merge over it.
    writeFileSync(live.claudeConfig, JSON.stringify({ numStartups: 8, oauthAccount: { emailAddress: "synthetic-owner@example.test" } }));
    const afterCli = sha(live.claudeConfig);
    await recoverPromotions(deps());
    expect(readEpoch(stateDir, "claude")?.epoch).toBe(1);
    expect(sha(live.claudeConfig)).toBe(afterCli);
  });

  it("crash before the rename → recovery discards the journal and the attempt; live files and epoch untouched", async () => {
    const live = seedLive();
    const before = sha(live.codex);
    const ctx = stage("codex", { creds: codexAuth("new") });
    await expect(promoteCredentials(ctx, deps({ crashAt: (p) => { if (p === "before_rename") throw new CrashSimulation(p); } }))).rejects.toThrow();
    expect(readJournal(stateDir, "codex")).not.toBeNull();
    const restarted = deps();
    expect(await recoverPromotions(restarted)).toEqual([{ provider: "codex", action: "discarded" }]);
    expect(sha(live.codex)).toBe(before);
    expect(readEpoch(stateDir, "codex")).toBeNull();
    expect(readJournal(stateDir, "codex")).toBeNull();
    expect(existsSync(ctx.attemptDir)).toBe(false);
    expect(restarted.noteCredentialsPromoted).not.toHaveBeenCalled();
  });

  it("crash after the epoch, before the journal is deleted → recovery is idempotent (epoch stays 1)", async () => {
    seedLive();
    const ctx = stage("codex", { creds: codexAuth("new") });
    await expect(promoteCredentials(ctx, deps({ crashAt: (p) => { if (p === "epoch_written") throw new CrashSimulation(p); } }))).rejects.toThrow();
    expect(readEpoch(stateDir, "codex")?.epoch).toBe(1);
    await recoverPromotions(deps());
    expect(readEpoch(stateDir, "codex")?.epoch).toBe(1);
    expect(readJournal(stateDir, "codex")).toBeNull();
  });

  it("no journal → recovery does nothing", async () => {
    expect(await recoverPromotions(deps())).toEqual([]);
  });
});

describe("mergeClaudeAccount", () => {
  it("an unparsable live .claude.json is left alone (account then reads unknown, never the old email)", () => {
    const staged = join(root, "staged.json");
    const live = join(root, "live.json");
    writeFileSync(staged, JSON.stringify({ oauthAccount: { emailAddress: "n@example.test" } }));
    writeFileSync(live, "{broken");
    expect(mergeClaudeAccount(staged, live)).toBe(false);
    expect(readFileSync(live, "utf-8")).toBe("{broken");
  });

  it("no staged account → nothing written; a missing live file is created with the account only", () => {
    const staged = join(root, "staged.json");
    const live = join(root, "live.json");
    writeFileSync(staged, JSON.stringify({ numStartups: 1 }));
    expect(mergeClaudeAccount(staged, live)).toBe(false);
    expect(existsSync(live)).toBe(false);
    writeFileSync(staged, JSON.stringify({ oauthAccount: { emailAddress: "n@example.test" } }));
    expect(mergeClaudeAccount(staged, live)).toBe(true);
    expect(JSON.parse(readFileSync(live, "utf-8"))).toEqual({ oauthAccount: { emailAddress: "n@example.test" } });
    expect(statSync(live).mode & 0o777).toBe(0o600);
  });
});

describe("StatusCore.noteCredentialsPromoted (S1-AC2: working without Check)", () => {
  it("recomputes immediately even right after a recheck, and does not consume the recheck rate limit", async () => {
    let state: ProviderAuthStatus["state"] = "invalid";
    const probe = vi.fn(async (provider: ProviderId) => ({ ...working(provider), state }));
    let now = 1_000_000;
    const core = new StatusCore({
      identity: { user: "svc", env: {}, source: "service" },
      caller: { uid: 1, username: "svc", env: {} },
      probes: { claude: () => probe("claude"), codex: () => probe("codex") },
      now: () => now,
      lastCheckPath: join(root, "last-check.json"),
      persist: false,
      computedBy: "service",
    });
    expect((await core.recheck()).kind).toBe("ok");
    expect(core.peek()!.providers.claude.state).toBe("invalid");
    state = "working";
    now += 1_000;
    const snap = await core.noteCredentialsPromoted();
    expect(snap.providers.claude.state).toBe("working");
    expect(core.peek()!.providers.claude.state).toBe("working");
    // The owner's own Check is still rate-limited from the first recheck only.
    expect((await core.recheck()).kind).toBe("too_soon");
  });
});
