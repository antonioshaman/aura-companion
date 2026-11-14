/**
 * Usage-limit banner visibility (LLM auth task 13, S3-AC4). Visibility ends
 * at the window reset regardless of when the scheduled resume fires (observer
 * STOP, checkpoint 199); the server action separates "hide the banner" from
 * "cancel the schedule".
 */
import { describe, expect, it } from "vitest";
import { AUTO_RESUME_OVERDUE_GRACE_MS, autoResumeStaleAction, isAutoResumeBannerVisible } from "./auto-resume-visibility.js";

const NOW = 1_800_000_000_000;

describe("isAutoResumeBannerVisible", () => {
  it("visible strictly before the reset, hidden from the reset on — scheduled or paused", () => {
    expect(isAutoResumeBannerVisible({ resetAt: NOW + 1, fireAt: NOW + 90_000 }, NOW)).toBe(true);
    expect(isAutoResumeBannerVisible({ resetAt: NOW, fireAt: NOW + 90_000 }, NOW)).toBe(false);
    expect(isAutoResumeBannerVisible({ resetAt: NOW - 30_000, fireAt: NOW + 60_000 }, NOW)).toBe(false);
    expect(isAutoResumeBannerVisible({ resetAt: NOW - 1, fireAt: NOW - 1, paused: true }, NOW)).toBe(false);
  });
});

describe("autoResumeStaleAction", () => {
  it("window running → none", () => {
    expect(autoResumeStaleAction({ resetAt: NOW + 60_000, fireAt: NOW + 150_000 }, NOW)).toBe("none");
  });

  it("reset passed, resume still pending → hide (keep the schedule)", () => {
    expect(autoResumeStaleAction({ resetAt: NOW - 30_000, fireAt: NOW + 60_000 }, NOW)).toBe("hide");
  });

  it("paused or long overdue → cancel", () => {
    expect(autoResumeStaleAction({ resetAt: NOW - 1, fireAt: NOW - 1, paused: true }, NOW)).toBe("cancel");
    expect(autoResumeStaleAction({ resetAt: NOW - 1e6, fireAt: NOW - AUTO_RESUME_OVERDUE_GRACE_MS }, NOW)).toBe("cancel");
    expect(autoResumeStaleAction({ resetAt: NOW - 1e6, fireAt: NOW - AUTO_RESUME_OVERDUE_GRACE_MS + 1 }, NOW)).toBe("hide");
  });
});
