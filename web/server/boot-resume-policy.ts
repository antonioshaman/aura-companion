/**
 * Boot-resume policy (W2 hardening): which sessions alive before a restart are
 * worth reviving at boot, and how many relaunches may run at once.
 *
 * - Age filter: a session whose last activity is older than
 *   `COMPANION_BOOT_RESUME_MAX_AGE_HOURS` (default 72, `0` = off) is NOT
 *   revived at boot. It stays `exited` with its `cliSessionId`, so the next
 *   browser message resumes it through the normal relaunch path.
 * - Concurrency cap: at most `COMPANION_BOOT_RESUME_CONCURRENCY` (default 3)
 *   boot relaunches in flight. A slot is held until the relaunch settles or
 *   `COMPANION_BOOT_RESUME_SLOT_TIMEOUT_MS` (default 120 s) passes, so one
 *   hung relaunch cannot block the rest of the queue.
 *
 * Pure helpers + a tiny limiter; `SessionRecovery.scheduleBootResume` wires them.
 */

export const DEFAULT_BOOT_RESUME_MAX_AGE_HOURS = 72;
export const DEFAULT_BOOT_RESUME_CONCURRENCY = 3;
export const DEFAULT_BOOT_RESUME_SLOT_TIMEOUT_MS = 120_000;

const HOUR_MS = 3_600_000;

/** Non-negative number of hours; `0` disables the filter; missing/invalid → default. */
export function parseBootResumeMaxAgeHours(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_BOOT_RESUME_MAX_AGE_HOURS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_BOOT_RESUME_MAX_AGE_HOURS;
}

/** Positive integer; missing/invalid/zero/negative → default. */
export function parseBootResumeConcurrency(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_BOOT_RESUME_CONCURRENCY;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_BOOT_RESUME_CONCURRENCY;
}

/** Positive milliseconds; missing/invalid → default. */
export function parseBootResumeSlotTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_BOOT_RESUME_SLOT_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_BOOT_RESUME_SLOT_TIMEOUT_MS;
}

/**
 * Best known "last activity" of a session: the newest `timestamp` in its
 * persisted message history (user messages always carry one; assistant /
 * system events usually do), else `createdAt`. Returns `undefined` when
 * nothing usable exists (no timestamped entry and `createdAt` missing or 0) —
 * callers treat unknown age as fresh, i.e. fail open to the old behaviour.
 */
export function lastActivityAt(
  history: ReadonlyArray<unknown> | undefined,
  createdAt: number | undefined,
): number | undefined {
  let best = 0;
  if (history) {
    for (const entry of history) {
      const ts = (entry as { timestamp?: unknown } | null)?.timestamp;
      if (typeof ts === "number" && Number.isFinite(ts) && ts > best) best = ts;
    }
  }
  if (best > 0) return best;
  return typeof createdAt === "number" && Number.isFinite(createdAt) && createdAt > 0 ? createdAt : undefined;
}

/**
 * Age in hours when the session is too old to auto-resume, else `null`.
 * `maxAgeHours === 0` disables the filter; an unknown last activity is never stale.
 */
export function staleAgeHours(
  lastActivity: number | undefined,
  maxAgeHours: number,
  now: number,
): number | null {
  if (maxAgeHours <= 0 || lastActivity === undefined) return null;
  const ageMs = now - lastActivity;
  if (ageMs <= maxAgeHours * HOUR_MS) return null;
  return Math.round((ageMs / HOUR_MS) * 10) / 10;
}

/**
 * FIFO concurrency limiter. `run(task)` waits for a free slot, starts `task`,
 * and frees the slot when the task settles (resolve OR reject) or when
 * `slotTimeoutMs` elapses — whichever comes first. The returned promise
 * resolves when the slot is freed (with how it was freed); it never rejects.
 */
export class BootResumeLimiter {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(
    readonly maxConcurrent: number,
    private readonly slotTimeoutMs: number,
  ) {}

  get inFlight(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiters.length;
  }

  async run(task: () => Promise<unknown>): Promise<"settled" | "timeout"> {
    if (this.active >= this.maxConcurrent) {
      // The releasing task hands its slot over directly (`active` unchanged),
      // so a concurrent `run()` can never slip in between and exceed the cap.
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    } else {
      this.active++;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), this.slotTimeoutMs);
    });
    let settled: Promise<unknown>;
    try {
      settled = task().catch(() => undefined);
    } catch {
      settled = Promise.resolve();
    }
    try {
      const outcome = await Promise.race([settled, timedOut]);
      return outcome === "timeout" ? "timeout" : "settled";
    } finally {
      clearTimeout(timer);
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    }
  }
}
