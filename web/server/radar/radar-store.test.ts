import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RadarStore, emptyRadar } from "./radar-store.js";
import { evaluateFindings } from "./radar-evaluator.js";
const dirs: string[] = [];
function fixture() { const dir = mkdtempSync(join(tmpdir(), "radar-")); dirs.push(dir); return join(dir, "state.json"); }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
describe("durable Radar decisions", () => {
  // A new store instance models a server restart; no real home files are touched.
  it("preserves implemented/dismissed decisions across restart and restores them", () => {
    const path = fixture(); const store = new RadarStore(path); const s = emptyRadar();
    s.ideas = evaluateFindings([{ repo: "openai/codex", title: "", url: "https://github.com/openai/codex", publishedAt: null, topics: [] }]);
    store.write(s); store.decide(s.ideas[0].id, "implemented");
    expect(new RadarStore(path).read().decisions[s.ideas[0].id]).toBe("implemented");
    store.decide(s.ideas[0].id, "restore"); expect(store.read().decisions).toEqual({});
    expect(() => store.decide("../../bad", "dismissed")).toThrow();
  });
  it("never erases a corrupt store on read failure", () => {
    const path = fixture(); writeFileSync(path, "broken");
    expect(() => new RadarStore(path).read()).toThrow(); expect(readFileSync(path, "utf8")).toBe("broken");
  });
});

// HUNT-1: the persistence boundary also rejects untyped callers before writing.
it("rejects invalid runtime decisions at the store boundary", () => {
  const path=fixture(); const store=new RadarStore(path); const s=emptyRadar();
  s.ideas=evaluateFindings([{repo:"openai/codex",title:"",url:"https://github.com/openai/codex",publishedAt:null,topics:[]}]);store.write(s);
  const before=readFileSync(path,"utf8");
  expect(()=>store.decide(s.ideas[0].id, ["implemented"] as unknown as "implemented")).toThrow();
  expect(readFileSync(path,"utf8")).toBe(before);
});
