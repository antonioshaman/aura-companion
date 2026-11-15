import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { writeAtomicJson } from "../atomic-write.js";
import { assertNever, PROVIDER_IDS, type ProviderAuthStatus, type ProviderId } from "../auth-status/auth-types.js";
import { log } from "../logger.js";
import { STAGING_HOME_DIR, type PromotionContext, type PromotionOutcome } from "./login-attempt.js";

/**
 * The ONLY module that writes the live credential files —
 * `~/.claude/.credentials.json`, `~/.claude.json` (only its `oauthAccount`
 * key) and `~/.codex/auth.json` — guarded by `credential-write-sites.guard.test.ts`
 * (phase 2 plan task 6).
 *
 * A promotion moves the file a successful official sign-in wrote into the
 * attempt's staging home over the live one, with rename(2) on the same
 * filesystem — never a copy, never a backup of the old credentials (🚫 spec:
 * no independent copies). Order:
 *
 *   validate the staged file (regular, not a symlink, nlink 1, our uid,
 *   ≤64KB, parses, 0600) → phase-1 probe against the staging home (account /
 *   plan) → same filesystem (EXDEV → fail closed) → barrier `beforePromote`
 *   (2d stops Claude writers here) → JOURNAL written → rename + fsync dir →
 *   (Claude) merge `oauthAccount` into `~/.claude.json` → epoch written →
 *   status told (`noteCredentialsPromoted`) → journal deleted.
 *
 * The journal makes the rename-to-epoch window crash-safe: at startup
 * `recoverPromotions` finishes a promotion whose live file already carries
 * the new fingerprint and drops one that never reached the rename. There is
 * no rollback — it would need a copy of the old credentials.
 */

export const PROMOTION_SCHEMA_VERSION = 1;
export const MAX_STAGED_CREDENTIAL_BYTES = 64 * 1024;
const ACCOUNT_MERGE_ATTEMPTS = 3;

export type PromotionStep = "credentials_renamed" | "account_merged" | "epoch_written";

export interface PromotionJournal {
  schemaVersion: number;
  provider: ProviderId;
  attemptId: string;
  targetEpoch: number;
  /** sha256 of the staged credential file — what the live file must equal after the rename. */
  newFingerprint: string;
  steps: PromotionStep[];
}

export interface ProviderEpoch {
  schemaVersion: number;
  /** Bumps on every successful promotion; sessions launched on a lower epoch are stale (2d). */
  epoch: number;
  promotedAt: number;
  fingerprint: string;
}

/** What the status core learns after a promotion. */
export interface PromotedCredentials {
  provider: ProviderId;
  /** sha256 of the promoted file. */
  fingerprint: string;
  /** Codex: locator fingerprint of the access token (the D8 evidence key); null for Claude. */
  tokenFingerprint: string | null;
  promotedAt: number;
}

export interface PromotionDeps {
  /** Service environment (HOME, CLAUDE_CONFIG_DIR, CODEX_HOME decide the live paths). */
  serviceEnv: NodeJS.ProcessEnv;
  /** Dir holding the journal and epoch files (`~/.companion/llm-auth`). */
  stateDir: string;
  /** The service user's uid (the staged file must be ours). */
  uid: number;
  /** Phase-1 status probe pointed at the staging home (no model tokens spent). */
  probeStaged: (provider: ProviderId, stagingHome: string) => Promise<ProviderAuthStatus>;
  /** Codex: access-token fingerprint of an auth.json file (credential-locator), the D8 evidence key. */
  codexTokenFingerprint: (authJsonPath: string) => string | null;
  /** Barrier before the first rename (2a: no-op; 2d stops live Claude writers). */
  beforePromote?: (provider: ProviderId) => Promise<void>;
  noteCredentialsPromoted: (promoted: PromotedCredentials) => void | Promise<void>;
  now?: () => number;
  /** Test seam: throws at a step to simulate a crash (the process "dies" there). */
  crashAt?: (point: "before_rename" | PromotionStep) => void;
}

// ─── Paths ────────────────────────────────────────────────────────────────────

