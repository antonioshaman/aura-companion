/**
 * Usage-limit detection + reset-time resolution for Claude Code and Codex.
 *
 * Pure functions (no I/O, `now` injected) used by the adapters to turn a
 * "the turn stopped because the account hit a usage limit" frame into a
 * `{ resetAt, resetSource }` pair for the auto-resume scheduler.
 *
 * Source priority (structured beats text):
 *   Claude: last `rate_limit_event` with `status: "rejected"` (`resetsAt`,
 *           epoch seconds) → "resets 1:40am (UTC)" text → fallback.
 *   Codex:  `account/rateLimits/updated` snapshot window at ≥100% (`resetsAt`)
 *           → legacy `resets_in_seconds` / `resets_at` in the error body →
 *           "Try again at 3:45 PM." / "try again in 2 hours" text → fallback.
 *
 * Fallback when no reset time is known anywhere: `now + 5h` (the longest
 * rolling window that is not weekly). Choosing a fixed cap over polling the
 * usage endpoint keeps this dependency-free; if the limit is still active when
 * the resume fires, the resulting limit frame simply schedules the next
 * attempt (self-healing, at most one retry message per cap).
 */

export const USAGE_LIMIT_FALLBACK_MS = 5 * 60 * 60 * 1000;

export type UsageLimitResetSource =
  | "rate_limit_event"
  | "codex_rate_limits"
  | "resets_in_seconds"
  | "text"
  | "fallback";

