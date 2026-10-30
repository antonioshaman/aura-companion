#!/usr/bin/env bun
// AC3.3 behavioural eval, live run (PLAN Task 13). NOT part of CI: it spends
// model calls and depends on the operator's Claude login.
//
//   bun evals/uiux-platform-runner.ts [--runs 3] [--model sonnet] [--fixture <id>] [--arm with|without] [--jobs 3]
//   bun evals/uiux-platform-runner.ts --regrade   (re-grade stored transcripts after a grader fix; no model calls)
//
// Each fixture runs in two arms from an empty temp cwd:
//   with     `--plugin-dir` = a temp plugin exposing packs/skills/aura-uiux the
//            way Aura's spawn exposure does (`/aura-toolkit:aura-uiux`);
//   without  the same command with no plugin (the control).
// The session may only read (Skill, Read, Glob, Grep). Every run is stored in
// uiux-platform/transcripts/ with its grade, so CI can replay the verdicts, and
// REPORT.md is rewritten with the pass rate per fixture × arm.

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { grade, loadFixtures, summarise, isolatedTranscripts, TRANSCRIPTS_DIR, type Fixture, type Transcript } from "./uiux-platform/grade.js";

const SKILL_DIR = resolve(import.meta.dirname, "..", "..", "packs", "skills", "aura-uiux");
const REPORT_FILE = join(import.meta.dirname, "uiux-platform", "REPORT.md");
const RUN_TIMEOUT_MS = 6 * 60_000;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

export function skillRevision(directory = SKILL_DIR): string {
  const hash = createHash("sha256");
  for (const name of readdirSync(directory, { recursive: true, encoding: "utf8" }).map(String).filter((name) => name.endsWith(".md")).sort()) {
    hash.update(name).update("\0").update(readFileSync(join(directory, name))).update("\0");
  }
  return hash.digest("hex");
}

/** A throwaway plugin dir with the same layout as Aura's exposure: .claude-plugin/plugin.json + skills/<name>. */
function makePlugin(): string {
  const dir = mkdtempSync(join(tmpdir(), "uiux-eval-plugin-"));
  mkdirSync(join(dir, ".claude-plugin"));
  writeFileSync(join(dir, ".claude-plugin", "plugin.json"), `${JSON.stringify({ name: "aura-toolkit", description: "UI/UX eval exposure" }, null, 2)}\n`);
  mkdirSync(join(dir, "skills"));
  symlinkSync(SKILL_DIR, join(dir, "skills", "aura-uiux"));
  return dir;
}

/** One `claude -p` run; returns the final answer and the tool calls it made. */
function runOnce(f: Fixture, arm: "with" | "without", model: string, plugin: string): Promise<{ output: string; tools: string[]; resolvedModel?: string }> {
  const cwd = mkdtempSync(join(tmpdir(), "uiux-eval-cwd-"));
  const args = ["-p", f.prompt, "--output-format", "stream-json", "--verbose", "--model", model, "--max-turns", "10", "--allowedTools", "Skill,Read,Glob,Grep",
    // Skip the operator's user settings: their Stop hooks (self-reflect, guards) fire in a
    // nested `-p` run, and the final message becomes a reply to the hook, not the answer.
    "--setting-sources", "project,local"];
  if (arm === "with") args.push("--plugin-dir", plugin);
  const env = { ...process.env };
  // A nested run must look like a fresh CLI, not a child of this Aura session.
  for (const k of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "AURA_COUNCIL_CATALOG_DIR"]) delete env[k];
  return new Promise((done, fail) => {
    const child = spawn("claude", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (err += b));
    const timer = setTimeout(() => child.kill("SIGTERM"), RUN_TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      rmSync(cwd, { recursive: true, force: true });
      const result = parseEvalOutput(out);
      if (result.error) fail(new Error(`${f.id}/${arm}: ${result.error} (exit ${code}) ${err.slice(0, 300)}`));
      else done(result);

    });
  });
}

/** Provider errors are failed runs, never model answers eligible for grading. */
export function parseEvalOutput(stdout: string): { output: string; tools: string[]; error?: string; resolvedModel?: string } {
  const tools: string[] = [];
  let output = "";
  let error: string | undefined;
  let resolvedModel: string | undefined;
  for (const line of stdout.split("\n")) {
    let event: { type?: string; model?: string; is_error?: boolean; result?: string; message?: { model?: string; content?: { type: string; name?: string; input?: Record<string, unknown> }[] } };
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === "system" && event.model) resolvedModel = event.model;
    if (event.type === "assistant") {
      resolvedModel = event.message?.model ?? resolvedModel;
      for (const c of event.message?.content ?? []) if (c.type === "tool_use") tools.push(`${c.name}:${String(c.input?.skill ?? c.input?.file_path ?? c.input?.pattern ?? "")}`);
    }
    if (event.type === "result") {
      if (event.is_error || /^API Error:/.test(event.result ?? "")) error = event.result || "provider rejected the run";
      else if (typeof event.result === "string") output = event.result;
    }
  }
  return { output, tools, ...(resolvedModel ? { resolvedModel } : {}), ...(error || !output ? { error: error || "no result" } : {}) };
}

