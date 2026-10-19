// Tests for the report-only memory analysis (spec §3.3, AC9; plan Task 9).
//
// What is validated:
//   - duplicate (same name / matching description), dead-reference (backticked
//     repo paths that no longer exist) and age (feedback ≥ 180 days with no
//     inbound link) are reported with their criterion;
//   - caps: files over the per-file byte cap are skipped and `truncated` is set;
//   - AC9: a full run over a REAL directory performs zero write-capable fs
//     calls under that directory. Why a spy and not "the OS would refuse":
//     the prod memory dir is group-writable by the service user, so
//     permissions prove nothing. The module also imports no fs API at all —
//     asserted on its source, so a future write helper cannot slip in.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ESM namespaces cannot be spied on, so every write-capable fs export is
// wrapped in a pass-through vi.fn for the whole module graph of this file.
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
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { analyzeMemoryDir, MEMORY_MAX_FILE_BYTES, parseMemoryFrontmatter, type ReadOnlyDir } from "./memory-report.js";

const NOW = Date.parse("2026-10-19T00:00:00Z");
const DAY = 86_400_000;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memory-report-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function mem(file: string, fm: Record<string, string>, body = "", ageDays = 1) {
  const text = `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n\n${body}\n`;
  writeFileSync(join(dir, file), text);
  const t = (NOW - ageDays * DAY) / 1000;
  utimesSync(join(dir, file), t, t);
}

/** The same read-only adapter the runner builds: list/read/stat only. */
function realDir(): ReadOnlyDir {
  return {
    list: async () => (await fsp.readdir(dir, { withFileTypes: true })).filter((d) => d.isFile()).map((d) => d.name),
    read: (name) => fsp.readFile(join(dir, name), "utf8"),
    stat: async (name) => {
      const s = await fsp.stat(join(dir, name));
      return { mtimeMs: s.mtimeMs, size: s.size };
    },
  };
}

describe("analyzeMemoryDir", () => {
  it("reports duplicate, dead-reference and age with their criteria", async () => {
    mem("feedback_a.md", { name: "usage-badge-gone", description: "Badge vanished means the KV quota ran out", type: "feedback" });
    mem("feedback_b.md", { name: "badge-kv", description: "Badge vanished means the KV quota ran out", type: "feedback" });
    mem("project_c.md", { name: "c", description: "c", type: "project" }, "See `web/server/gone.ts` and `web/server/index.ts`.");
    mem("feedback_old.md", { name: "old-rule", description: "something old", type: "feedback" }, "", 200);
    mem("feedback_linked_old.md", { name: "linked-old", description: "linked", type: "feedback" }, "", 200);
    mem("project_d.md", { name: "d", description: "d", type: "project" }, "Related: [[linked-old]]");
    const r = await analyzeMemoryDir(realDir(), { now: NOW, exists: (p) => p === "web/server/index.ts" });

    const by = (f: string) => r.findings.find((x) => x.file === f)?.signals.map((s) => s.signal) ?? [];
    expect(by("feedback_a.md")).toEqual(["duplicate"]);
    expect(r.findings.find((x) => x.file === "feedback_a.md")?.signals[0].partnerFile).toBe("feedback_b.md");
    expect(by("project_c.md")).toEqual(["dead-reference"]);
    expect(r.findings.find((x) => x.file === "project_c.md")?.signals[0].criterion).toBe("missing in the repo: web/server/gone.ts");
    expect(by("feedback_old.md")).toEqual(["age"]);
    expect(by("feedback_linked_old.md")).toEqual([]);
    expect(r.findings.every((f) => f.findingId === `mem:${f.file}` && !f.file.includes("/"))).toBe(true);
  });

  it("skips oversize files and says the report is truncated", async () => {
    mem("project_ok.md", { name: "ok", description: "ok", type: "project" });
    writeFileSync(join(dir, "project_huge.md"), "x".repeat(MEMORY_MAX_FILE_BYTES + 1));
    const r = await analyzeMemoryDir(realDir(), { now: NOW, exists: () => true });
    expect(r.truncated).toBe(true);
    expect(r.fileCount).toBe(2);
  });

  it("AC9: a full report performs zero write-capable fs calls under the memory dir", async () => {
    mem("feedback_a.md", { name: "a", description: "dup dup dup", type: "feedback" });
    mem("feedback_b.md", { name: "b", description: "dup dup dup", type: "feedback" });
    // Sync names live on node:fs, promise names on node:fs/promises (the mock
    // throws on a name it does not export, so each is read from its own module).
    const mocks = FS_WRITE_FNS.flatMap((f) => {
      const mod = (f.endsWith("Sync") ? fs : fsp) as Record<string, unknown>;
      const m = mod[f];
      return vi.isMockFunction(m) ? [{ f, m }] : [];
    });
    expect(mocks.length).toBe(FS_WRITE_FNS.length);
    for (const { m } of mocks) m.mockClear(); // fixture writes above do not count
    const before = fs.readdirSync(dir).map((f) => [f, readFileSync(join(dir, f), "utf8")]);

    const r = await analyzeMemoryDir(realDir(), { now: NOW, exists: () => true });

    expect(r.findings.length).toBe(2);
    for (const { f, m } of mocks) {
      const underDir = m.mock.calls.filter((c: unknown[]) => String(c[0]).startsWith(dir));
      expect(underDir, `${f} touched the memory dir`).toEqual([]);
    }
    expect(fs.readdirSync(dir).map((f) => [f, readFileSync(join(dir, f), "utf8")])).toEqual(before);
  });

  it("the module imports no filesystem API (structural read-only guarantee)", () => {
    const src = readFileSync(join(import.meta.dirname, "memory-report.ts"), "utf8");
    expect(src).not.toMatch(/from\s+["']node:fs/);
    expect(src).not.toMatch(/from\s+["']fs/);
    expect(src).not.toMatch(/require\(/);
    // Review beck #1: no other write channel either.
    expect(src).not.toMatch(/\bBun\.(write|file)\b/);
    expect(src).not.toMatch(/\bimport\s*\(/);
  });
});

describe("parseMemoryFrontmatter", () => {
  it("reads name/description/type, including a nested metadata type", () => {
    const fm = parseMemoryFrontmatter("---\nname: x\ndescription: \"y z\"\nmetadata:\n  type: feedback\n---\nbody");
    expect(fm).toEqual({ name: "x", description: "y z", type: "feedback", body: "body" });
  });
});
