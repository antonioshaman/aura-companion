/**
 * Tests for the D2 variant table and the cell store (Story D2: "for every
 * (task, variant) pair … recorded" + "the run waits for the limit reset and
 * continues from the same place without duplicating finished cells").
 *
 * Validates:
 *   - the A→C→D→E ladder adds exactly one layer group per step (so the
 *     per-layer table in D3 measures one change at a time);
 *   - naked variants carry no layers, Codex variants never get the observer
 *     (Council Mode rejects a Codex primary);
 *   - Council pairs (D, E) carry the observer-loop directive flag; only E
 *     requests auto-proceed (FIX-D2-2);
 *   - `--variants` parsing rejects unknown ids instead of dropping them;
 *   - the cell plan is repetition-major and keys are unique;
 *   - resume: `completedCellKeys` reads keys back, ignores torn lines and
 *     records of another schema version.
 */

import { describe, it, expect } from "vitest";
import { VARIANTS, VARIANT_IDS, parseVariantList, type AuraVariant } from "./variants.js";
import { CELL_RECORD_VERSION, cellKey, completedCellKeys, parseClassTimeouts, planCells, staleCellRecords } from "./cells.js";

const onLayers = (v: AuraVariant) => Object.entries(v.layers).filter(([, s]) => s === "on").map(([k]) => k).sort();

describe("VARIANTS", () => {
  it("defines exactly A–G, A/B naked, C–G through Companion", () => {
    expect(Object.keys(VARIANTS).sort()).toEqual([...VARIANT_IDS]);
    expect(VARIANTS.A).toMatchObject({ mode: "naked", provider: "claude" });
    expect(VARIANTS.B).toMatchObject({ mode: "naked", provider: "codex" });
    for (const id of ["C", "D", "E", "F", "G"] as const) expect(VARIANTS[id].mode).toBe("aura");
  });

  it("the Claude ladder A→C→D→E adds layers monotonically, one group per step", () => {
    const c = VARIANTS.C as AuraVariant;
    const d = VARIANTS.D as AuraVariant;
    const e = VARIANTS.E as AuraVariant;
    expect(onLayers(c)).toEqual(["knowledge"]);
    expect(onLayers(d)).toEqual(["knowledge", "observer"]);
    // E = full stack: council skills plus the auto-proceed driver.
    expect(onLayers(e)).toEqual(["autoProceed", "council", "knowledge", "observer"]);
    expect(d.councilPairing).toBe("claude+claude");
    expect(e.councilPairing).toBe("claude+claude");
    expect(c.councilPairing).toBeUndefined();
    expect(e.autoProceedOnIdle).toBeDefined();
  });

  it("observer layer on ⇔ a Council pairing is requested (no silent solo fallback)", () => {
    for (const v of Object.values(VARIANTS)) {
      if (v.mode !== "aura") continue;
      expect(v.layers.observer === "on").toBe(v.councilPairing !== undefined);
    }
  });

  it("every Council pair runs the observer loop (FIX-D2-2: otherwise D ≡ C, observer sees no code)", () => {
    for (const v of Object.values(VARIANTS)) {
      if (v.mode !== "aura") continue;
      expect(v.observerLoop === true).toBe(v.councilPairing !== undefined);
    }
  });

  it("E really requests auto-proceed (FIX-D2-2: armed since AP-WIRE, measured, not merely labelled)", () => {
    const e = VARIANTS.E as AuraVariant;
    expect(e.layers.autoProceed).toBe("on");
    expect(e.autoProceedOnIdle).toEqual({ idleMs: 120_000, maxIterations: 3 });
    // Only E: the ladder's D step must not already include auto-proceed.
    for (const v of Object.values(VARIANTS)) if (v.mode === "aura" && v.id !== "E") expect(v.autoProceedOnIdle).toBeUndefined();
  });

  it("Codex variants never request the observer (unsupported for a Codex primary)", () => {
    for (const id of ["F", "G"] as const) {
      const v = VARIANTS[id] as AuraVariant;
      expect(v.provider).toBe("codex");
      expect(v.layers.observer).toBe("off");
      expect(v.councilPairing).toBeUndefined();
    }
    // G differs from F by the council-skills layer only.
    expect(onLayers(VARIANTS.F as AuraVariant)).toEqual(["knowledge"]);
    expect(onLayers(VARIANTS.G as AuraVariant)).toEqual(["council", "knowledge"]);
  });
});

