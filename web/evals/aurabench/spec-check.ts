/**
 * AuraBench spec-completeness check (P6/CORPUS-SPEC-CHECK). The leak judge
 * (`prompt-judge.ts`) asks "does the prompt give the fix away?". This asks the
 * opposite question: is every observable behaviour the hidden tests assert
 * (field values, return values, codes, strings, call order, names) either
 * stated by the prompt or unambiguously implied by it plus the repository at
 * the base commit? A hidden test that pins behaviour the prompt leaves open
 * measures luck, not quality — the pilot's `resume-hiccup-loses-conversation`
 * (the streak value after a discard) and the probe's
 * `claude-cli-stdio-transport` (blank-line handling, restore anchor,
 * `attachTransport`) were exactly that.
 *
 * Pure, like `prompt-judge.ts`: request, schema, fail-closed parser, verdicts
 * keyed by prompt hash + rubric version. The `claude -p` call lives in
 * `aurabench-runner.ts spec-check` (no LLM in CI).
 *
 * Firewall-clean. Never `server/`.
 */

import { promptSha256 } from "./prompt-judge.js";

/** Bump when the rubric changes: old verdicts no longer count. */
export const SPEC_RUBRIC_VERSION = 1;

export const SPEC_VERDICTS = ["ok", "underspecified"] as const;
export type SpecVerdictKind = (typeof SPEC_VERDICTS)[number];

export interface SpecGap {
  /** Test name (the `it(...)` title) that asserts the unstated behaviour. */
  test: string;
  /** The assertion, quoted or paraphrased closely (expected value included). */
  assertion: string;
  /** What the prompt would have to state, as observable behaviour (never the fix). */
  missing: string;
}

export interface SpecReply {
  verdict: SpecVerdictKind;
  gaps: SpecGap[];
  rationale: string;
}

export interface SpecRecord extends SpecReply {
  id: string;
  prompt_sha256: string;
  rubric_version: number;
  model: string;
  checked_at: string;
}

export const SPEC_SYSTEM_PROMPT = `You audit task prompts for a coding-agent benchmark (AuraBench).
Each task was mined from a merged pull request. The agent gets ONLY the prompt and the repository at the commit BEFORE the PR; its solution is graded by withheld ("hidden") tests from the PR. You see the prompt, the PR's source diff and the hidden tests.

Your question is SPEC COMPLETENESS, not leakage: could a competent engineer who reads only the prompt and the base repository write code that passes every hidden test, without guessing? Go through the hidden tests assertion by assertion. For each observable behaviour a test pins — a return value, a field value (including values after a reset/discard/second call), an error or status code, an exact string or message, an event/payload shape, the order or count of calls, a name or signature, handling of edge inputs (empty, blank, whitespace, missing, duplicate) — decide whether it is:
- STATED by the prompt, or
- UNAMBIGUOUSLY IMPLIED by the prompt (a reasonable reader has exactly one choice), or
- DETERMINED BY THE BASE REPOSITORY: behaviour the PR did not change (an existing test that the PR only moved or kept), an existing convention every sibling follows, an existing type/interface the new code must satisfy, an existing helper whose output the test compares against.

Anything else is a GAP: the test pins one of several reasonable behaviours and the prompt does not say which (e.g. "after the discard the counter is 2" when the prompt never says what the counter holds after a discard; "blank lines are dropped" when the prompt says "emit every complete line"; a method name the prompt never gives).

Rules:
- Only hidden-test assertions count. Behaviour in the diff that no test checks is irrelevant.
- Setup/mocking details of the test (how it constructs objects, which internal function it spies on) are a gap ONLY if a correct solution that uses a different but reasonable internal structure would fail the test; then name that dependency.
- Be concrete: quote the test title and the assertion with its expected value. Describe the missing piece as an observable requirement the prompt could add ("after a discard the streak stays at 2 until the next successful spawn"), never as implementation advice.
- Do not report style, wording, or things the prompt states differently but equivalently.

Verdict: "ok" when there is no gap; "underspecified" when there is at least one. Return structured output.`;

