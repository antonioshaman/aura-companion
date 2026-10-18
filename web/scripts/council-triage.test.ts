// Tests for the council complexity gate (handoff 2026-10-18 §1).
//
// What is validated:
//   - the gate is a recommendation driven by the closed risk table: any risk
//     path makes the council mandatory (never `solo`), two risk areas → `full`,
//     an explicit request → `full`;
//   - size alone decides only when no risk path is touched, with the SAME
//     small-diff limits the dispatch policy uses for the seat budget, and an
//     unknown line count never qualifies as small (fail-closed toward review);
//   - test files and fixtures never trigger a risk row (they change no
//     behaviour) but still count toward the diff size;
//   - `changedFiles` sees committed-but-unmerged, working-tree AND untracked
//     changes in a real temp git repo;
//   - the decision log round-trips, skips malformed lines, and the report tells
//     "overruled to council" (gate too eager) from "overruled to solo".

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SMALL_DIFF_MAX_FILES, SMALL_DIFF_MAX_LINES } from "./dispatch-policy.js";
import {
  changedFiles,
  matchRiskTriggers,
  readTriageDecisions,
  recordTriageDecision,
  renderTriage,
  summarizeTriage,
  triage,
  type TriageDecision,
} from "./council-triage.js";

describe("matchRiskTriggers — the closed risk table", () => {
  it("maps auth / persistence / protocol / council / deploy paths to their category", () => {
    expect(matchRiskTriggers(["web/server/auth.ts"])).toEqual([{ category: "auth", path: "web/server/auth.ts" }]);
    expect(matchRiskTriggers(["web/server/session-store.ts"])[0]?.category).toBe("persistence");
    expect(matchRiskTriggers(["web/server/ws-bridge.ts"])[0]?.category).toBe("protocol");
    expect(matchRiskTriggers(["web/server/session-recovery.ts"])[0]?.category).toBe("protocol");
    expect(matchRiskTriggers(["web/server/council/coordinator.ts"])[0]?.category).toBe("council");
    expect(matchRiskTriggers([".council/prompts/observer-system.md"])[0]?.category).toBe("council");
    expect(matchRiskTriggers(["deploy/deploy-spa-app.sh"])[0]?.category).toBe("deploy");
    expect(matchRiskTriggers([".github/workflows/ci.yml"])[0]?.category).toBe("deploy");
  });

  it("never triggers on test files or fixtures, and leaves plain UI files alone", () => {
    expect(matchRiskTriggers(["web/server/ws-bridge.test.ts", "web/scripts/__fixtures__/council-skills/x.md"])).toEqual([]);
    expect(matchRiskTriggers(["web/src/components/HomePage.tsx", "web/src/utils/dropdown-fit.ts", "README.md"])).toEqual([]);
  });

  it("normalises Windows separators and a leading ./", () => {
    expect(matchRiskTriggers(["./web\\server\\claude-adapter.ts"])).toEqual([{ category: "protocol", path: "web/server/claude-adapter.ts" }]);
  });
});

describe("triage — recommendation rules", () => {
  it("small, risk-free change → solo, council not mandatory", () => {
    const r = triage({ files: ["web/src/components/HomePage.tsx"], diffLines: 40 });
    expect(r.recommendation).toBe("solo");
    expect(r.mandatoryCouncil).toBe(false);
    expect(r.small).toBe(true);
    expect(renderTriage(r)).toMatch(/^Triage: solo — 1 file\(s\) \/ 40 line\(s\), no risk paths/);
  });

  it("uses the dispatch policy's small-diff limits exactly (one over either limit → economy)", () => {
    const files = Array.from({ length: SMALL_DIFF_MAX_FILES }, (_, i) => `web/src/a${i}.tsx`);
    expect(triage({ files, diffLines: SMALL_DIFF_MAX_LINES }).recommendation).toBe("solo");
    expect(triage({ files, diffLines: SMALL_DIFF_MAX_LINES + 1 }).recommendation).toBe("economy");
    expect(triage({ files: [...files, "web/src/more.tsx"], diffLines: 10 }).recommendation).toBe("economy");
  });

  it("unknown line count is never small — fail closed toward a council", () => {
    const r = triage({ files: ["web/src/x.tsx"], diffLines: null });
    expect(r.recommendation).toBe("economy");
    expect(r.small).toBe(false);
    expect(r.rationale[0]).toMatch(/unknown/);
  });

  it("one risk area → economy and mandatory, however small the diff", () => {
    const r = triage({ files: ["web/server/auth.ts"], diffLines: 3 });
    expect(r.recommendation).toBe("economy");
    expect(r.mandatoryCouncil).toBe(true);
    expect(r.categories).toEqual(["auth"]);
    expect(renderTriage(r)).toContain("(council mandatory)");
  });

  it("two risk areas → full; categories are code-point sorted", () => {
    const r = triage({ files: ["web/server/ws-bridge.ts", "web/server/session-store.ts"], diffLines: 500 });
    expect(r.recommendation).toBe("full");
    expect(r.categories).toEqual(["persistence", "protocol"]);
  });

  it("an explicit full request wins over everything", () => {
    expect(triage({ files: ["README.md"], diffLines: 1, explicitFull: true }).recommendation).toBe("full");
  });

  it("test files count toward size but do not make the council mandatory", () => {
    const r = triage({ files: ["web/server/ws-bridge.test.ts", "web/server/x.test.ts", "web/server/y.test.ts", "web/server/z.test.ts"], diffLines: 20 });
    expect(r.mandatoryCouncil).toBe(false);
    expect(r.recommendation).toBe("economy"); // 4 files > the small limit
    expect(r.diff.files).toBe(4);
  });

  it("rejects a malformed line count instead of coercing it", () => {
    expect(() => triage({ files: [], diffLines: -1 })).toThrow(/diffLines/);
    expect(() => triage({ files: [], diffLines: 1.5 })).toThrow(/diffLines/);
  });
});

