/**
 * Human-label SHEET renderer — turns extracted observer findings into a
 * self-contained, trivially-judgeable markdown document for offline labeling.
 *
 * The raw observer `claim` is too dense to judge true/false in isolation, so
 * each entry leads with a one-line headline, inlines the ACTUAL source the
 * claim points at (`evidence_path:evidence_lines`, resolved by the runner),
 * and presents one unmistakable binary choice. A human works through the file
 * in a separate session, ticks TRUE / FALSE / SKIP, and the result feeds the
 * precision scorer.
 *
 * This module is the PURE renderer (string in, string out) so it is unit-
 * testable without disk; the runner resolves snippets and writes the file.
 * Firewall-clean: no `server/` imports.
 */

import { frameDecision, type Triage } from "./label-triage.js";

export interface LabelSheetItem {
  id: string;
  /** Council group the finding belongs to — carried into the round-trip
   *  machine-key so the parsed label can be a complete EvalLabelRecord. */
  session_group_id: string;
  /** 1-based position in the sheet. */
  index: number;
  severity: string;
  workspace: string;
  evidence_path: string;
  evidence_lines?: [number, number];
  checkpoint_id: string;
  observer_provider: string;
  /** Full claim text. */
  claim: string;
  /** Resolved source snippet (already line-numbered), or null when the file
   *  could not be read at the review-time path. */
  snippet: string | null;
  /** Human note about the snippet provenance (e.g. line range, or why absent). */
  snippet_note: string;
  /** Triage bucket (P3/FIX-B3-1). Absent → legacy flat TRUE/FALSE item. */
  triage?: Triage;
  /** For triaged code-claims: the same range in the CURRENT file, shown next
   *  to the checkpoint-time `snippet`. null = not available (see note). */
  current_snippet?: string | null;
  current_note?: string;
}

/**
 * First-sentence headline: everything up to the first sentence terminator or
 * newline, hard-capped so a runaway claim can't blow up the headline. The full
 * claim is always rendered below, so truncation here loses nothing.
 */
export function headlineOf(claim: string, maxLen = 200): string {
  const firstLine = claim.split("\n", 1)[0]!;
  const m = firstLine.match(/^(.*?[.:])\s/);
  let head = m ? m[1]! : firstLine;
  if (head.length > maxLen) head = head.slice(0, maxLen - 1).trimEnd() + "…";
  return head.trim();
}

/**
 * Hidden machine-readable coordinate block for the ingest round-trip. An HTML
 * comment does NOT render in a markdown viewer, so the human still sees a clean
 * sheet; the ingest parser reads the JSON to reconstruct a full EvalLabelRecord
 * (the join key `finding_id` + the record's required identity fields). JSON is
 * used so paths/ids with awkward characters survive without per-field escaping.
 */
function machineKey(it: LabelSheetItem): string {
  const coords = {
    finding_id: it.id,
    session_group_id: it.session_group_id,
    checkpoint_id: it.checkpoint_id,
    evidence_path: it.evidence_path,
  };
  return `<!-- eval-label ${JSON.stringify(coords)} -->`;
}

