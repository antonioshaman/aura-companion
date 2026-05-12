import { describe, expect, it } from "vitest";
import {
  CLAUDE_BACKEND,
  CODEX_BACKEND,
  SUPPORTED_PAIRINGS,
  getBackend,
  isSupportedPairing,
} from "./backend-provider.js";

describe("getBackend", () => {
  it("returns the Claude backend descriptor for 'claude'", () => {
    expect(getBackend("claude")).toBe(CLAUDE_BACKEND);
  });

  it("returns the Codex backend descriptor for 'codex'", () => {
    expect(getBackend("codex")).toBe(CODEX_BACKEND);
  });
});

describe("isSupportedPairing", () => {
  // claude+claude is the zero-friction default — must be supported even
  // when Codex is unavailable on the host.
  it("accepts claude+claude (default)", () => {
    expect(isSupportedPairing("claude", "claude")).toBe(true);
  });

  // claude+codex is the experimental cross-family pairing — the whole
  // value-prop of "independent review" depends on this being supported.
  it("accepts claude+codex (experimental)", () => {
    expect(isSupportedPairing("claude", "codex")).toBe(true);
  });

  // Hunt: an attacker who sends `codex+claude` or `codex+codex` from the
  // browser must be rejected. The allow-list is the server-side guard.
  it.each<[string, string]>([
    ["codex", "claude"],
    ["codex", "codex"],
  ])("rejects unsupported pairing %s+%s", (a, b) => {
    expect(isSupportedPairing(a as "claude", b as "claude")).toBe(false);
  });
});

describe("SUPPORTED_PAIRINGS", () => {
  it("marks the cross-family pairing experimental and the same-family default not", () => {
    const same = SUPPORTED_PAIRINGS.find((p) => p.primary === "claude" && p.observer === "claude");
    const cross = SUPPORTED_PAIRINGS.find((p) => p.primary === "claude" && p.observer === "codex");
    expect(same?.experimental).toBe(false);
    expect(cross?.experimental).toBe(true);
  });

  it("is frozen — runtime cannot mutate the allow-list", () => {
    expect(Object.isFrozen(SUPPORTED_PAIRINGS)).toBe(true);
  });
});