describe("parseVariantList", () => {
  it("defaults to all variants", () => {
    expect(parseVariantList(undefined)).toEqual({ ok: true, ids: [...VARIANT_IDS] });
  });
  it("normalises case/whitespace and dedupes", () => {
    expect(parseVariantList(" a, C ,a")).toEqual({ ok: true, ids: ["A", "C"] });
  });
  it("rejects unknown ids instead of skipping them", () => {
    const r = parseVariantList("A,H");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("H");
  });
});

describe("planCells / completedCellKeys", () => {
  it("plans repetition-major so a partial run keeps all variants of a task×rep together", () => {
    const plan = planCells(["t1", "t2"], ["A", "C"], 2);
    expect(plan.map((c) => c.key)).toEqual([
      "t1|A|1", "t1|C|1", "t2|A|1", "t2|C|1",
      "t1|A|2", "t1|C|2", "t2|A|2", "t2|C|2",
    ]);
    expect(new Set(plan.map((c) => c.key)).size).toBe(plan.length);
  });

  it("reads finished keys back and ignores torn lines and foreign versions", () => {
    const jsonl = [
      JSON.stringify({ v: CELL_RECORD_VERSION, key: cellKey("t1", "A", 1) }),
      '{"v":1,"key":"t1|C|1"', // torn final write → that cell reruns
      JSON.stringify({ v: 999, key: "t2|A|1" }),
      "",
      JSON.stringify({ v: CELL_RECORD_VERSION, key: "t2|C|1" }),
    ].join("\n");
    expect([...completedCellKeys(jsonl)].sort()).toEqual(["t1|A|1", "t2|C|1"]);
  });
});

// D2-full stage 1 reuses pilot/probe cells. The cell key has no prompt hash,
// so without this guard a rewritten prompt (CORPUS-SPEC-CHECK rewrote five)
// would let an old run count as "done" for a different task.
describe("staleCellRecords", () => {
  const rec = (task: string, variant: string, sha?: string) =>
    JSON.stringify({ v: CELL_RECORD_VERSION, key: `${task}|${variant}|1`, task_id: task, ...(sha ? { prompt_sha256: sha } : {}) });
  const current = new Map([["t1", "aaa"], ["t2", "bbb"]]);

  it("flags a record stamped with another prompt sha, accepts a matching one", () => {
    const jsonl = [rec("t1", "A", "aaa"), rec("t2", "A", "old")].join("\n");
    expect(staleCellRecords(jsonl, current)).toEqual({
      mismatched: [{ key: "t2|A|1", recorded: "old", current: "bbb" }],
      unstamped: [],
    });
  });

  it("lists legacy records without a stamp separately (reuse unverified, not rejected)", () => {
    expect(staleCellRecords(rec("t1", "B"), current)).toEqual({ mismatched: [], unstamped: ["t1|B|1"] });
  });

  it("ignores tasks outside the run, torn lines and other schema versions", () => {
    const jsonl = [rec("other", "A", "zzz"), "{torn", JSON.stringify({ v: 99, key: "t1|A|1", task_id: "t1", prompt_sha256: "x" })].join("\n");
    expect(staleCellRecords(jsonl, current)).toEqual({ mismatched: [], unstamped: [] });
  });
});

// Architecture tasks get 120 min (D2-PROBE: the two big ones need more than
// the 60-min default); a typo must stop the run, not fall back to 60.
describe("parseClassTimeouts", () => {
  it("absent / empty → no overrides", () => {
    expect(parseClassTimeouts(undefined)).toEqual({ ok: true, minutes: {} });
    expect(parseClassTimeouts("")).toEqual({ ok: true, minutes: {} });
  });

  it("parses class=minutes pairs", () => {
    expect(parseClassTimeouts("architecture=120, debug=90")).toEqual({ ok: true, minutes: { architecture: 120, debug: 90 } });
  });

  it("rejects unknown classes, zero and malformed entries (fail-closed)", () => {
    expect(parseClassTimeouts("archtecture=120").ok).toBe(false);
    expect(parseClassTimeouts("architecture=0").ok).toBe(false);
    expect(parseClassTimeouts("architecture").ok).toBe(false);
    expect(parseClassTimeouts("architecture=-5").ok).toBe(false);
  });
});
