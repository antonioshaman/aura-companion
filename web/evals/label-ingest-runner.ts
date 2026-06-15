/**
 * Council Eval Harness label-ingest runner — the back half of the human-label
 * loop.
 *
 *   bun run eval:label-ingest --sheet <ticked-sheet.md> \
 *     [--out <human-labels.jsonl>] [--labeler <name>]
 *
 * Reads a sheet a human ticked offline (rendered by `eval:label-sheet`), parses
 * each decisive TRUE/FALSE back into an `EvalLabelRecord`, and APPENDS the new
 * records to the append-only label log. The log is last-write-wins by record id
 * (see `parseLabelLog`), so re-ingesting an edited sheet is idempotent — a label
 * whose verdict changed overwrites the prior one on read; appending does not
 * duplicate it.
 *
 * `labeled_at` is stamped from the SERVER clock here, never the human's prose —
 * the sheet carries no trustworthy timestamp. Touches disk; not in the vitest
 * glob. The parsing + record construction live in the pure, tested
 * `parse-label-sheet.ts`.
 */

import { readFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseLabelSheet, buildLabelRecords } from "./parse-label-sheet.js";
import { parseLabelLog } from "./schema/parse-artifact.js";

interface ParsedArgs {
  sheet?: string;
  out: string;
  labeler?: string;
  help: boolean;
}

const DEFAULT_OUT = fileURLToPath(new URL("./judge-calibration/human-labels.jsonl", import.meta.url));

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { out: DEFAULT_OUT, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--sheet" || a === "-s") out.sheet = argv[++i];
    else if (a.startsWith("--sheet=")) out.sheet = a.slice("--sheet=".length);
    else if (a === "--out") out.out = argv[++i] ?? out.out;
    else if (a.startsWith("--out=")) out.out = a.slice("--out=".length);
    else if (a === "--labeler") out.labeler = argv[++i];
    else if (a.startsWith("--labeler=")) out.labeler = a.slice("--labeler=".length);
  }
  return out;
}

const USAGE =
  "usage: bun run eval:label-ingest --sheet <ticked-sheet.md> [--out <human-labels.jsonl>] [--labeler <name>]";

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE + "\n");
    return 0;
  }
  if (!args.sheet) {
    process.stderr.write(USAGE + "\n");
    return 2;
  }

  let sheetText: string;
  try {
    sheetText = readFileSync(args.sheet, "utf8");
  } catch {
    process.stderr.write(`eval:label-ingest: cannot read sheet ${args.sheet}\n`);
    return 1;
  }

  const parsed = parseLabelSheet(sheetText);
  const records = buildLabelRecords(parsed.inputs, {
    ...(args.labeler ? { labeler: args.labeler } : {}),
    labeled_at: new Date().toISOString(),
  });

  if (records.length === 0) {
    process.stdout.write(
      `eval:label-ingest: no decisive labels found ` +
        `(skipped=${parsed.skipped}, malformed=${parsed.malformed}); nothing appended\n`,
    );
    return 0;
  }

  mkdirSync(dirname(args.out), { recursive: true });
  const lines = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  appendFileSync(args.out, lines);

  // Report the deduped total so the operator sees the effective corpus size.
  let total = records.length;
  if (existsSync(args.out)) {
    total = parseLabelLog(readFileSync(args.out, "utf8")).records.length;
  }
  process.stdout.write(
    `eval:label-ingest: appended ${records.length} labels ` +
      `(skipped=${parsed.skipped}, malformed=${parsed.malformed}) → ${args.out} ` +
      `[${total} unique total]\n`,
  );
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}
