export function browserLifecycleEnv(
  sessionId: string,
  overrides: Record<string, string | undefined> = {},
  inherited: Record<string, string | undefined> = process.env,
  container = false,
  // Injectable so tests cover the Linux host policy on any CI runner.
  platform: NodeJS.Platform = process.platform,
): Record<string, string | undefined> {
  return {
    AGENT_BROWSER_SESSION: `aura-${sessionId}`,
    AGENT_BROWSER_IDLE_TIMEOUT_MS: container || platform !== "linux"
      ? inherited.AGENT_BROWSER_IDLE_TIMEOUT_MS ?? "3600000"
      : inherited.AURA_BROWSER_SESSION_IDLE_TIMEOUT_MS ?? "0",
    ...overrides,
    AURA_BROWSER_SESSION_ID: sessionId,
  };
}
