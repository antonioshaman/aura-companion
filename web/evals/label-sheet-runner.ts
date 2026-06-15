/**
 * Council Eval Harness label-sheet runner.
 *
 *   bun run eval:label-sheet --workspace <path> [--workspace <path> ...] \
 *     [--out <file.md>] [--context <N>]
 *
 * Extracts every observer finding from each workspace's `.council/reviews/`,
 * resolves the source snippet at each `evidence_path:evidence_lines` (within
 * workspace bounds), and writes a self-contained markdown sheet a human can
 * label TRUE/FALSE/SKIP offline. Findings are ordered STOP→WARN→NOTE→INFO so
 * the highest-stakes calls come first.
 *
 * Reads real artifacts off disk; not in the vitest glob. The pure renderer
 * (label-sheet.ts) and the extractor are unit-tested on synthetic fixtures.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { extractFindings, type ExtractedFinding } from "./scorers/findings-extractor.js";
import { resolveWithinWorkspace } from "./schema/eval-paths.js";
import { renderLabelSheet, type LabelSheetItem } from "./label-sheet.js";
import { parseLabelLog } from "./schema/parse-artifact.js";

const DEFAULT_LABELS = fileURLToPath(new URL("./judge-calibration/human-labels.jsonl", import.meta.url));

interface ParsedArgs {
  workspaces: string[];
  out?: string;
  labels: string;
  context: number;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { workspaces: [], labels: DEFAULT_LABELS, context: 6, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--workspace" || a === "-w") {
      const v = argv[++i];
      if (v) out.workspaces.push(v);
    } else if (a.startsWith("--workspace=")) out.workspaces.push(a.slice("--workspace=".length));
    else if (a === "--out") out.out = argv[++i];
    else if (a.startsWith("--out=")) out.out = a.slice("--out=".length);
    else if (a === "--labels") out.labels = argv[++i] ?? out.labels;
    else if (a.startsWith("--labels=")) out.labels = a.slice("--labels=".length);
    else if (a === "--context") out.context = Number(argv[++i]) || 6;
    else if (a.startsWith("--context=")) out.context = Number(a.slice("--context=".length)) || 6;
  }
  return out;
}

/** finding_ids already carrying a decisive verdict in the label log, so the
 *  sheet doesn't re-present work a human already did (AC2). Missing/unreadable
 *  log → empty set (first run). */
function alreadyLabeled(labelsPath: string): Set<string> {
  let text: string;
  try {
    text = readFileSync(labelsPath, "utf8");
  } catch {
    return new Set();
  }
  const ids = new Set<string>();
  for (const r of parseLabelLog(text).records) {
    if (r.finding_id) ids.add(r.finding_id);
  }
  return ids;
}

const SEV_ORDER: Record<string, number> = { STOP: 0, WARN: 1, NOTE: 2, INFO: 3 };

