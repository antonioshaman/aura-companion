/**
 * Tests for the shared availability resolver (Council Plan Task 2).
 *
 * Pure + injectable: every case passes a FIXTURE lookup, so there is zero disk
 * or network and the registry overlay is never touched. Covers the four
 * outcomes and the policy invariants: 1-hop cap (no cascade), no-cross-tier,
 * argv-id revalidation, and the lattice (runtime exclusions win over a registry
 * `active` mark — the registry can narrow but never resurrect).
 */
import { describe, expect, it } from "vitest";
import type { BackendType } from "./session-types.js";
import type { ModelRegistryEntry } from "./model-registry.js";
import {
  getSuppressedModelIds,
  isModelSuppressed,
  resolveModelAvailability,
  type ResolverLookup,
} from "./model-availability.js";

/** Build an injectable lookup from a flat entry list keyed by (backend, id). */
function fixtureLookup(entries: ModelRegistryEntry[]): ResolverLookup {
  const map = new Map(entries.map((e) => [`${e.backend}\0${e.id}`, e]));
  return (backend: BackendType, id: string) => map.get(`${backend}\0${id}`) ?? null;
}

const opus: ModelRegistryEntry = {
  id: "claude-opus-4-8",
  backend: "claude",
  status: "active",
  replacement: null,
  tier: "max",
};
const sonnet: ModelRegistryEntry = {
  id: "claude-sonnet-4-6",
  backend: "claude",
  status: "active",
  replacement: null,
  tier: "balanced",
};

describe("isModelSuppressed", () => {
  it("is true only for retired and blocked", () => {
    expect(isModelSuppressed("retired")).toBe(true);
    expect(isModelSuppressed("blocked")).toBe(true);
    expect(isModelSuppressed("active")).toBe(false);
    expect(isModelSuppressed("degraded")).toBe(false);
  });
});

describe("resolveModelAvailability — happy path", () => {
  it("returns ok for an active registered model", () => {
    const lookup = fixtureLookup([opus]);
    expect(resolveModelAvailability({ backend: "claude", requested: "claude-opus-4-8", lookup })).toEqual({
      kind: "ok",
      model: "claude-opus-4-8",
    });
  });

  it("returns ok for a model the registry does not annotate (overlay only narrows)", () => {
    const lookup = fixtureLookup([]);
    expect(resolveModelAvailability({ backend: "claude", requested: "claude-unlisted-9", lookup })).toEqual({
      kind: "ok",
      model: "claude-unlisted-9",
    });
  });

  it("returns ok for a degraded model (offered, just marked)", () => {
    const degraded: ModelRegistryEntry = { ...opus, status: "degraded" };
    const lookup = fixtureLookup([degraded]);
    expect(resolveModelAvailability({ backend: "claude", requested: "claude-opus-4-8", lookup }).kind).toBe("ok");
  });
});

describe("resolveModelAvailability — argv safety (Hunt REC-1)", () => {
  it("never returns ok for a structurally-invalid requested id", () => {
    const lookup = fixtureLookup([]);
    const r = resolveModelAvailability({ backend: "claude", requested: "-dangerous", lookup });
    expect(r).toEqual({ kind: "unavailable", model: "-dangerous", reason: "invalid-id" });
  });
});

describe("resolveModelAvailability — substitution (1 hop, same tier)", () => {
  it("substitutes a retired model with its valid same-tier replacement", () => {
    const retiredOpus: ModelRegistryEntry = { ...opus, status: "retired", replacement: "claude-opus-4-7", tier: "max" };
    const opus47: ModelRegistryEntry = { id: "claude-opus-4-7", backend: "claude", status: "active", replacement: null, tier: "max" };
    const lookup = fixtureLookup([retiredOpus, opus47]);
    expect(resolveModelAvailability({ backend: "claude", requested: "claude-opus-4-8", lookup })).toEqual({
      kind: "substituted",
      from: "claude-opus-4-8",
      to: "claude-opus-4-7",
      reason: "retired",
    });
  });

  it("reports the blocked reason when the suppressed status is blocked", () => {
    const blockedOpus: ModelRegistryEntry = { ...opus, status: "blocked", replacement: "claude-opus-4-7", tier: "max" };
    const opus47: ModelRegistryEntry = { id: "claude-opus-4-7", backend: "claude", status: "active", replacement: null, tier: "max" };
    const lookup = fixtureLookup([blockedOpus, opus47]);
    const r = resolveModelAvailability({ backend: "claude", requested: "claude-opus-4-8", lookup });
    expect(r.kind === "substituted" && r.reason).toBe("blocked");
  });

  it("substitutes when a tier is unknown on either side (cannot prove a crossing)", () => {
    const retired: ModelRegistryEntry = { id: "claude-opus-4-8", backend: "claude", status: "retired", replacement: "claude-opus-4-7" };
    const rep: ModelRegistryEntry = { id: "claude-opus-4-7", backend: "claude", status: "active", replacement: null };
    const lookup = fixtureLookup([retired, rep]);
    expect(resolveModelAvailability({ backend: "claude", requested: "claude-opus-4-8", lookup }).kind).toBe("substituted");
  });
});

