/**
 * Council Eval Harness label-queue exporter (P3/B3).
 *
 *   bun run eval:label-export [--recordings <dir>] [--labels <file.jsonl> ...] \
 *     [--out <file.md>]
 *
 * Recovers every observer review from protocol recordings (default
 * `~/.companion/recordings/`, READ-ONLY — pass a copy when in doubt), keeps the
 * last write per checkpoint, drops findings already labeled in any `--labels`
 * log, and writes a label sheet (same renderer and ingest round-trip as
 * `eval:label-sheet`). Recordings carry no source tree, so evidence snippets
 * are not inlined: the sheet names `path:lines` and the reviewer opens it.
 *
 * Ends with the sufficiency verdict: until {@link MIN_LABELED_STOPS} STOPs are
 * labeled, "Observer is useful" is UNPROVEN and the precision gate NOT
 * EVALUATED.
 *
 * Reads real artifacts off disk; not in the vitest glob. The recovery,
 * selection and verdict logic are unit-tested on synthetic frames.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRecording } from "./recording/read-recording.js";
import { latestPerReview, recoverObserverReviews, type RecoveredReview } from "./recording/observer-reviews-from-recording.js";
import { extractFindingsFromDocs } from "./scorers/findings-extractor.js";
import { collectLabelKeys, countLabeledStops, selectUnlabeled } from "./label-export.js";
import { renderLabelSheet, type LabelSheetItem } from "./label-sheet.js";
import { evidenceVerdict, renderEvidenceVerdict } from "./reports/eval-scorecard.js";

const DEFAULT_LABELS = fileURLToPath(new URL("./judge-calibration/human-labels.jsonl", import.meta.url));
const SEV_ORDER: Record<string, number> = { STOP: 0, WARN: 1, NOTE: 2, INFO: 3 };

interface ParsedArgs {
  recordings: string;
  labels: string[];
  out?: string;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { recordings: join(homedir(), ".companion", "recordings"), labels: [], help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--recordings") out.recordings = argv[++i] ?? out.recordings;
    else if (a.startsWith("--recordings=")) out.recordings = a.slice("--recordings=".length);
    else if (a === "--labels") {
      const v = argv[++i];
      if (v) out.labels.push(v);
    } else if (a.startsWith("--labels=")) out.labels.push(a.slice("--labels=".length));
    else if (a === "--out") out.out = argv[++i];
    else if (a.startsWith("--out=")) out.out = a.slice("--out=".length);
  }
  if (out.labels.length === 0) out.labels.push(DEFAULT_LABELS);
  return out;
}

function readOptional(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

const USAGE =
  "usage: bun run eval:label-export [--recordings <dir>] [--labels <file.jsonl> ...] [--out <file.md>]";

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE + "\n");
    return 0;
  }

  let files: string[];
  try {
    // Recursive: rotated recordings live in `archived-recordings/`.
    files = readdirSync(args.recordings, { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".jsonl"))
      .sort();
  } catch {
    process.stderr.write(`eval:label-export: cannot read recordings dir ${args.recordings}\n`);
    return 2;
  }

  const recovered: RecoveredReview[] = [];
  let unrecoverable = 0;
  for (const f of files) {
    const r = recoverObserverReviews(loadRecording(join(args.recordings, f)), basename(f, ".jsonl"));
    recovered.push(...r.reviews);
    unrecoverable += r.unrecoverable;
  }
  const docs = latestPerReview(recovered);
  const extract = extractFindingsFromDocs(docs);
  const logs = args.labels.map(readOptional);
  const sel = selectUnlabeled(extract.findings, collectLabelKeys(logs));

  const items: LabelSheetItem[] = sel.queue.map((f) => ({
    id: f.id,
    session_group_id: f.session_group_id,
    index: 0,
    severity: f.severity,
    workspace: f.review_file.split("#", 1)[0]!,
    evidence_path: f.evidence_path,
    ...(f.evidence_lines ? { evidence_lines: f.evidence_lines } : {}),
    checkpoint_id: f.checkpoint_id,
    observer_provider: f.observer_provider || "unknown",
    claim: f.claim,
    snippet: null,
    snippet_note: "exported from a recording — no source tree; open the path at the checkpoint",
  }));
  items.sort(
    (x, y) =>
      (SEV_ORDER[x.severity] ?? 9) - (SEV_ORDER[y.severity] ?? 9) ||
      x.checkpoint_id.localeCompare(y.checkpoint_id) ||
      x.id.localeCompare(y.id),
  );
  items.forEach((it, i) => (it.index = i + 1));

  const labeled = countLabeledStops(logs, extract.findings);
  const verdict = evidenceVerdict(labeled.stops, labeled.precision);
  const stats =
    `recordings=${files.length} reviews=${extract.reviews} (from ${recovered.length} writes, ` +
    `${unrecoverable} unrecoverable edits) findings=${extract.findings.length} ` +
    `duplicates=${sel.duplicates} already_labeled=${sel.alreadyLabeled} queued=${items.length} ` +
    `(STOP ${items.filter((i) => i.severity === "STOP").length})`;
  const md = renderLabelSheet(items);
  if (args.out) {
    writeFileSync(args.out, md);
    process.stdout.write(`eval:label-export: ${stats}\n  → ${args.out}\n`);
  } else {
    process.stdout.write(md);
    process.stderr.write(`eval:label-export: ${stats}\n`);
  }
  process.stdout.write(renderEvidenceVerdict(verdict) + "\n");
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}
