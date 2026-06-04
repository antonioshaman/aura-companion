/**
 * Anthropic /v1/models dynamic-list cache (PLAN-aura-dynamic-model-list Tasks 1-5).
 *
 * Server-side cache for the Anthropic `/v1/models` REST endpoint. Mirrors the
 * existing Codex pattern at `routes.ts:/backends/codex/models` but with one
 * critical asymmetry: Codex CLI writes its own `~/.codex/models_cache.json`,
 * so the Aura server reads that file as-is. Anthropic's CLI does NOT expose
 * a models cache file, so the server here both FETCHES upstream AND OWNS the
 * disk cache.
 *
 * Module surface (discriminated-union):
 *   {@link AnthropicModelsResult} — every call resolves to one of:
 *     ok / no-key / upstream-auth / upstream-unavailable
 *   The Hono handler at `routes.ts` maps these directly to HTTP status codes
 *   (200 / 404 / 502 / 502) — see Task 6.
 *
 * Two-tier cache:
 *   - In-memory  (TTL {@link IN_MEMORY_TTL_MS}, 1h): hot path, zero-IO hit
 *   - Disk       (ceiling {@link DISK_STALENESS_CEILING_MS}, 24h): warm-start
 *     on bun cold restart; survives process restarts.
 *
 * Key rotation invalidation:
 *   The cache record carries {@link CachedModelsRecord.key_fingerprint} — a
 *   SHA-256 hex prefix of the active API key. Hit predicate requires fingerprint
 *   match (Task 4 implements the predicate). Rotating the key produces a new
 *   fingerprint, fresh cache miss, full re-fetch.
 *
 * --- THIS MODULE DELIBERATELY DOES NOT (negative-space documentation) ---
 *
 * - **No debounce.** Writes are rare (≤1/h memory TTL, ≤1/24h disk ceiling).
 *   In-memory cache is the authoritative source until next read.
 * - **No rotation.** Cache file is a single bounded-size JSON (~few KB max
 *   for the model list). Unlike `recorder.ts` JSONL which grows unboundedly.
 * - **No orphan-sweep.** Stale cache file is freely replaceable from the
 *   network. A 25h-old file is a "free re-fetch on next read", not a state
 *   machine orphan that needs reconciliation.
 * - **No `fs.watch`.** Cache is poll-on-request. EC-12 (`fs.watch`-driven
 *   pipelines require pre-scan reconcile) does not apply.
 * - **No probe-spawn validation.** Adding `claude --list-models` to verify
 *   ids would create an un-tracked subprocess class with no PID registry,
 *   no idle-kill, no stdio drain. Model validity is upstream's concern;
 *   CLI's spawn-time rejection is the only acceptable runtime check.
 *
 * Reference: PLAN-aura-dynamic-model-list.md — convergent recommendations from
 * Fowler (extract from routes.ts god-module), Backend (testability),
 * Deploy (file-granular coverage gate), Persistence (atomic write floor).
 */

import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { join, resolve as resolvePath, sep } from "node:path";
import { COMPANION_HOME } from "./paths.js";
import { writeAtomicJson } from "./atomic-write.js";
import { log } from "./logger.js";

// ── Schema versioning (Persistence P8) ──────────────────────────────────────

/**
 * Disk cache schema version. Strict equality on read — any other value
 * (including absence) treats the file as a cache-miss, log structured warn,
 * fetch fresh from upstream. New format ships as v2 with a separate parser
 * branch; v1 is never silently migrated.
 */
export const SCHEMA_VERSION = 1 as const;

// ── Cache lifecycle bounds ──────────────────────────────────────────────────

/** In-memory cache TTL — within this window the disk read is skipped. */
export const IN_MEMORY_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Disk staleness ceiling. Beyond this age, disk cache is treated as miss
 * (must re-fetch). The exception is "upstream unreachable + disk stale" —
 * Persistence P3 + Backend R2: serve stale, log loudly, prefer availability
 * over freshness when the alternative is a hard fail.
 */
export const DISK_STALENESS_CEILING_MS = 24 * 60 * 60 * 1000; // 24 hours

// ── HTTP boundary ───────────────────────────────────────────────────────────

/**
 * Upstream endpoint — module-scope constant so it can never be derived from
 * request input (Hunt SSRF defence). Never interpolate the route's `:id`
 * param or any other user-derived bytes into this URL.
 */
export const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models" as const;

/**
 * `anthropic-version` request header value. Pinned constant — when Anthropic
 * bumps the version, the parser may need updating in lockstep, so a floating
 * version is a silent compat-break. Re-record the fixture (Task 2) on bumps.
 */
export const ANTHROPIC_VERSION_HEADER = "2023-06-01" as const;

/**
 * Outer bound on the upstream fetch. Bun's native `fetch` has NO default
 * timeout — without this, a hung TLS handshake pins a Hono worker until
 * the kernel TCP timeout (~75s+) or the client gives up. 5s is generous
 * for a small JSON response; faster failures land in the cache-served-stale
 * fallback path.
 */
export const FETCH_TIMEOUT_MS = 5_000;

// ── Disk artifact location ──────────────────────────────────────────────────

/**
 * Cache file basename. EC-20 path-as-constant — exported so tests and the
 * writer reference the same string. Never construct this filename inline.
 */
export const ANTHROPIC_MODELS_CACHE_FILENAME = "anthropic_models_cache.json";

/**
 * Resolved absolute path to the cache file. Honours `COMPANION_HOME` env
 * override (`paths.ts` precedent for managed deploys).
 */
export const ANTHROPIC_MODELS_CACHE_PATH = join(
  COMPANION_HOME,
  ANTHROPIC_MODELS_CACHE_FILENAME,
);

/**
 * EC-23 sentinel for cache file path in structured log payloads. Raw
 * filesystem bytes never appear in logs — operator topology leak
 * (username under `/home/`, project name under `/Users/`) is the egress
 * channel EC-23 closes.
 */
export const ANTHROPIC_MODELS_CACHE_LOG_LABEL =
  "<companion-cache:anthropic-models>" as const;

