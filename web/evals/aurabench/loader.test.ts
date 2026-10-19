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
import { checkCorpusReviewed, type JudgeRecord } from "./prompt-judge.js";
import { readStabilityVerdicts, stabilityKey } from "./flake.js";
import { checkCorpusSpecified, type SpecRecord } from "./spec-check.js";

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

  // P6/FIX-D2-5 gates. The review artefacts are committed next to the corpus
  // (`review/`), produced by `eval:aurabench judge` and `eval:aurabench
  // stability` — this keeps them honest without an LLM or git in CI.
  const REVIEW_DIR = join(dirname(fileURLToPath(import.meta.url)), "review");

  it("every prompt carries a clean solution-leak verdict for its CURRENT text", () => {
    // Editing a prompt changes its hash, so a rewrite that was not re-judged
    // (or a verdict from an older rubric) fails here instead of shipping.
    const records = readFileSync(join(REVIEW_DIR, "prompt-review.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as JudgeRecord);
    expect(checkCorpusReviewed(loaded.tasks, records)).toEqual([]);
  });

  it("every task's hidden tests passed 3 of 3 runs on its merge commit", () => {
    // Flaky hidden tests would turn a cell into a coin toss; unstable tasks are excluded.
    const verdicts = readStabilityVerdicts(readFileSync(join(REVIEW_DIR, "stability.jsonl"), "utf8"));
    const unstable = loaded.tasks
      .map((t) => ({ id: t.id, v: verdicts.get(stabilityKey({ id: t.id, merge_commit: t.aurabench.merge_commit })) }))
      .filter(({ v }) => !v || !v.stable || v.runs.length < 3)
      .map(({ id }) => id);
    expect(unstable).toEqual([]);
  });

  it("every prompt carries an ok spec-completeness verdict for its CURRENT text", () => {
    // P6/CORPUS-SPEC-CHECK: every behaviour the hidden tests assert must be
    // stated by the prompt or fixed by the base repo, otherwise a cell measures
    // a guess (pilot: resume-hiccup's streak value after a discard). Editing a
    // prompt changes its hash, so a rewrite must be re-checked, not just re-judged.
    const records = readFileSync(join(REVIEW_DIR, "spec-check.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as SpecRecord);
    expect(checkCorpusSpecified(loaded.tasks, records)).toEqual([]);
  });
});
