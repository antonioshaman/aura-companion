import { describe, expect, it } from "vitest";
import { assertKbArchiveAvailable, KbArchiveUnavailableError, KB_ARCHIVE_UNAVAILABLE } from "./archive-availability.js";
// Real guard, no mocks: production has no switch that can silently permit a rewrite.
describe("KB archive availability", () => {
  it("fails closed with a specific reason", () => {
    expect(assertKbArchiveAvailable).toThrow(KbArchiveUnavailableError);
    expect(assertKbArchiveAvailable).toThrow(KB_ARCHIVE_UNAVAILABLE);
  });
});
