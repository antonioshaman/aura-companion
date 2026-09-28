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
import { readFileSync, realpathSync, statSync } from "node:fs";

import { respondError } from "../respond-error.js";
import type { CliLauncher } from "../cli-launcher.js";
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
// A file at or under this size is hashed in FULL (matching the CLI hashFilesOnDisk,
// so HTTP and CLI hashes stay byte-identical). A file OVER it is rejected (400) —
// never truncated: truncating before hashing would make two large files that differ
// only past the cap hash identically → a false cache hit that could serve stale
// findings (observer STOP). The council's assigned files are source files well under
// this bound; an over-cap file simply skips caching.
const MAX_HASH_FILE_BYTES = 2 * 1024 * 1024;
// Same deletion-sensitive sentinel hashFilesOnDisk uses, so a missing file hashes
// identically across the HTTP and CLI paths.
const UNREADABLE_SENTINEL = "\u0000<unreadable-or-missing>";

export function registerCouncilEconomyRoutes(api: Hono, deps: { launcher: CliLauncher }): void {
  const { launcher } = deps;
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
  // `root` is NOT client-supplied — it is derived from the caller's live session
  // cwd, so this can never be turned into an arbitrary-file-read oracle over the
  // whole box (observer STOP): the caller passes its sessionId + workspace-relative
  // paths only.
  api.post("/council/economy/cache/hash", async (c) => {
    let body: { sessionId?: unknown; paths?: unknown };
    try {
      body = (await c.req.json()) as { sessionId?: unknown; paths?: unknown };
    } catch {
      return respondError(c, 400, "bad_request", { module: "council.economy.cache.hash" });
    }
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    const paths = Array.isArray(body.paths) ? body.paths : null;
    if (!sessionId || !paths || paths.length === 0 || paths.length > MAX_HASH_PATHS) {
      return respondError(c, 400, "bad_request", {
        module: "council.economy.cache.hash",
        detail: { reason: `sessionId + non-empty paths[] (<= ${MAX_HASH_PATHS}) required` },
      });
    }
    const session = launcher.getSession(sessionId);
    if (!session) {
      return respondError(c, 404, "not_found", { module: "council.economy.cache.hash", detail: { sessionId } });
    }
    // realpath the workspace root once so the bounds check is symlink-safe (a
    // lexical `startsWith` alone is bypassable by a symlink inside the workspace
    // pointing outside — observer STOP).
    let rootReal: string;
    try {
      rootReal = realpathSync(resolve(session.cwd));
    } catch {
      return respondError(c, 404, "not_found", {
        module: "council.economy.cache.hash",
        detail: { sessionId, reason: "workspace path does not resolve" },
      });
    }
    const entries: FileEntry[] = [];
    for (const p of paths) {
      if (typeof p !== "string" || p.length === 0 || p.length > MAX_HASH_PATH_LEN) {
        return respondError(c, 400, "bad_request", { module: "council.economy.cache.hash", detail: { reason: "bad path entry" } });
      }
      const abs = resolve(rootReal, p);
      // Fast lexical reject of `..` escapes before touching the filesystem.
      if (abs !== rootReal && !abs.startsWith(rootReal + sep)) {
        return respondError(c, 403, "forbidden", {
          module: "council.economy.cache.hash",
          detail: { reason: "path escapes workspace", path: p },
        });
      }
      // Symlink-safe bounds: resolve the REAL path; a symlink whose target escapes
      // the workspace is refused. A missing file has no realpath → deletion
      // sentinel (matches the CLI; a nonexistent path can't leak anything).
      let real: string | null = null;
      try {
        real = realpathSync(abs);
      } catch {
        entries.push({ path: p, content: UNREADABLE_SENTINEL });
        continue;
      }
      if (real !== rootReal && !real.startsWith(rootReal + sep)) {
        return respondError(c, 403, "forbidden", {
          module: "council.economy.cache.hash",
          detail: { reason: "symlink target escapes workspace", path: p },
        });
      }
      // Reject (never truncate) an over-cap file: a truncated hash would go blind to
      // changes past the cap and forge a false cache hit.
      let content: string;
      try {
        const size = statSync(real).size;
        if (size > MAX_HASH_FILE_BYTES) {
          return respondError(c, 400, "bad_request", {
            module: "council.economy.cache.hash",
            detail: { reason: "file too large to hash", path: p, size },
          });
        }
        content = readFileSync(real).toString("utf8");
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
