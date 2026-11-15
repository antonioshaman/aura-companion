import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { knownField, LOGIN_ATTEMPT_STATES, type ProviderId } from "../auth-status/auth-types.js";
import {
  ATTEMPT_SENTINEL_FILE,
  checkReplyCode,
  LoginAttempts,
  MAX_CODE_SUBMISSIONS,
  readAttemptSentinel,
  reduceLoginAttempt,
  sweepOrphanAttempts,
  type LoginAttempt,
  type LoginAttemptsDeps,
  type LoginEvent,
  type PromotionOutcome,
} from "./login-attempt.js";
import { readProcStat, sessionMembers } from "./login-runner.js";

// Sign-in attempts (phase 2 plan task 5; S1-AC1, S1-AC3, S1-AC4, S1-AC5).
// The reducer is tested as a pure function over every state; the executor
// runs the FAKE official CLI (never the real one) and a stub promotion. Pins:
//  - one attempt per provider (second start → the same attempt);
//  - a malformed or foreign reply code is refused BEFORE it reaches the CLI
//    (the process keeps running, untouched); a rejected one fails the attempt;
//  - cancel / expiry / failure → no process left in /proc and no staging dir;
//  - cancel and expiry do not interrupt `verifying` (the promotion decides);
//  - 10-second readiness budget → cli_output_unrecognised;
//  - the startup sweep kills a leftover CLI only when its identity (pid +
//    /proc start time) still matches, and only touches attempt-id names.

const FAKE_CLI = join(import.meta.dirname, "fixtures", "fake-login-cli.mjs");
const linux = process.platform === "linux";

let root: string;
let registries: LoginAttempts[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "login-attempt-"));
  registries = [];
});

afterEach(async () => {
  for (const r of registries) await r.shutdown();
  rmSync(root, { recursive: true, force: true });
});

function fakeCli(scenario: string): string {
  const path = join(root, `fake-${scenario}.sh`);
  writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLI}" --scenario=${scenario} "$@"\n`);
  chmodSync(path, 0o755);
  return path;
}

const okPromotion = async (): Promise<PromotionOutcome> => ({ ok: true, account: knownField("synthetic-owner@example.test"), plan: knownField("max") });

function registry(scenario: Partial<Record<ProviderId, string>>, over: Partial<LoginAttemptsDeps> = {}): LoginAttempts {
  const r = new LoginAttempts({
    attemptsRoot: join(root, "attempts"),
    resolveCli: (p) => (scenario[p] ? fakeCli(scenario[p]!) : null),
    platform: "linux",
    callerUser: "svc",
    callerUid: 1000,
    serviceUser: "svc",
    serviceEnv: { PATH: process.env.PATH },
    promote: okPromotion,
    cooldownMs: 0,
    killGraceMs: 300,
    timeoutBinary: null,
    ...over,
  });
  registries.push(r);
  return r;
}

async function waitFor(pred: () => boolean, ms = 5_000): Promise<void> {
  const until = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > until) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const attemptDirs = () => (existsSync(join(root, "attempts")) ? readdirSync(join(root, "attempts")) : []);
const pidOf = (dir: string) => readAttemptSentinel(join(root, "attempts", dir))?.pid ?? null;

// ─── Reducer ──────────────────────────────────────────────────────────────────

function attempt(over: Partial<LoginAttempt> = {}): LoginAttempt {
  return {
    id: "a".repeat(32), provider: "claude", state: "starting", version: 1, startedAt: 0, expiresAt: 1,
    prompt: null, failure: null, codeError: null, submissions: 0, submitting: false, result: null, ...over,
  };
}
const claudePrompt = { provider: "claude" as const, url: "https://claude.com/cai/oauth/authorize?state=s", state: "s".repeat(43) };

