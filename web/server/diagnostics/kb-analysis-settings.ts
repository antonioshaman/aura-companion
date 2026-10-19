/**
 * Settings for the background KB analyzer (spec
 * `specs/diagnostics-page-and-kb-analyzer-v1.md` §3.2, owner answers 2026-10-19).
 *
 * An analysis becomes due when ANY one threshold is reached since the last run:
 *   newEntriesThreshold — KB entries created or updated
 *   sessionsThreshold   — finished sessions
 *   maxAgeDays          — days since the last run (safety net)
 *
 * Wire + disk shape: `kbAnalysis: { newEntriesThreshold, sessionsThreshold, maxAgeDays }`.
 * The three numbers always travel together, so they are one object (the
 * `councilSecondReviewer` precedent), normalised here for disk and parsed
 * strictly for the PUT route.
 *
 * Bounds matter: a threshold of 0 would make the analyzer due every hour, and a
 * huge maxAgeDays silently disables the safety net.
 */

export interface KbAnalysisSettings {
  newEntriesThreshold: number;
  sessionsThreshold: number;
  maxAgeDays: number;
}

export const DEFAULT_KB_ANALYSIS_SETTINGS: Readonly<KbAnalysisSettings> = Object.freeze({
  newEntriesThreshold: 10,
  sessionsThreshold: 25,
  maxAgeDays: 14,
});

/** Inclusive integer bounds per field. */
export const KB_ANALYSIS_BOUNDS: Readonly<Record<keyof KbAnalysisSettings, readonly [number, number]>> = Object.freeze({
  newEntriesThreshold: [1, 1000] as const,
  sessionsThreshold: [1, 10000] as const,
  maxAgeDays: [1, 365] as const,
});

const FIELDS = Object.keys(DEFAULT_KB_ANALYSIS_SETTINGS) as (keyof KbAnalysisSettings)[];

function inBounds(field: keyof KbAnalysisSettings, v: unknown): v is number {
  const [min, max] = KB_ANALYSIS_BOUNDS[field];
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
}

/** Disk-side normaliser: any missing or out-of-bounds field falls back to its default. */
export function normalizeKbAnalysisSettings(raw: unknown): KbAnalysisSettings {
  const obj = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out = { ...DEFAULT_KB_ANALYSIS_SETTINGS };
  for (const f of FIELDS) {
    if (inBounds(f, obj[f])) out[f] = obj[f] as number;
  }
  return out;
}

/**
 * Route-side strict parser (EC-5): every field must be present and in bounds,
 * otherwise a 400 with a message naming the field — never a silent default.
 */
export function parseKbAnalysisSettings(
  raw: unknown,
): { ok: true; value: KbAnalysisSettings } | { ok: false; error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "kbAnalysis must be an object { newEntriesThreshold, sessionsThreshold, maxAgeDays }" };
  }
  const obj = raw as Record<string, unknown>;
  const value = {} as KbAnalysisSettings;
  for (const f of FIELDS) {
    if (!inBounds(f, obj[f])) {
      const [min, max] = KB_ANALYSIS_BOUNDS[f];
      return { ok: false, error: `kbAnalysis.${f} must be an integer between ${min} and ${max}` };
    }
    value[f] = obj[f] as number;
  }
  return { ok: true, value };
}
