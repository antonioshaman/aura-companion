import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  reapStrandedTerminals,
  type TerminalReaperDeps,
} from "./terminal-orphan-reaper.js";
import type { ProcessIdentityResult } from "./process-identity.js";
import {
  getCleanupEventCountLastHour,
  __resetCleanupCountersForTests,
} from "./cleanup/cleanup-events.js";
import {
  argvSha256,
  type TerminalSidecarPayload,
  type TerminalSidecarResult,
} from "./terminal-runtime-sidecar.js";

// The terminal reaper enumerates sidecars (NOT /proc — a PTY shell carries no
// identifying argv token) and acts per the identity verdict:
//   match → SIGTERM the stranded terminal + delete sidecar
//   gone → prune the stale sidecar, no kill
//   mismatch → pid reused → prune sidecar, no kill
// These tests drive each branch with injected stubs so no real process is
// signalled and the pass is deterministic.

const ROOT = "/tmp/fake-terminals-root";
const SENTINEL = "/tmp/fake-sentinel-root";

function payload(overrides: Partial<TerminalSidecarPayload> = {}): TerminalSidecarPayload {
  return {
    schemaVersion: 1,
    terminalId: "term-1",
    pid: 4321,
    processStartMs: 1_700_000_000_000,
    argvSha256: argvSha256(["/bin/bash", "-l"]),
    kind: "host",
    ...overrides,
  };
}

function present(p: TerminalSidecarPayload): TerminalSidecarResult {
  return { kind: "present", payload: p };
}

/** Build deps with sensible Linux defaults; override per-test. */
function makeDeps(overrides: Partial<TerminalReaperDeps> = {}): TerminalReaperDeps {
  return {
    terminalsRoot: ROOT,
    sentinelRoot: SENTINEL,
    platform: () => "linux",
    now: () => 1_000, // frozen clock — every pass is well within budget
    sleep: () => Promise.resolve(),
    listSidecarIds: () => [],
    readSidecar: () => ({ kind: "absent" }),
    deleteSidecar: vi.fn(),
    writeMarker: vi.fn(),
    deleteMarker: vi.fn(),
    killCheck: () => false, // default: process exits immediately after SIGTERM
    kill: vi.fn(),
    verify: () => ({ kind: "gone" }) as ProcessIdentityResult,
    ...overrides,
  };
}

