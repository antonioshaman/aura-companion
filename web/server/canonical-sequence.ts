/**
 * Canonical Orchestrator skill sequence — the 9 steps the orchestrator
 * half of a Council Mode pair runs through, in order.
 *
 * Story 1.1 (council-mode-bidirectional-pipeline): "Given a fresh Council
 * Mode pair, when the Orchestrator first activates, then its first
 * message names the 9 sequence steps in order with brief intent."
 *
 * This is a frozen exported array — single source of truth for any
 * downstream consumer (orchestrator-system-prompt loader [deferred],
 * UI start banner, audit log, future structured WARN detector for
 * out-of-sequence skill invocations). Tests assert deep-equality against
 * this constant, not substring; substring matches false-pass on
 * reordering or step drops.
 *
 * The sequence intent column intentionally short (≤80 chars/step) so a
 * start-of-session banner stays readable.
 */

export interface OrchestratorSequenceStep {
  readonly index: number;
  readonly slug: string;
  readonly intent: string;
}

export const CANONICAL_ORCHESTRATOR_SEQUENCE: readonly OrchestratorSequenceStep[] = Object.freeze([
  { index: 1, slug: "/prime", intent: "Load relevant knowledge before starting work." },
  { index: 2, slug: "/spec-writer", intent: "Generate a structured spec from the feature concept." },
  { index: 3, slug: "/council-plan", intent: "Architect the feature with the council before writing code." },
  { index: 4, slug: "/council-implement", intent: "Execute the plan task by task, verifying after each." },
  { index: 5, slug: "/council-review", intent: "Rigorous code review producing prioritised findings." },
  { index: 6, slug: "/test-architect", intent: "Map testable surfaces; audit + specify tests (anytime)." },
  { index: 7, slug: "/self-improvement", intent: "Capture learnings, errors, corrections." },
  { index: 8, slug: "/learn", intent: "Quick-capture a learning mid-session without breaking flow." },
  { index: 9, slug: "/self-reflect", intent: "End-of-session reflection; consolidate + prune knowledge." },
]);

/** Number of canonical steps — for length assertions in tests. */
export const CANONICAL_SEQUENCE_LENGTH = CANONICAL_ORCHESTRATOR_SEQUENCE.length;
