import { afterEach, describe, expect, it, vi } from "vitest";
import { _resetLoginWiringForTest, getServiceLoginAttempts, startServiceLoginRecovery } from "./login-wiring.js";

/**
 * Server wiring of the sign-in registry (phase 2b task 8; handoff "what 2b
 * must connect"). Pinned:
 * - startup runs the promotion recovery BEFORE the orphan sweep — the
 *   recovery may still need an attempt dir the sweep would delete;
 * - a throwing step is logged and the next one still runs (EC-53), the
 *   returned promise never rejects (the start route awaits it);
 * - it runs once per process (idempotent), and the registry is a singleton.
 */
afterEach(() => _resetLoginWiringForTest());

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
