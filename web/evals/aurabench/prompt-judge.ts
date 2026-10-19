/**
 * AuraBench solution-leak judge (P6/FIX-D2-5). `leak.ts` only catches code
 * identifiers; a prompt can still hand the agent the fix in plain English
 * ("the relaunch path treats a live PID as healthy and refuses `starting`
 * sessions" is the whole diagnosis of #184). An LLM judge reads the prompt
 * next to the real PR diff and decides whether the prompt describes only the
 * observable symptom / required behaviour, or also gives away the cause or the
 * fix.
 *
 * This module is pure: it builds the judge request, the structured-output
 * schema, parses the reply fail-closed, and keys verdicts by the prompt's hash
 * so a rewritten prompt must be judged again. The `claude -p` call lives in
 * `aurabench-runner.ts judge` (no LLM in CI).
 *
 * Firewall-clean. Never `server/`.
 */

import { createHash } from "node:crypto";

/** Bump when the rubric changes: old verdicts no longer count. */
export const JUDGE_RUBRIC_VERSION = 1;

export const JUDGE_ISSUE_KINDS = ["cause", "fix", "contract_is_fix", "underspecified"] as const;
export type JudgeIssueKind = (typeof JUDGE_ISSUE_KINDS)[number];

export const JUDGE_VERDICTS = ["clean", "rewrite", "exclude"] as const;
export type JudgeVerdictKind = (typeof JUDGE_VERDICTS)[number];

export interface JudgeIssue {
  kind: JudgeIssueKind;
  /** Verbatim span of the prompt the issue is about. */
  quote: string;
  why: string;
}

export interface JudgeReply {
  verdict: JudgeVerdictKind;
  issues: JudgeIssue[];
  rationale: string;
}

export interface JudgeRecord extends JudgeReply {
  id: string;
  prompt_sha256: string;
  rubric_version: number;
  model: string;
  judged_at: string;
}

export const JUDGE_SYSTEM_PROMPT = `You audit task prompts for a coding-agent benchmark (AuraBench).
Each task was mined from a merged pull request. The agent gets ONLY the prompt and the repository at the commit BEFORE the PR; it must reproduce the PR's behaviour so that withheld ("hidden") tests pass. You see the prompt, the PR's source diff and the hidden tests.

A good prompt reads like a bug report or a feature request from a user or product owner: the OBSERVABLE symptom or the required behaviour, plus whatever contract the hidden tests pin that the agent could not otherwise guess. It must leave the diagnosis and the design of the fix to the agent.

Flag every span of the prompt that does one of these:
- "cause": names the root cause inside the code — which function, branch, condition, map key, state or data flow is wrong and why — when the agent could find it by investigating the symptom. (Saying WHERE the symptom shows up to a user is fine; explaining WHY the code produces it is not.)
- "fix": prescribes the implementation — what to change, which existing helper/transition/field to use or call, the order of steps, the mechanism (e.g. "re-use X", "trigger the Y transition", "key the map by Z", "check A before B") — beyond the observable behaviour the tests assert.
- "contract_is_fix": the hidden tests pin an exact contract (payload shape, key, string, constant, call) that the agent cannot discover from the repository, and stating that contract in the prompt already IS the whole fix. Such a task cannot be both passable and non-leaking.
- "underspecified": the hidden tests assert something the prompt gives no way to derive (an exact message, field name, constant, public function name or signature, log shape) and that the repository alone does not determine. Note it so a rewrite can state it as a requirement.

NOT issues:
- names, file paths and signatures of NEW interfaces the hidden tests import or call (listed under "Required interface"): the prompt must name them;
- existing user-visible concepts (UI labels, REST routes, env vars, CLI flags, protocol message names) used to describe the symptom or the requirement;
- acceptance criteria phrased as observable behaviour ("after X, Y happens"; "a session that is not part of Z must not change"), even when they mirror individual test cases;
- for class "refactor": naming the component/module to extract and its public interface (that is the task).

Verdict:
- "clean": no cause/fix/contract_is_fix issue (underspecified alone is fine only if minor; otherwise "rewrite").
- "rewrite": the task is sound but the prompt must be rewritten (drop the cause/fix spans, restate as symptom/requirement; add missing contract as requirement).
- "exclude": a passable prompt must give away the fix (contract_is_fix), or the hidden tests pin one specific implementation.

Calibration (a human reviewer's rulings on this corpus — apply the same standard):
- "The orchestrator's relaunch path treats a live PID as a healthy session and also refuses to relaunch a session still in \`starting\`" → "cause": it names the two guards the fix changes. "…while still skipping sessions whose process is alive AND whose backend adapter is attached" → "fix": it is the new condition.
- "The SDK expects the tool's \`answers\` object to be keyed by each question's full \`question\` text. The browser currently sends something else." → "contract_is_fix": re-keying the payload IS the change; finding where the payload is built is not the hard part.
- "The group state machine already defines a recovery transition for exactly this case (\`degraded\` × \`half_respawned\` → \`active\`), but nothing in production ever triggers it" → "cause" + "fix": it diagnoses the gap and names the mechanism to use.
Pointing at an existing internal mechanism the fix should use ("already has X that nothing calls", "reuse the existing Y check") is always "cause"/"fix", even when phrased as background.

Quote spans verbatim from the prompt. Be strict: the question is not "is the prompt helpful" but "does it do the agent's diagnostic or design work for it".`;