describe("reduceLoginAttempt", () => {
  it("walks the happy path starting → awaiting_user → verifying → succeeded with a monotonic version", () => {
    let a = attempt();
    a = reduceLoginAttempt(a, { type: "prompt_ready", prompt: claudePrompt });
    expect(a).toMatchObject({ state: "awaiting_user", version: 2, prompt: claudePrompt });
    a = reduceLoginAttempt(a, { type: "code_submitted" });
    expect(a).toMatchObject({ submitting: true, submissions: 1, version: 3 });
    a = reduceLoginAttempt(a, { type: "cli_succeeded" });
    expect(a).toMatchObject({ state: "verifying", prompt: null, version: 4 });
    a = reduceLoginAttempt(a, { type: "promoted", account: knownField("x@example.test"), plan: knownField("max") });
    expect(a).toMatchObject({ state: "succeeded", version: 5, result: { plan: { known: true, value: "max" } } });
  });

  it("terminal states absorb every event and drop the link (secrets never outlive the attempt)", () => {
    const events: LoginEvent[] = [
      { type: "prompt_ready", prompt: claudePrompt }, { type: "code_submitted" }, { type: "cli_succeeded" },
      { type: "promoted", account: knownField("x"), plan: knownField("y") }, { type: "failed", reason: "network" },
      { type: "cancelled" }, { type: "expired" }, { type: "code_refused", reason: "code_format" },
    ];
    for (const end of ["failed", "cancelled", "expired"] as const) {
      const awaiting = attempt({ state: "awaiting_user", prompt: claudePrompt });
      const ended = reduceLoginAttempt(awaiting, end === "failed" ? { type: "failed", reason: "code_rejected" } : { type: end });
      expect(ended.state).toBe(end);
      expect(ended.prompt).toBeNull();
      for (const e of events) expect(reduceLoginAttempt(ended, e)).toBe(ended);
    }
  });

  it("cancel and expiry do not interrupt verifying; a failure does", () => {
    const verifying = attempt({ state: "verifying" });
    expect(reduceLoginAttempt(verifying, { type: "cancelled" })).toBe(verifying);
    expect(reduceLoginAttempt(verifying, { type: "expired" })).toBe(verifying);
    expect(reduceLoginAttempt(verifying, { type: "failed", reason: "promotion_failed" }).state).toBe("failed");
  });

  it("one submission in flight, at most MAX_CODE_SUBMISSIONS; a refused code is recorded without a state change", () => {
    const awaiting = attempt({ state: "awaiting_user", prompt: claudePrompt });
    const busy = reduceLoginAttempt(awaiting, { type: "code_submitted" });
    expect(reduceLoginAttempt(busy, { type: "code_submitted" })).toBe(busy);
    const spent = attempt({ state: "awaiting_user", submissions: MAX_CODE_SUBMISSIONS });
    expect(reduceLoginAttempt(spent, { type: "code_submitted" })).toBe(spent);
    const refused = reduceLoginAttempt(awaiting, { type: "code_refused", reason: "attempt_mismatch" });
    expect(refused).toMatchObject({ state: "awaiting_user", codeError: "attempt_mismatch" });
  });

  it("expiry marks the failure reason; every state is reachable from starting", () => {
    expect(reduceLoginAttempt(attempt(), { type: "expired" })).toMatchObject({ state: "expired", failure: "expired" });
    const reached = new Set<string>(["starting"]);
    const walk = (a: LoginAttempt, depth: number) => {
      if (depth === 0) return;
      for (const e of [
        { type: "prompt_ready", prompt: claudePrompt }, { type: "cli_succeeded" }, { type: "promoted", account: knownField("x"), plan: knownField("y") },
        { type: "failed", reason: "network" }, { type: "cancelled" }, { type: "expired" },
      ] as LoginEvent[]) {
        const n = reduceLoginAttempt(a, e);
        reached.add(n.state);
        if (n !== a) walk(n, depth - 1);
      }
    };
    walk(attempt(), 4);
    expect([...reached].sort()).toEqual([...LOGIN_ATTEMPT_STATES].sort());
  });
});

