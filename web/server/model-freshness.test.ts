import { afterEach, describe, expect, it, vi } from "vitest";
import { modelFreshness, installedCliVersion } from "./model-freshness.js";
describe("account-catalog freshness", () => {
  // Same clock and inputs for both providers; announcements never become model ids.
  it.each(["claude", "codex"] as const)("distinguishes all cache states for %s", backend => {
    const now = Date.parse("2026-11-26T00:00:00Z");
    expect(modelFreshness({ present: true, valid: true, fetchedAt: now - 1000 }, backend, now).status).toBe("fresh");
    expect(modelFreshness({ present: true, valid: true, fetchedAt: now - 2 * 86400000 }, backend, now).status).toBe("stale");
    expect(modelFreshness({ present: false, valid: false, fetchedAt: null }, backend, now).status).toBe("missing");
    expect(modelFreshness({ present: true, valid: false, fetchedAt: null }, backend, now).status).toBe("malformed");
    expect(modelFreshness({ present: true, valid: true, fetchedAt: "bad" }, backend, now).status).toBe("stale");
    expect(modelFreshness({ present: true, valid: true, fetchedAt: now + 86400000 }, backend, now).fetchedAt).toBeNull();
  });
  it("does not equate absent API key with absent CLI subscription", () => {
    expect(modelFreshness({ present: false, valid: false, fetchedAt: null, keyConfigured: false }, "claude").status).toBe("no-key");
  });
});

// Version observation is a fixed, bounded subprocess; no model launch or installation.
vi.mock("./path-resolver.js", () => ({ resolveBinary: (backend: string) => backend === "claude" ? null : "/trusted/codex" }));
const { probe }=vi.hoisted(()=>({probe:vi.fn()}));
vi.mock("node:child_process",()=>({execFile:probe}));
afterEach(()=>{vi.useRealTimers();probe.mockReset();});
it("observes fixed CLI version and handles absent executables",async()=>{
 probe.mockImplementation((_file,_args,_opts,cb)=>cb(null,"codex-cli fixture\n"));
 expect(await installedCliVersion("codex")).toBe("codex-cli fixture");expect(await installedCliVersion("claude")).toBeNull();
 expect(probe).toHaveBeenCalledWith("/trusted/codex",["--version"],expect.objectContaining({timeout:2000,maxBuffer:4096,encoding:"utf8"}),expect.any(Function));
});
// HUNT-2: concurrent identical metadata reads share bounded observation, including cached failures.
it("shares in-flight CLI probes and expires their short cache",async()=>{
 vi.useFakeTimers();vi.resetModules();const {installedCliVersion:observe}=await import("./model-freshness.js");
 let complete!:(e:Error|null,s:string)=>void;probe.mockImplementation((_f,_a,_o,cb)=>{complete=cb;});
 const pending=Array.from({length:20},()=>observe("codex"));expect(probe).toHaveBeenCalledTimes(1);complete(null,"codex-cli current");
 expect(await Promise.all(pending)).toEqual(Array(20).fill("codex-cli current"));expect(await observe("codex")).toBe("codex-cli current");expect(probe).toHaveBeenCalledTimes(1);
 await vi.advanceTimersByTimeAsync(60_001);const expired=observe("codex");expect(probe).toHaveBeenCalledTimes(2);complete(new Error("failed"),"");expect(await expired).toBeNull();expect(await observe("codex")).toBeNull();expect(probe).toHaveBeenCalledTimes(2);
});
// BECK-2: probe failures and response bounds are observable process contracts.
it("returns unknown on probe errors and bounds oversized observations",async()=>{
 vi.resetModules();let observe=(await import("./model-freshness.js")).installedCliVersion;
 probe.mockImplementation((_f,_a,_o,cb)=>cb(new Error("output limit exceeded"),"x".repeat(5000)));expect(await observe("codex")).toBeNull();
 vi.resetModules();observe=(await import("./model-freshness.js")).installedCliVersion;
 probe.mockImplementation((_f,_a,_o,cb)=>cb(null,"x".repeat(5000)));expect((await observe("codex"))?.length).toBe(100);
});
