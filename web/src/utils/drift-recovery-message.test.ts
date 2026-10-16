import { describe, expect, it } from "vitest";
import { isDriftRecoveryMessage } from "./drift-recovery-message.js";

describe("isDriftRecoveryMessage", () => {
  it("matches the exact wording session-recovery.ts broadcasts", () => {
    expect(
      isDriftRecoveryMessage("Backend transcript 1813s behind CLI's jsonl — relaunching to recover."),
    ).toBe(true);
    expect(
      isDriftRecoveryMessage("Backend transcript 0s behind CLI's jsonl — relaunching to recover."),
    ).toBe(true);
  });

  it("rejects unrelated error text, including text that shares words with the drift notice", () => {
    expect(isDriftRecoveryMessage("Session keeps crashing. Please relaunch manually.")).toBe(false);
    expect(isDriftRecoveryMessage("Backend output looks stalled, but it was already auto-recovered.")).toBe(
      false,
    );
    expect(isDriftRecoveryMessage("jsonl parse error: unexpected token")).toBe(false);
    expect(isDriftRecoveryMessage("")).toBe(false);
  });

  it("rejects a near-miss missing the trailing period or with extra text appended", () => {
    expect(isDriftRecoveryMessage("Backend transcript 5s behind CLI's jsonl — relaunching to recover")).toBe(
      false,
    );
    expect(
      isDriftRecoveryMessage("Backend transcript 5s behind CLI's jsonl — relaunching to recover. Again."),
    ).toBe(false);
  });
});
