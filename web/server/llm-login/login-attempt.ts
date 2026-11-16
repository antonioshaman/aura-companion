import { randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { writeAtomicJson } from "../atomic-write.js";
import {
  assertNever,
  isTerminalLoginState,
  type Known,
  type LoginAttemptState,
  type LoginFailureReason,
  type ProviderId,
} from "../auth-status/auth-types.js";
import { log } from "../logger.js";
import { LoginTranscript, type LoginPrompt } from "./login-transcript.js";
import { loginPreflight, readProcStat, spawnLoginProcess, type LoginExit, type LoginProcess, type LoginProcessSpec } from "./login-runner.js";

/**
 * Sign-in attempts: a pure reducer over `LoginAttemptState` plus ONE executor
 * that reads top to bottom — preflight → staging dir + sentinel → spawn →
 * parse → (reply code) → exit → promote → finalize (phase 2 plan task 5).
 *
 *  - One attempt per provider; a second start returns the running one (S1-AC4).
 *  - TTL: Claude 10 min, Codex 15 min (the device code's own lifetime).
 *  - `finalize` is the single idempotent exit: timers, process, staging dir;
 *    the first outcome wins. Every async callback re-checks the attempt token
 *    (EC-41) and is wrapped in try/catch (EC-53).
 *  - The staging dir is `<attemptsRoot>/<128-bit hex>/` (0700, never from a
 *    request) with a sentinel written O_EXCL BEFORE the spawn (EC-8); the
 *    startup sweep removes only names of that shape and kills a leftover CLI
 *    only after re-verifying its identity (EC-45).
 *  - Claude's reply code is checked BEFORE it reaches the CLI's stdin.
 */

export const LOGIN_TTL_MS: Readonly<Record<ProviderId, number>> = { claude: 10 * 60_000, codex: 15 * 60_000 };
/** S1-AC1: link + code must be on screen within 10 s, else the output is not understood. */
export const LOGIN_READY_BUDGET_MS = 10_000;
/** Pause before a new attempt after a cancel or failure. */
export const LOGIN_COOLDOWN_MS = 10_000;
export const MAX_CODE_SUBMISSIONS = 5;
export const MAX_REPLY_CODE_LENGTH = 512;
/** Extra time the kernel-side `timeout` wrapper gives over the attempt TTL. */
const HARD_TTL_SLACK_MS = 30_000;

export const ATTEMPT_ID_PATTERN = /^[0-9a-f]{32}$/;
export const ATTEMPT_SENTINEL_FILE = "attempt.json";
export const ATTEMPT_SENTINEL_SCHEMA_VERSION = 1;
/** The CLI's private HOME inside the attempt dir. */
export const STAGING_HOME_DIR = "home";

// ─── Reducer ──────────────────────────────────────────────────────────────────

export interface LoginAttempt {
  id: string;
  provider: ProviderId;
  state: LoginAttemptState;
  /** Monotonic; bumps on every change so pollers can tell a new state. */
  version: number;
  startedAt: number;
  expiresAt: number;
  /** Link (+ Codex code). Present only while `awaiting_user` — secrets never outlive the attempt window. */
  prompt: LoginPrompt | null;
  failure: LoginFailureReason | null;
  /** Last refused reply code (attempt continues). */
  codeError: Extract<LoginFailureReason, "code_format" | "attempt_mismatch"> | null;
  submissions: number;
  submitting: boolean;
  /** Account / plan the promoted credentials report (S1-AC2). */
  result: { account: Known<string>; plan: Known<string> } | null;
}

export type LoginEvent =
  | { type: "prompt_ready"; prompt: LoginPrompt }
  | { type: "code_refused"; reason: Extract<LoginFailureReason, "code_format" | "attempt_mismatch"> }
  | { type: "code_submitted" }
  | { type: "cli_succeeded" }
  | { type: "promoted"; account: Known<string>; plan: Known<string> }
  | { type: "failed"; reason: LoginFailureReason }
  | { type: "cancelled" }
  | { type: "expired" };

/**
 * Pure transition. Unchanged input is returned as the same object (no version
 * bump); terminal states absorb every event. Cancel and expiry do not
 * interrupt `verifying`: the promotion is a short atomic step, and its outcome
 * (success or `promotion_failed` / `promotion_incomplete`) ends the attempt.
 */
export function reduceLoginAttempt(a: LoginAttempt, e: LoginEvent): LoginAttempt {
  if (isTerminalLoginState(a.state)) return a;
  const next = (patch: Partial<LoginAttempt>): LoginAttempt => {
    const n = { ...a, ...patch, version: a.version + 1 };
    if (isTerminalLoginState(n.state)) {
      n.prompt = null;
      n.submitting = false;
    }
    return n;
  };
  switch (e.type) {
    case "prompt_ready":
      return a.state === "starting" ? next({ state: "awaiting_user", prompt: e.prompt }) : a;
    case "code_refused":
      return a.state === "awaiting_user" ? next({ codeError: e.reason }) : a;
    case "code_submitted":
      if (a.state !== "awaiting_user" || a.submitting || a.submissions >= MAX_CODE_SUBMISSIONS) return a;
      return next({ submitting: true, submissions: a.submissions + 1, codeError: null });
    case "cli_succeeded":
      return a.state === "verifying" ? a : next({ state: "verifying", prompt: null, submitting: false });
    case "promoted":
      return a.state === "verifying" ? next({ state: "succeeded", result: { account: e.account, plan: e.plan } }) : a;
    case "failed":
      return next({ state: "failed", failure: e.reason });
    case "cancelled":
      return a.state === "verifying" ? a : next({ state: "cancelled" });
    case "expired":
      return a.state === "verifying" ? a : next({ state: "expired", failure: "expired" });
    default:
      return assertNever(e);
  }
}

// ─── Reply code (Claude) ──────────────────────────────────────────────────────

const CODE_PART = /^[A-Za-z0-9._~-]+$/;

/**
 * Claude's reply code is `<code>#<state>`. Checked before it touches the CLI:
 * exactly one `#`, both halves from the URL-safe alphabet, ≤512 chars, and the
 * suffix must equal this attempt's `state` (constant-time compare).
 */
export function checkReplyCode(raw: string, expectedState: string): { ok: true; line: string } | { ok: false; reason: "code_format" | "attempt_mismatch" } {
  const code = raw.trim();
  if (code.length === 0 || code.length > MAX_REPLY_CODE_LENGTH) return { ok: false, reason: "code_format" };
  const parts = code.split("#");
  if (parts.length !== 2 || !CODE_PART.test(parts[0]) || !CODE_PART.test(parts[1])) return { ok: false, reason: "code_format" };
  const got = Buffer.from(parts[1]);
  const want = Buffer.from(expectedState);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, reason: "attempt_mismatch" };
  return { ok: true, line: code };
}

