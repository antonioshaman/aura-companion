import { describe, expect, it } from "vitest";
import {
  MAX_TOUCHES_PER_WAKE,
  ObserverReadLedger,
  countArtifactsRead,
  extractToolTouches,
  touchesReachBeyondArtifacts,
  type ObserverToolTouch,
} from "./observer-read-ledger.js";

// P3/CONV-HONEST: the convergence counter only folds a clean review when the
// HOST saw the observer read ≥1 changed file of the checkpoint. These tests
// pin what "read" means for both providers (Claude tool_use blocks; Codex
// commandExecution items mapped to `Bash`) and that the ledger is scoped to
// the checkpoint whose wake was dispatched.

const ROOT = "/work/repo";

function assistant(...blocks: unknown[]) {
  return { type: "assistant", message: { model: "m", content: blocks } };
}
function toolUse(name: string, input: Record<string, unknown>) {
  return { type: "tool_use", id: `t_${name}`, name, input };
}

describe("extractToolTouches", () => {
  it("pulls name + path/command from tool_use blocks and ignores text/tool_result", () => {
    const touches = extractToolTouches(assistant(
      { type: "text", text: "looking" },
      toolUse("Read", { file_path: "src/a.ts" }),
      toolUse("Grep", { pattern: "x", path: "src/b.ts" }),
      toolUse("Bash", { command: "cat src/c.ts" }),
      { type: "tool_result", tool_use_id: "t", content: "src/d.ts" },
    ));
    expect(touches).toEqual([
      { name: "Read", path: "src/a.ts" },
      { name: "Grep", path: "src/b.ts" },
      { name: "Bash", command: "cat src/c.ts" },
    ]);
  });

  it("returns [] for non-assistant frames and malformed content", () => {
    expect(extractToolTouches(null)).toEqual([]);
    expect(extractToolTouches({ type: "result" })).toEqual([]);
    expect(extractToolTouches({ type: "assistant", message: { content: "nope" } })).toEqual([]);
  });
});

describe("countArtifactsRead", () => {
  const changed = ["web/server/a.ts", "web/src/b.tsx"];

  it("counts Read by relative or absolute path, once per file", () => {
    const touches: ObserverToolTouch[] = [
      { name: "Read", path: "web/server/a.ts" },
      { name: "Read", path: `${ROOT}/web/server/a.ts` },
      { name: "Read", path: `${ROOT}/web/src/b.tsx` },
    ];
    expect(countArtifactsRead(touches, changed, ROOT)).toBe(2);
  });

  it("counts a Grep scoped to a changed file but not a directory grep", () => {
    expect(countArtifactsRead([{ name: "Grep", path: "web/server/a.ts" }], changed, ROOT)).toBe(1);
    expect(countArtifactsRead([{ name: "Grep", path: "web/server" }], changed, ROOT)).toBe(0);
  });

  it("counts shell commands (Codex path) that name a changed file as a token", () => {
    expect(countArtifactsRead([{ name: "Bash", command: "sed -n '1,200p' web/server/a.ts" }], changed, ROOT)).toBe(1);
    expect(countArtifactsRead([{ name: "Bash", command: `nl -ba ${ROOT}/web/src/b.tsx | head` }], changed, ROOT)).toBe(1);
    expect(countArtifactsRead([{ name: "Bash", command: "rg -n foo ./web/server/a.ts" }], changed, ROOT)).toBe(1);
  });

  it("does not count a path that is only a prefix/suffix of another file", () => {
    // `web/server/a.ts.bak` and `xweb/server/a.ts` are different files.
    expect(countArtifactsRead([{ name: "Bash", command: "cat web/server/a.ts.bak" }], changed, ROOT)).toBe(0);
    expect(countArtifactsRead([{ name: "Bash", command: "cat xweb/server/a.ts" }], changed, ROOT)).toBe(0);
  });

  it("a bare git diff / git show reads every changed file", () => {
    expect(countArtifactsRead([{ name: "Bash", command: "git diff HEAD~1" }], changed, ROOT)).toBe(2);
    expect(countArtifactsRead([{ name: "Bash", command: "cd /work/repo && git show | head -400" }], changed, ROOT)).toBe(2);
  });

  it("git diff summaries (--stat / --name-only) are not reads", () => {
    expect(countArtifactsRead([{ name: "Bash", command: "git diff --stat" }], changed, ROOT)).toBe(0);
    expect(countArtifactsRead([{ name: "Bash", command: "git diff --name-only HEAD~1" }], changed, ROOT)).toBe(0);
  });

  it("a git diff with a pathspec counts only the named files", () => {
    expect(countArtifactsRead([{ name: "Bash", command: "git diff -- web/src/b.tsx" }], changed, ROOT)).toBe(1);
  });

  it("listings, globs and writes are not reads", () => {
    const touches: ObserverToolTouch[] = [
      { name: "Bash", command: "ls web/server" },
      { name: "Glob", path: "web/server/a.ts" },
      { name: "Write", path: "web/server/a.ts" },
    ];
    expect(countArtifactsRead(touches, changed, ROOT)).toBe(0);
  });

  it("no changed files → 0 even with reads (spawn checkpoint)", () => {
    expect(countArtifactsRead([{ name: "Read", path: "web/server/a.ts" }], [], ROOT)).toBe(0);
  });
});