describe("checkReplyCode", () => {
  const state = "S".repeat(43);
  it("accepts <code>#<state>; trims surrounding whitespace", () => {
    expect(checkReplyCode(`  abc-DEF_1.2~#${state}\n`, state)).toEqual({ ok: true, line: `abc-DEF_1.2~#${state}` });
  });
  it("S1-AC3: malformed → code_format; another attempt's state → attempt_mismatch", () => {
    for (const bad of ["", "nohash", `a#b#${state}`, `#${state}`, "a#", `a b#${state}`, `a\x00#${state}`, `<x>#${state}`, `${"a".repeat(600)}#${state}`]) {
      expect(checkReplyCode(bad, state), JSON.stringify(bad)).toEqual({ ok: false, reason: "code_format" });
    }
    expect(checkReplyCode(`abc#${"T".repeat(43)}`, state)).toEqual({ ok: false, reason: "attempt_mismatch" });
    expect(checkReplyCode("abc#short", state)).toEqual({ ok: false, reason: "attempt_mismatch" });
  });
});

// ─── Executor against the fake CLI ────────────────────────────────────────────

describe.skipIf(!linux)("LoginAttempts", () => {
  it("S1-AC1/AC2 claude: ready → valid code → promotion → succeeded; staging dir gone, no process", async () => {
    const promote = vi.fn(okPromotion);
    const r = registry({ claude: "success" }, { promote });
    const started = await r.start("claude");
    expect(started.kind).toBe("started");
    const id = started.attempt!.id;
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    await waitFor(() => r.current("claude")?.state === "awaiting_user");
    const dir = attemptDirs()[0];
    expect(dir).toBe(id);
    const pid = pidOf(dir)!;
    const prompt = r.current("claude")!.prompt;
    if (prompt?.provider !== "claude") throw new Error("no claude prompt");
    expect((await r.submitCode("claude", id, `SYNTHcode#${prompt.state}`)).kind).toBe("submitted");
    await waitFor(() => r.current("claude")?.state === "succeeded");
    expect(promote).toHaveBeenCalledWith(expect.objectContaining({ attemptId: id, provider: "claude" }));
    expect(r.current("claude")!.result).toEqual({ account: knownField("synthetic-owner@example.test"), plan: knownField("max") });
    expect(r.current("claude")!.prompt).toBeNull();
    await waitFor(() => attemptDirs().length === 0);
    expect(sessionMembers(pid)).toEqual([]);
  });

  it("S1-AC4: a second start for the same provider returns the running attempt; one process only", async () => {
    const r = registry({ codex: "wait" });
    const a = await r.start("codex");
    const b = await r.start("codex");
    expect(b).toEqual({ kind: "existing", attempt: expect.objectContaining({ id: a.attempt!.id }) });
    expect(attemptDirs()).toHaveLength(1);
  });

  it("S1-AC3: malformed and foreign codes are refused before the CLI; the process keeps running", async () => {
    const r = registry({ claude: "success" });
    const a = (await r.start("claude")).attempt!;
    await waitFor(() => r.current("claude")?.state === "awaiting_user");
    const pid = pidOf(attemptDirs()[0])!;
    expect(await r.submitCode("claude", a.id, "no-hash-here")).toMatchObject({ kind: "refused", reason: "code_format" });
    expect(await r.submitCode("claude", a.id, `abc#${"Z".repeat(43)}`)).toMatchObject({ kind: "refused", reason: "attempt_mismatch" });
    expect(await r.submitCode("claude", "f".repeat(32), "abc#x")).toMatchObject({ kind: "refused", reason: "attempt_mismatch" });
    expect(r.current("claude")).toMatchObject({ state: "awaiting_user", submissions: 0, codeError: "attempt_mismatch" });
    expect(readProcStat(pid)).not.toBeNull();
  });

  it("S1-AC3: a code the provider rejects fails the attempt (code_rejected); nothing left behind; cooldown applies", async () => {
    const r = registry({ claude: "reject" }, { cooldownMs: 60_000 });
    const a = (await r.start("claude")).attempt!;
    await waitFor(() => r.current("claude")?.state === "awaiting_user");
    const pid = pidOf(a.id)!;
    const prompt = r.current("claude")!.prompt;
    if (prompt?.provider !== "claude") throw new Error("no prompt");
    await r.submitCode("claude", a.id, `abc#${prompt.state}`);
    await waitFor(() => r.current("claude")?.state === "failed");
    expect(r.current("claude")!.failure).toBe("code_rejected");
    await waitFor(() => attemptDirs().length === 0);
    expect(sessionMembers(pid)).toEqual([]);
    expect((await r.start("claude")).kind).toBe("cooldown");
  });

  it("S1-AC5: cancel → cancelled, no process in /proc, no staging dir (both providers)", async () => {
    const r = registry({ claude: "success", codex: "wait" });
    for (const provider of ["claude", "codex"] as const) {
      const a = (await r.start(provider)).attempt!;
      await waitFor(() => r.current(provider)?.state === "awaiting_user");
      const pid = pidOf(a.id)!;
      expect((await r.cancel(provider, a.id))?.state).toBe("cancelled");
      expect(sessionMembers(pid)).toEqual([]);
      expect(attemptDirs()).not.toContain(a.id);
    }
  });

  it("S1-AC5: expiry → expired, no process, no staging dir", async () => {
    const r = registry({ codex: "wait" }, { ttlMs: { codex: 400 } });
    const a = (await r.start("codex")).attempt!;
    await waitFor(() => attemptDirs().length === 1 && pidOf(a.id) !== null);
    const pid = pidOf(a.id)!;
    await waitFor(() => r.current("codex")?.state === "expired");
    await waitFor(() => attemptDirs().length === 0);
    expect(sessionMembers(pid)).toEqual([]);
    expect(r.current("codex")).toMatchObject({ failure: "expired", prompt: null });
  });

  it("S1-AC1: no link within the readiness budget → cli_output_unrecognised", async () => {
    const r = registry({ claude: "silent" }, { readyBudgetMs: 300 });
    await r.start("claude");
    await waitFor(() => r.current("claude")?.state === "failed");
    expect(r.current("claude")!.failure).toBe("cli_output_unrecognised");
  });

  it("unrecognised output fails closed at once; codex no network → network", async () => {
    const r = registry({ claude: "garbage", codex: "no_network" });
    await r.start("claude");
    await r.start("codex");
    await waitFor(() => r.current("claude")?.state === "failed" && r.current("codex")?.state === "failed");
    expect(r.current("claude")!.failure).toBe("cli_output_unrecognised");
    expect(r.current("codex")!.failure).toBe("network");
  });

  it("codex: no reply code (not applicable); device-code success → promotion → succeeded", async () => {
    const r = registry({ codex: "success" });
    const a = (await r.start("codex")).attempt!;
    expect(await r.submitCode("codex", a.id, "abc#x")).toEqual({ kind: "not_applicable" });
    await waitFor(() => r.current("codex")?.state === "succeeded");
  });

  it("a failed promotion → promotion_failed; staging dir removed", async () => {
    const r = registry({ codex: "success" }, { promote: async () => ({ ok: false, reason: "promotion_failed" as const }) });
    await r.start("codex");
    await waitFor(() => r.current("codex")?.state === "failed");
    expect(r.current("codex")!.failure).toBe("promotion_failed");
    await waitFor(() => attemptDirs().length === 0);
  });

  it("promotion_incomplete (new credentials live, a later step failed) keeps the attempt dir for recovery", async () => {
    const r = registry({ codex: "success" }, { promote: async () => ({ ok: false, reason: "promotion_incomplete" as const }) });
    const a = (await r.start("codex")).attempt!;
    await waitFor(() => r.current("codex")?.state === "failed");
    expect(r.current("codex")!.failure).toBe("promotion_incomplete");
    await new Promise((res) => setTimeout(res, 100));
    expect(attemptDirs()).toContain(a.id);
  });

  it("cancel and expiry during verifying do not interrupt the promotion", async () => {
    let release!: (o: PromotionOutcome) => void;
    const promote = vi.fn(() => new Promise<PromotionOutcome>((res) => { release = res; }));
    const r = registry({ codex: "success" }, { promote });
    const a = (await r.start("codex")).attempt!;
    await waitFor(() => promote.mock.calls.length === 1);
    expect(r.current("codex")!.state).toBe("verifying");
    await r.cancel("codex", a.id);
    expect(r.current("codex")!.state).toBe("verifying");
    expect(attemptDirs()).toContain(a.id);
    release({ ok: true, account: knownField("x@example.test"), plan: knownField("pro") });
    await waitFor(() => r.current("codex")?.state === "succeeded");
  });

  it("preflight refusal: nothing spawned, no staging dir, the attempt is failed with the reason", async () => {
    const r = registry({ claude: "success" }, { callerUser: "root", callerUid: 0, serviceUser: null });
    const res = await r.start("claude");
    expect(res).toMatchObject({ kind: "refused", attempt: { state: "failed", failure: "wrong_service_user" } });
    expect(attemptDirs()).toEqual([]);
    const mac = registry({ claude: "success" }, { platform: "darwin" });
    expect((await mac.start("claude")).attempt!.failure).toBe("unsupported_platform");
    const missing = registry({});
    expect((await missing.start("codex")).attempt!.failure).toBe("cli_missing");
  });

  it("the sentinel is written before the spawn and carries pid + start time after it", async () => {
    const r = registry({ codex: "wait" });
    const a = (await r.start("codex")).attempt!;
    const s = readAttemptSentinel(join(root, "attempts", a.id))!;
    expect(s).toMatchObject({ attemptId: a.id, provider: "codex", pid: expect.any(Number), startTime: expect.stringMatching(/^\d+$/) });
    expect(readProcStat(s.pid!)?.startTime).toBe(s.startTime);
  });
});

