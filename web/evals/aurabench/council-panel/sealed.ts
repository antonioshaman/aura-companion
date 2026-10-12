/**
 * Sealed checkout for a COUNCIL-PANEL-BENCH run (P6). The council reviews
 * `base..head` of a historical PR, and the ground truth is what LATER commits
 * fixed — so the checkout must hold nothing but the two reviewed trees:
 *
 *  - no object of any later commit (the fix commits ARE the answer key):
 *    both trees are materialised with `git archive` in the MAIN repo and
 *    unpacked with `tar` into a fresh `git init` — no fetch, no history;
 *  - no archived council artefacts ({@link PANEL_SCRUB_PATHS}): the head of
 *    #91 carries `.council/review-output/2026-06-04-1826/`, the very review
 *    that defines #91's known defects. The paths are removed from BOTH trees
 *    before committing, so they are neither on disk nor in `git show`, and the
 *    reviewed diff loses only review artefacts, never code;
 *  - no repo-shipped skills (`.agents/skills`, `.claude/skills`): the CLI loads
 *    them from the checkout, and several share a name with a real user skill
 *    (`harden`), so the isolation check cannot tell them apart and the run is
 *    `invalid_isolation`. No case diff touches them, so the diff is unchanged.
 *
 * Result: a two-commit repo `base' → head'` (head' checked out). The prompt
 * names `base'` (the only base the checkout knows); the evidence keeps the
 * original shas next to the sealed ones.
 *
 * Firewall-clean. Everything that spawns goes through the injected exec.
 */

import type { AsyncExec, ExecResult } from "../harness/run-cell.js";

/** Archived council artefacts removed from both trees (answer-key leak guard). */
export const PANEL_SCRUB_PATHS = [
  ".council/review-output",
  ".council/handoffs",
  ".council/implementation-logs",
  ".council/plan-output",
  // Historical observer review logs and plan/review A/B docs — prior reviews, not code.
  ".council/reviews",
  ".council/abtest",
  "docs/history",
  // Repo-shipped skills — the copied council skills in the run home are the only skills a run may see.
  ".agents/skills",
  ".claude/skills",
] as const;

export interface SealedPanelCheckout {
  /** Original full shas in the main repo. */
  base: string;
  head: string;
  /** Sealed commits inside the checkout (`git diff <sealedBase>..HEAD`). */
  sealedBase: string;
  sealedHead: string;
  /** Scrubbed files per tree (repo-relative, from `git ls-tree`). */
  scrubbed: { base: number; head: number };
}

/**
 * Build the sealed checkout in `dir` (absolute, must not exist or be empty —
 * the caller owns a fresh path). `scratch` holds the tar files, outside `dir`.
 */
export async function sealedPanelCheckout(
  exec: AsyncExec,
  repo: string,
  dir: string,
  scratch: string,
  revs: { base: string; head: string },
  gitId: readonly string[],
): Promise<{ ok: true; checkout: SealedPanelCheckout } | { ok: false; error: string }> {
  const run = (cmd: string, args: string[], cwd: string) => exec(cmd, args, { cwd, timeoutMs: 180_000 });
  const fail = (what: string, r: ExecResult) => ({ ok: false as const, error: `${what}: ${r.output.slice(-300)}` });

  const resolved: string[] = [];
  for (const rev of [revs.base, revs.head]) {
    const r = await run("git", ["rev-parse", "--verify", "-q", `${rev}^{commit}`], repo);
    const sha = r.output.trim();
    if (r.code !== 0 || !/^[0-9a-f]{40}$/.test(sha)) return fail(`cannot resolve ${rev}`, r);
    resolved.push(sha);
  }
  const [base, head] = resolved as [string, string];

  const scrubCount = async (sha: string): Promise<number | ExecResult> => {
    const r = await run("git", ["ls-tree", "-r", "--name-only", sha, "--", ...PANEL_SCRUB_PATHS], repo);
    return r.code !== 0 ? r : r.output.split("\n").filter(Boolean).length;
  };

  const init = await run("git", ["init", "-q", dir], repo);
  if (init.code !== 0) return fail("git init", init);

  const commitTree = async (sha: string, label: string): Promise<string | { error: string }> => {
    const tar = `${scratch}/panel-${label}.tar`;
    const steps: [string, string[], string][] = [
      // Empty the work tree (keep .git) — the head tree replaces the base tree wholesale.
      ["find", [dir, "-mindepth", "1", "-maxdepth", "1", "!", "-name", ".git", "-exec", "rm", "-rf", "{}", "+"], dir],
      ["git", ["archive", "--format=tar", `--output=${tar}`, sha], repo],
      ["tar", ["-xf", tar, "-C", dir], dir],
      ["rm", ["-rf", "--", ...PANEL_SCRUB_PATHS.map((p) => `${dir}/${p}`)], dir],
      ["git", ["add", "-A", "--", "."], dir],
      ["git", [...gitId, "commit", "-q", "--no-verify", "--allow-empty", "-m", `aurabench council-panel: ${label} (${sha.slice(0, 12)})`], dir],
      ["rm", ["-f", tar], dir],
    ];
    for (const [cmd, args, cwd] of steps) {
      const r = await run(cmd, args, cwd);
      if (r.code !== 0) return { error: `sealed ${label} (${cmd} ${args[0]}): ${r.output.slice(-300)}` };
    }
    const r = await run("git", ["rev-parse", "HEAD"], dir);
    return r.code === 0 ? r.output.trim() : { error: `sealed ${label} rev-parse: ${r.output.slice(-300)}` };
  };

  const sealedBase = await commitTree(base, "base");
  if (typeof sealedBase !== "string") return { ok: false, error: sealedBase.error };
  const sealedHead = await commitTree(head, "head");
  if (typeof sealedHead !== "string") return { ok: false, error: sealedHead.error };

  const nBase = await scrubCount(base);
  if (typeof nBase !== "number") return fail("ls-tree base", nBase);
  const nHead = await scrubCount(head);
  if (typeof nHead !== "number") return fail("ls-tree head", nHead);
  return { ok: true, checkout: { base, head, sealedBase, sealedHead, scrubbed: { base: nBase, head: nHead } } };
}
