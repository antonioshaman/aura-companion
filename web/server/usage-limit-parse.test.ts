/**
 * Usage-limit detection + reset-time parsing.
 *
 * Validates the pure functions the adapters use to decide that a session
 * stopped on a usage limit and WHEN the limit resets. Structured fields are
 * always preferred over text (rate_limit_event.resetsAt for Claude, the
 * account/rateLimits snapshot for Codex); text parsing is the fallback for
 * frames that carry no structured reset.
 *
 * Fixtures under fixtures/usage-limit/ are real frames from prod recordings
 * (see the README there).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseResetFromText,
  isClaudeUsageLimitText,
  resolveClaudeUsageLimit,
  resolveCodexUsageLimit,
  parseClaudeRateLimitEvent,
  USAGE_LIMIT_FALLBACK_MS,
  NO_ZONE_SAFE_FALLBACK_MS,
} from "./usage-limit-parse.js";

function loadFrames(name: string): Array<Record<string, unknown>> {
  const raw = readFileSync(join(__dirname, "fixtures", "usage-limit", name), "utf-8");
  return raw.trim().split("\n").map((l) => JSON.parse(l));
}

describe("parseResetFromText — Claude text variants", () => {
  // The real frame was emitted at 2026-10-14T23:37:48Z; "1:40am (UTC)" must
  // resolve to the NEXT day 01:40Z — exactly the structured resetsAt the same
  // turn carried (1792028400). This is the cross-check that text parsing and
  // structured parsing agree on a real frame.
  it("'resets 1:40am (UTC)' late in the day rolls to the next day and matches the real structured epoch", () => {
    const now = 1792021068884;
    expect(parseResetFromText("You've hit your session limit · resets 1:40am (UTC)", now)).toBe(1792028400 * 1000);
  });

  // Real frame seen live 2026-10-16 (HTTP 429, error type rate_limit).
  it("'resets 12pm (UTC)' — live 2026-10-16 frame", () => {
    const now = Date.UTC(2026, 9, 16, 8, 5);
    expect(parseResetFromText("You've hit your session limit · resets 12pm (UTC)", now)).toBe(Date.UTC(2026, 9, 16, 12, 0));
  });

  it("'resets 3pm' without a timezone uses the default timezone", () => {
    const now = Date.UTC(2026, 9, 16, 10, 0);
    expect(parseResetFromText("You've hit your session limit · resets 3pm", now, "UTC")).toBe(Date.UTC(2026, 9, 16, 15, 0));
  });

  it("'resets 3:30pm (Europe/Moscow)' converts the IANA zone (UTC+3)", () => {
    const now = Date.UTC(2026, 9, 16, 10, 0);
    expect(parseResetFromText("Session limit · resets 3:30pm (Europe/Moscow)", now)).toBe(Date.UTC(2026, 9, 16, 12, 30));
  });

  it("'resets Oct 21, 9am' with an explicit date (weekly limit)", () => {
    const now = Date.UTC(2026, 9, 16, 10, 0);
    expect(parseResetFromText("You've hit your weekly limit · resets Oct 21, 9am (UTC)", now)).toBe(Date.UTC(2026, 9, 21, 9, 0));
  });

  it("'out of extra usage · resets Oct 21 at 9am' accepts the 'at' form", () => {
    const now = Date.UTC(2026, 9, 16, 10, 0);
    expect(parseResetFromText("You're out of extra usage · resets Oct 21 at 9am (UTC)", now)).toBe(Date.UTC(2026, 9, 21, 9, 0));
  });

  it("a month/day earlier than today rolls into next year", () => {
    const now = Date.UTC(2026, 11, 30, 10, 0);
    expect(parseResetFromText("resets Jan 2, 9am (UTC)", now)).toBe(Date.UTC(2027, 0, 2, 9, 0));
  });

  it("12am / 12pm map to 00:00 / 12:00", () => {
    const now = Date.UTC(2026, 9, 16, 1, 0);
    expect(parseResetFromText("resets 12pm (UTC)", now)).toBe(Date.UTC(2026, 9, 16, 12, 0));
    expect(parseResetFromText("resets 12am (UTC)", now)).toBe(Date.UTC(2026, 9, 17, 0, 0));
  });

  it("an unknown timezone label falls back to the default zone rather than failing", () => {
    const now = Date.UTC(2026, 9, 16, 10, 0);
    expect(parseResetFromText("resets 3pm (Mars/Olympus)", now, "UTC")).toBe(Date.UTC(2026, 9, 16, 15, 0));
  });

  it("returns null when there is no reset time in the text", () => {
    expect(parseResetFromText("You're out of usage credits. Switch to another model", Date.now())).toBeNull();
  });
});

describe("parseResetFromText — Codex text variants", () => {
  it("'Try again at 3:45 PM.' (same-day form)", () => {
    const now = Date.UTC(2026, 9, 16, 10, 0);
    expect(parseResetFromText("You've hit your usage limit. Try again at 3:45 PM.", now, "UTC")).toBe(Date.UTC(2026, 9, 16, 15, 45));
  });

  it("'try again at Oct 21st, 2026 3:45 PM.' (dated form with year + ordinal)", () => {
    const now = Date.UTC(2026, 9, 16, 10, 0);
    expect(
      parseResetFromText("You've hit your usage limit. Upgrade to Pro or try again at Oct 21st, 2026 3:45 PM.", now, "UTC"),
    ).toBe(Date.UTC(2026, 9, 21, 15, 45));
  });

  it("'try again in 2 hours 5 minutes' (relative form)", () => {
    const now = Date.UTC(2026, 9, 16, 10, 0);
    expect(parseResetFromText("You've hit your usage limit. Try again in 2 hours 5 minutes.", now)).toBe(now + (2 * 60 + 5) * 60_000);
  });
});

describe("isClaudeUsageLimitText", () => {
  it.each([
    "You've hit your session limit · resets 1:40am (UTC)",
    "You've hit your weekly limit · resets Oct 21, 9am",
    "You're out of extra usage · resets Oct 21, 9am",
    "You're out of usage credits. Switch to another model, or manage usage credits at claude.ai/settings/usage?from=cc_cli_limit_message, to continue.",
    "API Error: 429 rate_limit_error",
  ])("recognises %s", (text) => {
    expect(isClaudeUsageLimitText(text)).toBe(true);
  });

  it("ignores normal assistant prose that mentions limits", () => {
    expect(isClaudeUsageLimitText("I added a limit to the query so it resets the page.")).toBe(false);
  });
});

describe("parseClaudeRateLimitEvent", () => {
  it("rejected status carries resetsAt seconds → ms + window type (real frame)", () => {
    const [evt] = loadFrames("claude-session-limit-2026-10-14.ndjson");
    expect(parseClaudeRateLimitEvent(evt.rate_limit_info as Record<string, unknown>)).toEqual({
      rejected: true,
      resetAt: 1792028400 * 1000,
      limitType: "five_hour",
    });
  });

  it("allowed_warning is not a rejection", () => {
    const parsed = parseClaudeRateLimitEvent({ status: "allowed_warning", resetsAt: 1791979200, rateLimitType: "seven_day" });
    expect(parsed.rejected).toBe(false);
  });
});

describe("resolveClaudeUsageLimit (real frames)", () => {
  it("session limit: structured rate_limit_event wins, source = rate_limit_event", () => {
    const [evt, , result] = loadFrames("claude-session-limit-2026-10-14.ndjson");
    const out = resolveClaudeUsageLimit({
      text: result.result as string,
      apiErrorStatus: result.api_error_status as number,
      lastRejected: parseClaudeRateLimitEvent(evt.rate_limit_info as Record<string, unknown>),
      now: 1792021068884,
    });
    expect(out).toEqual({ resetAt: 1792028400 * 1000, resetSource: "rate_limit_event", limitType: "five_hour" });
  });

  it("session limit with no structured event: parsed from text, source = text", () => {
    const [, , result] = loadFrames("claude-session-limit-2026-10-14.ndjson");
    const out = resolveClaudeUsageLimit({
      text: result.result as string,
      apiErrorStatus: 429,
      lastRejected: null,
      now: 1792021068884,
    });
    expect(out).toEqual({ resetAt: 1792028400 * 1000, resetSource: "text", limitType: null });
  });

  it("out of usage credits: text has no time, structured weekly resetsAt is used", () => {
    const [evt, , result] = loadFrames("claude-out-of-usage-credits-2026-10-14.ndjson");
    const out = resolveClaudeUsageLimit({
      text: result.result as string,
      apiErrorStatus: 429,
      lastRejected: parseClaudeRateLimitEvent(evt.rate_limit_info as Record<string, unknown>),
      now: 1791959859885,
    });
    expect(out).toEqual({ resetAt: 1791979200 * 1000, resetSource: "rate_limit_event", limitType: "seven_day_overage_included" });
  });

  it("limit with no reset anywhere → fallback (now + 5h cap)", () => {
    const now = 1791959859885;
    const out = resolveClaudeUsageLimit({ text: "You're out of usage credits.", apiErrorStatus: 429, lastRejected: null, now });
    expect(out).toEqual({ resetAt: now + USAGE_LIMIT_FALLBACK_MS, resetSource: "fallback", limitType: null });
  });

  it("a stale rejected event whose reset already passed is ignored in favour of text", () => {
    const now = Date.UTC(2026, 9, 16, 10, 0);
    const out = resolveClaudeUsageLimit({
      text: "You've hit your session limit · resets 3pm (UTC)",
      apiErrorStatus: 429,
      lastRejected: { rejected: true, resetAt: now - 3_600_000, limitType: "five_hour" },
      now,
    });
    expect(out?.resetSource).toBe("text");
    expect(out?.resetAt).toBe(Date.UTC(2026, 9, 16, 15, 0));
  });

  it("not a limit (normal error) → null", () => {
    expect(resolveClaudeUsageLimit({ text: "Tool failed", apiErrorStatus: 500, lastRejected: null, now: 0 })).toBeNull();
  });
});

// Review WARN1: a zoneless time is interpreted in the SERVER zone (the
// adapters pass no defaultTimeZone). That path gets its own resetSource so the
// guess is visible in logs, and a zoneless time that is already past or less
// than 15 min away is not trusted (likely a zone mismatch) → safe fallback.
describe("zoneless reset text (server-zone guess)", () => {
  // Local-time anchors: the code under test resolves against the server zone,
  // which is the zone `new Date(y, m, d, h)` uses in this process.
  const localNow = new Date(2026, 9, 16, 10, 0).getTime();

  it("Claude 'resets 3pm' without defaultTimeZone → server-zone 15:00, source text_no_zone", () => {
    const out = resolveClaudeUsageLimit({ text: "You've hit your session limit · resets 3pm", apiErrorStatus: 429, lastRejected: null, now: localNow });
    expect(out).toEqual({ resetAt: new Date(2026, 9, 16, 15, 0).getTime(), resetSource: "text_no_zone", limitType: null });
  });

  it("an explicit zone keeps source 'text'", () => {
    const out = resolveClaudeUsageLimit({ text: "You've hit your session limit · resets 3pm (UTC)", apiErrorStatus: 429, lastRejected: null, now: Date.UTC(2026, 9, 16, 10, 0) });
    expect(out?.resetSource).toBe("text");
  });

  it("an unrecognised zone label is treated as zoneless", () => {
    const out = resolveClaudeUsageLimit({ text: "You've hit your session limit · resets 3pm (Mars/Olympus)", apiErrorStatus: 429, lastRejected: null, now: localNow });
    expect(out?.resetSource).toBe("text_no_zone");
  });

  it("zoneless time less than 15 min ahead → safe fallback, not trusted", () => {
    const out = resolveClaudeUsageLimit({ text: "You've hit your session limit · resets 10:10am", apiErrorStatus: 429, lastRejected: null, now: localNow });
    expect(out).toEqual({ resetAt: localNow + NO_ZONE_SAFE_FALLBACK_MS, resetSource: "fallback", limitType: null });
  });

  it("zoneless time just past (within the 5-min 'now' tolerance) → safe fallback", () => {
    const out = resolveClaudeUsageLimit({ text: "You've hit your session limit · resets 9:58am", apiErrorStatus: 429, lastRejected: null, now: localNow });
    expect(out?.resetSource).toBe("fallback");
  });

  it("Codex 'Try again at 3:45 PM.' without snapshot → text_no_zone in server zone", () => {
    const out = resolveCodexUsageLimit({ message: "You've hit your usage limit. Try again at 3:45 PM.", codexErrorInfo: "usageLimitExceeded", rateLimits: null, now: localNow });
    expect(out).toEqual({ resetAt: new Date(2026, 9, 16, 15, 45).getTime(), resetSource: "text_no_zone", limitType: null });
  });
});

describe("resolveCodexUsageLimit", () => {
  // Real account/rateLimits/updated shape from recordings (usedPercent raised
  // to 100 to model the exhausted window; resetsAt already ms-normalised by
  // CodexAdapter.updateRateLimits).
  const exhausted = {
    primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1791858070 * 1000 },
    secondary: { usedPercent: 2, windowDurationMins: 10080, resetsAt: 1792296164 * 1000 },
  };
  const now = 1791850000000;

  it("usageLimitExceeded + exhausted window → snapshot resetsAt (structured)", () => {
    const out = resolveCodexUsageLimit({
      message: "You've hit your usage limit. Try again at 3:45 PM.",
      codexErrorInfo: "usageLimitExceeded",
      rateLimits: exhausted,
      now,
    });
    expect(out).toEqual({ resetAt: 1791858070 * 1000, resetSource: "codex_rate_limits", limitType: "primary" });
  });

  it("weekly (secondary) window exhausted picks the secondary reset", () => {
    const out = resolveCodexUsageLimit({
      message: "You've hit your usage limit.",
      codexErrorInfo: "usageLimitExceeded",
      rateLimits: { primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: now + 1000 }, secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: now + 86_400_000 } },
      now,
    });
    expect(out).toEqual({ resetAt: now + 86_400_000, resetSource: "codex_rate_limits", limitType: "secondary" });
  });

  it("no snapshot → legacy resets_in_seconds in the error body", () => {
    const out = resolveCodexUsageLimit({
      message: '{"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","resets_in_seconds":3600}}',
      codexErrorInfo: "other",
      rateLimits: null,
      now,
    });
    expect(out).toEqual({ resetAt: now + 3_600_000, resetSource: "resets_in_seconds", limitType: null });
  });

  it("no snapshot → 'Try again at' text", () => {
    const out = resolveCodexUsageLimit({
      message: "You've hit your usage limit. Try again at Oct 21st, 2026 3:45 PM.",
      codexErrorInfo: "usageLimitExceeded",
      rateLimits: null,
      now: Date.UTC(2026, 9, 16, 10, 0),
      defaultTimeZone: "UTC",
    });
    // Zoneless (Codex formats in its own local zone) → flagged text_no_zone.
    expect(out).toEqual({ resetAt: Date.UTC(2026, 9, 21, 15, 45), resetSource: "text_no_zone", limitType: null });
  });

  it("usage limit with no reset anywhere → fallback", () => {
    const out = resolveCodexUsageLimit({ message: "You've hit your usage limit.", codexErrorInfo: "usageLimitExceeded", rateLimits: null, now });
    expect(out).toEqual({ resetAt: now + USAGE_LIMIT_FALLBACK_MS, resetSource: "fallback", limitType: null });
  });

  it("transient rateLimitExceeded with no exhausted window is NOT a usage limit", () => {
    expect(resolveCodexUsageLimit({ message: "Rate limit exceeded", codexErrorInfo: "rateLimitExceeded", rateLimits: null, now })).toBeNull();
  });

  it("rateLimitExceeded WITH an exhausted window is a usage limit", () => {
    const out = resolveCodexUsageLimit({ message: "Rate limit exceeded", codexErrorInfo: "rateLimitExceeded", rateLimits: exhausted, now });
    expect(out?.resetSource).toBe("codex_rate_limits");
  });

  it("an unrelated error (real model-not-supported frame) → null", () => {
    expect(
      resolveCodexUsageLimit({
        message: "The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.",
        codexErrorInfo: "other",
        rateLimits: exhausted,
        now,
      }),
    ).toBeNull();
  });
});
