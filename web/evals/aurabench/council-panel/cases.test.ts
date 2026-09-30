/**
 * COUNCIL-PANEL-BENCH case loader + git pin verification.
 *
 * The loader is the ground truth for recall, so malformed entries must fail
 * loudly rather than silently shrink the denominator. `verifyCases` runs once
 * against the real checked-in corpus (when this clone has the history) and
 * once against a scratch repo, so the "fix must descend from head" rule is
 * proven without relying on the clone.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { loadCases, parseCases, verifyCases, type GitRun } from "./cases.js";

const REPO = resolve(new URL(".", import.meta.url).pathname, "../../../..");

function gitIn(repo: string): GitRun {
  return (args) => {
    try {
      return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return null;
    }
  };
}

const defect = {
  id: "d1", kind: "defect", severity: "P1", summary: "s", fixedBy: ["abcdef1"],
  locations: [{ file: "web/a.ts", lines: [1, 2] }], keywords: ["foo"],
};
const aCase = {
  id: "c1", pr: 1, base: "abcdef0^", head: "abcdef0", title: "t", changedDomains: ["security"],
  evidence: "e", knownDefects: [defect],
};
const doc = (cases: unknown[]) => ({ schemaVersion: 1, cases });

describe("parseCases", () => {
  it("loads the checked-in corpus: 6 cases, every case has at least one P1", () => {
    // The spec asks for 6 historical PRs with known defects.
    const cases = loadCases();
    expect(cases).toHaveLength(6);
    for (const c of cases) expect(c.knownDefects.some((d) => d.severity === "P1")).toBe(true);
  });

  it("accepts a minimal valid case", () => {
    expect(parseCases(doc([aCase]))[0]!.knownDefects[0]!.locations[0]!.lines).toEqual([1, 2]);
  });

  it.each([
    ["wrong schema version", { schemaVersion: 2, cases: [aCase] }, /schemaVersion/],
    ["no cases", doc([]), /non-empty/],
    ["duplicate case id", doc([aCase, aCase]), /duplicate case id/],
    ["branch name instead of sha", doc([{ ...aCase, head: "main" }]), /sha/],
    ["absolute defect path", doc([{ ...aCase, knownDefects: [{ ...defect, locations: [{ file: "/etc/passwd" }] }] }]), /repo-relative/],
    ["parent traversal", doc([{ ...aCase, knownDefects: [{ ...defect, locations: [{ file: "web/../x" }] }] }]), /repo-relative/],
    ["inverted line range", doc([{ ...aCase, knownDefects: [{ ...defect, locations: [{ file: "a.ts", lines: [5, 2] }] }] }]), /lines/],
    // A 1-char keyword like "_" matches nearly any prose → inflated recall.
    ["too-short keyword", doc([{ ...aCase, knownDefects: [{ ...defect, keywords: ["_"] }] }]), /too short/],
    ["upper-case keyword", doc([{ ...aCase, knownDefects: [{ ...defect, keywords: ["Foo"] }] }]), /lower-case/],
    ["unknown kind", doc([{ ...aCase, knownDefects: [{ ...defect, kind: "style" }] }]), /kind/],
    ["non-sha fixedBy", doc([{ ...aCase, knownDefects: [{ ...defect, fixedBy: ["#55"] }] }]), /non-sha/],
    ["duplicate defect id", doc([{ ...aCase, knownDefects: [defect, defect] }]), /duplicate defect id/],
  ])("rejects %s", (_name, raw, re) => {
    expect(() => parseCases(raw)).toThrow(re);
  });
});

describe("verifyCases", () => {
  it("the checked-in corpus resolves against this clone (skipped on a shallow clone)", () => {
    const git = gitIn(REPO);
    const cases = loadCases();
    if (git(["cat-file", "-e", `${cases[0]!.head}^{commit}`]) === null) return; // shallow CI clone
    expect(verifyCases(cases, git)).toEqual([]);
  });

  it("flags a fix commit that is not a descendant of head, a missing file and an unresolvable base", () => {
    // Scratch history: c0 → c1 (head, adds web/a.ts) → c2 (fix); side branch s1 off c0.
    const dir = mkdtempSync(join(tmpdir(), "council-panel-cases-"));
    try {
      const g = (...args: string[]) =>
        execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).trim();
      g("init", "-q", "-b", "main");
      writeFileSync(join(dir, "r.md"), "0");
      g("add", "."); g("commit", "-qm", "c0");
      const c0 = g("rev-parse", "HEAD");
      writeFileSync(join(dir, "a.ts"), "1");
      g("add", "."); g("commit", "-qm", "c1");
      const c1 = g("rev-parse", "HEAD");
      writeFileSync(join(dir, "a.ts"), "2");
      g("commit", "-qam", "c2");
      const c2 = g("rev-parse", "HEAD");
      g("checkout", "-q", "-b", "side", c0);
      writeFileSync(join(dir, "s.ts"), "s");
      g("add", "."); g("commit", "-qm", "s1");
      const s1 = g("rev-parse", "HEAD");

      const mk = (over: Record<string, unknown>, d: Record<string, unknown> = {}) =>
        parseCases(doc([{ ...aCase, base: `${c1}^`, head: c1, ...over, knownDefects: [{ ...defect, locations: [{ file: "a.ts" }], fixedBy: [c2], ...d }] }]));
      const git = gitIn(dir);

      expect(verifyCases(mk({}), git)).toEqual([]);
      expect(verifyCases(mk({}, { fixedBy: [s1] }), git)).toEqual([`c1/d1: fixedBy ${s1} is not a descendant of head`]);
      expect(verifyCases(mk({}, { locations: [{ file: "missing.ts" }] }), git)).toEqual(["c1/d1: missing.ts absent at head"]);
      expect(verifyCases(mk({ base: `${c0}^` }), git)).toEqual([`c1: base ${c0}^ does not resolve`]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
