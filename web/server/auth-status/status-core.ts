import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeAtomicJson } from "../atomic-write.js";
import {
  PROVIDER_IDS,
  unknownField,
  type ProviderAuthStatus,
  type ProviderId,
} from "./auth-types.js";

/**
 * Status core: the one place that turns provider probes into the status every
 * surface (REST in 1b, offline CLI in 1b, UI in 1c) shows.
 *
 *  - Identity: status is about the SERVICE user (its HOME/PATH/uid), not the
 *    calling shell. The server process is the service; the offline CLI reads
 *    `User=` / `Environment=HOME|PATH` from the installed systemd unit and, if
 *    it runs as a different uid, reports `not_verified / wrong_user` instead
 *    of silently describing root's (or another user's) credentials.
 *  - Cost: provider checks run at most once per STATUS_TTL_MS (single-flight);
 *    an explicit recheck is allowed after RECHECK_MIN_INTERVAL_MS. UI polling
 *    must only ever read the cache (owner default (b)).
 *  - Memory: the last result per provider is persisted atomically under
 *    COMPANION_HOME by the service process only, so `lastSuccessAt` survives
 *    restarts and a later network failure (S1-AC3). A corrupt or
 *    unknown-version file means "no checks yet".
 */

export const STATUS_TTL_MS = 5 * 60 * 1000;
export const RECHECK_MIN_INTERVAL_MS = 30 * 1000;
/** EC-38 tolerance: wall clock this far BEHIND a stored check = anomaly → treat as stale. */
export const CLOCK_SKEW_TOLERANCE_MS = 5 * 1000;
export const LAST_CHECK_SCHEMA_VERSION = 1;
export const LAST_CHECK_FILE = join("auth-status", "last-check.json");

// ─── Service identity ─────────────────────────────────────────────────────────

export interface ServiceIdentity {
  /** OS user the service runs as; null when no unit was found (dev / non-systemd). */
  user: string | null;
  /** Environment the probes run with (HOME/PATH of the service). */
  env: NodeJS.ProcessEnv;
  /** "service" = this process IS the service; "unit" = read from the unit; "caller" = fallback. */
  source: "service" | "unit" | "caller";
}

/**
 * Parse `User=` and `Environment=` from a systemd unit plus its drop-ins
 * (later texts override earlier ones, as systemd applies them). Only the
 * keys we need; everything else is ignored.
 */
export function parseSystemdUnit(texts: readonly string[]): { user: string | null; env: Record<string, string> } {
  let user: string | null = null;
  const env: Record<string, string> = {};
  for (const text of texts) {
    let inService = false;
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.startsWith("[")) {
        inService = line === "[Service]";
        continue;
      }
      if (!inService || line.startsWith("#") || line.startsWith(";")) continue;
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      if (key === "User") user = value || null;
      if (key === "Environment") {
        for (const assignment of splitEnvironment(value)) {
          const i = assignment.indexOf("=");
          if (i > 0) env[assignment.slice(0, i)] = assignment.slice(i + 1);
        }
      }
    }
  }
  return { user, env };
}

/** `Environment=` value → assignments; double-quoted words may contain spaces. */
function splitEnvironment(value: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2]);
  return out;
}

export interface CallerInfo {
  uid: number;
  username: string;
  env: NodeJS.ProcessEnv;
}

/**
 * Identity for the offline CLI: the unit's user + HOME/PATH when a unit is
 * installed, else the caller. `isServiceProcess` short-circuits for the
 * server itself (its own env is by definition the service env).
 */
export function resolveServiceIdentity(opts: {
  isServiceProcess: boolean;
  caller: CallerInfo;
  unitTexts: readonly string[];
}): ServiceIdentity {
  if (opts.isServiceProcess) return { user: opts.caller.username, env: opts.caller.env, source: "service" };
  if (opts.unitTexts.length === 0) return { user: null, env: opts.caller.env, source: "caller" };
  const unit = parseSystemdUnit(opts.unitTexts);
  const env: NodeJS.ProcessEnv = { ...opts.caller.env };
  if (unit.env.HOME) env.HOME = unit.env.HOME;
  if (unit.env.PATH) env.PATH = unit.env.PATH;
  return { user: unit.user, env, source: "unit" };
}

