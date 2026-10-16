import { useEffect, useState } from "react";
import { useStore } from "../store.js";
import { formatTokenCount } from "../utils/format.js";
import {
  estimateIdleCacheRewrite,
  estimateModelSwitchCacheRewrite,
  formatIdleGap,
} from "../utils/cache-rewrite.js";

export interface CacheRewriteHintProps {
  sessionId: string;
  /**
   * `idle` — composing after the prompt cache likely expired (>60 min pause).
   * `model-switch` — shown inside the model picker: switching rebuilds the cache.
   */
  reason: "idle" | "model-switch";
  className?: string;
}

/** Wall clock that re-renders once a minute — enough resolution for a 60 min TTL. */
function useMinuteClock(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, [enabled]);
  return now;
}

/**
 * W7(b) — subtle, non-blocking prompt-cache hint. Estimates how many tokens
 * the next request will write to the cache again (last known full prompt of
 * the session's main thread). Plain muted text: informs, never gates input.
 * Works for both backends — the server normalises Claude and Codex usage.
 */
export function CacheRewriteHint({ sessionId, reason, className }: CacheRewriteHintProps) {
  const lastContextTokens = useStore((s) => s.sessions.get(sessionId)?.last_context_tokens);
  const lastTurnCompletedAt = useStore((s) => s.sessions.get(sessionId)?.last_turn_completed_at);
  const now = useMinuteClock(reason === "idle");
  const state = { last_context_tokens: lastContextTokens, last_turn_completed_at: lastTurnCompletedAt };

  let text: string | null = null;
  if (reason === "idle") {
    const est = estimateIdleCacheRewrite(state, now);
    if (est) {
      text = `Кеш истёк (пауза ${formatIdleGap(est.idleMinutes)}): ≈${formatTokenCount(est.tokens)} токенов будут записаны заново`;
    }
  } else {
    const est = estimateModelSwitchCacheRewrite(state);
    if (est) {
      text = `Смена модели сбросит кеш: ≈${formatTokenCount(est.tokens)} токенов будут записаны заново`;
    }
  }
  if (!text) return null;

  return (
    <p
      data-testid="cache-rewrite-hint"
      className={`text-[11px] leading-snug text-cc-muted ${className ?? ""}`}
      title="Оценка по размеру контекста последнего запроса. Повторная запись кеша дороже чтения из него."
    >
      {text}
    </p>
  );
}
