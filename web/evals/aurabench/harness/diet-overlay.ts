/**
 * DIET-AB control-file overlay (P6/DIET-AB). Measures the diet itself: the
 * same task, the same code, only the agent's standing context differs —
 *
 *   before  main 74a539d (pre-diet): CLAUDE.md 33.5 KB, observer prompt
 *           13.9 KB, KB + `.learnings/`, the `self-improvement` skill;
 *   after   `diet/main` (pinned sha): CLAUDE.md ~9 KB + the linked
 *           `docs/architecture|conventions`, observer prompt ~4 KB, one KB.
 *
 * A task checkout sits on its historical `start_commit`, i.e. the agent would
 * see THAT commit's CLAUDE.md/KB. The overlay removes every
 * {@link DIET_OVERLAY_PATHS} entry from the checkout and writes the chosen
 * version's files instead; task code is never touched. The overlay is
 * committed before the agent runs (like the naked scrub) so it never counts
 * as the agent's diff.
 *
 * Leak guard: the overlay source commits are LATER than every task's merge
 * commit, i.e. they contain the reference solutions. Their objects must never
 * enter the sealed checkout (`git log --all` / `FETCH_HEAD` would expose
 * them), so files are materialised with `git archive` in the MAIN repo and
 * unpacked with `tar` — no fetch into the cell.
 *
 * `.learnings/` was untracked in prod before the diet; A1 archived that exact
 * copy to `docs/history/learnings/` on `diet/main`, so the `before` overlay
 * takes it from the `after` ref and renames it back (subtree archive +
 * `--prefix`, so extraction needs no GNU-only tar flag).
 *
 * Not reproduced (recorded as a confound on every `before` cell): the
 * user-level `UserPromptSubmit` self-improvement reminder hook, which lives in
 * the real `~/.claude/settings.json` — the bench never reads user config.
 *
 * Firewall-clean. Everything that spawns goes through the injected exec.
 */

import type { AsyncExec, ExecResult } from "./run-cell.js";

export type DietVersion = "before" | "after";

/** main at the start of the diet (#211) — the `before` control files. */
export const DIET_BEFORE_REF = "74a539d5626281a2ce19f1685f1ecd4235495998";

/** Repo-relative paths owned by the overlay: removed from the checkout, then
 *  filled from the chosen version (a path the version lacks stays absent). */
export const DIET_OVERLAY_PATHS = [
  "CLAUDE.md",
  "AGENTS.md",
  "SELF-LEARNING.md",
  "skills-lock.json",
  ".agents/knowledge",
  ".agents/skills",
  ".claude/skills",
  ".council/prompts/observer-system.md",
  "docs/architecture",
  "docs/conventions",
  ".learnings",
] as const;

/** Where `before`'s `.learnings/` lives on the `after` ref (A1 archive). */
export const LEARNINGS_ARCHIVE = "docs/history/learnings";

export const DIET_BEFORE_HOOK_CONFOUND =
  "diet_overlay:before — user-level UserPromptSubmit self-improvement hook (~/.claude/settings.json) not reproduced";
export const DIET_SOURCE_LATER_CONFOUND =
  "diet_overlay — overlay files come from a commit later than the task merge; KB entries may describe the fix";

export interface DietOverlaySpec {
  version: DietVersion;
  /** Full sha the control files come from. */
  ref: string;
  /** Full sha of `diet/main` holding {@link LEARNINGS_ARCHIVE} (`before` only). */
  learningsRef?: string;
}

export interface DietOverlayEvidence {
  version: DietVersion;
  ref: string;
  learnings_ref?: string;
  /** Files written into the checkout (after removal of the owned paths). */
  files: number;
  /** Bytes of the overlaid CLAUDE.md / observer prompt; null = absent. */
  claude_md_bytes: number | null;
  observer_prompt_bytes: number | null;
}

export function parseDietVersion(raw: string | undefined): { ok: true; version: DietVersion | null } | { ok: false; reason: string } {
  if (raw === undefined) return { ok: true, version: null };
  if (raw === "before" || raw === "after") return { ok: true, version: raw };
  return { ok: false, reason: `--diet-overlay must be "before" or "after", got "${raw}"` };
}

/**
 * Overlay `spec` onto the sealed checkout `worktree` and commit it. `repo` is
 * the main repo holding both refs; `scratch` is a directory outside the
 * checkout for the tar files. Returns the evidence for the cell record.
 */
