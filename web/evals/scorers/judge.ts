/**
 * Judge seam — the typed boundary an LLM-as-judge plugs into, plus the
 * DETERMINISTIC, zero-quota judges the harness ships and tests against.
 *
 * Why a seam and not a direct LLM call: an LLM judge costs subscription tokens
 * on every finding, so it can NEVER run in CI or by default — that would burn
 * the very budget this project exists to protect. Instead the contract is a
 * narrow interface ({@link Judge}); the harness's own code paths use only the
 * deterministic implementations below ({@link ScriptedJudge}, {@link
 * HeuristicJudge}). A real Claude/Codex judge is a SEPARATE, explicitly opt-in
 * adapter that implements this same interface and is wired only by a maintainer
 * running an off-CI calibration pass — it is intentionally not constructed
 * anywhere in this module.
 *
 * The judge's job is narrow: given ONE emitted observer finding (the model's
 * claim + where it points), decide whether that finding is a real problem
 * (`true_positive`), a false alarm (`false_positive`), or — when the evidence
 * is insufficient to decide — `skip`. `skip` is first-class: a judge that
 * abstains is honest, and calibration counts abstentions separately rather than
 * coercing them into a wrong verdict (absent-vs-zero, applied to verdicts).
 *
 * Pure + firewall-clean: imports only the eval schema's severity type. Never
 * `server/`. The deterministic judges use no clock, no randomness, no IO.
 */

import type { EvalFindingSeverity } from "../schema/eval-artifact.js";

/** A judge's verdict on a single finding. `true_positive`/`false_positive`
 *  mirror the human-label vocabulary so judge and human are directly
 *  comparable; `skip` is an explicit abstention (insufficient evidence). */
export type JudgeVerdict = "true_positive" | "false_positive" | "skip";

/** The minimal view of a finding a judge needs to render a verdict. */
export interface JudgeInput {
  /** The finding's stable extractor id (`efnd_<hex>`) — the calibration join key. */
  finding_id: string;
  /** The observer's claim, verbatim. */
  claim: string;
  /** Workspace-relative path the claim points at. */
  evidence_path: string;
  /** Severity as the observer emitted it (pre-grounding). */
  severity: EvalFindingSeverity;
  /** The observer's self-reported confidence, when present. */
  confidence?: "high" | "medium" | "low";
  /** Optional source excerpt at the evidence path, when the caller has it. */
  evidence_excerpt?: string;
}

export interface JudgeResult {
  finding_id: string;
  verdict: JudgeVerdict;
  /** Optional free-text reason — for human audit only, never parsed. */
  rationale?: string;
}

/**
 * The boundary a judge implements. Async because a real LLM judge does IO; the
 * deterministic judges resolve immediately. A judge MUST be a pure function of
 * its input for a given instance — same input, same verdict — so a calibration
 * run is reproducible.
 */
export interface Judge {
  /** Stable identifier for the judge, recorded on calibration output. */
  readonly id: string;
  judge(input: JudgeInput): Promise<JudgeResult>;
}

/**
 * A judge whose verdicts come from a fixed `finding_id → verdict` map. This is
 * the workhorse for tests and for replaying a captured judge transcript without
 * re-spending tokens: freeze a real judge's verdicts once, then calibrate
 * deterministically forever. Unmapped findings resolve to `skip` (the judge was
 * never asked about them) rather than guessing.
 */
export class ScriptedJudge implements Judge {
  readonly id: string;
  private readonly verdicts: ReadonlyMap<string, JudgeVerdict>;

  constructor(verdicts: Record<string, JudgeVerdict> | ReadonlyMap<string, JudgeVerdict>, id = "scripted") {
    this.id = id;
    this.verdicts =
      verdicts instanceof Map ? verdicts : new Map(Object.entries(verdicts));
  }

  judge(input: JudgeInput): Promise<JudgeResult> {
    const verdict = this.verdicts.get(input.finding_id) ?? "skip";
    return Promise.resolve({ finding_id: input.finding_id, verdict });
  }
}

/**
 * A trivial deterministic heuristic judge — NOT a quality oracle, a baseline.
 * It confirms a finding as `true_positive` only when the observer itself was
 * `high` confidence, treats `low` confidence as a `false_positive`, and
 * `skip`s everything in between. Its value is as a zero-quota floor: any real
 * LLM judge must calibrate measurably better than "just trust high-confidence
 * STOPs", or it is not earning its token cost.
 */
export class HeuristicJudge implements Judge {
  readonly id = "heuristic-confidence";

  judge(input: JudgeInput): Promise<JudgeResult> {
    let verdict: JudgeVerdict = "skip";
    if (input.confidence === "high") verdict = "true_positive";
    else if (input.confidence === "low") verdict = "false_positive";
    return Promise.resolve({
      finding_id: input.finding_id,
      verdict,
      rationale: `confidence=${input.confidence ?? "unknown"}`,
    });
  }
}

/** Run a judge over many findings in input order, preserving determinism. */
export async function runJudge(judge: Judge, inputs: JudgeInput[]): Promise<JudgeResult[]> {
  const out: JudgeResult[] = [];
  for (const input of inputs) {
    out.push(await judge.judge(input));
  }
  return out;
}
