/**
 * Label-queue triage (P3/FIX-B3-1) — who can judge a finding, and how.
 *
 * A flat TRUE/FALSE sheet over every observer finding proved useless to the
 * human: most claims are about code, and nobody can check "line 42 races"
 * without the code in front of them. So the queue is split by WHO can decide:
 *
 *   - `decision`   — the finding questions a product / policy choice (keep PII
 *                    or not, which role may self-serve, scope). Only a human
 *                    can answer; it is framed "now it is X → option A (keep) /
 *                    option B (adopt the observer's recommendation)".
 *   - `code-claim` — a factual claim about code or a document. The
 *                    orchestrator verifies it against the source at the
 *                    checkpoint; its labels carry their own source and are
 *                    reported apart from human labels.
 *   - `excluded`   — INFO or no checkable assertion: nothing to label.
 *
 * The classifier is a deliberately conservative keyword heuristic: anything
 * that is not clearly a decision stays a `code-claim`, because the
 * orchestrator can read code — the expensive mistake is sending a code
 * question to the human, not the reverse.
 *
 * Pure; firewall-clean (no `server/`, no disk).
 */

import type { ExtractedFinding } from "./scorers/findings-extractor.js";

export type TriageKind = "decision" | "code-claim" | "excluded";

export interface Triage {
  kind: TriageKind;
  /** Why this bucket — printed in the sheet so a misroute is visible. */
  reason: string;
}

/** Shorter than this, a claim cannot state a checkable fact. */
const MIN_CLAIM_CHARS = 20;

/**
 * Cues that the finding hinges on a choice, not a fact. Each names the kind
 * of decision so the sheet can say why the human got it.
 */
const DECISION_CUES: ReadonlyArray<[RegExp, string]> = [
  [/\b(PII|privacy|personal data|data minimi[sz]ation|retention)\b/i, "privacy / data policy"],
  [/\bproduct (decision|choice|call|question)\b/i, "product decision"],
  [/\b(business|pricing|commercial) (rule|decision|policy|model)\b/i, "business rule"],
  [/\b(self-service|allowlist|allow-list)\b.*\brole\b|\brole\b.*\b(self-service|allowlist|allow-list)\b/i, "access policy"],
  // Not bare "policy": it is a common code identifier (`tier-policy.ts`).
  [/\b(security|data|access|retention|privacy|product|business) policy\b|\btrade-?off\b/i, "policy / trade-off"],
  [/\b(decide|decision) (whether|if|between|on)\b|\bwhether (to|or not)\b/i, "open choice"],
  [/\b(the plan|the spec|it) (does not|doesn't|never) (say|decide|specify) (whether|which|if)\b/i, "unspecified choice"],
];

/** Assertion-free wording: a finding that only agrees, confirms or recaps. */
const NO_CLAIM = /^(looks good|lgtm|no (issues|findings|concerns)|nothing to (flag|report))\b/i;

export function classifyFinding(f: Pick<ExtractedFinding, "severity" | "claim">): Triage {
  const claim = f.claim.trim();
  if (f.severity === "INFO") return { kind: "excluded", reason: "INFO — no defect asserted" };
  if (claim.length < MIN_CLAIM_CHARS || NO_CLAIM.test(claim)) {
    return { kind: "excluded", reason: "no checkable assertion" };
  }
  for (const [re, why] of DECISION_CUES) {
    if (re.test(claim)) return { kind: "decision", reason: why };
  }
  return { kind: "code-claim", reason: "factual claim about code/docs — verifiable against the source" };
}

export interface DecisionFraming {
  /** What the observer says the state is now (first sentence of the claim). */
  now: string;
  /** Keep the current behaviour — the observer is wrong to object. */
  optionA: string;
  /** Adopt the observer's recommendation — the observer is right. */
  optionB: string;
}

const RECOMMEND = /\b(should|must|needs? to|recommend|consider|instead|require[sd]?)\b/i;

/**
 * Frame a decision as "now → A / B". Option B quotes the observer's own
 * recommendation sentence when there is one; otherwise it restates the claim
 * as the change to make. Sentence splitting is naive on purpose — the full
 * claim is always shown alongside.
 */
export function frameDecision(claim: string): DecisionFraming {
  const sentences = claim
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])\s+(?=[A-Z(`'"])/);
  const now = sentences[0] ?? claim;
  const rec = sentences.slice(1).find((s) => RECOMMEND.test(s));
  return {
    now,
    optionA: "Оставить как есть — текущее поведение задумано (observer ошибся).",
    optionB: rec
      ? `Изменить, как советует observer: ${rec}`
      : "Изменить — observer прав, это проблема.",
  };
}

export type LabelSource = "human" | "orchestrator" | "unknown";

/**
 * Who produced a label, from `labeled_by` (diet log) or `labeler` (ingest
 * log). Anything not self-identifying as human or orchestrator is `unknown`
 * — never silently promoted to human, since human labels are the only ones
 * that can prove the observer useful.
 */
export function labelSource(r: Record<string, unknown>): LabelSource {
  const by = typeof r.labeled_by === "string" ? r.labeled_by : typeof r.labeler === "string" ? r.labeler : "";
  if (/^human\b/i.test(by)) return "human";
  if (/^orchestrator\b/i.test(by)) return "orchestrator";
  return "unknown";
}
