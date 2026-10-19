/**
 * Subscription usage ceiling for the AuraBench driver (P6/USAGE-CEILING).
 *
 * The bench shares the Claude subscription with the working pairs on this
 * box, so before EVERY cell the driver asks the prod server's
 * `GET /api/usage-limits` (loopback, read-only) and holds while:
 *
 *  - `seven_day.utilization` ≥ the weekly ceiling (env
 *    `AURABENCH_WEEKLY_CEILING`, default 75), or
 *  - `five_hour.utilization` ≥ the 5-hour ceiling (env
 *    `AURABENCH_FIVE_HOUR_CEILING`, default 90).
 *
 * Fail-closed: an unreachable endpoint, a non-JSON body, or a missing /
 * non-numeric `seven_day.utilization` is a hold, never a blind start. The one
 * tolerated gap is `five_hour: null` next to a valid `seven_day` — upstream
 * reports no object for a 5-hour window that has not started, and the server
 * maps that to null (`data.five_hour || null`); the weekly gate still applies.
 * A malformed `five_hour` object is a hold. Invalid env values fall back to
 * the default (never "no ceiling").
 *
 * P6/FIX-D2-CLAUDE-AUTH: the all-null body (`five_hour`, `seven_day` both
 * null) is the server's shape when prod's Claude OAuth cannot be read or
 * refreshed. On 2026-09-30 that meant prod was logged out, and the gate held
 * silently for 3 h. It is now `fatal`: the driver re-confirms it and then
 * STOPS the run for a human instead of waiting.
 *
 * Pure except `fetchUsageGate` (injected fetch). Firewall-clean.
 */

export const USAGE_LIMITS_URL = "http://localhost:3456/api/usage-limits";
export const DEFAULT_WEEKLY_CEILING = 75;
export const DEFAULT_FIVE_HOUR_CEILING = 90;
export const USAGE_HOLD_POLL_MS = 15 * 60_000;

export interface UsageCeilings {
  weekly: number;
  fiveHour: number;
}

export type UsageGate =
  | { ok: true; sevenDay: number; fiveHour: number | null }
  | { ok: false; reason: string; sevenDay: number | null; fiveHour: number | null; resetsAt: string | null; fatal?: boolean };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** A ceiling in (0, 100]; anything else (unset, NaN, 0, 150, "abc") → default. */
function parseCeiling(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : fallback;
}

export function usageCeilingsFromEnv(env: Record<string, string | undefined>): UsageCeilings {
  return {
    weekly: parseCeiling(env.AURABENCH_WEEKLY_CEILING, DEFAULT_WEEKLY_CEILING),
    fiveHour: parseCeiling(env.AURABENCH_FIVE_HOUR_CEILING, DEFAULT_FIVE_HOUR_CEILING),
  };
}

type Window = { utilization: number; resetsAt: string | null };

/** `undefined` = malformed, `null` = absent (null/missing). */
function readWindow(v: unknown): Window | null | undefined {
  if (v === null || v === undefined) return null;
  if (!isObj(v)) return undefined;
  const u = v.utilization;
  if (typeof u !== "number" || !Number.isFinite(u)) return undefined;
  return { utilization: u, resetsAt: typeof v.resets_at === "string" ? v.resets_at : null };
}

/** Decides whether a cell may start, from a parsed `/api/usage-limits` body. */
export function evaluateUsageGate(body: unknown, c: UsageCeilings): UsageGate {
  if (!isObj(body)) return { ok: false, reason: "invalid response", sevenDay: null, fiveHour: null, resetsAt: null };
  if (body.seven_day == null && body.five_hour == null) {
    return { ok: false, fatal: true, reason: "prod Claude OAuth looks dead: usage-limits returned no windows", sevenDay: null, fiveHour: null, resetsAt: null };
  }
  const week = readWindow(body.seven_day);
  const five = readWindow(body.five_hour);
  const fiveHour = five ? five.utilization : null;
  if (!week) {
    return { ok: false, reason: "seven_day.utilization missing or invalid", sevenDay: null, fiveHour, resetsAt: null };
  }
  if (five === undefined) {
    return { ok: false, reason: "five_hour malformed", sevenDay: week.utilization, fiveHour: null, resetsAt: null };
  }
  if (week.utilization >= c.weekly) {
    return {
      ok: false,
      reason: `seven_day ${week.utilization}% >= ceiling ${c.weekly}%`,
      sevenDay: week.utilization,
      fiveHour,
      resetsAt: week.resetsAt,
    };
  }
  if (five && five.utilization >= c.fiveHour) {
    return {
      ok: false,
      reason: `five_hour ${five.utilization}% >= ceiling ${c.fiveHour}%`,
      sevenDay: week.utilization,
      fiveHour,
      resetsAt: five.resetsAt,
    };
  }
  return { ok: true, sevenDay: week.utilization, fiveHour };
}

/** Fetches and evaluates; any transport/parse failure is a hold. */
export async function fetchUsageGate(
  fetchFn: (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>,
  c: UsageCeilings,
  url = USAGE_LIMITS_URL,
): Promise<UsageGate> {
  const fail = (reason: string): UsageGate => ({ ok: false, reason, sevenDay: null, fiveHour: null, resetsAt: null });
  try {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return fail(`endpoint HTTP ${res.status}`);
    let body: unknown;
    try {
      body = JSON.parse(await res.text());
    } catch {
      return fail("endpoint returned non-JSON");
    }
    return evaluateUsageGate(body, c);
  } catch (e) {
    return fail(`endpoint unreachable (${e instanceof Error ? e.message : String(e)})`);
  }
}

export function formatUsageHold(g: Extract<UsageGate, { ok: false }>): string {
  const pct = (v: number | null) => (v === null ? "?" : `${v}%`);
  return (
    `[aurabench] usage-ceiling hold: ${g.reason} (seven_day ${pct(g.sevenDay)}, five_hour ${pct(g.fiveHour)}` +
    `${g.resetsAt ? `, resets_at ${g.resetsAt}` : ""}) — rechecking in ${USAGE_HOLD_POLL_MS / 60_000} min`
  );
}
