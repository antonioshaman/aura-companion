/**
 * Golden-task contract — the on-disk shape of a reproducible benchmark for a
 * known bug class (WebSocket regression, observer false STOP, Codex contract
 * break, session recovery). A task is authored as a YAML file under
 * `web/evals/tasks/` and re-run across Aura versions to measure whether a
 * given build still gets the case right.
 *
 * A task is pure DATA, never code: it names a `start_commit` to check out, the
 * `prompt` to drive the agent with, the `expected_files` it should touch, the
 * `expected_tests` that must end green, the `failure_modes` it must NOT exhibit,
 * and a `rubric` of weighted criteria for scoring the result. The harness reads
 * these; it does not execute arbitrary task logic.
 *
 * Versioning is independent of the sidecar/label formats (see eval-artifact.ts)
 * — golden tasks evolve on their own cadence as the bug corpus grows.
 *
 * Pure types + constants. No `server/` imports — this file lives inside the
 * eval import firewall.
 */

/**
 * Golden-task schema version. First field of every task file so a reader sees
 * the discriminator before any content. Bump ONLY on a breaking shape change;
 * additive fields do not bump (readers tolerate unknown extra keys).
 */
export const GOLDEN_TASK_VERSION = 1 as const;

/** A single weighted rubric criterion. `weight` is a positive number; the
 *  scorer normalizes across all criteria so absolute magnitudes don't matter. */
export interface GoldenTaskRubricCriterion {
  /** Stable id for cross-version diffing of per-criterion scores. */
  id: string;
  /** Human-readable description of what earns this criterion. */
  description: string;
  /** Relative weight (> 0). Normalized by the scorer. */
  weight: number;
}

export interface GoldenTask {
  /** MUST be the first field — schema discriminator. */
  golden_task_version: typeof GOLDEN_TASK_VERSION;
  /** Stable task id (filename stem is the conventional default). */
  id: string;
  /** One-line summary of the bug class this task pins. */
  title: string;
  /** Full-length git SHA to check out before driving the agent. */
  start_commit: string;
  /** The instruction handed to the agent under test. */
  prompt: string;
  /** Workspace-relative paths the correct fix is expected to touch. */
  expected_files: string[];
  /** Test selectors/paths that must end green for the task to pass. */
  expected_tests: string[];
  /** Named failure modes the result must NOT exhibit (regression canaries). */
  failure_modes: string[];
  /** Weighted scoring criteria. */
  rubric: GoldenTaskRubricCriterion[];
}

/**
 * Version guard used before structural parsing. An unknown version is a hard
 * reject — we author these in-repo, so a mismatch is a real incompatibility
 * the caller must opt into — distinct from unknown extra FIELDS which readers
 * tolerate (additive evolution).
 */
export function isSupportedGoldenTaskVersion(v: unknown): v is typeof GOLDEN_TASK_VERSION {
  return v === GOLDEN_TASK_VERSION;
}
