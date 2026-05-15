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

import { readFileSync, statSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, resolve as resolvePath, sep } from "node:path";
import {
  OBSERVER_WAKE_MAX_BYTES,
  OBSERVER_WAKE_MAX_PATHS_PER_SECTION,
  OBSERVER_WAKE_PAYLOAD_VERSION,
  type CheckpointPayload,
  type ObserverWakePayload,
} from "./council-types.js";
import {
  BUNDLED_OBSERVER_PROMPT,
  BUNDLED_OBSERVER_PROMPT_SHA256,
} from "./observer-prompt-bundled.js";

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
  /**
   * Informational label describing where the artifact came from.
   *
   * For workspace loads (via {@link loadObserverSystemPrompt}) this is the
   * absolute filesystem path. For the bundled fallback it is the sentinel
   * {@link BUNDLED_OBSERVER_PROMPT_SOURCE_LABEL} — NOT a path consumers
   * can `dirname()` or `existsSync()` against. Renamed from `sourcePath`
   * (Council Review 2026-05-15-0820 Fowler P3 #4 — the field carried two
   * shapes and the path-name lied about the bundled variant).
   */
  sourceLabel: string;
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
 * on missing-file is the contract AT THIS LEVEL — this function loads a
 * specific file from disk; if the file isn't there, it throws.
 *
 * Fallback policy is the {@link resolveObserverSystemPrompt} resolver's
 * concern — it composes this function for the workspace path, catches
 * `code === "ENOENT"` only, and falls back to the bundled artifact
 * through the SAME validator below (preserving the schema-mismatch
 * guarantee the original anti-fallback design relied on). Every other
 * fs error (EACCES, EISDIR, ELOOP) still propagates as the loud throw —
 * fallback would silently mask "you mounted the workspace wrong."
 *
 * `sourcePath` must be absolute — relative paths are a misconfiguration
 * vector (relative to *what*? process cwd is unstable).
 *
 * Council Plan PLAN-aura-observer-prompt-bundled-fallback.md Task 11
 * rewrote the prior anti-fallback wording — the schema-mismatch hazard
 * is now mitigated at the resolver layer, not by refusing fallback
 * everywhere.
 */
export function loadObserverSystemPrompt(sourcePath: string): ObserverPromptArtifact {
  if (typeof sourcePath !== "string" || sourcePath.length === 0 || sourcePath.includes("\0")) {
    throw new Error("observer-prompt: invalid sourcePath");
  }
  if (!isAbsolute(sourcePath)) {
    throw new Error("observer-prompt: sourcePath must be absolute");
  }

  // Pre-check size via stat — avoids reading a multi-megabyte file just
  // to reject it on the byte-count test below. Council Review 2026-05-15-0820
  // P2 #6 (D1): stamp `code` directly on the wrapped Error so the resolver
  // discriminates ENOENT via a single named field, not a chain-walk. The
  // cause stays attached for forensic depth.
  let size: number;
  try {
    size = statSync(sourcePath).size;
  } catch (err) {
    throw wrapFsError("stat workspace prompt", err);
  }
  if (size > OBSERVER_PROMPT_MAX_BYTES) {
    throw new Error(
      `observer-prompt: workspace prompt is ${size} bytes, exceeds OBSERVER_PROMPT_MAX_BYTES (${OBSERVER_PROMPT_MAX_BYTES})`,
    );
  }

  // Council Plan Bug B Cleanup Task 1b: wrap readFileSync symmetrically.
  // Prior shape was unwrapped — a stat-success-then-read-ENOENT race (file
  // unlinked between stat and read, editor `:w` truncate-then-rename) threw
  // an ENOENT whose `.code` lived directly on the error, not on a wrapper.
  // Symmetric wrap means the resolver's `err.code === "ENOENT"` discriminator
  // works identically for either fs call's failure (Persistence P3 #1).
  let body: string;
  try {
    body = readFileSync(sourcePath, "utf-8");
  } catch (err) {
    throw wrapFsError("read workspace prompt", err);
  }
  return parseObserverSystemPromptBody(body, sourcePath);
}