describe("reapStrandedTerminals — verdict branches", () => {
  // match → the terminal is alive and provably ours → SIGTERM + sentinel +
  // sidecar deletion. This is the core leak-closing path.
  it("reaps a stranded terminal on a match verdict", async () => {
    const p = payload();
    const kill = vi.fn();
    const writeMarker = vi.fn();
    const deleteMarker = vi.fn();
    const deleteSidecar = vi.fn();
    const deps = makeDeps({
      listSidecarIds: () => [p.terminalId],
      readSidecar: () => present(p),
      verify: () => ({ kind: "match" }),
      kill,
      writeMarker,
      deleteMarker,
      deleteSidecar,
    });

    const summary = await reapStrandedTerminals(deps);

    expect(summary.reaped).toBe(1);
    expect(writeMarker).toHaveBeenCalledWith(SENTINEL, p.pid, expect.objectContaining({ pid: p.pid }));
    expect(kill).toHaveBeenCalledWith(p.pid, "SIGTERM");
    expect(deleteSidecar).toHaveBeenCalledWith(ROOT, p.terminalId);
    expect(deleteMarker).toHaveBeenCalledWith(SENTINEL, p.pid);
  });

  // EC-8 (sentinel-before-sweep) is an ORDER invariant, not an end-state one:
  // the `.reaping/<pid>.json` crash-recovery marker MUST be persisted BEFORE
  // the SIGTERM, so a crash mid-reap leaves a record. Asserting only that both
  // were "called" lets a refactor that moves the write past the kill pass green
  // and silently reintroduces the state-loss EC-8 closes. Pin the order.
  it("writes the sentinel marker BEFORE issuing SIGTERM (EC-8 ordering)", async () => {
    const p = payload();
    const kill = vi.fn();
    const writeMarker = vi.fn();
    const deps = makeDeps({
      listSidecarIds: () => [p.terminalId],
      readSidecar: () => present(p),
      verify: () => ({ kind: "match" }),
      kill,
      writeMarker,
    });

    await reapStrandedTerminals(deps);

    expect(writeMarker).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledTimes(1);
    // invocationCallOrder is a global monotonic counter across all vi mocks.
    expect(writeMarker.mock.invocationCallOrder[0]).toBeLessThan(
      kill.mock.invocationCallOrder[0],
    );
  });

  // The safety arm of EC-8: if the sentinel can't be persisted, the reaper must
  // NOT SIGTERM (a kill with no crash-recovery record is the exact failure the
  // sentinel prevents). The sidecar is left intact for the next pass.
  it("aborts the SIGTERM when the sentinel write fails", async () => {
    const p = payload();
    const kill = vi.fn();
    const deleteSidecar = vi.fn();
    const deps = makeDeps({
      listSidecarIds: () => [p.terminalId],
      readSidecar: () => present(p),
      verify: () => ({ kind: "match" }),
      writeMarker: () => {
        throw Object.assign(new Error("EROFS"), { code: "EROFS" });
      },
      kill,
      deleteSidecar,
    });

    const summary = await reapStrandedTerminals(deps);

    expect(kill).not.toHaveBeenCalled();
    expect(summary.reaped).toBe(0);
    // Sidecar preserved — the stranded terminal is retried next pass.
    expect(deleteSidecar).not.toHaveBeenCalled();
  });

  // "Never throws" contract: one terminal whose sidecar prune throws a
  // non-ENOENT errno must NOT abort the pass — the next terminal is still
  // processed. Without the per-terminal try/catch this rejected the whole
  // reconcile and (detached via `void`) crashed the process at boot.
  it("isolates a throwing prune so the rest of the pass still runs", async () => {
    const bad = payload({ terminalId: "term-bad", pid: 1111 });
    const good = payload({ terminalId: "term-good", pid: 2222 });
    const kill = vi.fn();
    const deleteSidecar = vi.fn((_root: string, id: string) => {
      if (id === "term-bad") {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      }
    });
    const deps = makeDeps({
      listSidecarIds: () => [bad.terminalId, good.terminalId],
      readSidecar: (_root, id) => present(id === "term-bad" ? bad : good),
      // both verdict `gone` → prune path (the unguarded deleteOne site)
      verify: () => ({ kind: "gone" }),
      kill,
      deleteSidecar,
    });

    // Must resolve, never reject.
    const summary = await reapStrandedTerminals(deps);

    // The good terminal was still pruned despite the bad one throwing.
    expect(deleteSidecar).toHaveBeenCalledWith(ROOT, "term-good");
    expect(summary.prunedGone).toBe(1);
    expect(kill).not.toHaveBeenCalled();
  });

  // gone → the process already exited; prune the stale provenance, never kill.
  it("prunes the sidecar without killing on a gone verdict", async () => {
    const p = payload();
    const kill = vi.fn();
    const writeMarker = vi.fn();
    const deleteSidecar = vi.fn();
    const deps = makeDeps({
      listSidecarIds: () => [p.terminalId],
      readSidecar: () => present(p),
      verify: () => ({ kind: "gone" }),
      kill,
      writeMarker,
      deleteSidecar,
    });

    const summary = await reapStrandedTerminals(deps);

    expect(summary.prunedGone).toBe(1);
    expect(summary.reaped).toBe(0);
    expect(kill).not.toHaveBeenCalled();
    expect(writeMarker).not.toHaveBeenCalled();
    expect(deleteSidecar).toHaveBeenCalledWith(ROOT, p.terminalId);
  });

  // mismatch → the pid is alive but belongs to an unrelated process (PID
  // reuse). Killing it would hit a bystander → prune sidecar, never kill.
  it("prunes the stale sidecar without killing on a mismatch verdict", async () => {
    const p = payload();
    const kill = vi.fn();
    const deleteSidecar = vi.fn();
    const deps = makeDeps({
      listSidecarIds: () => [p.terminalId],
      readSidecar: () => present(p),
      verify: () => ({ kind: "mismatch", reason: "starttime" }),
      kill,
      deleteSidecar,
    });

    const summary = await reapStrandedTerminals(deps);

    expect(summary.prunedReused).toBe(1);
    expect(kill).not.toHaveBeenCalled();
    expect(deleteSidecar).toHaveBeenCalledWith(ROOT, p.terminalId);
  });

  // A terminal the running server still owns must NOT be reaped — its
  // in-memory orphanTimer covers it. This is the guard that makes the reaper
  // safe to run as a periodic reconcile, not just at boot.
  it("skips terminals the current process still tracks", async () => {
    const p = payload();
    const verify = vi.fn();
    const deps = makeDeps({
      listSidecarIds: () => [p.terminalId],
      readSidecar: () => present(p),
      isLocallyTracked: (id) => id === p.terminalId,
      verify,
    });

    const summary = await reapStrandedTerminals(deps);

    expect(summary.skippedTracked).toBe(1);
    expect(summary.scannedSidecars).toBe(0);
    expect(verify).not.toHaveBeenCalled();
  });

  // The argv predicate passed to verify must recompute the hash from the live
  // tokens and compare to the stored anchor — that is the FLAG A generalized
  // factor 2. Assert the predicate accepts the matching argv and rejects others.
  it("builds an argv predicate that matches the stored argvSha256", async () => {
    const p = payload({ argvSha256: argvSha256(["/bin/zsh", "-l"]) });
    let captured: ((tokens: string[]) => boolean) | null = null;
    const deps = makeDeps({
      listSidecarIds: () => [p.terminalId],
      readSidecar: () => present(p),
      verify: (_pid, argvMatches) => {
        captured = argvMatches;
        return { kind: "gone" };
      },
    });

    await reapStrandedTerminals(deps);

    expect(captured).not.toBeNull();
    expect(captured!(["/bin/zsh", "-l"])).toBe(true);
    expect(captured!(["/bin/bash", "-l"])).toBe(false);
  });

  // ESRCH on SIGTERM (the process exited between verify and kill) is still an
  // effective reap — count it and prune the sidecar.
  it("treats ESRCH on SIGTERM as an effective reap", async () => {
    const p = payload();
    const deleteSidecar = vi.fn();
    const deps = makeDeps({
      listSidecarIds: () => [p.terminalId],
      readSidecar: () => present(p),
      verify: () => ({ kind: "match" }),
      kill: () => {
        const err = new Error("no such process") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      },
      deleteSidecar,
    });

    const summary = await reapStrandedTerminals(deps);

    expect(summary.reaped).toBe(1);
    expect(summary.killFailed).toBe(0);
    expect(deleteSidecar).toHaveBeenCalledWith(ROOT, p.terminalId);
  });

  // EPERM (or any non-ESRCH error) means the process SURVIVES but the error is
  // DETERMINISTIC — retrying every pass forever just churns WARN noise while the
  // sidecar never clears. So it is NOT counted as reaped, but the stale sidecar
  // IS pruned (loud WARN, no infinite retry) and handed to the operator.
  it("prunes the sidecar on a deterministic EPERM SIGTERM failure (no infinite retry)", async () => {
    const p = payload();
    const deleteSidecar = vi.fn();
    const deps = makeDeps({
      listSidecarIds: () => [p.terminalId],
      readSidecar: () => present(p),
      verify: () => ({ kind: "match" }),
      kill: () => {
        const err = new Error("operation not permitted") as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      },
      deleteSidecar,
    });

    const summary = await reapStrandedTerminals(deps);

    expect(summary.reaped).toBe(0);
    expect(summary.killFailed).toBe(1);
    // Pruned — the unsignalable sidecar must not be retried daily forever.
    expect(deleteSidecar).toHaveBeenCalledWith(ROOT, p.terminalId);
  });

  // Non-Linux dev host → the whole pass is a no-op; sidecars are never touched.
  it("is a no-op on non-Linux", async () => {
    const verify = vi.fn();
    const deps = makeDeps({
      platform: () => "darwin",
      listSidecarIds: () => ["term-1"],
      readSidecar: () => present(payload()),
      verify,
    });

    const summary = await reapStrandedTerminals(deps);

    expect(summary.platform).toBe("darwin");
    expect(summary.scannedSidecars).toBe(0);
    expect(verify).not.toHaveBeenCalled();
  });

  // A docker terminal's sentinel reason carries the kind so the reap log
  // distinguishes host vs host-side docker-exec-client kills (FLAG B). The
  // FLAG B design claim is "SAME kill path for both kinds; kind only colours
  // the sentinel reason" — so assert the docker terminal is actually SIGTERMed
  // and reaped, not just that the label survived (a no-kill docker branch must
  // not pass this test).
  it("stamps the docker kind into the sentinel reason AND reaps via the same kill path", async () => {
    const p = payload({ kind: "docker", terminalId: "docker-term" });
    const writeMarker = vi.fn();
    const kill = vi.fn();
    const deps = makeDeps({
      listSidecarIds: () => [p.terminalId],
      readSidecar: () => present(p),
      verify: () => ({ kind: "match" }),
      writeMarker,
      kill,
    });

    const summary = await reapStrandedTerminals(deps);

    expect(writeMarker).toHaveBeenCalledWith(
      SENTINEL,
      p.pid,
      expect.objectContaining({ reason: "terminal_docker" }),
    );
    // Same kill path as host: the host-side docker-exec client IS SIGTERMed.
    expect(kill).toHaveBeenCalledWith(p.pid, "SIGTERM");
    expect(summary.reaped).toBe(1);
  });

  // A corrupt-but-present sidecar throws on read — skip it (cannot trust its
  // pid to drive a kill) and surface it in the summary.
  it("skips a sidecar whose read throws", async () => {
    const kill = vi.fn();
    const deps = makeDeps({
      listSidecarIds: () => ["corrupt"],
      readSidecar: () => {
        throw new Error("malformed JSON");
      },
      kill,
    });

    const summary = await reapStrandedTerminals(deps);

    expect(summary.skippedUnreadable).toBe(1);
    expect(kill).not.toHaveBeenCalled();
  });
});

