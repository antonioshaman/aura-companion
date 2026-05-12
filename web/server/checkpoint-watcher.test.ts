import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeAtomicJson } from "./atomic-write.js";
import { watchCheckpoints } from "./checkpoint-watcher.js";
import { COUNCIL_SCHEMA_VERSION, type CheckpointPayload } from "./council-types.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "watcher-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makePayload(overrides: Partial<CheckpointPayload> = {}): CheckpointPayload {
  return {
    schema_version: COUNCIL_SCHEMA_VERSION,
    checkpoint_id: "chk-1",
    phase: "plan",
    sequence: 0,
    session_group_id: "grp-1",
    emitted_at: "2026-05-11T10:00:00.000Z",
    artifact_paths: ["foo.md"],
    ...overrides,
  };
}

/** Poll a predicate until true or the timeout elapses. fs.watch is async +
 *  platform-specific so we cannot synchronously assert "the event fired". */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("timeout waiting for predicate");
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("watchCheckpoints", () => {
  // Happy path round-trip — proves the atomic-write + watcher contract works
  // end-to-end without partial-read races on the typical platform.
  it("emits a validated payload when a checkpoint is written atomically", async () => {
    const ac = new AbortController();
    const seen: CheckpointPayload[] = [];
    const watcherDone = watchCheckpoints({
      directory: dir,
      signal: ac.signal,
      onCheckpoint: (p) => {
        seen.push(p);
      },
    });
    // Give the watcher a moment to initialise — fs.watch is async.
    await new Promise((r) => setTimeout(r, 50));
    writeAtomicJson(join(dir, "plan.json"), makePayload());
    await waitFor(() => seen.length > 0);
    expect(seen[0]?.checkpoint_id).toBe("chk-1");
    ac.abort();
    await watcherDone;
  });

  // Hunt P2: malformed JSON must not crash the handler. The watcher logs
  // through onDropped and continues; the orchestrator chat is never told.
  it("drops invalid JSON via the onDropped hook", async () => {
    const ac = new AbortController();
    const dropped: string[] = [];
    const emitted: CheckpointPayload[] = [];
    const watcherDone = watchCheckpoints({
      directory: dir,
      signal: ac.signal,
      onCheckpoint: (p) => {
        emitted.push(p);
      },
      onDropped: (reason) => {
        dropped.push(reason);
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    writeFileSync(join(dir, "bad.json"), "not-json{");
    await waitFor(() => dropped.length > 0);
    expect(dropped[0]).toMatch(/invalid-schema/);
    expect(emitted).toHaveLength(0);
    ac.abort();
    await watcherDone;
  });

  // The writer's `.tmp` staging files must never trigger the handler —
  // otherwise we'd see partial JSON on every atomic write.
  it("ignores .tmp staging files", async () => {
    const ac = new AbortController();
    const seen: CheckpointPayload[] = [];
    const dropped: string[] = [];
    const watcherDone = watchCheckpoints({
      directory: dir,
      signal: ac.signal,
      onCheckpoint: (p) => {
        seen.push(p);
      },
      onDropped: (r) => {
        dropped.push(r);
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    writeFileSync(join(dir, ".abc.tmp"), "anything");
    await new Promise((r) => setTimeout(r, 250));
    expect(seen).toHaveLength(0);
    expect(dropped).toHaveLength(0);
    ac.abort();
    await watcherDone;
  });

  // Clean shutdown — aborting before any event must not throw. This is the
  // common case during normal session lifecycle teardown.
  it("resolves cleanly when signal is aborted before any event", async () => {
    const ac = new AbortController();
    const watcherDone = watchCheckpoints({
      directory: dir,
      signal: ac.signal,
      onCheckpoint: () => {},
    });
    setTimeout(() => ac.abort(), 50);
    await expect(watcherDone).resolves.toBeUndefined();
  });

  // Idempotency: a handler exception must not break subsequent events.
  // Drop the throwing event via onDropped and keep listening. Distinct
  // checkpoint_ids so the dedup LRU doesn't swallow the second event.
  it("drops events whose handler throws and continues processing", async () => {
    const ac = new AbortController();
    const dropped: string[] = [];
    let calls = 0;
    const watcherDone = watchCheckpoints({
      directory: dir,
      signal: ac.signal,
      onCheckpoint: () => {
        calls++;
        if (calls === 1) throw new Error("boom");
      },
      onDropped: (reason) => {
        dropped.push(reason);
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    writeAtomicJson(join(dir, "plan.json"), makePayload({ checkpoint_id: "chk-a" }));
    await waitFor(() => dropped.length > 0);
    // Second checkpoint with a DIFFERENT id (dedup is by checkpoint_id).
    writeAtomicJson(join(dir, "plan.json"), makePayload({ checkpoint_id: "chk-b" }));
    await waitFor(() => calls >= 2);
    expect(dropped[0]).toMatch(/handler-error/);
    ac.abort();
    await watcherDone;
  });

  // Realtime F4 / Persistence F5: the watcher's documented dedup contract.
  // Re-emitting the same checkpoint_id (idempotent orchestrator retry)
  // must drop on the second event, not double-invoke the handler.
  it("drops duplicate checkpoint_id events without re-invoking the handler", async () => {
    const ac = new AbortController();
    const seen: string[] = [];
    const dropped: string[] = [];
    const watcherDone = watchCheckpoints({
      directory: dir,
      signal: ac.signal,
      onCheckpoint: (p) => {
        seen.push(p.checkpoint_id);
      },
      onDropped: (reason) => {
        dropped.push(reason);
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    writeAtomicJson(join(dir, "plan.json"), makePayload({ checkpoint_id: "chk-same" }));
    await waitFor(() => seen.length >= 1);
    // Force a fresh FS event by writing the same payload to a different
    // filename (debounce is per-filename, so this exercises the dedup
    // path that lives downstream of the debounce).
    writeAtomicJson(join(dir, "plan-retry.json"), makePayload({ checkpoint_id: "chk-same" }));
    await waitFor(() => dropped.some((r) => r === "duplicate-checkpoint-id"));
    expect(seen).toEqual(["chk-same"]);
    ac.abort();
    await watcherDone;
  });
});