// ── Fingerprint discipline ──────────────────────────────────────────────────

/**
 * Length of the SHA-256 hex prefix stored as `key_fingerprint`. 16 hex chars
 * = 8 bytes of entropy — sufficient to disambiguate cache validity across
 * key rotations for a single-user instance, low enough that the truncated
 * hash is not directly invertible into the original key bytes.
 *
 * Documented as a single constant so tests, writers, and readers reference
 * one source of truth (EC-20).
 */
export const KEY_FINGERPRINT_HEX_LEN = 16;

// ── Disk cache record (writer + reader schema, AP-3 co-located) ─────────────

/**
 * The on-disk cache record. Schema version stamped at write time; rejected
 * on read if not strict-equal to {@link SCHEMA_VERSION}.
 *
 * `key_fingerprint` is a SHA-256 hex prefix of the API key the records were
 * fetched against — used to invalidate the cache on key rotation. NEVER the
 * raw key, NEVER the full hash. Defensive runtime assertion in the writer
 * (Task 4) verifies the serialised payload does not contain raw key bytes.
 *
 * `fetched_at` is an epoch-ms timestamp at the moment of the successful
 * upstream response — drives the in-memory TTL and disk staleness ceiling
 * predicates. Single-source-of-truth field per EC-21 (log lines derive
 * `cache_age_ms` from this, never recompute from `Date.now()` at log time).
 */
export interface CachedModelsRecord {
  schema_version: typeof SCHEMA_VERSION;
  fetched_at: number;
  key_fingerprint: string;
  models: BackendModelInfo[];
}

// ── Browser-visible model shape ─────────────────────────────────────────────

/**
 * Server-side mirror of the frontend `BackendModelInfo` (`web/src/api.ts:252`).
 * The shape crosses the REST boundary identically; both sides reference this
 * file's structural definition (Fowler R2 — one authoritative shape, no
 * parallel definitions held together by hope).
 *
 * Strings are bounded at ingest (Task 2 parser): `value` ≤128 chars, `label`
 * ≤256 chars, `description` ≤256 chars. Bounding at construction site
 * (Persistence P6 / Hunt Trojan-Source defence) means downstream consumers
 * — including any future tooltip / status pill / dropdown render — can
 * trust the bytes without re-validating.
 */
export interface BackendModelInfo {
  value: string;
  label: string;
  description: string;
}

// ── Per-request result discriminated union (Backend R1 + Fowler R1) ─────────

/**
 * Every `getAnthropicModels()` call resolves to exactly one of these shapes.
 * The Hono handler at `routes.ts` switches on `kind` and maps to HTTP status
 * + response body (Task 6). Adding a new variant goes red at every consumer
 * site (EC-15 exhaustiveness discipline).
 *
 * `ok` carries `source` ("memory" | "disk" | "network") so EC-21 log
 * triplets reference one record, not optional spreads of independent fields.
 *
 * `upstream-unavailable.reason` discriminates the failure subkind for
 * forensic logging — never echoed verbatim to the browser (Hunt R2 — 502
 * body is a fixed enum, never upstream prose).
 */
export type AnthropicModelsResult =
  | {
      kind: "ok";
      source: "memory" | "disk" | "network";
      models: BackendModelInfo[];
      fetched_at: number;
    }
  | { kind: "no-key" }
  | { kind: "upstream-auth"; httpStatus: number }
  | {
      kind: "upstream-unavailable";
      reason: "network" | "5xx" | "timeout" | "parse";
    };

// ── Upstream response parser (Task 2, EC-5 boundary) ────────────────────────

/**
 * Intermediate shape — pre-sort, pre-label-normalisation. Internal to this
 * module; the public boundary returns `BackendModelInfo[]` via the combined
 * {@link parseAndPrepareAnthropicModels} helper.
 */
interface ParsedAnthropicModel {
  id: string;
  display_name: string | undefined;
  /** epoch ms; `undefined` when upstream omits `created_at`. */
  created_at: number | undefined;
}

/**
 * Outcome of {@link parseAnthropicModelsResponse}. `reason` discriminates
 * the failure subkind so the caller (Task 6 handler) can map cleanly to
 * the structured-log shape without inspecting the raw bytes a second time.
 *
 * - `envelope`     — top-level shape is not `{ data: ... }`
 * - `no-data-array` — `data` is present but not an array
 * - `empty`        — `data` is an array but no entry passed validation
 */
export type ParseAnthropicResult =
  | {
      ok: true;
      models: ParsedAnthropicModel[];
      droppedItems: number;
      hasMore: boolean;
    }
  | { ok: false; reason: "envelope" | "no-data-array" | "empty" };

/**
 * Combined result of {@link parseAndPrepareAnthropicModels} — the parser's
 * public boundary. Carries the sorted, mapped, browser-ready model array
 * plus forensic diagnostics for logging.
 */
export type ParseAndPrepareResult =
  | {
      ok: true;
      models: BackendModelInfo[];
      droppedItems: number;
      hasMore: boolean;
    }
  | { ok: false; reason: "envelope" | "no-data-array" | "empty" };

/** Anthropic claude model id allowlist. Bounded charset + claude- prefix.
 *  Hunt R6: `^claude-[a-z0-9.\-]+$` defeats argv-flag injection via model
 *  string (a leading `-` is impossible by construction). */
const CLAUDE_MODEL_ID_RE = /^claude-[a-z0-9.\-]+$/;

/** Hunt R6 + Subprocess R1: bound `value` field that flows into CLI argv.
 *  128 chars is generous (real ids are ~30 chars); rejection pollutes log
 *  lines / EC-9 entries less than truncation. */
const MODEL_ID_MAX_LEN = 128;

/** Hunt R6: bound display strings — defence against runaway upstream
 *  responses + Trojan-Source bidi injection via long obfuscated names. */
const MODEL_LABEL_MAX_LEN = 256;

