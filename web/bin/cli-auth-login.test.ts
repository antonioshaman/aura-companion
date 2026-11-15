import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  describeCliSignInTokenMissing,
  describeEffectiveMethod,
  describeLoginAttempt,
  describeLoginFailure,
  describeLoginInProgressElsewhere,
  describeManualSignIn,
  describePlanCheck,
  formatAction,
} from "../server/auth-status/auth-catalog.js";
import { knownField, type ProviderAuthStatus, type ProviderId } from "../server/auth-status/auth-types.js";
import type { StatusSnapshot } from "../server/auth-status/status-core.js";
import { LoginAttempts, MAX_CODE_SUBMISSIONS, type PromotionOutcome } from "../server/llm-login/login-attempt.js";
import { registerAuthStatusRoutes, type SignInFacts } from "../server/routes/auth-status-routes.js";
import { registerLoginRoutes } from "../server/routes/login-routes.js";
import { LOGIN_EXIT, readServiceAuraToken, runAuthLoginCommand, type CliLoginDeps } from "./cli-auth-login.js";

/**
 * `aura-companion auth login` (phase 2 plan task 9; S1-AC6 "same steps, texts
 * and outcome as the UI, no tokens in the output"). The CLI runs against the
 * REAL sign-in routes and registry, which run the FAKE official CLI — never
 * the real one, never real credentials. Pinned:
 * - every line it prints comes from the shared catalog (the UI's texts);
 * - exit codes: 0 success, 1 failure / cancel / expiry, 130 Ctrl-C (the
 *   attempt is cancelled on the server first);
 * - the link/code appear only while the attempt waits; nothing secret after
 *   the outcome; the typed reply code is never echoed;
 * - server unreachable → the manual instruction, no attempt (D3);
 * - no Aura token / 401 → "run as the service user" (D9);
 * - an attempt started elsewhere → continue or cancel;
 * - `--json` → one JSON object per line.
 */

const FAKE_CLI = join(import.meta.dirname, "..", "server", "llm-login", "fixtures", "fake-login-cli.mjs");
const TOKEN = "cli-login-test-token-abcdef0123456789";

let dir: string;
let registry: LoginAttempts | null;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cli-auth-login-"));
  registry = null;
});
afterEach(async () => {
  await registry?.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

function fakeCli(scenario: string): string {
  const path = join(dir, `fake-${scenario.replace(/[^a-z_]/gi, "")}.sh`);
  writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLI}" --scenario=${scenario} "$@"\n`);
  chmodSync(path, 0o755);
  return path;
}

function status(provider: ProviderId): ProviderAuthStatus {
  return {
    provider, state: "working", reason: null,
    account: knownField("synthetic-owner@example.test"), plan: knownField("pro"),
    method: knownField("subscription"), tokenExpiresAt: { known: false }, lastSuccessAt: 1, checkedAt: 1,
    verifiedBy: "login", cli: { path: { known: false }, version: { known: false } },
  };
}

interface Server {
  app: Hono;
  registry: LoginAttempts;
}

function server(scenario: Partial<Record<ProviderId, string>>, facts?: (p: ProviderId) => SignInFacts): Server {
  registry = new LoginAttempts({
    attemptsRoot: join(dir, "attempts"),
    resolveCli: (p) => (scenario[p] ? fakeCli(scenario[p]!) : null),
    platform: "linux",
    callerUser: "svc",
    callerUid: 1000,
    serviceUser: "svc",
    serviceEnv: { PATH: process.env.PATH },
    promote: async (): Promise<PromotionOutcome> => ({ ok: true, account: knownField("synthetic-owner@example.test"), plan: knownField("pro") }),
    cooldownMs: 0,
    killGraceMs: 300,
    timeoutBinary: null,
  });
  const api = new Hono();
  const snapshot: StatusSnapshot = { providers: { claude: status("claude"), codex: status("codex") }, computedBy: "service" };
  registerAuthStatusRoutes(api, { statusCore: () => ({ peek: () => snapshot, recheck: async () => ({ kind: "ok", snapshot }) as never }), doctor: () => ({ peek: () => null, recheck: async () => ({}) as never }), serviceHome: "/home/svc", signInFacts: facts });
  registerLoginRoutes(api, { attempts: () => registry!, hasAuraToken: (c) => c.req.header("Authorization") === `Bearer ${TOKEN}` }, MAX_CODE_SUBMISSIONS);
  const app = new Hono();
  app.route("/api", api);
  return { app, registry };
}

interface Harness {
  deps: CliLoginDeps;
  out: string[];
  typed: string[];
  interrupt: () => void;
}

/**
 * CLI deps over the in-process app. `answer` decides each stdin line from the
 * output so far (e.g. builds the Claude reply code from the printed link).
 */
function harness(app: Hono | null, answer: (out: string[], prompt: string) => string | null | Promise<string | null> = () => null, token: string | null = TOKEN): Harness {
  const out: string[] = [];
  const typed: string[] = [];
  let handler: (() => void) | null = null;
  const deps: CliLoginDeps = {
    request: async (path, init) => {
      if (!app) throw new Error("ECONNREFUSED");
      const res = await app.request(`http://localhost:3456${path}`, {
        method: init.method ?? "GET",
        headers: { Authorization: `Bearer ${init.token}`, ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}) },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    readToken: () => token,
    readLine: async (prompt) => {
      const line = await answer(out, prompt);
      if (line !== null) typed.push(line);
      return line;
    },
    onInterrupt: (h) => {
      handler = h;
      return () => { handler = null; };
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 30))),
    out: (line) => out.push(line),
    pollMs: 30,
  };
  return { deps, out, typed, interrupt: () => handler?.() };
}