describe("reapStrandedTerminals — grace + budget guards", () => {
  // P2 #4: the documented AURA_TERMINAL_ORPHAN_GRACE_SECONDS knob means "don't
  // reap a browserless PTY younger than N seconds". A matched-but-young terminal
  // (process age < minReapAgeMs) is deferred a pass — NOT killed — and its
  // sidecar is kept so a later pass can reap it once it ages past the grace.
  it("defers a matched terminal younger than the grace window", async () => {
    const p = payload({ processStartMs: 9_000 }); // age = now(10_000) - 9_000 = 1_000ms
    const kill = vi.fn();
    const deleteSidecar = vi.fn();
    const writeMarker = vi.fn();
    const deps = makeDeps({
      now: () => 10_000,
      minReapAgeMs: 5_000, // 1_000ms old < 5_000ms grace → too young
      listSidecarIds: () => [p.terminalId],
      readSidecar: () => present(p),
      verify: () => ({ kind: "match" }),
      kill,
      deleteSidecar,
      writeMarker,
    });

    const summary = await reapStrandedTerminals(deps);

    expect(summary.skippedYoung).toBe(1);
    expect(summary.reaped).toBe(0);
    expect(kill).not.toHaveBeenCalled();
    // Neither the sentinel nor the sidecar is touched — retried next pass.
    expect(writeMarker).not.toHaveBeenCalled();
    expect(deleteSidecar).not.toHaveBeenCalled();
  });

  // The other side of the grace gate: a terminal OLDER than the grace window is
  // reaped normally. Proves the guard defers only the young, not every match.
  it("reaps a matched terminal older than the grace window", async () => {
    const p = payload({ processStartMs: 1_000 }); // age = 10_000 - 1_000 = 9_000ms
    const kill = vi.fn();
    const deps = makeDeps({
      now: () => 10_000,
      minReapAgeMs: 5_000, // 9_000ms old > 5_000ms grace → reap
      listSidecarIds: () => [p.terminalId],
      readSidecar: () => present(p),
      verify: () => ({ kind: "match" }),
      kill,
    });

    const summary = await reapStrandedTerminals(deps);

    expect(summary.skippedYoung).toBe(0);
    expect(summary.reaped).toBe(1);
    expect(kill).toHaveBeenCalledWith(p.pid, "SIGTERM");
  });

  // P2 #8: a `match` blocks up to REAP_POST_TERM_GRACE_MS (1_500ms) waiting for
  // the SIGTERMed process to exit. Admitting one when less than that remains in
  // the pass budget would overrun the systemd readiness window. With a budget of
  // 1_000ms (< the 1_500ms tail), the very first match is deferred — no kill —
  // and budgetExceeded is flagged so the next pass picks it up.
  it("defers a reap whose post-SIGTERM tail would overrun the pass budget", async () => {
    const p = payload({ processStartMs: 1_000 });
    const kill = vi.fn();
    const writeMarker = vi.fn();
    const deps = makeDeps({
      now: () => 10_000, // frozen → elapsed is 0, so the 1_500ms tail vs 1_000ms budget decides
      budgetMs: 1_000,
      listSidecarIds: () => [p.terminalId],
      readSidecar: () => present(p),
      verify: () => ({ kind: "match" }),
      kill,
      writeMarker,
    });

    const summary = await reapStrandedTerminals(deps);

    expect(summary.budgetExceeded).toBe(true);
    expect(summary.reaped).toBe(0);
    expect(kill).not.toHaveBeenCalled();
    expect(writeMarker).not.toHaveBeenCalled();
  });
});

