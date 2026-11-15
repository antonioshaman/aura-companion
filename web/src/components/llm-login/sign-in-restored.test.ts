// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Sign-in restored" selector + its one-per-page status read (phase 2c,
 * task 12; S3-AC1/AC4). The card is restored only when the SAME provider's
 * last promotion came AFTER the failure, and only for sign-in failures —
 * a failed / cancelled sign-in moves no promotion time, so cards stay.
 */

const mocks = vi.hoisted(() => ({ llmAuthStatus: vi.fn() }));
vi.mock("../../api.js", () => ({ api: mocks }));

import { _resetPromotedAtLoaderForTest, ensurePromotedAtLoaded, isSignInRestored, notePromotedFromStatus } from "./sign-in-restored.js";
import { useStore } from "../../store.js";
import { statusSnapshot } from "../diagnostics/llm-auth-fixtures.js";
import { TURN_FAILURE_KINDS, type TurnFailure } from "../../../server/auth-status/auth-types.js";

const failure = (over: Partial<TurnFailure> = {}): TurnFailure => ({ kind: "auth_rejected", provider: "claude", providerMessage: "401", ...over });

beforeEach(() => {
  useStore.getState().reset();
  mocks.llmAuthStatus.mockReset();
  _resetPromotedAtLoaderForTest();
});

describe("isSignInRestored", () => {
  it("restored only when the same provider was promoted after the failure fired", () => {
    expect(isSignInRestored(failure(), 100, { claude: 200 })).toBe(true);
    expect(isSignInRestored(failure(), 200, { claude: 200 })).toBe(false); // not strictly after
    expect(isSignInRestored(failure(), 300, { claude: 200 })).toBe(false); // failed on the new sign-in
    expect(isSignInRestored(failure(), 100, { codex: 200 })).toBe(false); // other provider
    expect(isSignInRestored(failure(), 100, {})).toBe(false); // no promotion (failed / cancelled sign-in)
  });

  it("only sign-in failures can be restored", () => {
    const restorable = TURN_FAILURE_KINDS.filter((kind) => isSignInRestored(failure({ kind }), 1, { claude: 2 }));
    expect(restorable.sort()).toEqual(["auth_rejected", "stale_session_credentials"]);
  });
});

describe("promotedAt from the status", () => {
  it("notePromotedFromStatus copies lastPromotedAt per provider", () => {
    notePromotedFromStatus(statusSnapshot({ lastPromotedAt: 500 }, { lastPromotedAt: null }));
    expect(useStore.getState().llmAuthPromotedAt).toEqual({ claude: 500 });
    notePromotedFromStatus(null);
    expect(useStore.getState().llmAuthPromotedAt).toEqual({ claude: 500 });
  });

  it("ensurePromotedAtLoaded reads the status once per page; a failure is retried", async () => {
    mocks.llmAuthStatus.mockRejectedValueOnce(new Error("down")).mockResolvedValue({ status: statusSnapshot({}, { lastPromotedAt: 9 }) });
    await ensurePromotedAtLoaded();
    expect(useStore.getState().llmAuthPromotedAt).toEqual({});
    await ensurePromotedAtLoaded();
    await ensurePromotedAtLoaded();
    expect(mocks.llmAuthStatus).toHaveBeenCalledTimes(2);
    expect(useStore.getState().llmAuthPromotedAt).toEqual({ codex: 9 });
  });
});