// ─── Executor ─────────────────────────────────────────────────────────────────

export interface PromotionContext {
  attemptId: string;
  provider: ProviderId;
  attemptDir: string;
  stagingHome: string;
}

export type PromotionOutcome =
  | { ok: true; account: Known<string>; plan: Known<string> }
  /**
   * `promotion_failed`: nothing live changed. `promotion_incomplete`: the new
   * credentials are live but a later step failed — the attempt dir is KEPT
   * (startup recovery needs its staged account data).
   */
  | { ok: false; reason: Extract<LoginFailureReason, "promotion_failed" | "storage_split" | "promotion_incomplete"> };

export interface LoginAttemptsDeps {
  attemptsRoot: string;
  /** Absolute CLI path the sessions use; null when not found. */
  resolveCli: (provider: ProviderId) => string | null;
  platform: NodeJS.Platform;
  callerUser: string;
  callerUid: number;
  serviceUser: string | null;
  serviceEnv: NodeJS.ProcessEnv;
  /** Moves verified credentials in place (credential-promotion.ts). */
  promote: (ctx: PromotionContext) => Promise<PromotionOutcome>;
  /** Staging and the live credential dir share a filesystem (credential-promotion.ts `sameStorage`); absent = assume yes. */
  sameStorage?: (provider: ProviderId) => boolean;
  now?: () => number;
  ttlMs?: Partial<Record<ProviderId, number>>;
  readyBudgetMs?: number;
  cooldownMs?: number;
  killGraceMs?: number;
  /** Test seam; defaults to the real runner. */
  spawn?: typeof spawnLoginProcess;
  timeoutBinary?: string | null;
}