describe("ObserverReadLedger", () => {
  it("ignores frames for sessions without a dispatched wake", () => {
    const ledger = new ObserverReadLedger();
    ledger.onAssistant("obs", assistant(toolUse("Read", { file_path: "a.ts" })));
    expect(ledger.touchesFor("obs", "chk_1")).toEqual([]);
  });

  it("scopes touches to the checkpoint of the latest wake", () => {
    const ledger = new ObserverReadLedger();
    ledger.begin("obs", "chk_1");
    ledger.onAssistant("obs", assistant(toolUse("Read", { file_path: "a.ts" })));
    expect(ledger.touchesFor("obs", "chk_1")).toHaveLength(1);
    // A different checkpoint id (stale review, restart catch-up) sees nothing.
    expect(ledger.touchesFor("obs", "chk_0")).toEqual([]);
    // A newer wake resets the slot.
    ledger.begin("obs", "chk_2");
    expect(ledger.touchesFor("obs", "chk_2")).toEqual([]);
    expect(ledger.touchesFor("obs", "chk_1")).toEqual([]);
  });

  it("forget drops the slot", () => {
    const ledger = new ObserverReadLedger();
    ledger.begin("obs", "chk_1");
    ledger.onAssistant("obs", assistant(toolUse("Read", { file_path: "a.ts" })));
    ledger.forget("obs");
    expect(ledger.touchesFor("obs", "chk_1")).toEqual([]);
  });

  it("caps recorded touches per wake", () => {
    const ledger = new ObserverReadLedger();
    ledger.begin("obs", "chk_1");
    for (let i = 0; i < MAX_TOUCHES_PER_WAKE + 5; i++) {
      ledger.onAssistant("obs", assistant(toolUse("Bash", { command: `echo ${i}` })));
    }
    expect(ledger.touchesFor("obs", "chk_1")).toHaveLength(MAX_TOUCHES_PER_WAKE);
  });
});

// Observer rigor (2026-10-16): prod checkpoint 148 — the observer `cat`-ed the
// prose closure note and replied `[]`; reading the note counted as "read a
// changed file". `touchesReachBeyondArtifacts` asks the stricter question: did
// the turn look at anything BESIDES the prose artifact (the code it cites)?
describe("touchesReachBeyondArtifacts (rubber-stamp detection)", () => {
  const ROOT = "/root/aura-companion";
  const NOTE = ".council/review-input/task-a-model-rotation-closure.md";
  const PLAN = "docs/plan.md";
  const bash = (command: string) => ({ name: "Bash", command });

  it("the recorded checkpoint-148 command (bash -lc 'cat <note>') does not reach beyond", () => {
    expect(touchesReachBeyondArtifacts([bash(`/bin/bash -lc 'cat ${NOTE}'`)], [NOTE], ROOT)).toBe(false);
  });

  it("reading only prose artifacts (relative, absolute, cd-prefixed, sed ranges) does not reach beyond", () => {
    expect(touchesReachBeyondArtifacts([
      { name: "Read", path: `${ROOT}/${PLAN}` },
      bash(`cd ${ROOT} && sed -n '1,200p' ${PLAN}`),
      bash(`nl -ba ./${PLAN} | head -c 4000`),
    ], [PLAN], ROOT)).toBe(false);
  });

  it("no tool calls at all does not reach beyond", () => {
    expect(touchesReachBeyondArtifacts([], [PLAN], ROOT)).toBe(false);
  });

  it("opening a code file the note cites reaches beyond (Read or shell)", () => {
    expect(touchesReachBeyondArtifacts([{ name: "Read", path: "web/server/ws-bridge.ts" }], [PLAN], ROOT)).toBe(true);
    expect(touchesReachBeyondArtifacts([bash("sed -n 300,340p web/server/session-orchestrator.ts")], [PLAN], ROOT)).toBe(true);
    expect(touchesReachBeyondArtifacts([bash(`cat ${ROOT}/web/server/a.ts:12`)], [PLAN], ROOT)).toBe(true);
  });

  it("searching the code (rg / grep / git diff / Grep tool) reaches beyond", () => {
    expect(touchesReachBeyondArtifacts([bash("rg -n persistModel")], [PLAN], ROOT)).toBe(true);
    expect(touchesReachBeyondArtifacts([bash("git -C /root/aura-companion show HEAD")], [PLAN], ROOT)).toBe(true);
    expect(touchesReachBeyondArtifacts([{ name: "Grep" }], [PLAN], ROOT)).toBe(true);
  });

  it("a CODE artifact listed in the checkpoint is code: reading it counts", () => {
    expect(touchesReachBeyondArtifacts([{ name: "Read", path: "web/server/a.ts" }], ["web/server/a.ts"], ROOT)).toBe(true);
  });

  it("council protocol files and paths outside the workspace never count", () => {
    expect(touchesReachBeyondArtifacts([
      { name: "Read", path: ".council/checkpoints/council-review-grp_x.json" },
      bash("cat /etc/hosts"),
      bash("ls -la"),
    ], [PLAN], ROOT)).toBe(false);
  });
});
