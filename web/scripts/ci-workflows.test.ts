/**
 * CI workflow hardening invariants (P7/CI-HARDEN, external tech audit).
 *
 * These checks pin three properties of `.github/workflows/` that are easy to
 * lose in a casual edit and invisible until something goes wrong:
 *   1. a11y / ci / coverage-gate run with a read-only GITHUB_TOKEN
 *      (`permissions: contents: read` at the workflow level), so a compromised
 *      dependency or action in a PR build cannot push or edit the repo.
 *   2. The coverage gate's test steps no longer swallow failures with
 *      `|| true` — a red test run must fail the gate, not just yield a
 *      missing/partial coverage summary that the gate then skips.
 *   3. CI runs a dependency audit. It is intentionally non-blocking for now
 *      (`continue-on-error: true`) while the existing advisory backlog is
 *      cleared; flipping it to blocking is a deliberate later change, and this
 *      test is the place to tighten when that happens.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// ci-workflows.test.ts → web/scripts → web → repo root.
const repoRoot = join(fileURLToPath(import.meta.url), "..", "..", "..");

type Step = { name?: string; run?: string; "continue-on-error"?: boolean; "working-directory"?: string };
type Workflow = { permissions?: unknown; jobs: Record<string, { permissions?: unknown; steps: Step[] }> };

function loadWorkflow(name: string): Workflow {
  return parse(readFileSync(join(repoRoot, ".github", "workflows", name), "utf-8")) as Workflow;
}

describe("CI workflow hardening (P7/CI-HARDEN)", () => {
  // Every PR-triggered workflow that only builds/tests must be read-only.
  // A job-level override that widens permissions would defeat the top-level
  // default, so job-level blocks are checked too.
  it.each(["a11y.yml", "ci.yml", "coverage-gate.yml"])(
    "%s grants the GITHUB_TOKEN only contents: read",
    (file) => {
      const wf = loadWorkflow(file);
      expect(wf.permissions).toEqual({ contents: "read" });
      for (const [job, def] of Object.entries(wf.jobs)) {
        if (def.permissions !== undefined) {
          expect({ job, permissions: def.permissions }).toEqual({ job, permissions: { contents: "read" } });
        }
      }
    },
  );

  // `bun run test -- --coverage || true` made the coverage gate green even
  // when the test run itself failed. No step in the gate may mask an exit code.
  it("coverage-gate does not mask test failures with `|| true`", () => {
    const wf = loadWorkflow("coverage-gate.yml");
    const testSteps = wf.jobs.coverage.steps.filter((s) => s.run?.includes("--coverage"));
    // Both web and platform coverage runs must still exist (guards against
    // "fixing" this test by deleting the steps).
    expect(testSteps).toHaveLength(2);
    for (const step of testSteps) {
      expect(step.run).not.toMatch(/\|\|\s*true/);
      expect(step["continue-on-error"]).not.toBe(true);
    }
  });

  // The audit step must exist and run in web/ (the only package with a
  // committed bun.lock). Non-blocking is the agreed starting point.
  it("ci runs a non-blocking bun audit for web dependencies", () => {
    const wf = loadWorkflow("ci.yml");
    const audit = wf.jobs.quality.steps.find((s) => s.run?.trim().startsWith("bun audit"));
    expect(audit).toBeDefined();
    expect(audit?.["working-directory"]).toBe("web");
    expect(audit?.["continue-on-error"]).toBe(true);
  });
});