export type StartResult =
  | { kind: "started"; attempt: LoginAttempt }
  | { kind: "existing"; attempt: LoginAttempt }
  | { kind: "cooldown"; retryAfterMs: number; attempt: LoginAttempt | null }
  /** Preflight refused; the returned attempt is already terminal (`failed`) and nothing was spawned. */
  | { kind: "refused"; attempt: LoginAttempt };

export type SubmitResult =
  | { kind: "submitted"; attempt: LoginAttempt }
  | { kind: "refused"; reason: "code_format" | "attempt_mismatch"; attempt: LoginAttempt }
  /** Codex has no reply code. */
  | { kind: "not_applicable" }
  | { kind: "not_awaiting"; attempt: LoginAttempt | null }
  | { kind: "busy"; attempt: LoginAttempt }
  | { kind: "limit"; attempt: LoginAttempt };

interface Running {
  attempt: LoginAttempt;
  dir: string;
  process: LoginProcess | null;
  transcript: LoginTranscript;
  timers: ReturnType<typeof setTimeout>[];
  finalizing: Promise<void> | null;
  /** Keep the attempt dir for the promotion recovery (`promotion_incomplete`). */
  retainDir: boolean;
}

export class LoginAttempts {
  private readonly running = new Map<ProviderId, Running>();
  /** Last attempt per provider (also after it ended), for polling. */
  private readonly last = new Map<ProviderId, LoginAttempt>();
  private readonly cooldownUntil = new Map<ProviderId, number>();
  /** When the last attempt per provider ended (REST hides a finished attempt after a while). */
  private readonly ended = new Map<ProviderId, { id: string; at: number }>();

