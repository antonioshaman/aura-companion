/**
 * ObserverFindingsBlock — renders a council observer's final reply in the
 * chat feed as severity cards instead of raw JSON.
 *
 * The observer reply contract (`.council/prompts/observer-system.md`) makes
 * the observer's final message a bare JSON array of findings. The server
 * consumes it for the review file; the chat feed used to show the raw JSON
 * string. `parseObserverFindingsMessage` recognises exactly that shape —
 * strict on the fields the contract mandates, returning `null` for anything
 * else so ordinary messages (including JSON-looking prose) fall back to the
 * markdown renderer unchanged.
 *
 * Severity hues come from `severityClass` — the single source of truth the
 * ObserverPanel's FindingsLog and BlockerBanner already share, so a STOP
 * looks the same in the feed, the log, and the banner.
 */

import { severityClass } from "../council/FindingsLog.js";

// The parser lives in a plain util (no React) so the feed's probe-span
// classifier can share the exact same "is this a findings reply" rule.
export { parseObserverFindingsMessage } from "../../utils/observer-findings.js";
export type { ParsedChatFinding } from "../../utils/observer-findings.js";
import type { ParsedChatFinding } from "../../utils/observer-findings.js";

function evidenceLabel(f: ParsedChatFinding): string | null {
  if (!f.evidence_path) return null;
  return f.evidence_lines ? `${f.evidence_path}:${f.evidence_lines[0]}–${f.evidence_lines[1]}` : f.evidence_path;
}

export function ObserverFindingsBlock({ findings }: { findings: ParsedChatFinding[] }) {
  if (findings.length === 0) {
    return (
      <div
        role="status"
        className="inline-flex items-center gap-2 text-[13px] text-cc-success bg-cc-success/10 border border-cc-success/30 rounded-lg px-3 py-1.5"
      >
        <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className="w-3.5 h-3.5">
          <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z" />
        </svg>
        <span>Observer review: no findings — clean</span>
      </div>
    );
  }
  return (
    <ul aria-label="Observer findings" className="space-y-2 list-none pl-0">
      {findings.map((f, i) => {
        const cls = severityClass(f.severity);
        const evidence = evidenceLabel(f);
        return (
          <li
            key={i}
            className="rounded-lg border border-cc-border bg-cc-code-bg/40 px-3 py-2 flex items-start gap-2.5"
          >
            <span className={`mt-1 w-2 h-2 rounded-full shrink-0 ${cls.dot}`} aria-hidden="true" />
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`text-[11px] font-semibold tracking-wide ${cls.text}`}>{cls.label}</span>
                {f.confidence ? (
                  <span className="text-[11px] text-cc-muted">confidence: {f.confidence}</span>
                ) : null}
              </div>
              <p className="text-[13px] text-cc-fg leading-relaxed mt-0.5 mb-0 break-words">{f.claim}</p>
              {evidence ? (
                <code className="text-[12px] font-mono-code text-cc-muted break-all">{evidence}</code>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
