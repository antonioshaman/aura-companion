import { statSync } from "node:fs";
import type { CredentialGenerationVerdict } from "./turn-failure.js";

/**
 * Session credential generation (LLM auth phase 1, task 11).
 *
 * The same `unauthorized` frame means two different things: the session holds
 * an OLD copy while the primary sign-in was renewed (fix: restart the
 * session), or the primary sign-in itself is dead (fix: sign in again). Codex
 * reads its token once at start and each session has its own CODEX_HOME, so
 * at launch we record the metadata of the credentials file the session got
 * and, on an auth failure, compare it with the primary file's CURRENT
 * metadata. Metadata only — dev/ino/size/mtime via stat(2); file contents are
 * never read here.
 *
 * Claude sessions read the primary credentials file directly (no per-session
 * copy), so the variant does not arise for Claude.
 */

export interface CredentialGeneration {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

/** stat(2) following symlinks; null when the path cannot be stat-ed. */
export type GenerationStat = (path: string) => CredentialGeneration | null;

export const statGeneration: GenerationStat = (path) => {
  try {
    const st = statSync(path);
    if (!st.isFile()) return null;
    return { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
};

/** What the session received at launch: its CODEX_HOME/auth.json, symlink followed. */
export function captureCredentialGeneration(sessionAuthPath: string, stat: GenerationStat = statGeneration): CredentialGeneration | null {
  return stat(sessionAuthPath);
}

function sameFile(a: CredentialGeneration, b: CredentialGeneration): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/**
 * `renewed` when the session runs on an older generation than the primary
 * sign-in (a re-login happened after it took its credentials), `same` when
 * the primary is not newer, `incomparable` without metadata.
 *
 * The session file is looked at NOW, not only at launch (observer STOP,
 * checkpoint 199): an in-session refresh replaces the shared symlink with the
 * session's own, newer regular file — then the session holds the newest
 * credentials and restarting it is not the fix.
 * - Session file is a distinct file: renewed iff primary is strictly newer.
 * - Session still reads the primary (same dev/ino): Codex cached the token at
 *   start, so compare the primary with the launch snapshot.
 */
export function compareCredentialGeneration(input: {
  launch: CredentialGeneration | null;
  sessionAuthPath: string;
  primaryAuthPath: string;
  stat?: GenerationStat;
}): CredentialGenerationVerdict {
  const stat = input.stat ?? statGeneration;
  const primary = stat(input.primaryAuthPath);
  if (!primary) return "incomparable";
  const session = stat(input.sessionAuthPath);
  if (session && !(session.dev === primary.dev && session.ino === primary.ino)) {
    return primary.mtimeMs > session.mtimeMs ? "renewed" : "same";
  }
  if (!input.launch) return "incomparable";
  if (sameFile(primary, input.launch)) return "same";
  return primary.mtimeMs > input.launch.mtimeMs ? "renewed" : "same";
}