describe("reapStrandedTerminals — metrics emit (T8)", () => {
  // EC-21: a successful reap records exactly one `terminal_reaped` cleanup
  // event in the shared store, which the `getTerminalReapedLastHour`
  // projection reads. Verdicts that do NOT kill (gone/mismatch) must NOT
  // emit — only an actual reap counts.
  beforeEach(() => {
    __resetCleanupCountersForTests();
  });

  it("records one terminal_reaped event per actual reap", async () => {
    const p = payload();
    const deps = makeDeps({
      listSidecarIds: () => [p.terminalId],
      readSidecar: () => present(p),
      verify: () => ({ kind: "match" }),
    });

    await reapStrandedTerminals(deps);

    expect(getCleanupEventCountLastHour("terminal_reaped")).toBe(1);
  });

  it("does not record a terminal_reaped event for a gone/mismatch prune", async () => {
    const p = payload();
    const deps = makeDeps({
      listSidecarIds: () => [p.terminalId],
      readSidecar: () => present(p),
      verify: () => ({ kind: "mismatch", reason: "argv" }),
    });

    await reapStrandedTerminals(deps);

    expect(getCleanupEventCountLastHour("terminal_reaped")).toBe(0);
  });
});

describe("terminal-orphan-reaper — security hardening canary (T10)", () => {
  // Hunt Principle 1: reaping is a privileged loop; it must signal PIDs
  // through the structured `process.kill` syscall ONLY — never shell out
  // to `pkill` / `exec` / a `shell:true` spawn where a crafted argv could
  // inject a command. This source-grep canary fails the build if any such
  // primitive ever appears in the reaper module, even via a future refactor
  // that "just needs to run one command".
  const reaperSrc = (() => {
    const here = dirname(fileURLToPath(import.meta.url));
    return readFileSync(join(here, "terminal-orphan-reaper.ts"), "utf8");
  })();

  // Strip line + block comments so the `NEVER pkill` documentation in
  // `defaultKill` doesn't trip the canary — we only care about live code.
  const codeOnly = reaperSrc
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");

  it.each(["pkill", "execSync", "exec(", "shell:", "shell :", "Bun.spawn", "child_process"])(
    "does not invoke the shell primitive '%s'",
    (primitive) => {
      expect(codeOnly).not.toContain(primitive);
    },
  );
});
