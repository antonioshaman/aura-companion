import { PROVIDER_IDS, type ProviderId, type TurnFailure } from "./auth-status/auth-types.js";
import { readEpoch, type ProviderEpoch } from "./llm-login/credential-promotion.js";
import { LLM_AUTH_STATE_DIR } from "./llm-login/state-dir.js";
import { log } from "./logger.js";
import type { CredentialRenewalRecord } from "./session-types.js";

/**
 * Live sessions move to a new sign-in (LLM auth phase 2, task 13, plan D1).
 *
 * A successful promotion bumps the provider's EPOCH (`epoch-<provider>.json`,
 * written only by `promoteCredentials`). Every session remembers the epoch it
 * was launched on (`credentialEpochAtLaunch`); a live session on a lower epoch
 * runs on the old sign-in — Codex holds the token in memory from start, a
 * Claude process may write its stale refresh result over the fresh file. Such
 * a session is relaunched with `--resume` (`relaunchOnce(…, "credentials_renewed")`)
 * at its first idle moment: idle ones at once, one at a time; one mid-turn
 * after its turn ends. Nothing is ever re-sent to the CLI: the relaunch is a
 * process swap, a failed turn is retried only by the user's click.
 *
 * The epoch is NOT the stat-based `CredentialGeneration` of phase 1: a Claude
 * session refreshing its token in place changes the file's metadata all the
 * time, the epoch changes only on a sign-in.
 *
 * Claude barrier (`beforePromote`): before the rename, live Claude processes
 * are stopped — idle ones at once, busy ones after their turn, waiting at most
 * {@link BARRIER_WAIT_MS}. After the timeout the promotion goes ahead; the
 * sessions still busy are relaunched after their turn and the UI says so. For
 * Codex the barrier is a no-op: each Codex session refreshes into its OWN
 * copy (`prepareCodexHome`), never into the primary file being replaced.
 *
 * Gate: the bridge asks {@link CredentialRenewal.holdUserMessage} at its one
 * `user_message` point (browser, Retry, `injectUserMessage` — cron, auto-resume,
 * REST, council peer) and the council wake senders ask
 * {@link CredentialRenewal.isHolding}. While a session is being renewed its
 * input is held in the bridge's pending queue and delivered once, to the new
 * process.
 */

export const BARRIER_WAIT_MS = 10 * 60_000;
/** How long after a promotion the live file is watched for a running session writing over it. */
export const OVERWRITE_WATCH_MS = 10 * 60_000;
export const OVERWRITE_WATCH_TICK_MS = 30_000;

export function currentCredentialEpoch(provider: ProviderId, stateDir: string = LLM_AUTH_STATE_DIR): number {
  return readEpoch(stateDir, provider)?.epoch ?? 0;
}

/** What the renewal needs to know about one session. */
export interface RenewalSession {
  sessionId: string;
  provider: ProviderId;
  /** A CLI process is running (not `exited`). */
  alive: boolean;
  archived: boolean;
  /** Containers carry their own credentials; a host sign-in does not reach them. */
  containerized: boolean;
  /** Epoch the session was launched on; absent (older sessions) = current. */
  credentialEpochAtLaunch?: number;
}

/**
 * Pure: the session runs on an older sign-in than the provider's current one.
 * A session without the field counts as current — the failure card stays the
 * fallback for it.
 */
export function needsRenewalRelaunch(session: RenewalSession, epochs: Readonly<Record<ProviderId, number>>): boolean {
  if (!session.alive || session.archived || session.containerized) return false;
  if (session.credentialEpochAtLaunch === undefined) return false;
  return session.credentialEpochAtLaunch < epochs[session.provider];
}

/**
 * - `stopping`: barrier — busy, waiting for its turn to end before the stop;
 * - `stopped`: barrier — process stopped, waits for the promotion;
 * - `after_turn`: on the old sign-in and mid-turn; relaunched when the turn ends;
 * - `queued` / `relaunching`: in the one-at-a-time relaunch queue.
 */
export type RenewalPhase = "stopping" | "stopped" | "after_turn" | "queued" | "relaunching";

interface Tracked {
  provider: ProviderId;
  phase: RenewalPhase;
  /** Barrier stop: this module owns the intentional mark until the relaunch ends (EC-52). */
  ownsStopMark: boolean;
  promotedAt: number | null;
}

