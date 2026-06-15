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

export interface LabelSheetItem {
  id: string;
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

function renderItem(it: LabelSheetItem): string {
  const L: string[] = [];
  L.push(`## ${it.index}. [${it.severity}] ${it.evidence_path}`);
  L.push("");
  L.push(`**Headline:** ${headlineOf(it.claim)}`);
  L.push("");
  L.push(
    `_workspace_ \`${it.workspace}\` · _checkpoint_ \`${it.checkpoint_id}\` · ` +
      `_observer_ \`${it.observer_provider}\` · _id_ \`${it.id}\``,
  );
  L.push("");
  L.push(`**Code it points at** (${it.snippet_note}):`);
  L.push("");
  if (it.snippet !== null) {
    L.push("```");
    L.push(it.snippet);
    L.push("```");
  } else {
    L.push("> _(source not available at the review-time path — judge from the claim, or SKIP)_");
  }
  L.push("");
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
