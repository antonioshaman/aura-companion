/**
 * Tests for the AuraBench corpus loader. Same contract as the golden loader —
 * one bad task never aborts the load — plus two AuraBench-specific checks:
 * BOTH commits (start + merge) must exist, and task ids must be unique across
 * files (the ablation results are keyed by id, so a duplicate would silently
 * merge two tasks' cells). Commit existence is injected, so no git is needed.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyAuraBenchTaskSource, loadAuraBenchTasks } from "./loader.js";
import { AURABENCH_CLASSES } from "./task.js";

const BASE = "a".repeat(40);
const MERGE = "b".repeat(40);

const yaml = (id: string) => `
golden_task_version: 1
id: ${id}
title: A task
start_commit: ${BASE}
prompt: Fix it.
expected_files: [web/server/x.ts]
expected_tests: [web/server/x.test.ts]
failure_modes: [hidden tests still fail]
rubric:
  - id: hidden-tests-pass
    description: hidden tests pass
    weight: 1
aurabench:
  pr: 7
  merge_commit: ${MERGE}
  class: feature
  hidden_tests: [web/server/x.test.ts]
  validation:
    base: fail
    merge: pass
    base_failure: missing-interface
    checked_at: "2026-09-28T10:00:00Z"
`;

const always = () => true;

describe("classifyAuraBenchTaskSource", () => {
  it("accepts a valid task", () => {
    const r = classifyAuraBenchTaskSource(yaml("t1"), always);
    expect(r.ok).toBe(true);
  });

  it("excludes when either commit is missing, naming the SHA", () => {
    // Merge commit gone (e.g. a history rewrite) must exclude, not just start.
    const noMerge = classifyAuraBenchTaskSource(yaml("t1"), (sha) => sha !== MERGE);
    expect(noMerge).toEqual({ ok: false, reason: `commit ${MERGE} does not exist in the repo` });
    const noBase = classifyAuraBenchTaskSource(yaml("t1"), (sha) => sha !== BASE);
    expect(noBase).toEqual({ ok: false, reason: `commit ${BASE} does not exist in the repo` });
  });

  it("reports YAML errors instead of throwing", () => {
    const r = classifyAuraBenchTaskSource("a: [unterminated", always);
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/YAML parse error/) });
  });
});

describe("loadAuraBenchTasks", () => {
  it("loads good tasks sorted, excludes bad and duplicate-id files without aborting", () => {
    const dir = mkdtempSync(join(tmpdir(), "aurabench-"));
    try {
      writeFileSync(join(dir, "b.yaml"), yaml("t-b"));
      writeFileSync(join(dir, "a.yaml"), yaml("t-a"));
      writeFileSync(join(dir, "c-dup.yaml"), yaml("t-a"));
      writeFileSync(join(dir, "d-bad.yaml"), yaml("t-d").replace("class: feature", "class: nope"));
      writeFileSync(join(dir, "notes.md"), "ignored");
      const loaded = loadAuraBenchTasks(dir, always);
      expect(loaded.tasks.map((t) => t.id)).toEqual(["t-a", "t-b"]);
      expect(loaded.excluded).toEqual([
        { file: "c-dup.yaml", reason: 'duplicate task id "t-a"' },
        { file: "d-bad.yaml", reason: expect.stringMatching(/class must be one of/) },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("committed AuraBench corpus (web/evals/aurabench/tasks)", () => {
  // Story D1 gate: >= 30 validated tasks (target 50) spread over the task
  // classes, every one schema-valid. The commit probe is stubbed so this stays
  // git-history-independent (shallow clones); `eval:aurabench leak` does the
  // git-backed prompt check against the real diffs.
  const TASKS_DIR = join(dirname(fileURLToPath(import.meta.url)), "tasks");
  const loaded = loadAuraBenchTasks(TASKS_DIR, () => true);

  it("parses every committed task with no exclusions", () => {
    expect(loaded.excluded).toEqual([]);
    expect(loaded.tasks.length).toBeGreaterThanOrEqual(30);
  });

  it("covers every task class", () => {
    const classes = new Set(loaded.tasks.map((t) => t.aurabench.class));
    for (const c of AURABENCH_CLASSES) expect(classes.has(c)).toBe(true);
  });

  it("uses each source PR at most once and names the file after the task id", () => {
    // Two tasks from one PR would double-count it in the per-class lift; the
    // results JSONL is keyed by id, so the filename must match it.
    const prs = loaded.tasks.map((t) => t.aurabench.pr);
    expect(new Set(prs).size).toBe(prs.length);
    for (const t of loaded.tasks) {
      expect(readFileSync(join(TASKS_DIR, `${t.id}.yaml`), "utf8")).toContain(`id: ${t.id}`);
    }
  });
});
