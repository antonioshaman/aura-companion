/**
 * The prompt a COUNCIL-PANEL-BENCH run sends to the Chair (P6). The roster is
 * FORCED: the Chair seats exactly the panel under test instead of re-running
 * selection, so the panel is the only variable between runs of a case.
 *
 * Also switched off, because each would let one run influence another or
 * reach outside the bench: the seat result cache (a cached seat would be
 * "free" and skew cost), the run-stats write and the checkpoint emit.
 *
 * The prompt names the PR and the diff range — what a real reviewer is given —
 * and never anything from `knownDefects`.
 */

import type { PanelCase } from "./cases.js";
import type { Panel } from "./panels.js";

const SEAT_RE = /^[a-z][a-z0-9-]{1,31}$/;

export function buildPanelPrompt(c: PanelCase, panel: Panel, baseSha: string): string {
  if (!/^[0-9a-f]{40}$/.test(baseSha)) throw new Error(`council-panel: base must be a full sha, got ${baseSha}`);
  if (panel.seats.length === 0) throw new Error(`council-panel: panel ${panel.id} has no seats`);
  for (const s of panel.seats) {
    // Same canary as the skill's catalog-id check: a seat id is interpolated into a prompt.
    if (!SEAT_RE.test(s)) throw new Error(`council-panel: invalid seat id ${s}`);
  }
  return [
    `/council-review-aura Review the changes of PR #${c.pr} ("${c.title}"): the diff \`git diff ${baseSha}..HEAD\`. Scope: the changed files only.`,
    "",
    "BENCHMARK ROSTER OVERRIDE — follow exactly:",
    `- Seat EXACTLY these ${panel.seats.length} advisors, one subagent each, and no others: ${panel.seats.join(", ")}.`,
    "- Do not run the selection engine, do not add, veto or swap seats, and do not skip a listed seat because its domain looks empty — give it the changed files closest to its domain.",
    "- Do not use the seat result cache (no cache lookups, no cache write-back).",
    "- Skip the run-stats record and the checkpoint emit phases.",
    "- Everything else (brief, dispatch, synthesis, FINAL-REVIEW.md format) as the skill specifies.",
  ].join("\n");
}
