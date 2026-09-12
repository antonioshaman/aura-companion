import { describe, it, expect } from "vitest";
import {
  BROKEN_MODEL_SUBSTITUTIONS,
  resolveModelSubstitution,
} from "./broken-model-substitution.js";

describe("resolveModelSubstitution", () => {
  it("returns the substitution entry for a listed broken model", () => {
    const sub = resolveModelSubstitution("claude-opus-5");
    expect(sub).not.toBeNull();
    expect(sub?.from).toBe("claude-opus-5");
    expect(sub?.to).toBe("claude-opus-4-8");
    expect(sub?.reason).toContain("Claude CLI 2.1.265");
  });

  it("substitutes claude-opus-4-7 → claude-opus-4-8 (added 2026-09-10 after field verification)", () => {
    const sub = resolveModelSubstitution("claude-opus-4-7");
    expect(sub).not.toBeNull();
    expect(sub?.from).toBe("claude-opus-4-7");
    expect(sub?.to).toBe("claude-opus-4-8");
    expect(sub?.reason).toContain("Claude CLI 2.1.266");
  });

  it("substitutes claude-fable-5-1 → claude-opus-4-8 (API codename for Opus 5, added 2026-09-11)", () => {
    // The CLI's init frame reports the API model codename
    // (`claude-fable-5-1`) rather than the composer's display name
    // (`claude-opus-5`). bun persists whichever form the CLI last
    // reported, so persistence-across-restart may land on either
    // string. Both must substitute to the SAME target to prevent
    // the substitution table missing the codename form (verified
    // gap 2026-09-11 when two sessions spawned with fable-5-1
    // hit the identical silent-stdio pattern the opus-5 entry
    // was meant to pre-empt).
    const sub = resolveModelSubstitution("claude-fable-5-1");
    expect(sub).not.toBeNull();
    expect(sub?.from).toBe("claude-fable-5-1");
    expect(sub?.to).toBe("claude-opus-4-8");
    expect(sub?.reason).toContain("Opus 5 API codename");
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
