/**
 * Auto-resume after a usage limit — the one-shot scheduler.
 *
 * When a session (Claude or Codex, solo or either council half) stops on a
 * usage limit, the adapters emit `session:usage-limit` with a resolved reset
 * time (see `usage-limit-parse.ts`). The orchestrator hands that to
 * {@link AutoResumeScheduler.schedule}, which arms ONE timer per session at
 * `resetAt + 60–120 s` (jitter so several sessions that hit the same window
 * don't stampede the API at the same second). When it fires, the record is
 * deleted (memory + disk) BEFORE `resume` runs — fire-once even if the resume
 * throws or the server dies mid-resume — and `resume` (DI, see
 * `auto-resume-executor.ts`) relaunches the session if needed and injects the
 * continuation prompt.
 *
 * Invariants:
 *  - At most one schedule per session. The same limit reported again (the
 *    CLI emits an assistant frame AND a result frame per failure) is a no-op;
 *    a different reset time replaces the schedule ("a new limit hit wins").
 *  - Repeat-limit guard: a limit hit within {@link REHIT_WINDOW_MS} of a fire
 *    is a "re-hit" (the resumed turn ran straight back into the limit — e.g.
 *    the +5h fallback guessed a weekly limit). After two consecutive fires
 *    that re-hit, auto-resume for that session is PAUSED: nothing more is
 *    injected, the banner says the limit is still active, and only a user
 *    action (message, cancel, stop, archive) clears it. A hit later than the
 *    window means the resume made progress and resets the count. The fire
 *    history and pauses are persisted with the schedules.
 *  - Persisted to `~/.companion/auto-resume.json` on every mutation and
 *    re-armed by {@link restore} on boot. Overdue schedules fire after a boot
 *    grace (lets CLI reconnects settle); schedules of sessions that no longer
 *    exist or are archived are dropped.
 *  - The global setting is checked at schedule time AND at fire time.
 *
 * Every transition emits a structured log line:
 * `usage_limit.auto_resume.{scheduled,cancelled,fired}` with sessionId,
 * backend, model and resetAt.
 */
import { readFileSync, existsSync } from "node:fs";
import { writeAtomicJson } from "./atomic-write.js";
import { log } from "./logger.js";
import type { UsageLimitResetSource } from "./usage-limit-parse.js";

export type AutoResumeRole = "solo" | "orchestrator" | "observer";

export interface AutoResumeHit {
  sessionId: string;
  backend: "claude" | "codex";
  model: string | null;
  /** Epoch ms when the limit resets. */
  resetAt: number;
  resetSource: UsageLimitResetSource;
  limitType: string | null;
  role: AutoResumeRole;
  sessionGroupId: string | null;
}

export interface AutoResumeSchedule extends AutoResumeHit {
  /** Epoch ms when the resume fires (resetAt + jitter, or boot grace). */
  fireAt: number;
  scheduledAt: number;
}

/** What the browser banner needs (mirrored on SessionState.auto_resume). */
export interface AutoResumePublicState {
  resetAt: number;
  fireAt: number;
  resetSource: UsageLimitResetSource;
  /** Set when the repeat-limit guard paused auto-resume for the session. */
  paused?: boolean;
}

interface AttemptRecord {
  /** Epoch ms of the last fire. */
  lastFiredAt: number;
  /** Consecutive fires that were immediately followed by another limit hit. */
  rehits: number;
}

interface PausedRecord extends AutoResumeHit {
  pausedAt: number;
}

export interface AutoResumeOutcome {
  ok: boolean;
  outcome: string;
  error?: string;
  relaunched?: boolean;
  partnerRelaunched?: boolean;
}

export type AutoResumeCancelReason =
  | "user_message"
  | "user_cancel"
  | "user_stop"
  | "archived"
  | "deleted"
  | "disabled"
  | "session_gone";

export interface AutoResumeSchedulerDeps {
  filePath: string;
  isEnabled: () => boolean;
  /** Session exists and is not archived. */
  isSessionResumable: (sessionId: string) => boolean;
  /**
   * Run the resume. `signal.aborted` flips when the session is cancelled
   * while the resume is in flight (the schedule itself is already gone).
   */
  resume: (schedule: AutoResumeSchedule, signal: { readonly aborted: boolean }) => Promise<AutoResumeOutcome>;
  publish: (sessionId: string, state: AutoResumePublicState | null) => void;
  now?: () => number;
  random?: () => number;
  /** Delay applied to overdue schedules on {@link AutoResumeScheduler.restore}. */
  bootGraceMs?: number;
}

