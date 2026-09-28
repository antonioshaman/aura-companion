// Council PRO Economy — workspace-agnostic REST surface (spec follow-up).
//
// The run-stats + result-cache engine lives in `web/scripts/` and is only on the
// PATH when the aura-companion repo is the cwd. Non-aura council pairs run in other
// repos (Python bots, …) where `bun web/scripts/...` does not resolve, so they
// cannot collect stats or use the cache via the CLI. These endpoints expose the
// same primitives over the server's own HTTP (which every pair can already reach at
// localhost:3456, exactly like the checkpoint-emit), so ALL pipelines contribute to
// the dataset and share the cache from any workspace.
//
// The hashing endpoint reads the caller's workspace files server-side (same box)
// under a path-traversal guard — the client sends {root, paths}, never contents.

import type { Hono } from "hono";
import { resolve, sep } from "node:path";
import { readFileSync } from "node:fs";

import { respondError } from "../respond-error.js";
import { recordRunStats, type RunStatsInput } from "../../scripts/run-stats.js";
import {
  hashFileSet,
  getCachedResult,
  putCachedResult,
  type FileEntry,
  type PutCacheInput,
} from "../../scripts/result-cache.js";

const MAX_HASH_PATHS = 200;
const MAX_HASH_PATH_LEN = 1024;
const MAX_HASH_FILE_BYTES = 512 * 1024;
// Same deletion-sensitive sentinel hashFilesOnDisk uses, so the HTTP path and the
// CLI path produce IDENTICAL hashes for the same file set (a mixed fleet stays
// cache-compatible).
const UNREADABLE_SENTINEL = "\u0000<unreadable-or-missing>";

export function registerCouncilEconomyRoutes(api: Hono): void {
  // Record one council run into the persistent stats dataset.
  api.post("/council/economy/stats", async (c) => {
    let body: RunStatsInput;
    try {
      body = (await c.req.json()) as RunStatsInput;
    } catch {
      return respondError(c, 400, "bad_request", { module: "council.economy.stats", detail: { reason: "invalid json" } });
    }
    try {
      const rec = recordRunStats(body);
      return c.json({ ok: true, runId: rec.runId });
    } catch (e) {
      return respondError(c, 422, "validation_failed", {
        module: "council.economy.stats",
        detail: { reason: (e as Error).message },
      });
    }
  });

  // Content-hash a seat's assigned file set (read server-side, path-guarded).
  api.post("/council/economy/cache/hash", async (c) => {
    let body: { root?: unknown; paths?: unknown };
    try {
      body = (await c.req.json()) as { root?: unknown; paths?: unknown };
    } catch {
      return respondError(c, 400, "bad_request", { module: "council.economy.cache.hash" });
    }
    const root = typeof body.root === "string" ? body.root : "";
    const paths = Array.isArray(body.paths) ? body.paths : null;
    if (!root || !paths || paths.length === 0 || paths.length > MAX_HASH_PATHS) {
      return respondError(c, 400, "bad_request", {
        module: "council.economy.cache.hash",
        detail: { reason: `root + non-empty paths[] (<= ${MAX_HASH_PATHS}) required` },
      });
    }
    const rootResolved = resolve(root);
    const entries: FileEntry[] = [];
    for (const p of paths) {
      if (typeof p !== "string" || p.length === 0 || p.length > MAX_HASH_PATH_LEN) {
        return respondError(c, 400, "bad_request", { module: "council.economy.cache.hash", detail: { reason: "bad path entry" } });
      }
      const abs = resolve(rootResolved, p);
      // Traversal guard: the resolved path must stay within root.
      if (abs !== rootResolved && !abs.startsWith(rootResolved + sep)) {
        return respondError(c, 403, "forbidden", {
          module: "council.economy.cache.hash",
          detail: { reason: "path escapes root", path: p },
        });
      }
      let content: string;
      try {
        const buf = readFileSync(abs);
        content = (buf.length > MAX_HASH_FILE_BYTES ? buf.subarray(0, MAX_HASH_FILE_BYTES) : buf).toString("utf8");
      } catch {
        content = UNREADABLE_SENTINEL;
      }
      entries.push({ path: p, content });
    }
    return c.json({ hash: hashFileSet(entries) });
  });

  // Look up a cached seat result.
  api.post("/council/economy/cache/get", async (c) => {
    let b: { skill?: unknown; seatId?: unknown; filesHash?: unknown; engineVersion?: unknown; maxAgeMs?: unknown };
    try {
      b = (await c.req.json()) as typeof b;
    } catch {
      return respondError(c, 400, "bad_request", { module: "council.economy.cache.get" });
    }
    if (
      typeof b.skill !== "string" ||
      typeof b.seatId !== "string" ||
      typeof b.filesHash !== "string" ||
      typeof b.engineVersion !== "string"
    ) {
      return respondError(c, 400, "bad_request", {
        module: "council.economy.cache.get",
        detail: { reason: "skill, seatId, filesHash, engineVersion required" },
      });
    }
    const lookup = getCachedResult(b.skill, b.seatId, b.filesHash, {
      engineVersion: b.engineVersion,
      maxAgeMs: typeof b.maxAgeMs === "number" ? b.maxAgeMs : undefined,
    });
    return c.json(lookup);
  });

  // Write a fresh seat result into the cache.
  api.post("/council/economy/cache/put", async (c) => {
    let body: PutCacheInput;
    try {
      body = (await c.req.json()) as PutCacheInput;
    } catch {
      return respondError(c, 400, "bad_request", { module: "council.economy.cache.put" });
    }
    try {
      const rec = putCachedResult(body);
      return c.json({ ok: true, seatId: rec.seatId, filesHash: rec.filesHash });
    } catch (e) {
      return respondError(c, 422, "validation_failed", {
        module: "council.economy.cache.put",
        detail: { reason: (e as Error).message },
      });
    }
  });
}
