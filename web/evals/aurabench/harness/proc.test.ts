/**
 * Tests for the live-child registry in proc.ts (P6/FIX-D2-1c item 3).
 *
 * Agents run detached (own process group), so the terminal's SIGINT does not
 * reach them. The runner's signal handler must stop them BEFORE it releases
 * the cell Codex homes (else auth.json vanishes under a live Codex B). This
 * spawns a real `sleep` through `nice` — the point is that the group really
 * dies and the registry empties, which a mock cannot prove.
 */

import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { liveChildCount, spawnNice, stopLiveChildren } from "./proc.js";

describe("spawnNice live-child registry", () => {
  it("tracks a running agent group and stopLiveChildren() terminates it", async () => {
    const run = spawnNice("sleep", ["30"], { cwd: tmpdir(), timeoutMs: 60_000, env: { PATH: process.env.PATH ?? "" } });
    expect(liveChildCount()).toBe(1);
    const t0 = Date.now();
    await stopLiveChildren(5_000);
    const r = await run;
    expect(liveChildCount()).toBe(0);
    // Killed by SIGTERM well before the 30 s sleep would end.
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(r.code).not.toBe(0);
  });

  it("stopLiveChildren() with nothing running resolves at once", async () => {
    expect(liveChildCount()).toBe(0);
    await expect(stopLiveChildren(10)).resolves.toBeUndefined();
  });
});
