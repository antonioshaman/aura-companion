/**
 * Tests for the subscription usage ceiling (P6/USAGE-CEILING, human decision
 * 2026-09-28: the bench may burn at most 75% of the weekly Claude limit and
 * must not start a cell while the 5-hour window is ≥ 90%).
 *
 * Validates:
 *   - the gate opens strictly below the ceiling and closes AT it (≥, not >),
 *     for both the weekly and the 5-hour window;
 *   - fail-closed: unreachable endpoint, HTTP error, non-JSON body, the
 *     server's all-null error shape, and a non-numeric utilization all hold;
 *   - the one tolerated gap: `five_hour: null` with a valid `seven_day` (the
 *     5-hour window has not started) — the weekly gate still decides;
 *   - env parsing: defaults 75/90, overrides honoured, garbage/out-of-range
 *     values fall back to the default instead of disabling the ceiling;
 *   - the driver asks the gate before every cell start, sleeps 15 min per
 *     hold with a `usage-ceiling hold` log line carrying the numbers and
 *     `resets_at`, runs nothing while held, and resumes the same cell.
 */

import { describe, it, expect } from "vitest";
import {
  DEFAULT_FIVE_HOUR_CEILING,
  DEFAULT_WEEKLY_CEILING,
  USAGE_HOLD_POLL_MS,
  USAGE_LIMITS_URL,
  evaluateUsageGate,
  fetchUsageGate,
  usageCeilingsFromEnv,
  type UsageGate,
} from "./usage-ceiling.js";
import { runAblation, type DriverDeps } from "./driver.js";
import { CELL_RECORD_VERSION, type CellRecord } from "./cells.js";
import { emptyMetrics } from "./agent-metrics.js";

const C = { weekly: 75, fiveHour: 90 };

// Verbatim shape of the prod `/api/usage-limits` response (2026-09-29).
const body = (seven: number | null, five: number | null) => ({
  five_hour: five === null ? null : { utilization: five, resets_at: "2026-09-29T13:30:00.243321+00:00", limit_dollars: null },
  seven_day: seven === null ? null : { utilization: seven, resets_at: "2026-09-30T12:00:00.243345+00:00", limit_dollars: null },
  extra_usage: { is_enabled: false, monthly_limit: 10000, used_credits: 0, utilization: 0 },
});

describe("evaluateUsageGate", () => {
  it("opens below both ceilings", () => {
    expect(evaluateUsageGate(body(37, 7), C)).toEqual({ ok: true, sevenDay: 37, fiveHour: 7 });
    expect(evaluateUsageGate(body(74.9, 89.9), C).ok).toBe(true);
  });

  it("holds at and above the weekly ceiling, reporting the weekly reset", () => {
    for (const u of [75, 80, 100]) {
      const g = evaluateUsageGate(body(u, 7), C);
      expect(g.ok).toBe(false);
      if (!g.ok) {
        expect(g.reason).toContain("seven_day");
        expect(g.resetsAt).toBe("2026-09-30T12:00:00.243345+00:00");
      }
    }
  });

  it("holds at and above the 5-hour ceiling, reporting the 5-hour reset", () => {
    const g = evaluateUsageGate(body(10, 90), C);
    expect(g.ok).toBe(false);
    if (!g.ok) {
      expect(g.reason).toContain("five_hour");
      expect(g.resetsAt).toBe("2026-09-29T13:30:00.243321+00:00");
    }
  });

  it("fails closed on a missing or invalid weekly window", () => {
    // The server's error shape: every window null (credentials/upstream failure).
    // Still a hold — and since P6/FIX-D2-CLAUDE-AUTH a FATAL one (prod OAuth dead).
    expect(evaluateUsageGate({ five_hour: null, seven_day: null, extra_usage: null }, C)).toMatchObject({ ok: false, fatal: true });
    // A missing weekly window next to a live 5-hour one is a plain hold, not fatal.
    const partial = evaluateUsageGate({ five_hour: { utilization: 5 }, seven_day: null }, C);
    expect(partial.ok).toBe(false);
    if (!partial.ok) expect(partial.fatal).toBeUndefined();
    expect(evaluateUsageGate({ seven_day: { utilization: "37" } }, C).ok).toBe(false);
    expect(evaluateUsageGate({ seven_day: { utilization: null } }, C).ok).toBe(false);
    expect(evaluateUsageGate(null, C).ok).toBe(false);
    expect(evaluateUsageGate([], C).ok).toBe(false);
  });

  it("fails closed on a malformed 5-hour window, tolerates an absent one", () => {
    expect(evaluateUsageGate({ seven_day: { utilization: 10 }, five_hour: { utilization: NaN } }, C).ok).toBe(false);
    expect(evaluateUsageGate({ seven_day: { utilization: 10 }, five_hour: "x" }, C).ok).toBe(false);
    // Window not started → null; the weekly gate still decides.
    expect(evaluateUsageGate(body(10, null), C)).toEqual({ ok: true, sevenDay: 10, fiveHour: null });
    expect(evaluateUsageGate(body(75, null), C).ok).toBe(false);
  });
});

