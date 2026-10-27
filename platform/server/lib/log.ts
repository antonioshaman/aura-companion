/**
 * Minimal structured logger for control-plane lifecycle events.
 *
 * Every line is a single JSON object with `event` + `level` + `ts` so it can
 * be grepped / shipped without parsing free-form text. Never pass secrets in
 * `fields` — callers log resource ids, not tokens.
 */
export type LogLevel = "info" | "warn" | "error";

export function logEvent(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
