/**
 * Pure resolution layer between `cli-launcher.applyCouncilObserverSpawnConfig`
 * (now `buildObserverSpawnOverrides`) and `observer-prompt.ts`. Decides
 * whether the observer half spawns with a workspace-provided system prompt
 * or with the bundled fallback, and returns enough metadata for the caller
 * to emit a structured WARN log on the fallback branch.
 *
 * Council Review 2026-05-15-0820 P2 #5 (D3): extracted as a free function,
 * NOT a private method on `CliLauncher`. Has zero `this` references —
 * a private-method form would close over nothing and benefit from
 * nothing in the class. The launcher imports + calls it; tests exercise
 * it standalone without launcher instantiation.
 *
 * Council Review 2026-05-15-0820 P2 #4 (D5): the prior shape synthesised a
 * magic-string filesystem path to force the resolver's ENOENT branch when
 * no workspace cwd was available. Control-flow-via-magic-string AND a
 * multi-tenant-host attack vector (Hunt P3 #2 — attacker could create the
 * dummy directory and plant a workspace artifact at it). The no-cwd path
 * here calls {@link loadBundledObserverPromptValidated} directly; no
 * filesystem touch when the caller already knows it wants bundled.
 */

import { join } from "node:path";
import {
  loadBundledObserverPromptValidated,
  resolveObserverSystemPrompt,
  type ResolvedObserverPrompt,
} from "./observer-prompt.js";

/**
 * Why the resolution returned a bundled artifact (or `null` when
 * workspace resolution succeeded).
 *
 * - `"ENOENT"` — workspace cwd was set, the workspace file was absent,
 *   resolver fell back to bundled.
 * - `"no-workspace-cwd"` — no workspace cwd was set; the bundled artifact
 *   was loaded directly without any filesystem probe.
 */
export type ObserverSpawnFallbackReason = "ENOENT" | "no-workspace-cwd";

export interface ObserverSpawnPromptResolution {
  /** Validated artifact — either workspace-loaded or bundled. */
  readonly artifact: ResolvedObserverPrompt;
  /**
   * Whether the resolution attempted a workspace lookup at all. False
   * when the caller had no workspace cwd to point at; true otherwise
   * (workspace artifact found OR fell back to bundled).
   *
   * Replaces the prior WARN-log `expectedPath` string field. The raw
   * workspace path leaked operator topology (username inside `/home/X/`,
   * project name inside `/Users/X/work/<repo>/`) if logs egressed to a
   * shared sink — Hunt P3 #4 from Council Review 2026-05-15-0820. The
   * `(present, depth)` integer pair preserves diagnostic value without
   * topology disclosure.
   */
  readonly expectedPathPresent: boolean;
  /**
   * Segment count of the attempted workspace path (`0` when
   * `expectedPathPresent === false`). Tells the operator "was the cwd
   * deep enough to be a real project" without revealing which project.
   */
  readonly expectedPathDepth: number;
  /** Discriminator for why fallback fired (or `null` when source === "workspace"). */
  readonly fallbackReason: ObserverSpawnFallbackReason | null;
}

/**
 * Resolve which observer system-prompt artifact to inject into the
 * spawn argv, given the workspace cwd known at spawn time.
 *
 * Throws for any non-ENOENT fs error (EACCES, EISDIR, ELOOP, malformed
 * workspace artifact) — same contract as {@link resolveObserverSystemPrompt}.
 * Callers should let the throw propagate; the launcher's outer catch
 * wraps it into "observer spawn config load failed for session ..."
 *
 * `cwd` may be `undefined` or empty — in that case the bundled artifact
 * is loaded directly via {@link loadBundledObserverPromptValidated} and
 * the returned `fallbackReason` is `"no-workspace-cwd"`. No filesystem
 * probe occurs on this path.
 */
export function resolveObserverPromptForSpawn(opts: {
  readonly cwd: string | undefined;
}): ObserverSpawnPromptResolution {
  const cwd = opts.cwd && opts.cwd.length > 0 ? opts.cwd : null;
  if (cwd === null) {
    return {
      artifact: loadBundledObserverPromptValidated(),
      expectedPathPresent: false,
      expectedPathDepth: 0,
      fallbackReason: "no-workspace-cwd",
    };
  }
  const promptPath = join(cwd, ".council", "prompts", "observer-system.md");
  // Posix segment count — `/foo/bar/baz` → 3. Windows fallback splits on
  // `\` too. Empty leading segment from absolute path is dropped via filter.
  const expectedPathDepth = promptPath.split(/[/\\]/).filter((s) => s.length > 0).length;
  const artifact = resolveObserverSystemPrompt(promptPath);
  return {
    artifact,
    expectedPathPresent: true,
    expectedPathDepth,
    fallbackReason: artifact.source === "bundled" ? "ENOENT" : null,
  };
}
