/**
 * Council Eval Harness findings runner (M2 denominator surface).
 *
 *   bun run eval:findings --workspace <path> [--workspace <path> ...]
 *   bun run eval:findings --workspace <path> --json   # labelable rows to stdout
 *
 * Scans each workspace's `.council/reviews/` directory, extracts every observer
 * finding via {@link extractFindings}, and prints a per-workspace severity
 * table — the cheap, zero-LLM view of "what the observer actually flagged".
 * `--json` instead emits the flat finding rows so they can be hand-labeled
 * (true_positive / false_positive) into the EvalLabelRecord log.
 *
 * Like replay-runner this reads real artifacts off disk and is NOT in the
 * vitest glob; the extractor itself is unit-tested on synthetic fixtures.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { extractFindings, type FindingsExtract } from "./scorers/findings-extractor.js";

interface ParsedArgs {
  workspaces: string[];
  json: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { workspaces: [], json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--json") out.json = true;
    else if (a === "--workspace" || a === "-w") {
      const v = argv[++i];
      if (v) out.workspaces.push(v);
    } else if (a.startsWith("--workspace=")) out.workspaces.push(a.slice("--workspace=".length));
  }
  return out;
}

function reviewFilesFor(workspace: string): string[] {
  const dir = join(workspace, ".council", "reviews");
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

export function renderFindingsTable(rows: Array<{ workspace: string; extract: FindingsExtract }>): string {
  const L: string[] = [];
  L.push("── Council Eval · observer findings (M2 denominator) ──");
  const totals = { reviews: 0, findings: 0, STOP: 0, WARN: 0, NOTE: 0, INFO: 0, skipped: 0 };
  for (const { workspace, extract } of rows) {
    const s = extract.by_severity;
    totals.reviews += extract.reviews;
    totals.findings += extract.findings.length;
    totals.STOP += s.STOP;
    totals.WARN += s.WARN;
    totals.NOTE += s.NOTE;
    totals.INFO += s.INFO;
    totals.skipped += extract.skipped;
    L.push(
      `${workspace.padEnd(20)} reviews=${extract.reviews} findings=${extract.findings.length} ` +
        `[STOP=${s.STOP} WARN=${s.WARN} NOTE=${s.NOTE} INFO=${s.INFO}] ` +
        `skipped=${extract.skipped} malformed=${extract.malformed_findings}`,
    );
  }
  L.push("");
  L.push(
    `TOTAL reviews=${totals.reviews} findings=${totals.findings} ` +
      `[STOP=${totals.STOP} WARN=${totals.WARN} NOTE=${totals.NOTE} INFO=${totals.INFO}]`,
  );
  return L.join("\n");
}

const USAGE =
  "usage: bun run eval:findings --workspace <path> [--workspace <path> ...] [--json]";

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

  if (args.json) {
    const all = args.workspaces.flatMap((w) => extractFindings(reviewFilesFor(w)).findings);
    process.stdout.write(JSON.stringify(all, null, 2) + "\n");
    return 0;
  }

  const rows = args.workspaces.map((workspace) => ({
    workspace,
    extract: extractFindings(reviewFilesFor(workspace)),
  }));
  process.stdout.write(renderFindingsTable(rows) + "\n");
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}