/**
 * Pure: reject CR/LF/NUL/C0/C1/DEL + Unicode bidi controls. Trojan-Source
 * defence (CVE-2021-42574) — bidi controls in `display_name` would render
 * adversarial text under operator's Anthropic key.
 *
 * Allows extended Unicode (CJK, emoji) for legitimate model names.
 */
function isBoundedSafeString(s: unknown, maxLen: number): s is string {
  if (typeof s !== "string") return false;
  if (s.length === 0 || s.length > maxLen) return false;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x20) return false; // C0 controls (incl. tab, newline, CR)
    if (code === 0x7f) return false; // DEL
    if (code >= 0x80 && code <= 0x9f) return false; // C1 controls
    if (code >= 0x202a && code <= 0x202e) return false; // bidi LRE/RLE/PDF/LRO/RLO
    if (code >= 0x2066 && code <= 0x2069) return false; // bidi LRI/RLI/FSI/PDI
  }
  return true;
}

/**
 * EC-5 strict-on-discriminator boundary parser for Anthropic `/v1/models`.
 *
 * - Envelope: requires `{ data: Array<...> }`. Rejects on shape mismatch.
 * - Per-item: requires `type === "model"` (forward-compat skip on
 *   `"model_snapshot"` or future variants); requires `id` matching
 *   {@link CLAUDE_MODEL_ID_RE}; tolerates missing/optional `display_name`
 *   and `created_at` (EC-5 polymorphic-by-spec).
 * - Drops non-conforming entries individually (Backend R3 + Realtime R1 —
 *   one bad row does not invalidate the whole list); the caller logs
 *   `droppedItems` count and `hasMore` as canaries.
 *
 * Pure; no I/O. Replay-tested against `web/server/fixtures/anthropic-models-response.json`.
 */
export function parseAnthropicModelsResponse(raw: unknown): ParseAnthropicResult {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "envelope" };
  }
  const envelope = raw as { data?: unknown; has_more?: unknown };
  if (!Array.isArray(envelope.data)) {
    return { ok: false, reason: "no-data-array" };
  }
  const hasMore = envelope.has_more === true;

  const models: ParsedAnthropicModel[] = [];
  let droppedItems = 0;

  for (const entry of envelope.data) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      droppedItems++;
      continue;
    }
    const item = entry as {
      id?: unknown;
      type?: unknown;
      display_name?: unknown;
      created_at?: unknown;
    };

    // EC-5 strict on discriminator: reject anything that's not exactly
    // a model record.
    if (item.type !== "model") {
      droppedItems++;
      continue;
    }
    // Bound + regex + claude- prefix.
    if (!isBoundedSafeString(item.id, MODEL_ID_MAX_LEN)) {
      droppedItems++;
      continue;
    }
    if (!CLAUDE_MODEL_ID_RE.test(item.id)) {
      droppedItems++;
      continue;
    }

    // Optional display_name — present-with-bad-shape rejects the whole
    // item (Backend R3: strict per-item, drop individually).
    let displayName: string | undefined;
    if (item.display_name !== undefined) {
      if (!isBoundedSafeString(item.display_name, MODEL_LABEL_MAX_LEN)) {
        droppedItems++;
        continue;
      }
      displayName = item.display_name;
    }

    // Optional created_at — ISO 8601 string parseable to a finite epoch ms.
    let createdAt: number | undefined;
    if (item.created_at !== undefined) {
      if (typeof item.created_at !== "string") {
        droppedItems++;
        continue;
      }
      const ts = Date.parse(item.created_at);
      if (!Number.isFinite(ts)) {
        droppedItems++;
        continue;
      }
      createdAt = ts;
    }

    models.push({ id: item.id, display_name: displayName, created_at: createdAt });
  }

  if (models.length === 0) {
    return { ok: false, reason: "empty" };
  }

  return { ok: true, models, droppedItems, hasMore };
}

// ── Sort discipline (Task 2, server-side) ───────────────────────────────────

/**
 * Tier ordering — opus (flagship) > sonnet (balanced) > haiku (fast).
 * Lower number = higher priority. Unknown tier sorts last (rank 99).
 */
const TIER_RANK: Record<"opus" | "sonnet" | "haiku", number> = {
  opus: 0,
  sonnet: 1,
  haiku: 2,
};

/**
 * Tier extraction by substring match on the id. Robust to Anthropic's
 * id shape variants (`claude-opus-4-7`, `claude-opus-4-8-20260401`,
 * etc.); the literal "opus" token is the discriminator.
 */
function tierRankOf(id: string): number {
  if (id.includes("opus")) return TIER_RANK.opus;
  if (id.includes("sonnet")) return TIER_RANK.sonnet;
  if (id.includes("haiku")) return TIER_RANK.haiku;
  return 99;
}

/**
 * Pure: parse `claude-(opus|sonnet|haiku)-<major>(-<minor>)?(-<snapshot>)?`
 * into a [major, minor, snapshot] integer tuple. Missing components → -1.
 *
 * **Critical correctness anchor (PLAN Risk #6):** lexicographic comparison
 * of `claude-opus-4-10` vs `claude-opus-4-7` puts `4-10` BEFORE `4-7`
 * (because `'1' < '7'` as strings). Numeric tuple comparison is the only
 * way to sort `4-10 > 4-7` correctly. Without this, the day Anthropic ships
 * `opus-4-10` the dropdown silently mis-orders.
 */
function parseVersionParts(id: string): [number, number, number] {
  const m = /^claude-(?:opus|sonnet|haiku)-(\d+)(?:-(\d+))?(?:-(\d+))?$/.exec(id);
  if (m === null) return [-1, -1, -1];
  const major = Number.parseInt(m[1]!, 10);
  const minor = m[2] !== undefined ? Number.parseInt(m[2], 10) : -1;
  const snap = m[3] !== undefined ? Number.parseInt(m[3], 10) : -1;
  return [major, minor, snap];
}

/**
 * Pure: sort parsed models by tier > created_at desc > version-aware-numeric > id desc.
 *
 * Stable across runs given identical input — important for snapshot tests
 * and forensic replay. Sort is non-mutating; returns a new array.
 */
