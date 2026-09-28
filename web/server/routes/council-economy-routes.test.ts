// Tests for the workspace-agnostic Council PRO Economy REST surface. Validates the
// stats record endpoint, the path-traversal-guarded server-side hash, and the
// cache put→get round-trip over HTTP — plus that the HTTP hash is byte-identical to
// the CLI's hashFilesOnDisk so a mixed CLI/HTTP fleet stays cache-compatible.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerCouncilEconomyRoutes } from "./council-economy-routes.js";
import { hashFilesOnDisk } from "../../scripts/result-cache.js";

let app: Hono;
let statsDir: string;
let cacheDir: string;
let workspace: string;
let prevStats: string | undefined;
let prevCache: string | undefined;

beforeEach(() => {
  statsDir = mkdtempSync(join(tmpdir(), "econ-stats-"));
  cacheDir = mkdtempSync(join(tmpdir(), "econ-cache-"));
  workspace = mkdtempSync(join(tmpdir(), "econ-ws-"));
  prevStats = process.env.COMPANION_COUNCIL_STATS_DIR;
  prevCache = process.env.COMPANION_COUNCIL_CACHE_DIR;
  process.env.COMPANION_COUNCIL_STATS_DIR = statsDir;
  process.env.COMPANION_COUNCIL_CACHE_DIR = cacheDir;

  app = new Hono();
  const api = new Hono();
  registerCouncilEconomyRoutes(api);
  app.route("/api", api);
});

afterEach(() => {
  rmSync(statsDir, { recursive: true, force: true });
  rmSync(cacheDir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
  if (prevStats === undefined) delete process.env.COMPANION_COUNCIL_STATS_DIR;
  else process.env.COMPANION_COUNCIL_STATS_DIR = prevStats;
  if (prevCache === undefined) delete process.env.COMPANION_COUNCIL_CACHE_DIR;
  else process.env.COMPANION_COUNCIL_CACHE_DIR = prevCache;
});

function post(path: string, body: unknown) {
  return app.request(`/api${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const statsBody = {
  skill: "council-review",
  engineVersion: "rc2",
  complexity: { diffFiles: 1, diffLines: 5, surfaceCount: 0, domainBreadth: 0 },
  seats: [{ seatId: "hunt", guaranteed: true, tier: "top", model: "default", findings: [] }],
};

describe("POST /council/economy/stats", () => {
  it("records a valid run and returns a runId", async () => {
    const res = await post("/council/economy/stats", statsBody);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; runId: string };
    expect(json.ok).toBe(true);
    expect(json.runId).toBeTruthy();
  });

  it("422s an invalid run (bad tier)", async () => {
    const res = await post("/council/economy/stats", {
      ...statsBody,
      seats: [{ seatId: "hunt", guaranteed: true, tier: "medium", model: "d", findings: [] }],
    });
    expect(res.status).toBe(422);
  });

  it("400s invalid json", async () => {
    const res = await app.request("/api/council/economy/stats", { method: "POST", body: "{bad" });
    expect(res.status).toBe(400);
  });
});

describe("POST /council/economy/cache/hash", () => {
  it("hashes a file set and matches the CLI hashFilesOnDisk byte-for-byte", async () => {
    writeFileSync(join(workspace, "a.ts"), "alpha");
    writeFileSync(join(workspace, "b.ts"), "beta");
    const res = await post("/council/economy/cache/hash", { root: workspace, paths: ["a.ts", "b.ts"] });
    expect(res.status).toBe(200);
    const { hash } = (await res.json()) as { hash: string };
    expect(hash).toBe(hashFilesOnDisk(workspace, ["a.ts", "b.ts"]));
  });

  it("403s a path that escapes the root (traversal guard)", async () => {
    const res = await post("/council/economy/cache/hash", { root: workspace, paths: ["../../etc/passwd"] });
    expect(res.status).toBe(403);
  });

  it("400s a missing paths array", async () => {
    const res = await post("/council/economy/cache/hash", { root: workspace });
    expect(res.status).toBe(400);
  });
});

describe("cache put → get round-trip over HTTP", () => {
  const putBody = {
    skill: "council-review",
    engineVersion: "rc2",
    seatId: "saarinen",
    filesHash: "hash-xyz",
    findings: [{ id: "f1", priority: "P2", summary: "a nit" }],
  };

  it("stores then hits with matching key", async () => {
    const putRes = await post("/council/economy/cache/put", putBody);
    expect(putRes.status).toBe(200);
    const getRes = await post("/council/economy/cache/get", {
      skill: "council-review",
      seatId: "saarinen",
      filesHash: "hash-xyz",
      engineVersion: "rc2",
    });
    const lookup = (await getRes.json()) as { hit: boolean; result?: { findings: unknown[] } };
    expect(lookup.hit).toBe(true);
    expect(lookup.result?.findings).toEqual(putBody.findings);
  });

  it("misses on an engine-version mismatch (invalidation over HTTP)", async () => {
    await post("/council/economy/cache/put", putBody);
    const getRes = await post("/council/economy/cache/get", {
      skill: "council-review",
      seatId: "saarinen",
      filesHash: "hash-xyz",
      engineVersion: "rc3",
    });
    expect((await getRes.json()) as { hit: boolean; reason: string }).toEqual({ hit: false, reason: "version" });
  });

  it("misses when nothing was stored", async () => {
    const getRes = await post("/council/economy/cache/get", {
      skill: "council-review",
      seatId: "nobody",
      filesHash: "none",
      engineVersion: "rc2",
    });
    expect((await getRes.json()) as { hit: boolean; reason: string }).toEqual({ hit: false, reason: "miss" });
  });

  it("422s an invalid put (bad priority)", async () => {
    const res = await post("/council/economy/cache/put", {
      ...putBody,
      findings: [{ id: "x", priority: "P0", summary: "s" }],
    });
    expect(res.status).toBe(422);
  });
});