export const AUTO_RESUME_JITTER_MIN_MS = 60_000;
export const AUTO_RESUME_JITTER_MAX_MS = 120_000;
/** Two schedules whose reset times differ by less than this are "the same limit". */
const SAME_LIMIT_TOLERANCE_MS = 5 * 60_000;
/** setTimeout clamps delays above 2^31-1 ms (~24.8 days) to 1 ms — chunk instead. */
const MAX_TIMER_MS = 2_147_483_647;
/** A limit hit this soon after a fire counts as an immediate re-hit. */
export const REHIT_WINDOW_MS = 15 * 60_000;
/** Consecutive immediate re-hits after which auto-resume pauses. */
export const MAX_CONSECUTIVE_REHITS = 2;
const FILE_VERSION = 1;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function isSchedule(raw: unknown): raw is AutoResumeSchedule {
  if (!raw || typeof raw !== "object") return false;
  const r = raw as Record<string, unknown>;
  return (
    typeof r.sessionId === "string" &&
    r.sessionId.length > 0 &&
    (r.backend === "claude" || r.backend === "codex") &&
    typeof r.resetAt === "number" &&
    typeof r.fireAt === "number" &&
    (r.role === "solo" || r.role === "orchestrator" || r.role === "observer")
  );
}

export class AutoResumeScheduler {
  private schedules = new Map<string, AutoResumeSchedule>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private attempts = new Map<string, AttemptRecord>();
  private paused = new Map<string, PausedRecord>();
  /** Resumes currently running (fired, not yet settled) → their abort flag. */
  private inFlight = new Map<string, { aborted: boolean }>();
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly bootGraceMs: number;

  constructor(private readonly deps: AutoResumeSchedulerDeps) {
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
    this.bootGraceMs = deps.bootGraceMs ?? 35_000;
  }

  get(sessionId: string): AutoResumeSchedule | undefined {
    return this.schedules.get(sessionId);
  }

  list(): AutoResumeSchedule[] {
    return [...this.schedules.values()];
  }

  isPaused(sessionId: string): boolean {
    return this.paused.has(sessionId);
  }

  /**
   * Arm (or keep, or replace) the one-shot resume for `hit.sessionId`.
   * Returns the active schedule, or null when the feature is disabled.
   */
  schedule(hit: AutoResumeHit): AutoResumeSchedule | null {
    if (!this.deps.isEnabled()) {
      log.info("auto-resume", "usage limit hit; auto-resume disabled", {
        event: "usage_limit.auto_resume.skipped",
        reason: "disabled",
        ...this.logFields(hit),
      });
      return null;
    }
    if (this.paused.has(hit.sessionId)) {
      log.info("auto-resume", "usage limit hit; auto-resume paused for this session", {
        event: "usage_limit.auto_resume.skipped",
        reason: "paused",
        ...this.logFields(hit),
      });
      return null;
    }
    const existing = this.schedules.get(hit.sessionId);
    if (existing && Math.abs(existing.resetAt - hit.resetAt) < SAME_LIMIT_TOLERANCE_MS) {
      return existing;
    }
    const now = this.now();
    const attempt = this.attempts.get(hit.sessionId);
    if (attempt && now - attempt.lastFiredAt <= REHIT_WINDOW_MS) {
      const rehits = attempt.rehits + 1;
      this.attempts.set(hit.sessionId, { ...attempt, rehits });
      if (rehits >= MAX_CONSECUTIVE_REHITS) {
        this.pause(hit, rehits);
        return null;
      }
    } else if (attempt) {
      // The resume made progress before this limit — start counting afresh.
      this.attempts.delete(hit.sessionId);
    }
    const jitter =
      AUTO_RESUME_JITTER_MIN_MS +
      Math.floor(Math.min(Math.max(this.random(), 0), 0.999999) * (AUTO_RESUME_JITTER_MAX_MS - AUTO_RESUME_JITTER_MIN_MS + 1));
    const schedule: AutoResumeSchedule = {
      ...hit,
      fireAt: Math.max(hit.resetAt, now) + jitter,
      scheduledAt: now,
    };
    if (existing) this.clearTimer(hit.sessionId);
    this.schedules.set(hit.sessionId, schedule);
    this.persist();
    this.arm(schedule);
    this.deps.publish(hit.sessionId, this.publicState(schedule));
    log.info("auto-resume", "auto-resume scheduled", {
      event: "usage_limit.auto_resume.scheduled",
      ...this.logFields(schedule),
      fireAt: iso(schedule.fireAt),
      replaced: existing !== undefined,
    });
    return schedule;
  }

