import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { knownField, unknownField, type ProviderAuthStatus, type ProviderId, type TurnFailure } from "./auth-status/auth-types.js";
import { codexTokenFingerprintAt } from "./auth-status/credential-locator.js";
import { readEpoch as readEpochFile, type PromotionDeps } from "./llm-login/credential-promotion.js";
import { STAGING_HOME_DIR } from "./llm-login/login-attempt.js";
import { promoteAndRenew } from "./llm-login/login-wiring.js";
import {
  CredentialRenewal,
  needsRenewalRelaunch,
  type CredentialRenewalDeps,
  type RelaunchResult,
  type RenewalSession,
} from "./credential-renewal.js";
import type { CredentialRenewalRecord } from "./session-types.js";

/**
 * LLM auth phase 2, task 13 (plan D1): live sessions move to a new sign-in by
 * an epoch + relaunch at their first idle moment, with a Claude barrier before
 * the rename. Everything here runs against a fake launcher/bridge: no CLI, no
 * credentials. The fake records the ORDER of side effects (stop, relaunch,
 * held-input release, intentional marks) because the contract is about order:
 * nothing is killed unmarked, nothing is delivered to the old process,
 * nothing is re-sent on its own.
 */

interface FakeSession extends RenewalSession {
  busy: boolean;
  peers?: string[];
  pendingSignInRetry?: boolean;
}

function harness(sessions: FakeSession[], opts: { epochs?: Partial<Record<ProviderId, number>>; relaunch?: (id: string) => Promise<RelaunchResult> } = {}) {
  const epochs: Record<ProviderId, number> = { claude: 0, codex: 0, ...opts.epochs };
  const byId = new Map(sessions.map((s) => [s.sessionId, s]));
  const events: string[] = [];
  const intentional = new Set<string>();
  const published: Array<{ id: string; record: CredentialRenewalRecord | null }> = [];
  const failed: Array<{ id: string; failure: TurnFailure }> = [];
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const relaunch = vi.fn(opts.relaunch ?? (async (id: string) => {
    events.push(`relaunch:${id}:marked=${[...intentional].sort().join(",")}`);
    const s = byId.get(id);
    if (s) {
      s.alive = true;
      s.credentialEpochAtLaunch = epochs[s.provider];
    }
    return { ok: true };
  }));
  const deps: CredentialRenewalDeps = {
    listSessions: () => [...byId.values()],
    getSession: (id) => byId.get(id) ?? null,
    currentEpoch: (p) => epochs[p],
    readEpoch: (p) => ({ schemaVersion: 1, epoch: epochs[p], promotedAt: 5_000, fingerprint: "promoted" }),
    isBusy: (id) => byId.get(id)?.busy ?? false,
    stop: async (id) => {
      events.push(`stop:${id}:marked=${intentional.has(id)}`);
      const s = byId.get(id);
      if (s) s.alive = false;
    },
    relaunch,
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
    releaseHeld: (id) => {
      events.push(`release:${id}`);
    },
    failHeld: (id, failure) => {
      failed.push({ id, failure });
      events.push(`fail:${id}`);
    },
    hasPendingSignInRetry: (id) => byId.get(id)?.pendingSignInRetry ?? false,
    now: () => 1_000,
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => {
      (h as { cleared: boolean }).cleared = true;
    },
  };
  const renewal = new CredentialRenewal(deps);
  /** A promotion: the epoch moves, then the settle hook runs (as `promoteCredentials` → wiring does). */
  const promote = (provider: ProviderId) => {
    epochs[provider] += 1;
    renewal.promotionSettled(provider, true, 5_000);
  };
  const fireTimers = () => {
    for (const t of timers.splice(0)) if (!t.cleared) t.fn();
  };
  return { renewal, epochs, events, intentional, published, failed, relaunch, promote, fireTimers, byId };
}

function session(id: string, provider: ProviderId, over: Partial<FakeSession> = {}): FakeSession {
  return { sessionId: id, provider, alive: true, archived: false, containerized: false, credentialEpochAtLaunch: 0, busy: false, ...over };
}

