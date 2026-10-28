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

type Step = { name?: string; run?: string; if?: string; "continue-on-error"?: boolean | string; "working-directory"?: string };
type Job = { permissions?: unknown; if?: string; "continue-on-error"?: boolean | string; steps: Step[] };
type Workflow = { permissions?: unknown; jobs: Record<string, Job> };

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

// PLAN-aura-uiux-agent-enrichment Task 4: the council catalog moved into the repo
// (packs/skills). Its canary gate only protects anything if CI actually runs it on
// every PR, and only the exit code of the script itself can fail the job — so pin
// that the step exists and is not masked.
const GATE_COMMANDS = [
  "bash packs/skills/_council-experts/.verify/verify-catalog.sh",
  "bun scripts/vendored-skills.ts check",
  "bun scripts/skill-manifest.ts check",
  "bun scripts/uiux-sources.ts check",
];

/**
 * Every way a gate step can stop failing the build, read from the PARSED workflow
 * (review 2026-10-27-2139 finding #4): `continue-on-error` and `if:` are YAML keys
 * on the step or its job, never part of the `run` text, so a regex over `run`
 * cannot see them. Text masks (`|| true`) are still checked on `run`.
 */
function gateMaskingErrors(wf: Workflow, commands: string[]): string[] {
  const errs: string[] = [];
  for (const cmd of commands) {
    const owners = Object.entries(wf.jobs).flatMap(([jobId, job]) =>
      job.steps.filter((st) => st.run?.includes(cmd)).map((step) => ({ jobId, job, step })),
    );
    if (owners.length === 0) errs.push(`missing: ${cmd}`);
    for (const { jobId, job, step } of owners) {
      if (/\|\|\s*true|;\s*true\b|\|\|\s*:/.test(step.run ?? "")) errs.push(`${cmd}: run text masks the exit code`);
      if (step["continue-on-error"] !== undefined && step["continue-on-error"] !== false) errs.push(`${cmd}: step continue-on-error`);
      if (step.if !== undefined) errs.push(`${cmd}: step has an if: condition`);
      if (job["continue-on-error"] !== undefined && job["continue-on-error"] !== false) errs.push(`${cmd}: job ${jobId} continue-on-error`);
      if (job.if !== undefined) errs.push(`${cmd}: job ${jobId} has an if: condition`);
    }
  }
  return errs;
}

// PLAN-aura-uiux-agent-enrichment Task 4: the council catalog moved into the repo
// (packs/skills). Its canary gate only protects anything if CI runs it on every PR
// and nothing can turn its failure into a pass.
describe("council catalog canaries run in CI (uiux Task 4)", () => {
  it("ci.yml runs verify-catalog.sh, the vendor lock check and the source-catalog check, unmasked", () => {
    expect(gateMaskingErrors(loadWorkflow("ci.yml"), GATE_COMMANDS)).toEqual([]);
  });

  // Planted defect (hashimoto's reproduction): the exact edits that kept the old
  // run-text regex green must each be reported here.
  it("detects step- and job-level continue-on-error and if: masks", () => {
    const masked: Workflow = {
      jobs: {
        "council-skills": {
          "continue-on-error": true,
          if: "github.event_name == 'push'",
          steps: [
            { run: GATE_COMMANDS[0], "continue-on-error": true, if: "github.event_name == 'push'" },
            { run: `${GATE_COMMANDS[1]} || true` },
          ],
        },
      },
    };
    const errs = gateMaskingErrors(masked, GATE_COMMANDS.slice(0, 2)).join("\n");
    expect(errs).toMatch(/verify-catalog.sh: step continue-on-error/);
    expect(errs).toMatch(/verify-catalog.sh: step has an if: condition/);
    expect(errs).toMatch(/job council-skills continue-on-error/);
    expect(errs).toMatch(/job council-skills has an if: condition/);
    expect(errs).toMatch(/vendored-skills.ts check: run text masks the exit code/);
  });
});

// Review 2026-10-27-2139 finding #18: the job that attests bytes must not run on a
// floating toolchain — setup-python pinned to a commit SHA, pyyaml installed by hash.
describe("council-skills job toolchain is pinned", () => {
  it("setup-python is pinned by a 40-hex commit SHA and pip installs with --require-hashes", () => {
    const steps = loadWorkflow("ci.yml").jobs["council-skills"].steps as (Step & { uses?: string })[];
    const py = steps.find((s) => s.uses?.startsWith("actions/setup-python@"));
    expect(py?.uses).toMatch(/^actions\/setup-python@[0-9a-f]{40}$/);
    const pip = steps.find((s) => s.run?.includes("pip install"));
    expect(pip?.run).toMatch(/--require-hashes -r \.github\/council-canary-requirements\.txt/);
  });
});

// PLAN-aura-uiux-agent-enrichment Task 9: the npm tarball and the server image are
// tested as artifacts. Each gate must exist and be unmasked; the jobs that attest
// an artifact run on a pinned bun, and the Dockerfile pins its bases by digest and
// its CLIs by exact version.
describe("artifact gates (uiux Task 9)", () => {
  const ARTIFACT_GATES = [
    "npm pack --json",
    "bun scripts/skill-pack-build.ts gate",
    "bun scripts/pack-smoke.ts",
    "docker build -t aura-companion:ci .",
    "bash scripts/docker-smoke.sh aura-companion:ci",
  ];

  it("ci.yml runs the package gate, pack-smoke and the image smoke, unmasked", () => {
    expect(gateMaskingErrors(loadWorkflow("ci.yml"), ARTIFACT_GATES)).toEqual([]);
  });

  it("the package job pins bun to an exact version", () => {
    const steps = loadWorkflow("ci.yml").jobs.package.steps as (Step & { uses?: string; with?: Record<string, string> })[];
    const bun = steps.find((s) => s.uses?.startsWith("oven-sh/setup-bun@"));
    expect(bun?.with?.["bun-version"]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("the Dockerfile pins base images by digest and the CLIs by exact version", () => {
    const df = readFileSync(join(repoRoot, "Dockerfile"), "utf-8");
    const images = [...df.matchAll(/^ARG (\w+_IMAGE)=(\S+)$/gm)].map((m) => m[2]);
    expect(images.length).toBe(2);
    for (const img of images) expect(img).toMatch(/:\d+\.\d+\.\d+[\w.-]*@sha256:[0-9a-f]{64}$/);
    expect(df).toMatch(/^ARG CLAUDE_CODE_VERSION=\d+\.\d+\.\d+$/m);
    expect(df).toMatch(/^ARG CODEX_VERSION=\d+\.\d+\.\d+$/m);
    expect(df).not.toMatch(/:latest\b/);
    // python3 + node for skill scripts; the image is built from the npm tarball.
    expect(df).toMatch(/apt-get install[^\n]*python3/);
    expect(df).toMatch(/bun pm pack/);
    expect(df).toMatch(/test -f packs\/skills\/skills-manifest\.json/);
  });
});