export interface JudgeInput {
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

/** The user message for one task. Diff/test text is clipped so a huge PR
 *  cannot blow the context; the clip is marked. */
export function buildJudgeRequest(i: JudgeInput, limits = { diff: 60_000, tests: 40_000 }): string {
  return [
    `# Task ${i.id} (class: ${i.cls})`,
    `PR title (NOT shown to the agent): ${i.title}`,
    "",
    "## Prompt shown to the agent",
    "<prompt>",
    i.prompt.trimEnd(),
    "</prompt>",
    "",
    "## Required interface (new names the hidden tests use — the prompt must name these)",
    i.requiredInterface.length ? i.requiredInterface.map((n) => `- ${n}`).join("\n") : "(none)",
    "",
    "## PR source diff (base → merge; NOT shown to the agent)",
    "```diff",
    clip(i.sourceDiff, limits.diff),
    "```",
    "",
    "## Hidden tests at merge (NOT shown to the agent)",
    "```",
    clip(i.hiddenTests, limits.tests),
    "```",
    "",
    "Return the verdict as structured output.",
  ].join("\n");
}

export const JUDGE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "issues", "rationale"],
  properties: {
    verdict: { type: "string", enum: [...JUDGE_VERDICTS] },
    issues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "quote", "why"],
        properties: {
          kind: { type: "string", enum: [...JUDGE_ISSUE_KINDS] },
          quote: { type: "string" },
          why: { type: "string" },
        },
      },
    },
    rationale: { type: "string" },
  },
} as const;

export type ParsedJudgeReply = { ok: true; value: JudgeReply } | { ok: false; error: string };

/**
 * Validate a structured reply. Fail-closed: an unknown verdict/kind, a
 * missing field, or a "clean" verdict that still lists a cause/fix/
 * contract_is_fix issue is rejected (the caller re-asks or records an error),
 * never coerced into "clean".
 */
export function parseJudgeReply(v: unknown): ParsedJudgeReply {
  if (typeof v !== "object" || v === null) return { ok: false, error: "reply is not an object" };
  const r = v as Record<string, unknown>;
  if (!JUDGE_VERDICTS.includes(r.verdict as JudgeVerdictKind)) return { ok: false, error: `unknown verdict ${String(r.verdict)}` };
  if (typeof r.rationale !== "string") return { ok: false, error: "rationale must be a string" };
  if (!Array.isArray(r.issues)) return { ok: false, error: "issues must be an array" };
  const issues: JudgeIssue[] = [];
  for (const it of r.issues) {
    const o = it as Record<string, unknown>;
    if (typeof it !== "object" || it === null) return { ok: false, error: "issue is not an object" };
    if (!JUDGE_ISSUE_KINDS.includes(o.kind as JudgeIssueKind)) return { ok: false, error: `unknown issue kind ${String(o.kind)}` };
    if (typeof o.quote !== "string" || typeof o.why !== "string") return { ok: false, error: "issue.quote/why must be strings" };
    issues.push({ kind: o.kind as JudgeIssueKind, quote: o.quote, why: o.why });
  }
  const verdict = r.verdict as JudgeVerdictKind;
  if (verdict === "clean" && issues.some((i) => i.kind !== "underspecified")) {
    return { ok: false, error: "verdict clean contradicts a cause/fix/contract_is_fix issue" };
  }
  return { ok: true, value: { verdict, issues, rationale: r.rationale } };
}

export function promptSha256(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}

/** Key of a verdict: a rewritten prompt or a new rubric needs a new verdict. */
export function judgeKey(id: string, prompt: string, rubricVersion = JUDGE_RUBRIC_VERSION): string {
  return `${id}@${promptSha256(prompt)}@v${rubricVersion}`;
}

/** Latest record per key from a JSONL file (torn lines ignored). */
export function readJudgeRecords(jsonl: string): Map<string, JudgeRecord> {
  const out = new Map<string, JudgeRecord>();
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as JudgeRecord;
      if (typeof r.id === "string" && typeof r.prompt_sha256 === "string" && typeof r.rubric_version === "number") {
        out.set(`${r.id}@${r.prompt_sha256}@v${r.rubric_version}`, r);
      }
    } catch {
      // torn line — ignore
    }
  }
  return out;
}

export interface CorpusTaskRef {
  id: string;
  prompt: string;
}

export type CorpusReviewProblem = { id: string; problem: string };

/**
 * Corpus gate: every task must carry a "clean" verdict for its CURRENT prompt
 * under the CURRENT rubric. A prompt edited after judging, a missing verdict,
 * or a non-clean one is reported.
 */
export function checkCorpusReviewed(tasks: CorpusTaskRef[], records: JudgeRecord[]): CorpusReviewProblem[] {
  const byKey = new Map(records.map((r) => [`${r.id}@${r.prompt_sha256}@v${r.rubric_version}`, r]));
  const problems: CorpusReviewProblem[] = [];
  for (const t of tasks) {
    const r = byKey.get(judgeKey(t.id, t.prompt));
    if (!r) problems.push({ id: t.id, problem: "no judge verdict for the current prompt and rubric" });
    else if (r.verdict !== "clean") problems.push({ id: t.id, problem: `judge verdict is ${r.verdict}` });
  }
  return problems;
}
