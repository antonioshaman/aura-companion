/**
 * Observer-review replay corpus (Task 13).
 *
 * Six fixtures under `__fixtures__/observer-reviews/` exercise the load-
 * bearing branches of `parseObserverReviewPayload` + `validateObserverFindings`:
 *
 * | # | Fixture                              | What it validates                                |
 * |---|--------------------------------------|--------------------------------------------------|
 * | 1 | 01-stop-grounded.json                | STOP grounded in modifiedFiles — kept            |
 * | 2 | 02-stop-evidence-outside-delta.json  | STOP outside modifiedFiles — downgrades to NOTE  |
 * | 3 | 03-stop-evidence-missing.json        | STOP with non-existent file — downgrades to NOTE |
 * | 4 | 04-claim-multi-word-unicode.json     | claim with unicode / tabs / newlines — accepted  |
 * | 5 | 05-polymorphic-extra-fields.json     | unknown extra fields — tolerated (EC-5)          |
 * | 6 | 06-malformed-json.txt                | malformed JSON — rejected with reason            |
 *
 * EC-6: load-bearing protocol parsers require replay-based regression
 * tests against captured fixtures. Hand-crafted JSON literals do not
 * substitute. These fixtures are the captured corpus for the council
 * payload boundary; refresh them when the upstream observer ships a
 * schema change.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  parseObserverReviewPayload,
  type CouncilParserDropReason,
} from "./council-types.js";
import { validateObserverFindings } from "./observer-grounding.js";

const FIXTURE_DIR = join(__dirname, "__fixtures__", "observer-reviews");

function loadFixture(filename: string): string {
  return readFileSync(join(FIXTURE_DIR, filename), "utf-8");
}

describe("observer-review fixture corpus — parser + grounding gate", () => {
  // Sanity check: ensures we don't lose fixtures silently after a rename.
  // The corpus is the contract; missing files should be a visible failure.
  it("the fixture directory contains exactly the six documented files", () => {
    const files = readdirSync(FIXTURE_DIR).sort();
    expect(files).toEqual([
      "01-stop-grounded.json",
      "02-stop-evidence-outside-delta.json",
      "03-stop-evidence-missing.json",
      "04-claim-multi-word-unicode.json",
      "05-polymorphic-extra-fields.json",
      "06-malformed-json.txt",
    ]);
  });

  // ── 1. STOP grounded ─────────────────────────────────────────────────────
  it("fixture 01 — STOP grounded in modifiedFiles: parses, no downgrade", () => {
    const raw = loadFixture("01-stop-grounded.json");
    const review = parseObserverReviewPayload(raw);
    expect(review).not.toBeNull();
    expect(review!.findings).toHaveLength(1);
    expect(review!.findings[0]!.severity).toBe("STOP");

    const result = validateObserverFindings(review!, {
      workspaceRoot: "/root/aura-companion",
      modifiedFiles: new Set(["web/server/recorder.ts"]),
      existsRelative: (p) => p === "web/server/recorder.ts",
    });
    expect(result.downgrades).toEqual([]);
    expect(result.findings[0]!.severity).toBe("STOP");
  });

  // ── 2. STOP outside delta ────────────────────────────────────────────────
  it("fixture 02 — STOP evidence_path outside modifiedFiles: downgrades to NOTE", () => {
    const raw = loadFixture("02-stop-evidence-outside-delta.json");
    const review = parseObserverReviewPayload(raw);
    expect(review).not.toBeNull();
    expect(review!.findings[0]!.severity).toBe("STOP");

    const result = validateObserverFindings(review!, {
      workspaceRoot: "/root/aura-companion",
      modifiedFiles: new Set(["web/server/recorder.ts"]),
      existsRelative: () => true, // existence is moot — the path isn't in modifiedFiles
    });
    expect(result.downgrades).toHaveLength(1);
    expect(result.downgrades[0]!.reason).toBe("evidence_not_in_modified_set");
    expect(result.findings[0]!.severity).toBe("NOTE");
  });

  // ── 3. STOP evidence missing on disk ─────────────────────────────────────
  it("fixture 03 — STOP evidence_path missing on disk: downgrades to NOTE", () => {
    const raw = loadFixture("03-stop-evidence-missing.json");
    const review = parseObserverReviewPayload(raw);
    expect(review).not.toBeNull();

    const result = validateObserverFindings(review!, {
      workspaceRoot: "/root/aura-companion",
      modifiedFiles: new Set(["web/server/nonexistent-on-disk.ts"]),
      existsRelative: () => false, // simulate file missing on disk
    });
    expect(result.downgrades).toHaveLength(1);
    expect(result.downgrades[0]!.reason).toBe("evidence_missing_on_disk");
    expect(result.findings[0]!.severity).toBe("NOTE");
  });

  // ── 4. Multi-word + unicode + control claims ─────────────────────────────
  it("fixture 04 — multi-word claim with unicode + tabs + newlines: accepted", () => {
    const raw = loadFixture("04-claim-multi-word-unicode.json");
    const review = parseObserverReviewPayload(raw);
    expect(review).not.toBeNull();
    expect(review!.findings).toHaveLength(2);
    // Unicode roundtrip preserved verbatim — non-ASCII codepoints aren't
    // mangled by the validator. The "smart quotes" + Cyrillic + CJK are
    // the canary for validator-per-semantic-category (isBoundedText
    // allows spaces, unlike isBoundedToken).
    expect(review!.findings[0]!.claim).toContain("“smart quotes”");
    expect(review!.findings[0]!.claim).toContain("кириллица");
    expect(review!.findings[0]!.claim).toContain("漢字");
    // Tabs (0x09) + newlines (0x0a) ARE allowed in isBoundedText.
    expect(review!.findings[1]!.claim).toContain("\t");
    expect(review!.findings[1]!.claim).toContain("\n");
  });

  // ── 5. Polymorphic extra fields ─────────────────────────────────────────
  it("fixture 05 — unknown extra fields at top level + inside finding: tolerated (EC-5)", () => {
    const raw = loadFixture("05-polymorphic-extra-fields.json");
    const review = parseObserverReviewPayload(raw);
    expect(review).not.toBeNull();
    // The parser drops the unknown fields silently — output type carries
    // only the declared shape; tolerance means the parse SUCCEEDS, not
    // that the fields round-trip. EC-5: strict on discriminator,
    // permissive on polymorphic-by-spec FIELDS.
    expect(review!.findings).toHaveLength(1);
    expect(review!.findings[0]!.severity).toBe("WARN");
    // Spec confirms a known-field set; no expectation that the unknown
    // fields appear on the typed output.
    expect(Object.keys(review!)).not.toContain("unknown_top_level_field");
  });

  // ── 6. Malformed JSON ────────────────────────────────────────────────────
  it("fixture 06 — structurally malformed JSON: rejected with json-parse-error", () => {
    const raw = loadFixture("06-malformed-json.txt");
    const drops: Array<{ reason: CouncilParserDropReason; field?: string }> = [];
    const review = parseObserverReviewPayload(raw, (reason, field) => {
      drops.push({ reason, field });
    });
    expect(review).toBeNull();
    // Exactly one drop signal fires — the parser must not double-report.
    expect(drops).toHaveLength(1);
    expect(drops[0]!.reason).toBe("json-parse-error");
  });

  // ── Cross-fixture: every accepted fixture round-trips through the
  //    grounding gate without throwing, even with empty modifiedFiles ──────
  it("every accepted fixture validates against an empty modifiedFiles set without throwing", () => {
    const acceptedFiles = [
      "01-stop-grounded.json",
      "02-stop-evidence-outside-delta.json",
      "03-stop-evidence-missing.json",
      "04-claim-multi-word-unicode.json",
      "05-polymorphic-extra-fields.json",
    ];
    for (const f of acceptedFiles) {
      const review = parseObserverReviewPayload(loadFixture(f));
      expect(review).not.toBeNull();
      const result = validateObserverFindings(review!, {
        workspaceRoot: "/root/aura-companion",
        modifiedFiles: new Set(),
        existsRelative: () => false,
      });
      // All STOPs in the corpus downgrade when modifiedFiles is empty;
      // non-STOPs pass through unchanged. Either way, no throw.
      expect(result.findings.length).toBe(review!.findings.length);
    }
  });
});
