import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  checkStopGrounding,
  checkStopLines,
  extractIdentifiers,
  validateObserverFindings,
  type EvidenceLineFacts,
  type GroundingFailReason,
} from "./observer-grounding.js";
import {
  COUNCIL_SCHEMA_VERSION,
  type ObserverReviewFinding,
  type ObserverReviewPayload,
} from "./council-types.js";

function stop(overrides: Partial<ObserverReviewFinding> = {}): ObserverReviewFinding {
  return {
    severity: "STOP",
    claim: "Test STOP claim",
    evidence_path: "src/foo.ts",
    evidence_lines: [10, 20],
    confidence: "high",
    ...overrides,
  };
}

function note(overrides: Partial<ObserverReviewFinding> = {}): ObserverReviewFinding {
  return {
    severity: "NOTE",
    claim: "Test NOTE claim",
    evidence_path: "src/foo.ts",
    ...overrides,
  };
}

function review(findings: ObserverReviewFinding[]): ObserverReviewPayload {
  return {
    schema_version: COUNCIL_SCHEMA_VERSION,
    checkpoint_id: "chk-001",
    phase: "council-plan",
    session_group_id: "grp-abc",
    reviewed_at: "2026-05-11T10:00:00Z",
    observer_provider: "codex",
    observer_model: "gpt-5-codex",
    observer_cli_version: "1.4.0",
    findings,
  };
}

// ── checkStopGrounding (pure) ───────────────────────────────────────────────

describe("checkStopGrounding", () => {
  // Beck F4: the positive branch — file in modified set AND on disk.
  it("returns { grounded: true } when evidence is in modified set AND exists", () => {
    const result = checkStopGrounding(
      stop({ evidence_path: "src/foo.ts" }),
      new Set(["src/foo.ts"]),
      () => true,
    );
    expect(result).toEqual({ grounded: true });
  });

  // Beck F4: each failure branch independently. The "not in modified set"
  // path fires BEFORE the existence check (cheaper test first).
  it("returns evidence_not_in_modified_set when path is outside modified files", () => {
    const result = checkStopGrounding(
      stop({ evidence_path: "src/other.ts" }),
      new Set(["src/foo.ts"]),
      () => true,
    );
    expect(result).toEqual({ grounded: false, reason: "evidence_not_in_modified_set" });
  });

  it("returns evidence_missing_on_disk when path is in modified set but does not exist", () => {
    const result = checkStopGrounding(
      stop({ evidence_path: "src/foo.ts" }),
      new Set(["src/foo.ts"]),
      () => false,
    );
    expect(result).toEqual({ grounded: false, reason: "evidence_missing_on_disk" });
  });

  // The ordering invariant: when both checks would fail, "not in modified
  // set" wins because it does not require touching the filesystem.
  it("reports evidence_not_in_modified_set first when both would fail", () => {
    const result = checkStopGrounding(
      stop({ evidence_path: "src/other.ts" }),
      new Set(["src/foo.ts"]),
      () => false,
    );
    expect(result).toEqual({ grounded: false, reason: "evidence_not_in_modified_set" });
  });

  // The helper does NOT short-circuit on severity. Caller is responsible
  // for only invoking it on STOPs; the helper runs both checks regardless.
  // This keeps the helper monomorphic — easier to reason about.
  it("runs both checks even when finding is not a STOP (caller's responsibility to filter)", () => {
    const result = checkStopGrounding(
      note({ evidence_path: "src/other.ts" }),
      new Set(["src/foo.ts"]),
      () => false,
    );
    expect(result.grounded).toBe(false);
  });
});

// ── validateObserverFindings ────────────────────────────────────────────────

