// AC9 at the PRODUCTION boundary (review 2026-10-19-1110, beck #1).
//
// memory-report.test.ts proves the analyzer itself has no fs access. This file
// proves the code that DOES hold fs — the runner's `memoryDirAdapter` and the
// whole manual memory-report run — never writes under the memory dir:
//   - every write-capable fs export (sync and promise) is wrapped in a
//     pass-through mock for this module graph; after a full run plus a
//     "Mark as seen" decision, none of them received a path under the memory
//     root;
//   - the memory dir, including MEMORY.md, is byte-identical before and after.
// Why not "the OS would refuse": the prod memory dir is group-writable by the
// service user, so permissions prove nothing.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const FS_WRITE_FNS = vi.hoisted(() => [
  "writeFileSync", "appendFileSync", "renameSync", "unlinkSync", "rmSync", "mkdirSync", "chmodSync",
  "utimesSync", "copyFileSync", "truncateSync", "openSync", "writeSync",
  "writeFile", "appendFile", "rename", "unlink", "rm", "mkdir", "chmod", "utimes", "copyFile", "truncate", "open",
] as const);
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  const wrapped: Record<string, unknown> = { ...real };
  for (const f of FS_WRITE_FNS) if (typeof real[f] === "function") wrapped[f] = vi.fn(real[f] as (...a: unknown[]) => unknown);
  return { ...wrapped, default: wrapped };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  const wrapped: Record<string, unknown> = { ...real };
  for (const f of FS_WRITE_FNS) if (typeof real[f] === "function") wrapped[f] = vi.fn(real[f] as (...a: unknown[]) => unknown);
  return { ...wrapped, default: wrapped };
});

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KbAnalysisRunner } from "./kb-analysis-runner.js";
import { appendDecisions, clearArchivePending, writeArchivePending } from "./kb-analysis-store.js";
import { applyDecisions, validateDecisions } from "./kb-decisions.js";

let base: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "mem-runner-")));
  mkdirSync(join(base, "kb"));
  mkdirSync(join(base, "memory"));
  writeFileSync(join(base, "kb", "gotchas.jsonl"), JSON.stringify({ id: "got-1", fact: "f", createdAt: "2026-01-01T00:00:00Z" }) + "\n");
  writeFileSync(join(base, "memory", "MEMORY.md"), "# Memory Index\n- [a](feedback_a.md)\n");
  writeFileSync(join(base, "memory", "feedback_a.md"), "---\nname: a\ndescription: badge gone kv quota\ntype: feedback\n---\nbody `web/gone.ts`\n");
  writeFileSync(join(base, "memory", "feedback_b.md"), "---\nname: b\ndescription: badge gone kv quota\ntype: feedback\n---\nbody\n");
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const snapshot = () => readdirSync(join(base, "memory")).sort().map((f) => [f, readFileSync(join(base, "memory", f), "utf8")]);

describe("AC9 through the runner's real memory adapter", () => {
  it("a full memory report plus 'Mark as seen' writes nothing under the memory dir", async () => {
    const before = snapshot();
    const mocks = FS_WRITE_FNS.flatMap((f) => {
      const m = ((f.endsWith("Sync") ? fs : fsp) as Record<string, unknown>)[f];
      return vi.isMockFunction(m) ? [{ f, m }] : [];
    });
    expect(mocks).toHaveLength(FS_WRITE_FNS.length);
    for (const { m } of mocks) m.mockClear();

    const roots = { kb: join(base, "kb"), reports: join(base, "reports"), memory: join(base, "memory") };
    const runner = new KbAnalysisRunner({
      roots,
      settings: () => ({ kbAnalysis: { newEntriesThreshold: 10, sessionsThreshold: 25, maxAgeDays: 14 }, diagnosticsMemoryReport: true }),
      repoExists: () => false,
    });
    runner.init();
    expect(runner.requestManualRun({ includeMemory: true }).kind).toBe("started");
    await runner._waitForRun();
    const report = runner.currentReport();
    expect(report?.memory?.findings.map((f) => f.findingId).sort()).toEqual(["mem:feedback_a.md", "mem:feedback_b.md"]);

    const v = validateDecisions({ runId: report!.runId, decisions: [{ entryId: "mem:feedback_a.md", decision: "seen" }] }, report);
    if (!v.ok) throw new Error(v.error);
    applyDecisions(v, {
      kbRoot: roots.kb,
      append: (l) => appendDecisions(roots.reports, l),
      pending: { write: (p) => writeArchivePending(roots.reports, p), clear: () => clearArchivePending(roots.reports) },
      now: () => Date.now(),
    });
    await runner.dispose();

    for (const { f, m } of mocks) {
      const underMemory = m.mock.calls.filter((c: unknown[]) => String(c[0]).startsWith(roots.memory));
      expect(underMemory, `${f} touched the memory dir`).toEqual([]);
    }
    expect(snapshot()).toEqual(before);
  });
});
