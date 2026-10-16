/**
 * Auto-resume executor — what happens when a usage-limit schedule fires.
 *
 * Validates: a live solo session gets the continuation prompt injected
 * (no relaunch); a dead session is relaunched FIRST and then injected (the
 * bridge queues the frame until the new CLI attaches); a failed relaunch does
 * not inject; archived/missing sessions are skipped; for a Council pair the
 * orchestrator is resumed and a dead observer is relaunched too; when the
 * OBSERVER half hit the limit it is revived and re-woken (never sent a
 * "continue" user prompt — observer turns are wake-driven).
 */
import { describe, it, expect, vi } from "vitest";
import { createAutoResumeExecutor, AUTO_RESUME_PROMPT, type AutoResumeExecutorDeps } from "./auto-resume-executor.js";
import type { AutoResumeSchedule } from "./auto-resume-scheduler.js";

function schedule(overrides: Partial<AutoResumeSchedule> = {}): AutoResumeSchedule {
  return {
    sessionId: "orch",
    backend: "claude",
    model: "claude-opus-5-5",
    resetAt: 1,
    resetSource: "rate_limit_event",
    limitType: "five_hour",
    role: "solo",
    sessionGroupId: null,
    fireAt: 2,
    scheduledAt: 0,
    ...overrides,
  };
}

function deps(state: {
  alive?: Record<string, boolean>;
  archived?: Record<string, boolean>;
  missing?: string[];
  group?: { sessionGroupId: string; orchestratorSessionId: string; observerSessionId: string } | null;
  relaunchOk?: boolean;
}) {
  const calls: string[] = [];
  const d: AutoResumeExecutorDeps = {
    getSession: (id) => (state.missing?.includes(id) ? undefined : { archived: state.archived?.[id] ?? false }),
    isAlive: (id) => state.alive?.[id] ?? true,
    relaunch: vi.fn(async (id: string) => {
      calls.push(`relaunch:${id}`);
      return state.relaunchOk === false ? { ok: false, error: "spawn failed" } : { ok: true };
    }),
    findGroup: () => state.group ?? null,
    inject: vi.fn((id: string, content: string) => {
      calls.push(`inject:${id}:${content}`);
    }),
    wakeObserver: vi.fn((groupId: string) => {
      calls.push(`wake:${groupId}`);
    }),
  };
  return { d, calls };
}

const GROUP = { sessionGroupId: "grp_1", orchestratorSessionId: "orch", observerSessionId: "obs" };

describe("createAutoResumeExecutor", () => {
  it("live solo session: injects the continuation prompt without relaunching", async () => {
    const { d, calls } = deps({});
    const out = await createAutoResumeExecutor(d)(schedule());
    expect(calls).toEqual([`inject:orch:${AUTO_RESUME_PROMPT}`]);
    expect(out).toMatchObject({ ok: true, outcome: "injected", relaunched: false });
  });

  it("dead session: relaunches first, then injects", async () => {
    const { d, calls } = deps({ alive: { orch: false } });
    const out = await createAutoResumeExecutor(d)(schedule());
    expect(calls).toEqual(["relaunch:orch", `inject:orch:${AUTO_RESUME_PROMPT}`]);
    expect(out).toMatchObject({ ok: true, relaunched: true });
  });

  it("failed relaunch: reports the error and does not inject", async () => {
    const { d, calls } = deps({ alive: { orch: false }, relaunchOk: false });
    const out = await createAutoResumeExecutor(d)(schedule());
    expect(calls).toEqual(["relaunch:orch"]);
    expect(out).toMatchObject({ ok: false, outcome: "relaunch_failed", error: "spawn failed" });
  });

  it("archived or deleted session: skipped", async () => {
    for (const st of [{ archived: { orch: true } }, { missing: ["orch"] }]) {
      const { d, calls } = deps(st);
      const out = await createAutoResumeExecutor(d)(schedule());
      expect(calls).toEqual([]);
      expect(out).toMatchObject({ ok: false, outcome: "session_gone" });
    }
  });

  it("council orchestrator: injects into the orchestrator and relaunches a dead observer", async () => {
    const { d, calls } = deps({ alive: { orch: true, obs: false }, group: GROUP });
    const out = await createAutoResumeExecutor(d)(schedule({ role: "orchestrator", sessionGroupId: "grp_1" }));
    expect(calls).toEqual(["relaunch:obs", `inject:orch:${AUTO_RESUME_PROMPT}`]);
    expect(out).toMatchObject({ ok: true, outcome: "injected", partnerRelaunched: true });
  });

  it("council orchestrator with both halves dead: relaunches both, injects into the orchestrator only", async () => {
    const { d, calls } = deps({ alive: { orch: false, obs: false }, group: GROUP });
    await createAutoResumeExecutor(d)(schedule({ role: "orchestrator", sessionGroupId: "grp_1" }));
    expect(calls).toEqual(["relaunch:orch", "relaunch:obs", `inject:orch:${AUTO_RESUME_PROMPT}`]);
  });

  it("council observer hit the limit: revived + re-woken, never sent a user prompt", async () => {
    const { d, calls } = deps({ alive: { orch: true, obs: false }, group: GROUP });
    const out = await createAutoResumeExecutor(d)(schedule({ sessionId: "obs", role: "observer", sessionGroupId: "grp_1", backend: "codex" }));
    expect(calls).toEqual(["relaunch:obs", "wake:grp_1"]);
    expect(d.inject).not.toHaveBeenCalled();
    expect(out).toMatchObject({ ok: true, outcome: "observer_woken", relaunched: true });
  });

  it("an archived partner is not relaunched", async () => {
    const { d, calls } = deps({ alive: { obs: false }, archived: { obs: true }, group: GROUP });
    await createAutoResumeExecutor(d)(schedule({ role: "orchestrator" }));
    expect(calls).toEqual([`inject:orch:${AUTO_RESUME_PROMPT}`]);
  });
});