export function sortAnthropicModels(
  models: readonly ParsedAnthropicModel[],
): ParsedAnthropicModel[] {
  return [...models].sort((a, b) => {
    // Primary: tier rank ascending (opus first).
    const tr = tierRankOf(a.id) - tierRankOf(b.id);
    if (tr !== 0) return tr;

    // Secondary: created_at desc (newer first). Missing-vs-present asymmetry
    // — entries with a timestamp sort before timestamp-less peers in the
    // same tier (newer info beats no info).
    if (a.created_at !== undefined && b.created_at !== undefined) {
      const dt = b.created_at - a.created_at;
      if (dt !== 0) return dt;
    } else if (a.created_at !== undefined) {
      return -1;
    } else if (b.created_at !== undefined) {
      return 1;
    }

    // Tertiary: version-aware numeric on id (Risk #6 — `4-10 > 4-7`).
    const [aMaj, aMin, aSnap] = parseVersionParts(a.id);
    const [bMaj, bMin, bSnap] = parseVersionParts(b.id);
    if (bMaj !== aMaj) return bMaj - aMaj;
    if (bMin !== aMin) return bMin - aMin;
    if (bSnap !== aSnap) return bSnap - aSnap;

    // Quaternary: lexicographic desc as final stable tiebreaker.
    if (a.id < b.id) return 1;
    if (a.id > b.id) return -1;
    return 0;
  });
}

// ── Label mapping (Task 2, Saarinen R1) ─────────────────────────────────────

/**
 * Pure: strip the leading "Claude " prefix from `display_name`. Saarinen R1
 * — every Anthropic `display_name` ("Claude Opus 4.8") starts with the
 * brand prefix; inside an Aura session the prefix is redundant noise that
 * pushes the differentiating version digit to the rightmost end of each
 * row. Stripping at the API-adapter layer ensures one source of truth
 * (HomePage / CronManager / ModelSwitcher all show "Opus 4.8" not
 * "Claude Opus 4.8") and avoids client-side conditional cleanup.
 *
 * Conservative: only strips the literal "Claude " (with trailing space).
 * `"ClaudeNext"` or `"claude-opus"` are NOT affected. Idempotent on
 * already-stripped strings.
 */
function normaliseModelLabel(displayName: string): string {
  return displayName.replace(/^Claude\s+/, "");
}

/**
 * Pure: map an internally-parsed `ParsedAnthropicModel` to the wire shape
 * `BackendModelInfo` consumed by the frontend store + UI. Strips the
 * `"Claude "` brand prefix from `label` (Saarinen R1). Falls back to `id`
 * when `display_name` is absent — graceful degrade rather than rejecting
 * the whole entry on a missing optional field.
 */
function toBackendModelInfo(parsed: ParsedAnthropicModel): BackendModelInfo {
  const rawLabel = parsed.display_name ?? parsed.id;
  return {
    value: parsed.id,
    label: normaliseModelLabel(rawLabel),
    description: parsed.display_name ?? "",
  };
}

/**
 * Public composite: parse the upstream raw response, sort, and map to wire
 * shape. The Task 6 Hono handler calls this once per cache miss; tests
 * (Task 7) verify the full pipeline against the captured fixture.
 *
 * Either resolves to `{ ok: true, models }` (sorted, browser-ready) or
 * `{ ok: false, reason }` (envelope / no-data-array / empty). All caller-
 * relevant diagnostics (droppedItems, hasMore) surface on the success
 * branch for structured-log emission.
 */
export function parseAndPrepareAnthropicModels(raw: unknown): ParseAndPrepareResult {
  const parsed = parseAnthropicModelsResponse(raw);
  if (!parsed.ok) return parsed;
  const sorted = sortAnthropicModels(parsed.models);
  return {
    ok: true,
    models: sorted.map(toBackendModelInfo),
    droppedItems: parsed.droppedItems,
    hasMore: parsed.hasMore,
  };
}

// ── HTTPS fetch (Task 3, Backend R2 + R3 + R7) ─────────────────────────────

/**
 * Dependency-injection seam for the upstream fetch + clock. Test sites
 * pass mocks via `deps`; production callers omit and inherit the globals.
 * Beck-friendly: deterministic fakes without `vi.stubGlobal('fetch')` (which
 * fights Bun's native implementation) and `vi.useFakeTimers` for `now`.
 */
/**
 * Callable signature of `globalThis.fetch` WITHOUT the runtime-specific
 * properties (Bun's `preconnect`, Node's `dispatcher`, etc.). Tests pass
 * `vi.fn().mockResolvedValue(new Response(...))` which satisfies this
 * shape — the full `typeof fetch` shape would require the test mock to
 * also implement runtime-specific methods nothing in this module calls.
 */
export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface AnthropicFetchDeps {
  fetch?: FetchLike;
  now?: () => number;
  /** Optional parent AbortSignal for request-abort propagation. */
  parentSignal?: AbortSignal;
}

/**
 * Discriminated outcome of {@link fetchAnthropicModelsRaw}. `raw` is the
 * parsed JSON body — caller (Task 4 cache layer) feeds it to
 * {@link parseAndPrepareAnthropicModels} to validate shape.
 *
 * Authentication errors land in `auth-failed` so the route handler can map
 * to 502 with `upstream-auth` (Backend R2 — bad upstream key is operator
 * concern, NOT 401 to the browser which would trigger Aura's own auth
 * re-flow). Other failures collapse into `unavailable` with a `reason`
 * subkind for forensic logging.
 */
export type AnthropicFetchOutcome =
  | { kind: "success"; raw: unknown; httpStatus: number; elapsed_ms: number }
  | { kind: "auth-failed"; httpStatus: number; elapsed_ms: number }
  | {
      kind: "unavailable";
      reason: "5xx" | "network" | "timeout" | "parse";
      elapsed_ms: number;
    };

