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
