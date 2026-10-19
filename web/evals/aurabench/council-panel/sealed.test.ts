/**
 * Sealed checkout for COUNCIL-PANEL-BENCH. Uses REAL git and tar in a temp
 * directory — the leak guard is a property of those tools; a fake exec would
 * only prove the argv.
 *
 * Validates:
 *   - the checkout is a two-commit repo `base' → head'` whose HEAD tree is the
 *     case head (code, symlinks, runtime `.council/prompts` kept) and whose
 *     `git diff base'..HEAD` is exactly the PR's code change;
 *   - answer-key leak guard: no object of the LATER fix commit, and no
 *     archived review (`.council/review-output`, `docs/history`, …) on disk
 *     or anywhere in the object store — the head of #91 really carries the
 *     review that defines its known defects;
 *   - no repo-shipped skills (`.agents/skills`, `.claude/skills`) on disk —
 *     the CLI would load them and a name clash with a user skill voids the run;
 *   - scrub counts per tree are reported as evidence;
 *   - an unresolvable revision fails cleanly (no partial success).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PANEL_SCRUB_PATHS, sealedPanelCheckout } from "./sealed.js";
import { git, makeCaseRepo, realExec, TEST_GIT_ID } from "./test-fixtures.js";

let root: string;
let fx: ReturnType<typeof makeCaseRepo>;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "panel-sealed-"));
  fx = makeCaseRepo(root);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("sealedPanelCheckout", () => {
  it("builds base' → head' with the head tree, the PR diff, and nothing later", async () => {
    const dir = join(root, "wt", "c-1");
    const scratch = join(root, "scratch-1");
    mkdirSync(scratch, { recursive: true });
    const r = await sealedPanelCheckout(realExec, fx.repo, dir, scratch, { base: `${fx.head}^`, head: fx.head }, TEST_GIT_ID);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // Original shas resolved (the `^` form included); sealed shas are the checkout's own.
    expect(r.checkout.base).toBe(fx.base);
    expect(r.checkout.head).toBe(fx.head);
    expect(git(dir, "rev-parse", "HEAD")).toBe(r.checkout.sealedHead);
    expect(git(dir, "rev-list", "--all").split("\n")).toEqual([r.checkout.sealedHead, r.checkout.sealedBase]);

    // Head tree on disk: code, the symlink, the runtime prompt.
    expect(readFileSync(join(dir, "web/server/a.ts"), "utf8")).toContain("racy");
    expect(lstatSync(join(dir, "AGENTS.md")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(dir, ".council/prompts/observer-system.md"))).toBe(true);

    // The reviewed diff is the code change only (archived reviews scrubbed from both sides).
    expect(git(dir, "diff", "--name-only", `${r.checkout.sealedBase}..HEAD`)).toBe("web/server/a.ts");

    // Leak guard: no scrubbed path on disk, and neither the answer-key review
    // nor the fix commit's content anywhere in the object store.
    for (const p of PANEL_SCRUB_PATHS) expect(existsSync(join(dir, p))).toBe(false);
    const objects = git(dir, "cat-file", "--batch-all-objects", "--batch");
    expect(objects).not.toContain("ANSWERKEY");
    expect(objects).not.toContain("FIXSECRET");
    expect(objects).not.toContain("old handoff");
    expect(git(dir, "status", "--porcelain")).toBe("");

    // Repo-shipped skills are gone too: the CLI would load them from the
    // checkout, and `harden` collides with a real user skill name, which made
    // the first live run invalid_isolation (2026-10-01 smoke).
    expect(existsSync(join(dir, ".agents/skills"))).toBe(false);
    expect(existsSync(join(dir, ".claude/skills"))).toBe(false);

    // Evidence: base had 4 scrubbable entries (review, handoff, skill file, skill symlink), head 5.
    expect(r.checkout.scrubbed).toEqual({ base: 4, head: 5 });
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toBe("rules\n");
    expect(existsSync(join(scratch, "panel-head.tar"))).toBe(false);
  });

  it("fails cleanly on an unresolvable revision", async () => {
    const r = await sealedPanelCheckout(realExec, fx.repo, join(root, "wt", "c-2"), root, { base: "deadbeef", head: fx.head }, TEST_GIT_ID);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/cannot resolve deadbeef/);
    expect(existsSync(join(root, "wt", "c-2"))).toBe(false);
  });
});
