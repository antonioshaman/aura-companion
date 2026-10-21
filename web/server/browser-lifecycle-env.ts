export function browserLifecycleEnv(
  sessionId: string,
  overrides: Record<string, string | undefined> = {},
  inherited: Record<string, string | undefined> = process.env,
  container = false,
): Record<string, string | undefined> {
  return {
    AGENT_BROWSER_SESSION: `aura-${sessionId}`,
    AGENT_BROWSER_IDLE_TIMEOUT_MS: container || process.platform !== "linux"
      ? inherited.AGENT_BROWSER_IDLE_TIMEOUT_MS ?? "3600000"
      : inherited.AURA_BROWSER_SESSION_IDLE_TIMEOUT_MS ?? "0",
    ...overrides,
    AURA_BROWSER_SESSION_ID: sessionId,
  };
}