describe("usageCeilingsFromEnv", () => {
  it("defaults to 75 / 90", () => {
    expect(usageCeilingsFromEnv({})).toEqual({ weekly: DEFAULT_WEEKLY_CEILING, fiveHour: DEFAULT_FIVE_HOUR_CEILING });
    expect(DEFAULT_WEEKLY_CEILING).toBe(75);
    expect(DEFAULT_FIVE_HOUR_CEILING).toBe(90);
  });

  it("honours valid overrides", () => {
    expect(usageCeilingsFromEnv({ AURABENCH_WEEKLY_CEILING: "60", AURABENCH_FIVE_HOUR_CEILING: "50.5" })).toEqual({
      weekly: 60,
      fiveHour: 50.5,
    });
  });

  it("falls back to the default on garbage or out-of-range values (never disables the ceiling)", () => {
    for (const v of ["", "abc", "0", "-5", "101", "Infinity", "NaN"]) {
      expect(usageCeilingsFromEnv({ AURABENCH_WEEKLY_CEILING: v, AURABENCH_FIVE_HOUR_CEILING: v })).toEqual({
        weekly: 75,
        fiveHour: 90,
      });
    }
  });
});

describe("fetchUsageGate", () => {
  const res = (status: number, text: string) => async () => ({ ok: status < 400, status, text: async () => text });

  it("reads the prod loopback endpoint and evaluates the body", async () => {
    let asked = "";
    const g = await fetchUsageGate(async (url, init) => {
      asked = url;
      return res(200, JSON.stringify(body(37, 7)))();
    }, C);
    expect(asked).toBe(USAGE_LIMITS_URL);
    expect(asked).toBe("http://localhost:3456/api/usage-limits");
    expect(g.ok).toBe(true);
  });

  it("holds when the endpoint is unreachable, errors, or returns non-JSON", async () => {
    const down = await fetchUsageGate(async () => {
      throw new Error("ECONNREFUSED");
    }, C);
    expect(down.ok).toBe(false);
    if (!down.ok) expect(down.reason).toContain("unreachable");
    expect((await fetchUsageGate(res(500, "{}"), C)).ok).toBe(false);
    expect((await fetchUsageGate(res(200, "<html>"), C)).ok).toBe(false);
  });
});