export interface LiveCredentialPaths {
  /** The credential file sessions read. */
  credentials: string;
  /** Claude's `.claude.json` (account info); null for Codex. */
  accountConfig: string | null;
}

/** Where the service's sessions read credentials (the CLIs' own resolution rules). */
export function liveCredentialPaths(provider: ProviderId, env: NodeJS.ProcessEnv): LiveCredentialPaths {
  const home = env.HOME ?? "";
  switch (provider) {
    case "claude": {
      const dir = env.CLAUDE_CONFIG_DIR || join(home, ".claude");
      return { credentials: join(dir, ".credentials.json"), accountConfig: env.CLAUDE_CONFIG_DIR ? join(dir, ".claude.json") : join(home, ".claude.json") };
    }
    case "codex":
      return { credentials: join(env.CODEX_HOME || join(home, ".codex"), "auth.json"), accountConfig: null };
    default:
      return assertNever(provider);
  }
}

/** The same files inside an attempt's staging home (the runner sets CLAUDE_CONFIG_DIR / CODEX_HOME). */
export function stagedCredentialPaths(provider: ProviderId, stagingHome: string): LiveCredentialPaths {
  switch (provider) {
    case "claude":
      return { credentials: join(stagingHome, ".claude", ".credentials.json"), accountConfig: join(stagingHome, ".claude", ".claude.json") };
    case "codex":
      return { credentials: join(stagingHome, ".codex", "auth.json"), accountConfig: null };
    default:
      return assertNever(provider);
  }
}

const journalPath = (stateDir: string, provider: ProviderId) => join(stateDir, `promotion-${provider}.json`);
const epochPath = (stateDir: string, provider: ProviderId) => join(stateDir, `epoch-${provider}.json`);

