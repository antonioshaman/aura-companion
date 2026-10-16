import { OBSERVER_WAKE_TIMEOUT_MS } from "./council-types.js";
import { SilentStdioWatchdog } from "./silent-stdio-watchdog.js";

/**
 * W14 — observer wake silence detection (shared by the Codex and Claude
 * adapters).
 *
 * Incident 2026-10-16 12:01 (grp_879b81b6, codex observer 17fbf63f): the
 * observer accepted a wake (`turn/start` → `{status:"inProgress"}`) and then
 * NOT ONE frame reached the adapter. The app-server's own log
 * (`codex-home/<id>/logs_2.sqlite`) proves it ran the turn and emitted
 * `turn/started` … `turn/completed` (12:01:30, 27 s) to the connection, and
 * the WS proxy never logged a pong timeout or reconnect — the frames were lost
 * between the app-server and the adapter. Nothing noticed: the review
 * deadline degraded the pair after 5 min, the completion watchdog released
 * the slot after 6 min, and the pair stayed degraded until a manual relaunch.
 *
 * A healthy wake turn streams frames continuously: across the last 40 codex
 * observer recordings (3 611 inbound frames inside wake turns) the largest
 * gap between two frames was 35 s. So "no frame at all for
 * {@link OBSERVER_WAKE_SILENCE_MS}" is a reliable "this turn is lost" signal,
 * far earlier than the 5-minute review deadline.
 *
 * Default 120 s (≈3.4× the worst healthy gap), env-overridable through
 * `COMPANION_OBSERVER_WAKE_SILENCE_MS`, bounded to [30 s, review deadline −
 * 30 s] so the silence verdict always lands before the review deadline.
 */
export const OBSERVER_WAKE_SILENCE_DEFAULT_MS = 120_000;
export const OBSERVER_WAKE_SILENCE_MIN_MS = 30_000;
export const OBSERVER_WAKE_SILENCE_MAX_MS = OBSERVER_WAKE_TIMEOUT_MS - 30_000;

/**
 * Pure parse of the env override. Returns the default for absent / empty /
 * non-integer / out-of-bounds input; `onInvalid` fires only for a present but
 * rejected value.
 */
export function resolveObserverWakeSilenceMs(
  raw: string | undefined = process.env.COMPANION_OBSERVER_WAKE_SILENCE_MS,
  onInvalid?: (raw: string) => void,
): number {
  if (raw === undefined || raw.trim() === "") return OBSERVER_WAKE_SILENCE_DEFAULT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (
    !Number.isFinite(parsed) ||
    String(parsed) !== raw.trim() ||
    parsed < OBSERVER_WAKE_SILENCE_MIN_MS ||
    parsed > OBSERVER_WAKE_SILENCE_MAX_MS
  ) {
    onInvalid?.(raw);
    return OBSERVER_WAKE_SILENCE_DEFAULT_MS;
  }
  return parsed;
}

export const OBSERVER_WAKE_SILENCE_MS = resolveObserverWakeSilenceMs(undefined, (raw) => {
  console.warn(
    `[observer-wake-silence] COMPANION_OBSERVER_WAKE_SILENCE_MS=${raw} rejected (integer ms in ` +
      `[${OBSERVER_WAKE_SILENCE_MIN_MS}, ${OBSERVER_WAKE_SILENCE_MAX_MS}]); using ${OBSERVER_WAKE_SILENCE_DEFAULT_MS}ms`,
  );
});

/**
 * A {@link SilentStdioWatchdog} dedicated to observer wake turns: armed when
 * the wake is sent, slid forward by every inbound backend frame, disarmed
 * when the wake turn ends. Kept separate from the adapter's session-level
 * silence watchdog so an observer verdict never routes through the generic
 * kill-and-rotate-model path (`session:backend-silent`) — observer recovery
 * is owned by the council pipeline (degrade + auto-heal + redelivery).
 */
export function createObserverWakeSilenceWatchdog(
  onSilent: (info: { sinceMs: number; reason: string }) => void,
  opts?: { timeoutMs?: number; clock?: () => number },
): SilentStdioWatchdog {
  return new SilentStdioWatchdog({
    timeoutMs: opts?.timeoutMs ?? OBSERVER_WAKE_SILENCE_MS,
    onSilent,
    ...(opts?.clock ? { clock: opts.clock } : {}),
    setTimer: (fn, ms) => {
      const t = setTimeout(fn, ms);
      if (typeof t.unref === "function") t.unref();
      return t as unknown;
    },
  });
}
