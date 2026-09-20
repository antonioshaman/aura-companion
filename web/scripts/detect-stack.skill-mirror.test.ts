// Structural contract for the six council SKILL.md dispatchers (RC-2).
//
// HISTORY. This file used to be a *drift canary* pinning the three suffixless
// SKILL.md Phase-0 blocks to the marker names + refusal headlines exported from
// `detect-stack.ts` — the old two-stack detect-or-refuse router. RC-2 retires
// that model: advisor selection is now adaptive and universal, defined once in
// `~/.claude/skills/_council-experts/selection-engine.md`, and `detect-stack.ts`
// (verdict-router) + `detect-stack.test.ts` were deleted with it. There is no
// longer a marker/headline export to pin prose against.
//
// The contract this file now enforces is the inverse — the property the
// migration must not silently regress:
//
//   1. NO dispatcher SKILL.md embeds a fixed panel (`### Council panel` /
//      `**Panel:**` bullet list) or a stack-detection router (a `## Phase 0:
//      Stack Detection` heading, the marker names, or a refusal headline). The
//      catalog IS the panel; a re-embedded panel would resurrect the drift the
//      catalog verifier's C2/C6/C13 were rebuilt to prevent.
//   2. ALL SIX dispatchers delegate selection to `selection-engine.md` — the
//      single source of truth for who sits. An alias that grew its own panel or
//      router would "contain selection logic" and stop being thin.
//   3. Every dispatcher still carries the `council/checkpoint` emit step. Its
//      absence was a real months-long outage (the emit phase existed only in the
//      `-aura` skills; every non-Aura workspace routed to the inline body, never
//      POSTed a checkpoint, and its Council observer sat idle). This assertion
//      pins the step into all six so a branch can't lose it again.
//
// Runs against two roots: a checked-in fixture (never skipped — the load-bearing
// CI gate) and the operator's live `~/.claude/skills` (skipped when absent).

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const FIXTURE_ROOT = join(
  dirname(new URL(import.meta.url).pathname),
  "__fixtures__",
  "council-skills",
);
const LIVE_ROOT =
  process.env.COUNCIL_SKILLS_ROOT ?? join(homedir(), ".claude", "skills");

const DISPATCHERS = [
  "council-plan",
  "council-plan-aura",
  "council-review",
  "council-review-aura",
  "council-implement",
  "council-implement-aura",
];

// Tokens that MUST NOT survive anywhere in a dispatcher body — each is a marker
// name or refusal headline from the retired two-stack router, or the fixed-panel
// heading. A match means a router/panel was re-embedded.
const FORBIDDEN_SUBSTRINGS = [
  "### Council panel",
  "**Panel:**",
  "## Phase 0: Stack Detection",
  "Stack detection: no recognised stack markers",
  "Stack detection: both Aura and Python markers present",
  ".council-stack-override",
  "name=aura-companion",
];

const REQUIRED_STEP_TOKENS = ["council/checkpoint", "selection-engine.md"];

function runSuite(rootLabel: string, root: string) {
  function skillBody(slug: string): string {
    const path = join(root, slug, "SKILL.md");
    if (!existsSync(path)) throw new Error(`SKILL.md not found at ${path}`);
    return readFileSync(path, "utf8");
  }

  describe(`SKILL.md structural contract (${rootLabel})`, () => {
    describe.each(DISPATCHERS)("%s", (slug) => {
      it("embeds no fixed panel and no stack-detection router", () => {
        const body = skillBody(slug);
        for (const token of FORBIDDEN_SUBSTRINGS) {
          expect(
            body.includes(token),
            `${slug}/SKILL.md still contains "${token}" — the fixed panel / stack router must be gone (the catalog is the panel; selection is delegated to selection-engine.md)`,
          ).toBe(false);
        }
      });

      it.each(REQUIRED_STEP_TOKENS)(
        "delegates/steps: carries the %s reference",
        (token) => {
          expect(
            skillBody(slug),
            `${slug}/SKILL.md is missing the "${token}" reference`,
          ).toContain(token);
        },
      );
    });
  });
}

// Never skipped — this is the CI gate.
runSuite("checked-in fixture", FIXTURE_ROOT);

// Additional case: the operator's actual installation. Absent in CI.
const liveRootExists = existsSync(LIVE_ROOT);
describe.skipIf(!liveRootExists)("live skills tree", () => {
  runSuite("live tree", LIVE_ROOT);
});
