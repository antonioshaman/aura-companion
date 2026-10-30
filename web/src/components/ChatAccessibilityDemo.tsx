import { useEffect, useState } from "react";
import { useChatAnnouncement } from "../use-chat-announcement.js";
import { useModalDialog } from "../use-modal-dialog.js";
import type { ChatMessage } from "../types.js";

/** Reproducible manual review: no model calls, PTYs or permission approvals. */
export function ChatAccessibilityDemo() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const announcement = useChatAnnouncement("playground-a11y", messages);
  const dialogRef = useModalDialog<HTMLDivElement>(open, () => setOpen(false));
  const streaming = messages.at(-1)?.isStreaming;
  useEffect(() => {
    if (!streaming) return;
    let step = 0;
    const parts = ["A short ", "A short streamed reply. ", "A short streamed reply. Your draft keeps its focus."];
    const timer = setInterval(() => {
      step++;
      setMessages((current) => [{ ...current[0], content: parts[Math.min(step, 2)], isStreaming: step < 2 }]);
    }, 1700);
    return () => clearInterval(timer);
  }, [streaming]);
  return (
    <div id="chat-a11y-review" className="space-y-3">
      <label className="block text-sm">Draft (kept while a reply arrives)
        <input aria-label="Review draft" value={draft} onChange={(event) => setDraft(event.target.value)} className="block w-full border border-cc-border bg-cc-input-bg rounded p-2 focus-visible:outline-2 focus-visible:outline-cc-focus" />
      </label>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={!!streaming} onClick={() => setMessages([{ id: String(Date.now()), role: "assistant", content: "A short ", isStreaming: true, timestamp: Date.now() }])} className="px-3 py-2 border border-cc-border rounded cursor-pointer">Simulate streamed reply</button>
        <button type="button" onClick={() => setOpen(true)} className="px-3 py-2 border border-cc-border rounded cursor-pointer">Test dialog keyboard</button>
      </div>
      <p className="text-sm">{messages.at(-1)?.content || "No reply yet."}</p>
      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">{announcement}</p>
      {open && <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center">
        <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Keyboard review" tabIndex={-1} className="max-w-sm p-5 rounded-xl border border-cc-border bg-cc-card space-y-3">
          <h2 className="text-base font-semibold">Keyboard review</h2>
          <p className="text-sm">Tab stays here. Escape closes this window and restores the opener. Your draft stays intact.</p>
          <input aria-label="Dialog test field" className="w-full bg-cc-input-bg border border-cc-border rounded p-2" />
          <button type="button" onClick={() => setOpen(false)} className="px-3 py-2 border border-cc-border rounded cursor-pointer">Close review dialog</button>
        </div>
      </div>}
    </div>
  );
}
