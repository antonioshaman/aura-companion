/**
 * Observer findings reply parser — shared by the chat feed's card renderer
 * (`components/chat/ObserverFindingsBlock.tsx`) and the probe-span
 * classifier (`utils/observer-probe.ts`). See ObserverFindingsBlock for the
 * reply contract.
 */

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