function reviewFilesFor(workspace: string): string[] {
  try {
    const dir = join(workspace, ".council", "reviews");
    return readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

const shaCache = new Map<string, string | null>();

/** Commit sha at-or-before `reviewedAt` on the workspace's HEAD line, or null
 *  when git/timestamp unavailable. Cached per (workspace, reviewedAt). */
function commitAt(workspace: string, reviewedAt: string): string | null {
  if (!reviewedAt) return null;
  const key = `${workspace}\0${reviewedAt}`;
  if (shaCache.has(key)) return shaCache.get(key)!;
  let sha: string | null = null;
  try {
    const out = execFileSync("git", ["-C", workspace, "rev-list", "-1", `--before=${reviewedAt}`, "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    sha = out.length > 0 ? out : null;
  } catch {
    sha = null;
  }
  shaCache.set(key, sha);
  return sha;
}

function gitFileAt(workspace: string, relPath: string, sha: string): string[] | null {
  try {
    const content = execFileSync("git", ["-C", workspace, "show", `${sha}:${relPath}`], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return content.split("\n");
  } catch {
    return null;
  }
}

function sliceLines(all: string[], lines: [number, number] | undefined, context: number): string {
  if (!lines) {
    return all.slice(0, 40).map((l, i) => `${String(i + 1).padStart(5)}  ${l}`).join("\n");
  }
  const [a, b] = lines;
  const from = Math.max(1, a - context);
  const to = Math.min(all.length, b + context);
  const out: string[] = [];
  for (let n = from; n <= to; n++) {
    const marker = n >= a && n <= b ? "▶" : " ";
    out.push(`${marker}${String(n).padStart(5)}  ${all[n - 1] ?? ""}`);
  }
  return out.join("\n");
}

/** Resolve the evidence snippet, PREFERRING the code as of the review commit
 *  (so an actively-developed file's drift doesn't show the wrong code), and
 *  falling back to the current file with a loud "may have drifted" note. */
function resolveSnippet(
  workspace: string,
  evidencePath: string,
  lines: [number, number] | undefined,
  reviewedAt: string,
  context: number,
): { snippet: string | null; note: string } {
  const range = lines ? `lines ${lines[0]}–${lines[1]} (±${context})` : "first 40 lines";

  // 1. Exact: the file content at the review-time commit.
  const sha = commitAt(workspace, reviewedAt);
  if (sha) {
    const at = gitFileAt(workspace, evidencePath, sha);
    if (at !== null) {
      return { snippet: sliceLines(at, lines, context), note: `${range} as of review commit ${sha.slice(0, 8)}` };
    }
  }

  // 2. Fallback: the current working-tree file (may have drifted).
  const abs = resolveWithinWorkspace(workspace, evidencePath);
  if (abs === null) {
    return { snippet: null, note: `not found within ${workspace} (and no review-commit copy)` };
  }
  let text: string;
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    return { snippet: null, note: `unreadable: ${evidencePath}` };
  }
  return {
    snippet: sliceLines(text.split("\n"), lines, context),
    note: `${range} from CURRENT file — ⚠ may have drifted since review`,
  };
}

function toItems(workspace: string, findings: ExtractedFinding[], context: number): LabelSheetItem[] {
  return findings.map((f) => {
    const { snippet, note } = resolveSnippet(workspace, f.evidence_path, f.evidence_lines, f.reviewed_at, context);
    return {
      id: f.id,
      session_group_id: f.session_group_id,
      index: 0, // assigned after global sort
      severity: f.severity,
      workspace: workspace.split("/").pop() ?? workspace,
      evidence_path: f.evidence_path,
      ...(f.evidence_lines ? { evidence_lines: f.evidence_lines } : {}),
      checkpoint_id: f.checkpoint_id,
      observer_provider: f.observer_provider,
      claim: f.claim,
      snippet,
      snippet_note: note,
    };
  });
}

const USAGE =
  "usage: bun run eval:label-sheet --workspace <path> [--workspace <path> ...] [--out <file.md>] [--labels <human-labels.jsonl>] [--context <N>]";

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE + "\n");
    return 0;
  }
  if (args.workspaces.length === 0) {
    process.stderr.write(USAGE + "\n");
    return 2;
  }

  const labeled = alreadyLabeled(args.labels);
  let alreadyDone = 0;
  const items = args.workspaces.flatMap((w) =>
    toItems(
      w,
      extractFindings(reviewFilesFor(w)).findings.filter((f) => {
        if (labeled.has(f.id)) {
          alreadyDone++;
          return false;
        }
        return true;
      }),
      args.context,
    ),
  );
  items.sort(
    (x, y) =>
      (SEV_ORDER[x.severity] ?? 9) - (SEV_ORDER[y.severity] ?? 9) ||
      x.workspace.localeCompare(y.workspace),
  );
  items.forEach((it, i) => (it.index = i + 1));

  const md = renderLabelSheet(items);
  const doneNote = alreadyDone > 0 ? ` (${alreadyDone} already labeled, skipped)` : "";
  if (args.out) {
    writeFileSync(args.out, md);
    process.stdout.write(`eval:label-sheet: wrote ${items.length} findings → ${args.out}${doneNote}\n`);
  } else {
    process.stdout.write(md);
  }
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}