describe.skipIf(!linux)("sweepOrphanAttempts (startup after a restart)", () => {
  function orphan(): { pid: number; startTime: string } {
    // A detached `sleep` stands in for a CLI left behind by a previous server process.
    const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    child.unref();
    return { pid: child.pid!, startTime: readProcStat(child.pid!)!.startTime };
  }

  function attemptDir(name: string, sentinel: object | null): string {
    const dir = join(root, "attempts", name);
    mkdirSync(join(dir, "home"), { recursive: true });
    if (sentinel) writeFileSync(join(dir, ATTEMPT_SENTINEL_FILE), JSON.stringify(sentinel));
    return dir;
  }

  it("kills an orphan whose identity matches, removes its dir; a reused pid is NOT signalled", async () => {
    const live = orphan();
    const reused = orphan();
    const idA = "a".repeat(32);
    const idB = "b".repeat(32);
    attemptDir(idA, { schemaVersion: 1, attemptId: idA, provider: "claude", pid: live.pid, startTime: live.startTime, expiresAt: 0 });
    // Same pid, different start time: the pid now belongs to someone else.
    attemptDir(idB, { schemaVersion: 1, attemptId: idB, provider: "codex", pid: reused.pid, startTime: "1", expiresAt: 0 });
    const report = await sweepOrphanAttempts(join(root, "attempts"), { killGraceMs: 1_000 });
    expect(report.killed).toEqual([live.pid]);
    await waitFor(() => readProcStat(live.pid) === null || readProcStat(live.pid)?.startTime !== live.startTime);
    expect(readProcStat(reused.pid)?.startTime).toBe(reused.startTime);
    process.kill(reused.pid, "SIGKILL");
    expect(attemptDirs()).toEqual([]);
  });

  it("touches only attempt-id names, honours keep(), and tolerates a missing or broken sentinel", async () => {
    const keepId = "c".repeat(32);
    attemptDir(keepId, null);
    attemptDir("d".repeat(32), null);
    attemptDir("e".repeat(32), { garbage: true });
    attemptDir("not-an-attempt", null);
    const report = await sweepOrphanAttempts(join(root, "attempts"), { keep: (id) => id === keepId });
    expect(attemptDirs().sort()).toEqual([keepId, "not-an-attempt"]);
    expect(report.removed.sort()).toEqual(["d".repeat(32), "e".repeat(32)]);
    expect(await sweepOrphanAttempts(join(root, "missing-root"))).toEqual({ removed: [], killed: [], skipped: [] });
  });
});
