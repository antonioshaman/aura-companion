/**
 * Tests for the publish filter (P6/D3-REFRESH). The committed
 * `docs/aurabench/data/*.jsonl` must keep every field the report reads and
 * nothing that identifies the bench box: no absolute paths, no credential
 * shapes. The guard must fail loudly rather than publish a leak.
 */

import { describe, it, expect } from "vitest";
import { assertPublishable, publishCellsJsonl, sanitizeCellForPublish } from "./publish.js";

const raw = {
  key: "t1|A|1",
  task_id: "t1",
  variant: "A",
  success: true,
  metrics: { cost_usd: 0.5 },
  confounds: ["agent read /home/auracomp/aura-diet/bench/clone/README.md"],
  isolation: {
    violations: [],
    layer_evidence: { auto_proceed_fires: 3, review_files: ["/tmp/x/.council/reviews/a.md"] },
    council_halves: { observer: "codex" },
    worktree: "/home/auracomp/aura-diet/wt-cells/c-1",
    claude_auth: { credentials: "/home/auracomp/aura-diet/bench/cells/t1/A-1/claude-config/.credentials.json" },
    skills: ["design"],
  },
};

describe("sanitizeCellForPublish", () => {
  it("keeps only the isolation fields the report reads and leaves the verdict intact", () => {
    // worktree / claude_auth / skills are bench-box detail; the report needs
    // violations (exclusion), layer_evidence (auto-proceed waits) and council_halves.
    const s = sanitizeCellForPublish(raw);
    expect(Object.keys(s.isolation as object).sort()).toEqual(["council_halves", "layer_evidence", "violations"]);
    expect(s).toMatchObject({ key: "t1|A|1", success: true, metrics: { cost_usd: 0.5 } });
  });

  it("replaces absolute paths anywhere, including nested arrays and confounds", () => {
    const s = sanitizeCellForPublish(raw);
    expect(s.confounds).toEqual(["agent read <path>"]);
    expect((s.isolation as { layer_evidence: { review_files: string[] } }).layer_evidence.review_files).toEqual(["<path>"]);
    // Relative repo paths are the evidence the report cites — they stay.
    expect(sanitizeCellForPublish({ confounds: ["web/server/x.ts"] }).confounds).toEqual(["web/server/x.ts"]);
  });
});

describe("publishCellsJsonl", () => {
  it("filters records and emits sanitized JSONL", () => {
    const jsonl = [JSON.stringify(raw), "", JSON.stringify({ ...raw, key: "t1|G|1", variant: "G" })].join("\n");
    const out = publishCellsJsonl(jsonl, (r) => r.variant !== "G");
    expect(out.trim().split("\n")).toHaveLength(1);
    expect(out).not.toContain("/home/");
    expect(out).not.toContain(".credentials.json");
  });
});

describe("assertPublishable", () => {
  it.each([
    ["a home path", '{"x":"/home/someone/repo"}'],
    ["an Anthropic key", '{"x":"sk-ant-api03-abcdefghijkl"}'],
    ["a JWT", '{"x":"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0"}'],
    ["a token field", '{"refresh_token":"x"}'],
  ])("refuses %s", (_label, text) => {
    expect(() => assertPublishable(text)).toThrow(/refusing to publish/);
  });

  it("passes clean text through unchanged", () => {
    expect(assertPublishable('{"x":"<path>"}')).toBe('{"x":"<path>"}');
    // Isolation prose names the credentials file without its location — not a leak.
    const prose = '{"claude_auth":"no .credentials.json; access token only"}';
    expect(assertPublishable(prose)).toBe(prose);
  });
});
