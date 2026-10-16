import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SECOND_REVIEW_CLAUDE_DISALLOWED_TOOLS,
  SecondReviewer,
  type HeadlessRunOptions,
  type HeadlessRunResult,
  type SecondReviewBusEvent,
  type SecondReviewerDeps,
  buildSecondReviewInvocation,
  buildSecondReviewEnv,
  parseSecondReviewOutput,
  makeTmpScratchFile,
  prependBinaryDir,
  readCodexDefaultModel,
  readScratchFile,
  runHeadless,
} from "./second-reviewer.js";
import { existsSync } from "node:fs";
import type { CheckpointPayload, ObserverReviewPayload } from "./council-types.js";
import { parseObserverReviewPayload } from "./council-types.js";
import type { SecondReviewerConfig } from "./second-reviewer-config.js";
import { log } from "./logger.js";
import { writeAtomicJson } from "./atomic-write.js";

// W15 multi-model review — the host-run one-shot second-opinion reviewer.
// These tests pin: (1) the read-only argv for both backends, (2) parsing of
// each CLI's output incl. usage-limit detection, (3) the dispatch decisions
// (off / scope / dedup / limit / queue / timeout) with their structured
// `council.second_review.*` log lines, and (4) that a completed run writes a
// host-stamped `reviewer_role: "second"` review under its own file name so the
// existing review pipeline picks it up.

const GROUP = "grp_0123456789abcdef0123456789abcdef";
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  vi.restoreAllMocks();
});

function workspace(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "second-reviewer-")));
  mkdirSync(join(dir, ".council", "reviews"), { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function checkpoint(id: string, phase = "council-implement", sequence = 1): CheckpointPayload {
  return {
    schema_version: 1,
    checkpoint_id: id,
    phase,
    sequence,
    session_group_id: GROUP,
    emitted_at: new Date(Date.now() - 1000).toISOString(),
    artifact_paths: ["src/a.ts"],
  } as CheckpointPayload;
}

function claudeResult(reply: string, model = "claude-sonnet-5"): HeadlessRunResult {
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: reply,
      modelUsage: { "claude-haiku-4-5": { outputTokens: 10 }, [model]: { outputTokens: 900 } },
    }),
    stderr: "",
    timedOut: false,
    aborted: false,
  };
}

interface Harness {
  reviewer: SecondReviewer;
  cwd: string;
  run: ReturnType<typeof vi.fn>;
  ingest: ReturnType<typeof vi.fn>;
  events: SecondReviewBusEvent[];
  setConfig: (c: SecondReviewerConfig) => void;
  setLimited: (v: boolean) => void;
  now: { value: number };
}

function harness(opts: {
  config?: SecondReviewerConfig;
  run?: (cmd: string[], o: HeadlessRunOptions) => Promise<HeadlessRunResult>;
  deps?: Partial<SecondReviewerDeps>;
} = {}): Harness {
  const cwd = workspace();
  let config: SecondReviewerConfig = opts.config ?? { reviewer: "auto", scope: "review-implement" };
  let limited = false;
  const events: SecondReviewBusEvent[] = [];
  const now = { value: Date.now() };
  const run = vi.fn(opts.run ?? (async () => claudeResult("[]")));
  const ingest = vi.fn();
  const reviewer = new SecondReviewer({
    getConfig: () => config,
    loadSystemPrompt: () => "<!-- observer-system-prompt v1 -->\nObserver prompt body",
    resolveBinary: (name) => `/usr/local/bin/${name}`,
    buildEnv: () => ({ PATH: "/usr/bin" }),
    run,
    writeReview: (path, payload) => writeAtomicJson(path, payload),
    ingestReview: ingest,
    isBackendLimited: () => limited,
    isGroupLive: () => true,
    emit: (e) => { events.push(e); },
    now: () => now.value,
    makeScratchFile: () => ({ path: join(cwd, "scratch.txt"), cleanup: () => {} }),
    readScratchFile: (p) => {
      try {
        return readFileSync(p, "utf-8");
      } catch {
        return null;
      }
    },
    ...opts.deps,
  });
  return {
    reviewer, cwd, run, ingest, events, now,
    setConfig: (c) => { config = c; },
    setLimited: (v) => { limited = v; },
  };
}

