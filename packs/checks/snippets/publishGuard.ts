/**
 * Publish guard: the last check before LLM text becomes public.
 *
 * Copy this file into your project (no dependencies). Call `assertPublishable`
 * right before every public write. It rejects text that is obviously not a
 * final answer: a JSON envelope, a fenced code block, or internal keys / tags
 * the pipeline uses between steps.
 *
 * Lesson: auraengine published 27 raw JSON envelopes as public comments after a
 * "fallback" returned the unparsed model output (see docs/experience-packs.md).
 */

// Keys your pipeline uses internally; extend per project.
export const DEFAULT_INTERNAL_KEYS = [
  "reply", "soft", "hard", "reasoning", "analysis", "thoughts", "tool_call",
  "function_call", "schema_version", "system", "assistant",
] as const;

const TAG_RE = /<\/?(thinking|analysis|reasoning|system|scratchpad|tool_call)\b[^>]*>/i;
const FENCE_RE = /^\s*```|```\s*$/m;

export class UnpublishableText extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "UnpublishableText";
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Why `text` must not be published, or null if it looks fine. */
export function publishProblem(
  text: string | null | undefined,
  internalKeys: readonly string[] = DEFAULT_INTERNAL_KEYS,
): string | null {
  const s = (text ?? "").trim();
  if (!s) return "empty";
  if (FENCE_RE.test(s)) return "contains a fenced code block";
  if ("{[".includes(s[0]) && "}]".includes(s[s.length - 1])) {
    try {
      JSON.parse(s);
      return "is a JSON document";
    } catch {
      return "looks like (broken) JSON";
    }
  }
  if (TAG_RE.test(s)) return "contains an internal tag";
  for (const key of internalKeys) {
    if (new RegExp(`["']${escapeRegExp(key)}["']\\s*:`).test(s)) return `contains internal key "${key}"`;
  }
  return null;
}

/** Returns the trimmed text or throws. Log the reason and drop the reply;
 * never "fix" it by publishing the raw text. */
export function assertPublishable(
  text: string | null | undefined,
  internalKeys: readonly string[] = DEFAULT_INTERNAL_KEYS,
): string {
  const problem = publishProblem(text, internalKeys);
  if (problem) throw new UnpublishableText(problem);
  return (text ?? "").trim();
}
