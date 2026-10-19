/**
 * Panel composition for COUNCIL-PANEL-BENCH. Rosters must be deterministic
 * (the same case seats the same panel on every run — the panel is the only
 * variable), and each panel must keep its defining property: FULL = today's
 * engine, ECONOMY never drops a relevant fail-closed lens, MINIMAL = one
 * domain specialist + the adversarial security lens.
 */
import { describe, expect, it } from "vitest";

import { loadHistory, loadProfiles } from "../../../scripts/dispatch-policy.js";
import { loadCases } from "./cases.js";
import { ADVERSARIAL_SEAT, composePanels, parsePanelIds } from "./panels.js";

const profiles = loadProfiles();
const { fingerprintSignals } = loadHistory();
const cases = loadCases();
const pr54 = cases.find((c) => c.id === "pr54-auto-proceed-wireup")!;

describe("composePanels", () => {
  it("pins the exact rosters for PR #54 against the catalog snapshot", () => {
    // Snapshot of the engine output: a change here means the engine or the
    // catalog moved, and every earlier run of this case is no longer comparable.
    const p = composePanels(pr54.changedDomains, fingerprintSignals, profiles, { diffFiles: 7, diffLines: 855 });
    expect(p.FULL.seats).toEqual(["dahl", "abramov", "ritchie", "beck", "fowler", "hashimoto", "hunt", "saarinen", "willison", "vanrossum", "brandur"]);
    expect(p.ECONOMY.seats).toEqual(["beck", "fowler", "hunt", "willison"]);
    expect(p.MINIMAL.seats).toEqual(["dahl", ADVERSARIAL_SEAT]);
  });

  it.each(cases.map((c) => [c.id, c] as const))("%s: ECONOMY ⊆ FULL-candidates, keeps every relevant lens, MINIMAL = specialist + hunt", (_id, c) => {
    const p = composePanels(c.changedDomains, fingerprintSignals, profiles, { diffFiles: 10, diffLines: 1000 });
    expect(p.ECONOMY.seats.length).toBeLessThanOrEqual(p.FULL.seats.length);
    const changed = new Set(c.changedDomains);
    for (const lens of profiles.filter((x) => x.signals.includes("any") && x.domains.some((d) => changed.has(d)))) {
      expect(p.ECONOMY.seats).toContain(lens.id);
    }
    const [primary, adversarial] = p.MINIMAL.seats;
    expect(adversarial).toBe(ADVERSARIAL_SEAT);
    const prof = profiles.find((x) => x.id === primary)!;
    expect(prof.signals).not.toContain("any");
    expect(prof.domains.some((d) => changed.has(d))).toBe(true);
    expect(new Set(p.FULL.seats).size).toBe(p.FULL.seats.length);
  });

  it("fails loudly when no specialist matches the change (MINIMAL would be lens-only)", () => {
    expect(() => composePanels(["security"], [], profiles, { diffFiles: 1, diffLines: 1 })).toThrow(/no domain specialist/);
  });

  it("fails loudly when the adversarial seat is missing from the catalog", () => {
    expect(() =>
      composePanels(pr54.changedDomains, fingerprintSignals, profiles.filter((p) => p.id !== ADVERSARIAL_SEAT), { diffFiles: 7, diffLines: 855 }),
    ).toThrow(/adversarial seat/);
  });
});

describe("parsePanelIds", () => {
  it("parses and dedups", () => expect(parsePanelIds("FULL, MINIMAL,FULL")).toEqual(["FULL", "MINIMAL"]));
  it("rejects unknown and empty lists", () => {
    expect(() => parsePanelIds("FULL,CHEAP")).toThrow(/unknown panel CHEAP/);
    expect(() => parsePanelIds(" , ")).toThrow(/empty/);
  });
});
