/**
 * Codex provider evidence registry (task 11): the newest provider answer wins,
 * an older one arriving late never overwrites it. The probe-side acceptance
 * rules (fingerprint match, 5-min TTL, EC-38 future-dated) live in
 * provider-probes.test.ts.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  _resetCodexProviderEvidenceForTests,
  latestCodexProviderEvidence,
  recordCodexProviderEvidence,
} from "./codex-provider-evidence.js";

afterEach(() => _resetCodexProviderEvidenceForTests());

describe("codex provider evidence", () => {
  it("is empty until a session records an answer", () => {
    expect(latestCodexProviderEvidence()).toBeNull();
  });

  it("keeps the newest answer", () => {
    recordCodexProviderEvidence({ checkedAt: 2000, credentialFingerprint: "fp-b" });
    recordCodexProviderEvidence({ checkedAt: 1000, credentialFingerprint: "fp-a" });
    expect(latestCodexProviderEvidence()).toEqual({ checkedAt: 2000, credentialFingerprint: "fp-b" });
    recordCodexProviderEvidence({ checkedAt: 3000, credentialFingerprint: "fp-c" });
    expect(latestCodexProviderEvidence()?.credentialFingerprint).toBe("fp-c");
  });
});
