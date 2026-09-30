/**
 * Tests for the DIET-AB control-file overlay (P6/DIET-AB). Uses REAL git and
 * tar in a temp directory — the leak guard and the `.learnings` rename are
 * properties of those tools, a fake exec would only prove the argv.
 *
 * Validates:
 *   - `before` / `after` replace every owned path with the chosen version's
 *     files (CLAUDE.md, symlinked AGENTS.md, KB, skills, observer prompt,
 *     linked docs); a path the version lacks is REMOVED, not left at the
 *     task's historical copy; task code is untouched;
 *   - `before` gets `.learnings/` from the `after` ref's A1 archive
 *     (`docs/history/learnings/` → `.learnings/`);
 *   - the overlay is committed, so the agent's diff (against HEAD) is empty;
 *   - leak guard: the overlay source commits are LATER than the task's merge
 *     (they hold the reference solution) — none of their objects may enter
 *     the sealed checkout;
 *   - evidence (version, ref, file count, CLAUDE.md / observer prompt bytes);
 *   - fail-closed parsing of `--diet-overlay`, and the one-overlay-per-bench-
 *     root reuse guard.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applyDietOverlay, overlayMismatches, parseDietVersion, type DietOverlaySpec } from "./diet-overlay.js";
import { sealedCheckout, type AsyncExec } from "./run-cell.js";

const GIT_ID = ["-c", "user.name=t", "-c", "user.email=t@localhost", "-c", "commit.gpgsign=false"];

const exec: AsyncExec = async (cmd, args, opts) => {
  const r = spawnSync(cmd, args, { cwd: opts.cwd, encoding: "utf8", timeout: opts.timeoutMs });
  return { code: r.status ?? 1, output: `${r.stdout ?? ""}${r.stderr ?? ""}`, timedOut: false };
};
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", [...GIT_ID, ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

let root: string;
let repo: string;
let taskSha: string;
let beforeSha: string;
let afterSha: string;

/** Replace the repo's tree with `files` (null value = symlink to AGENTS target) and commit. */
function commitTree(files: Record<string, string>, msg: string): string {
  git(repo, "rm", "-r", "-q", "--ignore-unmatch", ".");
  for (const [path, body] of Object.entries(files)) {
    const abs = join(repo, path);
    mkdirSync(dirname(abs), { recursive: true });
    if (path === "AGENTS.md") symlinkSync(body, abs);
    else writeFileSync(abs, body);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "--allow-empty", "-m", msg);
  return git(repo, "rev-parse", "HEAD");
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "diet-overlay-"));
  repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q");
  // Historical task base: its own (old) control files + code.
  taskSha = commitTree(
    {
      "CLAUDE.md": "task-era claude md",
      "AGENTS.md": "CLAUDE.md",
      ".agents/knowledge/gotchas.jsonl": "task-era kb\n",
      ".agents/skills/old-only/SKILL.md": "task-era skill",
      "web/server/x.ts": "export const x = 1;\n",
    },
    "task base",
  );
  // Pre-diet main: big CLAUDE.md, self-improvement skill, big observer prompt.
  beforeSha = commitTree(
    {
      "CLAUDE.md": "B".repeat(3000),
      "AGENTS.md": "CLAUDE.md",
      "SELF-LEARNING.md": "self learning",
      ".agents/knowledge/gotchas.jsonl": "before kb\n",
      ".agents/skills/self-improvement/SKILL.md": "self-improvement",
      ".council/prompts/observer-system.md": "O".repeat(1400),
      "web/server/x.ts": "export const x = 2; // the reference fix\n",
    },
    "pre-diet main",
  );
  // diet/main: small CLAUDE.md + linked docs, A1 archive of prod .learnings.
  afterSha = commitTree(
    {
      "CLAUDE.md": "A".repeat(900),
      "AGENTS.md": "CLAUDE.md",
      ".agents/knowledge/gotchas.jsonl": "after kb\n",
      ".agents/skills/prime/SKILL.md": "prime",
      ".council/prompts/observer-system.md": "o".repeat(430),
      "docs/architecture/overview.md": "overview",
      "docs/history/learnings/LEARNINGS.md": "prod learnings",
      "web/server/x.ts": "export const x = 3;\n",
    },
    "diet/main",
  );
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

async function overlaid(spec: DietOverlaySpec) {
  const wt = join(root, `wt-${spec.version}`);
  const scratch = join(root, `scratch-${spec.version}`);
  mkdirSync(scratch, { recursive: true });
  const co = await sealedCheckout(exec, repo, wt, taskSha);
  expect(co.code).toBe(0);
  const r = await applyDietOverlay(exec, repo, wt, scratch, spec, GIT_ID);
  return { wt, r };
}

const read = (wt: string, p: string) => readFileSync(join(wt, p), "utf8");