  constructor(private readonly deps: LoginAttemptsDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  current(provider: ProviderId): LoginAttempt | null {
    return this.running.get(provider)?.attempt ?? this.last.get(provider) ?? null;
  }

  /** Epoch ms the attempt reached a terminal state; null while it runs or when unknown. */
  endedAt(id: string): number | null {
    for (const e of this.ended.values()) if (e.id === id) return e.at;
    return null;
  }

  byId(id: string): LoginAttempt | null {
    for (const a of [...[...this.running.values()].map((r) => r.attempt), ...this.last.values()]) if (a.id === id) return a;
    return null;
  }

  async start(provider: ProviderId): Promise<StartResult> {
    const live = this.running.get(provider);
    if (live) return { kind: "existing", attempt: live.attempt };
    const until = this.cooldownUntil.get(provider) ?? 0;
    const now = this.now();
    if (now < until) return { kind: "cooldown", retryAfterMs: until - now, attempt: this.last.get(provider) ?? null };

    const id = randomBytes(16).toString("hex");
    const ttl = this.deps.ttlMs?.[provider] ?? LOGIN_TTL_MS[provider];
    const fresh: LoginAttempt = {
      id, provider, state: "starting", version: 1, startedAt: now, expiresAt: now + ttl,
      prompt: null, failure: null, codeError: null, submissions: 0, submitting: false, result: null,
    };

    const cliPath = this.deps.resolveCli(provider);
    // ritchie B4: refuse BEFORE the browser step when the rename can never be
    // atomic — otherwise the user signs in and only then gets a generic failure.
    const refusal = loginPreflight({
      provider, platform: this.deps.platform, callerUser: this.deps.callerUser, callerUid: this.deps.callerUid, serviceUser: this.deps.serviceUser, cliPath,
    }) ?? (this.deps.sameStorage && !this.deps.sameStorage(provider) ? "storage_split" as const : null);
    if (refusal) {
      const failed = reduceLoginAttempt(fresh, { type: "failed", reason: refusal });
      this.last.set(provider, failed);
      this.ended.set(provider, { id, at: now });
      logTransition(fresh, failed);
      return { kind: "refused", attempt: failed };
    }

    // Decide → marker → act (EC-8): the sentinel exists before any process does.
    const dir = join(this.deps.attemptsRoot, id);
    const stagingHome = join(dir, STAGING_HOME_DIR);
    mkdirSync(this.deps.attemptsRoot, { recursive: true, mode: 0o700 });
    mkdirSync(dir, { mode: 0o700 });
    mkdirSync(stagingHome, { mode: 0o700 });
    writeSentinelExclusive(dir, { schemaVersion: ATTEMPT_SENTINEL_SCHEMA_VERSION, attemptId: id, provider, pid: null, startTime: null, expiresAt: fresh.expiresAt });

    const run: Running = { attempt: fresh, dir, process: null, transcript: new LoginTranscript(provider), timers: [], finalizing: null, retainDir: false };
    this.running.set(provider, run);
    this.last.set(provider, fresh);

    const spec: LoginProcessSpec = {
      provider, cliPath: cliPath!, stagingHome, serviceEnv: this.deps.serviceEnv,
      hardTtlMs: ttl + HARD_TTL_SLACK_MS, killGraceMs: this.deps.killGraceMs,
      ...(this.deps.timeoutBinary !== undefined ? { timeoutBinary: this.deps.timeoutBinary } : {}),
    };
    const spawned = await (this.deps.spawn ?? spawnLoginProcess)(spec, (chunk, stream) => this.onOutput(id, provider, chunk, stream));
    if (!spawned.ok) {
      await this.finalize(provider, id, { type: "failed", reason: spawned.reason === "cli_missing" ? "cli_missing" : "cli_output_unrecognised" });
      return { kind: "started", attempt: this.current(provider)! };
    }
    run.process = spawned.process;
    this.guard(id, provider, "sentinel_update", () => {
      writeAtomicJson(join(dir, ATTEMPT_SENTINEL_FILE), {
        schemaVersion: ATTEMPT_SENTINEL_SCHEMA_VERSION, attemptId: id, provider,
        pid: spawned.process.pid, startTime: spawned.process.startTime, expiresAt: fresh.expiresAt,
      });
    });
    void spawned.process.exited.then((exit) => this.onExit(id, provider, exit)).catch((err) => warn("login_attempt.exit_handler_failed", provider, err));

    run.timers.push(
      setTimeout(() => this.guard(id, provider, "ttl", () => void this.finalize(provider, id, { type: "expired" })), ttl),
      setTimeout(() => this.guard(id, provider, "ready_budget", () => {
        if (this.liveRun(provider, id)?.attempt.state === "starting") void this.finalize(provider, id, { type: "failed", reason: "cli_output_unrecognised" });
      }), this.deps.readyBudgetMs ?? LOGIN_READY_BUDGET_MS),
    );
    // Output may already have arrived before `run.process` was set.
    this.applyVerdict(id, provider);
    return { kind: "started", attempt: this.current(provider)! };
  }

  /** Claude only: forward one reply code after checking it. */
  async submitCode(provider: ProviderId, attemptId: string, code: string): Promise<SubmitResult> {
    if (provider === "codex") return { kind: "not_applicable" };
    const run = this.running.get(provider);
    if (!run || run.attempt.state !== "awaiting_user") return { kind: "not_awaiting", attempt: this.current(provider) };
    if (run.attempt.id !== attemptId) {
      // A code typed into a stale window: refused without touching the running attempt.
      return { kind: "refused", reason: "attempt_mismatch", attempt: run.attempt };
    }
    if (run.attempt.submitting) return { kind: "busy", attempt: run.attempt };
    if (run.attempt.submissions >= MAX_CODE_SUBMISSIONS) return { kind: "limit", attempt: run.attempt };
    const prompt = run.attempt.prompt;
    if (!prompt || prompt.provider !== "claude") return { kind: "not_awaiting", attempt: run.attempt };
    const checked = checkReplyCode(code, prompt.state);
    if (!checked.ok) {
      this.apply(run, { type: "code_refused", reason: checked.reason });
      return { kind: "refused", reason: checked.reason, attempt: run.attempt };
    }
    if (!run.process?.writeLine(checked.line)) {
      await this.finalize(provider, attemptId, { type: "failed", reason: "cli_output_unrecognised" });
      return { kind: "not_awaiting", attempt: this.current(provider) };
    }
    this.apply(run, { type: "code_submitted" });
    return { kind: "submitted", attempt: run.attempt };
  }

  async cancel(provider: ProviderId, attemptId: string): Promise<LoginAttempt | null> {
    if (this.liveRun(provider, attemptId)) await this.finalize(provider, attemptId, { type: "cancelled" });
    return this.current(provider);
  }

  /** Server shutdown / tests: end every running attempt. */
  async shutdown(): Promise<void> {
    await Promise.all([...this.running.entries()].map(([p, r]) => this.finalize(p, r.attempt.id, { type: "cancelled" })));
  }

  // ─── internals ──────────────────────────────────────────────────────────────

  private liveRun(provider: ProviderId, id: string): Running | null {
    const run = this.running.get(provider);
    return run && run.attempt.id === id && !run.finalizing ? run : null;
  }

  private apply(run: Running, event: LoginEvent): void {
    const before = run.attempt;
    const after = reduceLoginAttempt(before, event);
    if (after === before) return;
    run.attempt = after;
    this.last.set(after.provider, after);
    logTransition(before, after);
  }

  private onOutput(id: string, provider: ProviderId, chunk: Buffer, stream: "stdout" | "stderr"): void {
    const run = this.running.get(provider);
    if (!run || run.attempt.id !== id) return;
    run.transcript.push(chunk, stream);
    if (run.process) this.applyVerdict(id, provider);
  }

  private applyVerdict(id: string, provider: ProviderId): void {
    const run = this.liveRun(provider, id);
    if (!run) return;
    const v = run.transcript.verdict();
    switch (v.kind) {
      case "pending": return;
      case "ready":
        this.apply(run, { type: "prompt_ready", prompt: v.prompt });
        return;
      case "failed":
        void this.finalize(provider, id, { type: "failed", reason: v.reason });
        return;
      case "unrecognised":
        void this.finalize(provider, id, { type: "failed", reason: "cli_output_unrecognised" });
        return;
      default:
        assertNever(v);
    }
  }

  private async onExit(id: string, provider: ProviderId, exit: LoginExit): Promise<void> {
    const run = this.liveRun(provider, id);
    if (!run || exit.killedByUs) return;
    if (exit.exitCode === 0 && !exit.outputCapped) {
      this.apply(run, { type: "cli_succeeded" });
      let outcome: PromotionOutcome;
      try {
        outcome = await this.deps.promote({ attemptId: id, provider, attemptDir: run.dir, stagingHome: join(run.dir, STAGING_HOME_DIR) });
      } catch (err) {
        warn("login_attempt.promote_threw", provider, err);
        outcome = { ok: false, reason: "promotion_failed" };
      }
      if (!outcome.ok && outcome.reason === "promotion_incomplete") run.retainDir = true;
      await this.finalize(provider, id, outcome.ok ? { type: "promoted", account: outcome.account, plan: outcome.plan } : { type: "failed", reason: outcome.reason });
      return;
    }
    // Non-zero: the transcript's reason if it has one; a Claude exit after a submitted code is the provider refusing it.
    const v = run.transcript.verdict();
    const reason: LoginFailureReason =
      v.kind === "failed" ? v.reason : run.attempt.submissions > 0 && provider === "claude" ? "code_rejected" : "cli_output_unrecognised";
    await this.finalize(provider, id, { type: "failed", reason });
  }

  /**
   * The one exit path. First outcome wins; later calls await the same work.
   * Order: record the outcome → stop timers → kill and reap the process →
   * remove the staging dir (after promotion moved files out on success).
   */
  private finalize(provider: ProviderId, id: string, event: LoginEvent): Promise<void> {
    const run = this.running.get(provider);
    if (!run || run.attempt.id !== id) return Promise.resolve();
    if (run.finalizing) return run.finalizing;
    this.apply(run, event);
    // An absorbed event (cancel / expiry while `verifying`) ends nothing: the
    // promotion in flight decides the outcome.
    if (!isTerminalLoginState(run.attempt.state)) return Promise.resolve();
    this.ended.set(provider, { id, at: this.now() });
    run.finalizing = (async () => {
      for (const t of run.timers) clearTimeout(t);
      try {
        await run.process?.kill();
      } catch (err) {
        warn("login_attempt.kill_failed", provider, err);
      }
      try {
        if (!run.retainDir) rmSync(run.dir, { recursive: true, force: true });
      } catch (err) {
        warn("login_attempt.cleanup_failed", provider, err);
      }
      if (run.attempt.state === "failed" || run.attempt.state === "cancelled") {
        this.cooldownUntil.set(provider, this.now() + (this.deps.cooldownMs ?? LOGIN_COOLDOWN_MS));
      }
      this.running.delete(provider);
    })();
    return run.finalizing;
  }

  /** EC-53: timer and callback bodies never throw out; a throw fails the attempt. */
  private guard(id: string, provider: ProviderId, what: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      warn(`login_attempt.${what}_failed`, provider, err);
      void this.finalize(provider, id, { type: "failed", reason: "cli_output_unrecognised" }).catch(() => {});
    }
  }
}

