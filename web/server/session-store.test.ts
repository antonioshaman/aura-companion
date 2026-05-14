import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionStore, migrateLegacyTmpdirSessions, type PersistedSession } from "./session-store.js";

let tempDir: string;
let store: SessionStore;

function makeSession(id: string, overrides: Partial<PersistedSession> = {}): PersistedSession {
  return {
    id,
    state: {
      session_id: id,
      model: "claude-sonnet-4-6",
      cwd: "/test",
      tools: [],
      permissionMode: "default",
      claude_code_version: "1.0.0",
      mcp_servers: [],
      agents: [],
      slash_commands: [],
      skills: [],
      total_cost_usd: 0,
      num_turns: 0,
      context_used_percent: 0,
      is_compacting: false,
      git_branch: "",
      is_worktree: false,
      is_containerized: false,
      repo_root: "",
      git_ahead: 0,
      git_behind: 0,
      total_lines_added: 0,
      total_lines_removed: 0,
    },
    messageHistory: [],
    pendingMessages: [],
    pendingPermissions: [],
    ...overrides,
  };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "ss-test-"));
  store = new SessionStore(tempDir);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ─── saveSync / load ──────────────────────────────────────────────────────────

describe("saveSync / load", () => {
  it("writes a session to disk and reads it back", () => {
    const session = makeSession("s1");
    store.saveSync(session);

    const filePath = join(tempDir, "s1.json");
    expect(existsSync(filePath)).toBe(true);

    const loaded = store.load("s1");
    expect(loaded).toEqual(session);
  });

  it("returns null for a non-existent session", () => {
    const loaded = store.load("does-not-exist");
    expect(loaded).toBeNull();
  });

  it("returns null for a corrupt JSON file", () => {
    writeFileSync(join(tempDir, "corrupt.json"), "{{not valid json!!", "utf-8");
    const loaded = store.load("corrupt");
    expect(loaded).toBeNull();
  });

  it("preserves all session fields through round-trip", () => {
    const session = makeSession("s2", {
      messageHistory: [{ type: "error", message: "test error" }],
      pendingMessages: ["msg1", "msg2"],
      pendingPermissions: [
        [
          "req-1",
          {
            request_id: "req-1",
            tool_name: "Write",
            input: { path: "/tmp/test.txt" },
            tool_use_id: "tu-1",
            timestamp: Date.now(),
          },
        ],
      ],
      eventBuffer: [
        { seq: 1, message: { type: "cli_connected" } },
      ],
      nextEventSeq: 2,
      lastAckSeq: 1,
      processedClientMessageIds: ["client-msg-1", "client-msg-2"],
      archived: true,
    });

    store.saveSync(session);
    const loaded = store.load("s2");
    expect(loaded).toEqual(session);
    expect(loaded!.archived).toBe(true);
    expect(loaded!.pendingPermissions).toHaveLength(1);
    expect(loaded!.pendingMessages).toEqual(["msg1", "msg2"]);
    expect(loaded!.eventBuffer).toEqual([{ seq: 1, message: { type: "cli_connected" } }]);
    expect(loaded!.nextEventSeq).toBe(2);
    expect(loaded!.lastAckSeq).toBe(1);
    expect(loaded!.processedClientMessageIds).toEqual(["client-msg-1", "client-msg-2"]);
  });
});

// ─── save (debounced) ─────────────────────────────────────────────────────────

describe("save (debounced)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not write immediately", () => {
    const session = makeSession("debounce-1");
    store.save(session);

    const filePath = join(tempDir, "debounce-1.json");
    expect(existsSync(filePath)).toBe(false);
  });

  it("writes after the 150ms debounce period", () => {
    const session = makeSession("debounce-2");
    store.save(session);

    vi.advanceTimersByTime(150);

    const filePath = join(tempDir, "debounce-2.json");
    expect(existsSync(filePath)).toBe(true);

    const loaded = store.load("debounce-2");
    expect(loaded).toEqual(session);
  });

  it("coalesces rapid calls and only writes the last version", () => {
    const session1 = makeSession("debounce-3", {
      pendingMessages: ["first"],
    });
    const session2 = makeSession("debounce-3", {
      pendingMessages: ["second"],
    });
    const session3 = makeSession("debounce-3", {
      pendingMessages: ["third"],
    });

    store.save(session1);
    vi.advanceTimersByTime(50);
    store.save(session2);
    vi.advanceTimersByTime(50);
    store.save(session3);

    // Not yet written (timer restarted with session3)
    expect(existsSync(join(tempDir, "debounce-3.json"))).toBe(false);

    vi.advanceTimersByTime(150);

    const loaded = store.load("debounce-3");
    expect(loaded!.pendingMessages).toEqual(["third"]);
  });
});

