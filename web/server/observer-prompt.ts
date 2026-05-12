/**
 * Loader for the observer system-prompt artifact and pure helper to build
 * the per-checkpoint context manifest the observer half consumes.
 *
 * The system prompt is an external artifact (`.council/prompts/observer-system.md`)
 * intentionally CLI-agnostic — both `claude+claude` and `claude+codex` pairings
 * load the same file. No Anthropic-specific tool-call conventions, no
 * Claude-specific "think step by step" cues; the whole value of the mixed
 * pairing is failure-mode independence, which a Claude-shaped prompt erases.
 *
 * The artifact carries a versioned sentinel header so a future schema change
 * (v1 → v2 prompt format) goes red at load rather than silently changing
 * observer behaviour. The body is hashed at load time so the recorder can
 * tag every observer invocation with the prompt revision that produced it
 * — forensic re-run depends on knowing which prompt the model saw.
 */

import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

export const OBSERVER_PROMPT_SCHEMA_VERSION = 1 as const;

/** Hard size cap. The prompt is supposed to be a focused role definition,
 *  not a context-window-eating manifesto. 64 KiB is generous; reject larger. */
export const OBSERVER_PROMPT_MAX_BYTES = 64 * 1024;

/** Required minimum body length after the header line. A "prompt" of one
 *  word is almost certainly a botched file write — fail loudly. */
const OBSERVER_PROMPT_MIN_BODY_BYTES = 256;

/** First line of the prompt artifact. Pinned shape — a regex bump here
 *  forces an explicit prompt-format version bump, not a silent drift. */
const HEADER_PATTERN = /^<!-- observer-system-prompt v(\d+) -->\s*$/;

export interface ObserverPromptArtifact {
  /** Parsed schema version from the header sentinel. */
  version: number;
  /** Full file body including the header line. This is what the observer SDK receives. */
  body: string;
  /** SHA-256 of the body, hex-encoded. Used by the recorder to tag invocations. */
  sha256: string;
  /** Absolute filesystem path the artifact was loaded from. Informational. */
  sourcePath: string;
}

/**
 * Pure: extract the schema version from the artifact's first line.
 * Returns the parsed integer when the header matches, `null` otherwise.
 *
 * Exported so callers (and Beck F4 tests) can exercise both branches —
 * malformed-header and well-formed-header — without filesystem access.
 */
export function parseObserverPromptHeader(raw: string): number | null {
  const firstLine = raw.split("\n", 1)[0] ?? "";
  const m = HEADER_PATTERN.exec(firstLine);
  if (!m) return null;
  const v = Number.parseInt(m[1]!, 10);
  if (!Number.isInteger(v) || v <= 0) return null;
  return v;
}

/**
 * Load and validate the observer system-prompt artifact from `sourcePath`.
 *
 * Throws on missing file, oversize body, missing or unsupported header
 * version, body shorter than `OBSERVER_PROMPT_MIN_BODY_BYTES`. The throw
 * path is the contract — a silent fallback prompt would mean the model
 * loaded "something" that may not match the schema the rest of the
 * pipeline assumes.
 *
 * `sourcePath` must be absolute — relative paths are a misconfiguration
 * vector (relative to *what*? process cwd is unstable).
 */
export function loadObserverSystemPrompt(sourcePath: string): ObserverPromptArtifact {
  if (typeof sourcePath !== "string" || sourcePath.length === 0 || sourcePath.includes("\0")) {
    throw new Error("observer-prompt: invalid sourcePath");
  }
  if (!isAbsolute(sourcePath)) {
    throw new Error("observer-prompt: sourcePath must be absolute");
  }

  // Pre-check size via stat — avoids reading a multi-megabyte file just
  // to reject it on the byte-count test below.
  let size: number;
  try {
    size = statSync(sourcePath).size;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`observer-prompt: cannot stat ${sourcePath}: ${detail}`);
  }
  if (size > OBSERVER_PROMPT_MAX_BYTES) {
    throw new Error(
      `observer-prompt: ${sourcePath} is ${size} bytes, exceeds OBSERVER_PROMPT_MAX_BYTES (${OBSERVER_PROMPT_MAX_BYTES})`,
    );
  }

  const body = readFileSync(sourcePath, "utf-8");
  const byteLen = Buffer.byteLength(body, "utf8");
  if (byteLen > OBSERVER_PROMPT_MAX_BYTES) {
    throw new Error(
      `observer-prompt: body is ${byteLen} bytes (after read), exceeds OBSERVER_PROMPT_MAX_BYTES`,
    );
  }
  if (byteLen < OBSERVER_PROMPT_MIN_BODY_BYTES) {
    throw new Error(
      `observer-prompt: body is ${byteLen} bytes, below minimum (${OBSERVER_PROMPT_MIN_BODY_BYTES}) — file likely truncated`,
    );
  }

  const version = parseObserverPromptHeader(body);
  if (version === null) {
    throw new Error(`observer-prompt: missing or malformed header in ${sourcePath} (expected '<!-- observer-system-prompt vN -->')`);
  }
  if (version !== OBSERVER_PROMPT_SCHEMA_VERSION) {
    throw new Error(
      `observer-prompt: header version ${version} does not match supported version ${OBSERVER_PROMPT_SCHEMA_VERSION}`,
    );
  }

  const sha256 = createHash("sha256").update(body, "utf8").digest("hex");

  return { version, body, sha256, sourcePath };
}