describe("runAblation with the usage gate", () => {
  const rec = (key: string): CellRecord => {
    const [task_id, variant, rep] = key.split("|");
    return {
      v: CELL_RECORD_VERSION,
      key,
      task_id: task_id!,
      task_class: "bugfix",
      variant: variant as "A",
      rep: Number(rep),
      status: "completed",
      success: true,
      hidden: null,
      regressions: null,
      diff: null,
      metrics: emptyMetrics(),
      wall_clock_ms: 1,
      started_at: "",
      finished_at: "",
      isolation: {},
      confounds: [],
    };
  };

  function setup(gates: UsageGate[]) {
    const events: string[] = [];
    const logs: string[] = [];
    const d: DriverDeps = {
      taskIds: ["t1"],
      variants: ["A", "C"],
      reps: 1,
      readResults: () => "",
      appendResult: (r) => events.push(`record ${r.key}`),
      runCell: async (c) => {
        events.push(`run ${c.key}`);
        return { kind: "record", record: rec(c.key) };
      },
      memAvailableKb: () => 8 * 1024 * 1024,
      usageGate: async () => {
        const g = gates.shift() ?? { ok: true, sevenDay: 1, fiveHour: 1 };
        events.push(`gate ${g.ok ? "open" : "hold"}`);
        return g;
      },
      sleep: async (ms) => {
        events.push(`sleep ${ms}`);
      },
      now: () => 0,
      log: (l) => logs.push(l),
    };
    return { d, events, logs };
  }

  const hold: UsageGate = {
    ok: false,
    reason: "seven_day 80% >= ceiling 75%",
    sevenDay: 80,
    fiveHour: 12,
    resetsAt: "2026-09-30T12:00:00Z",
  };

  it("asks the gate before every cell and runs nothing while held", async () => {
    const { d, events, logs } = setup([hold, hold]);
    const s = await runAblation(d);
    expect(events).toEqual([
      "gate hold",
      `sleep ${USAGE_HOLD_POLL_MS}`,
      "gate hold",
      `sleep ${USAGE_HOLD_POLL_MS}`,
      "gate open",
      "run t1|A|1",
      "record t1|A|1",
      "gate open",
      "run t1|C|1",
      "record t1|C|1",
    ]);
    expect(USAGE_HOLD_POLL_MS).toBe(15 * 60_000);
    expect(s.usageHolds).toBe(2);
    const line = logs.find((l) => l.includes("usage-ceiling hold"))!;
    expect(line).toContain("seven_day 80%");
    expect(line).toContain("five_hour 12%");
    expect(line).toContain("resets_at 2026-09-30T12:00:00Z");
  });

  // P6/FIX-D2-CLAUDE-AUTH: on 2026-09-30 prod's Claude OAuth was dead and the
  // gate held silently for 3 h. A fatal answer is re-confirmed, then the run STOPS.
  const dead: UsageGate = { ok: false, fatal: true, reason: "prod Claude OAuth looks dead", sevenDay: null, fiveHour: null, resetsAt: null };

  it("stops the run on a confirmed fatal gate instead of holding", async () => {
    const { d, events, logs } = setup([dead, dead, dead]);
    const s = await runAblation(d);
    expect(events).toEqual(["gate hold", "sleep 60000", "gate hold", "sleep 60000", "gate hold"]);
    expect(s.stoppedOnAuth).toBe("prod Claude OAuth looks dead");
    expect(s.recorded).toBe(0);
    expect(s.usageHolds).toBe(0);
    expect(logs.some((l) => l.includes("STOP: prod Claude OAuth looks dead"))).toBe(true);
  });

  it("a fatal blip that recovers within the confirmations does not stop the run", async () => {
    const { d, events } = setup([dead, dead]);
    const s = await runAblation(d);
    expect(s.stoppedOnAuth).toBeNull();
    expect(events.slice(0, 6)).toEqual(["gate hold", "sleep 60000", "gate hold", "sleep 60000", "gate open", "run t1|A|1"]);
    expect(s.recorded).toBe(2);
  });

  it("passes the planned cell to the gate (its timeout decides the token check)", async () => {
    const { d } = setup([]);
    const seen: string[] = [];
    const inner = d.usageGate!;
    d.usageGate = async (c) => {
      seen.push(c.key);
      return inner(c);
    };
    await runAblation(d);
    expect(seen).toEqual(["t1|A|1", "t1|C|1"]);
  });

  it("re-checks the gate before retrying a limit-interrupted cell", async () => {
    const { d, events } = setup([]);
    let first = true;
    d.runCell = async (c) => {
      events.push(`run ${c.key}`);
      if (first) {
        first = false;
        return { kind: "limit", limit: { resetAt: null, message: "session limit" } };
      }
      return { kind: "record", record: rec(c.key) };
    };
    await runAblation(d);
    expect(events.slice(0, 5)).toEqual(["gate open", "run t1|A|1", "sleep 1200000", "gate open", "run t1|A|1"]);
  });
});