function pushCode(L: string[], title: string, snippet: string | null | undefined, note: string, absent: string): void {
  L.push(`**${title}** (${note}):`);
  L.push("");
  if (snippet != null) {
    // Fence longer than any backtick run in the code, so it cannot close early.
    const fence = "`".repeat(Math.max(3, ...[...snippet.matchAll(/`+/g)].map((m) => m[0].length + 1)));
    L.push(fence);
    L.push(snippet);
    L.push(fence);
  } else {
    L.push(`> _(${absent})_`);
  }
  L.push("");
}

function renderItem(it: LabelSheetItem): string {
  if (it.triage?.kind === "decision") return renderDecision(it);
  const L: string[] = [];
  L.push(machineKey(it));
  L.push(`## ${it.index}. [${it.severity}] ${it.evidence_path}`);
  L.push("");
  L.push(`**Headline:** ${headlineOf(it.claim)}`);
  L.push("");
  L.push(
    `_workspace_ \`${it.workspace}\` · _checkpoint_ \`${it.checkpoint_id}\` · ` +
      `_observer_ \`${it.observer_provider}\` · _id_ \`${it.id}\``,
  );
  L.push("");
  if (it.triage) {
    pushCode(L, "Code at the checkpoint", it.snippet, it.snippet_note, "no checkpoint-time copy — see note");
    pushCode(L, "Code now", it.current_snippet, it.current_note ?? "current file", "not in the current tree — see note");
  } else {
    pushCode(
      L,
      "Code it points at",
      it.snippet,
      it.snippet_note,
      "source not available at the review-time path — judge from the claim, or SKIP",
    );
  }
  L.push("<details><summary>full claim</summary>");
  L.push("");
  L.push(it.claim);
  L.push("");
  L.push("</details>");
  L.push("");
  L.push("**Your call:**  `[ ] TRUE`  ·  `[ ] FALSE`  ·  `[ ] SKIP`");
  L.push("");
  L.push("---");
  return L.join("\n");
}

/**
 * A product/policy decision for the human: "now it is X → A (keep) / B
 * (adopt the observer's recommendation) → what is right". A = the observer
 * was wrong (false_positive), B = right (true_positive) — see the parser.
 */
function renderDecision(it: LabelSheetItem): string {
  const d = frameDecision(it.claim);
  const L: string[] = [];
  L.push(machineKey(it));
  L.push(`## ${it.index}. [${it.severity}] ${it.evidence_path}`);
  L.push("");
  L.push(`_Почему к вам: ${it.triage?.reason ?? "decision"}_ · _observer_ \`${it.observer_provider}\` · _id_ \`${it.id}\``);
  L.push("");
  L.push(`- **Сейчас так:** ${d.now}`);
  L.push(`- **Вариант А:** ${d.optionA}`);
  L.push(`- **Вариант Б:** ${d.optionB}`);
  L.push("");
  L.push("<details><summary>полный текст observer</summary>");
  L.push("");
  L.push(it.claim);
  L.push("");
  L.push("</details>");
  L.push("");
  L.push("**Что верно:**  `[ ] A`  ·  `[ ] B`  ·  `[ ] SKIP`");
  L.push("");
  L.push("---");
  return L.join("\n");
}

/** Human decision sheet: only `decision` items, in the A/B format. */
export function renderDecisionSheet(items: LabelSheetItem[]): string {
  const head = [
    "# Observer — решения для человека",
    "",
    `${items.length} вопросов. Это не проверка кода (её делает оркестратор), а выбор: ` +
      "как должно быть. Для каждого поставьте `x` ровно в одну клетку: A, B или SKIP.",
    "",
    "---",
    "",
  ];
  return head.join("\n") + items.map(renderItem).join("\n") + "\n";
}

/** Orchestrator verification queue: `code-claim` items with the code at the
 *  checkpoint and now. Ingest with `--labeler orchestrator-<id>` so the labels
 *  are counted apart from human ones. */
export function renderCodeClaimQueue(items: LabelSheetItem[]): string {
  const head = [
    "# Observer — code claims to verify (orchestrator queue)",
    "",
    `${items.length} factual claims. Check each against the code shown (checkpoint-time and current), ` +
      "then tick TRUE / FALSE / SKIP. Ingest with `bun run eval:label-ingest --labeler orchestrator-<session>` — " +
      "these labels are reported separately from human labels.",
    "",
    "---",
    "",
  ];
  return head.join("\n") + items.map(renderItem).join("\n") + "\n";
}

export function renderLabelSheet(items: LabelSheetItem[]): string {
  const bySev = items.reduce<Record<string, number>>((acc, it) => {
    acc[it.severity] = (acc[it.severity] ?? 0) + 1;
    return acc;
  }, {});
  const head: string[] = [];
  head.push("# Council Eval — observer findings label sheet");
  head.push("");
  head.push(
    `${items.length} findings to label. For each: read the headline, look at the code, ` +
      "tick exactly one of TRUE / FALSE / SKIP by putting an `x` in its box.",
  );
  head.push("");
  head.push("- **TRUE** = the observer is right, this is a real issue.");
  head.push("- **FALSE** = false alarm; the claim does not hold against the code.");
  head.push("- **SKIP** = can't tell / not enough context.");
  head.push("");
  head.push(
    "Tally: " +
      Object.keys(bySev)
        .sort()
        .map((k) => `${k}=${bySev[k]}`)
        .join(" "),
  );
  head.push("");
  head.push("---");
  head.push("");
  return head.join("\n") + items.map(renderItem).join("\n") + "\n";
}
