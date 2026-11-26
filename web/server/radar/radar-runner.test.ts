import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RadarRunner } from "./radar-runner.js";
import { evaluateFindings } from "./radar-evaluator.js";
import { RadarStore } from "./radar-store.js";
const dirs: string[] = [];
const finding = { repo: "openai/codex", title: "Update", url: "https://github.com/openai/codex", publishedAt: null, topics: [] };
function fixture() { const dir = mkdtempSync(join(tmpdir(), "radar-run-")); dirs.push(dir); return new RadarStore(join(dir, "state.json")); }
afterEach(() => { vi.useRealTimers(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
describe("single-flight read-only radar", () => {
  // Real store + evaluator: a failed scan must preserve evidence and dismissals.
  it("keeps decisions across an in-flight scan and retains last good results on failure", async () => {
    const store = fixture(); const initial = store.read(); initial.config.sources = [initial.config.sources[0]]; store.write(initial); let now = 1_000_000; let fail = false;
    const runner = new RadarRunner(store, async () => { if (fail) throw new Error("secret error must not leak"); return [finding]; }, () => now);
    const first = await runner.run(); expect(first.counts.proposals).toBe(1); expect(first.lastSuccess).toBe(now);
    now += 61000; fail = true;
    const next = await runner.run(); expect(next.outcome).toBe("error"); expect(next.lastSuccess).toBe(first.lastSuccess); expect(next.ideas).toEqual(first.ideas);
    expect(JSON.stringify(next)).not.toContain("secret error");
    now += 61000;
    let release!: () => void;
    const waiting = new RadarRunner(store, async () => { await new Promise<void>(r => { release = r; }); return [finding]; }, () => now);
    const run = waiting.run(); await expect(waiting.run()).rejects.toThrow("уже идёт");
    store.decide(first.ideas[0].id, "dismissed");
    // Only use one source on subsequent turns so the controlled adapter resolves once.
    const state = store.read(); state.config.sources = [state.config.sources[0]]; store.write(state);
    release(); await run; waiting.dispose();
    expect(store.read().decisions[first.ideas[0].id]).toBe("dismissed");
  });
  it("deadline releases a hung adapter and restart does not replay missed days", async () => {
    vi.useFakeTimers(); const store = fixture();
    const s = store.read(); s.config.enabled = true; s.config.sources = [s.config.sources[0]]; store.write(s);
    const acquire = vi.fn(() => new Promise<never>(() => {}));
    const runner = new RadarRunner(store, acquire);
    const run = runner.run(); await vi.advanceTimersByTimeAsync(60001); expect((await run).outcome).toBe("error"); expect(runner.view().running).toBe(false);
    runner.dispose(); const restartAcquire = vi.fn().mockResolvedValue([]);
    const restart = new RadarRunner(store, restartAcquire); restart.start(); await vi.advanceTimersByTimeAsync(60_000);
    expect(restartAcquire).not.toHaveBeenCalled(); restart.dispose();
  });
  it("stores partial success separately and ignores automatic scans when disabled", async () => {
    vi.useFakeTimers(); const store = fixture(); let calls = 0;
    const acquire = vi.fn(async () => { if (calls++ > 0) throw new Error(); return [finding]; });
    const runner = new RadarRunner(store, acquire); runner.start(); await vi.advanceTimersByTimeAsync(120000); expect(acquire).not.toHaveBeenCalled();
    const result = await runner.run(); expect(result.outcome).toBe("partial"); expect(result.lastSuccess).toBeNull(); expect(result.counts.proposals).toBe(1); runner.dispose();
  });
});

// A process restart must not present a half-written attempt as a completed scan.
it("shows interruption after restart without retaining a permanent running flag", () => {
  const store = fixture(); const state = store.read(); state.lastAttempt = 1000; store.write(state);
  const restarted = new RadarRunner(store, async () => []);
  expect(restarted.view()).toMatchObject({ running: false, outcome: "error", lastSuccess: null });
  expect(restarted.view().sourceErrors[0]).toContain("не завершилась");
  restarted.dispose();
});

// RIT-1: partial acquisition cannot evict the previous good evidence at the hard cap.
it("retains all prior evidence when a partial scan fills the budget", async () => {
 const store=fixture(); const s=store.read();
 const make=(prefix:string)=>Array.from({length:100},(_,i)=>({repo:`team/${prefix}${i}`,title:"",url:`https://github.com/team/${prefix}${i}`,publishedAt:null,topics:["mcp-server"]}));
 s.ideas=evaluateFindings(make("old"));s.config.sources=[{kind:"search",value:"topic:mcp-server"},{kind:"repo",value:"missing/repo"}];store.write(s);
 const runner=new RadarRunner(store,async source=>{if(source.kind==="repo")throw new Error();return make("new");});
 expect((await runner.run()).outcome).toBe("partial");expect(store.read().ideas.map(i=>i.id)).toEqual(s.ideas.map(i=>i.id)); runner.dispose();
});
// FOWLER-1: decided evidence outlives replaceable search results and can actually be restored after restart.
it("preserves named decisions through successful replacement and restores the proposal", async()=>{
 const store=fixture();const s=store.read();s.config.sources=[s.config.sources[0]];store.write(s);let now=1_000_000;
 const first=new RadarRunner(store,async()=>[finding],()=>now);const v=await first.run();store.decide(v.ideas[0].id,"implemented");now+=61000;
 const second=new RadarRunner(store,async()=>[],()=>now);await second.run();
 // Recreate from its real backing path without relying on in-memory runner state.
 const restarted=new RadarStore(join(dirs.at(-1)!,"state.json"));
 expect(restarted.read().decisionIdeas?.[v.ideas[0].id]).toEqual(v.ideas[0]);
 restarted.decide(v.ideas[0].id,"restore");expect(restarted.read().ideas).toContainEqual(v.ideas[0]);expect(restarted.read().decisions).toEqual({});first.dispose();second.dispose();
});
// BECK-1: positive scheduled behavior, one run per day and durable results, not just disabled guards.
it("automatically scans opted-in sources once each due day",async()=>{
 vi.useFakeTimers();vi.setSystemTime(Date.parse("2026-11-26T00:00:00Z"));const store=fixture();const s=store.read();s.config.enabled=true;s.config.sources=[s.config.sources[0]];store.write(s);
 const acquire=vi.fn(async()=>[finding]);const runner=new RadarRunner(store,acquire);runner.start();
 await vi.advanceTimersByTimeAsync(60_000);expect(acquire).toHaveBeenCalledTimes(1);expect(store.read().ideas).toHaveLength(1);expect(store.read().lastAttempt).toBe(Date.now());
 await vi.advanceTimersByTimeAsync(86_340_000);expect(acquire).toHaveBeenCalledTimes(1);
 await vi.advanceTimersByTimeAsync(60_000);expect(acquire).toHaveBeenCalledTimes(2);runner.dispose();
});
