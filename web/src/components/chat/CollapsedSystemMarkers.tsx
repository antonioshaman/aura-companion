import { useState } from "react";
import { RESUME_INTERRUPTED_LABEL } from "../../utils/resume-interrupted.js";

export interface CollapsedSystemMarkerItem {
  id: string;
  content: string;
  timestamp: number;
  systemVariant: "resume-interrupted" | "drift-recovery";
}

/**
 * A run of 2+ consecutive restart/drift-recovery system markers — the
 * `--resume` bookkeeping note from `utils/resume-interrupted.ts` and the
 * silent-stdio drift-recovery notice from `server/session-recovery.ts` /
 * `utils/drift-recovery-message.ts` — collapsed into one row. A long-lived
 * session can collect 15+ of these back to back; shown individually they are
 * pure noise (W16).
 *
 * `MessageFeed.tsx` only builds this group for a run of 2+ such markers with
 * nothing else (no user/assistant content, no unrelated system line) between
 * them — a lone marker renders exactly as before via `MessageBubble`.
 *
 * Collapsed by default; expands to the individual markers with their
 * timestamps. Uses a real `<button>` (not `<details>`/`<summary>`) so
 * `aria-expanded` is explicit and Enter/Space toggle it without depending on
 * cross-browser `<details>` a11y behaviour — matches the toggle pattern
 * already used by `ToolMessageGroup` / `ToolAuthErrorBlock` in
 * `MessageBubble.tsx`.
 */
export function CollapsedSystemMarkers({ items }: { items: CollapsedSystemMarkerItem[] }) {
  const [open, setOpen] = useState(false);
  const count = items.length;

  return (
    <div className="py-1 min-w-0" data-testid="collapsed-system-markers">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-3 w-full min-w-0 cursor-pointer text-left"
      >
        <span className="shrink-0 flex-1 h-px bg-cc-border" aria-hidden="true" />
        <span className="text-[11px] text-cc-muted italic font-mono-code px-1 min-w-0 break-words text-center">
          Interrupted ×{count}
          <span className="not-italic ml-1" aria-hidden="true">{open ? "▾" : "▸"}</span>
        </span>
        <span className="shrink-0 flex-1 h-px bg-cc-border" aria-hidden="true" />
      </button>
      {open && (
        <ul className="mt-1 space-y-1 list-none" data-testid="collapsed-system-markers-list">
          {items.map((item) => (
            <li
              key={item.id}
              className="flex items-center justify-center gap-2 text-[11px] text-cc-muted font-mono-code text-center break-words"
            >
              <span className="text-cc-muted/50 tabular-nums shrink-0">
                {new Date(item.timestamp).toLocaleTimeString()}
              </span>
              <span className="min-w-0 break-words">
                {item.systemVariant === "resume-interrupted" ? RESUME_INTERRUPTED_LABEL : item.content}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
