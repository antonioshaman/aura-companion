/**
 * Did the Chair seat exactly the forced roster? (COUNCIL-PANEL-BENCH, P6)
 *
 * The panel is the only variable between runs of a case, so a run whose
 * Chair seated a different set of advisors measures nothing and is recorded
 * as invalid. The proof comes from the Chair's own `stream-json`: every
 * top-level `Agent`/`Task` tool call (frames with `parent_tool_use_id` null —
 * a subagent's own tool calls do not count) is one dispatch, and the seat is
 * read from its prompt, which the skill builds from the catalog file and the
 * seat's output path:
 *
 *   `.council/review-output/<TS>/<seat>.md`   (preferred — the seat's report)
 *   `_council-experts/<seat>/`                (the catalog file it was built from)
 *
 * Only catalog ids count as seats. A dispatch naming no seat (or several, so
 * none can be attributed) is `other` — recorded, not guessed.
 *
 * Pure. Firewall-clean.
 */

import { parseJsonLines } from "../harness/agent-metrics.js";

const DISPATCH_TOOLS = new Set(["Agent", "Task"]);

export interface SeatDispatch {
  seat: string | null;
  subagentType: string | null;
  model: string | null;
  description: string;
}

export interface DispatchCheck {
  dispatches: SeatDispatch[];
  /** Distinct seats dispatched, in first-dispatch order. */
  seated: string[];
  /** Forced seats never dispatched. */
  missing: string[];
  /** Catalog seats dispatched that the panel does not hold. */
  extra: string[];
  /** Seats dispatched more than once (a retry — recorded, not invalidating). */
  duplicates: string[];
  /** Dispatches that name no attributable seat. */
  other: number;
  /** Seated set == forced set. */
  valid: boolean;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** The seat a dispatch prompt belongs to, or null when none / ambiguous. */
export function seatOfPrompt(prompt: string, catalogIds: ReadonlySet<string>): string | null {
  const pick = (re: RegExp): string | null | undefined => {
    const ids = new Set<string>();
    for (const m of prompt.matchAll(re)) if (catalogIds.has(m[1]!)) ids.add(m[1]!);
    if (ids.size === 1) return [...ids][0]!;
    return ids.size === 0 ? undefined : null;
  };
  const byOutput = pick(/review-output\/[^/\s`'"]+\/([a-z0-9-]+)\.md/g);
  if (byOutput) return byOutput;
  const byCatalog = pick(/_council-experts\/([a-z0-9-]+)\//g);
  if (byCatalog) return byCatalog;
  return null;
}

export function checkDispatch(stream: string, forced: readonly string[], catalogIds: ReadonlySet<string>): DispatchCheck {
  const dispatches: SeatDispatch[] = [];
  for (const f of parseJsonLines(stream)) {
    if (f.type !== "assistant" || (f.parent_tool_use_id ?? null) !== null) continue;
    const content = (f.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Record<string, unknown>[]) {
      if (block?.type !== "tool_use" || !DISPATCH_TOOLS.has(String(block.name))) continue;
      const input = (block.input ?? {}) as Record<string, unknown>;
      dispatches.push({
        seat: seatOfPrompt(`${str(input.prompt) ?? ""}\n${str(input.description) ?? ""}`, catalogIds),
        subagentType: str(input.subagent_type),
        model: str(input.model),
        description: (str(input.description) ?? "").slice(0, 120),
      });
    }
  }
  const seated: string[] = [];
  const duplicates = new Set<string>();
  for (const d of dispatches) {
    if (d.seat === null) continue;
    if (seated.includes(d.seat)) duplicates.add(d.seat);
    else seated.push(d.seat);
  }
  const missing = forced.filter((s) => !seated.includes(s));
  const extra = seated.filter((s) => !forced.includes(s));
  return {
    dispatches,
    seated,
    missing,
    extra,
    duplicates: [...duplicates],
    other: dispatches.filter((d) => d.seat === null).length,
    valid: missing.length === 0 && extra.length === 0,
  };
}
