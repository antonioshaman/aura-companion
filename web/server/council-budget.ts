/**
 * Council budget guard — per-pair token accounting and a kill-switch for
 * AUTOMATIC activity.
 *
 * Council pairs run on Claude / Codex subscriptions, so the real risk is not
 * a dollar bill but a looping pair (checkpoint → observer wake → auto-proceed
 * → checkpoint …) silently burning subscription quota while nobody watches.
 * `total_cost_usd` cannot measure that (Codex reports 0), so tokens are the
 * unit. Both backends deliver per-turn usage in Claude's shape on the
 * `result` frame (`codex-turn-usage.ts` normalises Codex's
 * `thread/tokenUsage/updated`), so one accumulator covers both.
 *
 * What counts against the budget: input + output + cache-creation tokens of
 * BOTH halves. Cache reads are tracked and shown but excluded — they are
 * 95–99 % of prompt tokens on long sessions (prod `llm.turn_usage`, Oct 2026:
 * 193 M cache-read vs 2.4 M cache-write on the heaviest session) and are
 * billed/rate-limited at a fraction of fresh input, so counting them would
 * make any sane limit either useless or trip on legit work.
 *
 * When the spend since the pair was created (or last continued) crosses the
 * limit, the guard flips `exceeded`. Callers then stop automatic activity
 * only — observer wakes, the second-opinion run and auto-proceed. Nothing is
 * killed and no user-driven turn is interrupted. A human continues the pair
 * (`POST /api/groups/:id/budget/continue`), which restarts the spend window
 * and may set a pair-specific limit.
 *
 * Persistence: `<workspace>/.council/state/<group>-budget.json`, the same
 * server-written state dir as disputes / resolved STOPs / second-reviewer
 * (the observer cannot write `.council/state/`). A restart must not hand a
 * looping pair a fresh budget.
 */

import { readFileSync } from "node:fs";
import { writeAtomicJson } from "./atomic-write.js";
import { resolveCouncilStatePath } from "./council-state-path.js";
import type { BrowserCouncilBudget, CouncilRoleUsage } from "./session-types.js";

/**
 * Default per-pair budget: 20 M budgeted tokens (input + output +
 * cache-creation, cache reads excluded).
 *
 * Rationale (prod `llm.turn_usage`, last 30 days of journal): the heaviest
 * single session spent 2.85 M budgeted tokens over 41 turns (~70 K/turn); the
 * next ones 0.6–1.1 M. 20 M is ~7× the heaviest session — a multi-day
 * implement/review pair rarely reaches it — while a runaway loop at ~70 K per
 * turn, one turn every ~2 min (~2 M/h), is stopped within ~10 hours, i.e.
 * before an unattended night eats the weekly quota. Legit work that hits it
 * costs one click on Continue.
 */
export const DEFAULT_COUNCIL_MAX_TOKENS_PER_GROUP = 20_000_000;
/** Upper bound for any configured limit (env or per pair). */
export const MAX_COUNCIL_TOKEN_LIMIT = 1_000_000_000_000;
export const COUNCIL_BUDGET_ENV = "COMPANION_COUNCIL_MAX_TOKENS_PER_GROUP";
export const COUNCIL_BUDGET_SCHEMA_VERSION = 1;
const BUDGET_SUFFIX = "-budget.json";

export type CouncilBudgetRole = "orchestrator" | "observer";

