import { describe, expect, it } from "vitest";
import { IntentionalKills } from "./intentional-kills.js";

// P4/FIX-AUTOHEAL-1 item 3: a relaunch's own intentional mark is transient;
// any plain `add` (archive, delete, user kill, group teardown) makes it
// durable, and the relaunch's release must then leave it in place (EC-2).
describe("IntentionalKills", () => {
  it("a transient mark is released by its owner", () => {
    const k = new IntentionalKills();
    expect(k.addTransient("s1")).toBe(true);
    expect(k.has("s1")).toBe(true);
    expect(k.isTransient("s1")).toBe(true);
    k.releaseTransient("s1");
    expect(k.has("s1")).toBe(false);
  });

  it("a plain add during the relaunch makes the mark durable — release leaves it", () => {
    const k = new IntentionalKills();
    k.addTransient("s1");
    k.add("s1");
    k.releaseTransient("s1");
    expect(k.has("s1")).toBe(true);
    expect(k.isTransient("s1")).toBe(false);
  });

  it("a pre-existing mark is not owned: addTransient returns false and stays durable", () => {
    const k = new IntentionalKills();
    k.add("s1");
    expect(k.addTransient("s1")).toBe(false);
    k.releaseTransient("s1");
    expect(k.has("s1")).toBe(true);
  });

  it("delete and clear drop transient ownership too; it still behaves as a Set", () => {
    const k = new IntentionalKills();
    k.addTransient("a");
    k.delete("a");
    k.add("a"); // a later durable mark must not be released by the stale owner
    k.releaseTransient("a");
    expect(k.has("a")).toBe(true);
    k.addTransient("b");
    k.clear();
    expect(k.size).toBe(0);
    expect(k.isTransient("b")).toBe(false);
    expect(k instanceof Set).toBe(true);
  });
});
