/**
 * Codex quota guard for the AuraBench driver (P6/FIX-CODEX-QUOTA).
 *
 * On 2026-10-01 the bench (B, F, G, H) used up the weekly Codex/ChatGPT quota
 * that prod's Codex observers share, and kept burning H cells as
 * `observer_dead` afterwards. Unlike Claude, the Codex quota is not exposed by
 * any loopback API here, so the bench cannot hold at a utilization ceiling.
 * Instead:
 *
 *  - a daily budget of Codex cell STARTS (env `AURABENCH_CODEX_DAILY_CELLS`,
 *    default {@link DEFAULT_CODEX_DAILY_CELLS}; invalid → default, never
 *    "unlimited"; `0` = no Codex cells at all), counted over a rolling 24 h
 *    from a ledger file that survives restarts and is shared by every runner
 *    pointed at it (env `AURABENCH_CODEX_LEDGER`). Starts, not records: a
 *    retried / limit-hit cell spent quota too;
 *  - a Codex usage-limit answer pauses ALL Codex cells until its reset (the
 *    driver keeps running the Claude-only cells meanwhile).
 *
 * Pure except the ledger helpers (injected fs). Firewall-clean.
 */

import { VARIANTS, type VariantId } from "./variants.js";

export const DEFAULT_CODEX_DAILY_CELLS = 12;
export const CODEX_WINDOW_MS = 24 * 3_600_000;

/** The variant spends Codex quota: Codex primary (B/F/G) or a Codex observer (H). */
export function variantUsesCodex(id: VariantId): boolean {
  const v = VARIANTS[id];
  return v.provider === "codex" || (v.mode === "aura" && v.councilPairing === "claude+codex");
}

/** A non-negative integer; anything else (unset, "", "abc", -1, 2.5) → default. */
export function codexDailyCellsFromEnv(env: Record<string, string | undefined>): number {
  const raw = env.AURABENCH_CODEX_DAILY_CELLS;
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return DEFAULT_CODEX_DAILY_CELLS;
  return Number(raw.trim());
}

/** Ledger = one epoch-ms per line. Torn / non-numeric lines are ignored. */
export function parseCodexLedger(text: string): number[] {
  const out: number[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (/^\d{10,}$/.test(t)) out.push(Number(t));
  }
  return out;
}

/**
 * When the next Codex cell may start under a budget of `cap` starts per
 * rolling 24 h: `now` if under budget, else the instant the oldest start in
 * the window ages out. `cap = 0` → never (Infinity).
 */
export function codexBudgetOpensAt(starts: readonly number[], cap: number, now: number): number {
  if (cap <= 0) return Number.POSITIVE_INFINITY;
  const inWindow = starts.filter((t) => t > now - CODEX_WINDOW_MS && t <= now).sort((a, b) => a - b);
  if (inWindow.length < cap) return now;
  return inWindow[inWindow.length - cap]! + CODEX_WINDOW_MS;
}