/**
 * Pure: wrap a node:fs error with an operation-name message AND stamp the
 * underlying `code` (ENOENT, EACCES, EISDIR, ELOOP, ...) directly on the
 * thrown wrapper so callers can discriminate via `err.code` without a
 * chain-walk. Cause stays attached for forensic depth.
 *
 * Council Review 2026-05-15-0820 D1 (Fowler × Backend × Hunt convergent):
 * the prior `(err as {cause?:unknown}).cause` + `(cause as {code?:unknown})?.code`
 * pattern loses to drift the first time another layer wraps. One named
 * field at the producer is one grep target.
 *
 * Council Review 2026-05-15-1015 CR-7 + CR-9 + CR-16:
 * - Message carries operation + code only — NEVER a filesystem path. Raw
 *   path bytes in `Error.message` flow through `session:relaunch-failed.reason`
 *   into EC-9 group-lifecycle logs and leak operator topology on every
 *   non-ENOENT failure (the (present, depth) hardening was bypassed via
 *   the error channel).
 * - Non-`Error` thrown values are handled defensively (`throw 42`,
 *   `throw "boom"` are legal JS) and normalised so `cause` is always an
 *   Error instance for consumers walking the chain.
 * - SECURITY WARNING for downstream loggers: the `cause` field carries
 *   the raw `node:fs` error, whose `.path` and `.dest` properties contain
 *   the absolute workspace path verbatim. A pretty-printing logger that
 *   serialises causes (`util.inspect({showHidden:true})`, structured-log
 *   shims that walk `cause` chains) re-leaks operator topology with zero
 *   diff in this file. Callers MUST redact `.path` and `.dest` from
 *   `err.cause` before serialising to a shared log sink.
 */
function wrapFsError(operation: string, underlying: unknown): Error & { code?: string } {
  const isObj = typeof underlying === "object" && underlying !== null;
  const rawCode = isObj && "code" in underlying
    ? (underlying as { code?: unknown }).code
    : undefined;
  const code = typeof rawCode === "string" ? rawCode : undefined;
  const message = code
    ? `observer-prompt: ${operation} failed (${code})`
    : `observer-prompt: ${operation} failed`;
  const normalisedCause = underlying instanceof Error
    ? underlying
    : new Error(String(underlying));
  const wrapped = new Error(message, { cause: normalisedCause }) as Error & { code?: string };
  if (code) wrapped.code = code;
  return wrapped;
}

/**
 * Exhaustiveness tripwire for the `"workspace" | "bundled"` source
 * discriminator. Used at every branch that gates behaviour on the source
 * field — if a future contributor adds a third source ("remote", "cache",
 * etc.) the TypeScript compiler points them at every unhandled site.
 *
 * Council Review 2026-05-15-1015 CR-10 (Backend P2-4): the source union
 * is referenced in 6+ places; without a `never` tripwire a third value
 * would silently no-op the conditional branches.
 */
export function assertExhaustiveObserverPromptSource(s: never): never {
  throw new Error(`unhandled observer prompt source: ${s as string}`);
}

/**
 * Pure: validate an already-loaded prompt body against the artifact
 * schema (header sentinel, byte-size ceiling, body-length floor) and
 * return the typed artifact. Extracted from {@link loadObserverSystemPrompt}
 * so the bundled-fallback path in {@link resolveObserverSystemPrompt}
 * can reuse identical validation without a disk round-trip.
 *
 * `sourceLabel` is informational — embedded in error messages and on the
 * returned artifact's `sourceLabel` field. For workspace artifacts it is
 * the absolute filesystem path; for bundled it is the sentinel
 * {@link BUNDLED_OBSERVER_PROMPT_SOURCE_LABEL}. Renamed from `sourcePath`
 * (Council Review 2026-05-15-0820 Fowler P3 #4 — name lied about the
 * bundled case).
 */