  /**
   * Cancel the schedule (or pause) for `sessionId` and forget its fire
   * history. Returns true when a schedule or pause existed.
   */
  cancel(sessionId: string, reason: AutoResumeCancelReason): boolean {
    const schedule = this.schedules.get(sessionId) ?? this.paused.get(sessionId);
    const hadAttempts = this.attempts.delete(sessionId);
    const running = this.inFlight.get(sessionId);
    if (running && !running.aborted) {
      running.aborted = true;
      log.info("auto-resume", "in-flight auto-resume aborted", {
        event: "usage_limit.auto_resume.cancelled",
        reason,
        sessionId,
        inFlight: true,
      });
    }
    if (!schedule) {
      if (hadAttempts) this.persist();
      return running !== undefined;
    }
    this.clearTimer(sessionId);
    this.schedules.delete(sessionId);
    this.paused.delete(sessionId);
    this.persist();
    this.deps.publish(sessionId, null);
    log.info("auto-resume", "auto-resume cancelled", {
      event: "usage_limit.auto_resume.cancelled",
      reason,
      ...this.logFields(schedule),
    });
    return true;
  }

  cancelAll(reason: AutoResumeCancelReason): void {
    for (const id of new Set([...this.schedules.keys(), ...this.paused.keys(), ...this.inFlight.keys()])) this.cancel(id, reason);
  }

  /**
   * Boot: load persisted schedules and re-arm them. Returns how many were
   * re-armed. Overdue ones fire after the boot grace; orphans are dropped.
   */
  restore(): number {
    const { schedules: loaded, attempts, paused } = this.load();
    const now = this.now();
    for (const a of attempts) {
      // Older than the window → any later hit resets the count anyway.
      if (now - a.lastFiredAt <= REHIT_WINDOW_MS && this.deps.isSessionResumable(a.sessionId)) {
        this.attempts.set(a.sessionId, { lastFiredAt: a.lastFiredAt, rehits: a.rehits });
      }
    }
    for (const p of paused) {
      if (!this.deps.isSessionResumable(p.sessionId)) continue;
      this.paused.set(p.sessionId, p);
      this.deps.publish(p.sessionId, this.pausedState(p));
    }
    let armed = 0;
    let dropped = false;
    for (const schedule of loaded) {
      if (!this.deps.isSessionResumable(schedule.sessionId)) {
        dropped = true;
        log.info("auto-resume", "auto-resume dropped on restore", {
          event: "usage_limit.auto_resume.cancelled",
          reason: "session_gone",
          ...this.logFields(schedule),
        });
        continue;
      }
      const rearmed: AutoResumeSchedule = { ...schedule, fireAt: Math.max(schedule.fireAt, now + this.bootGraceMs) };
      this.schedules.set(rearmed.sessionId, rearmed);
      this.arm(rearmed);
      this.deps.publish(rearmed.sessionId, this.publicState(rearmed));
      armed += 1;
      log.info("auto-resume", "auto-resume re-armed after restart", {
        event: "usage_limit.auto_resume.rearmed",
        ...this.logFields(rearmed),
        fireAt: iso(rearmed.fireAt),
      });
    }
    if (dropped || armed !== loaded.length || attempts.length !== this.attempts.size || paused.length !== this.paused.size) {
      this.persist();
    }
    return armed;
  }