function secondReviewFiles(cwd: string): string[] {
  return readdirSync(join(cwd, ".council", "reviews")).filter((f) => f.includes("-second-"));
}

describe("buildSecondReviewInvocation — read-only argv", () => {
  // EC-1 spirit: the claude second reviewer can only Read/Grep/Glob. `--tools`
  // limits which tools EXIST; the denylist and dontAsk mode are defence in
  // depth; no MCP servers; nothing persisted.
  it("claude: only Read/Grep/Glob exist, writes and shell are denied, dontAsk, no MCP", () => {
    const inv = buildSecondReviewInvocation({
      reviewer: { backend: "claude", model: "sonnet" },
      binary: "/bin/claude",
      cwd: "/w",
      systemPrompt: "SYS",
      wakeText: "WAKE",
    });
    const argv = inv.cmd;
    const after = (flag: string) => argv[argv.indexOf(flag) + 1];
    expect(argv[0]).toBe("/bin/claude");
    expect(argv).toContain("-p");
    expect(after("--tools")).toBe("Read,Grep,Glob");
    expect(after("--allowedTools")).toBe("Read,Grep,Glob");
    for (const t of ["Write", "Edit", "MultiEdit", "Bash", "NotebookEdit", "WebFetch"]) {
      expect(after("--disallowedTools").split(",")).toContain(t);
      expect(after("--tools").split(",")).not.toContain(t);
    }
    expect(after("--permission-mode")).toBe("dontAsk");
    expect(argv).toContain("--strict-mcp-config");
    expect(argv).toContain("--no-session-persistence");
    expect(after("--model")).toBe("sonnet");
    expect(after("--append-system-prompt")).toBe("SYS");
    expect(argv).not.toContain("--dangerously-skip-permissions");
    expect(inv.stdin).toContain("WAKE");
    expect(SECOND_REVIEW_CLAUDE_DISALLOWED_TOOLS).toContain("Write");
  });

  // codex: the read-only sandbox is the enforced boundary; never a
  // bypass flag, never a writable sandbox.
  it("codex: network is explicitly off in the sandbox config", () => {
    const inv = buildSecondReviewInvocation({
      reviewer: { backend: "codex", model: "gpt-6.1-sol" },
      binary: "/bin/codex", cwd: "/w", systemPrompt: "S", wakeText: "W", lastMessageFile: "/tmp/l",
    });
    expect(inv.cmd).toContain("sandbox_workspace_write.network_access=false");
    expect(inv.cmd[inv.cmd.indexOf("--model") + 1]).toBe("gpt-6.1-sol");
  });

  it("codex: read-only sandbox, no approvals, ephemeral, reply to the scratch file", () => {
    const inv = buildSecondReviewInvocation({
      reviewer: { backend: "codex" },
      binary: "/bin/codex",
      cwd: "/w",
      systemPrompt: "SYS",
      wakeText: "WAKE",
      lastMessageFile: "/tmp/x/last.txt",
    });
    const argv = inv.cmd;
    const after = (flag: string) => argv[argv.indexOf(flag) + 1];
    expect(argv.slice(0, 2)).toEqual(["/bin/codex", "exec"]);
    expect(after("--sandbox")).toBe("read-only");
    expect(argv).toContain('approval_policy="never"');
    expect(argv).toContain("--ephemeral");
    expect(after("--cd")).toBe("/w");
    expect(after("--output-last-message")).toBe("/tmp/x/last.txt");
    expect(argv).not.toContain("--model");
    expect(argv.join(" ")).not.toMatch(/danger|workspace-write|bypass/);
    // codex has no system-prompt flag: the prompt leads stdin.
    expect(inv.stdin.indexOf("SYS")).toBeLessThan(inv.stdin.indexOf("WAKE"));
  });
});

