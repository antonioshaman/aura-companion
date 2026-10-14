import { describe, expect, it } from "vitest";
import type { SdkSessionInfo } from "../types.js";
import { decideRestoreBounce, isReloadNavigation, type ArmedRestore } from "./restore-bounce.js";

// Review 2026-10-14-2248 #2/#9: the archived auto-restore bounce as a pure
// decision. Every edge the App effect relies on is pinned here.

const sdk = (sessionId: string, extra: Partial<SdkSessionInfo> = {}): SdkSessionInfo =>
  ({ sessionId, state: "exited", cwd: "/repo", createdAt: 1, ...extra }) as SdkSessionInfo;
const onS1 = { page: "session" as const, sessionId: "s1" };
const armedSeen: ArmedRestore = { sessionId: "s1", sawSessionRoute: true };
const armedFresh: ArmedRestore = { sessionId: "s1", sawSessionRoute: false };

describe("decideRestoreBounce", () => {
  it("waits while the server list has not landed, even if a local seed filled sdkSessions", () => {
    // `sdkSessions.length > 0` was the old sentinel; a HomePage seed defeated it.
    expect(decideRestoreBounce(armedSeen, onS1, [sdk("s1", { archived: true })], false)).toEqual({
      kind: "wait",
      armed: armedSeen,
    });
  });

  it("bounces an archived restored session once the list is loaded", () => {
    expect(decideRestoreBounce(armedSeen, onS1, [sdk("s1", { archived: true })], true)).toEqual({ kind: "settle", bounce: true });
  });

  it("keeps an exited-but-not-archived session (a message resumes it)", () => {
    expect(decideRestoreBounce(armedSeen, onS1, [sdk("s1", { state: "exited" })], true)).toEqual({ kind: "settle", bounce: false });
  });

  it("settles without bouncing when the restored id is unknown to the server (disarms instead of re-scanning every poll)", () => {
    expect(decideRestoreBounce(armedSeen, onS1, [sdk("other")], true)).toEqual({ kind: "settle", bounce: false });
  });

  it("a loaded but empty server list settles too (zero sessions is a real answer)", () => {
    expect(decideRestoreBounce(armedSeen, onS1, [], true)).toEqual({ kind: "settle", bounce: false });
  });

  it("disarms when the user navigated elsewhere before the list landed", () => {
    expect(decideRestoreBounce(armedSeen, { page: "home" }, [], false)).toEqual({ kind: "settle", bounce: false });
    expect(decideRestoreBounce(armedSeen, { page: "session", sessionId: "s2" }, [sdk("s1", { archived: true })], true)).toEqual({
      kind: "settle",
      bounce: false,
    });
  });

  it("hash-less restore: the still-home route right after arming is not 'moved away'", () => {
    // The restore arms, then navigateToSession lands a render later.
    expect(decideRestoreBounce(armedFresh, { page: "home" }, [], false)).toEqual({ kind: "wait", armed: armedFresh });
    // Once the session route shows, it is remembered…
    expect(decideRestoreBounce(armedFresh, onS1, [], false)).toEqual({ kind: "wait", armed: armedSeen });
    // …and an archived verdict still bounces even if the route never changed (mocked routing).
    expect(decideRestoreBounce(armedFresh, { page: "home" }, [sdk("s1", { archived: true })], true)).toEqual({
      kind: "settle",
      bounce: true,
    });
  });
});

describe("isReloadNavigation", () => {
  const perf = (type: string | null) => ({
    getEntriesByType: () => (type === null ? [] : [{ type } as unknown as PerformanceEntry]),
  });

  it("true only for a reload navigation entry", () => {
    expect(isReloadNavigation(perf("reload"))).toBe(true);
    expect(isReloadNavigation(perf("navigate"))).toBe(false); // pasted / followed deep link
    expect(isReloadNavigation(perf("back_forward"))).toBe(false);
    expect(isReloadNavigation(perf(null))).toBe(false);
  });

  it("false when the Performance API is missing or throws", () => {
    expect(isReloadNavigation(undefined)).toBe(false);
    expect(isReloadNavigation({ getEntriesByType: () => { throw new Error("nope"); } })).toBe(false);
  });
});