export async function applyDietOverlay(
  exec: AsyncExec,
  repo: string,
  worktree: string,
  scratch: string,
  spec: DietOverlaySpec,
  gitId: readonly string[],
): Promise<{ ok: true; evidence: DietOverlayEvidence } | { ok: false; error: string }> {
  const run = (cmd: string, args: string[], cwd: string) => exec(cmd, args, { cwd, timeoutMs: 120_000 });
  const listed = async (ref: string, paths: readonly string[]): Promise<string[] | ExecResult> => {
    const r = await run("git", ["ls-tree", "-r", "--name-only", ref, "--", ...paths], repo);
    return r.code !== 0 ? r : r.output.split("\n").filter(Boolean);
  };
  // Unpack `archiveArgs` (a `git archive` tail) into the checkout. Renaming is
  // git's job (`<ref>:<subdir>` + `--prefix`): tar gets only POSIX `-xf -C`,
  // since GNU `--transform` does not exist in BSD tar (macOS CI).
  const unpack = async (archiveArgs: string[], tarName: string): Promise<ExecResult> => {
    const tar = `${scratch}/${tarName}`;
    const ar = await run("git", ["archive", "--format=tar", `--output=${tar}`, ...archiveArgs], repo);
    if (ar.code !== 0) return ar;
    return run("tar", ["-xf", tar, "-C", worktree], repo);
  };
  const skip = async (): Promise<ExecResult> => ({ code: 0, output: "", timedOut: false });

  const main = await listed(spec.ref, DIET_OVERLAY_PATHS.filter((p) => !(spec.version === "before" && p === ".learnings")));
  if (!Array.isArray(main)) return { ok: false, error: `diet overlay ls-tree ${spec.ref} failed: ${main.output.slice(-300)}` };
  let learnings: string[] = [];
  if (spec.version === "before") {
    if (!spec.learningsRef) return { ok: false, error: "diet overlay before: learningsRef missing" };
    const l = await listed(spec.learningsRef, [LEARNINGS_ARCHIVE]);
    if (!Array.isArray(l)) return { ok: false, error: `diet overlay ls-tree ${spec.learningsRef} failed: ${l.output.slice(-300)}` };
    if (!l.length) return { ok: false, error: `diet overlay before: ${LEARNINGS_ARCHIVE} empty on ${spec.learningsRef}` };
    learnings = l;
  }
  if (!main.includes("CLAUDE.md")) return { ok: false, error: `diet overlay: CLAUDE.md missing on ${spec.ref}` };

  const steps: (() => Promise<ExecResult>)[] = [
    () => run("git", ["rm", "-r", "-q", "--ignore-unmatch", "--", ...DIET_OVERLAY_PATHS], worktree),
    // Untracked leftovers of an owned path (none in a fresh checkout) go too.
    () => run("rm", ["-rf", "--", ...DIET_OVERLAY_PATHS.map((p) => `${worktree}/${p}`)], worktree),
    () => (main.length ? unpack([spec.ref, "--", ...main], "diet-overlay.tar") : skip()),
    // Subtree archive: `docs/history/learnings/X` lands as `.learnings/X`.
    () =>
      learnings.length
        ? unpack(["--prefix=.learnings/", `${spec.learningsRef}:${LEARNINGS_ARCHIVE}`], "diet-learnings.tar")
        : skip(),
    // Whole tree: a fresh checkout has no other change, and a pathspec for an
    // owned path absent from both sides would make `git add` fail.
    () => run("git", ["add", "-A", "--", "."], worktree),
    () => run("git", [...gitId, "commit", "-q", "--no-verify", "--allow-empty", "-m", `aurabench: diet overlay ${spec.version}`], worktree),
  ];
  for (const step of steps) {
    const r = await step();
    if (r.code !== 0) return { ok: false, error: `diet overlay failed: ${r.output.slice(-300)}` };
  }
  const size = async (path: string): Promise<number | null> => {
    const r = await run("git", ["cat-file", "-s", `HEAD:${path}`], worktree);
    const n = Number(r.output.trim());
    return r.code === 0 && Number.isFinite(n) ? n : null;
  };
  const claudeMd = await size("CLAUDE.md");
  if (claudeMd === null) return { ok: false, error: "diet overlay: CLAUDE.md not in the committed checkout" };
  return {
    ok: true,
    evidence: {
      version: spec.version,
      ref: spec.ref,
      ...(spec.learningsRef && spec.version === "before" ? { learnings_ref: spec.learningsRef } : {}),
      files: main.length + learnings.length,
      claude_md_bytes: claudeMd,
      observer_prompt_bytes: await size(".council/prompts/observer-system.md"),
    },
  };
}

/**
 * Reuse guard: a bench root holds ONE overlay (the cell key does not carry
 * it). Any finished record whose overlay differs from this run's — including
 * a plain record in an overlay run and vice versa — is a mismatch.
 */
export function overlayMismatches(jsonl: string, spec: DietOverlaySpec | null): string[] {
  const out: string[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let v: { key?: unknown; diet_overlay?: { version?: unknown; ref?: unknown } };
    try {
      v = JSON.parse(line) as typeof v;
    } catch {
      continue;
    }
    if (typeof v.key !== "string") continue;
    const o = v.diet_overlay;
    const same = spec === null ? o === undefined : !!o && o.version === spec.version && o.ref === spec.ref;
    if (!same) out.push(v.key);
  }
  return out;
}
