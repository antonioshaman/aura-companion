import { describe, it, expect } from "vitest";
import {
  BROKEN_MODEL_SUBSTITUTIONS,
  resolveModelSubstitution,
} from "./broken-model-substitution.js";

import type { BrokenModelSubstitution } from "./broken-model-substitution.js";

// Fixture table: the live table is empty since the 2026-10-16 re-probe (CLI
// 2.1.283 emits opus-5 / fable-5-1 / opus-4-7 on stdout again), so the
// lookup MECHANISM is exercised against an injected table. Shape mirrors the
// historical entries so a future re-add behaves exactly like these.
const FIXTURE: readonly BrokenModelSubstitution[] = [
  { from: "claude-opus-5", to: "claude-opus-4-8", reason: "Claude CLI 2.1.265+ does not emit opus-5 responses on stdout (fixture)" },
  { from: "claude-opus-4-7", to: "claude-opus-4-8", reason: "Claude CLI 2.1.266 does not reliably emit opus-4-7 responses (fixture)" },
  { from: "claude-fable-5-1", to: "claude-opus-4-8", reason: "Claude CLI 2.1.266 does not emit fable-5-1 (Opus 5 API codename) (fixture)" },
];

describe("resolveModelSubstitution", () => {
  it("returns the substitution entry for a listed broken model (injected table)", () => {
    const sub = resolveModelSubstitution("claude-opus-5", FIXTURE);
    expect(sub).not.toBeNull();
    expect(sub?.from).toBe("claude-opus-5");
    expect(sub?.to).toBe("claude-opus-4-8");
    expect(sub?.reason).toContain("Claude CLI 2.1.265");
  });

  it("substitutes claude-opus-4-7 → claude-opus-4-8 when listed (injected table)", () => {
    const sub = resolveModelSubstitution("claude-opus-4-7", FIXTURE);
    expect(sub?.from).toBe("claude-opus-4-7");
    expect(sub?.to).toBe("claude-opus-4-8");
  });

  it("matches the API codename claude-fable-5-1 independently of claude-opus-5 (injected table)", () => {
    // The CLI's init frame reports the API codename, so persisted state may
    // land on either literal; each form needs its own exact-match entry.
    const sub = resolveModelSubstitution("claude-fable-5-1", FIXTURE);
    expect(sub?.from).toBe("claude-fable-5-1");
    expect(sub?.to).toBe("claude-opus-4-8");
  });

  it("live table no longer rewrites Opus 5 / fable-5-1 / opus-4-7 (re-probed on CLI 2.1.283, 2026-10-16)", () => {
    // Regression guard for the silent downgrade: the user picked Opus 5,
    // ran on it until the next relaunch, then got rewritten to 4.8. The
    // probe (two-turn stdin stream-json) showed all three emit on stdout.
    expect(resolveModelSubstitution("claude-opus-5")).toBeNull();
    expect(resolveModelSubstitution("claude-fable-5-1")).toBeNull();
    expect(resolveModelSubstitution("claude-opus-4-7")).toBeNull();
  });

  it("returns null for non-broken Claude models", () => {
    expect(resolveModelSubstitution("claude-opus-4-8")).toBeNull();
    // Note: `claude-opus-4-7` was ADDED to the substitution table
    // 2026-09-10 after field verification (see
    // feedback_claude_cli_opus5_stdout_dead_jsonl_alive.md).
    // `claude-fable-5-1` was ADDED 2026-09-11 as the API-codename
    // alias for Opus 5 that bun's state can land on if the CLI
    // reports it via init.
    expect(resolveModelSubstitution("claude-sonnet-4-6")).toBeNull();
    expect(resolveModelSubstitution("claude-haiku-4-5")).toBeNull();
  });

  it("returns null for unknown / off-family model ids", () => {
    expect(resolveModelSubstitution("gpt-4")).toBeNull();
    expect(resolveModelSubstitution("claude-opus-99")).toBeNull();
  });

  it("returns null for empty / null / undefined", () => {
    expect(resolveModelSubstitution("")).toBeNull();
    expect(resolveModelSubstitution(null)).toBeNull();
    expect(resolveModelSubstitution(undefined)).toBeNull();
  });

  it("substitution targets MUST be real Claude CLI-accepted model ids", () => {
    // Load-bearing: if the substitute is a typo or a codename, we'd replace
    // one broken model with another. Guard by asserting each target
    // matches the Claude family shape (any change to the id scheme
    // that would break spawn should trip a test here first).
    for (const sub of BROKEN_MODEL_SUBSTITUTIONS) {
      expect(sub.to).toMatch(/^claude-(opus|sonnet|haiku)-\d(-\d+)?$/);
      // The substitute must NOT itself be in the broken list — otherwise
      // we'd substitute-to-substitute in a loop.
      expect(
        BROKEN_MODEL_SUBSTITUTIONS.every((s) => s.from !== sub.to),
        `substitution target ${sub.to} is also a "from" — creates a cycle`,
      ).toBe(true);
    }
  });

  it("reason string is human-readable and identifies the trigger", () => {
    for (const sub of BROKEN_MODEL_SUBSTITUTIONS) {
      // Non-empty, over a plausible minimum length, doesn't lead with
      // "TODO" or "FIXME" (would be a placeholder someone forgot).
      expect(sub.reason.length).toBeGreaterThan(30);
      expect(sub.reason.toLowerCase()).not.toMatch(/^(todo|fixme|xxx)/);
    }
  });
});
