import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// The status core and the Codex evidence store are process singletons backed
// by the real service HOME — replaced here so nothing real is read or written.
const mocks = vi.hoisted(() => ({
  noteCredentialsPromoted: vi.fn(async () => {}),
  recordCodexLoginEvidence: vi.fn(),
}));
vi.mock("../auth-status/service-status.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth-status/service-status.js")>()),
  getServiceAuthStatusCore: () => ({ noteCredentialsPromoted: mocks.noteCredentialsPromoted }),
}));
vi.mock("../auth-status/codex-provider-evidence.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth-status/codex-provider-evidence.js")>()),
  recordCodexLoginEvidence: mocks.recordCodexLoginEvidence,
}));

import { CredentialRenewal, setCredentialRenewal } from "../credential-renewal.js";
import type { PromotionDeps } from "./credential-promotion.js";
import {
  _resetLoginWiringForTest,
  getServiceLoginAttempts,
  noteCredentialsPromoted,
  promoteAndRenew,
  servicePromotionDeps,
  shutdownServiceLoginAttempts,
  startServiceLoginRecovery,
} from "./login-wiring.js";

/**
 * Server wiring of the sign-in registry (phase 2b task 8; handoff "what 2b
 * must connect"). Pinned:
 * - startup runs the promotion recovery BEFORE the orphan sweep — the
 *   recovery may still need an attempt dir the sweep would delete;
 * - a throwing step is logged and the next one still runs (EC-53), the
 *   returned promise never rejects (the start route awaits it);
 * - it runs once per process (idempotent), and the registry is a singleton.
 */
afterEach(() => {
  _resetLoginWiringForTest();
  setCredentialRenewal(null);
  vi.clearAllMocks();
});

describe("startServiceLoginRecovery", () => {
  it("recovers promotions first, then sweeps", async () => {
    const order: string[] = [];
    await startServiceLoginRecovery({
      recover: async () => { await new Promise((r) => setTimeout(r, 10)); order.push("recover"); },
      sweep: async () => { order.push("sweep"); },
    });
    expect(order).toEqual(["recover", "sweep"]);
  });

  it("a failing recovery still lets the sweep run, and never rejects", async () => {
    const sweep = vi.fn(async () => {});
    await expect(startServiceLoginRecovery({ recover: async () => { throw new Error("boom"); }, sweep })).resolves.toBeUndefined();
    expect(sweep).toHaveBeenCalledOnce();
  });

  it("a failing sweep never rejects", async () => {
    await expect(startServiceLoginRecovery({ recover: async () => {}, sweep: async () => { throw new Error("boom"); } })).resolves.toBeUndefined();
  });

  it("runs once per process", async () => {
    const recover = vi.fn(async () => {});
    const sweep = vi.fn(async () => {});
    await Promise.all([startServiceLoginRecovery({ recover, sweep }), startServiceLoginRecovery({ recover, sweep })]);
    expect(recover).toHaveBeenCalledOnce();
  });
});

describe("getServiceLoginAttempts", () => {
  it("is one registry per server", () => {
    expect(getServiceLoginAttempts()).toBe(getServiceLoginAttempts());
  });
});

describe("noteCredentialsPromoted", () => {
  // S1-AC2: after a promotion the status is recomputed without the recheck
  // limit; Codex also gets its D8 sign-in evidence (Claude has none).
  it("Codex: records the sign-in evidence bound to the token fingerprint, then refreshes the status", async () => {
    await noteCredentialsPromoted({ provider: "codex", fingerprint: "f", tokenFingerprint: "tok", promotedAt: 42 });
    expect(mocks.recordCodexLoginEvidence).toHaveBeenCalledWith({ checkedAt: 42, credentialFingerprint: "tok" });
    expect(mocks.noteCredentialsPromoted).toHaveBeenCalledOnce();
  });

  it("Claude: no evidence; a failing status refresh is logged, never thrown", async () => {
    mocks.noteCredentialsPromoted.mockRejectedValueOnce(new Error("down"));
    await expect(noteCredentialsPromoted({ provider: "claude", fingerprint: "f", tokenFingerprint: null, promotedAt: 1 })).resolves.toBeUndefined();
    expect(mocks.recordCodexLoginEvidence).not.toHaveBeenCalled();
  });
});

describe("servicePromotionDeps", () => {
  it("routes the barrier to the server's credential renewal (absent → no-op) and lets callers override", async () => {
    const before = servicePromotionDeps();
    await expect(before.beforePromote!("claude")).resolves.toBeUndefined();
    const renewal = { beforePromote: vi.fn(async () => {}) } as unknown as CredentialRenewal;
    setCredentialRenewal(renewal);
    await servicePromotionDeps().beforePromote!("claude");
    expect(renewal.beforePromote).toHaveBeenCalledWith("claude");
    expect(servicePromotionDeps({ stateDir: "/x" }).stateDir).toBe("/x");
  });
});

describe("promoteAndRenew", () => {
  // Phase 2d: the live sessions follow the promotion's outcome. Failure (or a
  // throw) settles as "not promoted" — the renewal relaunches nobody new.
  function deps(stateDir: string, over: Partial<PromotionDeps> = {}): PromotionDeps {
    return {
      serviceEnv: { HOME: join(stateDir, "home") },
      stateDir,
      uid: process.getuid?.() ?? -1,
      probeStaged: async () => { throw new Error("unused"); },
      codexTokenFingerprint: () => null,
      noteCredentialsPromoted: () => {},
      ...over,
    };
  }
  const ctx = (root: string) => ({ attemptId: "a".repeat(32), provider: "claude" as const, attemptDir: join(root, "attempt"), stagingHome: join(root, "attempt", "home") });

  it("a refused promotion settles as failed", async () => {
    const root = mkdtempSync(join(tmpdir(), "wiring-"));
    try {
      mkdirSync(join(root, "attempt", "home"), { recursive: true });
      const renewal = { promotionSettled: vi.fn() } as unknown as CredentialRenewal;
      const out = await promoteAndRenew(ctx(root), deps(root), renewal);
      expect(out.ok).toBe(false);
      expect(renewal.promotionSettled).toHaveBeenCalledWith("claude", false, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a promotion that throws (crash simulation) settles as failed and rethrows", async () => {
    const root = mkdtempSync(join(tmpdir(), "wiring-"));
    try {
      const renewal = { promotionSettled: vi.fn() } as unknown as CredentialRenewal;
      const boom = new Error("boom");
      // A deps object that throws on first use stands in for a crash inside the promotion.
      const d = deps(root, { stateDir: root });
      Object.defineProperty(d, "stateDir", { get: () => { throw boom; } });
      await expect(promoteAndRenew(ctx(root), d, renewal)).rejects.toBe(boom);
      expect(renewal.promotionSettled).toHaveBeenCalledWith("claude", false, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("shutdownServiceLoginAttempts", () => {
  it("is a no-op without a registry and ends the registry's attempts otherwise", async () => {
    await expect(shutdownServiceLoginAttempts()).resolves.toBeUndefined();
    const registry = getServiceLoginAttempts();
    const shutdown = vi.spyOn(registry, "shutdown").mockResolvedValue(undefined);
    await shutdownServiceLoginAttempts();
    expect(shutdown).toHaveBeenCalledOnce();
  });
});