describe("validateObserverFindings (with injected existsRelative)", () => {
  // Happy path: a STOP that is grounded comes through with severity intact
  // and no downgrade is recorded.
  it("keeps grounded STOPs and records no downgrades", () => {
    const r = validateObserverFindings(
      review([stop({ evidence_path: "src/foo.ts" })]),
      {
        workspaceRoot: "/work/repo",
        modifiedFiles: new Set(["src/foo.ts"]),
        existsRelative: () => true,
      },
    );
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.severity).toBe("STOP");
    expect(r.downgrades).toEqual([]);
  });

  // The whole point of the gate: an ungrounded STOP is rewritten to NOTE
  // BEFORE reaching the user, and a downgrade entry is emitted so the
  // observer panel can show "this STOP was downgraded because…".
  it("downgrades a STOP whose evidence_path is not in the modified set", () => {
    const r = validateObserverFindings(
      review([stop({ evidence_path: "src/elsewhere.ts" })]),
      {
        workspaceRoot: "/work/repo",
        modifiedFiles: new Set(["src/foo.ts"]),
        existsRelative: () => true,
      },
    );
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.severity).toBe("NOTE");
    expect(r.downgrades).toHaveLength(1);
    expect(r.downgrades[0]?.reason).toBe("evidence_not_in_modified_set");
    expect(r.downgrades[0]?.original.severity).toBe("STOP");
  });

  it("downgrades a STOP whose evidence file does not exist on disk", () => {
    const r = validateObserverFindings(
      review([stop({ evidence_path: "src/foo.ts" })]),
      {
        workspaceRoot: "/work/repo",
        modifiedFiles: new Set(["src/foo.ts"]),
        existsRelative: () => false,
      },
    );
    expect(r.findings[0]?.severity).toBe("NOTE");
    expect(r.downgrades[0]?.reason).toBe("evidence_missing_on_disk");
  });

  // Non-STOP findings pass through unchanged regardless of grounding.
  // This is the explicit policy from the plan: the gate is STOP-only.
  it("passes WARN/NOTE/INFO findings through unchanged regardless of grounding", () => {
    const findings: ObserverReviewFinding[] = [
      { severity: "WARN", claim: "warn", evidence_path: "src/elsewhere.ts" },
      { severity: "NOTE", claim: "note", evidence_path: "src/missing.ts" },
      { severity: "INFO", claim: "info", evidence_path: "src/anywhere.ts" },
    ];
    const r = validateObserverFindings(review(findings), {
      workspaceRoot: "/work/repo",
      modifiedFiles: new Set(),
      existsRelative: () => false,
    });
    expect(r.findings.map((f) => f.severity)).toEqual(["WARN", "NOTE", "INFO"]);
    expect(r.downgrades).toEqual([]);
  });

  // Index stability — the downgrade record's `index` correlates with the
  // original array position so downstream observers (UI, log) can pin
  // the downgrade explanation to the right row.
  it("records the original index for each downgrade", () => {
    const findings: ObserverReviewFinding[] = [
      note({ evidence_path: "src/a.ts" }),                 // index 0 — pass through
      stop({ evidence_path: "src/missing.ts" }),          // index 1 — downgrade
      note({ evidence_path: "src/b.ts" }),                 // index 2 — pass through
      stop({ evidence_path: "src/elsewhere.ts" }),        // index 3 — downgrade
    ];
    const r = validateObserverFindings(review(findings), {
      workspaceRoot: "/work/repo",
      modifiedFiles: new Set(["src/missing.ts"]),
      existsRelative: () => false,
    });
    expect(r.downgrades).toHaveLength(2);
    expect(r.downgrades.map((d) => d.index)).toEqual([1, 3]);
  });

  // Argument validation: workspaceRoot is fixed by caller environment,
  // not by the observer; misuse should fail loudly.
  it.each([
    ["relative root", "relative/path"],
    ["NUL byte in root", "/work\0/repo"],
  ])("throws on %s", (_label, bad) => {
    expect(() =>
      validateObserverFindings(review([]), {
        workspaceRoot: bad,
        modifiedFiles: new Set(),
        existsRelative: () => true,
      }),
    ).toThrow(/workspaceRoot/);
  });
});

// ── validateObserverFindings (default existsRelative: realpath-backed) ──────