describe("changedFiles — git view of the change under review", () => {
  let root: string;
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function sh(args: string[]) {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  }

  it("counts committed-since-base, working-tree and untracked changes with their line totals", () => {
    root = mkdtempSync(join(tmpdir(), "triage-git-"));
    sh(["init", "-q", "-b", "main"]);
    sh(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base"]);
    const base = sh(["rev-parse", "HEAD"]).trim();
    mkdirSync(join(root, "web/server"), { recursive: true });
    writeFileSync(join(root, "web/server/ws-bridge.ts"), "a\nb\nc\n");
    sh(["add", "."]);
    sh(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "feat"]);
    // Working-tree edit on top of the commit (+1 line) and an untracked file (2 lines).
    writeFileSync(join(root, "web/server/ws-bridge.ts"), "a\nb\nc\nd\n");
    writeFileSync(join(root, "notes.md"), "x\ny\n");
    const c = changedFiles(root, base);
    expect(c.base).toBe(base);
    expect(c.files.sort()).toEqual(["notes.md", "web/server/ws-bridge.ts"]);
    // 4 added lines in the tracked file vs base + 3 lines of the untracked file
    // (split on "\n" counts the trailing newline as a line — a stable, if
    // generous, count; the gate only needs the order of magnitude).
    expect(c.diffLines).toBe(4 + 3);
    expect(triage({ files: c.files, diffLines: c.diffLines }).mandatoryCouncil).toBe(true);
  });

  it("falls back to HEAD when origin/main does not exist (no remote in a scratch repo)", () => {
    root = mkdtempSync(join(tmpdir(), "triage-git-"));
    sh(["init", "-q", "-b", "main"]);
    sh(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base"]);
    expect(changedFiles(root).base).toBe("HEAD");
  });
});

describe("decision log + report", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const decision = (over: Partial<TriageDecision>): TriageDecision => ({
    ts: 1,
    skill: "council-review-aura",
    recommendation: "solo",
    decision: "solo",
    reason: "tiny UI fix",
    diff: { files: 1, lines: 12 },
    categories: [],
    mandatoryCouncil: false,
    ...over,
  });

  it("appends validated jsonl lines, skips a malformed one on read, and summarises overrules", () => {
    dir = mkdtempSync(join(tmpdir(), "triage-log-"));
    recordTriageDecision(decision({}), { dir });
    recordTriageDecision(decision({ recommendation: "solo", decision: "economy", reason: "owner insisted" }), { dir });
    recordTriageDecision(decision({ recommendation: "economy", decision: "solo", reason: "deadline", categories: ["auth"], mandatoryCouncil: true }), { dir });
    writeFileSync(join(dir, "triage.jsonl"), '{"garbage":true}\n', { flag: "a" });
    const { decisions, skipped } = readTriageDecisions({ dir });
    expect(decisions).toHaveLength(3);
    expect(skipped).toBe(1);
    const report = summarizeTriage(decisions, skipped);
    expect(report).toMatchObject({ total: 3, skipped: 1, agreed: 1, overruledToCouncil: 1, overruledToSolo: 1 });
    expect(report.byRecommendation).toEqual({ solo: 2, economy: 1, full: 0 });
    expect(report.byDecision).toEqual({ solo: 2, economy: 1, full: 0 });
  });

  it("rejects an invalid decision before it reaches disk", () => {
    dir = mkdtempSync(join(tmpdir(), "triage-log-"));
    expect(() => recordTriageDecision(decision({ decision: "huge" as never }), { dir })).toThrow(/decision must be one of/);
    expect(() => recordTriageDecision(decision({ skill: "" }), { dir })).toThrow(/skill/);
    expect(readTriageDecisions({ dir }).decisions).toEqual([]);
  });
});
