/**
 * Unit + integration tests for `anthropic-models-cache.ts`
 * (PLAN-aura-dynamic-model-list Task 7).
 *
 * Coverage matrix:
 *  - Pure parser: strict envelope, per-item drop discipline, EC-5 polymorphic
 *    tolerance, Trojan-Source (bidi controls) defence.
 *  - Pure sort: tier rank, created_at desc, version-aware-numeric tiebreaker
 *    (Risk #6 — `claude-opus-4-10 > 4-7` numerically).
 *  - Label normalisation (Saarinen R1 — strip "Claude " prefix).
 *  - Fingerprint: deterministic, rotation changes, 16-hex output.
 *  - Atomic 3-check hit predicate (`isCacheRecordValid`).
 *  - Orchestrator via DI: no-key path, memory hit, network success,
 *    auth-failed mapping, single-flight collapse, timeout via fake timers,
 *    upstream-unavailable with no cache.
 *  - Fixture replay against `web/server/fixtures/anthropic-models-response.json`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseAnthropicModelsResponse,
  sortAnthropicModels,
  parseAndPrepareAnthropicModels,
  computeKeyFingerprint,
  isCacheRecordValid,
  fetchAnthropicModelsRaw,
  getAnthropicModels,
  readMemoryCache,
  writeMemoryCache,
  __resetMemoryCacheForTests,
  __resetInflightForTests,
  __deleteDiskCacheForTests,
  SCHEMA_VERSION,
  KEY_FINGERPRINT_HEX_LEN,
  IN_MEMORY_TTL_MS,
  FETCH_TIMEOUT_MS,
  type CachedModelsRecord,
} from "./anthropic-models-cache.js";

// ── PARSER ─────────────────────────────────────────────────────────────────

describe("parseAnthropicModelsResponse — envelope discipline (EC-5)", () => {
  it("rejects null", () => {
    expect(parseAnthropicModelsResponse(null)).toEqual({
      ok: false,
      reason: "envelope",
    });
  });

  it("rejects primitive (string)", () => {
    expect(parseAnthropicModelsResponse("oops")).toEqual({
      ok: false,
      reason: "envelope",
    });
  });

  it("rejects bare array (data must be inside an object)", () => {
    expect(parseAnthropicModelsResponse([])).toEqual({
      ok: false,
      reason: "envelope",
    });
  });

  it("rejects when data is missing", () => {
    expect(parseAnthropicModelsResponse({})).toEqual({
      ok: false,
      reason: "no-data-array",
    });
  });

  it("rejects when data is not an array", () => {
    expect(parseAnthropicModelsResponse({ data: "string" })).toEqual({
      ok: false,
      reason: "no-data-array",
    });
  });

  it("returns empty when no items pass validation", () => {
    expect(
      parseAnthropicModelsResponse({
        data: [{ type: "not-a-model" }, { id: "no-prefix" }],
      }),
    ).toEqual({ ok: false, reason: "empty" });
  });
});

describe("parseAnthropicModelsResponse — per-item drop discipline", () => {
  const happy = {
    type: "model",
    id: "claude-opus-4-7",
    display_name: "Claude Opus 4.7",
    created_at: "2026-01-15T00:00:00Z",
  };

  it("accepts a well-formed entry", () => {
    const r = parseAnthropicModelsResponse({ data: [happy] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.models).toHaveLength(1);
      expect(r.models[0]!.id).toBe("claude-opus-4-7");
      expect(r.droppedItems).toBe(0);
      expect(r.hasMore).toBe(false);
    }
  });

  it("drops non-`model` type (forward-compat for model_snapshot)", () => {
    const r = parseAnthropicModelsResponse({
      data: [{ ...happy, type: "model_snapshot" }, happy],
    });
    if (!r.ok) throw new Error("parser failed unexpectedly");
    expect(r.models).toHaveLength(1);
    expect(r.droppedItems).toBe(1);
  });

  it("drops non-claude- ids (Hunt R6 — id allowlist)", () => {
    const r = parseAnthropicModelsResponse({
      data: [{ ...happy, id: "gpt-4o" }, happy],
    });
    if (!r.ok) throw new Error("parser failed unexpectedly");
    expect(r.models).toHaveLength(1);
    expect(r.models[0]!.id).toBe("claude-opus-4-7");
  });

  it("drops id with leading dash (argv-injection defence)", () => {
    const r = parseAnthropicModelsResponse({
      data: [{ ...happy, id: "-malicious-flag" }, happy],
    });
    if (!r.ok) throw new Error("parser failed unexpectedly");
    expect(r.droppedItems).toBe(1);
    expect(r.models).toHaveLength(1);
  });

  it("drops id exceeding length cap", () => {
    const longId = "claude-" + "x".repeat(200);
    const r = parseAnthropicModelsResponse({
      data: [{ ...happy, id: longId }, happy],
    });
    if (!r.ok) throw new Error("parser failed unexpectedly");
    expect(r.droppedItems).toBe(1);
  });

  it("tolerates missing display_name (EC-5 polymorphic-by-spec)", () => {
    const { display_name: _, ...minimal } = happy;
    void _;
    const r = parseAnthropicModelsResponse({ data: [minimal] });
    if (!r.ok) throw new Error("parser failed unexpectedly");
    expect(r.models[0]!.display_name).toBeUndefined();
  });

  it("tolerates missing created_at", () => {
    const { created_at: _, ...minimal } = happy;
    void _;
    const r = parseAnthropicModelsResponse({ data: [minimal] });
    if (!r.ok) throw new Error("parser failed unexpectedly");
    expect(r.models[0]!.created_at).toBeUndefined();
  });

  it("drops entry with control chars in display_name", () => {
    const r = parseAnthropicModelsResponse({
      data: [{ ...happy, display_name: "BadName" }, happy],
    });
    if (!r.ok) throw new Error("parser failed unexpectedly");
    expect(r.droppedItems).toBe(1);
  });

  it("drops entry with bidi controls (Trojan-Source CVE-2021-42574)", () => {
    const r = parseAnthropicModelsResponse({
      data: [
        { ...happy, display_name: "Hidden‮rightToLeft" },
        happy,
      ],
    });
    if (!r.ok) throw new Error("parser failed unexpectedly");
    expect(r.droppedItems).toBe(1);
  });

  it("drops entry with unparseable created_at", () => {
    const r = parseAnthropicModelsResponse({
      data: [{ ...happy, created_at: "not-a-date" }, happy],
    });
    if (!r.ok) throw new Error("parser failed unexpectedly");
    expect(r.droppedItems).toBe(1);
  });

  it("preserves hasMore canary when upstream paginates", () => {
    const r = parseAnthropicModelsResponse({ data: [happy], has_more: true });
    if (!r.ok) throw new Error("parser failed unexpectedly");
    expect(r.hasMore).toBe(true);
  });
});

// ── SORT ───────────────────────────────────────────────────────────────────

describe("sortAnthropicModels", () => {
  const m = (id: string, created_at?: number) => ({
    id,
    display_name: undefined,
    created_at,
  });

  it("sorts opus > sonnet > haiku across tiers", () => {
    const sorted = sortAnthropicModels([
      m("claude-haiku-4-5"),
      m("claude-sonnet-4-6"),
      m("claude-opus-4-7"),
    ]);
    expect(sorted.map((x) => x.id)).toEqual([
      "claude-opus-4-7",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
    ]);
  });

  it("within tier sorts created_at desc (newer first)", () => {
    const sorted = sortAnthropicModels([
      m("claude-opus-4-7", Date.parse("2026-01-15T00:00:00Z")),
      m("claude-opus-4-8", Date.parse("2026-04-15T00:00:00Z")),
    ]);
    expect(sorted.map((x) => x.id)).toEqual([
      "claude-opus-4-8",
      "claude-opus-4-7",
    ]);
  });

  it("Risk #6: `4-10` sorts BEFORE `4-7` numerically (not lexicographically)", () => {
    const sorted = sortAnthropicModels([
      m("claude-opus-4-7"),
      m("claude-opus-4-10"),
    ]);
    expect(sorted[0]!.id).toBe("claude-opus-4-10");
    expect(sorted[1]!.id).toBe("claude-opus-4-7");
  });

  it("prefers entries with created_at over those without (within same tier)", () => {
    const sorted = sortAnthropicModels([
      m("claude-opus-4-7"),
      m("claude-opus-4-8", Date.parse("2026-04-15T00:00:00Z")),
    ]);
    expect(sorted[0]!.id).toBe("claude-opus-4-8");
  });

  it("falls back to lexicographic desc on full tie", () => {
    const sorted = sortAnthropicModels([
      m("claude-opus-x"),
      m("claude-opus-y"),
    ]);
    expect(sorted[0]!.id).toBe("claude-opus-y");
  });

  it("is non-mutating", () => {
    const input = [m("claude-haiku-4-5"), m("claude-opus-4-7")];
    const inputCopy = [...input];
    sortAnthropicModels(input);
    expect(input).toEqual(inputCopy);
  });
});

// ── LABEL NORMALISATION (Saarinen R1) ──────────────────────────────────────

describe("parseAndPrepareAnthropicModels — label normalisation", () => {
  it("strips 'Claude ' prefix from display_name", () => {
    const r = parseAndPrepareAnthropicModels({
      data: [
        {
          type: "model",
          id: "claude-opus-4-7",
          display_name: "Claude Opus 4.7",
        },
      ],
    });
    if (!r.ok) throw new Error("parser failed");
    expect(r.models[0]!.label).toBe("Opus 4.7");
  });

  it("falls back to id when display_name missing", () => {
    const r = parseAndPrepareAnthropicModels({
      data: [{ type: "model", id: "claude-opus-4-7" }],
    });
    if (!r.ok) throw new Error("parser failed");
    expect(r.models[0]!.label).toBe("claude-opus-4-7");
  });

  it("does NOT strip non-matching prefix", () => {
    const r = parseAndPrepareAnthropicModels({
      data: [
        {
          type: "model",
          id: "claude-opus-x",
          display_name: "NotClaude Opus",
        },
      ],
    });
    if (!r.ok) throw new Error("parser failed");
    expect(r.models[0]!.label).toBe("NotClaude Opus");
  });
});

// ── FIXTURE REPLAY (EC-6) ──────────────────────────────────────────────────

describe("parseAndPrepareAnthropicModels — fixture replay (EC-6)", () => {
  it("processes the captured /v1/models fixture deterministically", () => {
    const fixturePath = join(
      __dirname,
      "fixtures",
      "anthropic-models-response.json",
    );
    const raw = JSON.parse(readFileSync(fixturePath, "utf8"));
    const r = parseAndPrepareAnthropicModels(raw);
    if (!r.ok) throw new Error("fixture parse failed");
    // 4 valid claude- entries; 2 must be dropped (model_snapshot + gpt-4o)
    expect(r.models).toHaveLength(4);
    expect(r.droppedItems).toBe(2);
    expect(r.hasMore).toBe(false);
    // Sort order: opus-4-8 (newest) > opus-4-7 > sonnet-4-6 > haiku-4-5
    expect(r.models.map((m) => m.value)).toEqual([
      "claude-opus-4-8-20260415",
      "claude-opus-4-7",
      "claude-sonnet-4-6",
      "claude-haiku-4-5-20251001",
    ]);
    // Labels stripped of "Claude " prefix
    expect(r.models[0]!.label).toBe("Opus 4.8");
    expect(r.models[1]!.label).toBe("Opus 4.7");
  });
});

// ── KEY FINGERPRINT ────────────────────────────────────────────────────────

describe("computeKeyFingerprint", () => {
  it("produces 16 hex chars", () => {
    const fp = computeKeyFingerprint("sk-ant-test");
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(fp.length).toBe(KEY_FINGERPRINT_HEX_LEN);
  });

  it("is deterministic for identical input", () => {
    expect(computeKeyFingerprint("k1")).toBe(computeKeyFingerprint("k1"));
  });

  it("changes when the key rotates", () => {
    expect(computeKeyFingerprint("k1")).not.toBe(computeKeyFingerprint("k2"));
  });
});

// ── ATOMIC 3-CHECK HIT PREDICATE ───────────────────────────────────────────

describe("isCacheRecordValid", () => {
  const validRecord = (fp: string, fetched_at: number): CachedModelsRecord => ({
    schema_version: SCHEMA_VERSION,
    fetched_at,
    key_fingerprint: fp,
    models: [],
  });
  const now = 1_000_000_000_000;
  const ttl = 60_000;

  it("accepts fresh record with matching fingerprint", () => {
    expect(isCacheRecordValid(validRecord("fp", now - 1000), "fp", now, ttl)).toBe(
      true,
    );
  });

  it("rejects fingerprint mismatch (key rotation invalidation)", () => {
    expect(isCacheRecordValid(validRecord("fp1", now - 1000), "fp2", now, ttl)).toBe(
      false,
    );
  });

  it("rejects record older than ttlMs (staleness)", () => {
    expect(isCacheRecordValid(validRecord("fp", now - ttl - 1), "fp", now, ttl)).toBe(
      false,
    );
  });

  it("rejects wrong schema_version (forward-compat reject)", () => {
    const r = { ...validRecord("fp", now), schema_version: 2 };
    expect(isCacheRecordValid(r, "fp", now, ttl)).toBe(false);
  });

  it("rejects null, array, non-object", () => {
    expect(isCacheRecordValid(null, "fp", now, ttl)).toBe(false);
    expect(isCacheRecordValid([], "fp", now, ttl)).toBe(false);
    expect(isCacheRecordValid("str", "fp", now, ttl)).toBe(false);
  });

  it("rejects malformed shape (missing required fields)", () => {
    expect(isCacheRecordValid({ schema_version: 1 }, "fp", now, ttl)).toBe(false);
  });
});

// ── FETCH OUTCOMES ─────────────────────────────────────────────────────────

describe("fetchAnthropicModelsRaw", () => {
  it("returns success on 200 with JSON body", async () => {
    const fakeFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    const r = await fetchAnthropicModelsRaw("sk-test", { fetch: fakeFetch });
    expect(r.kind).toBe("success");
    if (r.kind === "success") expect(r.httpStatus).toBe(200);
  });

  it("maps 401 to auth-failed", async () => {
    const fakeFetch = vi.fn().mockResolvedValue(new Response("", { status: 401 }));
    const r = await fetchAnthropicModelsRaw("sk-test", { fetch: fakeFetch });
    expect(r.kind).toBe("auth-failed");
    if (r.kind === "auth-failed") expect(r.httpStatus).toBe(401);
  });

  it("maps 403 to auth-failed", async () => {
    const fakeFetch = vi.fn().mockResolvedValue(new Response("", { status: 403 }));
    const r = await fetchAnthropicModelsRaw("sk-test", { fetch: fakeFetch });
    expect(r.kind).toBe("auth-failed");
  });

  it("maps 500 to unavailable/5xx", async () => {
    const fakeFetch = vi.fn().mockResolvedValue(new Response("", { status: 500 }));
    const r = await fetchAnthropicModelsRaw("sk-test", { fetch: fakeFetch });
    expect(r.kind).toBe("unavailable");
    if (r.kind === "unavailable") expect(r.reason).toBe("5xx");
  });

  it("maps malformed JSON to unavailable/parse", async () => {
    const fakeFetch = vi
      .fn()
      .mockResolvedValue(new Response("not json", { status: 200 }));
    const r = await fetchAnthropicModelsRaw("sk-test", { fetch: fakeFetch });
    expect(r.kind).toBe("unavailable");
    if (r.kind === "unavailable") expect(r.reason).toBe("parse");
  });

  it("maps thrown TypeError (DNS / network) to unavailable/network", async () => {
    const fakeFetch = vi.fn().mockRejectedValue(new TypeError("ENOTFOUND"));
    const r = await fetchAnthropicModelsRaw("sk-test", { fetch: fakeFetch });
    expect(r.kind).toBe("unavailable");
    if (r.kind === "unavailable") expect(r.reason).toBe("network");
  });

  it("maps AbortError to unavailable/timeout", async () => {
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    const fakeFetch = vi.fn().mockRejectedValue(abortErr);
    const r = await fetchAnthropicModelsRaw("sk-test", { fetch: fakeFetch });
    expect(r.kind).toBe("unavailable");
    if (r.kind === "unavailable") expect(r.reason).toBe("timeout");
  });

  it("times out via internal AbortController (5s budget)", async () => {
    vi.useFakeTimers();
    try {
      // Fake fetch that respects the abort signal and rejects with AbortError.
      const fakeFetch = vi.fn().mockImplementation(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_, reject) => {
            const sig = init?.signal;
            if (sig) {
              sig.addEventListener("abort", () => {
                const err = new Error("aborted");
                err.name = "AbortError";
                reject(err);
              });
            }
          }),
      );

      const resultPromise = fetchAnthropicModelsRaw("sk-test", {
        fetch: fakeFetch,
      });
      // Advance time past the timeout budget.
      await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS + 100);
      const r = await resultPromise;
      expect(r.kind).toBe("unavailable");
      if (r.kind === "unavailable") expect(r.reason).toBe("timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes anthropic-version header", async () => {
    const fakeFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    await fetchAnthropicModelsRaw("sk-test", { fetch: fakeFetch });
    const [, init] = fakeFetch.mock.calls[0]!;
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
  });
});

// ── ORCHESTRATOR ───────────────────────────────────────────────────────────

describe("getAnthropicModels orchestrator", () => {
  beforeEach(() => {
    __resetMemoryCacheForTests();
    __resetInflightForTests();
    __deleteDiskCacheForTests();
  });

  afterEach(() => {
    __resetMemoryCacheForTests();
    __resetInflightForTests();
    __deleteDiskCacheForTests();
  });

  it("returns no-key when apiKey is empty", async () => {
    const r = await getAnthropicModels("");
    expect(r.kind).toBe("no-key");
  });

  it("returns memory hit without calling fetch", async () => {
    const fp = computeKeyFingerprint("sk-test");
    const record: CachedModelsRecord = {
      schema_version: SCHEMA_VERSION,
      fetched_at: Date.now(),
      key_fingerprint: fp,
      models: [{ value: "claude-opus-4-7", label: "Opus 4.7", description: "" }],
    };
    writeMemoryCache(record);
    const fakeFetch = vi.fn();
    const r = await getAnthropicModels("sk-test", { fetch: fakeFetch });
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.source).toBe("memory");
      expect(r.models).toHaveLength(1);
    }
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it("evicts expired memory entry and falls through to fetch", async () => {
    const fp = computeKeyFingerprint("sk-test");
    const expired: CachedModelsRecord = {
      schema_version: SCHEMA_VERSION,
      fetched_at: Date.now() - IN_MEMORY_TTL_MS - 1000,
      key_fingerprint: fp,
      models: [],
    };
    writeMemoryCache(expired);
    const probeNow = Date.now();
    expect(readMemoryCache(fp, probeNow)).toBeNull();
  });

  it("maps fetch 401 to upstream-auth", async () => {
    const fakeFetch = vi.fn().mockResolvedValue(new Response("", { status: 401 }));
    const r = await getAnthropicModels("sk-test", { fetch: fakeFetch });
    expect(r.kind).toBe("upstream-auth");
  });

  it("maps fetch 500 to upstream-unavailable (no cache to serve)", async () => {
    const fakeFetch = vi.fn().mockResolvedValue(new Response("", { status: 500 }));
    const r = await getAnthropicModels("sk-test", { fetch: fakeFetch });
    expect(r.kind).toBe("upstream-unavailable");
    if (r.kind === "upstream-unavailable") expect(r.reason).toBe("5xx");
  });

  it("collapses N concurrent cold-cache requests to ONE upstream fetch (single-flight)", async () => {
    let resolveFetch: (v: Response) => void;
    const fetchPromise = new Promise<Response>((res) => {
      resolveFetch = res;
    });
    const fakeFetch = vi.fn().mockReturnValue(fetchPromise);

    const [p1, p2, p3] = [
      getAnthropicModels("sk-test", { fetch: fakeFetch }),
      getAnthropicModels("sk-test", { fetch: fakeFetch }),
      getAnthropicModels("sk-test", { fetch: fakeFetch }),
    ];
    // All three should share the same in-flight promise.
    resolveFetch!(
      new Response(
        JSON.stringify({
          data: [
            { type: "model", id: "claude-opus-4-7", display_name: "Claude Opus 4.7" },
          ],
        }),
        { status: 200 },
      ),
    );
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    // Exactly ONE upstream call.
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    expect(r1.kind).toBe("ok");
    expect(r2.kind).toBe("ok");
    expect(r3.kind).toBe("ok");
  });

  it("different keys do NOT share single-flight lock", async () => {
    const fakeFetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ data: [] }), { status: 200 }),
      );
    await Promise.all([
      getAnthropicModels("sk-A", { fetch: fakeFetch }),
      getAnthropicModels("sk-B", { fetch: fakeFetch }),
    ]);
    expect(fakeFetch).toHaveBeenCalledTimes(2);
  });

  it("rejects parser-failure with upstream-unavailable/parse", async () => {
    const fakeFetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ no_data_field: true }), { status: 200 }),
      );
    const r = await getAnthropicModels("sk-test", { fetch: fakeFetch });
    expect(r.kind).toBe("upstream-unavailable");
    if (r.kind === "upstream-unavailable") expect(r.reason).toBe("parse");
  });

  it("invalidates memory cache after key rotation (different fingerprint)", async () => {
    const fp = computeKeyFingerprint("sk-old");
    writeMemoryCache({
      schema_version: SCHEMA_VERSION,
      fetched_at: Date.now(),
      key_fingerprint: fp,
      models: [{ value: "stale", label: "stale", description: "" }],
    });
    // Rotating to a new key — different fingerprint → memory cache lookup
    // returns null (not the old record).
    expect(readMemoryCache(computeKeyFingerprint("sk-new"), Date.now())).toBeNull();
  });
});

// ── RECORDING EXCLUSION (Hunt R5) ──────────────────────────────────────────

describe("recorder integration — apiKey leakage canary", () => {
  it("recorder.ts does NOT reference Anthropic models cache module (no fetch-tee)", () => {
    // EC-19 static-grep canary: the recorder must not import or call into
    // this cache module — outbound `fetch` to api.anthropic.com is a direct
    // server call, never routed through the protocol-recording channel.
    // If a future refactor wires this in, a key-bearing fetch could land
    // in `~/.companion/recordings/*.jsonl` → mandatory rotation.
    const recorderSource = readFileSync(
      join(__dirname, "recorder.ts"),
      "utf8",
    );
    expect(recorderSource).not.toMatch(/anthropic-models-cache/);
    expect(recorderSource).not.toMatch(/api\.anthropic\.com/);
  });
});
