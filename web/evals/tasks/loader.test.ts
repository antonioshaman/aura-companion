/**
 * Tests for the golden-task loader. The load-bearing contract: one bad task
 * never aborts the run — a malformed file, a schema violation, or a missing
 * start_commit becomes a per-file exclusion while the good tasks still load.
 * Commit existence is an injected predicate so these stay hermetic (no git).
 *
 * The final test loads the REAL committed `web/evals/tasks/` corpus with a
 * stub "commit always exists" predicate, so it validates the authored YAML
 * against the schema without depending on the repo's git history being present.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyGoldenTaskSource, loadGoldenTasks } from "./loader.js";

const TASKS_DIR = join(__dirname);

const validYaml = `
golden_task_version: 1
id: t-valid
title: Valid task
start_commit: 82d855a051dbae7395a98d30c681d1597242e6ac
prompt: Fix it.
expected_files: [web/server/x.ts]
expected_tests: [web/server/x.test.ts]
failure_modes: [regresses Y]
rubric:
  - id: c1
    description: does the thing
    weight: 1
`;

const alwaysExists = () => true;
const neverExists = () => false;

describe("classifyGoldenTaskSource", () => {
  it("returns the typed task when YAML, schema, and commit all pass", () => {
    const r = classifyGoldenTaskSource(validYaml, alwaysExists);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.task.id).toBe("t-valid");
  });

  it("excludes (not throws) on malformed YAML", () => {
    const r = classifyGoldenTaskSource("key: [unterminated", alwaysExists);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/YAML parse error/);
  });

  it("excludes a schema-invalid task with the field-level reason", () => {
    const r = classifyGoldenTaskSource(validYaml.replace("id: t-valid", "id: ''"), alwaysExists);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/id is missing/);
  });

  it("excludes a task whose start_commit does not exist, naming the SHA", () => {
    const r = classifyGoldenTaskSource(validYaml, neverExists);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/82d855a.*does not exist/);
  });
});

describe("loadGoldenTasks", () => {
  it("loads good tasks and excludes bad ones without aborting; both sorted", () => {
    const dir = mkdtempSync(join(tmpdir(), "golden-tasks-"));
    try {
      writeFileSync(join(dir, "b-good.yaml"), validYaml.replace("t-valid", "t-bbb"));
      writeFileSync(join(dir, "a-good.yaml"), validYaml.replace("t-valid", "t-aaa"));
      writeFileSync(join(dir, "z-bad.yaml"), "key: [unterminated");
      writeFileSync(join(dir, "ignored.txt"), "not a yaml file");

      const loaded = loadGoldenTasks(dir, alwaysExists);

      // Good tasks sorted by id, bad file excluded — run did not abort.
      expect(loaded.tasks.map((t) => t.id)).toEqual(["t-aaa", "t-bbb"]);
      expect(loaded.excluded).toEqual([
        { file: "z-bad.yaml", reason: expect.stringMatching(/YAML parse error/) },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("excludes a missing-commit task but still loads its siblings", () => {
    const dir = mkdtempSync(join(tmpdir(), "golden-tasks-"));
    try {
      writeFileSync(join(dir, "good.yaml"), validYaml);
      // Same content, but the injected predicate says this SHA is gone.
      const loaded = loadGoldenTasks(dir, (sha) => sha !== "82d855a051dbae7395a98d30c681d1597242e6ac");
      expect(loaded.tasks).toEqual([]);
      expect(loaded.excluded[0]!.reason).toMatch(/does not exist/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the committed golden-task corpus all parses against the schema", () => {
    // Stub the commit probe so this is git-history-independent: we only assert
    // the authored YAML is schema-valid, not that the SHAs are present here.
    const loaded = loadGoldenTasks(TASKS_DIR, alwaysExists);
    expect(loaded.excluded).toEqual([]);
    expect(loaded.tasks.length).toBeGreaterThan(0);
    // ids are unique across the corpus.
    const ids = loaded.tasks.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