describe("validateObserverFindings (default workspace-bounded existsRelative)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "obs-ground-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "foo.ts"), "// content");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // Happy path: STOP whose evidence file exists at workspace-relative path.
  it("grounds a STOP whose evidence_path resolves inside the workspace", () => {
    const r = validateObserverFindings(review([stop({ evidence_path: "src/foo.ts" })]), {
      workspaceRoot: root,
      modifiedFiles: new Set(["src/foo.ts"]),
    });
    expect(r.findings[0]?.severity).toBe("STOP");
    expect(r.downgrades).toEqual([]);
  });

  // Hunt EC-7: a symlink that escapes the workspace must NOT count as
  // grounded. The integrated wrapper realpaths before bounds-checking.
  it("downgrades a STOP whose evidence_path is a symlink escaping the workspace", () => {
    const targetOutside = join(tmpdir(), `outside-${Date.now()}.txt`);
    writeFileSync(targetOutside, "leaked");
    try {
      symlinkSync(targetOutside, join(root, "src", "escape.ts"));
      const r = validateObserverFindings(review([stop({ evidence_path: "src/escape.ts" })]), {
        workspaceRoot: root,
        modifiedFiles: new Set(["src/escape.ts"]),
      });
      expect(r.findings[0]?.severity).toBe("NOTE");
      expect(r.downgrades[0]?.reason).toBe("evidence_missing_on_disk");
    } finally {
      rmSync(targetOutside, { force: true });
    }
  });

  // A file that the manifest claims is modified but that does not exist
  // on disk (e.g. deleted between checkpoint and review) — downgrade.
  it("downgrades a STOP whose evidence file is absent on disk", () => {
    const r = validateObserverFindings(review([stop({ evidence_path: "src/ghost.ts" })]), {
      workspaceRoot: root,
      modifiedFiles: new Set(["src/ghost.ts"]),
    });
    expect(r.findings[0]?.severity).toBe("NOTE");
    expect(r.downgrades[0]?.reason).toBe("evidence_missing_on_disk");
  });

  // Path traversal in evidence_path is already filtered by council-types
  // validators, but the existence check defends in depth — a value that
  // slips past would resolve outside workspace and return false.
  it("downgrades when evidence_path contains parent traversal", () => {
    const r = validateObserverFindings(
      review([stop({ evidence_path: "src/../../etc/passwd" as unknown as string })]),
      {
        workspaceRoot: root,
        modifiedFiles: new Set(["src/../../etc/passwd"]),
      },
    );
    expect(r.findings[0]?.severity).toBe("NOTE");
  });
});

// ── B2 (meta-diet): line-level grounding ────────────────────────────────────
//
// The gate gets host line facts (content + lines changed by the checkpoint)
// through an injected provider, so every branch here is hermetic. Contract:
//   - cited range past EOF / inverted            → downgrade (out_of_range)
//   - cited range touches no changed line         → downgrade (unchanged)
//   - changed ranges unknown (null)               → unchanged-check SKIPPED
//   - no cited lines / claim names nothing on the
//     cited lines / content unreadable            → STOP kept, weak evidence
//   - no provider at all                          → exact legacy path-only gate

/** Line facts over an in-memory file; `changed` null = no baseline. */
function facts(lines: string[], changed: [number, number][] | null): EvidenceLineFacts {
  return {
    lineCount: lines.length,
    lineText: (n) => lines[n - 1],
    changedRanges: changed,
  };
}

const FILE = [
  "import { readFileSync } from 'node:fs';",
  "",
  "export function recordUsage(root: string) {",
  "  writeTextAtomic(storePath(root), 'x');",
  "}",
];

describe("extractIdentifiers", () => {
  // Keywords and glue words never count as shared evidence; 3+ char names do.
  it("keeps identifier-like tokens and drops keywords / short tokens", () => {
    const ids = extractIdentifiers("export const x = recordUsage(storePath) the if");
    expect([...ids].sort()).toEqual(["recordUsage", "storePath"]);
  });
});