/**
 * Fetch `/v1/models` from Anthropic with strict resource discipline:
 *
 * - **Timeout via AbortController** ({@link FETCH_TIMEOUT_MS}, 5s). Bun's
 *   native `fetch` has no default timeout — without this a hung TLS
 *   handshake pins a Hono worker until kernel TCP timeout.
 * - **`clearTimeout` in `finally`** — otherwise on fast success the timer
 *   fires anyway and aborts an unrelated controller (P5 hygiene + prevents
 *   Vitest worker leak).
 * - **Body consumption on every branch.** Bun keeps the underlying socket
 *   in the pool with an unread body; on error paths we still `.text()` to
 *   drain (or `.body.cancel()` on already-consumed). P5: "every fetch body
 *   must be read or explicitly cancelled."
 * - **Parent-signal propagation** via `AbortSignal.any([timeoutSignal,
 *   parentSignal])` when caller supplies one (Hono `c.req.raw.signal`).
 * - **No URL/key in error path** — `AbortError` and network errors caught
 *   and mapped to typed outcomes; never echo `err.message` (may contain
 *   the request URL in some shapes).
 *
 * Hunt R3 + R5: `apiKey` flows ONLY in the `x-api-key` request header.
 * Never in the URL (no query-param). Never echoed in throws or logs.
 * Caller logs `key_fingerprint` (a SHA-256 hex prefix), never the raw key.
 *
 * Pure-ish — no module state mutation. Caller owns the cache.
 */
export async function fetchAnthropicModelsRaw(
  apiKey: string,
  deps?: AnthropicFetchDeps,
): Promise<AnthropicFetchOutcome> {
  const fetchImpl = deps?.fetch ?? globalThis.fetch;
  const nowImpl = deps?.now ?? Date.now;
  const startedAt = nowImpl();
  const elapsed = () => nowImpl() - startedAt;

  const timeoutController = new AbortController();
  const timeoutHandle = setTimeout(() => timeoutController.abort(), FETCH_TIMEOUT_MS);
  // Use type assertion below for `AbortSignal.any` — supported in Bun + Node 20+
  // but the TS lib may not yet declare it; pre-resolve to a single signal here.
  const signal: AbortSignal = deps?.parentSignal
    ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((AbortSignal as any).any?.([timeoutController.signal, deps.parentSignal]) ??
        timeoutController.signal)
    : timeoutController.signal;

  let response: Response | undefined;
  try {
    response = await fetchImpl(ANTHROPIC_MODELS_URL, {
      method: "GET",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION_HEADER,
        accept: "application/json",
      },
      signal,
    });

    // Auth failures — let caller map to 502 upstream-auth.
    if (response.status === 401 || response.status === 403) {
      // Drain body to free socket; ignore errors (response may already be empty).
      await response.text().catch(() => undefined);
      return {
        kind: "auth-failed",
        httpStatus: response.status,
        elapsed_ms: elapsed(),
      };
    }

    // Other non-2xx (rate limit, 5xx, etc.) — all upstream-unavailable.
    if (!response.ok) {
      await response.text().catch(() => undefined);
      return {
        kind: "unavailable",
        reason: "5xx",
        elapsed_ms: elapsed(),
      };
    }

    // 2xx — parse JSON; reject malformed body as "parse" subkind.
    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      // body was already consumed by .json() throw; nothing more to drain.
      return {
        kind: "unavailable",
        reason: "parse",
        elapsed_ms: elapsed(),
      };
    }

    return {
      kind: "success",
      raw,
      httpStatus: response.status,
      elapsed_ms: elapsed(),
    };
  } catch (err: unknown) {
    // Drain body if response was assigned before throw (rare; happens if
    // .json() throws AFTER non-ok status but we already returned above —
    // defence-in-depth).
    if (response !== undefined) {
      try {
        await response.body?.cancel();
      } catch {
        /* ignore */
      }
    }

    // AbortError → timeout. All other thrown errors → network.
    const isAbort = err instanceof Error && err.name === "AbortError";
    return {
      kind: "unavailable",
      reason: isAbort ? "timeout" : "network",
      elapsed_ms: elapsed(),
    };
  } finally {
    // P5 hygiene: clear timer on fast success so it doesn't fire later
    // against a now-released controller.
    clearTimeout(timeoutHandle);
  }
}

// ── Persistence layer (Task 4) ──────────────────────────────────────────────

/**
 * In-memory cache, keyed by `key_fingerprint`. Module-scope singleton —
 * survives the request boundary, dies on Bun restart (disk cache warms
 * it back up via {@link readDiskCache} on next cold-cache read).
 *
 * Fingerprint-keyed (not "singleton") so a key rotation mid-runtime cannot
 * accidentally serve stale entries from the previous key's record.
 */
const memoryCache = new Map<string, CachedModelsRecord>();

/**
 * Pure: compute the SHA-256 hex prefix of an API key. One-way; the cache
 * file stores ONLY this prefix, never the raw key bytes. Hunt R1 + Backend
 * R5 — fingerprint is the only key-derived value that ever touches disk.
 *
 * Bun.serve's request handler computes this once per request and passes
 * to the cache primitives — no module-level cache of the fingerprint
 * because the user may edit `~/.companion/settings.json` mid-runtime
 * (rotate key without server restart) and the next request must see the
 * new fingerprint immediately.
 *
 * Exported so the route handler (Task 6) and tests can share one
 * implementation (EC-20 single-source-of-truth).
 */
export function computeKeyFingerprint(apiKey: string): string {
  return createHash("sha256")
    .update(apiKey, "utf8")
    .digest("hex")
    .slice(0, KEY_FINGERPRINT_HEX_LEN);
}

/**
 * Pure structural validator + atomic 3-check predicate. Tests can drive
 * it directly with hand-crafted records; production reads route through
 * {@link readDiskCache} / {@link readMemoryCache} which call this.
 *
 * The 3 checks (all must pass; any failure → invalid):
 *   1. `schema_version === SCHEMA_VERSION` (strict equality, NOT `>=`)
 *   2. `key_fingerprint === currentFingerprint` (atomic with #1, not a
 *      side-check — rotating the key must invalidate the cache as the
 *      same predicate evaluation, not via a separate post-load gate that
 *      a future refactor could bypass)
 *   3. `now - fetched_at <= ttlMs` (freshness within caller-supplied ceiling)
 *
 * Additionally validates the structural shape (presence + type of each
 * required field) — corrupt JSON that happens to parse but has wrong
 * field types lands here, not at the caller.
 */
