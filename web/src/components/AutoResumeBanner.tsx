/**
 * AutoResumeBanner — subtle info notice shown in a session that stopped on a
 * usage limit while Aura has a one-shot auto-resume scheduled:
 *
 *   "Лимит до 15:00 — автопродолжение в 15:01  [Отменить]"
 *
 * Times are rendered in the browser's local zone; a date is added when the
 * moment is not today (weekly limits). When the reset time was unknown
 * (`resetSource: "fallback"`) the copy says so instead of inventing a time.
 * When the server PAUSED auto-resume (two resumes in a row ran straight back
 * into the limit) the copy says the limit is still active and nothing more
 * will be sent automatically; the button just dismisses the notice.
 *
 * Info palette (`cc-info`), not warning: nothing is broken, the session will
 * continue by itself. Works the same for Claude Code and Codex sessions.
 */
import { useMemo } from "react";

export interface AutoResumeBannerProps {
  /** Epoch ms when the usage limit resets. */
  resetAt: number;
  /** Epoch ms when the continuation prompt will be sent. */
  fireAt: number;
  resetSource?: string;
  /** Cancel the scheduled resume. */
  onCancel: () => void;
  /** True while the cancel request is in flight. */
  cancelling?: boolean;
  /** Auto-resume paused by the server's repeat-limit guard. */
  paused?: boolean;
  /** Clock seam for tests / Playground (defaults to Date.now()). */
  now?: number;
}

function formatMoment(ms: number, now: number): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  const today = new Date(now);
  const sameDay =
    d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  if (sameDay) return time;
  const date = d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
  return `${date}, ${time}`;
}

export function AutoResumeBanner({ resetAt, fireAt, resetSource, onCancel, cancelling = false, paused = false, now }: AutoResumeBannerProps) {
  const reference = now ?? Date.now();
  const text = useMemo(() => {
    if (paused) {
      return "Лимит всё ещё активен — автопродолжение приостановлено. Напишите сообщение, когда лимит сбросится.";
    }
    const fire = formatMoment(fireAt, reference);
    if (resetSource === "fallback") {
      return `Лимит исчерпан, время сброса неизвестно — автопродолжение в ${fire}`;
    }
    return `Лимит до ${formatMoment(resetAt, reference)} — автопродолжение в ${fire}`;
  }, [resetAt, fireAt, resetSource, reference, paused]);

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="auto-resume-banner"
      className="px-3 py-2 border-b border-cc-info/20 bg-cc-info/8 flex items-center gap-2 animate-[fadeSlideIn_0.2s_ease-out]"
    >
      <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5 text-cc-info shrink-0" aria-hidden="true">
        <path
          fillRule="evenodd"
          d="M10 18a8 8 0 100-16 8 8 0 000 16zm.75-12.25a.75.75 0 00-1.5 0V10c0 .2.08.39.22.53l2.5 2.5a.75.75 0 101.06-1.06l-2.28-2.28V5.75z"
          clipRule="evenodd"
        />
      </svg>
      <span className="flex-1 min-w-0 text-xs text-cc-fg/85">{text}</span>
      <button
        type="button"
        onClick={onCancel}
        disabled={cancelling}
        className="text-xs text-cc-muted hover:text-cc-fg cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
      >
        {paused ? "Скрыть" : "Отменить"}
      </button>
    </div>
  );
}
