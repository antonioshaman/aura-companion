/**
 * Council Eval Harness label-queue exporter (P3/B3).
 *
 *   bun run eval:label-export [--recordings <dir>] [--labels <file.jsonl> ...] \
 *     [--out <decisions.md>] [--out-orchestrator <queue.md>] \
 *     [--workspace-map <recorded-prefix>=<local-prefix> ...] [--context <N>]
 *
 * Recovers every observer review from protocol recordings (default
 * `~/.companion/recordings/`, READ-ONLY — pass a copy when in doubt), keeps the
 * last write per checkpoint, drops findings already labeled in any `--labels`
 * log, and triages the rest (P3/FIX-B3-1, see label-triage.ts):
 *
 *   - decisions   → `--out` — the human sheet, "now → A / B → what is right";
 *   - code claims → `--out-orchestrator` (default `<out>.orchestrator.md`) —
 *     the orchestrator's queue, each with the code at the checkpoint
 *     (`git show` of the last commit at-or-before the review, in the
 *     recording's `cwd`) and the code now;
 *   - INFO / no assertion → dropped, counted.
 *
 * `--workspace-map` points a recorded `cwd` at a clone (git reads only; use it
 * to keep the exporter off a production checkout).
 *
 * Ends with the sufficiency verdict (until {@link MIN_LABELED_STOPS} STOPs are
 * labeled, "Observer is useful" is UNPROVEN and the precision gate NOT
 * EVALUATED) and the labeled-STOP precision split by label source.
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
import { collectLabelKeys, countLabeledStops, renderPrecisionBySource, selectUnlabeled } from "./label-export.js";
import { renderCodeClaimQueue, renderDecisionSheet, type LabelSheetItem } from "./label-sheet.js";
import { classifyFinding } from "./label-triage.js";
import { mapWorkspace, resolveEvidence } from "./evidence-source.js";
import { evidenceVerdict, renderEvidenceVerdict } from "./reports/eval-scorecard.js";

const DEFAULT_LABELS = fileURLToPath(new URL("./judge-calibration/human-labels.jsonl", import.meta.url));
const SEV_ORDER: Record<string, number> = { STOP: 0, WARN: 1, NOTE: 2, INFO: 3 };

interface ParsedArgs {
  recordings: string;
  labels: string[];
  out?: string;
  outOrchestrator?: string;
  workspaceMaps: [string, string][];
  context: number;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    recordings: join(homedir(), ".companion", "recordings"),
    labels: [],
    workspaceMaps: [],
    context: 6,
    help: false,
  };
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
    else if (a === "--out-orchestrator") out.outOrchestrator = argv[++i];
    else if (a.startsWith("--out-orchestrator=")) out.outOrchestrator = a.slice("--out-orchestrator=".length);
    else if (a === "--workspace-map" || a.startsWith("--workspace-map=")) {
      const v = a === "--workspace-map" ? argv[++i] : a.slice("--workspace-map=".length);
      const eq = v?.indexOf("=") ?? -1;
      if (v && eq > 0) out.workspaceMaps.push([v.slice(0, eq), v.slice(eq + 1)]);
    } else if (a === "--context") out.context = Number(argv[++i]) || 6;
    else if (a.startsWith("--context=")) out.context = Number(a.slice("--context=".length)) || 6;
  }
  if (out.out && !out.outOrchestrator) out.outOrchestrator = out.out.replace(/(\.md)?$/, ".orchestrator.md");
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
  "usage: bun run eval:label-export [--recordings <dir>] [--labels <file.jsonl> ...] " +
  "[--out <decisions.md>] [--out-orchestrator <queue.md>] [--workspace-map <from>=<to> ...] [--context <N>]";

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
  /** recording label → workspace it ran in (header `cwd`), for snippets. */
  const cwdOf = new Map<string, string>();
  let unrecoverable = 0;
  for (const f of files) {
    const rec = loadRecording(join(args.recordings, f));
    const label = basename(f, ".jsonl");
    cwdOf.set(label, rec.header?.cwd ?? "");
    const r = recoverObserverReviews(rec, label);
    recovered.push(...r.reviews);
    unrecoverable += r.unrecoverable;
  }
  const docs = latestPerReview(recovered);
  const extract = extractFindingsFromDocs(docs);
  const logs = args.labels.map(readOptional);
  const sel = selectUnlabeled(extract.findings, collectLabelKeys(logs));

  const decisions: LabelSheetItem[] = [];
  const codeClaims: LabelSheetItem[] = [];
  let excluded = 0;
  for (const f of sel.queue) {
    const triage = classifyFinding(f);
    if (triage.kind === "excluded") {
      excluded++;
      continue;
    }
    const label = f.review_file.split("#", 1)[0]!;
    const cwd = mapWorkspace(cwdOf.get(label) ?? "", args.workspaceMaps);
    const item: LabelSheetItem = {
      id: f.id,
      session_group_id: f.session_group_id,
      index: 0,
      severity: f.severity,
      workspace: cwd || label,
      evidence_path: f.evidence_path,
      ...(f.evidence_lines ? { evidence_lines: f.evidence_lines } : {}),
      checkpoint_id: f.checkpoint_id,
      observer_provider: f.observer_provider || "unknown",
      claim: f.claim,
      snippet: null,
      snippet_note: "",
      triage,
    };
    if (triage.kind === "decision") {
      decisions.push(item);
      continue;
    }
    const ev = resolveEvidence(cwd, f.evidence_path, f.evidence_lines, f.reviewed_at, args.context);
    const why = ev.missing.join("; ");
    item.snippet = ev.atCheckpoint?.snippet ?? null;
    item.snippet_note = ev.atCheckpoint?.note ?? why;
    item.current_snippet = ev.current?.snippet ?? null;
    item.current_note = ev.current?.note ?? why;
    codeClaims.push(item);
  }
  const bySeverity = (x: LabelSheetItem, y: LabelSheetItem) =>
    (SEV_ORDER[x.severity] ?? 9) - (SEV_ORDER[y.severity] ?? 9) ||
    x.checkpoint_id.localeCompare(y.checkpoint_id) ||
    x.id.localeCompare(y.id);
  for (const list of [decisions, codeClaims]) {
    list.sort(bySeverity);
    list.forEach((it, i) => (it.index = i + 1));
  }

  const labeled = countLabeledStops(logs, extract.findings);
  const verdict = evidenceVerdict(labeled.stops, labeled.precision);
  const stops = (l: LabelSheetItem[]) => l.filter((i) => i.severity === "STOP").length;
  const withCode = codeClaims.filter((i) => i.snippet !== null).length;
  const stats =
    `recordings=${files.length} reviews=${extract.reviews} (from ${recovered.length} writes, ` +
    `${unrecoverable} unrecoverable edits) findings=${extract.findings.length} ` +
    `duplicates=${sel.duplicates} already_labeled=${sel.alreadyLabeled} unlabeled=${sel.queue.length}\n` +
    `  triage: decisions=${decisions.length} (STOP ${stops(decisions)}) ` +
    `code_claims=${codeClaims.length} (STOP ${stops(codeClaims)}, ${withCode} with checkpoint code) ` +
    `excluded=${excluded}`;
  const humanMd = renderDecisionSheet(decisions);
  const orchestratorMd = renderCodeClaimQueue(codeClaims);
  if (args.out) {
    writeFileSync(args.out, humanMd);
    writeFileSync(args.outOrchestrator!, orchestratorMd);
    process.stdout.write(
      `eval:label-export: ${stats}\n  → human decisions: ${args.out}\n  → orchestrator queue: ${args.outOrchestrator}\n`,
    );
  } else {
    process.stdout.write(humanMd + "\n" + orchestratorMd);
    process.stderr.write(`eval:label-export: ${stats}\n`);
  }
  process.stdout.write(renderPrecisionBySource(labeled) + "\n");
  process.stdout.write(renderEvidenceVerdict(verdict) + "\n");
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}
