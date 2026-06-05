import { describe, it, expect } from "vitest";
import {
  stripClaudePrefix,
  pickTopPerTier,
  renderClaudeModelsLiteral,
  rewriteBlock,
} from "./sync-claude-models.js";

describe("sync-claude-models: stripClaudePrefix", () => {
  it("drops 'Claude ' prefix from a typical display_name", () => {
    expect(stripClaudePrefix("Claude Opus 4.8")).toBe("Opus 4.8");
  });

  it("is a no-op when no prefix is present", () => {
    expect(stripClaudePrefix("Opus 4.8")).toBe("Opus 4.8");
  });

  it("only strips a leading prefix (not internal occurrences)", () => {
    expect(stripClaudePrefix("Opus Claude Variant")).toBe("Opus Claude Variant");
  });
});

describe("sync-claude-models: pickTopPerTier", () => {
  // The upstream sort guarantees opus > sonnet > haiku then created_at desc,
  // so the FIRST entry of each tier in the input IS the latest.
  it("picks one model per tier in opus/sonnet/haiku order", () => {
    const sorted = [
      { id: "claude-opus-4-8", display_name: "Claude Opus 4.8", created_at: 200 },
      { id: "claude-opus-4-7", display_name: "Claude Opus 4.7", created_at: 100 },
      { id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6", created_at: 150 },
      { id: "claude-haiku-4-5-20251001", display_name: "Claude Haiku 4.5", created_at: 110 },
    ];
    expect(pickTopPerTier(sorted)).toEqual([
      { value: "claude-opus-4-8", label: "Opus 4.8" },
      { value: "claude-sonnet-4-6", label: "Sonnet 4.6" },
      { value: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
    ]);
  });

  it("falls back to id when display_name is undefined", () => {
    const sorted = [
      { id: "claude-opus-4-8", display_name: undefined, created_at: undefined },
    ];
    expect(pickTopPerTier(sorted)).toEqual([
      { value: "claude-opus-4-8", label: "claude-opus-4-8" },
    ]);
  });

  it("ignores entries whose id contains no known tier substring", () => {
    const sorted = [
      { id: "claude-mythos-1-0", display_name: "Claude Mythos 1.0", created_at: 200 },
      { id: "claude-opus-4-8", display_name: "Claude Opus 4.8", created_at: 100 },
    ];
    expect(pickTopPerTier(sorted)).toEqual([
      { value: "claude-opus-4-8", label: "Opus 4.8" },
    ]);
  });

  it("returns empty array on empty input", () => {
    expect(pickTopPerTier([])).toEqual([]);
  });
});

describe("sync-claude-models: renderClaudeModelsLiteral", () => {
  it("produces a deterministic export literal matching the static fallback shape", () => {
    const rendered = renderClaudeModelsLiteral([
      { value: "claude-opus-4-8", label: "Opus 4.8" },
      { value: "claude-sonnet-4-6", label: "Sonnet 4.6" },
      { value: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
    ]);
    expect(rendered).toBe(
      [
        "export const CLAUDE_MODELS: ModelOption[] = [",
        '  { value: "claude-opus-4-8", label: "Opus 4.8", icon: "" },',
        '  { value: "claude-sonnet-4-6", label: "Sonnet 4.6", icon: "" },',
        '  { value: "claude-haiku-4-5-20251001", label: "Haiku 4.5", icon: "" },',
        "];",
      ].join("\n"),
    );
  });

  it("is byte-identical for identical input (idempotency canary)", () => {
    const a = renderClaudeModelsLiteral([{ value: "claude-opus-4-8", label: "Opus 4.8" }]);
    const b = renderClaudeModelsLiteral([{ value: "claude-opus-4-8", label: "Opus 4.8" }]);
    expect(a).toBe(b);
  });
});

describe("sync-claude-models: rewriteBlock", () => {
  const SAMPLE = `
some preceding code
// AUTO-GENERATED:CLAUDE-MODELS-START
export const CLAUDE_MODELS: ModelOption[] = [
  { value: "claude-opus-4-7", label: "Opus 4.7", icon: "" },
];
// AUTO-GENERATED:CLAUDE-MODELS-END
trailing code
`.trim();

  it("replaces only the block between the sentinels (sentinels themselves preserved)", () => {
    const updated = rewriteBlock(
      SAMPLE,
      'export const CLAUDE_MODELS: ModelOption[] = [\n  { value: "claude-opus-4-8", label: "Opus 4.8", icon: "" },\n];',
    );
    expect(updated).toContain("// AUTO-GENERATED:CLAUDE-MODELS-START");
    expect(updated).toContain("// AUTO-GENERATED:CLAUDE-MODELS-END");
    expect(updated).toContain('claude-opus-4-8');
    expect(updated).not.toContain('claude-opus-4-7');
    expect(updated.startsWith("some preceding code")).toBe(true);
    expect(updated.endsWith("trailing code")).toBe(true);
  });

  it("is idempotent — rewriting with the SAME block produces byte-identical output", () => {
    const block =
      'export const CLAUDE_MODELS: ModelOption[] = [\n  { value: "claude-opus-4-7", label: "Opus 4.7", icon: "" },\n];';
    const once = rewriteBlock(SAMPLE, block);
    const twice = rewriteBlock(once, block);
    expect(twice).toBe(once);
  });

  it("throws when the START sentinel is missing", () => {
    const bad = SAMPLE.replace("// AUTO-GENERATED:CLAUDE-MODELS-START", "");
    expect(() => rewriteBlock(bad, "...")).toThrow(/sentinels not found/);
  });

  it("throws when the END sentinel is missing", () => {
    const bad = SAMPLE.replace("// AUTO-GENERATED:CLAUDE-MODELS-END", "");
    expect(() => rewriteBlock(bad, "...")).toThrow(/sentinels not found/);
  });

  it("throws when the END sentinel comes BEFORE the START sentinel", () => {
    const bad =
      "// AUTO-GENERATED:CLAUDE-MODELS-END\nmiddle\n// AUTO-GENERATED:CLAUDE-MODELS-START";
    expect(() => rewriteBlock(bad, "...")).toThrow(/sentinels not found/);
  });
});
