import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { spawn as Spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasFreshCodexCatalog, probeCodexCatalog } from "./codex-model-refresh.js";
const shared = vi.hoisted(() => ({ path: "", spawn: vi.fn(), binary: vi.fn((): string | null => "/trusted/codex") }));
vi.mock("node:child_process", () => ({ spawn: shared.spawn }));
vi.mock("./codex-models.js", () => ({ getCodexModelsCachePath: () => shared.path }));
vi.mock("./codex-home.js", () => ({ getLegacyCodexHome: () => "/trusted/account-home" }));
vi.mock("./path-resolver.js", () => ({ resolveBinary: shared.binary }));
vi.mock("./settings-manager.js", () => ({ getSettings: () => ({}) }));
const replay = readFileSync(new URL("./__fixtures__/model-catalog-refresh/model-list.jsonl", import.meta.url), "utf8");
let dir = "";
function cache(at = new Date().toISOString()) { writeFileSync(shared.path, JSON.stringify({ fetched_at: at, models: [{ slug: "gpt-account-model", visibility: "list" }] })); }
class Child extends EventEmitter {
  pid: number | undefined = 123;
  exitCode: number | null = null;
  signalCode: string | null = null;
  stdin = new PassThrough();
  stdout = new PassThrough();
  frames: { method: string }[] = [];
  kill = vi.fn((signal: string) => { queueMicrotask(() => { this.signalCode = signal; this.stdin.destroy(); this.stdout.destroy(); this.emit("close", null); }); return true; });
  constructor(reply?: (frame: { id: number; method: string }, child: Child) => void) {
    super(); this.stdin.on("data", bytes => { const frame = JSON.parse(bytes.toString()); this.frames.push(frame); reply?.(frame, this); });
  }
}
function spawned(child: Child) { return vi.fn(() => child) as unknown as typeof Spawn; }
function responding(onList?: () => void) {
  return new Child((f,c) => queueMicrotask(() => {
    if(f.method === "initialize") c.stdout.write('{"id":1,"result":{"userAgent":"fixture"}}\n');
    if(f.method === "model/list") { onList?.(); const bytes=Buffer.from(replay); for(let i=0;i<bytes.length;i+=13)c.stdout.write(bytes.subarray(i,i+13)); }
  }));
}
beforeEach(() => { vi.useRealTimers(); vi.resetModules(); shared.spawn.mockReset(); shared.binary.mockReturnValue("/trusted/codex"); dir=mkdtempSync(join(tmpdir(),"model-catalog-"));shared.path=join(dir,"models_cache.json"); });
afterEach(() => { vi.useRealTimers(); rmSync(dir,{recursive:true,force:true}); });
describe("read-only CLI catalog roundtrip", () => {
  // Exact recorded response replayed in fragmented UTF-8 chunks; no live CLI/network in tests.
  it("initializes then lists account models and reaps the process without starting a turn", async () => {
    const child=responding();const spawn=spawned(child);
    expect(await probeCodexCatalog("/trusted/codex",{CODEX_HOME:"/trusted/home"},spawn)).toBe(true);
    expect(child.frames.map(f=>f.method)).toEqual(["initialize","initialized","model/list"]);
    expect(spawn).toHaveBeenCalledWith("/trusted/codex",["app-server","--stdio"],expect.objectContaining({shell:false,env:{CODEX_HOME:"/trusted/home"}}));
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
  it.each(['not json\n','{"id":99,"result":{}}\n','{"id":1,"error":{"message":"private token"}}\n','{"method":"unexpected","params":{}}\n','{"id":1,"result":[]}\n','{"id":1,"result":{}}\n','{"id":1,"error":null,"result":{"userAgent":"fixture"}}\n'])("rejects malformed/foreign frames without exposing content: %s",async line=>{
    const child=new Child(()=>queueMicrotask(()=>child.stdout.write(line)));
    expect(await probeCodexCatalog("/trusted/codex",{},spawned(child))).toBe(false);
  });
  it("bounds accumulated output and handles spawn/stdin failures",async()=>{
    expect(await probeCodexCatalog("/trusted/codex",{},(()=>{throw new Error("private");}) as unknown as typeof Spawn)).toBe(false);
    const huge=new Child(()=>queueMicrotask(()=>huge.stdout.write("x".repeat(1_000_001))));expect(await probeCodexCatalog("/trusted/codex",{},spawned(huge))).toBe(false);
    const broken=new Child(()=>queueMicrotask(()=>broken.stdin.emit("error",new Error("pipe"))));expect(await probeCodexCatalog("/trusted/codex",{},spawned(broken))).toBe(false);
  });
  it("times out a hung CLI, escalates to KILL and waits until it is reaped",async()=>{
    vi.useFakeTimers();const child=new Child();child.kill.mockImplementation(signal=>{if(signal==="SIGKILL")queueMicrotask(()=>{child.signalCode=signal;child.emit("close",null);});return true;});
    const result=probeCodexCatalog("/trusted/codex",{},spawned(child));let done=false;void result.then(()=>{done=true;});
    await vi.advanceTimersByTimeAsync(15_000);expect(done).toBe(false);expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    await vi.advanceTimersByTimeAsync(1000);expect(await result).toBe(false);expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });
});
describe("automatic freshness and explicit refresh",()=>{
  it("recognizes missing/malformed/stale/future catalogs and one-hour freshness",()=>{
    expect(hasFreshCodexCatalog()).toBe(false);writeFileSync(shared.path,"bad");expect(hasFreshCodexCatalog()).toBe(false);
    cache(new Date(Date.now()-3_600_001).toISOString());expect(hasFreshCodexCatalog()).toBe(false);cache(new Date(Date.now()+120000).toISOString());expect(hasFreshCodexCatalog()).toBe(false);cache();expect(hasFreshCodexCatalog()).toBe(true);
  });
  it("does not spawn for a fresh automatic read, but explicit refresh shares one process across tabs",async()=>{
    const {refreshCodexModels}=await import("./codex-model-refresh.js");cache();expect(await refreshCodexModels()).toBe("ok");expect(shared.spawn).not.toHaveBeenCalled();
    const child=responding(()=>cache());shared.spawn.mockReturnValue(child);
    expect(await Promise.all(Array.from({length:10},()=>refreshCodexModels(true)))).toEqual(Array(10).fill("ok"));expect(shared.spawn).toHaveBeenCalledTimes(1);
    expect(shared.spawn.mock.calls[0][2].env.CODEX_HOME).toBe("/trusted/account-home");
    expect(await refreshCodexModels(true)).toBe("ok");expect(shared.spawn).toHaveBeenCalledTimes(1);
  });
  it("refreshes stale data automatically and preserves old bytes on failed protocol/CLI attempts",async()=>{
    const {refreshCodexModels}=await import("./codex-model-refresh.js");cache(new Date(Date.now()-7200000).toISOString());const before=readFileSync(shared.path,"utf8");
    shared.spawn.mockImplementation(()=>{throw new Error("private");});expect(await refreshCodexModels()).toBe("unavailable");expect(await refreshCodexModels(true)).toBe("unavailable");expect(shared.spawn).toHaveBeenCalledTimes(1);expect(readFileSync(shared.path,"utf8")).toBe(before);
  });
  it("retries after the cooldown and accepts only a fresh CLI-owned cache",async()=>{
    vi.useFakeTimers();const {refreshCodexModels}=await import("./codex-model-refresh.js");cache(new Date(Date.now()-7200000).toISOString());shared.spawn.mockReturnValue(responding());expect(await refreshCodexModels()).toBe("unavailable");
    await vi.advanceTimersByTimeAsync(60_001);shared.spawn.mockReturnValue(responding(()=>cache()));expect(await refreshCodexModels()).toBe("ok");expect(shared.spawn).toHaveBeenCalledTimes(2);
  });
});

// The installed CLI emits this unsolicited status between initialize and model/list.
it("accepts the recorded informational startup notification before the model response",async()=>{
 const notification=readFileSync(new URL("./__fixtures__/model-catalog-refresh/startup-notification.jsonl",import.meta.url),"utf8");
 const child=new Child((f,c)=>queueMicrotask(()=>{
  if(f.method==="initialize")c.stdout.write('{"id":1,"result":{"userAgent":"fixture"}}\n');
  if(f.method==="model/list")c.stdout.write(notification+replay);
 }));
 expect(await probeCodexCatalog("/trusted/codex",{},spawned(child))).toBe(true);
});
