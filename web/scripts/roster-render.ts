#!/usr/bin/env bun
// RC-2 CLI-flow presentation helpers (PLAN Task 8, friedman R1/R2/R3/R4).
//
// Pure text renderers for the developer-facing council flow. Kept as pure
// functions (not skill prose) so they are deterministic + testable; the skill
// (Task 9) calls them. friedman: the roster is a scannable ledger (matched signal
// per line, score in drill-down not headline); confirm-stack is a recoverable
// state (shows what was detected + a forward action), never a dead-end refusal.

import type { Composition, RankedCandidate } from "./advisor-scorer";
import type { Fingerprint, FingerprintFailure } from "./fingerprint";

/**
 * Surface fingerprint read-failures at the human boundary (ritchie #2). Every read
 * primitive records size_exceeded / read_error / symlink / out_of_bounds / json_parse
 * into `Fingerprint.failures`, but nothing drained it — a `pyproject.toml` over its
 * byte cap silently dropped its signals and seated the wrong council with the only
 * evidence discarded. A partial scan is NOT a clean scan; say so.
 */
export function renderFailures(failures: FingerprintFailure[]): string[] {
  if (failures.length === 0) return [];
  const lines = [
    `⚠ DEGRADED SCAN — could not read ${failures.length} marker file(s); the roster may be missing signals from them:`,
  ];
  for (const f of failures) lines.push(`  - ${f.path} (${f.reason})`);
  return lines;
}

function seatLine(c: RankedCandidate, index: number): string {
  const domain = c.matchedDomains[0] ?? (c.crossStack ? "cross-stack" : "—");
  const why = c.matchedSignals.length > 0 ? c.matchedSignals.join(", ") : c.crossStack ? "cross-stack lens" : "—";
  const id = c.advisorId.padEnd(11);
  return `  ${String(index + 1).padStart(2)}. ${id} ● ${domain}  ← ${why}`;
}

/**
 * Scannable roster ledger (friedman R1/R2). One line per seat: name, primary
 * matched domain, matched signals (the WHY — grounded in scorer data, not model
 * prose, willison R2). Crowded-out candidates are listed with an `add` hint so a
 * starved lens (e.g. security) is visibly recoverable (hunt #4, AC3.5).
 */
export function renderRosterPreview(comp: Composition, fingerprint?: Fingerprint): string {
  const lines: string[] = [];
  // A degraded scan changes what the roster means — surface it ABOVE the seats so
  // the developer sees the roster was computed from incomplete evidence.
  if (fingerprint && fingerprint.failures.length > 0) {
    lines.push(...renderFailures(fingerprint.failures), "");
  }
  lines.push(`Proposed council — ${comp.seated.length} seat${comp.seated.length === 1 ? "" : "s"} (adjust or confirm):`);
  comp.seated.forEach((c, i) => lines.push(seatLine(c, i)));
  if (comp.crowdedOut.length > 0) {
    lines.push("");
    lines.push(`Crowded out below the cap (add with \`add <id>\`):`);
    comp.crowdedOut.forEach((c, i) => lines.push(seatLine(c, i)));
  }
  if (comp.belowMin) {
    lines.push("");
    lines.push("NOTE: thin fingerprint — fewer relevant advisors than the minimum; consider confirming the stack or broadening scope.");
  }
  lines.push("");
  lines.push("→ `confirm` to dispatch · `veto <id>` to remove · `add <id>` to seat a crowded-out advisor");
  return lines.join("\n");
}

/**
 * Recoverable confirm-stack prompt (friedman R3/R4). Shows what WAS detected and
 * offers a forward action (confirm candidates / override / describe) — never the
 * old dead-end refusal. Structured choice first, free-text as the escape hatch.
 */
export function renderConfirmStackPrompt(fingerprint: Fingerprint): string {
  const lines: string[] = ["Stack unconfirmed — I need one confirmation to proceed.", ""];
  if (fingerprint.signals.length > 0) {
    lines.push("Detected so far (low confidence):");
    for (const dim of ["languages", "runtimes", "frameworks", "datastores", "orm-migrations", "infra", "surfaces"] as const) {
      const t = fingerprint.byDimension[dim];
      if (t.length > 0) lines.push(`  ${dim}: ${t.join(", ")}`);
    }
  } else {
    lines.push("No recognised stack signals were found at the workspace root or its subdirectories.");
  }
  if (fingerprint.scanTruncated) {
    lines.push("  (scan was capped — a very wide monorepo may have unseen subdirs)");
  }
  if (fingerprint.failures.length > 0) {
    lines.push("", ...renderFailures(fingerprint.failures));
  }
  lines.push("");
  lines.push("To proceed, pick one:");
  lines.push("  1. Confirm the detected stack above is correct");
  lines.push("  2. Name your stack (e.g. `fastapi + react + postgres`)");
  lines.push("  3. Write `.council-stack-override` with the intended stack tokens");
  return lines.join("\n");
}
