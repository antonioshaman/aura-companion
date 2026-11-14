/**
 * The one token-free request that tells us whether Anthropic accepts the
 * Claude OAuth access token: GET /api/oauth/usage (the usage-limits panel's
 * data source). It spends no model tokens. Shared by the status probe and
 * `usage-limits.ts` so both classify the same response the same way.
 *
 * The caller passes an access token it has already checked is NOT expired
 * locally; this module never refreshes or writes credentials.
 */

export const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const CLAUDE_USAGE_TIMEOUT_MS = 10_000;

export type ClaudeUsageOutcome =
  | { kind: "ok"; body: Record<string, unknown> }
  /** 401/403: the provider rejected the token. */
  | { kind: "rejected"; status: number }
  /** Any other non-2xx, or a 2xx with an unparsable body. */
  | { kind: "http"; status: number }
  | { kind: "network"; error: unknown };

export async function requestClaudeUsage(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ClaudeUsageOutcome> {
  let response: Response;
  try {
    response = await fetchImpl(CLAUDE_USAGE_URL, {
      signal: AbortSignal.timeout(CLAUDE_USAGE_TIMEOUT_MS),
      method: "GET",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "claude-code/2.1.39",
        Authorization: `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
    });
  } catch (error) {
    return { kind: "network", error };
  }
  if (!response.ok) {
    // Drain the body so the connection is released (do not leave it unread).
    await response.body?.cancel().catch(() => {});
    return response.status === 401 || response.status === 403
      ? { kind: "rejected", status: response.status }
      : { kind: "http", status: response.status };
  }
  try {
    const body: unknown = await response.json();
    if (body && typeof body === "object" && !Array.isArray(body)) {
      return { kind: "ok", body: body as Record<string, unknown> };
    }
    return { kind: "http", status: response.status };
  } catch (error) {
    // A body that dies mid-stream is a transport failure, not a rejection.
    return error instanceof SyntaxError ? { kind: "http", status: response.status } : { kind: "network", error };
  }
}
