import { join } from "node:path";
import { recordCodexLoginEvidence } from "../auth-status/codex-provider-evidence.js";
import { codexTokenFingerprintAt } from "../auth-status/credential-locator.js";
import { getServiceAuthStatusCore, probeStagedCredentials } from "../auth-status/service-status.js";
import { log } from "../logger.js";
import { COMPANION_HOME } from "../paths.js";
import type { PromotedCredentials, PromotionDeps } from "./credential-promotion.js";

/**
 * Production wiring of the sign-in core for the server (the REST routes and
 * the registry instance arrive in phase 2b). Paths: attempts under
 * `~/.companion/llm-auth/attempts/` (same filesystem as the service HOME on a
 * standard install; the promotion refuses EXDEV), journal + epochs in
 * `~/.companion/llm-auth/`.
 */

export const LLM_AUTH_STATE_DIR = join(COMPANION_HOME, "llm-auth");
export const LLM_AUTH_ATTEMPTS_DIR = join(LLM_AUTH_STATE_DIR, "attempts");

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
    beforePromote: async () => {},
    noteCredentialsPromoted,
    ...over,
  };
}