function parseObserverSystemPromptBody(body: string, sourceLabel: string): ObserverPromptArtifact {
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

  // Council Review 2026-05-15-1015 CR-7: redact the `sourceLabel` from the
  // thrown Error.message. On the workspace branch the label is the absolute
  // path; embedding it leaks operator topology through `session:relaunch-failed.reason`
  // → EC-9 group-lifecycle log. The artifact still carries `sourceLabel`
  // on its own field for in-memory forensic use.
  const sourceKind = sourceLabel === BUNDLED_OBSERVER_PROMPT_SOURCE_LABEL
    ? "bundled artifact"
    : "workspace prompt";
  const version = parseObserverPromptHeader(body);
  if (version === null) {
    throw new Error(`observer-prompt: missing or malformed header in ${sourceKind} (expected '<!-- observer-system-prompt vN -->')`);
  }
  if (version !== OBSERVER_PROMPT_SCHEMA_VERSION) {
    throw new Error(
      `observer-prompt: header version ${version} does not match supported version ${OBSERVER_PROMPT_SCHEMA_VERSION}`,
    );
  }

  const sha256 = createHash("sha256").update(body, "utf8").digest("hex");

  return { version, body, sha256, sourceLabel };
}

/**
 * Sentinel `sourceLabel` value used by {@link loadBundledObserverPromptValidated}
 * when returning the bundled artifact. NOT a filesystem path — kept
 * distinguishable from any plausible workspace path so consumers parsing
 * `sourceLabel` know the artifact didn't come from disk.
 *
 * Renamed from `BUNDLED_OBSERVER_PROMPT_SOURCE_PATH` (Council Review
 * 2026-05-15-0820 Fowler P3 #4) for symmetry with the renamed
 * `ObserverPromptArtifact.sourceLabel` field.
 */
export const BUNDLED_OBSERVER_PROMPT_SOURCE_LABEL = "<bundled:observer-system-v1>";

/** Artifact extended with a discriminator naming WHICH source produced it. */
export interface ResolvedObserverPrompt extends ObserverPromptArtifact {
  source: "workspace" | "bundled";
}

/**
 * Load the bundled observer-prompt artifact, validated through the same
 * schema gate as workspace artifacts. Returns a {@link ResolvedObserverPrompt}
 * with `source: "bundled"` and the bundled sentinel as its `sourceLabel`.
 *
 * Council Review 2026-05-15-0820 P2 #4/#5 (D3): exposed as a direct API
 * so callers that already know they want the bundled artifact (e.g., the
 * "no workspace cwd" branch in spawn-config) call this helper directly
 * instead of going through the workspace-path resolver with a synthetic
 * sentinel path designed to trip ENOENT. That sentinel-path indirection
 * was a control-flow-via-magic-string smell + a multi-tenant-host attack
 * vector (Hunt P3 #2).
 *
 * The runtime SHA re-check stays — three-gate trichotomy (CI canary +
 * test-time pin + runtime re-hash) catches distinct bundler-mutation
 * failure modes (CRLF normalisation, minify-syntax string-literal
 * mangling, template-literal preprocessing, npm pack/unpack line-ending
 * shifts). The parser already computes the hash; this gate compares its
 * output against the build-time-stamped constant — no double-hash work.
 * Fowler reversed his own prior P3 #3 on Council Review 2026-05-15-0820;
 * keep the gate but document the three failure-modes the comment now
 * names explicitly.
 */
export function loadBundledObserverPromptValidated(): ResolvedObserverPrompt {
  const bundled = parseObserverSystemPromptBody(
    BUNDLED_OBSERVER_PROMPT,
    BUNDLED_OBSERVER_PROMPT_SOURCE_LABEL,
  );
  // Three-gate trichotomy: CI canary catches source-tree drift; test-
  // time pin catches build-output drift; THIS runtime check catches
  // post-build mutation (bundler transforms — CRLF normalisation,
  // minify-syntax, template-literal preprocessing, npm tarball
  // line-ending shifts). All three gates target distinct failure modes
  // at distinct lifecycle stages.
  if (bundled.sha256 !== BUNDLED_OBSERVER_PROMPT_SHA256) {
    throw new Error(
      `observer-prompt: bundled artifact SHA mismatch — computed ${bundled.sha256} vs stamped ${BUNDLED_OBSERVER_PROMPT_SHA256}`,
    );
  }
  return { ...bundled, source: "bundled" };
}