/** The Claude reply code the fake CLI accepts: anything + `#<state from the printed link>`. */
function replyFromLink(out: string[]): string {
  const link = out.find((l) => l.startsWith("  Link: "))!.slice("  Link: ".length);
  return `SYNTHREPLY-CANARY#${new URL(link).searchParams.get("state")}`;
}

function entryLines(entry: { title: string; detail: string; action: Parameters<typeof formatAction>[0] }): string[] {
  const action = formatAction(entry.action, "cli");
  return [entry.title, `  ${entry.detail}`, ...(action ? [`  Action: ${action}`] : [])];
}

/** Everything printed after the outcome line must be free of the link, the codes and the canary. */
function expectNoSecretsAfter(out: string[], outcomeTitle: string, secrets: string[]): void {
  const at = out.indexOf(outcomeTitle);
  expect(at, `outcome "${outcomeTitle}" printed`).toBeGreaterThanOrEqual(0);
  const tail = out.slice(at).join("\n");
  for (const s of secrets) expect(tail).not.toContain(s);
  expect(tail).not.toContain("CANARY");
}

describe("auth login — Claude", () => {
  it("link → reply code → success: catalog texts, exit 0, nothing secret after the outcome", async () => {
    const { app } = server({ claude: "success" });
    const h = harness(app, (out) => replyFromLink(out));
    const code = await runAuthLoginCommand(["claude"], h.deps);
    expect(code).toBe(LOGIN_EXIT.ok);

    const awaiting = entryLines(describeLoginAttempt("awaiting_user", "claude"));
    expect(h.out.slice(h.out.indexOf(awaiting[0]), h.out.indexOf(awaiting[0]) + awaiting.length)).toEqual(awaiting);
    expect(h.out.some((l) => /^ {2}Link: https:\/\//.test(l))).toBe(true);
    expect(h.out.some((l) => l.startsWith("  Code: "))).toBe(false); // Claude has no device code
    expect(h.out).toContain(describeLoginAttempt("succeeded", "claude").title);
    expect(h.out).toContain("  Account: synthetic-owner@example.test · Plan: pro");

    const link = h.out.find((l) => l.startsWith("  Link: "))!.slice(8);
    expectNoSecretsAfter(h.out, describeLoginAttempt("succeeded", "claude").title, [link, ...h.typed]);
    // The typed reply code is never echoed, not even before the outcome.
    for (const t of h.typed) expect(h.out.join("\n")).not.toContain(t);
  });

  it("a rejected code → the catalog's \"code invalid or expired\", exit 1", async () => {
    const { app } = server({ claude: "reject" });
    const h = harness(app, (out) => replyFromLink(out));
    expect(await runAuthLoginCommand(["claude"], h.deps)).toBe(LOGIN_EXIT.failed);
    const failure = entryLines(describeLoginFailure("code_rejected", "claude"));
    expect(h.out).toEqual(expect.arrayContaining(failure));
    expectNoSecretsAfter(h.out, failure[0], h.typed);
  });

  it("a malformed code is refused with the catalog text and the prompt comes back", async () => {
    const { app } = server({ claude: "success" });
    let asks = 0;
    const h = harness(app, (out) => (++asks === 1 ? "not-a-code" : replyFromLink(out)));
    expect(await runAuthLoginCommand(["claude"], h.deps)).toBe(LOGIN_EXIT.ok);
    expect(h.out).toContain(describeLoginFailure("code_format", "claude").title);
    expect(asks).toBe(2);
  });

  it("plan mismatch and an overriding sign-in method are printed from the status, via the catalog", async () => {
    const effective = { method: "env_token", source: "environment", variable: "CLAUDE_CODE_OAUTH_TOKEN" } as const;
    const { app } = server({ claude: "success" }, () => ({ expectedPlan: "max", effectiveMethod: effective }));
    const h = harness(app, (out) => replyFromLink(out));
    expect(await runAuthLoginCommand(["claude"], h.deps)).toBe(LOGIN_EXIT.ok);
    expect(h.out).toEqual(expect.arrayContaining(entryLines(describePlanCheck("mismatch", "claude", "max", knownField("pro")))));
    expect(h.out).toEqual(expect.arrayContaining(entryLines(describeEffectiveMethod(effective, "claude"))));
  });
});

describe("auth login — Codex", () => {
  it("link + device code → success without typing anything, exit 0", async () => {
    const { app } = server({ codex: "success --success-after-ms=300" });
    const h = harness(app, () => { throw new Error("Codex must not ask for a code"); });
    const rc = await runAuthLoginCommand(["codex"], h.deps);
    expect(rc).toBe(LOGIN_EXIT.ok);
    const userCode = h.out.find((l) => l.startsWith("  Code: "))!.slice(8);
    expect(userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{5}$/);
    expect(h.out).toEqual(expect.arrayContaining(entryLines(describeLoginAttempt("awaiting_user", "codex"))));
    expectNoSecretsAfter(h.out, describeLoginAttempt("succeeded", "codex").title, [userCode]);
  });

  it("Ctrl-C cancels the attempt on the server, then exits 130", async () => {
    const { app, registry: reg } = server({ codex: "wait" });
    const h = harness(app);
    const run = runAuthLoginCommand(["codex"], h.deps);
    const until = Date.now() + 5_000;
    while (!h.out.some((l) => l.startsWith("  Code: ")) && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    h.interrupt();
    expect(await run).toBe(LOGIN_EXIT.interrupted);
    expect(reg.current("codex")?.state).toBe("cancelled");
    expect(h.out).toContain(describeLoginAttempt("cancelled", "codex").title);
  });
});

describe("auth login — server, token, existing attempt, json", () => {
  it("server unreachable → the manual instruction from the catalog, exit 1 (D3)", async () => {
    for (const provider of ["claude", "codex"] as const) {
      const h = harness(null);
      expect(await runAuthLoginCommand([provider], h.deps)).toBe(LOGIN_EXIT.failed);
      expect(h.out).toEqual(entryLines(describeManualSignIn(provider)));
    }
  });

  it("no token, or a token the server refuses → \"run as the service user\", nothing started (D9)", async () => {
    const { app, registry: reg } = server({ claude: "success" });
    for (const token of [null, "wrong-token"]) {
      const h = harness(app, () => null, token);
      expect(await runAuthLoginCommand(["claude"], h.deps)).toBe(LOGIN_EXIT.failed);
      expect(h.out).toEqual(entryLines(describeCliSignInTokenMissing("claude")));
    }
    expect(reg.current("claude")).toBeNull();
  });

  it("an attempt started elsewhere: \"x\" cancels it, exit 1", async () => {
    const { app, registry: reg } = server({ codex: "wait" });
    await reg.start("codex");
    const h = harness(app, (_out, prompt) => (prompt.includes("cancel") ? "x" : null));
    expect(await runAuthLoginCommand(["codex"], h.deps)).toBe(LOGIN_EXIT.failed);
    expect(h.out[0]).toBe(describeLoginInProgressElsewhere("codex").title);
    expect(reg.current("codex")?.state).toBe("cancelled");
  });

  it("an attempt started elsewhere: Enter continues the SAME attempt (no second one)", async () => {
    const { app, registry: reg } = server({ codex: "success --success-after-ms=400" });
    const first = await reg.start("codex");
    const h = harness(app, () => "");
    expect(await runAuthLoginCommand(["codex"], h.deps)).toBe(LOGIN_EXIT.ok);
    expect(reg.current("codex")?.id).toBe(first.attempt!.id);
  });

  // Review 203 STOP 1: Ctrl-C while the CLI waits on "continue or cancel?" must
  // cancel the attempt and exit 130, not hang on the pending stdin read.
  it("Ctrl-C during the continue/cancel question cancels the attempt and exits 130", async () => {
    const { app, registry: reg } = server({ codex: "wait" });
    await reg.start("codex");
    const h = harness(app, () => new Promise<string | null>(() => {})); // nobody answers
    const run = runAuthLoginCommand(["codex"], h.deps);
    const until = Date.now() + 5_000;
    while (h.out[0] !== describeLoginInProgressElsewhere("codex").title && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 20));
    h.interrupt();
    expect(await run).toBe(LOGIN_EXIT.interrupted);
    expect(reg.current("codex")?.state).toBe("cancelled");
    expect(h.out).toContain(describeLoginAttempt("cancelled", "codex").title);
  });

  // Review 203 WARN: closing stdin is not Ctrl-C — the attempt is cancelled and the exit code is 1.
  it("stdin closed while a Claude code is awaited → attempt cancelled, exit 1 (not 130)", async () => {
    const { app, registry: reg } = server({ claude: "success" });
    const h = harness(app, () => null);
    expect(await runAuthLoginCommand(["claude"], h.deps)).toBe(LOGIN_EXIT.failed);
    expect(reg.current("claude")?.state).toBe("cancelled");
    expect(h.out).toContain(describeLoginAttempt("cancelled", "claude").title);
  });

  // Review 203 STOP 2: Claude in --json mode still reads a code; no text prompt may
  // reach stdout, so every stdout line stays one JSON object.
  it("--json for Claude: stdout is JSON only (the code prompt is not text on stdout)", async () => {
    const { app } = server({ claude: "success" });
    const prompts: string[] = [];
    const h = harness(app, (out, prompt) => {
      prompts.push(prompt);
      const awaiting = out.map((l) => JSON.parse(l) as { prompt?: { url: string } }).find((o) => o.prompt)!;
      return `SYNTHREPLY#${new URL(awaiting.prompt!.url).searchParams.get("state")}`;
    });
    expect(await runAuthLoginCommand(["claude", "--json"], h.deps)).toBe(LOGIN_EXIT.ok);
    for (const line of h.out) expect(() => JSON.parse(line), line).not.toThrow();
    expect(prompts).toEqual([""]);
  });

  it("--json prints one JSON object per line, the prompt only in the awaiting line", async () => {
    const { app } = server({ codex: "success --success-after-ms=300" });
    const h = harness(app);
    expect(await runAuthLoginCommand(["codex", "--json"], h.deps)).toBe(LOGIN_EXIT.ok);
    const objects = h.out.map((l) => JSON.parse(l) as Record<string, unknown>);
    const withPrompt = objects.filter((o) => o.prompt);
    expect(withPrompt).toHaveLength(1);
    expect(withPrompt[0].state).toBe("awaiting_user");
    expect(objects.some((o) => o.state === "succeeded")).toBe(true);
  });

  it("an unknown provider prints the usage, exit 1", async () => {
    const h = harness(null);
    expect(await runAuthLoginCommand(["gemini"], h.deps)).toBe(LOGIN_EXIT.failed);
    expect(h.out[0]).toMatch(/^Usage: aura-companion auth login <claude\|codex>/);
  });
});

describe("readServiceAuraToken", () => {
  it("COMPANION_AUTH_TOKEN first, then the first readable auth.json, never creates one", () => {
    const svc = join(dir, "svc");
    const me = join(dir, "me");
    mkdirSync(join(svc, ".companion"), { recursive: true });
    mkdirSync(join(me, ".companion"), { recursive: true });
    writeFileSync(join(me, ".companion", "auth.json"), JSON.stringify({ token: "mine" }));
    expect(readServiceAuraToken({ env: { COMPANION_AUTH_TOKEN: "env" }, homes: [svc, me] })).toBe("env");
    expect(readServiceAuraToken({ env: {}, homes: [svc, me] })).toBe("mine");
    writeFileSync(join(svc, ".companion", "auth.json"), JSON.stringify({ token: "service" }));
    expect(readServiceAuraToken({ env: {}, homes: [svc, me] })).toBe("service");
    writeFileSync(join(svc, ".companion", "auth.json"), "{corrupt");
    expect(readServiceAuraToken({ env: {}, homes: [svc] })).toBeNull();
    expect(readServiceAuraToken({ env: {}, homes: [join(dir, "nobody")] })).toBeNull();
  });
});