export interface SpecInput {
  id: string;
  cls: string;
  title: string;
  prompt: string;
  requiredInterface: string[];
  sourceDiff: string;
  hiddenTests: string;
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n… [truncated ${s.length - max} chars]`;
}

/** The user message for one task. Diff/test text is clipped visibly. */
export function buildSpecRequest(i: SpecInput, limits = { diff: 60_000, tests: 60_000 }): string {
  return [
    `# Task ${i.id} (class: ${i.cls})`,
    `PR title (NOT shown to the agent): ${i.title}`,
    "",
    "## Prompt shown to the agent",
    "<prompt>",
    i.prompt.trimEnd(),
    "</prompt>",
    "",
    "## New names the hidden tests use (the prompt should name these)",
    i.requiredInterface.length ? i.requiredInterface.map((n) => `- ${n}`).join("\n") : "(none)",
    "",
    "## PR source diff (base → merge; NOT shown to the agent)",
    "```diff",
    clip(i.sourceDiff, limits.diff),
    "```",
    "",
    "## Hidden tests: diff base → merge (NOT shown to the agent; unchanged context lines existed at base)",
    "```diff",
    clip(i.hiddenTests, limits.tests),
    "```",
    "",
    "Return the verdict as structured output.",
  ].join("\n");
}

export const SPEC_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "gaps", "rationale"],
  properties: {
    verdict: { type: "string", enum: [...SPEC_VERDICTS] },
    gaps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["test", "assertion", "missing"],
        properties: {
          test: { type: "string" },
          assertion: { type: "string" },
          missing: { type: "string" },
        },
      },
    },
    rationale: { type: "string" },
  },
} as const;

export type ParsedSpecReply = { ok: true; value: SpecReply } | { ok: false; error: string };

/**
 * Validate a structured reply. Fail-closed: unknown verdict, missing or
 * non-string fields, "ok" with gaps, or "underspecified" without any gap are
 * rejected (the caller re-asks), never coerced to "ok".
 */
export function parseSpecReply(v: unknown): ParsedSpecReply {
  if (typeof v !== "object" || v === null) return { ok: false, error: "reply is not an object" };
  const r = v as Record<string, unknown>;
  if (!SPEC_VERDICTS.includes(r.verdict as SpecVerdictKind)) return { ok: false, error: `unknown verdict ${String(r.verdict)}` };
  if (typeof r.rationale !== "string") return { ok: false, error: "rationale must be a string" };
  if (!Array.isArray(r.gaps)) return { ok: false, error: "gaps must be an array" };
  const gaps: SpecGap[] = [];
  for (const g of r.gaps) {
    if (typeof g !== "object" || g === null) return { ok: false, error: "gap is not an object" };
    const o = g as Record<string, unknown>;
    if (typeof o.test !== "string" || typeof o.assertion !== "string" || typeof o.missing !== "string") {
      return { ok: false, error: "gap.test/assertion/missing must be strings" };
    }
    gaps.push({ test: o.test, assertion: o.assertion, missing: o.missing });
  }
  const verdict = r.verdict as SpecVerdictKind;
  if (verdict === "ok" && gaps.length > 0) return { ok: false, error: "verdict ok contradicts listed gaps" };
  if (verdict === "underspecified" && gaps.length === 0) return { ok: false, error: "verdict underspecified without gaps" };
  return { ok: true, value: { verdict, gaps, rationale: r.rationale } };
}

/** Key of a verdict: a rewritten prompt or a new rubric needs a new check. */
export function specKey(id: string, prompt: string, rubricVersion = SPEC_RUBRIC_VERSION): string {
  return `${id}@${promptSha256(prompt)}@v${rubricVersion}`;
}

/** Latest record per key from a JSONL file (torn lines ignored). */
export function readSpecRecords(jsonl: string): Map<string, SpecRecord> {
  const out = new Map<string, SpecRecord>();
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as SpecRecord;
      if (typeof r.id === "string" && typeof r.prompt_sha256 === "string" && typeof r.rubric_version === "number") {
        out.set(`${r.id}@${r.prompt_sha256}@v${r.rubric_version}`, r);
      }
    } catch {
      // torn line — ignore
    }
  }
  return out;
}

export type SpecCorpusProblem = { id: string; problem: string };

/**
 * Corpus gate: every task must carry an "ok" spec verdict for its CURRENT
 * prompt under the CURRENT rubric. Tasks in `waived` (reviewed by hand, with
 * the reason in `review/SPEC-CHECK.md`) are skipped.
 */
export function checkCorpusSpecified(
  tasks: { id: string; prompt: string }[],
  records: SpecRecord[],
  waived: ReadonlySet<string> = new Set(),
): SpecCorpusProblem[] {
  const byKey = new Map(records.map((r) => [`${r.id}@${r.prompt_sha256}@v${r.rubric_version}`, r]));
  const problems: SpecCorpusProblem[] = [];
  for (const t of tasks) {
    if (waived.has(t.id)) continue;
    const r = byKey.get(specKey(t.id, t.prompt));
    if (!r) problems.push({ id: t.id, problem: "no spec verdict for the current prompt and rubric" });
    else if (r.verdict !== "ok") problems.push({ id: t.id, problem: `spec verdict is ${r.verdict} (${r.gaps.length} gaps)` });
  }
  return problems;
}