/** Let the fire-and-forget relaunch queue run to completion. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe("needsRenewalRelaunch", () => {
  // The pure decision: only a live, non-archived host session on a LOWER epoch.
  const epochs = { claude: 2, codex: 1 };
  it("is true only for a live host session launched on an older epoch", () => {
    expect(needsRenewalRelaunch(session("a", "claude", { credentialEpochAtLaunch: 1 }), epochs)).toBe(true);
    expect(needsRenewalRelaunch(session("a", "claude", { credentialEpochAtLaunch: 2 }), epochs)).toBe(false);
    expect(needsRenewalRelaunch(session("a", "codex", { credentialEpochAtLaunch: 0 }), epochs)).toBe(true);
  });
  it("treats a session without the field as current (the failure card stays the fallback)", () => {
    expect(needsRenewalRelaunch(session("a", "claude", { credentialEpochAtLaunch: undefined }), epochs)).toBe(false);
  });
  it("skips exited, archived and containerized sessions", () => {
    expect(needsRenewalRelaunch(session("a", "claude", { credentialEpochAtLaunch: 0, alive: false }), epochs)).toBe(false);
    expect(needsRenewalRelaunch(session("a", "claude", { credentialEpochAtLaunch: 0, archived: true }), epochs)).toBe(false);
    expect(needsRenewalRelaunch(session("a", "claude", { credentialEpochAtLaunch: 0, containerized: true }), epochs)).toBe(false);
  });
});

describe("CredentialRenewal — relaunch at the first idle moment", () => {
  it("relaunches idle sessions of the provider one at a time, nothing of the other provider (S3-AC2, Codex)", async () => {
    const h = harness([session("c1", "codex"), session("c2", "codex"), session("k1", "claude")]);
    let inFlight = 0;
    let maxInFlight = 0;
    h.relaunch.mockImplementation(async (id: string) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight--;
      h.byId.get(id)!.credentialEpochAtLaunch = h.epochs.codex;
      return { ok: true };
    });
    h.promote("codex");
    await settle();
    expect(h.relaunch.mock.calls.map((c) => c[0])).toEqual(["c1", "c2"]);
    expect(maxInFlight).toBe(1);
    // The browser learns the promotion time and the end state, never a secret.
    expect(h.published.filter((p) => p.id === "c1").map((p) => p.record?.state)).toEqual(["reconnecting", "renewed"]);
    expect(h.published.find((p) => p.id === "c1")?.record).toEqual({ provider: "codex", promotedAt: 5_000, state: "reconnecting" });
  });

  it("relaunches a busy session only after its turn ends (S3-AC3)", async () => {
    const h = harness([session("c1", "codex", { busy: true })]);
    h.promote("codex");
    await settle();
    expect(h.relaunch).not.toHaveBeenCalled();
    h.byId.get("c1")!.busy = false;
    h.renewal.notePhase("c1", "ready");
    await settle();
    expect(h.relaunch).toHaveBeenCalledTimes(1);
  });

  it("a failed or cancelled sign-in relaunches nothing (S3-AC4)", async () => {
    const h = harness([session("c1", "codex"), session("k1", "claude")]);
    h.renewal.promotionSettled("codex", false, null);
    h.renewal.promotionSettled("claude", false, null);
    await settle();
    expect(h.relaunch).not.toHaveBeenCalled();
    expect(h.published).toEqual([]);
    expect(h.renewal.holdUserMessage("c1")).toBe(false);
  });

  it("skips archived and exited sessions (load: only live non-archived ones)", async () => {
    const h = harness([session("c1", "codex", { archived: true }), session("c2", "codex", { alive: false })]);
    h.promote("codex");
    await settle();
    expect(h.relaunch).not.toHaveBeenCalled();
  });

  it("marks BOTH halves of a council pair intentional before the relaunch kill, and releases them after (EC-2 / EC-52)", async () => {
    const h = harness([
      session("orch", "claude", { peers: ["obs"] }),
      session("obs", "codex", { peers: ["orch"] }),
    ]);
    h.promote("codex");
    await settle();
    expect(h.events).toContain("relaunch:obs:marked=obs,orch");
    expect(h.intentional.size).toBe(0);
  });

  it("releases the marks even when the relaunch throws (EC-52 finally)", async () => {
    const h = harness([session("c1", "codex", { peers: ["p"] })], { relaunch: async () => { throw new Error("spawn failed"); } });
    h.promote("codex");
    await settle();
    expect(h.intentional.size).toBe(0);
    expect(h.failed).toHaveLength(1);
  });
});

describe("CredentialRenewal — gate at the one user_message point", () => {
  it("holds input during the relaunch and delivers it once, after the new process is up (no auto re-send)", async () => {
    let finish!: (r: RelaunchResult) => void;
    const h = harness([session("c1", "codex")], { relaunch: () => new Promise((r) => { finish = r; }) });
    h.promote("codex");
    await settle();
    // Browser message, "Retry" and injected (council / cron / auto-resume) all go through holdUserMessage.
    expect(h.renewal.holdUserMessage("c1")).toBe(true);
    expect(h.renewal.holdUserMessage("c1")).toBe(true);
    expect(h.renewal.isHolding("c1")).toBe(true);
    expect(h.events.filter((e) => e.startsWith("release"))).toEqual([]);
    finish({ ok: true });
    await settle();
    expect(h.events.filter((e) => e === "release:c1")).toHaveLength(1);
    expect(h.renewal.isHolding("c1")).toBe(false);
    // The relaunch itself sent nothing: only the user's own held messages are released.
    expect(h.relaunch).toHaveBeenCalledTimes(1);
  });

  it("two near-simultaneous sends to a stale session trigger ONE relaunch (lazy path, e.g. after a server restart)", async () => {
    const h = harness([session("c1", "codex", { credentialEpochAtLaunch: 0 })], { epochs: { codex: 1 } });
    expect(h.renewal.holdUserMessage("c1")).toBe(true);
    expect(h.renewal.holdUserMessage("c1")).toBe(true);
    await settle();
    expect(h.relaunch).toHaveBeenCalledTimes(1);
    expect(h.events.filter((e) => e === "release:c1")).toHaveLength(1);
  });

  it("does not hold input of a session on the current epoch", () => {
    const h = harness([session("c1", "codex", { credentialEpochAtLaunch: 1 })], { epochs: { codex: 1 } });
    expect(h.renewal.holdUserMessage("c1")).toBe(false);
  });

  it("a failed relaunch drops the held input to a 'repeat this turn' card — the message is not lost and not sent", async () => {
    const h = harness([session("c1", "codex")], { relaunch: async () => ({ ok: false, error: "no binary" }) });
    h.promote("codex");
    await settle();
    expect(h.failed).toEqual([
      { id: "c1", failure: { kind: "stale_session_credentials", provider: "codex", providerMessage: "Reconnecting with the new sign-in failed: no binary" } },
    ]);
    expect(h.events).not.toContain("release:c1");
    expect(h.published.at(-1)?.record?.state).toBe("failed");
  });

  it("a council wake to a session being renewed is held, then caught up once after the relaunch", async () => {
    const onRelaunched = vi.fn();
    let finish!: (r: RelaunchResult) => void;
    const h = harness([session("obs", "codex", { peers: ["orch"] }), session("orch", "claude", { peers: ["obs"] })], {
      relaunch: () => new Promise((r) => { finish = r; }),
    });
    (h.renewal as unknown as { deps: CredentialRenewalDeps }).deps.onRelaunched = onRelaunched;
    h.promote("codex");
    await settle();
    expect(h.renewal.isHolding("obs")).toBe(true);
    expect(h.renewal.isHolding("orch")).toBe(false);
    finish({ ok: true });
    await settle();
    expect(onRelaunched).toHaveBeenCalledTimes(1);
    expect(onRelaunched).toHaveBeenCalledWith("obs");
  });
});

describe("CredentialRenewal — Claude barrier before the rename", () => {
  it("stops idle live Claude processes (marked intentional first) before the promotion, relaunches them after", async () => {
    const h = harness([session("k1", "claude"), session("k2", "claude"), session("c1", "codex")]);
    await h.renewal.beforePromote("claude");
    expect(h.events).toEqual(["stop:k1:marked=true", "stop:k2:marked=true"]);
    expect(h.renewal.isHolding("k1")).toBe(true);
    h.promote("claude");
    await settle();
    expect(h.relaunch.mock.calls.map((c) => c[0])).toEqual(["k1", "k2"]);
    expect(h.intentional.size).toBe(0);
    expect(h.renewal.isHolding("k1")).toBe(false);
  });

  it("waits for a busy Claude session's turn before stopping it", async () => {
    const h = harness([session("k1", "claude", { busy: true })]);
    const barrier = h.renewal.beforePromote("claude");
    await settle();
    expect(h.events).toEqual([]);
    h.byId.get("k1")!.busy = false;
    h.renewal.notePhase("k1", "ready");
    await barrier;
    expect(h.events).toEqual(["stop:k1:marked=true"]);
  });

  it("on timeout lets the promotion proceed and relaunches the still-busy session after its turn, with a warning count", async () => {
    const h = harness([session("k1", "claude", { busy: true })]);
    const barrier = h.renewal.beforePromote("claude");
    await settle();
    h.fireTimers();
    await barrier;
    expect(h.events).toEqual([]);
    expect(h.renewal.summary("claude").busyAtPromotion).toBe(1);
    h.promote("claude");
    await settle();
    expect(h.relaunch).not.toHaveBeenCalled();
    h.byId.get("k1")!.busy = false;
    h.renewal.notePhase("k1", "ready");
    await settle();
    expect(h.relaunch).toHaveBeenCalledTimes(1);
  });

  it("is a no-op for Codex: sessions write their own copy, never the primary file being replaced", async () => {
    const h = harness([session("c1", "codex"), session("k1", "claude")]);
    await h.renewal.beforePromote("codex");
    expect(h.events).toEqual([]);
    expect(h.renewal.isHolding("c1")).toBe(false);
  });

  it("a promotion that fails after the barrier brings the stopped sessions back, on the unchanged sign-in", async () => {
    const h = harness([session("k1", "claude")]);
    await h.renewal.beforePromote("claude");
    h.renewal.promotionSettled("claude", false, null);
    await settle();
    expect(h.relaunch).toHaveBeenCalledTimes(1);
    // No "renewed"/"reconnecting" record: the session did not move to anything new.
    expect(h.published.every((p) => p.record === null)).toBe(true);
    expect(h.intentional.size).toBe(0);
  });
});

describe("CredentialRenewal — turn failures and summary", () => {
  it("re-tags auth_rejected of a session still on the old epoch as stale_session_credentials", () => {
    const h = harness([session("k1", "claude", { credentialEpochAtLaunch: 0 }), session("k2", "claude", { credentialEpochAtLaunch: 1 })], { epochs: { claude: 1 } });
    const failure: TurnFailure = { kind: "auth_rejected", provider: "claude", providerMessage: "401", credentialsCompared: false };
    expect(h.renewal.adjustTurnFailure("k1", failure)).toEqual({ kind: "stale_session_credentials", provider: "claude", providerMessage: "401" });
    expect(h.renewal.adjustTurnFailure("k2", failure)).toBe(failure);
  });

  it("counts sessions moving to the new sign-in and those waiting for the user's Retry", async () => {
    const h = harness([session("c1", "codex", { busy: true }), session("c2", "codex", { pendingSignInRetry: true, credentialEpochAtLaunch: 1 })]);
    h.promote("codex");
    expect(h.renewal.summary("codex")).toMatchObject({ reconnecting: 1, awaitingRetry: 1 });
  });
});

// ─── With the real promotion (synthetic files in a tmp "live" HOME) ─────────

describe("CredentialRenewal + promoteCredentials (barrier ordering, S3-AC4)", () => {
  // The barrier must run BEFORE the rename: while a live Claude process is
  // still running its turn, the live credential file stays the old one.
  // All credentials are generated SYNTH-CANARY strings; nothing real is read.
  const synth = (label: string) => JSON.stringify({ claudeAiOauth: { accessToken: `SYNTH-CANARY-${label}-a`, refreshToken: `SYNTH-CANARY-${label}-r`, expiresAt: Date.now() + 3_600_000, subscriptionType: "max" } });

  function setup() {
    const root = mkdtempSync(join(tmpdir(), "renewal-"));
    const liveHome = join(root, "live");
    const stateDir = join(root, "state");
    mkdirSync(join(liveHome, ".claude"), { recursive: true, mode: 0o700 });
    const livePath = join(liveHome, ".claude", ".credentials.json");
    writeFileSync(livePath, synth("old"), { mode: 0o600 });
    const attemptDir = join(root, "attempts", "0123456789abcdef0123456789abcdef");
    const stagingHome = join(attemptDir, STAGING_HOME_DIR);
    mkdirSync(join(stagingHome, ".claude"), { recursive: true, mode: 0o700 });
    writeFileSync(join(stagingHome, ".claude", ".credentials.json"), synth("new"), { mode: 0o600 });
    const status = (state: ProviderAuthStatus["state"]): ProviderAuthStatus => ({
      provider: "claude", state, reason: null, account: knownField("synthetic@example.test"), plan: knownField("max"),
      method: knownField("subscription"), tokenExpiresAt: unknownField, lastSuccessAt: 1, checkedAt: 1, verifiedBy: "provider",
      cli: { path: unknownField, version: unknownField },
    });
    const ctx = { attemptId: "0123456789abcdef0123456789abcdef", provider: "claude" as const, attemptDir, stagingHome };
    return { root, livePath, stateDir, ctx, status, liveHome };
  }

  it("does not rename while a live Claude session is still busy; renames after it stops; relaunches it on the new epoch", async () => {
    const env = setup();
    try {
      const h = harness([session("k1", "claude", { busy: true })]);
      const deps: PromotionDeps = {
        serviceEnv: { HOME: env.liveHome },
        stateDir: env.stateDir,
        uid: process.getuid!(),
        probeStaged: async () => env.status("working"),
        codexTokenFingerprint: codexTokenFingerprintAt,
        beforePromote: (p) => h.renewal.beforePromote(p),
        noteCredentialsPromoted: () => {},
        now: () => 7_000,
      };
      // The real epoch file drives the harness epoch.
      (h.renewal as unknown as { deps: CredentialRenewalDeps }).deps.currentEpoch = (p) => readEpochFile(env.stateDir, p)?.epoch ?? 0;
      const pending = promoteAndRenew(env.ctx, deps, h.renewal);
      await settle();
      expect(readFileSync(env.livePath, "utf-8")).toContain("SYNTH-CANARY-old");
      expect(h.events).toEqual([]);
      h.byId.get("k1")!.busy = false;
      h.renewal.notePhase("k1", "ready");
      const out = await pending;
      expect(out.ok).toBe(true);
      expect(h.events[0]).toBe("stop:k1:marked=true");
      expect(readFileSync(env.livePath, "utf-8")).toContain("SYNTH-CANARY-new");
      await settle();
      expect(h.relaunch).toHaveBeenCalledTimes(1);
      expect(h.published.at(-1)?.record).toEqual({ provider: "claude", promotedAt: 7_000, state: "renewed" });
    } finally {
      rmSync(env.root, { recursive: true, force: true });
    }
  });

  it("a sign-in the provider rejects stops nothing and relaunches nothing (S3-AC4)", async () => {
    const env = setup();
    try {
      const h = harness([session("k1", "claude"), session("c1", "codex")]);
      const deps: PromotionDeps = {
        serviceEnv: { HOME: env.liveHome },
        stateDir: env.stateDir,
        uid: process.getuid!(),
        probeStaged: async () => env.status("invalid"),
        codexTokenFingerprint: codexTokenFingerprintAt,
        beforePromote: (p) => h.renewal.beforePromote(p),
        noteCredentialsPromoted: () => {},
      };
      const out = await promoteAndRenew(env.ctx, deps, h.renewal);
      await settle();
      expect(out.ok).toBe(false);
      expect(h.events).toEqual([]);
      expect(h.relaunch).not.toHaveBeenCalled();
      expect(h.published).toEqual([]);
      expect(readFileSync(env.livePath, "utf-8")).toContain("SYNTH-CANARY-old");
    } finally {
      rmSync(env.root, { recursive: true, force: true });
    }
  });
});

describe("CredentialRenewal — overwrite watch (from 2a: credentials replaced by a running session)", () => {
  it("flags the provider when the live file stops matching the promoted fingerprint within the watch window", async () => {
    const h = harness([]);
    let live = "promoted";
    (h.renewal as unknown as { deps: CredentialRenewalDeps }).deps.liveFingerprint = () => live;
    h.promote("claude");
    h.fireTimers();
    expect(h.renewal.summary("claude").credentialsReplaced).toBe(false);
    live = "something-else";
    h.fireTimers();
    expect(h.renewal.summary("claude").credentialsReplaced).toBe(true);
  });
});
