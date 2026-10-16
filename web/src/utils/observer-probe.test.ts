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
// row with raw JSON. The span is now bound to the probe's TURN: it closes at
// the message the turn's `result` frame marked `turnEnd`.
describe("probeMessageIds — the probe is bound to its turn", () => {
  const findings = '[\n  {\n    "severity": "STOP",\n    "claim": "Дедупликация сравнивает позднюю находку",\n    "evidence_lines": [402, 415],\n    "confidence": "high"\n  }\n]';

  it("a later-turn findings reply is a review, not probe traffic", () => {
    const ids = probeMessageIds([
      { id: "p1", role: "user", content: "[liveness probe] кто ты?" },
      { id: "a1", role: "assistant", content: "Я Observer…", turnEnd: true },
      // next turn = a wake (not in the feed as a user message)
      { id: "t1", role: "assistant", content: "" },
      { id: "f1", role: "assistant", content: findings, turnEnd: true },
    ]);
    expect([...ids]).toEqual(["p1", "a1"]);
  });

  it("`[]` answering the probe is probe traffic; `[]` in the next turn is a review", () => {
    // Observer WARN on PR #374: a JSON-shape rule would show the probe's own
    // "[]" answer as a green "no findings — clean" review.
    const ids = probeMessageIds([
      { id: "p1", role: "user", content: "[probe] Ответь []" },
      { id: "a1", role: "assistant", content: "[]", turnEnd: true },
      { id: "r1", role: "assistant", content: "[]", turnEnd: true },
    ]);
    expect([...ids]).toEqual(["p1", "a1"]);
  });

  it("every message inside the probe turn stays probe traffic until the turn ends", () => {
    const ids = probeMessageIds([
      { id: "p1", role: "user", content: "[probe] что видел последним в .council/?" },
      { id: "t0", role: "assistant", content: "" }, // reads files before answering
      { id: "a1", role: "assistant", content: "[]" }, // findings-shaped, same turn
      { id: "a2", role: "assistant", content: "Видел checkpoint 165.", turnEnd: true },
      { id: "a3", role: "assistant", content: "ответ следующего хода" },
    ]);
    expect([...ids]).toEqual(["p1", "t0", "a1", "a2"]);
  });

  it("a probe whose turn ended without any reply closes immediately", () => {
    const ids = probeMessageIds([
      { id: "p1", role: "user", content: "[ping]", turnEnd: true },
      { id: "f1", role: "assistant", content: "[]", turnEnd: true },
    ]);
    expect([...ids]).toEqual(["p1"]);
  });
});
