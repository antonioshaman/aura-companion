/**
 * Human resolutions of observer STOPs for auto-proceed (aura-meta-diet P4/FIX-AP-1).
 *
 * The blocker banner keeps a STOP visible until a human acts on it ("Dismiss
 * for now" or "Dispute"). Auto-proceed must hold on exactly that set, and the
 * hold must survive a server restart, so the server needs its own record of
 * which STOPs a human released. Disputes are already persisted
 * (`observer-disputes.ts`); this file holds the other release: a plain
 * dismissal, recorded by finding id at
 * `<workspace>/.council/state/<group>-resolved-stops.json`.
 *
 * A resolution only releases the auto-proceed hold. It is not a dispute: it
 * never marks a finding `disputed` and never hides a re-raised claim (a new
 * finding id is a new STOP). Written only by the server; the observer's write
 * allow-list excludes `.council/state/`.
 */

import { readFileSync } from "node:fs";
import { writeAtomicJson } from "./atomic-write.js";
import { resolveCouncilStatePath } from "./council-state-path.js";

export const STOP_RESOLUTIONS_SCHEMA_VERSION = 1;
/** Oldest ids are evicted past this count (bounded file). */
export const MAX_STOP_RESOLUTIONS_PER_GROUP = 256;
export const MAX_FINDING_ID_LEN = 256;
const RESOLUTIONS_SUFFIX = "-resolved-stops.json";

export type StopResolutionsReadResult =
  | { ok: true; findingIds: string[] }
  | { ok: false; reason: "path-error" | "unreadable" | "invalid-json" | "invalid-shape" };

function isFindingId(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= MAX_FINDING_ID_LEN;
}

/**
 * Read a group's resolved STOP ids. A missing file is an empty list. Any other
 * failure is reported; callers treat it as empty, which fails toward holding
 * auto-proceed, never toward firing past an unreviewed STOP.
 */
export function readStopResolutions(workspaceRoot: string, groupId: string): StopResolutionsReadResult {
  const p = resolveCouncilStatePath(workspaceRoot, groupId, RESOLUTIONS_SUFFIX);
  if (!p.ok) return { ok: false, reason: "path-error" };
  let raw: string;
  try {
    raw = readFileSync(p.value.absolutePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, findingIds: [] };
    return { ok: false, reason: "unreadable" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "invalid-json" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "invalid-shape" };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.schemaVersion !== STOP_RESOLUTIONS_SCHEMA_VERSION || !Array.isArray(obj.findingIds)) {
    return { ok: false, reason: "invalid-shape" };
  }
  // One bad row must not discard the other resolutions.
  return { ok: true, findingIds: obj.findingIds.filter(isFindingId) };
}

export type AddStopResolutionResult =
  | { ok: true; added: boolean }
  | { ok: false; reason: "invalid-input" | "path-error" | "write-failed"; detail?: string };

/** Append a resolved finding id (idempotent) and persist atomically. */
export function addStopResolution(
  workspaceRoot: string,
  groupId: string,
  findingId: string,
): AddStopResolutionResult {
  if (!isFindingId(findingId)) return { ok: false, reason: "invalid-input" };
  const p = resolveCouncilStatePath(workspaceRoot, groupId, RESOLUTIONS_SUFFIX);
  if (!p.ok) return { ok: false, reason: "path-error" };
  const existing = readStopResolutions(workspaceRoot, groupId);
  const ids = existing.ok ? existing.findingIds : [];
  if (ids.includes(findingId)) return { ok: true, added: false };
  ids.push(findingId);
  try {
    writeAtomicJson(
      p.value.absolutePath,
      {
        schemaVersion: STOP_RESOLUTIONS_SCHEMA_VERSION,
        sessionGroupId: groupId,
        findingIds: ids.slice(-MAX_STOP_RESOLUTIONS_PER_GROUP),
      },
      { maxBytes: 256 * 1024 },
    );
  } catch (err) {
    return { ok: false, reason: "write-failed", detail: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true, added: true };
}
