import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEvalOutput, renderReport, skillRevision } from "./uiux-platform-runner.js";

describe("live eval result validity", () => {
  it("collects successful answers and actual skill calls, tolerating non-JSON noise", () => {
    const result = parseEvalOutput('noise\n' + JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Skill", input: { skill: "aura-toolkit:aura-uiux" } }] } }) + '\n' + JSON.stringify({ type: "result", result: "code" }));
    expect(result).toEqual({ output: "code", tools: ["Skill:aura-toolkit:aura-uiux"] });
  });
  it("does not grade a provider rejection as a generated answer", () => {
    expect(parseEvalOutput(JSON.stringify({ type: "result", is_error: true, result: "Account verification required" })).error).toBe("Account verification required");
    expect(parseEvalOutput("{}").error).toBe("no result");
    expect(parseEvalOutput(JSON.stringify({ type: "result", result: "API Error: rejected" })).error).toContain("rejected");
    expect(parseEvalOutput(JSON.stringify({ type: "system", model: "pinned-model" }) + "\n" + JSON.stringify({ type: "result", result: "code" })).resolvedModel).toBe("pinned-model");
  });
});


it("pins actual skill content and keeps different experiment cohorts separate", () => {
  const root = mkdtempSync(join(tmpdir(), "skill-revision-test-"));
  try {
    mkdirSync(join(root, "references")); writeFileSync(join(root, "SKILL.md"), "skill");
    writeFileSync(join(root, "references/telegram.md"), "before"); const before = skillRevision(root);
    writeFileSync(join(root, "references/telegram.md"), "after"); expect(skillRevision(root)).not.toBe(before);
    const base = { fixture: "web-checkout", model: "sonnet", arm: "with" as const, run: 0, tools: [], output: "", grade: { pass: true, markers: {}, antiMarkers: {} }, settingsIsolation: "project-local" as const };
    const report = renderReport([{ ...base, startedAt: "old", skillRevision: "first" }, { ...base, startedAt: "new", skillRevision: "second" }]);
    expect(report).toContain("old / sonnet / first"); expect(report).toContain("new / sonnet / second");
    expect(report).not.toContain("2/2"); expect(report).toContain("No paired Telegram");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
