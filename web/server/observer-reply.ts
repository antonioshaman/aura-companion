/**
 * Host-built observer reviews (P3/B1 — "Observer = judgement only").
 *
 * Before B1 the observer LLM implemented the review protocol itself: it had
 * to name the review file (`<phase>-<group>-<provider>-observer.md`), echo
 * the checkpoint identity, stamp `schema_version` / `reviewed_at` / model /
 * CLI version, and `Write` the file. Every one of those is a place an LLM
 * can drift (the codex normalizer and the "most-omitted field" prompt
 * section in `council-types.ts` are the scar tissue).
 *
 * Now the observer's FINAL chat message is a bare findings array and the
 * host does the rest:
 *
 *   wake dispatched → {@link ObserverReplyCapture.expect}
 *   message:assistant frames → {@link ObserverReplyCapture.onAssistant}
 *     (text after the last tool activity is the candidate reply)
 *   observer:turn-done → {@link ObserverReplyCapture.finalize}
 *     → extract findings → stamp envelope from host facts → validate with
 *       the SAME `parseObserverReviewPayload` every consumer already uses
 *     → atomic write into `.council/reviews/` under the canonical name.
 *
 * The file on disk is byte-for-byte the pre-B1 contract, so the review
 * watcher, grounding, fanout, UI and eval sidecar are untouched.
 *
 * Transition: an observer still running the pre-B1 prompt writes the file
 * itself and replies with prose. `finalize` sees the file already on disk
 * for this checkpoint and stands down (`skipped_existing`); the watcher
 * processes the observer-written file exactly as before. A full legacy
 * envelope pasted into chat is also accepted — only its `findings` are used.
 *
 * Group-less observer files (AuraBench BENCH-H): Codex observers sometimes
 * write `<phase>-codex-observer.md` WITHOUT the group segment. Several pairs
 * can share one `.council/`, so that name is ambiguous — two observers
 * overwrite each other and nothing on disk says whose review it is. The
 * per-group review watcher therefore ignores group-less names, and
 * `finalize` ADOPTS such a file when it answers the checkpoint this observer
 * was woken for AND names this group: the host re-emits its findings under
 * the canonical group-scoped name with a host-stamped envelope (model from
 * the observer's own frames, not the LLM's self-report) and moves the
 * group-less file aside to a name no reader matches.
 *
 * Provider-agnostic by construction: both the Claude and the Codex bridges
 * emit the same `message:assistant` shape (content blocks + `message.model`)
 * and both adapters emit `observer:turn-done` at turn end.
 */

import { join } from "node:path";
import {
  type CouncilParserDropReason,
  type ObserverReviewPayload,
  COUNCIL_SCHEMA_VERSION,
  isBoundedToken,
  normalizeObserverFindingShapeRaw,
  parseObserverReviewPayload,
} from "./council-types.js";
import { adoptedReviewAsideName, buildObserverReviewFilename } from "./review-watcher.js";

/** Why a reply produced no review. `empty_reply` = the observer said nothing
 *  after its last tool call (or never answered); the rest = it answered, but
 *  not with a usable findings list. */
export type ObserverReplyRejectReason =
  | "empty_reply"
  | "no_json"
  | "not_findings"
  | "invalid_findings";

export type ExtractedFindings =
  | { ok: true; findings: unknown[]; shape: "array" | "object" }
  | { ok: false; reason: Exclude<ObserverReplyRejectReason, "invalid_findings"> };

/** Upper bound on bracket positions the prose scan will try. A reply with
 *  thousands of unmatched `[` would otherwise make the scan quadratic. */
const MAX_PROSE_SCAN_STARTS = 512;

/**
 * Return the balanced `[...]` / `{...}` span starting at `start`, tracking
 * JSON string literals so a `]` inside `"evidence"` does not close the span.
 * `null` if the text ends before the span balances.
 */
