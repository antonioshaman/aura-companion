/**
 * ObserverProbeMessage — observer rigor (2026-10-16).
 *
 * A liveness probe sent to the council observer ("[liveness probe] …") and
 * the observer's reply to it are probe traffic, not observer output. Observed
 * live 2026-10-15: the reply "Я Observer, независимый ревьюер Council…"
 * appeared as ordinary prose between the observer's findings cards. In the
 * observer's chat both are rendered as this collapsed row; the full text is
 * one click away.
 */

import { useId, useState } from "react";

export interface ObserverProbeMessageProps {
  /** `user` = the probe itself, `assistant` = the observer's reply. */
  role: "user" | "assistant";
  text: string;
}

const PREVIEW_CHARS = 80;

export function ObserverProbeMessage({ role, text }: ObserverProbeMessageProps) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const label = role === "user" ? "Проба связи" : "Ответ на пробу";
  const oneLine = text.replace(/\s+/g, " ").trim();
  const preview = oneLine.length > PREVIEW_CHARS ? `${oneLine.slice(0, PREVIEW_CHARS)}…` : oneLine;
  return (
    <div
      data-testid="observer-probe-message"
      data-role={role}
      className="my-1 mx-auto max-w-3xl px-3 py-1.5 rounded-md border border-dashed border-cc-border text-[12px] text-cc-muted"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        {...(open ? { "aria-controls": bodyId } : {})}
        className="w-full flex items-center gap-2 text-left cursor-pointer hover:text-cc-fg"
      >
        <span className="shrink-0 text-[10px] uppercase tracking-wider font-mono-code">{label}</span>
        <span className="min-w-0 flex-1 truncate">{preview}</span>
        <span aria-hidden="true">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div id={bodyId} className="mt-1.5 whitespace-pre-wrap text-cc-fg break-words">
          {text}
        </div>
      )}
    </div>
  );
}
