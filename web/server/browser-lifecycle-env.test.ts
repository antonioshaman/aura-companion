import { describe, expect, it } from "vitest";
import { browserLifecycleEnv } from "./browser-lifecycle-env.js";

describe("session-owned browser lifetime", () => {
  it("isolates and identifies a host session's browser without an idle deadline", () => {
    expect(browserLifecycleEnv("session-one", {}, {}, false, "linux")).toEqual({
      AGENT_BROWSER_SESSION: "aura-session-one", AGENT_BROWSER_IDLE_TIMEOUT_MS: "0",
      AURA_BROWSER_SESSION_ID: "session-one",
    });
    expect(browserLifecycleEnv("session-two", {}, {}, false, "linux").AGENT_BROWSER_SESSION).toBe("aura-session-two");
  });

  it("uses the service operator's configured timeout", () => {
    expect(browserLifecycleEnv("session-one", {}, { AURA_BROWSER_SESSION_IDLE_TIMEOUT_MS: "1800000" }, false, "linux")
      .AGENT_BROWSER_IDLE_TIMEOUT_MS).toBe("1800000");
  });

  it.each(["0", "900000", undefined])("preserves the session override %s, including explicit unset", (value) => {
    expect(browserLifecycleEnv("session-one", { AGENT_BROWSER_IDLE_TIMEOUT_MS: value }, {}, false, "linux")
      .AGENT_BROWSER_IDLE_TIMEOUT_MS).toBe(value);
  });

  it("does not alter unrelated environment overrides or mutate its inputs", () => {
    const overrides = { CUSTOM: "value", STALE_AUTH: undefined };
    const inherited = { OTHER_SECRET: "not-forwarded" };
    expect(browserLifecycleEnv("session-one", overrides, inherited, false, "linux")).toEqual({
      AGENT_BROWSER_SESSION: "aura-session-one", AURA_BROWSER_SESSION_ID: "session-one",
      AGENT_BROWSER_IDLE_TIMEOUT_MS: "0", CUSTOM: "value", STALE_AUTH: undefined,
    });
    expect(overrides).toEqual({ CUSTOM: "value", STALE_AUTH: undefined });
    expect(inherited).toEqual({ OTHER_SECRET: "not-forwarded" });
  });

  it.each(["darwin", "win32"] as const)("keeps %s host browsers bounded: the host cleaner only reads Linux /proc", (platform) => {
    // The archive-driven cleanup proves ownership via /proc, so on other
    // platforms an unbounded browser would never be closed.
    expect(browserLifecycleEnv("session-one", {}, {}, false, platform).AGENT_BROWSER_IDLE_TIMEOUT_MS).toBe("3600000");
    expect(browserLifecycleEnv("session-one", {}, { AGENT_BROWSER_IDLE_TIMEOUT_MS: "60000" }, false, platform)
      .AGENT_BROWSER_IDLE_TIMEOUT_MS).toBe("60000");
  });

  it("keeps container browsers bounded because host cleanup cannot inspect their sockets", () => {
    expect(browserLifecycleEnv("session-one", {}, {}, true).AGENT_BROWSER_IDLE_TIMEOUT_MS).toBe("3600000");
  });

  it("preserves custom browser names but prevents spoofing another owning session", () => {
    expect(browserLifecycleEnv("session-one", { AGENT_BROWSER_SESSION: "custom", AURA_BROWSER_SESSION_ID: "other" }, {}, false, "linux"))
      .toMatchObject({ AGENT_BROWSER_SESSION: "custom", AURA_BROWSER_SESSION_ID: "session-one" });
  });
});
