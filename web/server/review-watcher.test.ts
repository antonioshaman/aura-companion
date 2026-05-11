import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { watchReviews, type ReviewDropReason } from "./review-watcher.js";
import { writeAtomicJson } from "./atomic-write.js";
import { COUNCIL_SCHEMA_VERSION, type ObserverReviewPayload } from "./council-types.js";

function validReview(overrides: Partial<ObserverReviewPayload> = {}): ObserverReviewPayload {
  return {
    schema_version: COUNCIL_SCHEMA_VERSION,
    checkpoint_id: "chk-1",
    phase: "council-plan",
    session_group_id: "grp_abc",
    reviewed_at: "2026-05-11T10:00:00Z",
    observer_provider: "codex",
    observer_model: "gpt-5-codex",
    observer_cli_version: "1.4.0",
    findings: [
      { severity: "STOP", claim: "test", evidence_path: "src/foo.ts" },
    ],
    ...overrides,
  };
}

describe("watchReviews", () => {
  let dir: string;
  let controller: AbortController;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rev-watcher-"));
    controller = new AbortController();
  });

  afterEach(() => {
    controller.abort();
    rmSync(dir, { recursive: true, force: true });
  });

  // Happy path: a well-formed review file lands → parsed payload emitted.
  it("emits a validated review payload when a well-formed file appears", async () => {
    const seen: ObserverReviewPayload[] = [];
    const watchPromise = watchReviews({
      directory: dir,
      signal: controller.signal,
      onReview: (p) => { seen.push(p); },
    });
    // Atomic write so the watcher sees rename, not partial.
    writeAtomicJson(join(dir, "council-plan-observer.md"), validReview());
    // Allow the debounce window + handler to settle.
    await new Promise((r) => setTimeout(r, 300));
    controller.abort();
    await watchPromise;
    expect(seen).toHaveLength(1);
    expect(seen[0]?.checkpoint_id).toBe("chk-1");
    expect(seen[0]?.observer_provider).toBe("codex");
  });

  // Invalid filename: missing -observer.md suffix or NUL/etc. → onDropped fires.
  it("drops files with an invalid filename pattern", async () => {
    const onDropped = vi.fn<(r: ReviewDropReason, f: string, d?: string) => void>();
    const seen: ObserverReviewPayload[] = [];
    const watchPromise = watchReviews({
      directory: dir,
      signal: controller.signal,
      onReview: (p) => { seen.push(p); },
      onDropped,
    });
    writeFileSync(join(dir, "wrong-name.md"), JSON.stringify(validReview()));
    await new Promise((r) => setTimeout(r, 250));
    controller.abort();
    await watchPromise;
    expect(seen).toHaveLength(0);
    expect(onDropped).toHaveBeenCalledWith("invalid-filename", "wrong-name.md");
  });

  // Schema invalid: file matches the name pattern but content is malformed.
  it("drops files whose content fails parseObserverReviewPayload", async () => {
    const onDropped = vi.fn<(r: ReviewDropReason, f: string, d?: string) => void>();
    const watchPromise = watchReviews({
      directory: dir,
      signal: controller.signal,
      onReview: vi.fn(),
      onDropped,
    });
    writeFileSync(join(dir, "council-plan-observer.md"), "not-json{");
    await new Promise((r) => setTimeout(r, 250));
    controller.abort();
    await watchPromise;
    expect(onDropped).toHaveBeenCalledWith("invalid-schema", "council-plan-observer.md");
  });

  // Dedup: the same (checkpoint_id, observer_provider) is emitted once even
  // if the file is re-written. The dedup key allows the same checkpoint
  // reviewed by a DIFFERENT provider to land separately.
  it("dedups by (checkpoint_id, observer_provider)", async () => {
    const seen: ObserverReviewPayload[] = [];
    const onDropped = vi.fn<(r: ReviewDropReason, f: string, d?: string) => void>();
    const watchPromise = watchReviews({
      directory: dir,
      signal: controller.signal,
      onReview: (p) => { seen.push(p); },
      onDropped,
    });
    writeAtomicJson(join(dir, "phase-a-observer.md"), validReview({ checkpoint_id: "chk-A" }));
    await new Promise((r) => setTimeout(r, 250));
    // Re-emit same review (e.g. observer reconnect).
    writeAtomicJson(join(dir, "phase-a-observer.md"), validReview({ checkpoint_id: "chk-A" }));
    await new Promise((r) => setTimeout(r, 250));
    // A different review (different checkpoint) — must land.
    writeAtomicJson(join(dir, "phase-b-observer.md"), validReview({ checkpoint_id: "chk-B" }));
    await new Promise((r) => setTimeout(r, 250));
    controller.abort();
    await watchPromise;
    expect(seen.map((r) => r.checkpoint_id)).toEqual(["chk-A", "chk-B"]);
    expect(onDropped).toHaveBeenCalledWith("duplicate-review", "phase-a-observer.md", expect.stringContaining("chk-A"));
  });

  // Handler throw: the watcher does NOT propagate; it logs via onDropped.
  it("catches a thrown handler and drops the event without killing the watcher", async () => {
    const onDropped = vi.fn<(r: ReviewDropReason, f: string, d?: string) => void>();
    const watchPromise = watchReviews({
      directory: dir,
      signal: controller.signal,
      onReview: () => { throw new Error("handler boom"); },
      onDropped,
    });
    writeAtomicJson(join(dir, "phase-x-observer.md"), validReview({ checkpoint_id: "chk-X" }));
    await new Promise((r) => setTimeout(r, 250));
    controller.abort();
    await watchPromise;
    expect(onDropped).toHaveBeenCalledWith("handler-error", "phase-x-observer.md", expect.stringContaining("handler boom"));
  });
});
