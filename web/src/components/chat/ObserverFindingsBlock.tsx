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

export interface ParsedChatFinding {
  severity: "STOP" | "WARN" | "NOTE" | "INFO";
  claim: string;
  evidence_path?: string;
  evidence_lines?: [number, number];
  confidence?: "high" | "medium" | "low";
}

const SEVERITIES = new Set(["STOP", "WARN", "NOTE", "INFO"]);
const CONFIDENCES = new Set(["high", "medium", "low"]);

/**
 * Parse an assistant message as an observer findings array. Returns the
 * findings (possibly empty — an empty array is a complete "review clean"
 * reply per the contract) or `null` when the text is not a findings reply.
 *
 * Strictness is the false-positive guard: every element must be an object
 * with a valid `severity` and a non-empty string `claim`; optional fields
 * must have the contract shape when present. One bad element rejects the
 * whole message — half-findings render better as raw text than as a
 * truncated card list.
 */
export function parseObserverFindingsMessage(text: string): ParsedChatFinding[] | null {
  const trimmed = text.trim();
  // Cheap gate before JSON.parse — the vast majority of chat messages.
  if (!trimmed.startsWith("[")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: ParsedChatFinding[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
    const f = item as Record<string, unknown>;
    if (typeof f.severity !== "string" || !SEVERITIES.has(f.severity)) return null;
    if (typeof f.claim !== "string" || f.claim.trim().length === 0) return null;
    if (f.evidence_path !== undefined && typeof f.evidence_path !== "string") return null;
    if (f.confidence !== undefined && (typeof f.confidence !== "string" || !CONFIDENCES.has(f.confidence))) return null;
    const lines = f.evidence_lines;
    if (
      lines !== undefined &&
      !(Array.isArray(lines) && lines.length === 2 && lines.every((n) => typeof n === "number" && Number.isFinite(n)))
    ) {
      return null;
    }
    out.push({
      severity: f.severity as ParsedChatFinding["severity"],
      claim: f.claim,
      ...(typeof f.evidence_path === "string" && f.evidence_path.length > 0
        ? { evidence_path: f.evidence_path }
        : {}),
      ...(lines !== undefined ? { evidence_lines: lines as [number, number] } : {}),
      ...(typeof f.confidence === "string" ? { confidence: f.confidence as ParsedChatFinding["confidence"] } : {}),
    });
  }
  return out;
}

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
