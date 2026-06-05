// PLAN T12 (Phase G) - exhaustiveness + Friedman R1/R2/R3 invariants
// for cliFailedCopy(reason). EC-19 spirit: pin the user-facing copy with
// literal-string assertions so a silent rewrite (drift of headline / body /
// action) trips the gate at test time, not only at user-report time.

import { describe, it, expect } from "vitest";
import { cliFailedCopy } from "./cli-failed-copy.js";
import type { CliFailedReason } from "./types.js";

const ALL_REASONS: readonly CliFailedReason[] = [
  "relaunch_exhausted",
  "container_missing",
  "container_stopped",
  "binary_missing",
  "browser_closed_no_reconnect",
];

describe("cliFailedCopy", () => {
  // EC-19 spirit + Friedman R1: every variant carries a non-empty headline,
  // body, and action. Sharing the table across variants would collapse the
  // divergent recovery copy - the literal-string assertions below catch that.
  it.each(ALL_REASONS)("returns non-empty headline + body + action for %s", (reason) => {
    const copy = cliFailedCopy(reason);
    expect(copy.headline.length).toBeGreaterThan(0);
    expect(copy.body.length).toBeGreaterThan(0);
    expect(copy.action.length).toBeGreaterThan(0);
  });

  it("relaunch_exhausted copy names the retry-budget cause + agent agency", () => {
    const copy = cliFailedCopy("relaunch_exhausted");
    // Cause + agency + next step - mutation-resistant against silent rewrite.
    expect(copy.headline).toMatch(/recover/i);
    expect(copy.body).toMatch(/retry budget/i);
    expect(copy.body).toMatch(/agent/i);
    expect(copy.action).toMatch(/new session/i);
  });

  it("container_missing copy names the Docker container", () => {
    const copy = cliFailedCopy("container_missing");
    expect(copy.headline).toMatch(/container/i);
    expect(copy.body).toMatch(/container/i);
  });

  it("container_stopped copy names the stopped + restart-failed state", () => {
    const copy = cliFailedCopy("container_stopped");
    expect(copy.headline).toMatch(/start/i);
    expect(copy.body).toMatch(/stopped/i);
  });

  it("binary_missing copy names the missing claude/codex binary", () => {
    const copy = cliFailedCopy("binary_missing");
    expect(copy.headline).toMatch(/binary/i);
    expect(copy.body).toMatch(/claude|codex/);
  });

  // Friedman R2 - past-tense second-person for browser_closed_no_reconnect.
  // "You closed" is the actor whose action produced the state. Mutation-
  // resistant against drift to passive-voice ("This tab was closed").
  it("browser_closed_no_reconnect uses past-tense second-person framing (Friedman R2)", () => {
    const copy = cliFailedCopy("browser_closed_no_reconnect");
    expect(copy.headline).toMatch(/^you /i);
    expect(copy.body).toMatch(/disconnected/i);
  });

  // Friedman R3 - never "N message(s)" plural-form coupling. Drained count
  // is rendered as a mono integer chip in the banner, not woven into prose.
  it("body copy never embeds a plural-form message count", () => {
    for (const reason of ALL_REASONS) {
      const copy = cliFailedCopy(reason);
      expect(copy.body).not.toMatch(/message\(s\)/);
    }
  });

  // EC-37 sibling - exhaustive switch (const _: never = reason) means an
  // unrecognised value at runtime throws rather than silently returning
  // generic copy. This protects against a future wire-frame producer
  // sending a string that bypasses the type system (e.g. a stale buffered
  // event_replay from an older server).
  it("throws for an unknown reason at runtime (defence-in-depth)", () => {
    expect(() =>
      cliFailedCopy("not_a_real_reason" as unknown as CliFailedReason),
    ).toThrow(/unhandled reason/);
  });
});