describe("checkStopLines", () => {
  it("is strongly grounded when the claim names an identifier on its changed cited lines", () => {
    expect(checkStopLines(stop({ claim: "recordUsage writes tracked stores", evidence_lines: [3, 4] }), facts(FILE, [[3, 4]])))
      .toEqual({ grounded: true });
  });

  // AC: STOP citing a line that does not exist in the file → NOTE with reason.
  it.each([
    ["past EOF", [6, 7]],
    ["start < 1", [0, 2]],
    ["inverted", [4, 3]],
  ] as const)("downgrades a %s range as evidence_lines_out_of_range", (_label, range) => {
    expect(checkStopLines(stop({ evidence_lines: [range[0], range[1]] }), facts(FILE, null)))
      .toEqual({ grounded: false, reason: "evidence_lines_out_of_range" });
  });

  // AC: STOP citing lines the checkpoint did not change → NOTE with reason.
  it("downgrades a range that touches no changed line as evidence_lines_unchanged", () => {
    expect(checkStopLines(stop({ claim: "readFileSync misuse", evidence_lines: [1, 2] }), facts(FILE, [[3, 4]])))
      .toEqual({ grounded: false, reason: "evidence_lines_unchanged" });
  });

  it("counts a partial overlap with a changed range as changed", () => {
    expect(checkStopLines(stop({ claim: "storePath is wrong", evidence_lines: [2, 4] }), facts(FILE, [[4, 4]])))
      .toEqual({ grounded: true });
  });

  // No baseline must never be read as "nothing changed" — that would silence
  // every STOP on a group's first checkpoint.
  it("skips the unchanged check when changed ranges are unknown", () => {
    expect(checkStopLines(stop({ claim: "readFileSync misuse", evidence_lines: [1, 1] }), facts(FILE, null)))
      .toEqual({ grounded: true });
  });

  // AC: claim mentioning no identifier from the cited lines → weak evidence,
  // not removed (grounded: true keeps severity).
  it("marks weak evidence when the claim names nothing on the cited lines", () => {
    expect(checkStopLines(stop({ claim: "the session clock never advances", evidence_lines: [3, 4] }), facts(FILE, [[3, 4]])))
      .toEqual({ grounded: true, weak: "claim_symbols_not_on_cited_lines" });
  });

  // Supervisor incident diet-A2-103: a path-only STOP asserting runtime
  // behaviour ("command X fails") reached the banner. No cited lines → weak.
  it("marks weak evidence when the STOP cites no lines", () => {
    const f = stop({ claim: "bun run --cwd web kb:record fails" });
    delete f.evidence_lines;
    expect(checkStopLines(f, facts(FILE, null))).toEqual({ grounded: true, weak: "no_cited_lines" });
  });

  it("marks weak evidence (never downgrades) when content is unavailable", () => {
    expect(checkStopLines(stop({ evidence_lines: [1, 1] }), null)).toEqual({ grounded: true, weak: "cited_lines_unreadable" });
  });
});

describe("validateObserverFindings with lineFacts", () => {
  const modified = new Set(["src/foo.ts"]);
  const always = () => true;

  it("downgrades line failures, marks weak evidence, and leaves non-STOP findings alone", () => {
    const provider = (p: string) => (p === "src/foo.ts" ? facts(FILE, [[3, 4]]) : null);
    const noLines = stop({ claim: "runtime failure" });
    delete noLines.evidence_lines;
    const r = validateObserverFindings(
      review([
        stop({ claim: "recordUsage writes tracked stores", evidence_lines: [3, 4] }),
        stop({ evidence_lines: [90, 99] }),
        stop({ claim: "readFileSync", evidence_lines: [1, 1] }),
        noLines,
        note({ evidence_lines: [90, 99] }),
      ]),
      { workspaceRoot: "/ws", modifiedFiles: modified, existsRelative: always, lineFacts: provider },
    );
    expect(r.findings.map((f) => f.severity)).toEqual(["STOP", "NOTE", "NOTE", "STOP", "NOTE"]);
    expect(r.downgrades.map((d) => [d.index, d.reason])).toEqual([
      [1, "evidence_lines_out_of_range"],
      [2, "evidence_lines_unchanged"],
    ]);
    expect(r.weakEvidence).toEqual([{ index: 3, reason: "no_cited_lines" }]);
  });

  // Path checks still run first: a STOP outside the modified set keeps its
  // legacy reason even when its lines would also fail.
  it("keeps path-check reasons ahead of line checks", () => {
    const r = validateObserverFindings(review([stop({ evidence_path: "src/other.ts", evidence_lines: [90, 99] })]), {
      workspaceRoot: "/ws",
      modifiedFiles: modified,
      existsRelative: always,
      lineFacts: () => facts(FILE, null),
    });
    expect(r.downgrades[0]?.reason).toBe("evidence_not_in_modified_set");
  });

  // Omitting the provider is the legacy gate: eval sidecars recorded before
  // line facts existed must rerun byte-identically.
  it("runs no line checks and reports no weak evidence without a provider", () => {
    const r = validateObserverFindings(review([stop({ evidence_lines: [90, 99] })]), {
      workspaceRoot: "/ws",
      modifiedFiles: modified,
      existsRelative: always,
    });
    expect(r.downgrades).toEqual([]);
    expect(r.weakEvidence).toEqual([]);
    expect(r.findings[0]?.severity).toBe("STOP");
  });
});