export interface ResolvedUsageLimit {
  /** Epoch ms when the limit resets (never null — fallback fills it). */
  resetAt: number;
  resetSource: UsageLimitResetSource;
  /** Window name when known (`five_hour`, `seven_day`, `primary`, …). */
  limitType: string | null;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function serverTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock parts of `epochMs` in `tz`. */
function zonedParts(epochMs: number, tz: string): { y: number; m: number; d: number; h: number; min: number; s: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  const parts: Record<string, number> = {};
  for (const p of fmt.formatToParts(new Date(epochMs))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return { y: parts.year, m: parts.month - 1, d: parts.day, h: parts.hour % 24, min: parts.minute, s: parts.second };
}

/** Offset (ms) of `tz` from UTC at instant `epochMs`. */
function tzOffsetMs(epochMs: number, tz: string): number {
  const p = zonedParts(epochMs, tz);
  return Date.UTC(p.y, p.m, p.d, p.h, p.min, p.s) - Math.floor(epochMs / 1000) * 1000;
}

/** Epoch ms of the wall-clock time y-m-d h:min in `tz` (DST-correct to the minute). */
function zonedToEpoch(y: number, m: number, d: number, h: number, min: number, tz: string): number {
  const guess = Date.UTC(y, m, d, h, min);
  let result = guess - tzOffsetMs(guess, tz);
  const second = guess - tzOffsetMs(result, tz);
  if (second !== result) result = second;
  return result;
}

const UNIT_MS: Record<string, number> = {
  d: 86_400_000, day: 86_400_000, days: 86_400_000,
  h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
  m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
  s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
};

/**
 * Parse a human reset phrase ("resets 1:40am (UTC)", "resets Oct 21, 9am",
 * "Try again at Oct 21st, 2026 3:45 PM.", "try again in 2 hours 5 minutes")
 * into epoch ms, or `null` when the text carries no parseable reset.
 *
 * Times without a date resolve to their next occurrence after `now` (a time
 * up to 5 minutes in the past is treated as "now", not tomorrow). Dates
 * without a year resolve to this year, or next year when already past.
 * A missing or unknown timezone label uses `defaultTimeZone` (server zone).
 */
export function parseResetFromText(text: string, now: number, defaultTimeZone?: string): number | null {
  if (!text) return null;
  const fallbackTz = defaultTimeZone && isValidTimeZone(defaultTimeZone) ? defaultTimeZone : serverTimeZone();

  // Relative form first ("try again in 2 hours 5 minutes", "resets in 3h").
  const rel = /(?:resets|try again)\s+in\s+((?:\d+\s*[a-z]+[\s,]*(?:and\s+)?)+)/i.exec(text);
  if (rel) {
    let total = 0;
    const unitRe = /(\d+)\s*([a-z]+)/gi;
    let mm: RegExpExecArray | null;
    while ((mm = unitRe.exec(rel[1])) !== null) {
      const unit = UNIT_MS[mm[2].toLowerCase()];
      if (unit) total += Number(mm[1]) * unit;
    }
    if (total > 0) return now + total;
  }

  const re = new RegExp(
    String.raw`(?:resets|try again at)\s+` +
      String.raw`(?:(${MONTHS.join("|")})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(?:(\d{4}),?\s*)?(?:at\s+)?)?` +
      String.raw`(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?` +
      String.raw`(?:\s*\(([^)]+)\))?`,
    "i",
  );
  const match = re.exec(text);
  if (!match) return null;
  const [, monthName, dayStr, yearStr, hourStr, minuteStr, ampm, tzLabel] = match;

  let hour = Number(hourStr);
  const minute = minuteStr ? Number(minuteStr) : 0;
  if (hour < 1 || hour > 12 || minute > 59) return null;
  const pm = ampm.toLowerCase() === "p";
  if (hour === 12) hour = pm ? 12 : 0;
  else if (pm) hour += 12;

  const tzCandidate = tzLabel?.trim();
  const tz = tzCandidate && isValidTimeZone(tzCandidate) ? tzCandidate : fallbackTz;
  const today = zonedParts(now, tz);

  if (monthName) {
    const month = MONTHS.indexOf(monthName.slice(0, 3).toLowerCase());
    const day = Number(dayStr);
    let year = yearStr ? Number(yearStr) : today.y;
    let at = zonedToEpoch(year, month, day, hour, minute, tz);
    if (!yearStr && at < now - 86_400_000) {
      year += 1;
      at = zonedToEpoch(year, month, day, hour, minute, tz);
    }
    return at;
  }

  let at = zonedToEpoch(today.y, today.m, today.d, hour, minute, tz);
  if (at < now - 5 * 60_000) {
    at = zonedToEpoch(today.y, today.m, today.d + 1, hour, minute, tz);
  }
  return at;
}

/**
 * Text surfaces the Claude CLI uses for a usage/rate limit (the synthetic
 * assistant message and the `result` string). Deliberately narrow — a false
 * positive schedules an unwanted "continue" prompt.
 */
export function isClaudeUsageLimitText(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return (
    /hit your (?:session|weekly|daily|usage|opus|sonnet|[a-z0-9 ]{0,20})?\s*limit/.test(lower) ||
    lower.includes("out of extra usage") ||
    lower.includes("out of usage credits") ||
    lower.includes("usage limit reached") ||
    lower.includes("rate_limit_error") ||
    lower.includes("rate limit exceeded")
  );
}

export interface ClaudeRateLimitInfo {
  rejected: boolean;
  resetAt: number | null;
  limitType: string | null;
}

function toEpochMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value < 1_000_000_000_000 ? value * 1000 : value;
}

/** Normalise a Claude `rate_limit_event.rate_limit_info` payload. */
export function parseClaudeRateLimitEvent(info: Record<string, unknown> | null | undefined): ClaudeRateLimitInfo {
  if (!info || typeof info !== "object") return { rejected: false, resetAt: null, limitType: null };
  return {
    rejected: info.status === "rejected",
    resetAt: toEpochMs(info.resetsAt),
    limitType: typeof info.rateLimitType === "string" ? info.rateLimitType : null,
  };
}

/**
 * Decide whether a Claude error `result` is a usage limit and when it resets.
 * Returns null when the frame is not a usage limit.
 */
export function resolveClaudeUsageLimit(input: {
  text: string;
  apiErrorStatus?: number | null;
  lastRejected: ClaudeRateLimitInfo | null;
  now: number;
  defaultTimeZone?: string;
}): ResolvedUsageLimit | null {
  const { text, apiErrorStatus, lastRejected, now } = input;
  const textSaysLimit = isClaudeUsageLimitText(text);
  const rejected = lastRejected?.rejected === true;
  if (!textSaysLimit && !(rejected && apiErrorStatus === 429)) return null;

  if (rejected && lastRejected?.resetAt && lastRejected.resetAt > now) {
    return { resetAt: lastRejected.resetAt, resetSource: "rate_limit_event", limitType: lastRejected.limitType };
  }
  const fromText = parseResetFromText(text, now, input.defaultTimeZone);
  if (fromText !== null && fromText > now - 5 * 60_000) {
    return { resetAt: fromText, resetSource: "text", limitType: null };
  }
  return { resetAt: now + USAGE_LIMIT_FALLBACK_MS, resetSource: "fallback", limitType: null };
}

export interface CodexRateLimitWindow {
  usedPercent: number;
  windowDurationMins: number;
  resetsAt: number;
}

export interface CodexRateLimitSnapshot {
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
}

function codexInfoName(info: unknown): string | null {
  if (typeof info === "string") return info;
  if (info && typeof info === "object") {
    const keys = Object.keys(info as Record<string, unknown>);
    return keys.length > 0 ? keys[0] : null;
  }
  return null;
}

/**
 * Decide whether a Codex error (v2 `error` notification or a failed
 * `turn/completed`) is a usage limit and when it resets.
 */
export function resolveCodexUsageLimit(input: {
  message: string;
  codexErrorInfo?: unknown;
  rateLimits: CodexRateLimitSnapshot | null;
  now: number;
  defaultTimeZone?: string;
}): ResolvedUsageLimit | null {
  const { message, rateLimits, now } = input;
  const info = codexInfoName(input.codexErrorInfo);
  const lower = (message || "").toLowerCase();
  const usageLimit =
    info === "usageLimitExceeded" ||
    lower.includes("hit your usage limit") ||
    lower.includes("usage_limit_reached") ||
    lower.includes("usage limit has been reached");

  const exhausted: Array<{ name: string; resetsAt: number }> = [];
  if (rateLimits) {
    for (const name of ["primary", "secondary"] as const) {
      const w = rateLimits[name];
      if (w && w.usedPercent >= 100 && w.resetsAt > now) exhausted.push({ name, resetsAt: w.resetsAt });
    }
  }
  const transientRate = info === "rateLimitExceeded";
  if (!usageLimit && !(transientRate && exhausted.length > 0)) return null;

  if (exhausted.length > 0) {
    const latest = exhausted.reduce((a, b) => (b.resetsAt > a.resetsAt ? b : a));
    return { resetAt: latest.resetsAt, resetSource: "codex_rate_limits", limitType: latest.name };
  }

  const inSeconds = /"?resets_in_seconds"?\s*[:=]\s*(\d+)/.exec(message);
  if (inSeconds) {
    return { resetAt: now + Number(inSeconds[1]) * 1000, resetSource: "resets_in_seconds", limitType: null };
  }
  const resetsAtField = /"?resets_at"?\s*[:=]\s*(\d{9,13})/.exec(message);
  if (resetsAtField) {
    const at = toEpochMs(Number(resetsAtField[1]));
    if (at && at > now) return { resetAt: at, resetSource: "resets_in_seconds", limitType: null };
  }

  const fromText = parseResetFromText(message, now, input.defaultTimeZone);
  if (fromText !== null && fromText > now - 5 * 60_000) {
    return { resetAt: fromText, resetSource: "text", limitType: null };
  }
  return { resetAt: now + USAGE_LIMIT_FALLBACK_MS, resetSource: "fallback", limitType: null };
}