function logTransition(before: LoginAttempt, after: LoginAttempt): void {
  // No link, code, state or account in logs — only the shape of the change.
  log.info("llm-login", "login_attempt.transition", {
    event: "login_attempt.transition",
    provider: after.provider,
    attempt: after.id.slice(0, 8),
    from: before.state,
    to: after.state,
    ...(after.failure ? { reason: after.failure } : {}),
    ...(after.codeError && after.codeError !== before.codeError ? { codeError: after.codeError } : {}),
  });
}

function warn(event: string, provider: ProviderId, err: unknown): void {
  log.warn("llm-login", event, { event, provider, error: err instanceof Error ? err.name : "unknown" });
}

// ─── Sentinel + startup sweep ─────────────────────────────────────────────────

export interface AttemptSentinel {
  schemaVersion: number;
  attemptId: string;
  provider: ProviderId;
  pid: number | null;
  startTime: string | null;
  expiresAt: number;
}

function writeSentinelExclusive(dir: string, sentinel: AttemptSentinel): void {
  const fd = openSync(join(dir, ATTEMPT_SENTINEL_FILE), "wx", 0o600);
  try {
    writeSync(fd, JSON.stringify(sentinel));
  } finally {
    closeSync(fd);
  }
}

export function readAttemptSentinel(dir: string): AttemptSentinel | null {
  try {
    const v = JSON.parse(readFileSync(join(dir, ATTEMPT_SENTINEL_FILE), "utf-8")) as Partial<AttemptSentinel>;
    if (v.schemaVersion !== ATTEMPT_SENTINEL_SCHEMA_VERSION || typeof v.attemptId !== "string") return null;
    if (v.provider !== "claude" && v.provider !== "codex") return null;
    return {
      schemaVersion: v.schemaVersion, attemptId: v.attemptId, provider: v.provider,
      pid: typeof v.pid === "number" ? v.pid : null,
      startTime: typeof v.startTime === "string" ? v.startTime : null,
      expiresAt: typeof v.expiresAt === "number" ? v.expiresAt : 0,
    };
  } catch {
    return null;
  }
}

