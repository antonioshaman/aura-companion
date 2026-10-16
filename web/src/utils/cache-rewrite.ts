/**
 * W7(b) — estimate how many prompt tokens a cold cache would make the next
 * request write again. Inputs come from session state maintained by the
 * server (ws-bridge / codex-adapter):
 *  - `last_context_tokens`: full prompt of the main thread's last request
 *    (cached + uncached + cache write — backend-neutral);
 *  - `last_turn_completed_at`: when the last turn that reached the model ended.
 *
 * Thresholds: Claude Code's subscription prompt cache keeps entries for up
 * to an hour; past that a resumed turn re-writes the whole prefix. Small
 * contexts are not worth a hint.
 */
export const CACHE_HINT_IDLE_MINUTES = 60;
export const CACHE_HINT_MIN_TOKENS = 20_000;

export interface CacheHintState {
  last_context_tokens?: number;
  last_turn_completed_at?: number;
}

export function estimateIdleCacheRewrite(
  state: CacheHintState | undefined,
  now: number,
): { tokens: number; idleMinutes: number } | null {
  const tokens = state?.last_context_tokens;
  const at = state?.last_turn_completed_at;
  if (typeof tokens !== "number" || typeof at !== "number") return null;
  if (tokens < CACHE_HINT_MIN_TOKENS) return null;
  const idleMinutes = Math.floor((now - at) / 60_000);
  if (idleMinutes < CACHE_HINT_IDLE_MINUTES) return null;
  return { tokens, idleMinutes };
}

export function estimateModelSwitchCacheRewrite(state: CacheHintState | undefined): { tokens: number } | null {
  const tokens = state?.last_context_tokens;
  if (typeof tokens !== "number" || tokens < CACHE_HINT_MIN_TOKENS) return null;
  return { tokens };
}

export function formatIdleGap(minutes: number): string {
  if (minutes < 120) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} ч`;
  return `${Math.floor(hours / 24)} дн`;
}