export function renderReport(all: Transcript[]): string {
  const ts = isolatedTranscripts(all);
  // Never pool experiments run against different revisions or on different dates.
  const cohorts = new Map<string, Transcript[]>();
  for (const t of ts) {
    const key = `${t.startedAt} / ${t.resolvedModel ?? t.model} / ${t.skillRevision ?? "legacy-unpinned"}`;
    cohorts.set(key, [...(cohorts.get(key) ?? []), t]);
  }
  const rows = [...cohorts].flatMap(([cohort, records]) => summarise(records).map((row) => ({ ...row, cohort })));
  const currentRevision = skillRevision();
  const hasFreshTelegramPair = [...cohorts.values()].some((records) =>
    ["with", "without"].every((arm) => records.filter((t) => t.fixture === "tma-checkout" && t.arm === arm && t.skillRevision === currentRevision).length >= 10),
  );
  const lines = [
    "# AC3.3 behavioural eval — report",
    "",
    "GENERATED by `bun evals/uiux-platform-runner.ts`; graded deterministically by `uiux-platform/grade.ts`; transcripts in `transcripts/` (replayed in CI).",
    "",
    `Models: ${[...new Set(ts.map((t) => t.model))].join(", ")}. Runs: ${ts.length}. Last run: ${ts.map((t) => t.startedAt).sort().at(-1) ?? "-"}.`,
    "",
    `Only runs with verified project/local settings isolation are included; ${all.length - ts.length} earlier probes are excluded.`,
    "",
    "These regex markers describe generated answers, not human-confirmed usability or a causal quality gain. Native font-scaling markers are checked in code, excluding comments and surrounding prose. React Native also scales text by default: omission of an explicit marker is not proof of inaccessible code.",
    "",
    hasFreshTelegramPair
      ? `A paired Telegram cohort (N>=10 per arm) records the current skill revision ${currentRevision}. This is a marker evaluation, not evidence of the spec's 30% human-confirmed usability target.`
      : "No paired Telegram N>=10 cohort records the current skill revision. The historical cohort does not validate the tightened reference. The spec's 30% human-confirmed improvement target remains unverified.",
    "",
    "| Cohort (time / model / skill SHA) | Fixture | Arm | Pass rate | Skill loaded | Marker hits (`!x` = anti-marker) |",
    "|---|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.cohort} | ${r.fixture} | ${r.arm} | ${r.passed}/${r.runs} | ${r.skillLoaded}/${r.runs} | ${Object.entries(r.markerHits).map(([k, v]) => `${k} ${v}/${r.runs}`).join(", ")} |`),
    "",
  ];
  return lines.join("\n");
}

function loadTranscripts(): { file: string; t: Transcript }[] {
  return readdirSync(TRANSCRIPTS_DIR)
    .filter((n) => n.endsWith(".json"))
    .map((n) => ({ file: join(TRANSCRIPTS_DIR, n), t: JSON.parse(readFileSync(join(TRANSCRIPTS_DIR, n), "utf8")) as Transcript }));
}

/** Apply the current grader to every stored answer (both arms alike) and rewrite the report. */
function regrade(): number {
  const fx = new Map(loadFixtures().map((f) => [f.id, f]));
  let changed = 0;
  for (const { file, t } of loadTranscripts()) {
    const f = fx.get(t.fixture);
    if (!f) throw new Error(`${file}: unknown fixture ${t.fixture}`);
    const g = grade(t.output, f);
    if (JSON.stringify(g) !== JSON.stringify(t.grade)) {
      changed++;
      writeFileSync(file, `${JSON.stringify({ ...t, grade: g }, null, 2)}\n`);
    }
  }
  writeFileSync(REPORT_FILE, renderReport(loadTranscripts().map((x) => x.t)));
  console.log(`regrade: ${changed} transcript verdicts changed`);
  return 0;
}

async function main(): Promise<number> {
  if (process.argv.includes("--regrade")) return regrade();
  const runs = Number(arg("--runs", "3"));
  const model = arg("--model", "sonnet");
  const jobs = Number(arg("--jobs", "3"));
  const only = arg("--fixture", "");
  const arms = arg("--arm", "") ? [arg("--arm", "") as "with" | "without"] : (["with", "without"] as const);
  const fixtures = loadFixtures().filter((f) => !only || f.id === only);
  const plugin = makePlugin();
  const revision = skillRevision();
  const queue = fixtures.flatMap((f) => arms.flatMap((arm) => Array.from({ length: runs }, (_, i) => ({ f, arm, i }))));
  mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  let failures = 0;
  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const { f, arm, i } = job;
      try {
        const { output, tools, resolvedModel } = await runOnce(f, arm, model, plugin);
        const t: Transcript = { settingsIsolation: "project-local", skillRevision: revision, ...(resolvedModel ? { resolvedModel } : {}), fixture: f.id, arm, model, run: i, startedAt: stamp, tools, output, grade: grade(output, f) };
        writeFileSync(join(TRANSCRIPTS_DIR, `${stamp.replace(/[:]/g, "")}-${f.id}-${arm}-${i}.json`), `${JSON.stringify(t, null, 2)}\n`);
        console.log(`${f.id} ${arm} #${i}: ${t.grade.pass ? "PASS" : "fail"} tools=[${tools.join(" ")}]`);
      } catch (e) {
        failures++;
        console.error((e as Error).message);
      }
    }
  };
  await Promise.all(Array.from({ length: jobs }, worker));
  rmSync(plugin, { recursive: true, force: true });
  const all = loadTranscripts().map((x) => x.t);
  writeFileSync(REPORT_FILE, renderReport(all));
  console.log(renderReport(all));
  return failures ? 1 : 0;
}

if (import.meta.main) process.exit(await main());