export interface SweepReport {
  removed: string[];
  killed: number[];
  /** Directories skipped (not an attempt id, or kept for promotion recovery). */
  skipped: string[];
}

/**
 * Startup sweep of attempts left by a previous server process. Only entries
 * named like an attempt id are touched. A leftover CLI is killed only if
 * /proc still shows the sentinel's pid with the sentinel's start time — the
 * identity is re-read right before each signal (EC-45). `keep(id)` lets the
 * promotion recovery hold a directory it still needs (task 6).
 */
export async function sweepOrphanAttempts(
  attemptsRoot: string,
  opts: { keep?: (attemptId: string) => boolean; killGraceMs?: number } = {},
): Promise<SweepReport> {
  const report: SweepReport = { removed: [], killed: [], skipped: [] };
  let names: string[];
  try {
    names = readdirSync(attemptsRoot);
  } catch {
    return report;
  }
  for (const name of names) {
    if (!ATTEMPT_ID_PATTERN.test(name) || opts.keep?.(name)) {
      report.skipped.push(name);
      continue;
    }
    const dir = join(attemptsRoot, name);
    const sentinel = readAttemptSentinel(dir);
    if (sentinel?.pid && sentinel.startTime) {
      const { pid, startTime } = sentinel;
      const same = () => readProcStat(pid)?.startTime === startTime;
      if (same()) {
        report.killed.push(pid);
        try { if (same()) process.kill(-pid, "SIGTERM"); } catch { /* gone */ }
        const until = Date.now() + (opts.killGraceMs ?? 2_000);
        while (same() && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
        try { if (same()) process.kill(-pid, "SIGKILL"); } catch { /* gone */ }
      }
    }
    try {
      rmSync(dir, { recursive: true, force: true });
      report.removed.push(name);
    } catch (err) {
      log.warn("llm-login", "login_attempt.sweep_failed", { event: "login_attempt.sweep_failed", attempt: name.slice(0, 8), error: err instanceof Error ? err.name : "unknown" });
    }
  }
  if (report.removed.length || report.killed.length) {
    log.info("llm-login", "login_attempt.swept", { event: "login_attempt.swept", removed: report.removed.length, killed: report.killed.length });
  }
  return report;
}