// ─── loadAll ──────────────────────────────────────────────────────────────────

describe("loadAll", () => {
  it("returns all saved sessions", () => {
    store.saveSync(makeSession("a"));
    store.saveSync(makeSession("b"));
    store.saveSync(makeSession("c"));

    const all = store.loadAll();
    const ids = all.map((s) => s.id).sort();
    expect(ids).toEqual(["a", "b", "c"]);
  });

  it("skips corrupt JSON files", () => {
    store.saveSync(makeSession("good"));
    writeFileSync(join(tempDir, "bad.json"), "not-json!", "utf-8");

    const all = store.loadAll();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe("good");
  });

  it("excludes launcher.json from results", () => {
    store.saveSync(makeSession("session-1"));
    store.saveLauncher({ some: "launcher data" });

    const all = store.loadAll();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe("session-1");
  });

  it("returns an empty array for an empty directory", () => {
    const all = store.loadAll();
    expect(all).toEqual([]);
  });
});

// ─── setArchived ──────────────────────────────────────────────────────────────

describe("setArchived", () => {
  it("sets archived flag to true and persists it", () => {
    store.saveSync(makeSession("arch-1"));
    const result = store.setArchived("arch-1", true);

    expect(result).toBe(true);

    const loaded = store.load("arch-1");
    expect(loaded!.archived).toBe(true);
  });

  it("sets archived flag to false and persists it", () => {
    store.saveSync(makeSession("arch-2", { archived: true }));
    const result = store.setArchived("arch-2", false);

    expect(result).toBe(true);

    const loaded = store.load("arch-2");
    expect(loaded!.archived).toBe(false);
  });

  it("returns false for a non-existent session", () => {
    const result = store.setArchived("no-such-session", true);
    expect(result).toBe(false);
  });
});

// ─── remove ───────────────────────────────────────────────────────────────────