export function sha256File(path: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

// ─── Epoch ────────────────────────────────────────────────────────────────────

export function readEpoch(stateDir: string, provider: ProviderId): ProviderEpoch | null {
  try {
    const v = JSON.parse(readFileSync(epochPath(stateDir, provider), "utf-8")) as Partial<ProviderEpoch>;
    if (v.schemaVersion !== PROMOTION_SCHEMA_VERSION || typeof v.epoch !== "number" || !Number.isInteger(v.epoch) || v.epoch < 0) return null;
    return { schemaVersion: v.schemaVersion, epoch: v.epoch, promotedAt: Number(v.promotedAt) || 0, fingerprint: String(v.fingerprint ?? "") };
  } catch {
    return null;
  }
}

function writeEpoch(stateDir: string, provider: ProviderId, epoch: ProviderEpoch): void {
  writeAtomicJson(epochPath(stateDir, provider), epoch, { space: 2 });
}

// ─── Staged file validation ───────────────────────────────────────────────────

type StagedCheck = { ok: true; fingerprint: string } | { ok: false; why: string };

/**
 * The staged credential file must be a regular file (opened with O_NOFOLLOW),
 * single link, owned by the service uid, ≤64KB, parse as the provider's
 * credential shape. It is tightened to 0600 and fsynced before any rename.
 */
export function checkStagedCredential(provider: ProviderId, path: string, uid: number): StagedCheck {
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (err) {
    return { ok: false, why: (err as { code?: string }).code === "ELOOP" ? "symlink" : "missing" };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { ok: false, why: "not_regular" };
    if (st.nlink !== 1) return { ok: false, why: "hard_linked" };
    if (st.uid !== uid) return { ok: false, why: "foreign_owner" };
    if (st.size === 0 || st.size > MAX_STAGED_CREDENTIAL_BYTES) return { ok: false, why: "size" };
    const bytes = readFileSync(fd);
    if (!parsesAsCredential(provider, bytes.toString("utf-8"))) return { ok: false, why: "unparsable" };
    if ((st.mode & 0o777) !== 0o600) fchmodSync(fd, 0o600);
    fsyncSync(fd);
    return { ok: true, fingerprint: createHash("sha256").update(bytes).digest("hex") };
  } finally {
    closeSync(fd);
  }
}

function parsesAsCredential(provider: ProviderId, text: string): boolean {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return false;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  switch (provider) {
    case "claude": {
      const oauth = o.claudeAiOauth as Record<string, unknown> | undefined;
      return !!oauth && typeof oauth === "object" && typeof oauth.accessToken === "string" && oauth.accessToken.length > 0
        && typeof oauth.refreshToken === "string" && oauth.refreshToken.length > 0;
    }
    case "codex": {
      const tokens = o.tokens as Record<string, unknown> | undefined;
      return !!tokens && typeof tokens === "object" && typeof tokens.access_token === "string" && tokens.access_token.length > 0;
    }
    default:
      return assertNever(provider);
  }
}

function fsyncDir(dir: string): void {
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// ─── Claude account merge ─────────────────────────────────────────────────────

/**
 * Replace only `oauthAccount` in the live `.claude.json` (every live Claude
 * process writes this file). Re-stat (inode, size, mtime) right before the
 * rename and retry when someone wrote in between. Unparsable live file or no
 * staged account → nothing written; the account then reads "unknown", never
 * the old email. Returns whether the merge happened.
 */
export function mergeClaudeAccount(stagedConfig: string, liveConfig: string): boolean {
  let account: unknown;
  try {
    account = (JSON.parse(readFileSync(stagedConfig, "utf-8")) as Record<string, unknown>).oauthAccount;
  } catch {
    return false;
  }
  if (!account || typeof account !== "object") return false;
  for (let i = 0; i < ACCOUNT_MERGE_ATTEMPTS; i++) {
    const before = statOrNull(liveConfig);
    let config: Record<string, unknown> = {};
    if (before) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(liveConfig, "utf-8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
        config = parsed as Record<string, unknown>;
      } catch {
        return false;
      }
    }
    const tmp = `${liveConfig}.aura-login-${process.pid}.tmp`;
    const fd = openSync(tmp, "wx", before ? before.mode & 0o777 : 0o600);
    try {
      writeSync(fd, JSON.stringify({ ...config, oauthAccount: account }, null, 2));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const now = statOrNull(liveConfig);
    const unchanged = (!before && !now) || (before && now && before.ino === now.ino && before.size === now.size && before.mtimeMs === now.mtimeMs);
    if (!unchanged) {
      unlinkSync(tmp);
      continue;
    }
    renameSync(tmp, liveConfig);
    fsyncDir(dirname(liveConfig));
    return true;
  }
  return false;
}

function statOrNull(path: string): { ino: number; size: number; mtimeMs: number; mode: number } | null {
  try {
    const st = statSync(path);
    return { ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, mode: st.mode };
  } catch {
    return null;
  }
}

// ─── Promotion ────────────────────────────────────────────────────────────────

/** Promote a successful attempt's credentials. Never throws (EC-53): any failure is `{ok:false}`. */
export async function promoteCredentials(ctx: PromotionContext, deps: PromotionDeps): Promise<PromotionOutcome> {
  const { provider, attemptId } = ctx;
  const now = deps.now ?? Date.now;
  const staged = stagedCredentialPaths(provider, ctx.stagingHome);
  const live = liveCredentialPaths(provider, deps.serviceEnv);

  // A journal left by an earlier promotion is settled first (finish or drop),
  // so a new sign-in can never overwrite a recovery that is still owed.
  if (existsSync(journalPath(deps.stateDir, provider))) {
    await recoverPromotions({ ...deps, attemptsRoot: dirname(ctx.attemptDir) }, [provider]);
    if (existsSync(journalPath(deps.stateDir, provider))) return fail(provider, "recovery_pending");
  }

  const check = checkStagedCredential(provider, staged.credentials, deps.uid);
  if (!check.ok) return fail(provider, "staged_invalid", check.why);

  let probe: ProviderAuthStatus;
  try {
    probe = await deps.probeStaged(provider, ctx.stagingHome);
  } catch {
    return fail(provider, "probe_failed");
  }
  // A just-issued sign-in the provider already rejects, or that the CLI does not see, is not promoted.
  if (probe.state === "invalid" || probe.state === "not_signed_in") return fail(provider, "probe_rejected", probe.state);

  const liveDir = dirname(live.credentials);
  try {
    mkdirSync(liveDir, { recursive: true, mode: 0o700 });
    if (statSync(dirname(staged.credentials)).dev !== statSync(liveDir).dev) return fail(provider, "cross_device");
  } catch {
    return fail(provider, "live_dir_unavailable");
  }

  try {
    await deps.beforePromote?.(provider);
  } catch {
    return fail(provider, "barrier_failed");
  }

  const promotedAt = now();
  const journal: PromotionJournal = {
    schemaVersion: PROMOTION_SCHEMA_VERSION,
    provider,
    attemptId,
    targetEpoch: (readEpoch(deps.stateDir, provider)?.epoch ?? 0) + 1,
    newFingerprint: check.fingerprint,
    steps: [],
  };
  const tokenFingerprint = provider === "codex" ? deps.codexTokenFingerprint(staged.credentials) : null;
  let renamed = false;
  try {
    mkdirSync(deps.stateDir, { recursive: true, mode: 0o700 });
    writeAtomicJson(journalPath(deps.stateDir, provider), journal, { space: 2 });
    deps.crashAt?.("before_rename");
    // Codex sessions compare mtimes against their per-session copy: the file's time is the promotion's.
    if (provider === "codex") utimesSync(staged.credentials, promotedAt / 1000, promotedAt / 1000);
    renameSync(staged.credentials, live.credentials);
    renamed = true;
    fsyncDir(liveDir);
    advance(deps, journal, "credentials_renamed");
  } catch (err) {
    if (err instanceof CrashSimulation) throw err;
    // Before the rename: nothing live changed; the leftover journal is dropped at startup.
    if (!renamed) return fail(provider, "rename_failed", errName(err));
    // After it the new credentials ARE live: carry on; the journal lets startup finish if this fails too.
    log.warn("llm-login", "credential_promotion.journal_write_failed", { event: "credential_promotion.journal_write_failed", provider, error: errName(err) });
  }

  try {
    await finishPromotion(deps, journal, ctx.attemptDir, promotedAt, tokenFingerprint);
  } catch (err) {
    if (err instanceof CrashSimulation) throw err;
    // The new credentials ARE live, but the account / epoch step did not
    // complete: NOT a success. The journal and the attempt dir stay so the
    // next start (or the next sign-in of this provider) finishes it.
    log.warn("llm-login", "credential_promotion.finish_failed", { event: "credential_promotion.finish_failed", provider, error: errName(err) });
    return { ok: false, reason: "promotion_incomplete" };
  }
  log.info("llm-login", "credential_promotion.done", { event: "credential_promotion.done", provider, epoch: journal.targetEpoch });
  return { ok: true, account: probe.account, plan: probe.plan };
}

/** Steps after the rename; shared by the live path and startup recovery. Idempotent per step. */
async function finishPromotion(
  deps: PromotionDeps,
  journal: PromotionJournal,
  attemptDir: string,
  promotedAt: number,
  tokenFingerprint: string | null,
): Promise<void> {
  const { provider } = journal;
  if (provider === "claude" && !journal.steps.includes("account_merged")) {
    const staged = stagedCredentialPaths("claude", join(attemptDir, STAGING_HOME_DIR));
    const live = liveCredentialPaths("claude", deps.serviceEnv);
    const merged = staged.accountConfig && live.accountConfig ? mergeClaudeAccount(staged.accountConfig, live.accountConfig) : false;
    if (!merged) log.warn("llm-login", "credential_promotion.account_not_merged", { event: "credential_promotion.account_not_merged", provider });
    advance(deps, journal, "account_merged");
  }
  if (!journal.steps.includes("epoch_written")) {
    const current = readEpoch(deps.stateDir, provider)?.epoch ?? 0;
    if (current < journal.targetEpoch) {
      writeEpoch(deps.stateDir, provider, { schemaVersion: PROMOTION_SCHEMA_VERSION, epoch: journal.targetEpoch, promotedAt, fingerprint: journal.newFingerprint });
    }
    advance(deps, journal, "epoch_written");
  }
  // The epoch is on disk: a failed status refresh only delays the status (its TTL catches up).
  try {
    await deps.noteCredentialsPromoted({ provider, fingerprint: journal.newFingerprint, tokenFingerprint, promotedAt });
  } catch (err) {
    log.warn("llm-login", "credential_promotion.status_refresh_failed", { event: "credential_promotion.status_refresh_failed", provider, error: errName(err) });
  }
  // The journal goes only after the epoch is on disk.
  rmSync(journalPath(deps.stateDir, provider), { force: true });
}

function advance(deps: PromotionDeps, journal: PromotionJournal, step: PromotionStep): void {
  journal.steps.push(step);
  writeAtomicJson(journalPath(deps.stateDir, journal.provider), journal, { space: 2 });
  deps.crashAt?.(step);
}

// ─── Startup recovery ─────────────────────────────────────────────────────────

export function readJournal(stateDir: string, provider: ProviderId): PromotionJournal | null {
  try {
    const v = JSON.parse(readFileSync(journalPath(stateDir, provider), "utf-8")) as Partial<PromotionJournal>;
    if (v.schemaVersion !== PROMOTION_SCHEMA_VERSION || v.provider !== provider || typeof v.attemptId !== "string") return null;
    if (typeof v.newFingerprint !== "string" || typeof v.targetEpoch !== "number" || !Array.isArray(v.steps)) return null;
    return { schemaVersion: v.schemaVersion, provider, attemptId: v.attemptId, targetEpoch: v.targetEpoch, newFingerprint: v.newFingerprint, steps: v.steps.filter(isStep) };
  } catch {
    return null;
  }
}

function isStep(s: unknown): s is PromotionStep {
  return s === "credentials_renamed" || s === "account_merged" || s === "epoch_written";
}

export type RecoveryAction = { provider: ProviderId; action: "completed" | "discarded" };

/**
 * Run at startup BEFORE the attempt sweep: a journal whose live file already
 * carries the new fingerprint is finished (account merge, epoch, status);
 * any other journal is dropped with its attempt dir — the rename never
 * happened, so the live credentials are the old ones and the epoch stays.
 */
export async function recoverPromotions(
  deps: PromotionDeps & { attemptsRoot: string },
  providers: readonly ProviderId[] = PROVIDER_IDS,
): Promise<RecoveryAction[]> {
  const actions: RecoveryAction[] = [];
  for (const provider of providers) {
    const path = journalPath(deps.stateDir, provider);
    if (!existsSync(path)) continue;
    const journal = readJournal(deps.stateDir, provider);
    const attemptDir = journal && /^[0-9a-f]{32}$/.test(journal.attemptId) ? join(deps.attemptsRoot, journal.attemptId) : null;
    const liveFingerprint = sha256File(liveCredentialPaths(provider, deps.serviceEnv).credentials);
    try {
      if (journal && attemptDir && liveFingerprint === journal.newFingerprint) {
        const liveCredentials = liveCredentialPaths(provider, deps.serviceEnv).credentials;
        const tokenFingerprint = provider === "codex" ? deps.codexTokenFingerprint(liveCredentials) : null;
        await finishPromotion(deps, journal, attemptDir, (deps.now ?? Date.now)(), tokenFingerprint);
        actions.push({ provider, action: "completed" });
      } else {
        rmSync(path, { force: true });
        actions.push({ provider, action: "discarded" });
      }
    } catch (err) {
      log.warn("llm-login", "credential_promotion.recovery_failed", { event: "credential_promotion.recovery_failed", provider, error: errName(err) });
      continue;
    }
    if (attemptDir) rmSync(attemptDir, { recursive: true, force: true });
    log.info("llm-login", "credential_promotion.recovered", { event: "credential_promotion.recovered", provider, action: actions.at(-1)!.action });
  }
  return actions;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Thrown only by the `crashAt` test seam; propagates like a process death. */
export class CrashSimulation extends Error {}

function fail(provider: ProviderId, why: string, detail?: string): PromotionOutcome {
  log.warn("llm-login", "credential_promotion.refused", { event: "credential_promotion.refused", provider, why, ...(detail ? { detail } : {}) });
  return { ok: false, reason: "promotion_failed" };
}

function errName(err: unknown): string {
  return err instanceof Error ? ((err as { code?: string }).code ?? err.name) : "unknown";
}
