import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { RadarStore } from "../radar/radar-store.js";
import { RadarRunner } from "../radar/radar-runner.js";
import { registerRadarRoutes } from "./radar-routes.js";
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function appFixture() {
  const dir = mkdtempSync(join(tmpdir(), "radar-routes-")); dirs.push(dir);
  const store = new RadarStore(join(dir, "state.json"));
  const runner = new RadarRunner(store, async () => []);
  const app = new Hono(); registerRadarRoutes(app, runner, store); return { app, runner, store, path: join(dir, "state.json") };
}
describe("Radar operation boundaries", () => {
  // Real Hono/runner/store: malformed config is rejected before any network work.
  it("reads defaults, validates mutations and permits explicit scans", async () => {
    const { app, runner } = appFixture();
    expect((await (await app.request("/radar")).json()).counts).toEqual({ proposals: 0, implemented: 4 });
    const put = (body: unknown) => app.request("/radar/config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect((await put({ enabled: true, sources: [{ kind: "repo", value: "https://127.0.0.1" }] })).status).toBe(400);
    expect((await put({ enabled: true, sources: [{ kind: "repo", value: "openai/codex" }] })).status).toBe(200);
    expect((await app.request("/radar/run", { method: "POST" })).status).toBe(200);
    expect((await app.request("/radar/run", { method: "POST" })).status).toBe(409);
    expect((await app.request("/radar/decisions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "../file", decision: "implemented" }) })).status).toBe(400);
    runner.dispose();
  });
});

// HUNT-1: rejected JSON mutations must not change durable bytes or poison later reads.
it.each([["implemented"], { value: "implemented" }, null, 1])("rejects non-string decisions without changing state: %j", async decision => {
  const { app, runner, store, path } = appFixture();
  const state = store.read(); state.ideas = [{ id: "a".repeat(24), title: "A", benefit: "B", gap: "G", url: "https://github.com/team/tool", publishedAt: null, confidence: "candidate", complexity: "?" }]; store.write(state);
  const before = readFileSync(path, "utf8");
  const res = await app.request("/radar/decisions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: state.ideas[0].id, decision }) });
  expect(res.status).toBe(400); expect(readFileSync(path, "utf8")).toBe(before); expect((await app.request("/radar")).status).toBe(200);
  runner.dispose();
});
