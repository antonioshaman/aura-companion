/**
 * Report-only analysis of the Claude memory dir (spec §3.3 memory, AC9;
 * plan Task 9; hunt 4, ritchie B8).
 *
 * STRUCTURALLY read-only: this module imports no filesystem API at all. It
 * receives a `ReadOnlyDir` capability (list / read / stat) from the caller,
 * so a write here is a type error, not a code-review promise. The memory dir
 * is group-writable by the service user on prod, so OS permissions do NOT
 * protect it — this boundary does.
 *
 * Async in batches with a yield between them, and capped (file count, bytes
 * per file, total bytes), so ~470 files never stall the event loop.
 */

import type { MemoryFinding, MemoryReport } from "./diagnostics-types.js";
import { jaccard, normalizeFact, referencedPath } from "./kb-analyzer.js";

export interface ReadOnlyDir {
  /** Regular `*.md` file names directly inside the dir. */
  list(): Promise<string[]>;
  read(name: string): Promise<string>;
  stat(name: string): Promise<{ mtimeMs: number; size: number }>;
}

export const MEMORY_MAX_FILES = 1000;
export const MEMORY_MAX_FILE_BYTES = 64 * 1024;
export const MEMORY_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
export const MEMORY_BATCH = 25;
export const MEMORY_AGE_DAYS = 180;
const DAY = 86_400_000;

interface MemoryDoc {
  file: string;
  name: string;
  description: string;
  type: string;
  body: string;
  mtimeMs: number;
}

/** Minimal frontmatter reader: `name`, `description`, `type` (top-level or under `metadata:`). */
export function parseMemoryFrontmatter(text: string): { name: string; description: string; type: string; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.replace(/\r\n/g, "\n"));
  if (!m) return { name: "", description: "", type: "", body: text };
  const fields: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = /^\s*(name|description|type):\s*(.*)$/.exec(line);
    if (kv && fields[kv[1]] === undefined) fields[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
  }
  return { name: fields.name ?? "", description: fields.description ?? "", type: fields.type ?? "", body: m[2] };
}

const yieldToLoop = () => new Promise<void>((r) => setImmediate(r));

export async function analyzeMemoryDir(
  dir: ReadOnlyDir,
  opts: { now: number; exists: (repoRelativePath: string) => boolean },
): Promise<MemoryReport> {
  const names = (await dir.list()).filter((n) => n.endsWith(".md") && n !== "MEMORY.md").sort();
  let truncated = names.length > MEMORY_MAX_FILES;
  const docs: MemoryDoc[] = [];
  let total = 0;
  const selected = names.slice(0, MEMORY_MAX_FILES);
  for (let i = 0; i < selected.length; i += MEMORY_BATCH) {
    for (const file of selected.slice(i, i + MEMORY_BATCH)) {
      const st = await dir.stat(file);
      if (st.size > MEMORY_MAX_FILE_BYTES || total + st.size > MEMORY_MAX_TOTAL_BYTES) {
        truncated = true;
        continue;
      }
      total += st.size;
      const fm = parseMemoryFrontmatter(await dir.read(file));
      docs.push({ file, ...fm, mtimeMs: st.mtimeMs });
    }
    await yieldToLoop();
  }

  const signals = new Map<string, MemoryFinding["signals"]>();
  const add = (file: string, s: MemoryFinding["signals"][number]) => signals.set(file, [...(signals.get(file) ?? []), s]);

  // duplicate — same name, identical normalised description, or close descriptions.
  const descTok = docs.map((d) => new Set(normalizeFact(d.description).split(" ").filter((w) => w.length > 2)));
  for (let i = 0; i < docs.length; i++) {
    for (let j = i + 1; j < docs.length; j++) {
      const a = docs[i];
      const b = docs[j];
      const sameName = a.name !== "" && a.name === b.name;
      const sim = jaccard(descTok[i], descTok[j]);
      if (sameName || (a.description !== "" && normalizeFact(a.description) === normalizeFact(b.description)) || sim >= 0.8) {
        const criterion = sameName ? `same name "${a.name}"` : `descriptions match (Jaccard ${sim.toFixed(2)})`;
        add(a.file, { signal: "duplicate", criterion, partnerFile: b.file });
        add(b.file, { signal: "duplicate", criterion, partnerFile: a.file });
      }
    }
    if (i % 50 === 49) await yieldToLoop();
  }

  // dead-reference — backticked repo paths in the body that no longer exist.
  for (const d of docs) {
    const paths = [...d.body.matchAll(/`([^`\n]{3,200})`/g)]
      .map((m) => referencedPath(m[1]))
      .filter((p): p is string => p !== null && /^(web|docs|specs|scripts|landing|landing-legacy|stats|platform|\.agents|\.council)\//.test(p));
    const missing = [...new Set(paths)].filter((p) => !opts.exists(p));
    if (missing.length > 0) add(d.file, { signal: "dead-reference", criterion: `missing in the repo: ${missing.slice(0, 5).join(", ")}` });
  }

  // age — feedback older than 180 days that no other memory links to.
  const allText = docs.map((d) => d.body).join("\n");
  for (const d of docs) {
    const ageDays = Math.floor((opts.now - d.mtimeMs) / DAY);
    if (d.type !== "feedback" || ageDays < MEMORY_AGE_DAYS) continue;
    const slug = d.name || d.file.replace(/\.md$/, "");
    const linked = allText.includes(`[[${slug}]]`) || allText.includes(d.file);
    if (!linked) add(d.file, { signal: "age", criterion: `feedback last changed ${ageDays} days ago (≥ ${MEMORY_AGE_DAYS}), no other memory links to it` });
  }

  const findings: MemoryFinding[] = docs
    .filter((d) => signals.has(d.file))
    .map((d) => ({
      findingId: `mem:${d.file}`,
      file: d.file,
      name: d.name.slice(0, 200),
      description: d.description.slice(0, 500),
      signals: signals.get(d.file)!,
    }));
  return { fileCount: names.length, findings, truncated };
}
