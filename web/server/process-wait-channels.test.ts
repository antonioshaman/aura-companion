import { describe, expect, it } from "vitest";
import { summarizeWaitChannels, type WaitChannelFs } from "./process-wait-channels.js";

// summarizeWaitChannels feeds `cliWaitChannels` on silent_stdio_drift.detected.
// The value decides the open P7/SERVER-STDOUT-STALL question (bun stopped
// reading vs CLI stopped writing), so the summary must be stable and must
// never throw from inside the drift tick.

/** In-memory /proc: { "<pid>": { "<tid>": "<wchan>" } }. */
function fakeProc(tree: Record<string, Record<string, string>>): WaitChannelFs {
  return {
    readdir: (p) => {
      const m = p.match(/^\/proc\/(\d+)\/task$/);
      const tasks = m ? tree[m[1]] : undefined;
      if (!tasks) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return Object.keys(tasks);
    },
    readFile: (p) => {
      const m = p.match(/^\/proc\/(\d+)\/task\/(\d+)\/wchan$/);
      const v = m ? tree[m[1]]?.[m[2]] : undefined;
      if (v === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return v;
    },
  };
}

describe("summarizeWaitChannels", () => {
  it("counts threads per wait channel, most frequent first, ties by name", () => {
    const fs = fakeProc({
      "42": { "42": "ep_poll", "43": "futex_wait_queue", "44": "futex_wait_queue", "45": "pipe_write", "46": "0" },
    });
    // "0" is how the kernel shows a running/runnable thread.
    expect(summarizeWaitChannels(42, { fs })).toBe("futex_wait_queue×2, ep_poll×1, pipe_write×1, running×1");
  });

  it("returns null for a dead process, a bad pid, or no readable threads", () => {
    const fs = fakeProc({ "7": {} });
    expect(summarizeWaitChannels(99, { fs })).toBeNull(); // no such pid
    expect(summarizeWaitChannels(0, { fs })).toBeNull();
    expect(summarizeWaitChannels(-1, { fs })).toBeNull();
    expect(summarizeWaitChannels(1.5, { fs })).toBeNull();
    expect(summarizeWaitChannels(7, { fs })).toBeNull(); // no threads
  });

  it("skips a thread that exits between readdir and read, and ignores non-numeric entries", () => {
    const base = fakeProc({ "5": { "5": "ep_poll" } });
    const fs: WaitChannelFs = { readdir: () => ["5", "6", "self"], readFile: base.readFile };
    expect(summarizeWaitChannels(5, { fs })).toBe("ep_poll×1");
  });

  it("caps the number of threads read", () => {
    const tasks: Record<string, string> = {};
    for (let i = 1; i <= 10; i++) tasks[String(i)] = "ep_poll";
    expect(summarizeWaitChannels(3, { fs: fakeProc({ "3": tasks }), maxTasks: 4 })).toBe("ep_poll×4");
  });

  it.skipIf(process.platform !== "linux")("reads the real /proc for this process", () => {
    expect(summarizeWaitChannels(process.pid)).toMatch(/^[\w.]+×\d+(, [\w.]+×\d+)*$/);
  });
});
