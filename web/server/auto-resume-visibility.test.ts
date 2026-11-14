/**
 * Stale auto-resume banner rule (LLM auth task 13, S3-AC4). One pure rule
 * shared by the server (clear on browser open) and the client (hide between
 * server updates).
 */
import { describe, expect, it } from "vitest";
import { AUTO_RESUME_OVERDUE_GRACE_MS, isAutoResumeStale } from "./auto-resume-visibility.js";

const NOW = 1_800_000_000_000;

describe("isAutoResumeStale", () => {
  it("paused banner: stale once its window reset, truthful before", () => {
    expect(isAutoResumeStale({ resetAt: NOW - 1, fireAt: NOW - 1, paused: true }, NOW)).toBe(true);
    expect(isAutoResumeStale({ resetAt: NOW + 60_000, fireAt: NOW + 60_000, paused: true }, NOW)).toBe(false);
  });

  it("scheduled banner: legit between reset and fire, stale only when long overdue", () => {
    expect(isAutoResumeStale({ resetAt: NOW - 30_000, fireAt: NOW + 60_000 }, NOW)).toBe(false);
    expect(isAutoResumeStale({ resetAt: NOW - 1e6, fireAt: NOW - AUTO_RESUME_OVERDUE_GRACE_MS + 1 }, NOW)).toBe(false);
    expect(isAutoResumeStale({ resetAt: NOW - 1e6, fireAt: NOW - AUTO_RESUME_OVERDUE_GRACE_MS }, NOW)).toBe(true);
  });
});
