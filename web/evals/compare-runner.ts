/**
 * Council Eval Harness comparison runner.
 *
 *   bun run eval:compare --baseline <path> --candidate <path> [--markdown]
 *
 * Each path is EITHER a directory (a precision corpus — `*.sidecar.json` +
 * `labels.jsonl`, scored on the fly via `scorePrecisionCorpus`) OR a `.json`
 * file holding an already-serialized {@link PrecisionSummary} (e.g. a committed
 * baseline like `ci-precision-baseline.json`). This lets a maintainer diff a
 * fresh corpus against a frozen baseline, or two corpora against each other,
 * with the same command.
 *
 * It prints a grounded-tier side-by-side delta (precision / recall /
 * false_stop_rate) and ALWAYS exits 0 — this is an advisory lens, not a gate.
 * The blocking no-regression check stays in `eval:replay --ci`. Zero LLM calls:
 * both inputs are already-scored numbers.
 */

import { readFileSync, statSync } from "node:fs";
import {
  compareSummaries,
  renderComparisonMarkdown,
  renderComparisonText,
} from "./reports/compare.js";
import { scorePrecisionCorpus, type PrecisionSummary } from "./scorers/precision-corpus.js";

interface Args {
  baseline: string;
  candidate: string;
  markdown: boolean;
}

function parseArgs(argv: string[]): Args {
  let baseline = "";
  let candidate = "";
  let markdown = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--baseline") baseline = argv[++i] ?? "";
    else if (a === "--candidate") candidate = argv[++i] ?? "";
    else if (a === "--markdown") markdown = true;
  }
  if (!baseline || !candidate) {
    throw new Error("usage: eval:compare --baseline <path> --candidate <path> [--markdown]");
  }
  return { baseline, candidate, markdown };
}

/** Resolve a path to a PrecisionSummary: a directory is scored as a corpus; a
 *  `.json` file is read as a frozen summary. */
export function loadSummary(path: string): PrecisionSummary {
  if (statSync(path).isDirectory()) {
    return scorePrecisionCorpus(path).summary;
  }
  return JSON.parse(readFileSync(path, "utf8")) as PrecisionSummary;
}

export function main(argv: string[]): number {
  const args = parseArgs(argv);
  const baseline = loadSummary(args.baseline);
  const candidate = loadSummary(args.candidate);
  const rows = compareSummaries(baseline, candidate);
  const out = args.markdown ? renderComparisonMarkdown(rows) : renderComparisonText(rows);
  process.stdout.write(out + "\n");
  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
