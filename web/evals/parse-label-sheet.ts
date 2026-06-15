/**
 * Sheet round-trip parser — the back half of the human-labeling loop. The
 * label-sheet renderer (label-sheet.ts) emits one block per finding carrying a
 * hidden `<!-- eval-label {...} -->` machine-key and a visible
 * `**Your call:** [ ] TRUE · [ ] FALSE · [ ] SKIP` line. A human ticks exactly
 * one box; this module reads the ticked sheet back into `EvalLabelRecord`s.
 *
 * The discipline that matters:
 *   - The verdict is read ONLY from the "Your call" line, never from the
 *     finding's free-text claim (which could itself contain `[x] TRUE`).
 *   - A block with no tick, a SKIP tick, or MORE THAN ONE tick yields NO
 *     record — ambiguity is dropped, never guessed. Counted in `skipped`.
 *   - A finding the human marked is always a tp/fp; the sheet never contains
 *     `expected_blocker_missed` (that set is authored by hand, by construction
 *     it has no emitted finding to tick). So every produced record carries the
 *     `finding_id` join key — satisfying the parser contract downstream.
 *   - The record `id` is derived deterministically from the finding_id so a
 *     re-ingest of the same sheet is idempotent (last-write-wins by id in the
 *     append-only label log).
 *
 * Pure: string in, records out. No disk, no clock — the ingest runner injects
 * `labeled_at` (server clock) and `labeler`. Firewall-clean: imports only the
 * eval schema + node:crypto.
 */

import { createHash } from "node:crypto";
import {
  EVAL_LABEL_VERSION,
  type EvalLabelRecord,
} from "./schema/eval-artifact.js";

/** The coordinates carried in a finding's hidden machine-key, plus the human's
 *  decisive verdict. The minimal shape needed to build an EvalLabelRecord. */
export interface SheetLabelInput {
  finding_id: string;
  session_group_id: string;
  checkpoint_id: string;
  evidence_path: string;
  verdict: "true_positive" | "false_positive";
}

export interface SheetParseResult {
  inputs: SheetLabelInput[];
  /** Blocks present but not decisively ticked (none / SKIP / multi-tick). */
  skipped: number;
  /** Hidden machine-keys that did not parse as a complete coordinate object. */
  malformed: number;
}

const COMMENT_RE = /<!-- eval-label (\{[\s\S]*?\}) -->/g;

interface Coords {
  finding_id: string;
  session_group_id: string;
  checkpoint_id: string;
  evidence_path: string;
}

function parseCoords(json: string): Coords | null {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const fields = ["finding_id", "session_group_id", "checkpoint_id", "evidence_path"] as const;
  for (const f of fields) {
    if (typeof o[f] !== "string" || o[f] === "") return null;
  }
  return {
    finding_id: o.finding_id as string,
    session_group_id: o.session_group_id as string,
    checkpoint_id: o.checkpoint_id as string,
    evidence_path: o.evidence_path as string,
  };
}

/**
 * Read the decisive verdict from a block, looking ONLY at the "Your call" line
 * so claim text can never spoof a tick. Returns null on no/ambiguous/SKIP tick.
 */
function readVerdict(block: string): SheetLabelInput["verdict"] | null {
  const marker = block.indexOf("**Your call:**");
  if (marker === -1) return null;
  const line = block.slice(marker).split("\n", 1)[0]!;
  const ticked = new Set<string>();
  const boxRe = /\[([ xX])\]\s*(TRUE|FALSE|SKIP)/g;
  let m: RegExpExecArray | null;
  while ((m = boxRe.exec(line)) !== null) {
    if (m[1] !== " ") ticked.add(m[2]!.toUpperCase());
  }
  if (ticked.size !== 1) return null; // none, or contradictory multi-tick
  if (ticked.has("TRUE")) return "true_positive";
  if (ticked.has("FALSE")) return "false_positive";
  return null; // SKIP ticked → no record
}

/**
 * Parse a ticked label sheet back into label inputs. Each hidden machine-key
 * delimits a block; the verdict is read from that block's "Your call" line.
 */
export function parseLabelSheet(text: string): SheetParseResult {
  const inputs: SheetLabelInput[] = [];
  let skipped = 0;
  let malformed = 0;

  const marks: { json: string; end: number; start: number }[] = [];
  COMMENT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = COMMENT_RE.exec(text)) !== null) {
    marks.push({ json: m[1]!, start: m.index, end: m.index + m[0].length });
  }

  for (let i = 0; i < marks.length; i++) {
    const blockEnd = i + 1 < marks.length ? marks[i + 1]!.start : text.length;
    const block = text.slice(marks[i]!.end, blockEnd);
    const coords = parseCoords(marks[i]!.json);
    if (coords === null) {
      malformed++;
      continue;
    }
    const verdict = readVerdict(block);
    if (verdict === null) {
      skipped++;
      continue;
    }
    inputs.push({ ...coords, verdict });
  }

  return { inputs, skipped, malformed };
}

/** Deterministic record id from the finding_id so re-ingest is idempotent. */
export function deriveLabelId(findingId: string): string {
  return "lbl_" + createHash("sha256").update(findingId).digest("hex").slice(0, 12);
}

export interface BuildLabelOptions {
  /** Who/what produced the labels (human handle). */
  labeler?: string;
  /** Server-clock ISO 8601 — the ingest runner injects `new Date().toISOString()`. */
  labeled_at?: string;
}

/** Build complete EvalLabelRecords from parsed sheet inputs. */
export function buildLabelRecords(
  inputs: SheetLabelInput[],
  opts: BuildLabelOptions = {},
): EvalLabelRecord[] {
  return inputs.map((it) => {
    const record: EvalLabelRecord = {
      eval_label_version: EVAL_LABEL_VERSION,
      id: deriveLabelId(it.finding_id),
      finding_id: it.finding_id,
      session_group_id: it.session_group_id,
      checkpoint_id: it.checkpoint_id,
      evidence_path: it.evidence_path,
      verdict: it.verdict,
    };
    if (opts.labeler) record.labeler = opts.labeler;
    if (opts.labeled_at) record.labeled_at = opts.labeled_at;
    return record;
  });
}
