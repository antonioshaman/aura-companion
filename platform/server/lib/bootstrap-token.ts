import { createHash, randomBytes } from "node:crypto";

/**
 * One-time bootstrap tokens for new instances.
 *
 * The raw token goes into cloud-init user_data (readable for the server's
 * lifetime via the Hetzner API / metadata service), so it must be worthless
 * once used: the DB only stores its sha256, and the exchange endpoint nulls
 * the hash atomically on first use. It also expires after a short TTL.
 */
export const DEFAULT_BOOTSTRAP_TOKEN_TTL_MS = 30 * 60 * 1000;

export function generateBootstrapToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashBootstrapToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function bootstrapTokenTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.PLATFORM_BOOTSTRAP_TOKEN_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_BOOTSTRAP_TOKEN_TTL_MS;
}