describe("remove", () => {
  it("deletes the session file from disk", () => {
    store.saveSync(makeSession("rm-1"));
    expect(existsSync(join(tempDir, "rm-1.json"))).toBe(true);

    store.remove("rm-1");
    expect(existsSync(join(tempDir, "rm-1.json"))).toBe(false);
    expect(store.load("rm-1")).toBeNull();
  });

  it("cancels a pending debounced save so it never writes", () => {
    vi.useFakeTimers();
    try {
      const session = makeSession("rm-2");
      store.save(session);

      // Remove before the debounce fires
      store.remove("rm-2");

      // Advance past the debounce window
      vi.advanceTimersByTime(300);

      expect(existsSync(join(tempDir, "rm-2.json"))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not throw when removing a non-existent session", () => {
    expect(() => store.remove("ghost-session")).not.toThrow();
  });
});

// ─── saveLauncher / loadLauncher ──────────────────────────────────────────────

describe("saveLauncher / loadLauncher", () => {
  it("writes and reads launcher data", () => {
    const data = { pids: [123, 456], lastBoot: "2025-01-01T00:00:00Z" };
    store.saveLauncher(data);

    const loaded = store.loadLauncher<{ pids: number[]; lastBoot: string }>();
    expect(loaded).toEqual(data);
  });

  it("returns null when no launcher file exists", () => {
    const loaded = store.loadLauncher();
    expect(loaded).toBeNull();
  });
});

// ─── migrateLegacyTmpdirSessions (PLAN Task 12-iii) ───────────────────────

describe("migrateLegacyTmpdirSessions", () => {
  let legacyDir: string;
  let newDir: string;
  let logs: { warn: string[]; info: string[] };
  let logger: { warn: (msg: string) => void; info: (msg: string) => void };

  beforeEach(() => {
    legacyDir = mkdtempSync(join(tmpdir(), "migrate-legacy-"));
    newDir = mkdtempSync(join(tmpdir(), "migrate-new-"));
    // The migration tests use an empty target dir to exercise the
    // happy-path copy. `mkdtempSync` creates the dir; remove it so the
    // populated-target guard tests are deterministic.
    rmSync(newDir, { recursive: true, force: true });
    logs = { warn: [], info: [] };
    logger = {
      warn: (msg) => logs.warn.push(msg),
      info: (msg) => logs.info.push(msg),
    };
  });

  afterEach(() => {
    rmSync(legacyDir, { recursive: true, force: true });
    rmSync(newDir, { recursive: true, force: true });
  });

  function writeSessionJson(dir: string, id: string): void {
    writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, messageHistory: [] }), "utf-8");
  }

  it("skips with no_source when the legacy directory does not exist", () => {
    // Fresh install path — no `$TMPDIR/vibe-sessions/` ever existed,
    // migration must be a silent no-op so the boot log isn't polluted.
    rmSync(legacyDir, { recursive: true, force: true });
    const outcome = migrateLegacyTmpdirSessions(legacyDir, newDir, logger);
    expect(outcome.ran).toBe(false);
    expect(outcome.skippedReason).toBe("no_source");
    expect(outcome.copied).toBe(0);
    expect(existsSync(newDir)).toBe(false);
  });

  it("skips with no_source when legacy directory exists but is empty", () => {
    // `/tmp/vibe-sessions/` may be created by another version then
    // emptied; we must not flag a zero-file copy as a real migration.
    const outcome = migrateLegacyTmpdirSessions(legacyDir, newDir, logger);
    expect(outcome.ran).toBe(false);
    expect(outcome.skippedReason).toBe("no_source");
  });

  it("copies session JSONs from legacy to new directory", () => {
    writeSessionJson(legacyDir, "session-A");
    writeSessionJson(legacyDir, "session-B");
    const outcome = migrateLegacyTmpdirSessions(legacyDir, newDir, logger);

    expect(outcome.ran).toBe(true);
    expect(outcome.copied).toBe(2);
    expect(outcome.failed).toBe(0);
    expect(outcome.launcherCopied).toBe(false);
    expect(outcome.skippedReason).toBeUndefined();

    expect(existsSync(join(newDir, "session-A.json"))).toBe(true);
    expect(existsSync(join(newDir, "session-B.json"))).toBe(true);
    // Source preserved for rollback.
    expect(existsSync(join(legacyDir, "session-A.json"))).toBe(true);
    expect(existsSync(join(legacyDir, "session-B.json"))).toBe(true);
  });

  it("flags the launcher.json sidecar separately so it doesn't inflate the session count", () => {
    // launcher.json carries the CLI PID map, not a session — counting it
    // as a session would inflate the migration log and hide a zero-session
    // case where only the sidecar is present.
    writeSessionJson(legacyDir, "session-1");
    writeFileSync(join(legacyDir, "launcher.json"), JSON.stringify({ pids: [1234] }), "utf-8");
    const outcome = migrateLegacyTmpdirSessions(legacyDir, newDir, logger);

    expect(outcome.copied).toBe(1);
    expect(outcome.launcherCopied).toBe(true);
    expect(existsSync(join(newDir, "launcher.json"))).toBe(true);
  });

  it("skips with target_already_populated when new directory already has session JSONs", () => {
    // Idempotency — re-running migration after first successful copy
    // must not overwrite live state in the new dir with stale tmpdir
    // copies.
    writeSessionJson(legacyDir, "session-1");
    mkdirSync(newDir, { recursive: true });
    writeSessionJson(newDir, "session-1");
    const outcome = migrateLegacyTmpdirSessions(legacyDir, newDir, logger);
    expect(outcome.ran).toBe(false);
    expect(outcome.skippedReason).toBe("target_already_populated");
    // Target preserved — not clobbered.
    expect(existsSync(join(newDir, "session-1.json"))).toBe(true);
  });

  it("treats a target containing ONLY launcher.json as still empty (migrates real sessions in)", () => {
    // Rare but legal interleaving: launcher.json may be written by
    // another process before the first session is persisted. Empty
    // sessions + launcher.json present must still allow migration in.
    writeSessionJson(legacyDir, "session-X");
    mkdirSync(newDir, { recursive: true });
    writeFileSync(join(newDir, "launcher.json"), JSON.stringify({}), "utf-8");
    const outcome = migrateLegacyTmpdirSessions(legacyDir, newDir, logger);
    expect(outcome.ran).toBe(true);
    expect(outcome.copied).toBe(1);
  });

  it("never deletes source files (rollback contract)", () => {
    writeSessionJson(legacyDir, "session-keep");
    migrateLegacyTmpdirSessions(legacyDir, newDir, logger);
    // Source must remain readable after migration so rolling back to
    // the pre-Task-12 binary continues to find the data.
    const remaining = readdirSync(legacyDir);
    expect(remaining).toContain("session-keep.json");
  });

  it("ignores non-JSON files in source (defensive)", () => {
    // Stray text files in `$TMPDIR/vibe-sessions/` (editor lockfiles,
    // tmp scratch) must not abort migration or get carried into the new
    // dir.
    writeSessionJson(legacyDir, "real");
    writeFileSync(join(legacyDir, "scratch.tmp"), "garbage", "utf-8");
    const outcome = migrateLegacyTmpdirSessions(legacyDir, newDir, logger);
    expect(outcome.copied).toBe(1);
    expect(existsSync(join(newDir, "scratch.tmp"))).toBe(false);
  });
});