/**
 * Resolve the observer system-prompt artifact for a given workspace.
 *
 * Composes {@link loadObserverSystemPrompt} for the workspace path. On
 * `code === "ENOENT"` ONLY, falls back to the bundled artifact via
 * {@link loadBundledObserverPromptValidated}. Every other error
 * propagates unchanged — EACCES, EISDIR, ELOOP, and any malformed-
 * but-present artifact failure still throws, preserving the "explicit
 * intent must surface" contract from the prior anti-fallback design.
 *
 * Council Review 2026-05-15-0820 P2 #6 (D1): discriminator reads
 * `err.code` directly on the wrapped throw (stamped by
 * {@link wrapFsError}), not via a chain-walk into `err.cause.code`.
 * One named field, one grep target, immune to future re-wrapping.
 *
 * Returned artifact's `source` field discriminates `"workspace"` (the
 * workspace file was loaded) from `"bundled"` (the workspace file was
 * absent and the in-repo default was used).
 *
 * `workspacePath` must be absolute — the same constraint
 * {@link loadObserverSystemPrompt} enforces.
 */
export function resolveObserverSystemPrompt(workspacePath: string): ResolvedObserverPrompt {
  try {
    const artifact = loadObserverSystemPrompt(workspacePath);
    return { ...artifact, source: "workspace" };
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    if (code === "ENOENT") {
      return loadBundledObserverPromptValidated();
    }
    throw err;
  }
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

// ── Wake-message body builder ────────────────────────────────────────────────

/**
 * Reason a manifest path was dropped from the assembled wake body. The
 * builder reports these to the caller (the orchestrator's dispatcher)
 * which emits one EC-9 structured log entry per drop.
 */
export type ObserverWakePathDropReason =
  | "realpath_resolve_failed"
  | "resolves_outside_workspace";

/** A single dropped manifest entry — section + workspace-relative path
 *  + reason. Order-preserved from the input manifest. */
export interface ObserverWakeDroppedPath {
  section: "delta" | "carried" | "dropped";
  path: string;
  reason: ObserverWakePathDropReason;
}

/**
 * Result of {@link buildObserverWakePayload}.
 *
 * `textBody` is the assembled hybrid body (H1 preamble + fenced JSON +
 * directive terminator) intended as the `content` of a `user`-shaped
 * NDJSON frame to the observer's CLI subprocess. `sha256` is the SHA-256
 * of `textBody` for audit/recording attribution; it is NOT a transport
 * checksum. `droppedPaths` enumerates manifest entries that were
 * filtered out by the realpath boundary check (Hunt P1 — EC-7 idiom);
 * callers MUST log each drop at EC-9 severity.
 */
export interface ObserverWakeBuildResult {
  textBody: string;
  sha256: string;
  droppedPaths: ObserverWakeDroppedPath[];
}

/**
 * EC-7 wrapper: realpath-resolve a workspace-relative manifest path and
 * assert containment in the workspace root. The predicate (containment)
 * is NEVER exported separately — only this wrapper that combines
 * resolve-then-check as one atomic unit. This is the convention from
 * EC-7 / `observer-write-policy.ts`'s `assertObserverWriteAllowed`,
 * applied symmetrically to outbound manifest-path emission.
 *
 * Behaviour for non-existent paths: climb to the nearest existing parent
 * and realpath that, then re-append the missing tail (mirrors the EC-7
 * idiom on the write side). Symbolic links along the chain are followed
 * — a symlink that escapes the workspace is caught here, not after the
 * observer reads it.
 *
 * Returns `{ok: true, resolved}` when the realpath lies inside the
 * workspace root (inclusive of the root itself). Returns `{ok: false,
 * reason}` otherwise. Never throws — callers that need exception flow
 * should wrap this themselves.
 *
 * `workspaceRoot` MUST be absolute and (ideally) already realpath-resolved
 * by the caller — the function realpaths it defensively but a caller
 * passing a non-canonical root short-circuits its own correctness
 * argument. The check is `resolved === root` OR `resolved.startsWith(root + sep)`
 * to avoid the classic prefix-confusion bug (`/work` accepting `/workspace-evil`).
 */
export function assertWakeManifestPathAllowed(
  workspaceRelativePath: string,
  workspaceRoot: string,
): { ok: true; resolved: string } | { ok: false; reason: ObserverWakePathDropReason } {
  if (!isAbsolute(workspaceRoot)) {
    return { ok: false, reason: "realpath_resolve_failed" };
  }
  let rootCanonical: string;
  try {
    rootCanonical = realpathSync(workspaceRoot);
  } catch {
    // Workspace root itself does not exist or is unresolvable — refuse
    // to make a containment claim against it.
    return { ok: false, reason: "realpath_resolve_failed" };
  }

  // Join workspace-relative path to the canonical root. Use posix-style
  // `resolve` so `..` segments collapse safely BEFORE realpath; the
  // upstream validator (`isRelativeWorkspacePath`) already rejects `..`
  // segments, but defence-in-depth means we don't trust the caller.
  const joined = resolvePath(rootCanonical, workspaceRelativePath);

  // Climb to the nearest existing ancestor and realpath that, then
  // re-attach the missing tail. This handles the legitimate case where
  // a checkpoint references a path the observer will create — and the
  // hostile case where the missing tail is intended to mask the parent's
  // symlink-escape.
  let canonical: string;
  try {
    canonical = realpathSync(joined);
  } catch {
    // Climb. Loop bounded by path-depth (paths are ≤ MAX_PATH_LEN chars).
    let cursor = joined;
    let suffix = "";
    while (true) {
      const parent = dirname(cursor);
      if (parent === cursor) {
        // Reached filesystem root without finding an existing ancestor.
        return { ok: false, reason: "realpath_resolve_failed" };
      }
      const tail = cursor.slice(parent.length);
      suffix = tail + suffix;
      cursor = parent;
      try {
        const parentCanonical = realpathSync(cursor);
        canonical = parentCanonical + suffix;
        break;
      } catch {
        // Continue climbing.
      }
    }
  }

  // Containment: canonical === rootCanonical (the workspace root itself)
  // OR canonical begins with rootCanonical + sep. The +sep is what
  // prevents the prefix-confusion vulnerability ("/work" accepting
  // "/workspace-other").
  if (canonical === rootCanonical) return { ok: true, resolved: canonical };
  if (canonical.startsWith(rootCanonical + sep)) return { ok: true, resolved: canonical };
  return { ok: false, reason: "resolves_outside_workspace" };
}

/** The exact triplet that would prematurely close our fenced JSON block. */
const FENCE_TRIPLET = "```";

/**
 * Reject path strings carrying NDJSON-unframing or fence-unframing bytes.
 *
 * `council-types.isRelativeWorkspacePath` rejects NUL but accepts CR/LF
 * (POSIX allows newlines inside filenames). At the wake-builder boundary
 * we tighten this: CR or LF inside a manifest path is almost always
 * either an adversarial-looking write by a buggy producer or a planted
 * injection attempt — neither belongs in a wake frame the observer
 * autoregresses over. The check pairs with the size and section caps
 * for input-side defence (Hunt P1 — NDJSON line-discipline injection).
 */
function hasUnsafeWireCharacters(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x00 || c === 0x0a || c === 0x0d) return true;
  }
  return false;
}

