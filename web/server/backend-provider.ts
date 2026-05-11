import type { BackendType } from "./session-types.js";

/**
 * Minimal seam over the two CLI backends Aura Companion drives. Today
 * `cli-launcher.ts` carries the codex branches inline; the eventual
 * migration replaces those branches with method dispatch through this
 * interface. For now {@link SessionGroupCoordinator} consumes it as a
 * declarative manifest of supported pairings, so council-mode code does
 * not duplicate the `if (backendType === "codex")` knowledge.
 */
export interface BackendProvider {
  readonly backendType: BackendType;
  readonly binaryName: string;
}

export const CLAUDE_BACKEND: BackendProvider = {
  backendType: "claude",
  binaryName: "claude",
};

export const CODEX_BACKEND: BackendProvider = {
  backendType: "codex",
  binaryName: "codex",
};

export function getBackend(type: BackendType): BackendProvider {
  return type === "codex" ? CODEX_BACKEND : CLAUDE_BACKEND;
}

/** Pairing of (primary, observer) backend types for Council Mode. */
export interface BackendPairing {
  readonly primary: BackendType;
  readonly observer: BackendType;
  /** True for cross-family pairings (independent review at billing cost). */
  readonly experimental: boolean;
}

/**
 * The complete set of pairings the server will spawn. Keep this short —
 * each entry is a UI option and a server-side allow-list check. Browser-
 * supplied provider strings must be validated against this list before
 * being forwarded to spawn().
 */
export const SUPPORTED_PAIRINGS: readonly BackendPairing[] = Object.freeze([
  { primary: "claude", observer: "claude", experimental: false },
  { primary: "claude", observer: "codex", experimental: true },
] as const);

export function isSupportedPairing(primary: BackendType, observer: BackendType): boolean {
  return SUPPORTED_PAIRINGS.some((p) => p.primary === primary && p.observer === observer);
}