export function isCacheRecordValid(
  record: unknown,
  currentFingerprint: string,
  now: number,
  ttlMs: number,
): record is CachedModelsRecord {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    return false;
  }
  const r = record as Partial<CachedModelsRecord>;
  if (r.schema_version !== SCHEMA_VERSION) return false;
  if (typeof r.fetched_at !== "number" || !Number.isFinite(r.fetched_at)) return false;
  if (typeof r.key_fingerprint !== "string") return false;
  if (!Array.isArray(r.models)) return false;
  // Atomic 3-check — all gates evaluated as part of "is it a hit?"
  if (r.key_fingerprint !== currentFingerprint) return false;
  if (now - r.fetched_at > ttlMs) return false;
  return true;
}

/**
 * Read from in-memory cache. Returns the record if present AND within
 * {@link IN_MEMORY_TTL_MS}; expired entries are evicted in place. The
 * fingerprint match is implicit via the Map key (memory cache is keyed
 * by fingerprint, not by a generic "current" slot).
 *
 * Exported so the orchestrator (Task 5) can compose it; tests share the
 * same path (no `_resetForTests` indirection — `__resetMemoryCacheForTests`
 * below is the test-only escape hatch).
 */
export function readMemoryCache(
  fingerprint: string,
  now: number,
): CachedModelsRecord | null {
  const record = memoryCache.get(fingerprint);
  if (record === undefined) return null;
  if (now - record.fetched_at > IN_MEMORY_TTL_MS) {
    memoryCache.delete(fingerprint);
    return null;
  }
  return record;
}

/** Write to in-memory cache. Keyed by `record.key_fingerprint` —
 *  caller (Task 5 / Task 6) provides the record built from a successful
 *  fetch or a fresh disk read. */
export function writeMemoryCache(record: CachedModelsRecord): void {
  memoryCache.set(record.key_fingerprint, record);
}

/**
 * Test-only reset of the in-memory cache. Suffix `__` signals test-only;
 * never imported from production code paths. Persistence R6.
 */
export function __resetMemoryCacheForTests(): void {
  memoryCache.clear();
}

/**
 * Discriminated outcome of {@link readDiskCache}. Each `reason` value
 * maps to a distinct EC-9 structured-log event for forensic triage
 * (Persistence R5). The `stale` reason fires when the disk file is
 * present and structurally valid BUT older than the disk-staleness
 * ceiling — caller decides whether to serve stale (upstream-unreachable
 * branch) or treat as miss (normal fetch path).
 */
export type DiskReadResult =
  | { ok: true; record: CachedModelsRecord }
  | {
      ok: false;
      reason:
        | "enoent"
        | "parse"
        | "schema"
        | "fingerprint-mismatch"
        | "stale";
    };

/**
 * EC-7/EC-36 defensive realpath bounds check. The cache path is a fixed
 * constant under {@link COMPANION_HOME}, so traversal is impossible by
 * construction — but the convention floor mandates the wrapper anyway,
 * defending against future refactors that might make the path dynamic
 * (env override of basename, multi-tenant subdirectories, etc.).
 *
 * Behaviour: realpath {@link COMPANION_HOME}; join with the cache
 * filename; assert the joined path starts with `homeCanonical + sep` (or
 * equals it). Throws on bounds violation; returns normally otherwise.
 *
 * Handles the case where {@link COMPANION_HOME} does not yet exist
 * (first run before any settings write) — returns silently so the next
 * `writeAtomicJson` call creates the directory tree as part of the
 * write. Other realpath errors (EACCES, ELOOP) propagate.
 */
function assertCachePathInBounds(): void {
  let homeCanonical: string;
  try {
    homeCanonical = realpathSync(COMPANION_HOME);
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    // First-run / missing-home → defer to writeAtomicJson's mkdir. Safe.
    if (code === "ENOENT") return;
    throw err;
  }
  const joined = resolvePath(homeCanonical, ANTHROPIC_MODELS_CACHE_FILENAME);
  if (joined === homeCanonical) {
    throw new Error(
      "anthropic-models-cache: cache path resolved to home root — refusing write",
    );
  }
  if (!joined.startsWith(homeCanonical + sep)) {
    throw new Error(
      "anthropic-models-cache: cache path escaped COMPANION_HOME — refusing write",
    );
  }
}

/**
 * Read the on-disk cache file, validate the schema and fingerprint, and
 * return the record OR a structured failure reason. ENOENT is a normal
 * outcome (first run, never-fetched) — log as INFO, fall through to fetch.
 *
 * Disambiguates failure reasons for EC-9 structured-log emission
 * (Persistence R5) — five distinct named branches: `enoent`, `parse`,
 * `schema`, `fingerprint-mismatch`, `stale`. Does NOT auto-delete the
 * corrupt file; the next successful write atomically replaces it
 * (Persistence R4 — preserve forensic trace).
 */
export function readDiskCache(
  currentFingerprint: string,
  now: number,
  ttlMs: number = DISK_STALENESS_CEILING_MS,
): DiskReadResult {
  let raw: string;
  try {
    raw = readFileSync(ANTHROPIC_MODELS_CACHE_PATH, "utf8");
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === "ENOENT") return { ok: false, reason: "enoent" };
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "parse" };
  }
  if (isCacheRecordValid(parsed, currentFingerprint, now, ttlMs)) {
    return { ok: true, record: parsed };
  }
  // Disambiguate the failure for forensic logging — same shape checks
  // as the predicate, but reported as distinct reasons.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "schema" };
  }
  const r = parsed as Partial<CachedModelsRecord>;
  if (r.schema_version !== SCHEMA_VERSION) return { ok: false, reason: "schema" };
  if (typeof r.fetched_at !== "number" || !Number.isFinite(r.fetched_at)) {
    return { ok: false, reason: "schema" };
  }
  if (typeof r.key_fingerprint !== "string" || !Array.isArray(r.models)) {
    return { ok: false, reason: "schema" };
  }
  if (r.key_fingerprint !== currentFingerprint) {
    return { ok: false, reason: "fingerprint-mismatch" };
  }
  if (now - r.fetched_at > ttlMs) {
    return { ok: false, reason: "stale" };
  }
  return { ok: false, reason: "schema" };
}