/**
 * Pure: format a deterministic wake message body the observer can parse.
 *
 * Body shape (in order, newline-joined):
 * 1. `# Council Checkpoint — <phase>` — H1 preamble naming the action.
 * 2. Single prose sentence pointing at the manifest below.
 * 3. ```json``` fence carrying an {@link ObserverWakePayload}. Version is
 *    the first key; echo fields (`session_group_id`, `checkpoint_id`,
 *    `phase`, `checkpoint_seq`) precede the content arrays so the
 *    observer's review can copy-paste them rather than synthesise.
 * 4. Single imperative directive sentence pointing at the system
 *    prompt's ObserverReviewPayload contract.
 *
 * Defensive input-side validation (Hunt P1; Willison P8):
 * - Each manifest section is capped at
 *   {@link OBSERVER_WAKE_MAX_PATHS_PER_SECTION} independently — a runaway
 *   `delta` cannot displace `carried`/`dropped` from the observer's view.
 * - Every manifest path is scanned for CR/LF/NUL via
 *   {@link hasUnsafeWireCharacters} — paths that survived the watcher
 *   boundary but would be ambiguous inside our fenced block are rejected
 *   here, not escaped silently.
 * - Every manifest path AND echo field is scanned for the literal
 *   ``` triplet — would prematurely close our fence. Reject on the writer
 *   side (EC-5 idiom: refuse unknown frame discriminators rather than
 *   escape away ambiguity).
 * - Total assembled body capped at {@link OBSERVER_WAKE_MAX_BYTES}.
 *
 * Throws a typed `Error` on validation failure. The dispatcher (Task 3)
 * catches and emits a structured EC-9 log line; the throw is the contract
 * because silent truncation would hide an orchestrator emitting
 * adversarial-looking content.
 */