describe("resolveModelAvailability — unavailable (retain current)", () => {
  it("is unavailable/no-replacement when the suppressed model has no replacement", () => {
    const retired: ModelRegistryEntry = { ...opus, status: "retired", replacement: null };
    const lookup = fixtureLookup([retired]);
    expect(resolveModelAvailability({ backend: "claude", requested: "claude-opus-4-8", lookup })).toEqual({
      kind: "unavailable",
      model: "claude-opus-4-8",
      reason: "no-replacement",
    });
  });

  it("is unavailable/replacement-invalid when the configured replacement fails validation", () => {
    // A replacement that survived parse as null cannot occur; this guards the
    // resolver directly against a fixture/disk path that hands an invalid id.
    const retired = { ...opus, status: "retired" as const, replacement: "-evil" } as ModelRegistryEntry;
    const lookup = fixtureLookup([retired]);
    expect(resolveModelAvailability({ backend: "claude", requested: "claude-opus-4-8", lookup }).kind).toBe("unavailable");
    const r = resolveModelAvailability({ backend: "claude", requested: "claude-opus-4-8", lookup });
    expect(r.kind === "unavailable" && r.reason).toBe("replacement-invalid");
  });

  it("stops after one hop: a replacement that is itself suppressed retains current (no cascade)", () => {
    const retiredOpus: ModelRegistryEntry = { ...opus, status: "retired", replacement: "claude-opus-4-7", tier: "max" };
    const retiredRep: ModelRegistryEntry = { id: "claude-opus-4-7", backend: "claude", status: "retired", replacement: "claude-opus-4-6", tier: "max" };
    const lookup = fixtureLookup([retiredOpus, retiredRep]);
    expect(resolveModelAvailability({ backend: "claude", requested: "claude-opus-4-8", lookup })).toEqual({
      kind: "unavailable",
      model: "claude-opus-4-8",
      reason: "replacement-unavailable",
    });
  });

  it("stops after one hop: a replacement that is runtime-excluded retains current", () => {
    const retiredOpus: ModelRegistryEntry = { ...opus, status: "retired", replacement: "claude-opus-4-7", tier: "max" };
    const repActive: ModelRegistryEntry = { id: "claude-opus-4-7", backend: "claude", status: "active", replacement: null, tier: "max" };
    const lookup = fixtureLookup([retiredOpus, repActive]);
    const r = resolveModelAvailability({
      backend: "claude",
      requested: "claude-opus-4-8",
      exclusions: ["claude-opus-4-7"],
      lookup,
    });
    expect(r).toEqual({ kind: "unavailable", model: "claude-opus-4-8", reason: "replacement-unavailable" });
  });
});

describe("resolveModelAvailability — no-cross-tier", () => {
  it("requires user action when the only replacement crosses a cost tier", () => {
    const retiredOpus: ModelRegistryEntry = { ...opus, status: "retired", replacement: "claude-sonnet-4-6", tier: "max" };
    const lookup = fixtureLookup([retiredOpus, sonnet]); // sonnet is tier "balanced"
    expect(resolveModelAvailability({ backend: "claude", requested: "claude-opus-4-8", lookup })).toEqual({
      kind: "needs-user-action",
      from: "claude-opus-4-8",
      to: "claude-sonnet-4-6",
      reason: "cross-tier",
      suppressed: "retired",
    });
  });
});

describe("resolveModelAvailability — lattice (runtime wins, registry never resurrects)", () => {
  it("does NOT return ok for a registry-active model that runtime truth has killed", () => {
    const lookup = fixtureLookup([opus]); // active, replacement null
    const r = resolveModelAvailability({
      backend: "claude",
      requested: "claude-opus-4-8",
      exclusions: ["claude-opus-4-8"],
      lookup,
    });
    // No resurrection: not ok. With no replacement, current is retained.
    expect(r).toEqual({ kind: "unavailable", model: "claude-opus-4-8", reason: "no-replacement" });
  });

  it("narrows a runtime-excluded active model toward its registry replacement when one exists", () => {
    const activeWithRep: ModelRegistryEntry = { ...opus, status: "active", replacement: "claude-opus-4-7", tier: "max" };
    const rep: ModelRegistryEntry = { id: "claude-opus-4-7", backend: "claude", status: "active", replacement: null, tier: "max" };
    const lookup = fixtureLookup([activeWithRep, rep]);
    const r = resolveModelAvailability({
      backend: "claude",
      requested: "claude-opus-4-8",
      exclusions: ["claude-opus-4-8"],
      lookup,
    });
    // Runtime-killed active model reads as "blocked" for messaging, swaps 1 hop.
    expect(r).toEqual({ kind: "substituted", from: "claude-opus-4-8", to: "claude-opus-4-7", reason: "blocked" });
  });
});

describe("getSuppressedModelIds", () => {
  it("collects only suppressed ids for the requested backend", () => {
    const registry = new Map<string, ModelRegistryEntry>([
      ["claude\0a", { id: "a", backend: "claude", status: "retired", replacement: null }],
      ["claude\0b", { id: "b", backend: "claude", status: "active", replacement: null }],
      ["claude\0c", { id: "c", backend: "claude", status: "blocked", replacement: null }],
      ["codex\0d", { id: "d", backend: "codex", status: "retired", replacement: null }],
    ]);
    expect(getSuppressedModelIds("claude", registry)).toEqual(new Set(["a", "c"]));
    expect(getSuppressedModelIds("codex", registry)).toEqual(new Set(["d"]));
  });
});