export interface RenewalSummary {
  /** Sessions whose turn the barrier is waiting for. */
  waitingForTurn: number;
  /** Sessions being moved to the new sign-in (stopped / queued / relaunching / after their turn). */
  reconnecting: number;
  /** Claude sessions still busy when the barrier timed out (last promotion). */
  busyAtPromotion: number;
  /** Sessions of the provider whose last turn failed on sign-in — they wait for the user's Retry. */
  awaitingRetry: number;
  /** The live file changed after the promotion to something other than the promoted file. */
  credentialsReplaced: boolean;
}

export interface RelaunchResult {
  ok: boolean;
  error?: string;
}

export interface CredentialRenewalDeps {
  listSessions: () => RenewalSession[];
  getSession: (sessionId: string) => RenewalSession | null;
  currentEpoch: (provider: ProviderId) => number;
  /** The provider's epoch record (promotion time, promoted fingerprint); default: the state dir. */
  readEpoch?: (provider: ProviderId) => ProviderEpoch | null;
  /** Mid-turn (streaming / awaiting permission / compacting). */
  isBusy: (sessionId: string) => boolean;
  /** Stop the CLI process (the caller already marked it intentional). */
  stop: (sessionId: string) => Promise<void>;
  /** `SessionRecovery.relaunchOnce(id, "credentials_renewed")` — `--resume`. */
  relaunch: (sessionId: string) => Promise<RelaunchResult>;
  /** `IntentionalKills.addTransient` / `releaseTransient` (EC-2 / EC-52). */
  markIntentional: (sessionId: string) => boolean;
  releaseIntentional: (sessionId: string) => void;
  /** Other members of the session's live council group (empty when solo). */
  groupPeers: (sessionId: string) => string[];
  /** `session_update { credential_renewal }` — persisted, replayed on reload. */
  publish: (sessionId: string, record: CredentialRenewalRecord | null) => void;
  /** Deliver the held input to the (new) process — once. */
  releaseHeld: (sessionId: string) => void;
  /** Relaunch failed: drop the held user messages and show a "turn needs to be repeated" card. */
  failHeld: (sessionId: string, failure: TurnFailure) => void;
  /** After a renewal relaunch (council: catch up a wake held meanwhile). */
  onRelaunched?: (sessionId: string) => void;
  /** Last turn of the session failed on sign-in and was not retried. */
  hasPendingSignInRetry: (sessionId: string) => boolean;
  /** sha256 of the provider's live credential file (overwrite watch). */
  liveFingerprint?: (provider: ProviderId) => string | null;
  now?: () => number;
  barrierWaitMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

const BUSY_PHASES = new Set(["streaming", "awaiting_permission", "compacting"]);

/** Bridge phase → mid-turn. */
export function isBusyPhase(phase: string | undefined): boolean {
  return phase !== undefined && BUSY_PHASES.has(phase);
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class CredentialRenewal {
  private readonly tracked = new Map<string, Tracked>();
  private readonly queue: string[] = [];
  private draining = false;
  /** Barrier: resolvers waiting for a session's turn to end. */
  private readonly idleWaiters = new Map<string, () => void>();
  private readonly busyAtPromotion = new Map<ProviderId, number>();
  private readonly replaced = new Map<ProviderId, boolean>();
  private readonly watches = new Map<ProviderId, unknown>();
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly deps: CredentialRenewalDeps) {
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((fn, ms) => {
      const t = setTimeout(fn, ms);
      (t as { unref?: () => void }).unref?.();
      return t;
    });
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  // ─── Gate (bridge) ──────────────────────────────────────────────────────────

  /** Input to this session is held (barrier, queue or relaunch in progress). */
  isHolding(sessionId: string): boolean {
    return this.tracked.has(sessionId);
  }

  /**
   * The one call at the bridge's `user_message` point. True → the bridge keeps
   * the message in its pending queue. A session found on an old epoch here
   * (e.g. after a server restart) is renewed now — one relaunch however many
   * messages arrive meanwhile.
   */
  holdUserMessage(sessionId: string): boolean {
    if (this.tracked.has(sessionId)) return true;
    const session = this.deps.getSession(sessionId);
    if (!session || !needsRenewalRelaunch(session, this.epochs())) return false;
    this.schedule(session, null);
    this.drain();
    return true;
  }

  /**
   * A sign-in failure of a session that is still on the old epoch is the
   * stale-copy case, whatever the provider said (Claude never compares
   * generations itself): "this turn needs to be repeated", not "sign in again".
   */
  adjustTurnFailure(sessionId: string, failure: TurnFailure): TurnFailure {
    if (failure.kind !== "auth_rejected") return failure;
    const session = this.deps.getSession(sessionId);
    const stale = this.tracked.has(sessionId) || (session !== null && needsRenewalRelaunch(session, this.epochs()));
    if (!stale) return failure;
    const { credentialsCompared: _drop, ...rest } = failure;
    return { ...rest, kind: "stale_session_credentials" };
  }

  /** `session:phase-changed` from the bridge. */
  notePhase(sessionId: string, phase: string): void {
    const t = this.tracked.get(sessionId);
    if (!t || isBusyPhase(phase)) return;
    if (t.phase === "stopping") {
      this.idleWaiters.get(sessionId)?.();
      return;
    }
    if (t.phase === "after_turn") {
      if (phase === "terminated") {
        // The process died on its own; whoever relaunches it launches on the new epoch.
        this.untrack(sessionId);
        this.deps.publish(sessionId, null);
        this.deps.releaseHeld(sessionId);
        return;
      }
      if (phase === "ready") {
        t.phase = "queued";
        this.queue.push(sessionId);
        this.drain();
      }
    }
  }

  // ─── Barrier (promotion) ──────────────────────────────────────────────────

  /**
   * Before the rename. Claude: stop every live host Claude process (idle at
   * once, busy after its turn, ≤ barrier wait). Codex: nothing to stop.
   * Never throws (a throw would fail the promotion).
   */
  async beforePromote(provider: ProviderId): Promise<void> {
    this.busyAtPromotion.delete(provider);
    if (provider === "codex") return;
    const targets = this.deps.listSessions().filter((s) => s.provider === provider && s.alive && !s.archived && !s.containerized && !this.tracked.has(s.sessionId));
    if (targets.length === 0) return;
    const busy: string[] = [];
    for (const s of targets) {
      this.tracked.set(s.sessionId, { provider, phase: "stopping", ownsStopMark: false, promotedAt: null });
      if (this.deps.isBusy(s.sessionId)) busy.push(s.sessionId);
    }
    for (const s of targets) {
      if (!busy.includes(s.sessionId)) await this.stopForBarrier(s.sessionId);
    }
    if (busy.length > 0) {
      log.info("credential-renewal", "waiting for busy sessions before the promotion", {
        event: "credential_renewal.barrier_waiting", provider, sessions: busy.length,
      });
      const deadline = this.now() + (this.deps.barrierWaitMs ?? BARRIER_WAIT_MS);
      const leftBusy: string[] = [];
      await Promise.all(busy.map(async (id) => {
        const idle = await this.waitIdle(id, Math.max(0, deadline - this.now()));
        if (idle) await this.stopForBarrier(id);
        else leftBusy.push(id);
      }));
      for (const id of leftBusy) {
        const t = this.tracked.get(id);
        if (t) t.phase = "after_turn";
      }
      if (leftBusy.length > 0) {
        this.busyAtPromotion.set(provider, leftBusy.length);
        log.warn("credential-renewal", "busy sessions still running at promotion", {
          event: "credential_renewal.barrier_timeout", provider, sessions: leftBusy.length,
        });
      }
    }
  }

  private async stopForBarrier(sessionId: string): Promise<void> {
    const t = this.tracked.get(sessionId);
    if (!t) return;
    // EC-52: mark before the kill; released after the relaunch (or the restore).
    t.ownsStopMark = this.deps.markIntentional(sessionId);
    try {
      await this.deps.stop(sessionId);
    } catch (err) {
      log.warn("credential-renewal", "barrier stop failed", { event: "credential_renewal.stop_failed", sessionId, error: errorName(err) });
    }
    t.phase = "stopped";
  }

  private waitIdle(sessionId: string, ms: number): Promise<boolean> {
    if (!this.deps.isBusy(sessionId)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = this.setTimer(() => {
        this.idleWaiters.delete(sessionId);
        resolve(false);
      }, ms);
      this.idleWaiters.set(sessionId, () => {
        this.clearTimer(timer);
        this.idleWaiters.delete(sessionId);
        resolve(true);
      });
    });
  }

  /**
   * The promotion ended. Success: every live session of the provider on an
   * older epoch (and every one the barrier stopped) is moved to the new
   * sign-in. Failure: the epoch did not move — the barrier's stopped sessions
   * come back as they were (on the unchanged credentials), nobody else is
   * touched (S3-AC4). Never throws.
   */
  promotionSettled(provider: ProviderId, ok: boolean, promotedAt: number | null): void {
    try {
      if (!ok) {
        this.busyAtPromotion.delete(provider);
        for (const [id, t] of [...this.tracked]) {
          if (t.provider !== provider) continue;
          if (t.phase === "stopped") {
            t.phase = "queued";
            this.queue.push(id);
          } else if (t.phase === "stopping" || t.phase === "after_turn") {
            this.untrack(id);
            this.deps.releaseHeld(id);
          }
        }
        this.drain();
        return;
      }
      const at = promotedAt ?? this.now();
      const epochs = this.epochs();
      for (const [id, t] of this.tracked) {
        if (t.provider !== provider) continue;
        t.promotedAt = at;
        if (t.phase === "stopped") {
          t.phase = "queued";
          this.queue.push(id);
        }
        this.deps.publish(id, { provider, promotedAt: at, state: "reconnecting" });
      }
      for (const s of this.deps.listSessions()) {
        if (s.provider !== provider || this.tracked.has(s.sessionId)) continue;
        if (needsRenewalRelaunch(s, epochs)) this.schedule(s, at);
      }
      this.drain();
      this.watchOverwrite(provider);
    } catch (err) {
      log.warn("credential-renewal", "renewal scheduling failed", { event: "credential_renewal.schedule_failed", provider, error: errorName(err) });
    }
  }

  private schedule(session: RenewalSession, promotedAt: number | null): void {
    const busy = this.deps.isBusy(session.sessionId);
    const at = promotedAt ?? this.lastPromotedAt(session.provider);
    this.tracked.set(session.sessionId, { provider: session.provider, phase: busy ? "after_turn" : "queued", ownsStopMark: false, promotedAt: at });
    if (!busy) this.queue.push(session.sessionId);
    this.deps.publish(session.sessionId, { provider: session.provider, promotedAt: at, state: "reconnecting" });
  }

  private lastPromotedAt(provider: ProviderId): number {
    return this.epochRecord(provider)?.promotedAt ?? this.now();
  }

  private epochRecord(provider: ProviderId): ProviderEpoch | null {
    return (this.deps.readEpoch ?? ((p: ProviderId) => readEpoch(LLM_AUTH_STATE_DIR, p)))(provider);
  }

  // ─── Sequential relaunch ──────────────────────────────────────────────────

  private drain(): void {
    if (this.draining) return;
    this.draining = true;
    // EC-53: fire-and-forget with a top-level catch.
    void (async () => {
      try {
        for (let id = this.queue.shift(); id !== undefined; id = this.queue.shift()) {
          await this.relaunchOne(id);
        }
      } catch (err) {
        log.warn("credential-renewal", "relaunch queue failed", { event: "credential_renewal.queue_failed", error: errorName(err) });
      } finally {
        this.draining = false;
        if (this.queue.length > 0) this.drain();
      }
    })();
  }

  private async relaunchOne(sessionId: string): Promise<void> {
    const t = this.tracked.get(sessionId);
    if (!t || t.phase !== "queued") return;
    const session = this.deps.getSession(sessionId);
    if (session?.archived) {
      // Archived meanwhile: nothing to bring back.
      this.untrack(sessionId);
      this.deps.publish(sessionId, null);
      return;
    }
    t.phase = "relaunching";
    // EC-2: a council half — both ids are intentional before the kill.
    const marks = [sessionId, ...this.deps.groupPeers(sessionId)].filter((id) => this.deps.markIntentional(id));
    let result: RelaunchResult;
    try {
      result = await this.deps.relaunch(sessionId);
    } catch (err) {
      result = { ok: false, error: errorName(err) };
    } finally {
      for (const id of marks) this.deps.releaseIntentional(id);
    }
    this.untrack(sessionId);
    const renewed = t.promotedAt !== null;
    if (result.ok) {
      log.info("credential-renewal", "renewal relaunch done", {
        event: "credential_renewal.relaunched", sessionId, provider: t.provider, renewed,
      });
      this.deps.publish(sessionId, renewed ? { provider: t.provider, promotedAt: t.promotedAt as number, state: "renewed" } : null);
      this.deps.releaseHeld(sessionId);
      try {
        this.deps.onRelaunched?.(sessionId);
      } catch (err) {
        log.warn("credential-renewal", "post-relaunch hook failed", { event: "credential_renewal.post_relaunch_failed", sessionId, error: errorName(err) });
      }
      return;
    }
    log.warn("credential-renewal", "relaunch onto the new sign-in failed", {
      event: "credential_renewal.relaunch_failed", sessionId, provider: t.provider, error: result.error ?? "unknown",
    });
    if (renewed) this.deps.publish(sessionId, { provider: t.provider, promotedAt: t.promotedAt as number, state: "failed" });
    this.deps.failHeld(sessionId, {
      kind: "stale_session_credentials",
      provider: t.provider,
      providerMessage: `Reconnecting with the new sign-in failed: ${result.error ?? "unknown error"}`,
    });
  }

  private untrack(sessionId: string): void {
    const t = this.tracked.get(sessionId);
    if (!t) return;
    this.tracked.delete(sessionId);
    if (t.ownsStopMark) this.deps.releaseIntentional(sessionId);
  }

  // ─── Overwrite watch ─────────────────────────────────────────────────────

  /**
   * For {@link OVERWRITE_WATCH_MS} after a promotion, compare the live file
   * with the promoted one. A change means a running process wrote over the
   * fresh sign-in (or refreshed it): made visible, never acted on.
   */
  private watchOverwrite(provider: ProviderId): void {
    if (!this.deps.liveFingerprint) return;
    const promoted = this.epochRecord(provider)?.fingerprint ?? null;
    this.replaced.delete(provider);
    const previous = this.watches.get(provider);
    if (previous !== undefined) this.clearTimer(previous);
    if (!promoted) return;
    const until = this.now() + OVERWRITE_WATCH_MS;
    const tick = (): void => {
      try {
        const live = this.deps.liveFingerprint?.(provider) ?? null;
        if (live !== null && live !== promoted) {
          this.replaced.set(provider, true);
          log.warn("credential-renewal", "live credentials changed after the sign-in", {
            event: "credential_renewal.credentials_replaced", provider,
          });
          this.watches.delete(provider);
          return;
        }
        if (this.now() < until) this.watches.set(provider, this.setTimer(tick, OVERWRITE_WATCH_TICK_MS));
        else this.watches.delete(provider);
      } catch (err) {
        log.warn("credential-renewal", "overwrite watch failed", { event: "credential_renewal.watch_failed", provider, error: errorName(err) });
      }
    };
    this.watches.set(provider, this.setTimer(tick, OVERWRITE_WATCH_TICK_MS));
  }

  // ─── Read side ────────────────────────────────────────────────────────────

  summary(provider: ProviderId): RenewalSummary {
    let waitingForTurn = 0;
    let reconnecting = 0;
    for (const t of this.tracked.values()) {
      if (t.provider !== provider) continue;
      if (t.phase === "stopping") waitingForTurn++;
      else reconnecting++;
    }
    let awaitingRetry = 0;
    for (const s of this.deps.listSessions()) {
      if (s.provider === provider && !s.archived && this.deps.hasPendingSignInRetry(s.sessionId)) awaitingRetry++;
    }
    return {
      waitingForTurn,
      reconnecting,
      busyAtPromotion: this.busyAtPromotion.get(provider) ?? 0,
      awaitingRetry,
      credentialsReplaced: this.replaced.get(provider) ?? false,
    };
  }

  phaseOf(sessionId: string): RenewalPhase | null {
    return this.tracked.get(sessionId)?.phase ?? null;
  }

  private epochs(): Record<ProviderId, number> {
    const out = {} as Record<ProviderId, number>;
    for (const p of PROVIDER_IDS) out[p] = this.deps.currentEpoch(p);
    return out;
  }

  dispose(): void {
    for (const h of this.watches.values()) this.clearTimer(h);
    this.watches.clear();
  }
}

// ─── The one instance per server ─────────────────────────────────────────────

let instance: CredentialRenewal | null = null;

/** Set by the orchestrator at start; read by the sign-in wiring (barrier, settle). */
export function setCredentialRenewal(renewal: CredentialRenewal | null): void {
  instance = renewal;
}

export function getCredentialRenewal(): CredentialRenewal | null {
  return instance;
}