function balancedSpanEnd(text: string, start: number): number | null {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

type Classified =
  | { kind: "findings"; findings: unknown[]; shape: "array" | "object" }
  | { kind: "other" };

/**
 * Decide whether parsed JSON is a findings list. `standalone` = it was the
 * whole reply or a whole fenced block — an explicit answer. Only a
 * standalone value may be an EMPTY list or an array the validator must
 * judge; JSON pulled out of prose must look like findings (a non-empty
 * array of objects), so `[0]`, `[ ]` or `[1, 2]` in a sentence never
 * becomes a review.
 */
function classifyFindings(parsed: unknown, standalone: boolean): Classified {
  if (Array.isArray(parsed)) {
    if (standalone) return { kind: "findings", findings: parsed, shape: "array" };
    if (parsed.length > 0 && parsed.every(isPlainObject)) return { kind: "findings", findings: parsed, shape: "array" };
    return { kind: "other" };
  }
  if (isPlainObject(parsed) && Array.isArray(parsed.findings)) {
    const findings = parsed.findings as unknown[];
    if (standalone || findings.length > 0) return { kind: "findings", findings, shape: "object" };
  }
  return { kind: "other" };
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/**
 * Pull the findings list out of the observer's final reply text.
 *
 * Accepted, in order:
 *  1. the whole text as JSON;
 *  2. the LAST ```json fenced block whose whole body parses;
 *  3. the LAST balanced `[...]` / `{...}` span in prose that parses AND
 *     looks like findings (non-empty array of objects, or an object with a
 *     non-empty `findings` array). Spans are found by a string-aware
 *     bracket scan, so prose brackets (`rule [R3]`, `see [docs]`,
 *     `foo[0]`) neither swallow the real array nor stand in for it.
 *
 * An EMPTY review is accepted only from an explicit empty list as the whole
 * reply or a whole fenced block — never from `[ ]` inside a sentence.
 * A JSON array is the findings list; an object is accepted only if it
 * carries a `findings` array (legacy envelope pasted in chat). Anything
 * else is rejected — never guessed at.
 */
export function extractObserverFindings(text: string): ExtractedFindings {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: false, reason: "empty_reply" };

  let sawJson = false;
  const standalone: string[] = [trimmed];
  const fences = [...trimmed.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n?```/g)].map((m) => (m[1] ?? "").trim());
  standalone.push(...fences.reverse());
  for (const c of standalone) {
    const r = tryParse(c);
    if (!r.ok) continue;
    sawJson = true;
    const cls = classifyFindings(r.value, true);
    if (cls.kind === "findings") return { ok: true, findings: cls.findings, shape: cls.shape };
  }

  // Prose scan: outermost balanced spans left to right; the last span that
  // classifies as findings wins (mirrors "last fenced block").
  let found: Extract<Classified, { kind: "findings" }> | null = null;
  let starts = 0;
  for (let i = 0; i < trimmed.length && starts < MAX_PROSE_SCAN_STARTS; i++) {
    const ch = trimmed[i];
    if (ch !== "[" && ch !== "{") continue;
    starts++;
    const end = balancedSpanEnd(trimmed, i);
    if (end === null) continue;
    const r = tryParse(trimmed.slice(i, end + 1));
    if (!r.ok) continue;
    sawJson = true;
    const cls = classifyFindings(r.value, false);
    if (cls.kind === "findings") found = cls;
    i = end; // skip the parsed span: its inner objects are not candidates
  }
  if (found) return { ok: true, findings: found.findings, shape: found.shape };
  return { ok: false, reason: sawJson ? "not_findings" : "no_json" };
}

export interface HostReviewIdentity {
  sessionGroupId: string;
  checkpointId: string;
  phase: string;
  provider: "claude" | "codex";
  /** Model id observed on the observer's own assistant frames (host fact). */
  model: string | undefined;
  /** CLI version from the observer session's init handshake (host fact). */
  cliVersion: string | undefined;
  /** Server clock at the moment the reply completed. */
  reviewedAt: Date;
}

export type HostReviewBuild =
  | { ok: true; payload: ObserverReviewPayload }
  | { ok: false; reason: "invalid_findings"; dropReason: CouncilParserDropReason; field?: string };

function auditToken(v: string | undefined, max: number): string {
  return isBoundedToken(v, max) ? v : "unknown";
}

/**
 * Wrap raw findings in the host-owned envelope and validate the result with
 * the shared reader-side parser. Native finding shapes (`severity:"high"`,
 * `file`/`line`) are mapped first — the same mapping the watcher applies to
 * observer-written files — so a reply is never dropped on a shape the file
 * path would have accepted.
 */
export function buildHostObserverReview(findings: unknown[], id: HostReviewIdentity): HostReviewBuild {
  const envelope = {
    schema_version: COUNCIL_SCHEMA_VERSION,
    checkpoint_id: id.checkpointId,
    phase: id.phase,
    session_group_id: id.sessionGroupId,
    reviewed_at: id.reviewedAt.toISOString(),
    observer_provider: id.provider,
    observer_model: auditToken(id.model, 128),
    observer_cli_version: auditToken(id.cliVersion, 64),
    findings,
  };
  let drop: { reason: CouncilParserDropReason; field?: string } | null = null;
  const payload = parseObserverReviewPayload(
    normalizeObserverFindingShapeRaw(JSON.stringify(envelope)),
    (reason, field) => { drop = { reason, field }; },
  );
  if (!payload) {
    const d = drop as { reason: CouncilParserDropReason; field?: string } | null;
    return { ok: false, reason: "invalid_findings", dropReason: d?.reason ?? "schema-mismatch", ...(d?.field ? { field: d.field } : {}) };
  }
  return { ok: true, payload };
}

// ── Capture: bus frames → one review per dispatched wake ────────────────────

export interface ObserverReplyExpectation {
  sessionGroupId: string;
  checkpointId: string;
  phase: string;
  provider: "claude" | "codex";
  /** Workspace root; the review lands in `<cwd>/.council/reviews/`. */
  cwd: string;
  /** Spawn-time model, used only if no assistant frame carried one. */
  fallbackModel?: string;
}

export type ObserverReplyOutcome =
  | { kind: "no_expectation" }
  | { kind: "written"; expectation: ObserverReplyExpectation; file: string; findingCount: number }
  | { kind: "skipped_existing"; expectation: ObserverReplyExpectation; file: string }
  | {
      kind: "adopted";
      expectation: ObserverReplyExpectation;
      /** Canonical group-scoped file the host wrote. */
      file: string;
      /** Group-less file the observer wrote. */
      sourceFile: string;
      /** Where the group-less file was moved; absent if the move failed. */
      asideFile?: string;
      asideError?: string;
      findingCount: number;
      /** Model the observer claimed in its own file vs the host fact stamped. */
      reportedModel: string;
      hostModel: string;
    }
  | {
      kind: "rejected";
      expectation: ObserverReplyExpectation;
      reason: ObserverReplyRejectReason;
      /** Parser drop detail for `invalid_findings`. */
      field?: string;
      /** Rejections in a row for this observer session, this one included. */
      consecutive: number;
    }
  | { kind: "write_failed"; expectation: ObserverReplyExpectation; file: string; error: string }
  | { kind: "filename_failed"; expectation: ObserverReplyExpectation; error: string };

export interface ObserverReplyCaptureDeps {
  now(): Date;
  /** Atomic write of the validated payload (production: `writeAtomicJson`). */
  writeReview(path: string, payload: ObserverReviewPayload): void;
  /** Review already on disk for this group's checkpoint, if any — owned by
   *  the group (payload `session_group_id`), group-scoped name preferred
   *  (production: `findOwnReviewForCheckpointSync`). */
  findExistingReview(
    reviewsDir: string,
    checkpointId: string,
    sessionGroupId: string,
  ): { file: string; payload: ObserverReviewPayload; groupScoped: boolean } | null;
  /** Move an adopted group-less file to `asideName` in the same directory
   *  (production: `renameSync`). */
  moveAside(reviewsDir: string, file: string, asideName: string): void;
  /** CLI version reported by the session's init handshake, if known. */
  resolveCliVersion(sessionId: string): string | undefined;
}

interface CaptureSlot {
  expectation: ObserverReplyExpectation;
  /** Text blocks since the last tool activity — the candidate final reply. */
  tail: string[];
  model: string | undefined;
}

type ContentBlock = { type?: unknown; text?: unknown };

function assistantParts(message: unknown): { blocks: ContentBlock[]; model: string | undefined } | null {
  if (typeof message !== "object" || message === null) return null;
  const m = message as { type?: unknown; message?: { content?: unknown; model?: unknown } };
  if (m.type !== "assistant" || !m.message || !Array.isArray(m.message.content)) return null;
  return {
    blocks: m.message.content as ContentBlock[],
    model: typeof m.message.model === "string" ? m.message.model : undefined,
  };
}

/**
 * Per-observer-session reply capture. One expectation per session: a newer
 * dispatch replaces the older one (the observer answers the newest wake;
 * the 1-slot wake queue guarantees a wake is only sent when the observer is
 * idle, so replacement only happens across completed turns).
 */
export class ObserverReplyCapture {
  private readonly slots = new Map<string, CaptureSlot>();
  private readonly consecutiveRejections = new Map<string, number>();
  /** Last model id seen on an observer's own assistant frames (host fact);
   *  outlives the per-wake slot so a review landing after `finalize` can
   *  still be stamped with it. Cleared by {@link forget}. */
  private readonly observedModels = new Map<string, string>();

  constructor(private readonly deps: ObserverReplyCaptureDeps) {}

  expect(observerSessionId: string, expectation: ObserverReplyExpectation): void {
    this.slots.set(observerSessionId, { expectation, tail: [], model: undefined });
  }

  /** Cheap no-op for every session without an outstanding wake. */
  onAssistant(sessionId: string, message: unknown): void {
    const slot = this.slots.get(sessionId);
    if (!slot) return;
    const parts = assistantParts(message);
    if (!parts) return;
    if (parts.model) {
      slot.model = parts.model;
      this.observedModels.set(sessionId, parts.model);
    }
    for (const b of parts.blocks) {
      if (b.type === "tool_use" || b.type === "tool_result") {
        slot.tail = [];
      } else if (b.type === "text" && typeof b.text === "string") {
        slot.tail.push(b.text);
      }
    }
  }

  forget(sessionId: string): void {
    this.slots.delete(sessionId);
    this.consecutiveRejections.delete(sessionId);
    this.observedModels.delete(sessionId);
  }

  /** Model id the observer session's own frames carried most recently, if any. */
  observedModel(sessionId: string): string | undefined {
    return this.observedModels.get(sessionId);
  }

  /** Turn ended: turn the captured reply into a review (or a reasoned rejection). */
  finalize(sessionId: string): ObserverReplyOutcome {
    const slot = this.slots.get(sessionId);
    if (!slot) return { kind: "no_expectation" };
    this.slots.delete(sessionId);
    const { expectation } = slot;
    const reviewsDir = join(expectation.cwd, ".council", "reviews");

    // Transition: a pre-B1 observer wrote the file itself during the turn.
    const existing = this.deps.findExistingReview(reviewsDir, expectation.checkpointId, expectation.sessionGroupId);
    if (existing?.groupScoped) {
      // Canonical, group-scoped name: unambiguous; the watcher consumes it.
      this.consecutiveRejections.delete(sessionId);
      return { kind: "skipped_existing", expectation, file: existing.file };
    }
    if (existing) {
      const adopted = this.adopt(sessionId, slot, existing.file, existing.payload, reviewsDir);
      if (adopted) return adopted;
      // Unreachable in practice (the file's findings already parsed); fall
      // through to the reply so the observer's answer is not lost.
    }

    const extracted = extractObserverFindings(slot.tail.join("\n"));
    if (!extracted.ok) return this.reject(sessionId, expectation, extracted.reason);

    const built = buildHostObserverReview(extracted.findings, {
      sessionGroupId: expectation.sessionGroupId,
      checkpointId: expectation.checkpointId,
      phase: expectation.phase,
      provider: expectation.provider,
      model: slot.model ?? expectation.fallbackModel,
      cliVersion: this.deps.resolveCliVersion(sessionId),
      reviewedAt: this.deps.now(),
    });
    if (!built.ok) return this.reject(sessionId, expectation, "invalid_findings", built.field ?? built.dropReason);

    // FIX-B1-1: a naming failure must come back as an outcome, not throw out
    // of the turn-done handler (which would skip the wake drain).
    let file: string;
    try {
      file = buildObserverReviewFilename(expectation.phase, expectation.provider, expectation.sessionGroupId);
    } catch (err) {
      return { kind: "filename_failed", expectation, error: err instanceof Error ? err.message : String(err) };
    }
    const path = join(reviewsDir, file);
    try {
      this.deps.writeReview(path, built.payload);
    } catch (err) {
      return { kind: "write_failed", expectation, file, error: err instanceof Error ? err.message : String(err) };
    }
    this.consecutiveRejections.delete(sessionId);
    return { kind: "written", expectation, file, findingCount: built.payload.findings.length };
  }

  /**
   * Re-emit an observer-written GROUP-LESS review under the canonical
   * group-scoped name with a host-stamped envelope, then move the group-less
   * file aside so no pair (this one or a neighbour sharing the directory)
   * reads it again. Only reached for a file whose payload answers THIS
   * checkpoint and names THIS group (the dep enforces ownership), so a
   * neighbour's review is never adopted. `null` = findings failed host
   * validation; the caller falls back to the chat reply.
   */
  private adopt(
    sessionId: string,
    slot: CaptureSlot,
    sourceFile: string,
    source: ObserverReviewPayload,
    reviewsDir: string,
  ): ObserverReplyOutcome | null {
    const { expectation } = slot;
    const built = buildHostObserverReview(source.findings, {
      sessionGroupId: expectation.sessionGroupId,
      checkpointId: expectation.checkpointId,
      phase: expectation.phase,
      provider: expectation.provider,
      model: slot.model ?? expectation.fallbackModel,
      cliVersion: this.deps.resolveCliVersion(sessionId),
      reviewedAt: this.deps.now(),
    });
    if (!built.ok) return null;
    let file: string;
    try {
      file = buildObserverReviewFilename(expectation.phase, expectation.provider, expectation.sessionGroupId);
    } catch (err) {
      return { kind: "filename_failed", expectation, error: err instanceof Error ? err.message : String(err) };
    }
    try {
      this.deps.writeReview(join(reviewsDir, file), built.payload);
    } catch (err) {
      // The group-less file stays where it is; no watcher consumes it, and the
      // wake watchdog's own-review rescan still finds it at the deadline.
      return { kind: "write_failed", expectation, file, error: err instanceof Error ? err.message : String(err) };
    }
    this.consecutiveRejections.delete(sessionId);
    const asideName = adoptedReviewAsideName(sourceFile, expectation.sessionGroupId, this.deps.now().getTime());
    const base = {
      kind: "adopted" as const,
      expectation,
      file,
      sourceFile,
      findingCount: built.payload.findings.length,
      reportedModel: source.observer_model,
      hostModel: built.payload.observer_model,
    };
    try {
      this.deps.moveAside(reviewsDir, sourceFile, asideName);
    } catch (err) {
      return { ...base, asideError: err instanceof Error ? err.message : String(err) };
    }
    return { ...base, asideFile: asideName };
  }

  private reject(
    sessionId: string,
    expectation: ObserverReplyExpectation,
    reason: ObserverReplyRejectReason,
    field?: string,
  ): ObserverReplyOutcome {
    const consecutive = (this.consecutiveRejections.get(sessionId) ?? 0) + 1;
    this.consecutiveRejections.set(sessionId, consecutive);
    return { kind: "rejected", expectation, reason, ...(field ? { field } : {}), consecutive };
  }
}
