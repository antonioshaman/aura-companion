// Verifies that SessionStore.saveSync reports its FULL synchronous cost —
// including the secret-redaction walk — to the event-loop lag monitor.
//
// Context (2026-10 prod): ~10k `server.event_loop_lag` warnings in 48h showed
// `topOperations=session-store.save=33ms` next to `untrackedMs=8067`. The
// redaction walk ran OUTSIDE the `trackSync("session-store.save")` wrapper,
// so its multi-second cost was invisible to the monitor and looked like
// "something untracked". The save is now tracked end-to-end.
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A fake monotonic clock shared by the monitor and the mocked redactor, so a
// "slow" redaction is deterministic instead of a real busy-wait.
const clock = vi.hoisted(() => ({ now: 0 }));
const REDACTION_COST_MS = 5_000;

vi.mock("./secret-redaction.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./secret-redaction.js")>();
  return {
    ...actual,
    redactStructured: <T,>(value: T): T => {
      clock.now += REDACTION_COST_MS; // simulate an expensive walk
      return actual.redactStructured(value);
    },
  };
});

import {
  installEventLoopLagMonitor,
  __resetEventLoopLagMonitorForTests,
  type EventLoopLagReport,
} from "./event-loop-lag-monitor.js";
import { SessionStore, CURRENT_SESSION_SCHEMA_VERSION, type PersistedSession } from "./session-store.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ss-lag-"));
  clock.now = 0;
});

afterEach(() => {
  __resetEventLoopLagMonitorForTests();
  rmSync(dir, { recursive: true, force: true });
});

describe("SessionStore.saveSync lag tracking", () => {
  it("attributes redaction time to session-store.save, not to untracked time", () => {
    const reports: EventLoopLagReport[] = [];
    const monitor = installEventLoopLagMonitor({
      now: () => clock.now,
      setIntervalFn: () => ({}), // driven manually via tick()
      clearIntervalFn: () => {},
      onLag: (r) => reports.push(r),
    });

    const store = new SessionStore(dir);
    store.saveSync({
      schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
      id: "s1",
      state: { session_id: "s1", cwd: "/test" } as PersistedSession["state"],
      messageHistory: [{ type: "user_message", content: "hi", timestamp: 1 }] as PersistedSession["messageHistory"],
      pendingMessages: [],
      pendingPermissions: [],
    } as PersistedSession);

    monitor.tick();
    expect(reports).toHaveLength(1);
    const save = reports[0].topOperations.find((op) => op.label === "session-store.save");
    // The whole redaction cost is inside the tracked save.
    expect(save?.durationMs).toBeGreaterThanOrEqual(REDACTION_COST_MS);
  });
});