  dispose(): void {
    for (const id of [...this.timers.keys()]) this.clearTimer(id);
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private async fire(sessionId: string): Promise<void> {
    const schedule = this.schedules.get(sessionId);
    if (!schedule) return;
    // Fire-once: drop the record (memory + disk) BEFORE resuming, and note
    // the fire for the repeat-limit guard (before resume: the resumed turn
    // can re-hit the limit before `resume` resolves).
    this.timers.delete(sessionId);
    this.schedules.delete(sessionId);
    const previous = this.attempts.get(sessionId);
    this.attempts.set(sessionId, { lastFiredAt: this.now(), rehits: previous?.rehits ?? 0 });
    this.persist();
    this.deps.publish(sessionId, null);

    if (!this.deps.isEnabled()) {
      log.info("auto-resume", "auto-resume cancelled at fire time", {
        event: "usage_limit.auto_resume.cancelled",
        reason: "disabled",
        ...this.logFields(schedule),
      });
      return;
    }

    const signal = { aborted: false };
    this.inFlight.set(sessionId, signal);
    let outcome: AutoResumeOutcome;
    try {
      outcome = await this.deps.resume(schedule, signal);
    } catch (err) {
      outcome = { ok: false, outcome: "error", error: err instanceof Error ? err.message : String(err) };
    } finally {
      if (this.inFlight.get(sessionId) === signal) this.inFlight.delete(sessionId);
    }
    log.info("auto-resume", "auto-resume fired", {
      event: "usage_limit.auto_resume.fired",
      ...this.logFields(schedule),
      ...outcome,
    });
  }

  private pause(hit: AutoResumeHit, rehits: number): void {
    const existing = this.schedules.get(hit.sessionId);
    if (existing) {
      this.clearTimer(hit.sessionId);
      this.schedules.delete(hit.sessionId);
    }
    const record: PausedRecord = { ...hit, pausedAt: this.now() };
    this.paused.set(hit.sessionId, record);
    this.persist();
    this.deps.publish(hit.sessionId, this.pausedState(record));
    log.info("auto-resume", "auto-resume paused: limit still active after consecutive resumes", {
      event: "usage_limit.auto_resume.paused",
      ...this.logFields(hit),
      consecutiveRehits: rehits,
    });
  }

  private pausedState(p: PausedRecord): AutoResumePublicState {
    return { resetAt: p.resetAt, fireAt: p.resetAt, resetSource: p.resetSource, paused: true };
  }

  private arm(schedule: AutoResumeSchedule): void {
    this.clearTimer(schedule.sessionId);
    const delay = Math.max(0, schedule.fireAt - this.now());
    const step = Math.min(delay, MAX_TIMER_MS);
    const timer = setTimeout(() => {
      this.timers.delete(schedule.sessionId);
      const current = this.schedules.get(schedule.sessionId);
      if (current !== schedule) return;
      if (current.fireAt > this.now()) {
        this.arm(current); // long delay — next chunk
        return;
      }
      void this.fire(schedule.sessionId);
    }, step);
    if (typeof timer === "object" && timer && "unref" in timer) {
      (timer as { unref?: () => void }).unref?.();
    }
    this.timers.set(schedule.sessionId, timer);
  }

  private clearTimer(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.timers.delete(sessionId);
  }

  private publicState(schedule: AutoResumeSchedule): AutoResumePublicState {
    return { resetAt: schedule.resetAt, fireAt: schedule.fireAt, resetSource: schedule.resetSource };
  }

  private logFields(s: AutoResumeHit): Record<string, unknown> {
    return {
      sessionId: s.sessionId,
      backend: s.backend,
      model: s.model,
      resetAt: iso(s.resetAt),
      resetSource: s.resetSource,
      limitType: s.limitType,
      role: s.role,
      ...(s.sessionGroupId ? { sessionGroupId: s.sessionGroupId } : {}),
    };
  }

  private load(): { schedules: AutoResumeSchedule[]; attempts: Array<AttemptRecord & { sessionId: string }>; paused: PausedRecord[] } {
    const empty = { schedules: [], attempts: [], paused: [] };
    try {
      if (!existsSync(this.deps.filePath)) return empty;
      const parsed = JSON.parse(readFileSync(this.deps.filePath, "utf-8")) as {
        schedules?: unknown;
        attempts?: unknown;
        paused?: unknown;
      };
      if (!parsed || typeof parsed !== "object") return empty;
      const schedules = Array.isArray(parsed.schedules) ? parsed.schedules.filter(isSchedule) : [];
      const attempts = Array.isArray(parsed.attempts)
        ? (parsed.attempts as unknown[]).filter((raw): raw is AttemptRecord & { sessionId: string } => {
          const a = raw as Record<string, unknown> | null;
          return !!a && typeof a.sessionId === "string" && typeof a.lastFiredAt === "number" && typeof a.rehits === "number";
        })
        : [];
      const paused = Array.isArray(parsed.paused)
        ? (parsed.paused as unknown[]).filter(
          (p): p is PausedRecord => isSchedule({ ...(p as object), fireAt: 0 }) && typeof (p as PausedRecord).pausedAt === "number",
        )
        : [];
      return { schedules, attempts, paused };
    } catch (err) {
      log.warn("auto-resume", "auto-resume file unreadable; starting empty", {
        event: "usage_limit.auto_resume.load_failed",
        error: err instanceof Error ? err.message : String(err),
      });
      return empty;
    }
  }

  private persist(): void {
    try {
      writeAtomicJson(
        this.deps.filePath,
        {
          version: FILE_VERSION,
          schedules: [...this.schedules.values()],
          attempts: [...this.attempts.entries()].map(([sessionId, a]) => ({ sessionId, ...a })),
          paused: [...this.paused.values()],
        },
        { maxBytes: Number.POSITIVE_INFINITY, space: 2 },
      );
    } catch (err) {
      log.warn("auto-resume", "auto-resume persist failed", {
        event: "usage_limit.auto_resume.persist_failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
