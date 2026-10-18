/**
 * The ONE browser reader of a context-advisory record (mirror of the server's
 * `decodeContextAdvisory` in context-size-suggester.ts). Records written
 * before 2026-10-17 carry only `milestoneBytes` and no `signal`: they are
 * bytes. `ws.ts` (legacy frame seeding) and `ContextAdvisoryBanner` both go
 * through this so the legacy-shape rule lives in exactly one place per runtime.
 */
import type { ContextAdvisoryRecord, ContextAdvisorySignal } from "../types.js";

export interface DecodedContextAdvisory {
  signal: ContextAdvisorySignal;
  /** Milestone in the signal's unit (bytes or compactions). */
  milestone: number;
}

export function decodeContextAdvisory(
  record: Pick<ContextAdvisoryRecord, "signal" | "milestone" | "milestoneBytes">,
): DecodedContextAdvisory {
  return {
    signal: record.signal ?? "transcript_bytes",
    milestone: record.milestone ?? record.milestoneBytes ?? 0,
  };
}
