/**
 * Council Eval Harness scorecard runner.
 *
 *   bun run eval:scorecard [--dir <precision-corpus-dir>] [--markdown]
 *
 * Scores the observer-quality (STOP precision/recall) of a precision corpus and
 * renders a single pass/fail scorecard — Story 2.2's at-a-glance verdict for the
 * metrics that matter most. Defaults to the checked-in synthetic corpus under
 * `__fixtures__/precision/`; `--dir` points it at another corpus. Plain text by
 * default; `--markdown` emits the GitHub-flavored table for a PR comment / job
 * summary.
 *
 * Zero LLM calls — it reuses the same deterministic {@link scorePrecisionCorpus}
 * the CI gate uses. The EXIT CODE reflects the card verdict (0 pass / 1 fail) so
 * it can double as an ADVISORY CI summary step, but it is NOT the blocking gate:
 * `eval:replay --ci` blocks on no-regression-vs-baseline. An unlabeled/empty
 * corpus renders "no scoreable inputs" and is a FAIL, never a vacuous pass.
 *
 * Like the other runners it reads artifacts off disk and is NOT in the vitest
 * glob; the pure mapping ({@link buildEvalScorecard}) and renderers are unit-tested.
 */

import { fileURLToPath } from "node:url";
import { scorePrecisionCorpus } from "./scorers/precision-corpus.js";
import { buildEvalScorecard } from "./reports/eval-scorecard.js";
import { renderScorecardMarkdown, renderScorecardText } from "./reports/scorecard.js";

const DEFAULT_CORPUS_DIR = fileURLToPath(new URL("./__fixtures__/precision", import.meta.url));

interface ParsedArgs {
  dir: string;
  markdown: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { dir: DEFAULT_CORPUS_DIR, markdown: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--markdown" || a === "--md") out.markdown = true;
    else if (a === "--dir" || a === "-d") {
      const v = argv[++i];
      if (v) out.dir = v;
    } else if (a.startsWith("--dir=")) out.dir = a.slice("--dir=".length);
  }
  return out;
}

const USAGE = "usage: bun run eval:scorecard [--dir <precision-corpus-dir>] [--markdown]";

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE + "\n");
    return 0;
  }

  const { summary } = scorePrecisionCorpus(args.dir);
  const card = buildEvalScorecard(summary);
  const out = args.markdown ? renderScorecardMarkdown(card) : renderScorecardText(card);
  process.stdout.write(out + "\n");
  return card.passed ? 0 : 1;
}

if (import.meta.main) {
  process.exit(main());
}
