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

export function _resetCodexProviderEvidenceForTests(): void {
  latest = null;
}