// ── Per-checkpoint context manifest ─────────────────────────────────────────

export interface CheckpointArtifactPathSource {
  /** Workspace-relative paths the writer listed for this checkpoint. */
  readonly artifact_paths: readonly string[];
}

export interface ObserverContextManifest {
  /** Paths the observer should read this cycle — present in current but not previous. */
  delta: string[];
  /** Paths carried over from previous checkpoint. Observer MAY re-read for cross-cut checks. */
  carried: string[];
  /** Paths dropped from scope this cycle. Observer MUST NOT re-read these. */
  dropped: string[];
}

/**
 * Pure: compute the delta/carried/dropped partition of artifact paths
 * between the current checkpoint and the previous one.
 *
 * The plan task says: *"observer receives only the artifacts that changed
 * since the previous checkpoint, NOT the cumulative `.council/`+`specs/`
 * tree growing across phases."* This function is the structural enforcer
 * — `delta` is what the observer reads this cycle; `carried` is exposed
 * for cross-cut consistency checks (observer's choice); `dropped` is
 * explicitly out-of-scope.
 *
 * When `previous` is omitted (first checkpoint in a group), every current
 * path lands in `delta` and the other two arrays are empty.
 *
 * Order-stable: the returned arrays preserve the order of `current.artifact_paths`
 * for `delta` and `carried`, and the order of `previous.artifact_paths` for
 * `dropped`. Stable order makes downstream hashing and snapshot tests
 * deterministic.
 */
export function buildObserverContextManifest(args: {
  current: CheckpointArtifactPathSource;
  previous?: CheckpointArtifactPathSource;
}): ObserverContextManifest {
  const currentPaths = args.current.artifact_paths;
  const previousPaths = args.previous?.artifact_paths ?? [];

  if (previousPaths.length === 0) {
    return { delta: [...currentPaths], carried: [], dropped: [] };
  }

  const previousSet = new Set(previousPaths);
  const currentSet = new Set(currentPaths);

  const delta: string[] = [];
  const carried: string[] = [];
  for (const p of currentPaths) {
    if (previousSet.has(p)) {
      carried.push(p);
    } else {
      delta.push(p);
    }
  }

  const dropped: string[] = [];
  for (const p of previousPaths) {
    if (!currentSet.has(p)) {
      dropped.push(p);
    }
  }

  return { delta, carried, dropped };
}

// ── Per-checkpoint observer wake message ────────────────────────────────────

/**
 * Pure: render the observer's per-checkpoint wake-input as a user_message
 * payload. The observer CLI runs `--input-format stream-json` and stays
 * blocked on stdin until the bridge injects a user_message; this is the
 * content of that injection. Without it the observer half sits at pre-init
 * forever — its only input channel is the WS bridge, and the bus listener
 * that fans `group:checkpoint` to browsers does not write back to the CLI.
 *
 * The format is deliberately plain-text-with-bullets, not JSON: the
 * observer system prompt was written assuming a human-readable manifest,
 * and a free-form prompt lets the same wake message work for both Claude
 * and Codex with no provider-specific framing.
 *
 * Path partitioning is delta-first: `manifest.delta` is what the observer
 * MUST read this cycle; `manifest.carried` is exposed for cross-cut
 * consistency checks but flagged as optional. `dropped` is omitted from
 * the message — the prompt's contract is "do not re-read dropped paths",
 * and listing them risks confusing the model into doing exactly that.
 */
export function formatCheckpointManifestPrompt(args: {
  sessionGroupId: string;
  checkpointId: string;
  phase: string;
  manifest: ObserverContextManifest;
}): string {
  const lines: string[] = [];
  lines.push("New checkpoint manifest for review.");
  lines.push("");
  lines.push(`session_group_id: ${args.sessionGroupId}`);
  lines.push(`checkpoint_id: ${args.checkpointId}`);
  lines.push(`phase: ${args.phase}`);
  lines.push("");
  if (args.manifest.delta.length === 0) {
    lines.push("Modified files this cycle: (none — no new artifacts since the previous checkpoint).");
  } else {
    lines.push("Modified files this cycle (read these):");
    for (const p of args.manifest.delta) lines.push(`- ${p}`);
  }
  if (args.manifest.carried.length > 0) {
    lines.push("");
    lines.push("Carried from previous checkpoint (read only for cross-cut checks):");
    for (const p of args.manifest.carried) lines.push(`- ${p}`);
  }
  lines.push("");
  lines.push(
    `Per your system prompt: emit exactly one ObserverReviewPayload JSON to ` +
    `.council/reviews/${args.phase}-<your provider>-observer.md, then exit.`,
  );
  return lines.join("\n");
}