// Sonnet review STOP (security) on PR #372: the second reviewer must never
// inherit the server's whole environment (tokens, API keys, AURA_*/COMPANION_*).
// codex keeps a shell inside its read-only, no-network sandbox, so anything in
// its env is readable by a prompt-injected reviewer.
describe("buildSecondReviewEnv — allowlisted environment", () => {
  const serverEnv = {
    PATH: "/usr/bin",
    HOME: "/home/auracomp",
    LANG: "C.UTF-8",
    TERM: "xterm",
    COMPANION_AUTH_TOKEN: "secret-companion",
    AURA_INIT_FRAME_TIMEOUT_MS: "1",
    OPENAI_API_KEY: "sk-openai",
    ANTHROPIC_API_KEY: "sk-ant",
    CLAUDE_CODE_OAUTH_TOKEN: "oauth",
    GITHUB_TOKEN: "ghp",
    CLAUDECODE: "1",
  };
  it("codex: only PATH/HOME/locale/TERM and CODEX_HOME — no API keys or server tokens", () => {
    const env = buildSecondReviewEnv("codex", serverEnv, { path: "/opt/codex/bin:/usr/bin" });
    expect(env).toEqual({
      PATH: "/opt/codex/bin:/usr/bin",
      HOME: "/home/auracomp",
      LANG: "C.UTF-8",
      TERM: "xterm",
      CODEX_HOME: "/home/auracomp/.codex",
    });
  });
  it("claude: the allowlist plus only Claude's own auth variables", () => {
    const env = buildSecondReviewEnv("claude", serverEnv, { path: "/usr/bin" });
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/auracomp",
      LANG: "C.UTF-8",
      TERM: "xterm",
      ANTHROPIC_API_KEY: "sk-ant",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth",
    });
  });
  it("keeps an explicit CODEX_HOME", () => {
    expect(buildSecondReviewEnv("codex", { ...serverEnv, CODEX_HOME: "/srv/codex" }, { path: "/usr/bin" }).CODEX_HOME).toBe("/srv/codex");
  });
});

describe("readCodexDefaultModel", () => {
  // The codex config default can be unlaunchable for a ChatGPT account
  // (observed: `gpt-5.5` → 400). `auto` uses the first launchable slug from
  // the CLI's own models cache instead.
  it("returns the first slug of $CODEX_HOME/models_cache.json, or undefined", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-home-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    expect(readCodexDefaultModel(dir)).toBeUndefined();
    writeFileSync(join(dir, "models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-6.1-sol" }, { slug: "gpt-6.1-mini" }] }));
    expect(readCodexDefaultModel(dir)).toBe("gpt-6.1-sol");
  });
});