/**
 * Atomically write the cache record to disk. Performs three defensive
 * checks before delegating to {@link writeAtomicJson}:
 *
 *  1. EC-7 bounds check on the cache path (defensive against future
 *     refactor making the path dynamic).
 *  2. Persistence R3 — the serialised payload MUST NOT contain raw key
 *     bytes. Checked by substring match on the API key's last 8 chars
 *     (unique tail; full-key match would false-positive if the key shape
 *     ever changes). Throws on assertion failure so a future refactor
 *     that accidentally adds the key to the record goes red.
 *  3. The underlying {@link writeAtomicJson} guarantees mode 0o600 +
 *     fsync + same-filesystem rename (already 600 by construction —
 *     `atomic-write.ts` opens the tmp with explicit `0o600`).
 */
export function writeDiskCache(
  record: CachedModelsRecord,
  apiKey: string,
): void {
  assertCachePathInBounds();
  const serialised = JSON.stringify(record);
  if (apiKey.length >= 8) {
    const suffix = apiKey.slice(-8);
    if (serialised.includes(suffix)) {
      throw new Error(
        "anthropic-models-cache: refusing to persist — serialised payload contains apiKey suffix",
      );
    }
  }
  writeAtomicJson(ANTHROPIC_MODELS_CACHE_PATH, record);
}

// ── Orchestrator (Task 5, Hunt R4 + Backend R1 single-flight) ──────────────

/**
 * Single-flight lock table — `Map<key_fingerprint, Promise<Result>>`.
 *
 * On every cold-cache request, the orchestrator allocates ONE upstream
 * fetch promise and installs it here before awaiting. Concurrent N
 * requests for the same key piggyback on the existing promise. The lock
 * entry is deleted in `finally` (resolve OR reject) so subsequent
 * requests never inherit a dead promise.
 *
 * Keyed by fingerprint (NOT a generic "singleton" slot) so a user
 * rotating the key mid-flight does not pin requests to the old key's
 * in-flight call — each fingerprint gets its own queue.
 */
const inflightFetches = new Map<string, Promise<AnthropicModelsResult>>();

/**
 * Test-only reset of the in-flight lock map. Companion to
 * {@link __resetMemoryCacheForTests}.
 */
export function __resetInflightForTests(): void {
  inflightFetches.clear();
}

/**
 * Test-only delete of the on-disk cache file. Tests that exercise the
 * orchestrator's fetch path may write a real disk cache as a side effect
 * (the orchestrator persists successful fetches); without this reset,
 * subsequent tests in the same file see a warm disk and never reach the
 * fetch branch they wanted to exercise.
 *
 * Swallows ENOENT (already absent is the normal state).
 */
export function __deleteDiskCacheForTests(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs") as typeof import("node:fs");
    fs.unlinkSync(ANTHROPIC_MODELS_CACHE_PATH);
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code !== "ENOENT") {
      // Surface non-ENOENT failures (EACCES on the parent dir, etc.) so
      // test failures point at the real cause, not at a downstream
      // assertion confused by stale disk state.
      throw err;
    }
  }
}

/**
 * Combined dependency-injection seam for the orchestrator + nested
 * fetch. Tests pass `fetch` + `now` mocks; production omits.
 */
export type GetModelsDeps = AnthropicFetchDeps;

/**
 * Resolve the dynamic Claude model list for a given API key.
 *
 * Cache ladder (in order):
 *  1. **Memory** — keyed by fingerprint, TTL {@link IN_MEMORY_TTL_MS} (1h).
 *  2. **Disk** — `{@link ANTHROPIC_MODELS_CACHE_PATH}`, ceiling
 *     {@link DISK_STALENESS_CEILING_MS} (24h). Atomic 3-check predicate
 *     ({@link isCacheRecordValid}) gates the hit decision.
 *  3. **Network** — upstream Anthropic `/v1/models` via
 *     {@link fetchAnthropicModelsRaw}. Result parsed via
 *     {@link parseAndPrepareAnthropicModels}; success persists to both
 *     cache tiers.
 *
 * Failure-mode ladder (when upstream call fails OR returns malformed):
 *  - **`auth-failed`** (401/403) → `{kind: "upstream-auth"}`. Operator's
 *    key is invalid; route handler maps to 502. NEVER 401 to the browser
 *    (would trigger Aura's bearer-auth re-flow).
 *  - **`unavailable`** (5xx/network/timeout/parse) → first try to serve
 *    last-known cache (even beyond 24h ceiling — Backend R2 + Persistence
 *    R3: availability beats freshness when alternative is hard fail).
 *    If no usable cache, `{kind: "upstream-unavailable", reason}`.
 *
 * Single-flight discipline (Hunt R4 + Backend R1): concurrent cold-cache
 * requests for the same fingerprint collapse to one upstream fetch via
 * {@link inflightFetches}.
 *
 * Structured logs (EC-9 + EC-21 + EC-23): every branch emits one
 * structured event sourcing all fields from the `record` and `fetched`
 * outcome — never from `Date.now()` at log time. Paths render as
 * {@link ANTHROPIC_MODELS_CACHE_LOG_LABEL} sentinel, never raw bytes.
 */
