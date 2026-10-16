import { describe, expect, it } from "vitest";
import { ObserverProbeTracker, PROBE_TURN_MAX_MS, isObserverProbeText } from "./observer-probe.js";

// Observer rigor (2026-10-16): liveness probes to an observer are not review
// traffic. Prod 2026-10-15: "[liveness probe] Это проверка связи…" got the
// reply "Я Observer…", which surfaced on the findings channel.
describe("isObserverProbeText", () => {
  it("matches the tagged probe forms used in prod", () => {
    expect(isObserverProbeText("[liveness probe] Это проверка связи после перезапуска на новой модели.")).toBe(true);
    expect(isObserverProbeText("  [Liveness-Probe] ping")).toBe(true);
    expect(isObserverProbeText("[ping]")).toBe(true);
  });
  it("does not match wakes, peer messages or a tag mid-text", () => {
    expect(isObserverProbeText("# Council Checkpoint — council-plan")).toBe(false);
    expect(isObserverProbeText("[from-orchestrator: NOTE] ok")).toBe(false);
    expect(isObserverProbeText("please [probe] this")).toBe(false);
    expect(isObserverProbeText(42)).toBe(false);
  });
});

describe("ObserverProbeTracker", () => {
  it("is in flight from the probe until its turn ends; the last end reports true", () => {
    const t = new ObserverProbeTracker(() => 0);
    expect(t.inFlight("obs")).toBe(false);
    t.noteProbe("obs");
    t.noteProbe("obs");
    expect(t.inFlight("obs")).toBe(true);
    expect(t.noteTurnEnded("obs")).toBe(false);
    expect(t.inFlight("obs")).toBe(true);
    expect(t.noteTurnEnded("obs")).toBe(true);
    expect(t.inFlight("obs")).toBe(false);
    // A turn end with no probe pending is a no-op.
    expect(t.noteTurnEnded("obs")).toBe(false);
  });

  it("a probe whose turn never reports an end stops blocking wakes after PROBE_TURN_MAX_MS", () => {
    let now = 0;
    const t = new ObserverProbeTracker(() => now);
    t.noteProbe("obs");
    now = PROBE_TURN_MAX_MS + 1;
    expect(t.inFlight("obs")).toBe(false);
  });
});
