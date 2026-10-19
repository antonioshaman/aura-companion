// The single source of truth for the RC-2 dispatcher structural contract (fowler #4).
//
// Imported by BOTH the contract test (skill-dispatcher-contract.test.ts) and the
// fixture builder (build-council-skill-fixture.ts) so the two can never drift — they
// previously hardcoded identical lists synced only by a "kept in lockstep" comment.
//
// The contract a council SKILL.md must satisfy after the RC-2 consolidation:
//   - it embeds NO fixed panel and NO retired two-stack stack-detection router;
//   - it delegates selection to selection-engine.md and carries the checkpoint step.

// Retired two-stack-router marker names + refusal headlines, and the fixed-panel
// heading. A literal match means a router/panel was re-embedded verbatim.
export const FORBIDDEN_SUBSTRINGS = [
  "### Council panel",
  "**Panel:**",
  "## Phase 0: Stack Detection",
  "Stack detection: no recognised stack markers",
  "Stack detection: both Aura and Python markers present",
  ".council-stack-override",
  "name=aura-companion",
];

export const REQUIRED_TOKENS = ["council/checkpoint", "selection-engine.md"];

// A fixed-panel bullet run: ≥3 CONSECUTIVE lines of the shape `- <advisor-id>` (a
// bare lowercase catalog id, nothing after it). The retired panels were exactly
// this shape. Checking the SHAPE — not a blocklisted heading string — catches a
// panel re-embedded under ANY heading (beck #1: the old blocklist missed a panel
// under a renamed "## Phase 0: Advisor Selection" heading). Legitimate bullets
// (`- **ritchie …**`, `- hono: [...]`, `- One question …`) do not match: they are
// not a bare lowercase id alone on the line.
const ID_BULLET = /^- [a-z][a-z0-9-]{1,31}[ \t]*$/;
const PANEL_RUN_THRESHOLD = 3;

/**
 * Return every way `body` violates the dispatcher contract (empty = conforming).
 * Structural, not a bare substring scan.
 */
export function findContractViolations(body: string): string[] {
  const violations: string[] = [];
  for (const token of FORBIDDEN_SUBSTRINGS) {
    if (body.includes(token)) violations.push(`re-embedded router/panel marker: "${token}"`);
  }
  for (const token of REQUIRED_TOKENS) {
    if (!body.includes(token)) violations.push(`missing required delegation/step token: "${token}"`);
  }
  let run = 0;
  for (const line of body.split("\n")) {
    if (ID_BULLET.test(line)) {
      run += 1;
      if (run >= PANEL_RUN_THRESHOLD) {
        violations.push(
          `fixed-panel bullet run: ${PANEL_RUN_THRESHOLD}+ consecutive bare advisor-id bullets ` +
            `(a re-embedded panel; the catalog is the panel)`,
        );
        break;
      }
    } else {
      run = 0;
    }
  }
  return violations;
}
