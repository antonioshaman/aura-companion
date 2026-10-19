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
import { extractFindings, type ExtractedFinding } from "./scorers/findings-extractor.js";
import { resolveSnippet } from "./evidence-source.js";
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
