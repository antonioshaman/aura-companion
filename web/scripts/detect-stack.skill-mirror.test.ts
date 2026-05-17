// Cross-artifact drift canary for the three suffixless council SKILL.md
// files (Task 8 of v2-router-plan).
//
// The Refactoring expert (REC 1) identified the load-bearing risk: 3 SKILL.md
// Phase 0 blocks duplicating the marker names and refusal template
// exported from `detect-stack.ts`. The economic answer is a single source
// of truth (the TS detector's exported constants) + a mechanical drift
// canary (this test). On any rule change, the TS edit + a red test
// indicate which SKILL.md mirror lines need to follow.
//
// The test resolves the skills directory from the env var
// `COUNCIL_SKILLS_ROOT`, defaulting to `~/.claude/skills`. CI environments
// that do not host the user's skills tree may skip this suite by
// pointing the env var at a fixture dir; for now we skip when the dir
// is absent so the test does not block CI environments where the
// developer's skills directory has not been provisioned.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  MARKER_NAMES,
  OVERRIDE_VALUES,
  REFUSAL_HEADLINES,
} from "./detect-stack.js";

const SKILLS_ROOT =
  process.env.COUNCIL_SKILLS_ROOT ?? join(homedir(), ".claude", "skills");

const SUFFIXLESS = ["council-plan", "council-implement", "council-review"];
const AURA = [
  "council-plan-aura",
  "council-implement-aura",
  "council-review-aura",
];

function skillBody(slug: string): string | null {
  const path = join(SKILLS_ROOT, slug, "SKILL.md");
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

const skillsRootExists = existsSync(SKILLS_ROOT);

describe.skipIf(!skillsRootExists)(
  "SKILL.md cross-artifact drift canary",
  () => {
    describe.each(SUFFIXLESS)("%s — Phase 0 stack detection", (slug) => {
      it("contains a Phase 0 section heading", () => {
        const body = skillBody(slug);
        expect(
          body,
          `SKILL.md not found at ${join(SKILLS_ROOT, slug, "SKILL.md")}`,
        ).not.toBeNull();
        expect(body!).toMatch(/##\s+Phase 0:?\s+Stack [Dd]etection/);
      });
      it("cites every canonical marker name verbatim", () => {
        const body = skillBody(slug);
        if (body === null) return;
        for (const name of Object.values(MARKER_NAMES)) {
          expect(
            body,
            `marker name "${name}" missing from ${slug}/SKILL.md`,
          ).toContain(name);
        }
      });
      it("cites every canonical refusal headline verbatim", () => {
        const body = skillBody(slug);
        if (body === null) return;
        for (const headline of Object.values(REFUSAL_HEADLINES)) {
          expect(
            body,
            `refusal headline "${headline}" missing from ${slug}/SKILL.md`,
          ).toContain(headline);
        }
      });
      it("cites every override allow-list value", () => {
        const body = skillBody(slug);
        if (body === null) return;
        for (const v of OVERRIDE_VALUES) {
          expect(body).toMatch(new RegExp(`\\b${v}\\b`));
        }
      });
    });

    // AC-4.1: the three `-aura` SKILL.md files MUST remain first-class
    // explicit entry points — they do NOT contain a Phase 0 router section.
    describe.each(AURA)(
      "%s — explicit first-class entry stays untouched (AC-4.1)",
      (slug) => {
        it("does NOT contain a Phase 0 stack-detection section", () => {
          const body = skillBody(slug);
          if (body === null) return;
          expect(body).not.toMatch(/##\s+Phase 0:?\s+Stack [Dd]etection/);
        });
      },
    );
  },
);
