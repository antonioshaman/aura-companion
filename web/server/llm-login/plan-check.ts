import { assertNever, type Known, type PlanCheck, type ProviderId } from "../auth-status/auth-types.js";

/**
 * Plan check (phase 2 task 7, D7): the signed-in plan against the owner's
 * optional expectation. One normalisation, one comparison — the status REST,
 * the sign-in window and the CLI all read the result, never compare plans
 * themselves. Pure, no Node imports (the settings UI imports the list).
 */

/** Plans the owner may expect, per provider (closed list; "max" = any Max tier). */
export const EXPECTED_PLANS: Readonly<Record<ProviderId, readonly string[]>> = {
  claude: ["pro", "max", "team", "enterprise"],
  codex: ["plus", "pro", "team", "business", "enterprise"],
};

/** Every plan the provider is known to report (expectable plans + free tiers). */
const OBSERVED_PLANS: Readonly<Record<ProviderId, readonly string[]>> = {
  claude: ["free", ...EXPECTED_PLANS.claude],
  codex: ["free", "go", "edu", ...EXPECTED_PLANS.codex],
};

/** Owner expectations, stored in settings. A missing provider = no expectation. */
export type ExpectedPlans = Partial<Record<ProviderId, string>>;

function providerPrefix(provider: ProviderId): string {
  switch (provider) {
    case "claude": return "claude_";
    case "codex": return "chatgpt_";
    default: return assertNever(provider);
  }
}

/**
 * Provider string → vocabulary value, or null when unrecognised. Claude reports
 * Max tiers as e.g. `max_20x`; every Max tier is "max".
 */
export function normalizeObservedPlan(provider: ProviderId, raw: string): string | null {
  let value = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  const prefix = providerPrefix(provider);
  if (value.startsWith(prefix)) value = value.slice(prefix.length);
  if (provider === "claude" && /^max(_|$)/.test(value)) value = "max";
  return OBSERVED_PLANS[provider].includes(value) ? value : null;
}

/** A user-supplied expectation → canonical value, or null when not on the provider's list. */
export function parseExpectedPlan(provider: ProviderId, raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  return EXPECTED_PLANS[provider].includes(value) ? value : null;
}

/** Settings-file normalisation: keep valid expectations, drop anything else silently. */
export function normalizeExpectedPlans(raw: unknown): ExpectedPlans {
  const out: ExpectedPlans = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const record = raw as Record<string, unknown>;
  for (const provider of ["claude", "codex"] as const) {
    const plan = parseExpectedPlan(provider, record[provider]);
    if (plan) out[provider] = plan;
  }
  return out;
}

/** `unknown` is never `match`: an unreported or unrecognised plan cannot satisfy an expectation. */
export function planCheck(provider: ProviderId, observed: Known<string>, expected: string | null): PlanCheck {
  if (expected === null) return "unset";
  if (!observed.known) return "unknown";
  const plan = normalizeObservedPlan(provider, observed.value);
  if (plan === null) return "unknown";
  return plan === expected ? "match" : "mismatch";
}

/**
 * A REST patch `{ claude?: plan | null, codex?: plan | null }` applied to the
 * current expectations: `null` removes one, an off-list plan or an unknown
 * provider key is refused (the REST surface is strict; only a hand-edited
 * settings file is normalised silently).
 */
export function applyExpectedPlansPatch(
  current: ExpectedPlans,
  raw: unknown,
): { ok: true; value: ExpectedPlans } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "expectedPlans must be an object" };
  const next: ExpectedPlans = { ...current };
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key !== "claude" && key !== "codex") return { ok: false, error: `expectedPlans: unknown provider ${JSON.stringify(key)}` };
    if (value === null) {
      delete next[key];
      continue;
    }
    const plan = parseExpectedPlan(key, value);
    if (!plan) return { ok: false, error: `expectedPlans.${key} must be one of ${EXPECTED_PLANS[key].join(", ")} or null` };
    next[key] = plan;
  }
  return { ok: true, value: next };
}