/** Per-turn usage in Claude's `result.usage` shape (both backends). */
export interface TurnUsageLike {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

function n(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

export function isValidTokenLimit(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_COUNCIL_TOKEN_LIMIT;
}

/**
 * Resolve the server default from the env. Unset/empty → default; `0` →
 * disabled; anything malformed keeps the default (fail toward guarding) and
 * returns a warning for the caller to log.
 */
export function resolveCouncilBudgetLimit(env: Record<string, string | undefined>): { limit: number; warning?: string } {
  const raw = env[COUNCIL_BUDGET_ENV];
  if (raw === undefined || raw.trim() === "") return { limit: DEFAULT_COUNCIL_MAX_TOKENS_PER_GROUP };
  const trimmed = raw.trim().replace(/_/g, "");
  const parsed = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
  if (!isValidTokenLimit(parsed)) {
    return {
      limit: DEFAULT_COUNCIL_MAX_TOKENS_PER_GROUP,
      warning: `${COUNCIL_BUDGET_ENV}=${JSON.stringify(raw)} is not a non-negative integer ≤ ${MAX_COUNCIL_TOKEN_LIMIT}; using the default ${DEFAULT_COUNCIL_MAX_TOKENS_PER_GROUP}`,
    };
  }
  return { limit: parsed };
}

export function emptyRoleUsage(): CouncilRoleUsage {
  return { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, turns: 0 };
}

/** Budgeted tokens of one usage bucket — cache reads excluded. */
export function budgetedTokens(u: CouncilRoleUsage): number {
  return u.inputTokens + u.outputTokens + u.cacheCreationTokens;
}

/** Fold one turn's usage into a role bucket (pure). Zero-usage turns don't count as turns. */
export function addTurnUsage(into: CouncilRoleUsage, usage: TurnUsageLike): CouncilRoleUsage {
  const add = {
    inputTokens: n(usage.input_tokens),
    outputTokens: n(usage.output_tokens),
    cacheCreationTokens: n(usage.cache_creation_input_tokens),
    cacheReadTokens: n(usage.cache_read_input_tokens),
  };
  const any = add.inputTokens + add.outputTokens + add.cacheCreationTokens + add.cacheReadTokens > 0;
  return {
    inputTokens: into.inputTokens + add.inputTokens,
    outputTokens: into.outputTokens + add.outputTokens,
    cacheCreationTokens: into.cacheCreationTokens + add.cacheCreationTokens,
    cacheReadTokens: into.cacheReadTokens + add.cacheReadTokens,
    turns: into.turns + (any ? 1 : 0),
  };
}

/** On-disk + in-memory state of one pair. */
export interface GroupBudgetState {
  byRole: { orchestrator: CouncilRoleUsage; observer: CouncilRoleUsage };
  /** Budgeted lifetime total at the last Continue — spend = total − baseline. */
  baselineTokens: number;
  /** Pair-specific limit set on Continue; absent → server default. */
  limitOverride?: number;
  /** Epoch ms the limit was crossed; cleared by Continue. */
  exceededAt?: number;
}

function emptyState(): GroupBudgetState {
  return { byRole: { orchestrator: emptyRoleUsage(), observer: emptyRoleUsage() }, baselineTokens: 0 };
}

function totalBudgeted(s: GroupBudgetState): number {
  return budgetedTokens(s.byRole.orchestrator) + budgetedTokens(s.byRole.observer);
}

function parseRoleUsage(v: unknown): CouncilRoleUsage | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  return {
    inputTokens: n(o.inputTokens),
    outputTokens: n(o.outputTokens),
    cacheCreationTokens: n(o.cacheCreationTokens),
    cacheReadTokens: n(o.cacheReadTokens),
    turns: n(o.turns),
  };
}

export type BudgetReadResult =
  | { ok: true; state: GroupBudgetState | null }
  | { ok: false; reason: "path-error" | "unreadable" | "invalid-json" | "invalid-shape" };

/** Read a pair's persisted budget. Missing file → `state: null`. Never throws. */
export function readGroupBudget(workspaceRoot: string, groupId: string): BudgetReadResult {
  const p = resolveCouncilStatePath(workspaceRoot, groupId, BUDGET_SUFFIX);
  if (!p.ok) return { ok: false, reason: "path-error" };
  let raw: string;
  try {
    raw = readFileSync(p.value.absolutePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, state: null };
    return { ok: false, reason: "unreadable" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "invalid-json" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, reason: "invalid-shape" };
  const o = parsed as Record<string, unknown>;
  const roles = o.byRole as Record<string, unknown> | undefined;
  const orchestrator = parseRoleUsage(roles?.orchestrator);
  const observer = parseRoleUsage(roles?.observer);
  if (o.schemaVersion !== COUNCIL_BUDGET_SCHEMA_VERSION || !orchestrator || !observer) {
    return { ok: false, reason: "invalid-shape" };
  }
  return {
    ok: true,
    state: {
      byRole: { orchestrator, observer },
      baselineTokens: n(o.baselineTokens),
      ...(isValidTokenLimit(o.limitOverride) ? { limitOverride: o.limitOverride } : {}),
      ...(n(o.exceededAt) > 0 ? { exceededAt: n(o.exceededAt) } : {}),
    },
  };
}

export function writeGroupBudget(
  workspaceRoot: string,
  groupId: string,
  state: GroupBudgetState,
): { ok: true } | { ok: false; reason: "path-error" | "write-failed"; detail?: string } {
  const p = resolveCouncilStatePath(workspaceRoot, groupId, BUDGET_SUFFIX);
  if (!p.ok) return { ok: false, reason: "path-error" };
  try {
    writeAtomicJson(
      p.value.absolutePath,
      { schemaVersion: COUNCIL_BUDGET_SCHEMA_VERSION, sessionGroupId: groupId, ...state },
      { maxBytes: 16 * 1024 },
    );
  } catch (err) {
    return { ok: false, reason: "write-failed", detail: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true };
}

/** EC-9 payload handed to `onExceeded`. */
export interface BudgetExceededEvent {
  sessionGroupId: string;
  /** The half whose turn crossed the limit. */
  sessionId: string;
  role: CouncilBudgetRole;
  budget: BrowserCouncilBudget;
}

export interface CouncilBudgetTrackerDeps {
  /** Server default (already resolved from env); 0 disables. */
  defaultLimit: number;
  /** Workspace of the pair, once its `.council/` watcher is armed. */
  cwdFor: (sessionGroupId: string) => string | undefined;
  now?: () => number;
  read?: typeof readGroupBudget;
  write?: typeof writeGroupBudget;
  /** Persistence problems — logged by the caller. */
  onPersistError?: (sessionGroupId: string, op: "read" | "write", reason: string) => void;
}

export type ContinueBudgetResult =
  | { ok: true; budget: BrowserCouncilBudget; wasExceeded: boolean }
  | { ok: false; reason: "unknown_group" | "invalid_input" };

/**
 * In-memory accumulator per pair, write-through to `.council/state/`. Loaded
 * lazily on first touch once the pair's workspace is known; usage recorded
 * before that is merged into whatever the file holds.
 */
export class CouncilBudgetTracker {
  private readonly states = new Map<string, GroupBudgetState>();
  /** Groups whose on-disk state has been merged in. */
  private readonly loaded = new Set<string>();
  private readonly now: () => number;
  private readonly read: typeof readGroupBudget;
  private readonly write: typeof writeGroupBudget;

  constructor(private readonly deps: CouncilBudgetTrackerDeps) {
    this.now = deps.now ?? Date.now;
    this.read = deps.read ?? readGroupBudget;
    this.write = deps.write ?? writeGroupBudget;
  }

  private stateFor(sessionGroupId: string): GroupBudgetState {
    let state = this.states.get(sessionGroupId);
    if (!state) {
      state = emptyState();
      this.states.set(sessionGroupId, state);
    }
    if (!this.loaded.has(sessionGroupId)) {
      const cwd = this.deps.cwdFor(sessionGroupId);
      if (cwd) {
        this.loaded.add(sessionGroupId);
        const res = this.read(cwd, sessionGroupId);
        if (!res.ok) {
          this.deps.onPersistError?.(sessionGroupId, "read", res.reason);
        } else if (res.state) {
          // Merge: anything recorded in memory before the workspace was known
          // is added on top of the persisted totals.
          const disk = res.state;
          const merged: GroupBudgetState = {
            byRole: {
              orchestrator: sumRole(disk.byRole.orchestrator, state.byRole.orchestrator),
              observer: sumRole(disk.byRole.observer, state.byRole.observer),
            },
            baselineTokens: disk.baselineTokens,
            ...(disk.limitOverride !== undefined ? { limitOverride: disk.limitOverride } : {}),
            ...(disk.exceededAt !== undefined ? { exceededAt: disk.exceededAt } : {}),
          };
          this.states.set(sessionGroupId, merged);
          state = merged;
        }
      }
    }
    return state;
  }

  private persist(sessionGroupId: string, state: GroupBudgetState): void {
    const cwd = this.deps.cwdFor(sessionGroupId);
    if (!cwd) return;
    const res = this.write(cwd, sessionGroupId, state);
    if (!res.ok) this.deps.onPersistError?.(sessionGroupId, "write", res.detail ? `${res.reason}: ${res.detail}` : res.reason);
  }

  private limitOf(state: GroupBudgetState): number {
    return state.limitOverride ?? this.deps.defaultLimit;
  }

  private snapshotOf(sessionGroupId: string, state: GroupBudgetState): BrowserCouncilBudget {
    return {
      sessionGroupId,
      limitTokens: this.limitOf(state),
      limitSource: state.limitOverride !== undefined ? "group" : "env",
      spentTokens: Math.max(0, totalBudgeted(state) - state.baselineTokens),
      exceeded: state.exceededAt !== undefined,
      ...(state.exceededAt !== undefined ? { exceededAt: state.exceededAt } : {}),
      byRole: { orchestrator: { ...state.byRole.orchestrator }, observer: { ...state.byRole.observer } },
    };
  }

  /**
   * Fold one turn's usage. Returns the exceeded event exactly once — on the
   * turn that crosses the limit — and null otherwise (already exceeded, under
   * the limit, guard disabled, or a zero-usage turn).
   */
  recordTurn(
    sessionGroupId: string,
    sessionId: string,
    role: CouncilBudgetRole,
    usage: TurnUsageLike | undefined,
  ): BudgetExceededEvent | null {
    if (!usage) return null;
    const state = this.stateFor(sessionGroupId);
    const before = state.byRole[role];
    const after = addTurnUsage(before, usage);
    if (after.turns === before.turns) return null; // zero-usage frame
    state.byRole[role] = after;
    const limit = this.limitOf(state);
    let crossed = false;
    if (limit > 0 && state.exceededAt === undefined && totalBudgeted(state) - state.baselineTokens >= limit) {
      state.exceededAt = this.now();
      crossed = true;
    }
    this.persist(sessionGroupId, state);
    return crossed ? { sessionGroupId, sessionId, role, budget: this.snapshotOf(sessionGroupId, state) } : null;
  }

  /** True while the pair's automatic activity must stay paused. */
  isExceeded(sessionGroupId: string): boolean {
    if (!this.states.has(sessionGroupId) && !this.deps.cwdFor(sessionGroupId)) return false;
    return this.stateFor(sessionGroupId).exceededAt !== undefined;
  }

  snapshot(sessionGroupId: string): BrowserCouncilBudget {
    return this.snapshotOf(sessionGroupId, this.stateFor(sessionGroupId));
  }

  /**
   * A human continues the pair: restart the spend window and optionally set
   * a pair-specific limit (`0` = no guard for this pair). Lifetime per-role
   * totals are kept.
   */
  continue(sessionGroupId: string, opts: { limitTokens?: number } = {}): ContinueBudgetResult {
    if (opts.limitTokens !== undefined && !isValidTokenLimit(opts.limitTokens)) {
      return { ok: false, reason: "invalid_input" };
    }
    const state = this.stateFor(sessionGroupId);
    const wasExceeded = state.exceededAt !== undefined;
    state.baselineTokens = totalBudgeted(state);
    delete state.exceededAt;
    if (opts.limitTokens !== undefined) state.limitOverride = opts.limitTokens;
    this.persist(sessionGroupId, state);
    return { ok: true, budget: this.snapshotOf(sessionGroupId, state), wasExceeded };
  }

  /** Drop the in-memory copy (pair exited). The file stays for a later unarchive. */
  forget(sessionGroupId: string): void {
    this.states.delete(sessionGroupId);
    this.loaded.delete(sessionGroupId);
  }
}

function sumRole(a: CouncilRoleUsage, b: CouncilRoleUsage): CouncilRoleUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    turns: a.turns + b.turns,
  };
}