// Sonnet review WARN1: a timeout must kill the whole process group (codex's
// bwrap sandbox, shells, …), not only the direct child.
describe("runHeadless", () => {
  it("on timeout kills the child's whole process group, grandchildren included", async () => {
    const dir = mkdtempSync(join(tmpdir(), "run-headless-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const pidFile = join(dir, "grandchild.pid");
    const res = await runHeadless(["/bin/sh", "-c", `sleep 30 & echo $! > ${pidFile}; wait`], {
      cwd: dir,
      env: { PATH: "/usr/bin:/bin" },
      stdin: "",
      timeoutMs: 300,
      signal: new AbortController().signal,
    });
    expect(res.timedOut).toBe(true);
    const pid = Number(readFileSync(pidFile, "utf-8").trim());
    await vi.waitFor(() => {
      expect(() => process.kill(pid, 0)).toThrow();
    }, { timeout: 2000 });
  });
});

// Error paths of the real spawner (coverage gate): a CLI that is not there,
// an abort before/while running, and normal stdin → stdout capture.
describe("runHeadless — spawn failure, abort and capture", () => {
  const opts = (signal = new AbortController().signal) => ({ cwd: tmpdir(), env: { PATH: "/usr/bin:/bin" }, stdin: "hello", timeoutMs: 5_000, signal });

  it("a missing binary resolves with a spawn error instead of throwing", async () => {
    const res = await runHeadless(["/nonexistent/aura-second-review-cli"], opts());
    expect(res.exitCode).toBeNull();
    expect(res.stderr).toMatch(/spawn error/);
    expect(res.timedOut).toBe(false);
  });

  it("feeds stdin and captures stdout and the exit code", async () => {
    const res = await runHeadless(["/bin/sh", "-c", "cat; echo err >&2; exit 3"], opts());
    expect(res).toMatchObject({ exitCode: 3, stdout: "hello", aborted: false, timedOut: false });
    expect(res.stderr).toContain("err");
  });

  it("an already-aborted signal kills the run at once", async () => {
    const ac = new AbortController();
    ac.abort();
    const res = await runHeadless(["/bin/sh", "-c", "sleep 30"], opts(ac.signal));
    expect(res.aborted).toBe(true);
  });

  it("aborting mid-run kills it", async () => {
    const ac = new AbortController();
    const p = runHeadless(["/bin/sh", "-c", "sleep 30"], opts(ac.signal));
    setTimeout(() => ac.abort(), 50);
    expect((await p).aborted).toBe(true);
  });
});

describe("scratch file and PATH helpers", () => {
  it("makeTmpScratchFile gives a writable path that cleanup removes; readScratchFile tolerates absence", () => {
    const scratch = makeTmpScratchFile();
    expect(readScratchFile(scratch.path)).toBeNull();
    writeFileSync(scratch.path, "[]");
    expect(readScratchFile(scratch.path)).toBe("[]");
    scratch.cleanup();
    expect(existsSync(scratch.path)).toBe(false);
    scratch.cleanup(); // idempotent
  });

  it("prependBinaryDir puts the CLI's own directory first", () => {
    expect(prependBinaryDir("/opt/codex/bin/codex", "/usr/bin:/bin")).toBe("/opt/codex/bin:/usr/bin:/bin");
  });
});

describe("parseSecondReviewOutput", () => {
  it("claude: returns the reply and the model that produced most output (host fact)", () => {
    expect(parseSecondReviewOutput("claude", { ...claudeResult("[]"), lastMessage: null })).toEqual({
      ok: true,
      text: "[]",
      model: "claude-sonnet-5",
    });
  });

  it("claude: a usage-limit answer is usage_limited, an error result is cli_error", () => {
    const limited = claudeResult("You've hit your session limit · resets 5pm (UTC)");
    expect(parseSecondReviewOutput("claude", limited)).toMatchObject({ ok: false, reason: "usage_limited" });
    const err = { ...claudeResult("boom"), stdout: JSON.stringify({ type: "result", is_error: true, subtype: "error_during_execution", result: "boom" }) };
    expect(parseSecondReviewOutput("claude", err)).toMatchObject({ ok: false, reason: "cli_error" });
    expect(parseSecondReviewOutput("claude", { stdout: "", stderr: "segfault", exitCode: 139 })).toMatchObject({ ok: false, reason: "cli_error" });
  });

  it("codex: the reply is the last-message file; an empty reply with a limit error is usage_limited", () => {
    expect(parseSecondReviewOutput("codex", { stdout: '{"type":"x","model":"gpt-6.1-sol"}', stderr: "", exitCode: 0, lastMessage: "[]" }))
      .toEqual({ ok: true, text: "[]", model: "gpt-6.1-sol" });
    expect(parseSecondReviewOutput("codex", { stdout: '{"type":"error","message":"You\'ve hit your usage limit."}', stderr: "", exitCode: 1, lastMessage: "" }))
      .toMatchObject({ ok: false, reason: "usage_limited" });
    expect(parseSecondReviewOutput("codex", { stdout: "", stderr: "bwrap: Operation not permitted", exitCode: 1, lastMessage: null }))
      .toMatchObject({ ok: false, reason: "cli_error" });
  });
});

describe("SecondReviewer dispatch", () => {
  it("off: never runs and never emits", () => {
    const h = harness({ config: { reviewer: "off", scope: "all" } });
    expect(h.reviewer.onCheckpoint(GROUP, checkpoint("c1"), { cwd: h.cwd, observerBackend: "codex", previous: null })).toEqual({ kind: "off" });
    expect(h.run).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
  });

  // Cost: plan checkpoints are not second-reviewed by default; a skip is
  // logged but owes the convergence tracker nothing (no bus event).
  it("skips an out-of-scope phase with a structured log and no bus event", () => {
    const h = harness();
    const info = vi.spyOn(log, "info");
    const out = h.reviewer.onCheckpoint(GROUP, checkpoint("c1", "council-plan"), { cwd: h.cwd, observerBackend: "codex", previous: null });
    expect(out).toEqual({ kind: "skipped", reason: "phase_out_of_scope" });
    expect(h.run).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
    expect(info).toHaveBeenCalledWith("second-reviewer", expect.any(String), expect.objectContaining({
      event: "council.second_review.skipped",
      sessionGroupId: GROUP,
      checkpointId: "c1",
      backend: "claude",
      model: "sonnet",
      reason: "phase_out_of_scope",
    }));
  });

  // The happy path end-to-end: dispatched event + log, the read-only run, and
  // a host-stamped second review on disk under the second-review file name.
  it("runs the opposite backend and writes a host-stamped reviewer_role=second review", async () => {
    const finding = { severity: "STOP", claim: "Crash-loop storm: relaunch has no backoff", evidence_path: "src/a.ts", evidence_lines: [1, 1] };
    const h = harness({ run: async () => claudeResult(JSON.stringify([finding])) });
    const info = vi.spyOn(log, "info");
    const out = h.reviewer.onCheckpoint(GROUP, checkpoint("c1"), { cwd: h.cwd, observerBackend: "codex", previous: null });
    expect(out.kind).toBe("dispatched");
    await (out as { done: Promise<void> }).done;

    expect(h.events).toEqual([{ sessionGroupId: GROUP, checkpointId: "c1", status: "dispatched", backend: "claude", model: "sonnet" }]);
    const [cmd, runOpts] = h.run.mock.calls[0]! as [string[], HeadlessRunOptions];
    expect(cmd[0]).toBe("/usr/local/bin/claude");
    expect(runOpts.cwd).toBe(h.cwd);
    expect(runOpts.stdin).toContain('"checkpoint_id": "c1"');

    const files = secondReviewFiles(h.cwd);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(new RegExp(`-${GROUP}-second-claude-observer\\.md$`));
    const payload = parseObserverReviewPayload(readFileSync(join(h.cwd, ".council", "reviews", files[0]!), "utf-8")) as ObserverReviewPayload;
    expect(payload.reviewer_role).toBe("second");
    expect(payload.observer_provider).toBe("claude");
    expect(payload.observer_model).toBe("claude-sonnet-5");
    expect(payload.checkpoint_id).toBe("c1");
    expect(payload.findings[0]).toMatchObject({ severity: "STOP", evidence_path: "src/a.ts" });

    // The written review is handed straight to the council review pipeline.
    expect(h.ingest).toHaveBeenCalledTimes(1);
    expect(h.ingest).toHaveBeenCalledWith(GROUP, payload, expect.any(Number));

    const events = info.mock.calls.map((c) => (c[2] as { event?: string })?.event);
    expect(events).toContain("council.second_review.dispatched");
    expect(events).toContain("council.second_review.completed");
  });

  // Respect usage limits: a backend another session reports as limited is
  // skipped (logged) and the tracker is told the verdict will not come.
  it("skips while the backend is usage-limited and tells the tracker the verdict is missing", () => {
    const h = harness();
    h.setLimited(true);
    const out = h.reviewer.onCheckpoint(GROUP, checkpoint("c1"), { cwd: h.cwd, observerBackend: "codex", previous: null });
    expect(out).toEqual({ kind: "skipped", reason: "usage_limited" });
    expect(h.run).not.toHaveBeenCalled();
    expect(h.events).toEqual([{ sessionGroupId: GROUP, checkpointId: "c1", status: "missing", backend: "claude", model: "sonnet", reason: "usage_limited" }]);
  });

  // A run that itself answers with a usage limit puts the backend in a
  // cooldown: the next checkpoint is skipped without spawning anything.
  it("a usage-limit answer fails the run and cools the backend down", async () => {
    const h = harness({ run: async () => claudeResult("You've hit your session limit · resets 11pm (UTC)") });
    const warn = vi.spyOn(log, "warn");
    const out = h.reviewer.onCheckpoint(GROUP, checkpoint("c1"), { cwd: h.cwd, observerBackend: "codex", previous: null });
    await (out as { done: Promise<void> }).done;
    expect(warn).toHaveBeenCalledWith("second-reviewer", expect.any(String), expect.objectContaining({
      event: "council.second_review.failed",
      reason: "usage_limited",
      checkpointId: "c1",
    }));
    expect(h.events.at(-1)).toMatchObject({ checkpointId: "c1", status: "missing", reason: "usage_limited" });
    expect(h.reviewer.onCheckpoint(GROUP, checkpoint("c2", "council-implement", 2), { cwd: h.cwd, observerBackend: "codex", previous: null }))
      .toEqual({ kind: "skipped", reason: "usage_limited" });
    expect(h.run).toHaveBeenCalledTimes(1);
    expect(secondReviewFiles(h.cwd)).toEqual([]);
    expect(h.ingest).not.toHaveBeenCalled();
  });

  it("a timed-out run is logged as failed and writes nothing", async () => {
    const h = harness({ run: async () => ({ exitCode: null, stdout: "", stderr: "", timedOut: true, aborted: false }) });
    const warn = vi.spyOn(log, "warn");
    const out = h.reviewer.onCheckpoint(GROUP, checkpoint("c1"), { cwd: h.cwd, observerBackend: "codex", previous: null });
    await (out as { done: Promise<void> }).done;
    expect(warn).toHaveBeenCalledWith("second-reviewer", expect.any(String), expect.objectContaining({ event: "council.second_review.failed", reason: "timeout" }));
    expect(h.events.at(-1)).toMatchObject({ status: "missing", reason: "timeout" });
    expect(secondReviewFiles(h.cwd)).toEqual([]);
  });

  it("an unusable reply (prose, no findings JSON) fails without a review file", async () => {
    const h = harness({ run: async () => claudeResult("Looks fine to me.") });
    const out = h.reviewer.onCheckpoint(GROUP, checkpoint("c1"), { cwd: h.cwd, observerBackend: "codex", previous: null });
    await (out as { done: Promise<void> }).done;
    expect(h.events.at(-1)).toMatchObject({ status: "missing", reason: "reply_no_json" });
    expect(secondReviewFiles(h.cwd)).toEqual([]);
  });

  // One run per group: a newer checkpoint waits in a newest-wins slot; the
  // one it replaces is logged as superseded and reported missing.
  it("queues newest-wins behind a running review and drains it afterwards", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const h = harness({
      run: vi.fn(async () => {
        await gate;
        return claudeResult("[]");
      }),
    });
    const first = h.reviewer.onCheckpoint(GROUP, checkpoint("c1", "council-implement", 1), { cwd: h.cwd, observerBackend: "codex", previous: null });
    expect(h.reviewer.onCheckpoint(GROUP, checkpoint("c1", "council-implement", 1), { cwd: h.cwd, observerBackend: "codex", previous: null }))
      .toEqual({ kind: "skipped", reason: "in_flight" });
    expect(h.reviewer.onCheckpoint(GROUP, checkpoint("c2", "council-review", 2), { cwd: h.cwd, observerBackend: "codex", previous: null })).toEqual({ kind: "queued" });
    expect(h.reviewer.onCheckpoint(GROUP, checkpoint("c3", "council-review", 3), { cwd: h.cwd, observerBackend: "codex", previous: null })).toEqual({ kind: "queued" });
    expect(h.events).toContainEqual(expect.objectContaining({ checkpointId: "c2", status: "missing", reason: "superseded" }));
    release();
    await (first as { done: Promise<void> }).done;
    await vi.waitFor(() => expect(h.run).toHaveBeenCalledTimes(2));
    expect((h.run.mock.calls[1]![1] as HeadlessRunOptions).stdin).toContain('"checkpoint_id": "c3"');
  });

  // Observer STOP2 on PR #372: a queued checkpoint is announced as owed at
  // enqueue time; if the drain then skips it (setting switched off meanwhile)
  // the owed verdict is released as missing so the tracker never waits forever.
  it("announces a queued checkpoint as owed and releases it if the drain skips it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const h = harness({ run: async () => { await gate; return claudeResult("[]"); } });
    const ctx = { cwd: h.cwd, observerBackend: "codex" as const, previous: null };
    const first = h.reviewer.onCheckpoint(GROUP, checkpoint("c1"), ctx);
    expect(h.reviewer.onCheckpoint(GROUP, checkpoint("c2", "council-review", 2), ctx)).toEqual({ kind: "queued" });
    expect(h.events).toContainEqual({ sessionGroupId: GROUP, checkpointId: "c2", status: "queued", backend: "claude", model: "sonnet" });
    h.setConfig({ reviewer: "off", scope: "all" });
    release();
    await (first as { done: Promise<void> }).done;
    expect(h.events.at(-1)).toMatchObject({ checkpointId: "c2", status: "missing", reason: "disabled" });
    expect(h.run).toHaveBeenCalledTimes(1);
  });

  // Sonnet review WARN2: a process-wide cap on concurrent second reviews
  // (default 2). Other groups wait in their newest-wins slot and start as
  // capacity frees up.
  it("caps concurrent runs across groups and starts queued groups when a run ends", async () => {
    const G2 = "grp_1111111111111111111111111111111a";
    const G3 = "grp_2222222222222222222222222222222b";
    const gates: Array<() => void> = [];
    const h = harness({
      run: () => new Promise((r) => { gates.push(() => r(claudeResult("[]"))); }),
      deps: { maxConcurrency: 2 },
    });
    const ctx = { cwd: h.cwd, observerBackend: "codex" as const, previous: null };
    const a = h.reviewer.onCheckpoint(GROUP, checkpoint("a1"), ctx);
    const b = h.reviewer.onCheckpoint(G2, { ...checkpoint("b1"), session_group_id: G2 }, ctx);
    expect(a.kind).toBe("dispatched");
    expect(b.kind).toBe("dispatched");
    expect(h.reviewer.onCheckpoint(G3, { ...checkpoint("c1"), session_group_id: G3 }, ctx)).toEqual({ kind: "queued" });
    expect(h.run).toHaveBeenCalledTimes(2);
    expect(h.events).toContainEqual(expect.objectContaining({ sessionGroupId: G3, checkpointId: "c1", status: "queued" }));
    gates[0]!();
    await (a as { done: Promise<void> }).done;
    await vi.waitFor(() => expect(h.run).toHaveBeenCalledTimes(3));
    expect((h.run.mock.calls[2]![1] as HeadlessRunOptions).stdin).toContain('"checkpoint_id": "c1"');
    gates[1]!();
    gates[2]!();
  });

  it("defaults the codex model to the CLI's first launchable model when none is set", async () => {
    const h = harness({
      run: async (cmd) => {
        writeFileSync(cmd[cmd.indexOf("--output-last-message") + 1]!, "[]");
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false, aborted: false };
      },
      deps: { defaultModel: (b) => (b === "codex" ? "gpt-6.1-sol" : undefined) },
    });
    const out = h.reviewer.onCheckpoint(GROUP, checkpoint("c1"), { cwd: h.cwd, observerBackend: "claude", previous: null });
    await (out as { done: Promise<void> }).done;
    const cmd = h.run.mock.calls[0]![0] as string[];
    expect(cmd[cmd.indexOf("--model") + 1]).toBe("gpt-6.1-sol");
  });

  // Restart / redelivery idempotency: a checkpoint already second-reviewed on
  // disk is not reviewed again.
  it("skips a checkpoint whose second review is already on disk", async () => {
    const h = harness();
    const out = h.reviewer.onCheckpoint(GROUP, checkpoint("c1"), { cwd: h.cwd, observerBackend: "codex", previous: null });
    await (out as { done: Promise<void> }).done;
    expect(h.reviewer.onCheckpoint(GROUP, checkpoint("c1"), { cwd: h.cwd, observerBackend: "codex", previous: null }))
      .toEqual({ kind: "skipped", reason: "already_reviewed" });
    expect(h.run).toHaveBeenCalledTimes(1);
  });

  // A broken prompt artifact (or an invalid manifest) fails the wake build:
  // logged skip + the owed verdict is released, nothing spawned.
  it("a wake build failure is a logged skip with a missing verdict", () => {
    const h = harness({ deps: { loadSystemPrompt: () => { throw new Error("malformed prompt"); } } });
    const warn = vi.spyOn(log, "warn");
    expect(h.reviewer.onCheckpoint(GROUP, checkpoint("c1"), { cwd: h.cwd, observerBackend: "codex", previous: null }))
      .toEqual({ kind: "skipped", reason: "build_error" });
    expect(h.run).not.toHaveBeenCalled();
    expect(h.events.at(-1)).toMatchObject({ status: "missing", reason: "build_error" });
    expect(warn).toHaveBeenCalledWith("second-reviewer", expect.any(String), expect.objectContaining({ reason: "build_error", error: "malformed prompt" }));
  });

  it("a reply whose findings fail validation is a failed run, not a review", async () => {
    const h = harness({ run: async () => claudeResult(JSON.stringify([{ severity: "STOP", claim: "x", evidence_path: "/etc/passwd" }])) });
    const out = h.reviewer.onCheckpoint(GROUP, checkpoint("c1"), { cwd: h.cwd, observerBackend: "codex", previous: null });
    await (out as { done: Promise<void> }).done;
    expect(h.events.at(-1)).toMatchObject({ status: "missing", reason: "invalid_findings" });
    expect(h.ingest).not.toHaveBeenCalled();
  });

  it("a review that lands after the pair is gone is discarded", async () => {
    let live = true;
    const h = harness({ run: async () => { live = false; return claudeResult("[]"); }, deps: { isGroupLive: () => live } });
    const out = h.reviewer.onCheckpoint(GROUP, checkpoint("c1"), { cwd: h.cwd, observerBackend: "codex", previous: null });
    await (out as { done: Promise<void> }).done;
    expect(secondReviewFiles(h.cwd)).toEqual([]);
    expect(h.ingest).not.toHaveBeenCalled();
  });

  // An unexpected throw (e.g. the review write fails) is caught, logged as
  // failed and frees the pair's slot for the next checkpoint.
  it("an internal error is a failed run and frees the slot", async () => {
    const h = harness({ deps: { writeReview: () => { throw new Error("EACCES"); } } });
    const out = h.reviewer.onCheckpoint(GROUP, checkpoint("c1"), { cwd: h.cwd, observerBackend: "codex", previous: null });
    await (out as { done: Promise<void> }).done;
    expect(h.events.at(-1)).toMatchObject({ status: "missing", reason: "internal_error" });
    expect(h.reviewer.isRunning(GROUP)).toBe(false);
  });

  it("a missing CLI binary is a logged skip, not a crash", () => {
    const h = harness({ deps: { resolveBinary: () => null } });
    expect(h.reviewer.onCheckpoint(GROUP, checkpoint("c1"), { cwd: h.cwd, observerBackend: "codex", previous: null }))
      .toEqual({ kind: "skipped", reason: "binary_missing" });
    expect(h.events.at(-1)).toMatchObject({ status: "missing", reason: "binary_missing" });
  });

  // claude observer + auto → codex runs with the read-only sandbox and the
  // reply is read from the last-message file.
  it("claude observer + auto runs codex and reads the reply from the scratch file", async () => {
    const h = harness({
      run: async (cmd) => {
        const file = cmd[cmd.indexOf("--output-last-message") + 1]!;
        writeFileSync(file, "[]");
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false, aborted: false };
      },
    });
    const out = h.reviewer.onCheckpoint(GROUP, checkpoint("c1"), { cwd: h.cwd, observerBackend: "claude", previous: null });
    await (out as { done: Promise<void> }).done;
    const cmd = h.run.mock.calls[0]![0] as string[];
    expect(cmd[cmd.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(secondReviewFiles(h.cwd)[0]).toMatch(/-second-codex-observer\.md$/);
  });

  it("forgetGroup aborts the running review", async () => {
    let seenSignal: AbortSignal | undefined;
    const h = harness({
      run: (_cmd, o) => new Promise((resolve) => {
        seenSignal = o.signal;
        o.signal.addEventListener("abort", () => resolve({ exitCode: null, stdout: "", stderr: "", timedOut: false, aborted: true }));
      }),
    });
    const out = h.reviewer.onCheckpoint(GROUP, checkpoint("c1"), { cwd: h.cwd, observerBackend: "codex", previous: null });
    h.reviewer.forgetGroup(GROUP);
    await (out as { done: Promise<void> }).done;
    expect(seenSignal?.aborted).toBe(true);
    expect(h.reviewer.isRunning(GROUP)).toBe(false);
    expect(secondReviewFiles(h.cwd)).toEqual([]);
  });
});