/** Status for a caller that is not the service user: say so, compute nothing. */
export function wrongUserStatus(provider: ProviderId, serviceUser: string, now: number): ProviderAuthStatus {
  return {
    provider,
    state: "not_verified",
    reason: "wrong_user",
    account: unknownField,
    plan: unknownField,
    method: unknownField,
    tokenExpiresAt: unknownField,
    lastSuccessAt: null,
    checkedAt: now,
    verifiedBy: "local",
    cli: { path: unknownField, version: unknownField },
    serviceUser,
  };
}

// ─── Persisted last check ─────────────────────────────────────────────────────

/** Minimal persisted record per provider — never tokens, never raw CLI output. */
export interface PersistedCheck {
  state: ProviderAuthStatus["state"];
  plan: string | null;
  method: string | null;
  checkedAt: number;
  lastSuccessAt: number | null;
}

export interface LastCheckFile {
  schemaVersion: typeof LAST_CHECK_SCHEMA_VERSION;
  providers: Partial<Record<ProviderId, PersistedCheck>>;
}

const STATES = new Set(["working", "invalid", "no_network", "not_verified", "not_signed_in"]);

function isPersistedCheck(v: unknown): v is PersistedCheck {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  const nullableString = (x: unknown) => x === null || typeof x === "string";
  const nullableNumber = (x: unknown) => x === null || (typeof x === "number" && Number.isFinite(x));
  return typeof o.state === "string" && STATES.has(o.state)
    && nullableString(o.plan) && nullableString(o.method)
    && typeof o.checkedAt === "number" && Number.isFinite(o.checkedAt)
    && nullableNumber(o.lastSuccessAt);
}

/** Parse the persisted file; anything unexpected → null ("no checks yet"). */
export function parseLastCheckFile(raw: string): LastCheckFile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  if (o.schemaVersion !== LAST_CHECK_SCHEMA_VERSION || !o.providers || typeof o.providers !== "object") return null;
  const providers: LastCheckFile["providers"] = {};
  for (const id of PROVIDER_IDS) {
    const entry = (o.providers as Record<string, unknown>)[id];
    if (entry === undefined) continue;
    if (!isPersistedCheck(entry)) return null;
    providers[id] = entry;
  }
  return { schemaVersion: LAST_CHECK_SCHEMA_VERSION, providers };
}

export function toPersisted(status: ProviderAuthStatus): PersistedCheck {
  return {
    state: status.state,
    plan: status.plan.known ? status.plan.value : null,
    method: status.method.known ? status.method.value : null,
    checkedAt: status.checkedAt,
    lastSuccessAt: status.lastSuccessAt,
  };
}

// ─── Core ─────────────────────────────────────────────────────────────────────

export interface StatusSnapshot {
  providers: Record<ProviderId, ProviderAuthStatus>;
  /** "service" when computed by (or as) the service; "local_cli" when the CLI computed it without the server. */
  computedBy: "service" | "local_cli";
}

export interface StatusCoreDeps {
  identity: ServiceIdentity;
  /** uid/username of the process computing the status. */
  caller: CallerInfo;
  probes: Record<ProviderId, (env: NodeJS.ProcessEnv) => Promise<ProviderAuthStatus>>;
  now: () => number;
  /** Absolute path of the persisted last-check file. */
  lastCheckPath: string;
  /** Only the service process persists; the CLI reads. */
  persist: boolean;
  readFile?: (path: string) => string;
  writeAtomic?: (path: string, payload: unknown) => void;
  computedBy: StatusSnapshot["computedBy"];
}

export type RecheckOutcome =
  | { kind: "ok"; snapshot: StatusSnapshot }
  | { kind: "too_soon"; retryAfterMs: number; snapshot: StatusSnapshot | null };

export class StatusCore {
  private cache: { snapshot: StatusSnapshot; at: number } | null = null;
  private inFlight: Promise<StatusSnapshot> | null = null;
  private lastForcedAt: number | null = null;
  private stored: LastCheckFile | null | undefined;
  /** In-memory last success per provider; independent of whether persistence works. */
  private lastSuccess: Partial<Record<ProviderId, number>> = {};

  constructor(private readonly deps: StatusCoreDeps) {}

