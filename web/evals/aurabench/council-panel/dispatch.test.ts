/**
 * Forced-roster check for COUNCIL-PANEL-BENCH. A run is only comparable
 * when the Chair seated exactly the panel under test, and the proof is the
 * Chair's own stream-json.
 *
 * Validates:
 *   - top-level `Agent` and legacy `Task` tool calls are dispatches; a
 *     subagent's own nested tool calls (parent_tool_use_id set) are not;
 *   - the seat is read from the output path (preferred) or the catalog path,
 *     and only catalog ids count (`FINAL-REVIEW`, `context-brief` never do);
 *   - a prompt naming several seats is unattributable (`other`), not guessed;
 *   - missing / extra seats invalidate the run; a re-dispatch of the same
 *     seat is recorded as a duplicate but stays valid.
 */

import { describe, it, expect } from "vitest";
import { checkDispatch, seatOfPrompt } from "./dispatch.js";

const CATALOG = new Set(["hunt", "fowler", "dahl", "beck"]);

let n = 0;
function dispatchFrame(prompt: string, opts: { name?: string; parent?: string | null; description?: string } = {}): string {
  return JSON.stringify({
    type: "assistant",
    parent_tool_use_id: opts.parent ?? null,
    message: {
      content: [
        { type: "text", text: "dispatching" },
        {
          type: "tool_use",
          id: `tu_${++n}`,
          name: opts.name ?? "Agent",
          input: { description: opts.description ?? "review seat", prompt, subagent_type: "general-purpose", model: "opus" },
        },
      ],
    },
  });
}
const seatPrompt = (seat: string) =>
  `Read ~/.claude/skills/_council-experts/${seat}/review-aura.md. Write findings to .council/review-output/2026-09-30-0712/${seat}.md and return one line.`;

describe("seatOfPrompt", () => {
  it("prefers the output path, falls back to the catalog path, ignores non-catalog names", () => {
    expect(seatOfPrompt(seatPrompt("hunt"), CATALOG)).toBe("hunt");
    expect(seatOfPrompt("Use _council-experts/dahl/review-aura.md", CATALOG)).toBe("dahl");
    expect(seatOfPrompt("Read .council/review-output/TS/context-brief.md then write FINAL-REVIEW.md", CATALOG)).toBeNull();
  });

  it("returns null when a prompt names several seats", () => {
    expect(seatOfPrompt(`${seatPrompt("hunt")}\n${seatPrompt("beck")}`, CATALOG)).toBeNull();
  });
});

describe("checkDispatch", () => {
  it("accepts exactly the forced roster (Agent and legacy Task), ignoring nested subagent tool calls", () => {
    const stream = [
      JSON.stringify({ type: "system", subtype: "init", skills: ["council-review-aura"] }),
      dispatchFrame(seatPrompt("hunt")),
      dispatchFrame(seatPrompt("fowler"), { name: "Task" }),
      // A subagent dispatching its own helper — not a Chair seat.
      dispatchFrame(seatPrompt("dahl"), { parent: "tu_1" }),
      "not json",
    ].join("\n");
    const r = checkDispatch(stream, ["hunt", "fowler"], CATALOG);
    expect(r.valid).toBe(true);
    expect(r.seated).toEqual(["hunt", "fowler"]);
    expect(r.dispatches).toHaveLength(2);
    expect(r.dispatches[0]).toMatchObject({ seat: "hunt", subagentType: "general-purpose", model: "opus" });
    expect(r).toMatchObject({ missing: [], extra: [], duplicates: [], other: 0 });
  });

  it("flags missing and extra seats as invalid", () => {
    const stream = [dispatchFrame(seatPrompt("hunt")), dispatchFrame(seatPrompt("dahl"))].join("\n");
    const r = checkDispatch(stream, ["hunt", "fowler"], CATALOG);
    expect(r.valid).toBe(false);
    expect(r.missing).toEqual(["fowler"]);
    expect(r.extra).toEqual(["dahl"]);
  });

  it("records a re-dispatch as a duplicate and an unattributable dispatch as other, still valid", () => {
    const stream = [
      dispatchFrame(seatPrompt("hunt")),
      dispatchFrame(seatPrompt("hunt")),
      dispatchFrame("Explore the repo layout and summarise it"),
    ].join("\n");
    const r = checkDispatch(stream, ["hunt"], CATALOG);
    expect(r.valid).toBe(true);
    expect(r.duplicates).toEqual(["hunt"]);
    expect(r.other).toBe(1);
  });

  it("an empty stream seats nobody", () => {
    const r = checkDispatch("", ["hunt"], CATALOG);
    expect(r).toMatchObject({ valid: false, missing: ["hunt"], seated: [], other: 0 });
  });
});
