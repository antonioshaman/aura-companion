import type { CodexProviderEvidence } from "./provider-probes.js";

/**
 * Latest Codex provider evidence from live sessions (task 11): the time the
 * app-server answered `account/rateLimits/*` and the fingerprint of the
 * primary credentials that session was running on. The launcher records it
 * only while the session still reads the primary auth.json (not its own
 * rotated copy); the status probe accepts it only when the fingerprint still
 * equals the primary's. In-memory, newest wins.
 */
let latest: CodexProviderEvidence | null = null;

export function recordCodexProviderEvidence(evidence: CodexProviderEvidence): void {
  if (!latest || evidence.checkedAt >= latest.checkedAt) latest = evidence;
}

export function latestCodexProviderEvidence(): CodexProviderEvidence | null {
  return latest;
}

/**
 * Phase 2 D8: an official `codex login --device-auth` that just succeeded is
 * provider evidence for the credentials it wrote — bound to that file's
 * access-token fingerprint (Codex has no free provider probe). Recorded by the
 * credential promotion; the probe accepts it only while the primary auth.json
 * still carries the same fingerprint. In-memory, newest wins.
 */
let latestLogin: CodexProviderEvidence | null = null;

export function recordCodexLoginEvidence(evidence: CodexProviderEvidence): void {
  if (!latestLogin || evidence.checkedAt >= latestLogin.checkedAt) latestLogin = evidence;
}

export function latestCodexLoginEvidence(): CodexProviderEvidence | null {
  return latestLogin;
}

export function _resetCodexProviderEvidenceForTests(): void {
  latest = null;
  latestLogin = null;
}
