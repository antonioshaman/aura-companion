/**
 * Shared availability resolver — the failover policy core (Council Plan Task 2).
 *
 * One PURE function, {@link resolveModelAvailability}, houses the whole
 * proactive-substitution policy: **1-hop cap, no loop, no cross-tier, no
 * cross-provider**. Both backends consult it as named siblings (the Claude
 * pre-send gate in Task 5; the Codex exclusion-union in Task 4) — it is the
 * single policy seam, not a unifying abstraction over the two catalog sources.
 *
 * --- The lattice (Willison) ---
 *
 * Runtime truth ALWAYS wins recovery. The registry may only **narrow or
 * annotate** the candidate set: it can suppress a `retired`/`blocked` model or
 * point at a `replacement`, but a registry `active` mark can NEVER resurrect a
 * model that live truth (a runtime error) has killed. `exclusions` carries the
 * runtime-killed ids and is checked BEFORE any registry-`active` happy path, so
 * an `active` mark can never un-exclude.
 *
 * --- Argv safety (Hunt REC-1) ---
 *
 * Every emitted id (`ok.model`, `substituted.to`) re-passes
 * {@link isValidModelIdForBackend}. The function is structurally incapable of
 * handing an unvalidated value to a spawn/`set_model` path.
 *
 * Pure + injectable: `lookup` defaults to the live registry but tests pass a
 * fixture for zero disk/network (Task 11).
 */

import type { BackendType } from "./session-types.js";
import {
  type ModelRegistryEntry,
  type ModelStatus,
  getModelRegistry,
  isValidModelIdForBackend,
  lookupModel,
} from "./model-registry.js";

/** A model is suppressed (must not be offered/launched) when retired or blocked. */
export type SuppressedStatus = "retired" | "blocked";

/** Single source of the "is this status suppressed?" predicate. */
export function isModelSuppressed(status: ModelStatus): status is SuppressedStatus {
  return status === "retired" || status === "blocked";
}

export type UnavailableReason =
  /** The requested id itself fails model-id validation — never emitted to argv. */
  | "invalid-id"
  /** Suppressed/killed and no `replacement` is configured — retain current. */
  | "no-replacement"
  /** A `replacement` is configured but fails model-id validation — retain current. */
  | "replacement-invalid"
  /** One-hop cap: the `replacement` is itself suppressed or runtime-excluded —
   *  resolution stops, NO cascade, retain current. */
  | "replacement-unavailable";

/**
 * Outcome of {@link resolveModelAvailability}.
 * - `ok`               — use `model` as requested.
 * - `substituted`      — auto-swap `from`→`to` (same provider, same tier, 1 hop).
 * - `needs-user-action`— the only valid replacement crosses a cost tier; the
 *                        server must NOT swap silently — surface for explicit
 *                        user action (spec ⚠️ Ask-first boundary).
 * - `unavailable`      — keep the current model; surface a single notice.
 */
export type ModelAvailabilityResolution =
  | { kind: "ok"; model: string }
  | { kind: "substituted"; from: string; to: string; reason: SuppressedStatus }
  | {
      kind: "needs-user-action";
      from: string;
      to: string;
      reason: "cross-tier";
      suppressed: SuppressedStatus;
    }
  | { kind: "unavailable"; model: string; reason: UnavailableReason };

/** Injectable single-entry lookup. Defaults to the live registry overlay. */
export type ResolverLookup = (backend: BackendType, id: string) => ModelRegistryEntry | null;

export interface ResolveModelOptions {
  backend: BackendType;
  /** The model id the session/user wants to run. */
  requested: string;
  /**
   * Runtime-killed ids for this session (404/403/etc. already observed). These
   * win over the registry — a model here is never returned `ok`, even if the
   * registry marks it `active`. The reactive revert path owns recovery; this
   * set only prevents the proactive path from re-offering a known-dead model.
   */
  exclusions?: Iterable<string>;
  /** Injectable for hermetic tests; defaults to {@link lookupModel}. */
  lookup?: ResolverLookup;
}

/**
 * Resolve whether `requested` can be launched, and if not, whether a single
 * registry `replacement` hop lands on a usable same-tier model.
 *
 * Pure. Never throws. Never emits an unvalidated id.
 */
export function resolveModelAvailability(opts: ResolveModelOptions): ModelAvailabilityResolution {
  const { backend, requested } = opts;
  const lookup = opts.lookup ?? lookupModel;
  const excluded = opts.exclusions instanceof Set ? opts.exclusions : new Set(opts.exclusions ?? []);

  // Hunt REC-1: a structurally-invalid requested id must never reach argv,
  // and there is nothing safe to substitute toward — retain current.
  if (!isValidModelIdForBackend(backend, requested)) {
    return { kind: "unavailable", model: requested, reason: "invalid-id" };
  }

  const entry = lookup(backend, requested);
  const suppressedByRegistry = entry !== null && isModelSuppressed(entry.status);
  const killedAtRuntime = excluded.has(requested);

  // Happy path: neither the registry nor runtime truth objects → use as-is.
  if (!suppressedByRegistry && !killedAtRuntime) {
    return { kind: "ok", model: requested };
  }

  // The requested model is unusable. Reason for the user-facing notice: the
  // registry status when it suppressed; otherwise a runtime kill of a
  // registry-`active` model reads as `blocked` (lattice: runtime wins).
  const reason: SuppressedStatus =
    suppressedByRegistry && entry !== null && isModelSuppressed(entry.status) ? entry.status : "blocked";

  const replacement = entry?.replacement ?? null;
  if (replacement === null) {
    return { kind: "unavailable", model: requested, reason: "no-replacement" };
  }

  // Re-validate the replacement before it can become an emitted id.
  if (!isValidModelIdForBackend(backend, replacement)) {
    return { kind: "unavailable", model: requested, reason: "replacement-invalid" };
  }

  // One-hop cap (no cascade): the replacement must itself be usable. If it is
  // suppressed or runtime-excluded, resolution STOPS here and the current
  // model is retained — we never chase a second replacement.
  const repEntry = lookup(backend, replacement);
  const repSuppressed = repEntry !== null && isModelSuppressed(repEntry.status);
  if (repSuppressed || excluded.has(replacement)) {
    return { kind: "unavailable", model: requested, reason: "replacement-unavailable" };
  }

  // No-cross-tier: if both tiers are known and differ, the swap crosses a cost
  // tier — require explicit user action rather than swapping silently. When a
  // tier is unknown on either side we cannot prove a crossing, so we inform
  // (substitute) — the conservative same-tier-by-default behaviour.
  if (entry?.tier && repEntry?.tier && entry.tier !== repEntry.tier) {
    return { kind: "needs-user-action", from: requested, to: replacement, reason: "cross-tier", suppressed: reason };
  }

  return { kind: "substituted", from: requested, to: replacement, reason };
}

/**
 * Collect every suppressed (`retired`/`blocked`) model id for a backend. Task 4
 * unions this into the Codex launcher's per-session `rejectedCodexModels` set so
 * the existing scorer never lands on a registry-dead slug — reusing this policy
 * helper instead of duplicating the suppression predicate.
 *
 * Injectable registry for hermetic tests; defaults to the live overlay.
 */
export function getSuppressedModelIds(
  backend: BackendType,
  registry: ReadonlyMap<string, ModelRegistryEntry> = getModelRegistry().entries,
): Set<string> {
  const out = new Set<string>();
  for (const entry of registry.values()) {
    if (entry.backend === backend && isModelSuppressed(entry.status)) out.add(entry.id);
  }
  return out;
}