  /** Cached snapshot if fresh, else one (shared) recomputation. */
  async get(): Promise<StatusSnapshot> {
    const now = this.deps.now();
    if (this.cache && isFresh(this.cache.at, now)) return this.cache.snapshot;
    return this.compute();
  }

  /** Cache only — never triggers a probe. For UI polling (owner default (b)). */
  peek(): StatusSnapshot | null {
    return this.cache?.snapshot ?? null;
  }

  /** Explicit recheck (POST), rate-limited to one per RECHECK_MIN_INTERVAL_MS. */
  async recheck(): Promise<RecheckOutcome> {
    const now = this.deps.now();
    if (this.lastForcedAt !== null) {
      const elapsed = now - this.lastForcedAt;
      // EC-38 anomaly form: a backwards clock is not a free pass, but must not lock out forever.
      if (elapsed >= 0 && elapsed < RECHECK_MIN_INTERVAL_MS) {
        return { kind: "too_soon", retryAfterMs: RECHECK_MIN_INTERVAL_MS - elapsed, snapshot: this.peek() };
      }
    }
    this.lastForcedAt = now;
    this.cache = null;
    return { kind: "ok", snapshot: await this.compute() };
  }

  /** Last persisted result (for "last successful check" when nothing ran yet). */
  lastStored(): LastCheckFile | null {
    if (this.stored === undefined) {
      try {
        this.stored = parseLastCheckFile((this.deps.readFile ?? defaultRead)(this.deps.lastCheckPath));
      } catch {
        this.stored = null;
      }
    }
    return this.stored;
  }

  private compute(): Promise<StatusSnapshot> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.run().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async run(): Promise<StatusSnapshot> {
    const { identity, caller } = this.deps;
    const now = this.deps.now();
    if (identity.source === "unit" && identity.user !== null && identity.user !== caller.username) {
      const providers = Object.fromEntries(
        PROVIDER_IDS.map((id) => [id, wrongUserStatus(id, identity.user!, now)]),
      ) as Record<ProviderId, ProviderAuthStatus>;
      return { providers, computedBy: this.deps.computedBy };
    }

    const results = await Promise.all(PROVIDER_IDS.map((id) => this.deps.probes[id](identity.env)));
    const stored = this.lastStored();
    const providers = {} as Record<ProviderId, ProviderAuthStatus>;
    for (const status of results) {
      const prior = this.lastSuccess[status.provider] ?? stored?.providers[status.provider]?.lastSuccessAt ?? null;
      // S1-AC3: a later failure keeps the last success time; a success advances it
      // to when the provider actually accepted the credentials.
      const lastSuccessAt = status.state === "working" ? status.lastSuccessAt ?? status.checkedAt : prior;
      if (lastSuccessAt !== null) this.lastSuccess[status.provider] = lastSuccessAt;
      providers[status.provider] = { ...status, lastSuccessAt };
    }
    const snapshot: StatusSnapshot = { providers, computedBy: this.deps.computedBy };
    this.cache = { snapshot, at: this.deps.now() };
    if (this.deps.persist) this.save(providers);
    return snapshot;
  }

  private save(providers: Record<ProviderId, ProviderAuthStatus>): void {
    const file: LastCheckFile = {
      schemaVersion: LAST_CHECK_SCHEMA_VERSION,
      providers: Object.fromEntries(PROVIDER_IDS.map((id) => [id, toPersisted(providers[id])])),
    };
    try {
      (this.deps.writeAtomic ?? defaultWriteAtomic)(this.deps.lastCheckPath, file);
      this.stored = file;
    } catch {
      // Persistence is best-effort: a failed write only loses "last success" across restarts
      // (the in-memory `lastSuccess` keeps it for this process).
    }
  }
}

/** EC-38: a check stamped in the future (clock went back) is stale, not fresh-forever. */
export function isFresh(at: number, now: number): boolean {
  if (now < at - CLOCK_SKEW_TOLERANCE_MS) return false;
  return Math.max(0, now - at) < STATUS_TTL_MS;
}

function defaultRead(path: string): string {
  return readFileSync(path, "utf-8");
}

function defaultWriteAtomic(path: string, payload: unknown): void {
  writeAtomicJson(path, payload);
}
