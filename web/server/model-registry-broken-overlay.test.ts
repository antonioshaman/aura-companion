import { describe, it, expect, vi, afterEach } from "vitest";

// The broken-model table is the single source of truth for "spawn rewrites
// this model". These tests prove `lookupModel` — which feeds BOTH the
// dropdown's /models status overlay and the set_model availability resolver —
// reflects it, so the picker can never offer a model the spawn path rewrites.
// The live table is empty since the 2026-10-16 CLI 2.1.283 re-probe, so the
// table is injected here.
const table = vi.hoisted(() => ({
  entries: [] as Array<{ from: string; to: string; reason: string }>,
}));
vi.mock("./broken-model-substitution.js", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("./broken-model-substitution.js");
  return {
    ...actual,
    resolveModelSubstitution: (model: string | null | undefined) =>
      (model && table.entries.find((e) => e.from === model)) || null,
  };
});

import { lookupModel } from "./model-registry.js";

afterEach(() => {
  table.entries = [];
});

describe("lookupModel — broken-model table overlay", () => {
  it("a Claude model listed in the broken table reads as blocked with the spawn substitute as replacement", () => {
    table.entries = [{ from: "claude-opus-5", to: "claude-opus-4-8", reason: "fixture CLI stdout bug" }];
    const entry = lookupModel("claude", "claude-opus-5");
    expect(entry).toMatchObject({
      id: "claude-opus-5",
      backend: "claude",
      status: "blocked",
      replacement: "claude-opus-4-8",
    });
  });

  it("an unlisted model is unaffected by the overlay", () => {
    table.entries = [{ from: "claude-opus-5", to: "claude-opus-4-8", reason: "fixture" }];
    // Not in the bundled registry and not in the table → null (no annotation).
    expect(lookupModel("claude", "claude-made-up-9")).toBeNull();
  });

  it("the table is Claude-only — a Codex id with the same string is not overlaid", () => {
    table.entries = [{ from: "gpt-x", to: "gpt-y", reason: "fixture" }];
    expect(lookupModel("codex", "gpt-x")).toBeNull();
  });
});
