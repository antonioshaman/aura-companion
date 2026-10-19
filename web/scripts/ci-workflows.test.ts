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
 *   4. The observer-prompt drift gate is ONE script (`check-observer-prompt-drift`)
 *      that diffs BOTH generated outputs — `server/observer-prompt-bundled.ts`
 *      and `../.council/prompts/observer-system.md` (rewritten by the bundler
 *      since the SOUL splice, handoff 2026-10-18 §4) — and CI, the pre-commit
 *      hook and `prepublishOnly` all call that script. A path dropped from the
 *      list, or a gate that stops calling the script, re-opens silent drift on
 *      that path (council review 2026-10-18-1815, beck P3 / fowler P3 / hashimoto P3).
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
  it("the observer-prompt drift gate diffs both generated files and is shared by CI, pre-commit and prepublishOnly", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "web", "package.json"), "utf-8")) as {
      scripts: Record<string, string>;
    };
    const gate = pkg.scripts["check-observer-prompt-drift"];
    expect(gate).toBeDefined();
    expect(gate).toContain("build-observer-prompt-bundle");
    expect(gate).toMatch(/git diff --exit-code/);
    expect(gate).toContain("server/observer-prompt-bundled.ts");
    expect(gate).toContain("../.council/prompts/observer-system.md");

    expect(pkg.scripts.prepublishOnly).toContain("check-observer-prompt-drift");

    const wf = loadWorkflow("ci.yml");
    const ciSteps = Object.values(wf.jobs).flatMap((j) => j.steps);
    const ciGate = ciSteps.find((s) => s.run?.includes("check-observer-prompt-drift"));
    expect(ciGate, "ci.yml must run the shared drift gate").toBeDefined();
    expect(ciGate?.["working-directory"]).toBe("web");

    const hook = readFileSync(join(repoRoot, ".husky", "pre-commit"), "utf-8");
    expect(hook).toContain("check-observer-prompt-drift");
  });

  it("ci runs a non-blocking bun audit for web dependencies", () => {
    const wf = loadWorkflow("ci.yml");
    const audit = wf.jobs.quality.steps.find((s) => s.run?.trim().startsWith("bun audit"));
    expect(audit).toBeDefined();
    expect(audit?.["working-directory"]).toBe("web");
    expect(audit?.["continue-on-error"]).toBe(true);
  });
});
