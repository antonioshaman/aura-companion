import { describe, it, expect } from "vitest";
import { isObserverProbeText, probeMessageIds } from "./observer-probe.js";

// Observer rigor (2026-10-16): the probe and every assistant message that
// answers it (up to the next user message) are probe traffic; wakes and
// their replies are not.
describe("probeMessageIds", () => {
  it("marks the probe and its replies, not the wake and its findings", () => {
    const ids = probeMessageIds([
      { id: "w1", role: "user", content: "# Council Checkpoint — council-plan" },
      { id: "a1", role: "assistant", content: "[]" },
      { id: "p1", role: "user", content: "[liveness probe] кто ты?" },
      { id: "a2", role: "assistant", content: "Я Observer…" },
      { id: "a3", role: "assistant", content: "ещё строка" },
      { id: "w2", role: "user", content: "# Council Checkpoint — council-review" },
      { id: "a4", role: "assistant", content: "[]" },
    ]);
    expect([...ids]).toEqual(["p1", "a2", "a3"]);
  });

  it("isObserverProbeText mirrors the server tag rule", () => {
    expect(isObserverProbeText("[ping]")).toBe(true);
    expect(isObserverProbeText("please [probe]")).toBe(false);
  });
});

// Prod 2026-10-16 (grp_879b81b6): wakes are NOT echoed into the browser feed
// as user messages, so after one probe the "up to the next user message" span
// never closed and every later findings reply rendered as a collapsed probe
// row with raw JSON. These pin the two extra span terminators.
describe("probeMessageIds — span ends without a following user message", () => {
  const findings = '[\n  {\n    "severity": "STOP",\n    "claim": "Дедупликация сравнивает позднюю находку",\n    "evidence_lines": [402, 415],\n    "confidence": "high"\n  }\n]';
  const tool = (id: string) => ({ id, role: "assistant", content: "", contentBlocks: [{ type: "tool_use" }] });

  it("a findings-shaped reply is review output, never probe traffic, and ends the span", () => {
    const ids = probeMessageIds([
      { id: "p1", role: "user", content: "[liveness probe] кто ты?" },
      { id: "a1", role: "assistant", content: "Я Observer…" },
      { id: "f1", role: "assistant", content: findings },
      { id: "x1", role: "assistant", content: "прозаический ответ после ревью" },
      { id: "f2", role: "assistant", content: "[]" },
    ]);
    expect([...ids]).toEqual(["p1", "a1"]);
  });

  it("a tool call after the probe's text answer belongs to the next turn and ends the span", () => {
    const ids = probeMessageIds([
      { id: "p1", role: "user", content: "[probe] что видел последним в .council/?" },
      tool("t0"), // the probe turn may read files BEFORE answering — still probe traffic
      { id: "a1", role: "assistant", content: "Видел checkpoint 165." },
      tool("t1"), // next wake's work
      { id: "a2", role: "assistant", content: "не-JSON ответ следующего хода" },
    ]);
    expect([...ids]).toEqual(["p1", "t0", "a1"]);
  });
});