export function buildObserverWakePayload(args: {
  checkpoint: Pick<CheckpointPayload, "session_group_id" | "checkpoint_id" | "phase" | "sequence">;
  manifest: { delta: readonly string[]; carried: readonly string[]; dropped: readonly string[] };
  /** Absolute path to the workspace root. Manifest paths that resolve
   *  (via realpath) outside this root are dropped from the assembled
   *  body and reported in {@link ObserverWakeBuildResult.droppedPaths}.
   *  EC-7 idiom — the filesystem-access predicate is callable only via
   *  the resolving wrapper {@link assertWakeManifestPathAllowed}. */
  workspaceRoot: string;
}): ObserverWakeBuildResult {
  const { checkpoint, manifest, workspaceRoot } = args;

  // Per-section length caps — bounded independently. Char-level
  // validation (CR/LF/NUL/fence-triplet) happens first; realpath
  // containment runs after so a malformed path is rejected before we
  // attempt a filesystem stat.
  const sections: Array<readonly [name: "delta" | "carried" | "dropped", paths: readonly string[]]> = [
    ["delta", manifest.delta],
    ["carried", manifest.carried],
    ["dropped", manifest.dropped],
  ];
  for (const [name, paths] of sections) {
    if (paths.length > OBSERVER_WAKE_MAX_PATHS_PER_SECTION) {
      throw new Error(
        `observer-wake: section "${name}" has ${paths.length} paths, exceeds OBSERVER_WAKE_MAX_PATHS_PER_SECTION (${OBSERVER_WAKE_MAX_PATHS_PER_SECTION})`,
      );
    }
    for (const p of paths) {
      if (typeof p !== "string") {
        throw new Error(`observer-wake: non-string entry in manifest section "${name}"`);
      }
      if (hasUnsafeWireCharacters(p)) {
        throw new Error(
          `observer-wake: manifest path in "${name}" contains CR/LF/NUL (refusing to serialise): ${p.slice(0, 64)}`,
        );
      }
      if (p.includes(FENCE_TRIPLET)) {
        throw new Error(
          `observer-wake: manifest path in "${name}" contains \`\`\` triplet (refusing to serialise): ${p.slice(0, 64)}`,
        );
      }
    }
  }

  // Realpath-bound containment check. Drop (not throw) — a single
  // mis-listed path should not invalidate the whole wake. The caller
  // (dispatcher in Task 3) logs each drop at EC-9. Dropped paths are
  // EXCLUDED from the serialised body the observer sees, so the
  // observer cannot be tricked into reading them via the prompt
  // injection vector even if its tool profile would have permitted
  // the read.
  const droppedPaths: ObserverWakeDroppedPath[] = [];
  const filteredManifest: Record<"delta" | "carried" | "dropped", string[]> = {
    delta: [],
    carried: [],
    dropped: [],
  };
  for (const [name, paths] of sections) {
    for (const p of paths) {
      const check = assertWakeManifestPathAllowed(p, workspaceRoot);
      if (!check.ok) {
        droppedPaths.push({ section: name, path: p, reason: check.reason });
        continue;
      }
      filteredManifest[name].push(p);
    }
  }

  // Echo fields appear verbatim in BOTH the prose preamble (phase) AND
  // the JSON block (all four). They were already validated by
  // parseCheckpointPayload's isBoundedToken/isValidPhase — those reject
  // ≤0x20 controls including CR/LF/NUL — but the symmetric check here
  // makes the wake builder's contract self-contained and grep-able.
  const echoFields: Array<[name: string, value: string]> = [
    ["session_group_id", checkpoint.session_group_id],
    ["checkpoint_id", checkpoint.checkpoint_id],
    ["phase", checkpoint.phase],
  ];
  for (const [name, value] of echoFields) {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`observer-wake: echo field "${name}" is missing or non-string`);
    }
    if (hasUnsafeWireCharacters(value)) {
      throw new Error(`observer-wake: echo field "${name}" contains CR/LF/NUL`);
    }
    if (value.includes(FENCE_TRIPLET)) {
      throw new Error(`observer-wake: echo field "${name}" contains \`\`\` triplet`);
    }
  }
  if (!Number.isInteger(checkpoint.sequence) || checkpoint.sequence < 0) {
    throw new Error(`observer-wake: checkpoint.sequence must be a non-negative integer`);
  }

  // Build the typed payload from the FILTERED manifest. Key order is
  // intentional and load-bearing: version first, then echo fields, then
  // content arrays. Paths that failed the realpath boundary check are
  // EXCLUDED from the body — the observer never sees them.
  const payload: ObserverWakePayload = {
    observer_wake_payload_version: OBSERVER_WAKE_PAYLOAD_VERSION,
    session_group_id: checkpoint.session_group_id,
    checkpoint_id: checkpoint.checkpoint_id,
    phase: checkpoint.phase,
    checkpoint_seq: checkpoint.sequence,
    delta: filteredManifest.delta,
    carried: filteredManifest.carried,
    dropped: filteredManifest.dropped,
  };

  const jsonBlock = JSON.stringify(payload, null, 2);

  // Hybrid body: H1 preamble → prose pointer → fenced JSON → directive
  // terminator. Plain English on either side of the fence is the
  // portability hedge across model families (Willison Principle 7).
  const textBody = [
    `# Council Checkpoint — ${checkpoint.phase}`,
    "",
    "A new checkpoint has arrived. Read only the workspace-relative paths listed under `delta` and `carried` in the manifest below. Files listed under `dropped` are explicitly out of scope this cycle.",
    "",
    "```json",
    jsonBlock,
    "```",
    "",
    "Emit one review file matching the `ObserverReviewPayload` JSON schema described in your system prompt. Set `observer_wake_payload_version_echo` to the integer value of `observer_wake_payload_version` from the manifest. Echo `session_group_id`, `checkpoint_id`, and `phase` from the manifest verbatim. Begin.",
    "",
  ].join("\n");

  const byteLen = Buffer.byteLength(textBody, "utf8");
  if (byteLen > OBSERVER_WAKE_MAX_BYTES) {
    throw new Error(
      `observer-wake: body is ${byteLen} bytes, exceeds OBSERVER_WAKE_MAX_BYTES (${OBSERVER_WAKE_MAX_BYTES})`,
    );
  }

  const sha256 = createHash("sha256").update(textBody, "utf8").digest("hex");

  return { textBody, sha256, droppedPaths };
}
