import type { RestLoginAttempt } from "../../api.js";
import { knownField, unknownField, type LoginAttemptState, type ProviderId } from "../../../server/auth-status/auth-types.js";
import { signInSteps } from "../../../server/auth-status/auth-catalog.js";
import { INITIAL_LOGIN_VIEW, type LoginAttemptView } from "./useLoginAttempt.js";

/**
 * Synthetic sign-in attempts in the REST shape for the SignInPanel tests and
 * the Playground. The link and codes are made up (never a real provider URL
 * with a real nonce); the `prompt` appears only in `awaiting_user`, as the
 * server sends it.
 */

export const LOGIN_NOW = Date.UTC(2026, 10, 14, 14, 23);
export const FAKE_CLAUDE_URL = "https://claude.example.test/oauth/authorize?state=SYNTHETIC";
export const FAKE_CODEX_URL = "https://auth.example.test/codex/device";
export const FAKE_DEVICE_CODE = "ABCD-12345";

export function loginAttempt(provider: ProviderId, state: LoginAttemptState, over: Partial<RestLoginAttempt> = {}): RestLoginAttempt {
  const base: RestLoginAttempt = {
    id: `${provider === "claude" ? "c" : "d"}${"0".repeat(31)}`,
    provider,
    state,
    version: 3,
    startedAt: LOGIN_NOW - 60_000,
    expiresAt: LOGIN_NOW + 12 * 60_000,
    failure: state === "failed" ? "code_rejected" : state === "expired" ? "expired" : null,
    codeError: null,
    submitting: false,
    submissionsLeft: 5,
    steps: signInSteps(provider),
    result: state === "succeeded" ? { account: knownField("owner@example.com"), plan: provider === "claude" ? knownField("max") : unknownField } : null,
  };
  if (state === "awaiting_user") {
    base.prompt = provider === "claude" ? { url: FAKE_CLAUDE_URL } : { url: FAKE_CODEX_URL, userCode: FAKE_DEVICE_CODE, expiresInMinutes: 15 };
  }
  return { ...base, ...over };
}

export function loginView(attempt: RestLoginAttempt | null, over: Partial<LoginAttemptView> = {}): LoginAttemptView {
  return { ...INITIAL_LOGIN_VIEW, attempt, loaded: true, lastPolledAt: LOGIN_NOW - 3_000, ...over };
}
