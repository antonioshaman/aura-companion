/**
 * Claude OAuth for the AuraBench harness (P6/FIX-D2-CLAUDE-AUTH).
 *
 * Incident 2026-09-30: the bench instance's HOME held a COPY of the real
 * `~/.claude/.credentials.json` (access + refresh token). At 03:03 a bench
 * Claude CLI refreshed the token in that copy; refresh tokens are single-use,
 * so prod's refresh token was spent and prod's Claude OAuth died (03:07 →
 * "OAuth session expired and could not be refreshed") until a human restored
 * it. Naked A cells carried the same kind of copy in `claude-config/`.
 *
 * Fix: no bench process gets a refresh token at all. The CLI accepts a bare
 * access token in `CLAUDE_CODE_OAUTH_TOKEN` (no `.credentials.json` needed;
 * verified on 2.1.283: `apiKeySource: none`, reply ok, no credentials file
 * written) and cannot refresh without a refresh token — so the only token
 * chain stays prod's own:
 *
 *  - {@link readClaudeAccessToken} reads ONLY `accessToken` + `expiresAt`
 *    from the real file (read-only); the refresh token never leaves it;
 *  - {@link claudeTokenGate}: a cell starts only when the access token
 *    outlives the cell's timeout (+ margin) — the bench never needs a refresh
 *    mid-cell. An expiring token is a HOLD (prod refreshes it in its own
 *    chain: prod `/api/usage-limits`, polled by the usage gate, refreshes
 *    within 5 min of expiry); a missing/unreadable token is FATAL (prod is
 *    logged out → stop, ask a human);
 *  - {@link quarantineClaudeCredentialCopies}: any `.credentials.json` left
 *    under the bench root (the incident copy, old A cells) is MOVED to a
 *    quarantine dir (0700/0600) — never written into the real file, never
 *    deleted (a human decides);
 *  - {@link claudeCredentialCopyEvidence}: per-cell proof that the agent's
 *    config dir / HOME holds no credentials file afterwards.
 *
 * Firewall-clean (node:fs only).
 */

import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { join, relative } from "node:path";

export const CLAUDE_CREDENTIALS_FILE = ".credentials.json";
/** Env var the Claude CLI takes a bare OAuth access token from. */
export const CLAUDE_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";
/** Extra validity a token must have beyond the cell timeout. */
export const TOKEN_MARGIN_MS = 10 * 60_000;

export type AccessTokenRead =
  | { ok: true; accessToken: string; expiresAt: number }
  | { ok: false; reason: string };

/**
 * The real access token and its expiry. Never returns (or copies) the refresh
 * token. Fail-closed: absent file, non-JSON, no `claudeAiOauth.accessToken`,
 * or a non-numeric `expiresAt` → `ok: false`.
 */
export function readClaudeAccessToken(
  realClaudeDir: string,
  readText: (p: string) => string = (p) => readFileSync(p, "utf8"),
): AccessTokenRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readText(join(realClaudeDir, CLAUDE_CREDENTIALS_FILE)));
  } catch (e) {
    return { ok: false, reason: `real ${CLAUDE_CREDENTIALS_FILE} unreadable (${(e as Error).message.slice(0, 80)})` };
  }
  const oauth = (parsed as { claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown } } | null)?.claudeAiOauth;
  const token = oauth?.accessToken;
  if (typeof token !== "string" || !token.trim()) return { ok: false, reason: "real credentials hold no claudeAiOauth.accessToken (prod logged out?)" };
  const exp = oauth?.expiresAt;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return { ok: false, reason: "real credentials: expiresAt missing or not a number" };
  return { ok: true, accessToken: token, expiresAt: exp };
}

export type TokenGate =
  | { ok: true; accessToken: string; expiresAt: number }
  | { ok: false; fatal: boolean; reason: string };

/** May a cell that can run `needMs` start on the current access token? */
export function claudeTokenGate(read: AccessTokenRead, needMs: number, now: number): TokenGate {
  if (!read.ok) return { ok: false, fatal: true, reason: read.reason };
  const left = read.expiresAt - now;
  if (left < needMs + TOKEN_MARGIN_MS) {
    return {
      ok: false,
      fatal: false,
      reason: `Claude access token expires in ${Math.max(0, Math.round(left / 60_000))} min < cell ${Math.round(needMs / 60_000)} min + ${TOKEN_MARGIN_MS / 60_000} min margin (waiting for prod to refresh it)`,
    };
  }
  return { ok: true, accessToken: read.accessToken, expiresAt: read.expiresAt };
}

const SKIP_DIRS = new Set(["node_modules", ".git"]);

/**
 * Move every regular `.credentials.json` under `roots` (up to `maxDepth`
 * directory levels, symlinks never followed) into `quarantineDir`, named
 * after its path. Returns the original paths. Nothing is deleted and nothing
 * is written into the real `~/.claude`.
 */
export function quarantineClaudeCredentialCopies(
  roots: readonly string[],
  quarantineDir: string,
  opts: { maxDepth?: number; stamp?: string; skipDirs?: readonly string[] } = {},
): string[] {
  const maxDepth = opts.maxDepth ?? 6;
  const skip = new Set([...SKIP_DIRS, ...(opts.skipDirs ?? [])]);
  const stamp = opts.stamp ?? new Date().toISOString().replace(/[:.]/g, "-");
  const found: { root: string; path: string }[] = [];
  const walk = (root: string, dir: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isFile() && e.name === CLAUDE_CREDENTIALS_FILE) found.push({ root, path: p });
      else if (e.isDirectory() && depth < maxDepth && !skip.has(e.name) && p !== quarantineDir) walk(root, p, depth + 1);
    }
  };
  for (const r of roots) walk(r, r, 1);
  if (!found.length) return [];
  mkdirSync(quarantineDir, { recursive: true, mode: 0o700 });
  chmodSync(quarantineDir, 0o700);
  const moved: string[] = [];
  for (const { root, path } of found) {
    const name = `${stamp}__${relative(root, path).replace(/[/\\]/g, "__")}`;
    const dest = join(quarantineDir, name);
    renameSync(path, dest);
    chmodSync(dest, 0o600);
    moved.push(path);
  }
  return moved;
}

/** Per-cell evidence: which of `dirs` hold a credentials file (expected none). */
export function claudeCredentialCopyEvidence(dirs: readonly string[]): { credential_copies: string[] } {
  const copies = dirs
    .map((d) => join(d, CLAUDE_CREDENTIALS_FILE))
    .filter((p) => lstatSync(p, { throwIfNoEntry: false }) !== undefined);
  return { credential_copies: copies };
}
