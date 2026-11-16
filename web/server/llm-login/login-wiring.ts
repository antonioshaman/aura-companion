import { userInfo } from "node:os";
import { recordCodexLoginEvidence } from "../auth-status/codex-provider-evidence.js";
import { codexTokenFingerprintAt } from "../auth-status/credential-locator.js";
import { getServiceAuthStatusCore, probeStagedCredentials, readUnitTexts } from "../auth-status/service-status.js";
import { parseSystemdUnit } from "../auth-status/status-core.js";
import { log } from "../logger.js";
import { resolveBinary } from "../path-resolver.js";
import { getCredentialRenewal } from "../credential-renewal.js";
import { promoteCredentials, readEpoch, recoverPromotions, sameStorage, type PromotedCredentials, type PromotionDeps } from "./credential-promotion.js";
import type { PromotionContext, PromotionOutcome } from "./login-attempt.js";
import { LoginAttempts, sweepOrphanAttempts, type LoginAttemptsDeps } from "./login-attempt.js";
import { LLM_AUTH_ATTEMPTS_DIR, LLM_AUTH_STATE_DIR } from "./state-dir.js";

/**
 * Production wiring of the sign-in core for the server: the one registry
 * instance the REST routes use (phase 2b), its startup recovery and shutdown. Paths: attempts under
 * `~/.companion/llm-auth/attempts/` (same filesystem as the service HOME on a
 * standard install; the promotion refuses EXDEV), journal + epochs in
 * `~/.companion/llm-auth/`.
 */

export { LLM_AUTH_ATTEMPTS_DIR, LLM_AUTH_STATE_DIR };

/**
 * After a promotion: Codex gets its D8 sign-in evidence bound to the new
 * token fingerprint, then the status core recomputes without the recheck
 * rate limit (S1-AC2 "working without Check").
 */
export async function noteCredentialsPromoted(promoted: PromotedCredentials): Promise<void> {
  if (promoted.provider === "codex" && promoted.tokenFingerprint) {
    recordCodexLoginEvidence({ checkedAt: promoted.promotedAt, credentialFingerprint: promoted.tokenFingerprint });
  }
  try {
    await getServiceAuthStatusCore().noteCredentialsPromoted();
  } catch (err) {
    log.warn("llm-login", "credential_promotion.status_refresh_failed", {
      event: "credential_promotion.status_refresh_failed",
      provider: promoted.provider,
      error: err instanceof Error ? err.name : "unknown",
    });
  }
}

export function servicePromotionDeps(over: Partial<PromotionDeps> = {}): PromotionDeps {
  const serviceEnv = process.env;
  return {
    serviceEnv,
    stateDir: LLM_AUTH_STATE_DIR,
    uid: process.getuid?.() ?? -1,
    probeStaged: (provider, stagingHome) => probeStagedCredentials(provider, stagingHome, serviceEnv),
    codexTokenFingerprint: codexTokenFingerprintAt,
    // D1 barrier: live Claude writers are stopped before the rename (Codex: no-op).
    beforePromote: async (provider) => {
      await getCredentialRenewal()?.beforePromote(provider);
    },
    noteCredentialsPromoted,
    ...over,
  };
}

/**
 * LLM auth task 13: a promotion, then the live sessions. Success → every live
 * session of the provider on an older epoch moves to the new sign-in at its
 * first idle moment. Failure → the epoch did not move; only the sessions the
 * barrier stopped come back (S3-AC4: nobody else is touched).
 */
export async function promoteAndRenew(
  ctx: PromotionContext,
  deps: PromotionDeps,
  renewal = getCredentialRenewal(),
): Promise<PromotionOutcome> {
  let outcome: PromotionOutcome;
  try {
    outcome = await promoteCredentials(ctx, deps);
  } catch (err) {
    renewal?.promotionSettled(ctx.provider, false, null);
    throw err;
  }
  renewal?.promotionSettled(ctx.provider, outcome.ok, outcome.ok ? readEpoch(deps.stateDir, ctx.provider)?.promotedAt ?? null : null);
  return outcome;
}

// ─── The one registry per server (phase 2b, task 8) ───────────────────────────

let attempts: LoginAttempts | null = null;
let startup: Promise<void> | null = null;

/**
 * Registry deps for the server process. The CLI is resolved the way sessions
 * resolve it (`resolveBinary`); the service user comes from the installed unit
 * (null in dev), so a server started by another user refuses to sign in.
 */
export function serviceLoginAttemptsDeps(over: Partial<LoginAttemptsDeps> = {}): LoginAttemptsDeps {
  const me = userInfo();
  return {
    attemptsRoot: LLM_AUTH_ATTEMPTS_DIR,
    resolveCli: (provider) => resolveBinary(provider),
    platform: process.platform,
    callerUser: me.username,
    callerUid: process.getuid?.() ?? me.uid,
    serviceUser: parseSystemdUnit(readUnitTexts()).user,
    serviceEnv: process.env,
    promote: (ctx) => promoteAndRenew(ctx, servicePromotionDeps()),
    sameStorage: (provider) => sameStorage(provider, LLM_AUTH_ATTEMPTS_DIR, process.env),
    ...over,
  };
}

export function getServiceLoginAttempts(): LoginAttempts {
  attempts ??= new LoginAttempts(serviceLoginAttemptsDeps());
  return attempts;
}

/**
 * Server start, strictly in this order: finish (or discard) an interrupted
 * promotion — it may still need its attempt dir — THEN remove orphaned attempt
 * dirs. Each step is caught (EC-53): a failure is logged and the server starts;
 * the REST start route awaits this before the first sign-in.
 */
export function startServiceLoginRecovery(deps: {
  recover?: () => Promise<unknown>;
  sweep?: () => Promise<unknown>;
} = {}): Promise<void> {
  startup ??= (async () => {
    try {
      await (deps.recover ?? (() => recoverPromotions({ ...servicePromotionDeps(), attemptsRoot: LLM_AUTH_ATTEMPTS_DIR })))();
    } catch (err) {
      log.warn("llm-login", "llm_auth.login.recovery_failed", { event: "llm_auth.login.recovery_failed", error: err instanceof Error ? err.name : "unknown" });
    }
    try {
      await (deps.sweep ?? (() => sweepOrphanAttempts(LLM_AUTH_ATTEMPTS_DIR)))();
    } catch (err) {
      log.warn("llm-login", "llm_auth.login.sweep_failed", { event: "llm_auth.login.sweep_failed", error: err instanceof Error ? err.name : "unknown" });
    }
  })();
  return startup;
}

/** Server shutdown: end running attempts (process reaped, staging dir removed). */
export async function shutdownServiceLoginAttempts(): Promise<void> {
  await attempts?.shutdown();
}

export function _resetLoginWiringForTest(): void {
  attempts = null;
  startup = null;
}