export async function getAnthropicModels(
  apiKey: string,
  deps?: GetModelsDeps,
): Promise<AnthropicModelsResult> {
  if (apiKey.length === 0) {
    log.info("anthropic-models-cache", "no-key", {
      event: "anthropic-models.no-key",
    });
    return { kind: "no-key" };
  }

  const fingerprint = computeKeyFingerprint(apiKey);
  const nowImpl = deps?.now ?? Date.now;
  const currentTime = nowImpl();

  // Memory hit — zero-IO fast path.
  const memHit = readMemoryCache(fingerprint, currentTime);
  if (memHit !== null) {
    log.info("anthropic-models-cache", "cache.hit.memory", {
      event: "anthropic-models.cache.hit",
      source: "memory",
      key_fingerprint: fingerprint,
      model_count: memHit.models.length,
      cache_age_ms: currentTime - memHit.fetched_at,
    });
    return {
      kind: "ok",
      source: "memory",
      models: memHit.models,
      fetched_at: memHit.fetched_at,
    };
  }

  // Single-flight: piggyback on existing in-flight fetch for this key.
  const existing = inflightFetches.get(fingerprint);
  if (existing !== undefined) {
    return existing;
  }

  const promise = (async (): Promise<AnthropicModelsResult> => {
    try {
      // Disk hit — warm-start on bun cold restart.
      const diskHit = readDiskCache(fingerprint, currentTime);
      if (diskHit.ok) {
        writeMemoryCache(diskHit.record);
        log.info("anthropic-models-cache", "cache.hit.disk", {
          event: "anthropic-models.cache.hit",
          source: "disk",
          file: ANTHROPIC_MODELS_CACHE_LOG_LABEL,
          key_fingerprint: fingerprint,
          model_count: diskHit.record.models.length,
          cache_age_ms: currentTime - diskHit.record.fetched_at,
        });
        return {
          kind: "ok",
          source: "disk",
          models: diskHit.record.models,
          fetched_at: diskHit.record.fetched_at,
        };
      }

      // Disk miss — log the reason for forensic triage.
      log.info("anthropic-models-cache", "cache.miss", {
        event: "anthropic-models.cache.miss",
        reason: diskHit.reason,
        file: ANTHROPIC_MODELS_CACHE_LOG_LABEL,
        key_fingerprint: fingerprint,
      });

      // Network fetch.
      const fetched = await fetchAnthropicModelsRaw(apiKey, deps);

      if (fetched.kind === "auth-failed") {
        log.warn("anthropic-models-cache", "upstream.auth-failed", {
          event: "anthropic-models.upstream.auth-failed",
          http_status: fetched.httpStatus,
          key_fingerprint: fingerprint,
          elapsed_ms: fetched.elapsed_ms,
        });
        return { kind: "upstream-auth", httpStatus: fetched.httpStatus };
      }

      if (fetched.kind === "unavailable") {
        log.warn("anthropic-models-cache", "upstream.unavailable", {
          event: "anthropic-models.upstream.unavailable",
          reason: fetched.reason,
          key_fingerprint: fingerprint,
          elapsed_ms: fetched.elapsed_ms,
        });
        // Backend R2 + Persistence R3: serve stale disk if any, even
        // beyond the 24h ceiling — last-known-good beats hard 502.
        const staleProbe = readDiskCache(
          fingerprint,
          currentTime,
          Number.POSITIVE_INFINITY,
        );
        if (staleProbe.ok) {
          log.warn("anthropic-models-cache", "stale-served", {
            event: "anthropic-models.stale-served",
            source: "disk",
            file: ANTHROPIC_MODELS_CACHE_LOG_LABEL,
            key_fingerprint: fingerprint,
            model_count: staleProbe.record.models.length,
            cache_age_ms: currentTime - staleProbe.record.fetched_at,
            upstream_reason: fetched.reason,
          });
          writeMemoryCache(staleProbe.record);
          return {
            kind: "ok",
            source: "disk",
            models: staleProbe.record.models,
            fetched_at: staleProbe.record.fetched_at,
          };
        }
        return { kind: "upstream-unavailable", reason: fetched.reason };
      }

      // Network success → parse + persist + return.
      const parsed = parseAndPrepareAnthropicModels(fetched.raw);
      if (!parsed.ok) {
        log.warn("anthropic-models-cache", "upstream.parse-failed", {
          event: "anthropic-models.upstream.parse-failed",
          reason: parsed.reason,
          key_fingerprint: fingerprint,
          elapsed_ms: fetched.elapsed_ms,
        });
        return { kind: "upstream-unavailable", reason: "parse" };
      }

      if (parsed.hasMore) {
        // EC-5 polymorphic-by-spec canary — pagination is currently
        // out of scope per plan; flag if Anthropic ever returns more
        // than one page.
        log.warn("anthropic-models-cache", "pagination-needed", {
          event: "anthropic-models.pagination-needed",
          key_fingerprint: fingerprint,
        });
      }

      const record: CachedModelsRecord = {
        schema_version: SCHEMA_VERSION,
        fetched_at: currentTime,
        key_fingerprint: fingerprint,
        models: parsed.models,
      };

      writeMemoryCache(record);
      try {
        writeDiskCache(record, apiKey);
      } catch (err: unknown) {
        // Disk write failure is non-fatal — in-memory cache is still
        // authoritative. Log + continue (Persistence R7).
        log.warn("anthropic-models-cache", "cache.write-failed", {
          event: "anthropic-models.cache.write-failed",
          file: ANTHROPIC_MODELS_CACHE_LOG_LABEL,
          key_fingerprint: fingerprint,
          error_name: err instanceof Error ? err.name : "unknown",
        });
      }

      log.info("anthropic-models-cache", "upstream.success", {
        event: "anthropic-models.upstream.success",
        http_status: fetched.httpStatus,
        key_fingerprint: fingerprint,
        model_count: parsed.models.length,
        dropped_items: parsed.droppedItems,
        elapsed_ms: fetched.elapsed_ms,
      });

      return {
        kind: "ok",
        source: "network",
        models: parsed.models,
        fetched_at: currentTime,
      };
    } finally {
      // Backend R1: delete lock entry on EVERY exit (resolve / reject /
      // throw) so subsequent requests don't piggyback on a dead promise.
      inflightFetches.delete(fingerprint);
    }
  })();

  inflightFetches.set(fingerprint, promise);
  return promise;
}