describe("applyDietOverlay — before", () => {
  it("installs the pre-diet control files, .learnings from the A1 archive, and leaves code alone", async () => {
    const { wt, r } = await overlaid({ version: "before", ref: beforeSha, learningsRef: afterSha });
    if (!r.ok) throw new Error(r.error);
    expect(read(wt, "CLAUDE.md")).toBe("B".repeat(3000));
    expect(lstatSync(join(wt, "AGENTS.md")).isSymbolicLink()).toBe(true);
    expect(read(wt, ".agents/knowledge/gotchas.jsonl")).toBe("before kb\n");
    expect(read(wt, ".agents/skills/self-improvement/SKILL.md")).toBe("self-improvement");
    expect(read(wt, ".learnings/LEARNINGS.md")).toBe("prod learnings");
    // The task's own skill is gone: the overlay owns `.agents/skills` entirely.
    expect(existsSync(join(wt, ".agents/skills/old-only"))).toBe(false);
    // after-only docs are not smuggled into `before`.
    expect(existsSync(join(wt, "docs/architecture"))).toBe(false);
    // Task code stays at the historical base, NOT the later commit's fix.
    expect(read(wt, "web/server/x.ts")).toBe("export const x = 1;\n");
    if (r.ok) {
      expect(r.evidence).toMatchObject({ version: "before", ref: beforeSha, learnings_ref: afterSha, claude_md_bytes: 3000, observer_prompt_bytes: 1400 });
      expect(r.evidence.files).toBe(7);
    }
  });
});

describe("applyDietOverlay — after", () => {
  it("installs the diet control files and linked docs, committed so the agent's diff starts empty", async () => {
    const { wt, r } = await overlaid({ version: "after", ref: afterSha });
    if (!r.ok) throw new Error(r.error);
    expect(read(wt, "CLAUDE.md")).toBe("A".repeat(900));
    expect(read(wt, "docs/architecture/overview.md")).toBe("overview");
    expect(existsSync(join(wt, ".agents/skills/self-improvement"))).toBe(false);
    // The A1 archive stays an archive in `after`; no `.learnings/` is resurrected.
    expect(existsSync(join(wt, ".learnings"))).toBe(false);
    expect(git(wt, "status", "--porcelain")).toBe("");
    expect(git(wt, "log", "-1", "--format=%s")).toBe("aurabench: diet overlay after");
    if (r.ok) expect(r.evidence).toMatchObject({ version: "after", ref: afterSha, claude_md_bytes: 900, observer_prompt_bytes: 430 });
  });

  it("never brings the overlay source commits (which hold the reference fix) into the checkout", async () => {
    const { wt } = await overlaid({ version: "after", ref: afterSha });
    for (const sha of [afterSha, beforeSha]) {
      const r = spawnSync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: wt });
      expect(r.status).not.toBe(0);
    }
    expect(git(wt, "log", "--all", "--format=%s")).not.toMatch(/diet\/main|pre-diet/);
  });
});

describe("applyDietOverlay — failures", () => {
  it("fails closed when `before` has no learnings source", async () => {
    const { r } = await overlaid({ version: "before", ref: beforeSha });
    expect(r).toEqual({ ok: false, error: "diet overlay before: learningsRef missing" });
  });

  it("fails closed on an unknown ref", async () => {
    const { r } = await overlaid({ version: "after", ref: "f".repeat(40) });
    expect(r.ok).toBe(false);
  });
});

describe("parseDietVersion", () => {
  it("accepts before/after/absent and rejects anything else", () => {
    expect(parseDietVersion(undefined)).toEqual({ ok: true, version: null });
    expect(parseDietVersion("before")).toEqual({ ok: true, version: "before" });
    expect(parseDietVersion("after")).toEqual({ ok: true, version: "after" });
    expect(parseDietVersion("After").ok).toBe(false);
  });
});

describe("overlayMismatches", () => {
  const rec = (key: string, o?: object) => JSON.stringify({ key, ...(o ? { diet_overlay: o } : {}) });
  const spec: DietOverlaySpec = { version: "after", ref: "a".repeat(40) };

  it("flags records of another overlay, a plain record in an overlay run, and vice versa", () => {
    const jsonl = [
      rec("t|C|1", { version: "after", ref: "a".repeat(40) }),
      rec("t|D|1", { version: "after", ref: "b".repeat(40) }),
      rec("t|H|1", { version: "before", ref: "a".repeat(40) }),
      rec("u|C|1"),
      "{torn",
    ].join("\n");
    expect(overlayMismatches(jsonl, spec)).toEqual(["t|D|1", "t|H|1", "u|C|1"]);
    expect(overlayMismatches(jsonl, null)).toEqual(["t|C|1", "t|D|1", "t|H|1"]);
  });
});
