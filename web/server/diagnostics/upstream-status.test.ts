// Tests for the upstream health record behind the Diagnostics Usage card (AC3).
//
// What is validated: `since` is the true onset (kept across repeated failures
// of the same kind, reset when the kind changes); a success clears the
// failure; and the classifiers map the Cloudflare quota shapes (429, or 500
// with "error code: 1101") to kv-quota and fetch errors to timeout/network.

import { describe, expect, it } from "vitest";
import { classifyFetchError, classifyStatsHttpFailure, UpstreamTracker } from "./upstream-status.js";

describe("UpstreamTracker", () => {
  it("keeps the onset across repeats and resets it when the failure kind changes", () => {
    let t = 100;
    const tr = new UpstreamTracker(() => t);
    expect(tr.view()).toEqual({ ok: false, lastOkAt: null, failure: null });
    tr.recordOk();
    t = 200;
    tr.recordFailure("kv-quota", 429);
    t = 300;
    tr.recordFailure("kv-quota", 429);
    expect(tr.view()).toEqual({ ok: false, lastOkAt: 100, failure: { kind: "kv-quota", httpStatus: 429, since: 200 } });
    t = 400;
    tr.recordFailure("network");
    expect(tr.view().failure).toEqual({ kind: "network", since: 400 });
    t = 500;
    tr.recordOk();
    expect(tr.view()).toEqual({ ok: true, lastOkAt: 500, failure: null });
  });
});

describe("classifiers", () => {
  it("maps Cloudflare quota shapes to kv-quota", () => {
    expect(classifyStatsHttpFailure(429, "")).toBe("kv-quota");
    expect(classifyStatsHttpFailure(500, "error code: 1101")).toBe("kv-quota");
    expect(classifyStatsHttpFailure(500, "boom")).toBe("http");
    expect(classifyStatsHttpFailure(404, "")).toBe("http");
  });

  it("maps fetch errors to timeout / parse / network", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(classifyFetchError(abort)).toBe("timeout");
    expect(classifyFetchError(new SyntaxError("bad json"))).toBe("parse");
    expect(classifyFetchError(new TypeError("fetch failed"))).toBe("network");
  });
});
