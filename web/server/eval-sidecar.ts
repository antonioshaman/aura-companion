/**
 * Eval sidecar emitter — the opt-in bridge from the live council pipeline to
 * the post-hoc Evaluator. On each observer review, when (and only when)
 * `COMPANION_EVAL_SIDECAR` is enabled, this freezes the grounding gate's
 * INPUTS that the WebSocket recording does NOT capture — the raw pre-grounding
 * findings, the manifest partition that WAS the modified set, and the per-path
 * existence answers the gate consulted — into `.council/eval/<checkpoint>.json`.
 *
 * Why freeze inputs rather than the grounding RESULT: the harness's
 * grounding-rerun oracle must RECOMPUTE the downgrade set from these inputs and
 * compare it to the recorded one. Freezing the existence answers is what makes
 * that rerun hermetic — it never re-stats a disk that has drifted since review
 * time. The recorded downgrades are kept only as the expectation to diff
 * against, never as truth.
 *
 * Fail-closed + isolated: default OFF; every failure is swallowed with a
 * structured EC-9 log so a sidecar problem can NEVER break the live review
 * fanout. This is a diagnostics side-channel, not a load-bearing path.
 *
 * Direction note: server → evals is the ALLOWED import direction. The firewall
 * only forbids evals → server (so portable scorers stay decoupled from server
 * internals); this emitter is server code consuming the eval schema.
 */

import { join } from "node:path";
import { writeAtomicJson } from "./atomic-write.js";
import { log } from "./logger.js";
import type { GroundingResult } from "./observer-grounding.js";
import type { ObserverReviewPayload } from "./council-types.js";
import {
  EVAL_ARTIFACT_VERSION,
  EVAL_SIDECAR_MAX_BYTES,
  type EvalRawFinding,
  type EvalSidecarArtifact,
} from "../evals/schema/eval-artifact.js";
import { existsWithinWorkspace, isEvalSlug } from "../evals/schema/eval-paths.js";

/**
 * Opt-in, default OFF. Mirrors `isRecordingHubEnabled`'s strict parse — only
 * the literal "1"/"true" enable it, so a typo'd value fails CLOSED (no sidecar)
 * rather than silently writing diagnostic artifacts an operator didn't ask for.
 */
export function isEvalSidecarEnabled(): boolean {
  const env = process.env.COMPANION_EVAL_SIDECAR;
  return env === "1" || env === "true";
}

export interface EmitEvalSidecarArgs {
  workspaceRoot: string;
  sessionGroupId: string;
  /** The review exactly as the observer emitted it (raw findings live here). */
  payload: ObserverReviewPayload;
  /** Manifest partition the observer reviewed; `delta` doubles as the modified
   *  set the grounding gate used. */
  manifest: { delta: string[]; carried: string[]; dropped: string[] };
  /** Grounding result whose downgrades are frozen for diffing (NOT trusted by
   *  the rerun, which recomputes). */
  grounding: GroundingResult;
  /** Hash of the observer system prompt at spawn — cohorting field. */
  observerPromptSha256: string;
}

/** Sort + de-dup a path list so two semantically-identical sidecars serialize
 *  byte-identically (stable diffs across Aura versions). */
function sortedUnique(paths: string[]): string[] {
  return [...new Set(paths)].sort();
}

/**
 * Emit the eval sidecar for one review — gated, hermetic-input-freezing, and
 * fully self-contained in its error handling. A no-op when the flag is off or
 * the checkpoint id can't form a safe filename. NEVER throws to the caller.
 */
export function maybeEmitEvalSidecar(args: EmitEvalSidecarArgs): void {
  if (!isEvalSidecarEnabled()) return;
  const { workspaceRoot, sessionGroupId, payload, manifest, grounding, observerPromptSha256 } = args;
  try {
    // The checkpoint id becomes a filename — reject anything that isn't a
    // strict single-segment slug rather than risk a path-traversal write.
    if (!isEvalSlug(payload.checkpoint_id)) {
      log.warn("eval-sidecar", "skipped: unsafe checkpoint id", {
        event: "council.eval.sidecar.skipped_unsafe_id",
        sessionGroupId,
        checkpointId: payload.checkpoint_id,
      });
      return;
    }

    const raw_findings: EvalRawFinding[] = payload.findings.map((f) => ({
      severity: f.severity,
      claim: f.claim,
      evidence_path: f.evidence_path,
      ...(f.evidence_lines !== undefined ? { evidence_lines: f.evidence_lines } : {}),
      ...(f.confidence !== undefined ? { confidence: f.confidence } : {}),
    }));

    // Freeze existence for every distinct evidence_path, in sorted-key order so
    // the serialized object is byte-stable. Uses the eval path helper, which
    // mirrors the grounding gate's own realpath+bounds check — so the frozen
    // answer matches what the gate consulted at review time.
    const existence_by_path: Record<string, boolean> = {};
    for (const p of sortedUnique(payload.findings.map((f) => f.evidence_path))) {
      existence_by_path[p] = existsWithinWorkspace(workspaceRoot, p);
    }

    const artifact: EvalSidecarArtifact = {
      eval_artifact_version: EVAL_ARTIFACT_VERSION,
      session_group_id: sessionGroupId,
      checkpoint_id: payload.checkpoint_id,
      phase: payload.phase,
      observer_provider: payload.observer_provider,
      observer_model: payload.observer_model,
      observer_cli_version: payload.observer_cli_version,
      observer_prompt_sha256: observerPromptSha256,
      // Server clock, NOT the model's self-reported time — observer-written
      // timestamps have been observed hallucinated (see council memory).
      emitted_at: new Date().toISOString(),
      manifest_partition: {
        delta: sortedUnique(manifest.delta),
        carried: sortedUnique(manifest.carried),
        dropped: sortedUnique(manifest.dropped),
      },
      raw_findings,
      grounding_downgrades: grounding.downgrades.map((d) => ({
        index: d.index,
        original_severity: d.original.severity,
        reason: d.reason,
      })),
      grounding_inputs: { existence_by_path },
    };

    const target = join(workspaceRoot, ".council", "eval", `${payload.checkpoint_id}.json`);
    // Explicit larger cap — the sidecar embeds the raw review + partition and
    // would throw against the smaller council-artifact default.
    writeAtomicJson(target, artifact, { maxBytes: EVAL_SIDECAR_MAX_BYTES });
  } catch (err) {
    log.error("eval-sidecar", "sidecar write failed", {
      event: "council.eval.sidecar.write_failed",
      sessionGroupId,
      checkpointId: payload.checkpoint_id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
