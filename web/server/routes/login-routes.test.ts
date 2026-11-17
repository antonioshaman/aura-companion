import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { knownField, type ProviderId } from "../auth-status/auth-types.js";
import {
  LoginAttempts,
  MAX_CODE_SUBMISSIONS,
  type LoginAttempt,
  type PromotionOutcome,
} from "../llm-login/login-attempt.js";

// The real router is mounted in the D9 test below; the registry singleton is
// replaced so the test can prove that no sign-in process was started.
const registrySpy = {
  start: vi.fn(),
  current: vi.fn(() => null),
  submitCode: vi.fn(),
  cancel: vi.fn(),
  endedAt: vi.fn(() => null),
};
vi.mock("../llm-login/login-wiring.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../llm-login/login-wiring.js")>()),
  getServiceLoginAttempts: () => registrySpy,
  startServiceLoginRecovery: () => Promise.resolve(),
}));

import { createRoutes } from "../routes.js";
import { _resetForTest } from "../auth-manager.js";
import {
  LOGIN_RESULT_VISIBLE_MS,
  loginOriginAllowed,
  registerLoginRoutes,
  toRestLoginAttempt,
  type LoginRegistry,
  type LoginRoutesDeps,
} from "./login-routes.js";

/**
 * Sign-in REST (phase 2 plan task 8; S1-AC4, Boundary "every sign-in action is
 * an authenticated Aura session + Origin check"). What is pinned:
 * - D9: the Aura token is required EVEN FROM LOCALHOST — the shared `/api`
 *   localhost bypass does not apply; without it the registry is never touched
 *   (no sign-in process is started);
 * - a present foreign Origin, `Origin: null`, or a non-JSON POST → refused
 *   even with the token; no Origin (the CLI) and the tab's own origin pass;
 * - a second start returns the running attempt (`existing: true`);
 * - the link/code appear only while `awaiting_user`; a finished attempt is
 *   readable without them, then disappears after LOGIN_RESULT_VISIBLE_MS;
 * - a stale attempt id → 409 attempt_mismatch; a Codex reply code → 400
 *   no_code_step; a provider refusal → 200 + state "failed" (never 401/403);
 * - every response is `Cache-Control: no-store`.
 */

const TOKEN = "login-route-test-token-1234567890abcdef";
const originalToken = process.env.COMPANION_AUTH_TOKEN;
afterEach(() => {
  if (originalToken === undefined) delete process.env.COMPANION_AUTH_TOKEN;
  else process.env.COMPANION_AUTH_TOKEN = originalToken;
  _resetForTest();
  vi.clearAllMocks();
});

const localhostEnv = { requestIP: () => ({ address: "127.0.0.1" }) };
const ID = "0123456789abcdef0123456789abcdef";
const SECRET_URL = "https://claude.ai/oauth/authorize?code=true&state=SYNTH-CANARY-route-state";

describe("D9: the Aura token is required on sign-in routes, also from localhost", () => {
  it("localhost without a token → 401 and no sign-in process is started (real router)", async () => {
    process.env.COMPANION_AUTH_TOKEN = TOKEN;
    const root = new Hono();
    root.route("/api", createRoutes({} as never, {} as never, {} as never, {} as never));

    // Sanity: the shared localhost bypass is live for other routes.
    const other = await root.request("http://localhost:3456/api/llm-auth/status", {}, localhostEnv);
    expect(other.status).not.toBe(401);

    const endpoints = [
      ["POST", "/llm-auth/login/claude"], ["POST", "/llm-auth/login/codex"],
      ["GET", "/llm-auth/login/claude"],
      ["POST", `/llm-auth/login/claude/${ID}/code`], ["POST", `/llm-auth/login/claude/${ID}/cancel`],
    ] as const;
    for (const [method, path] of endpoints) {
      for (const env of [localhostEnv, undefined]) {
        const res = await root.request(`http://localhost:3456/api${path}`, {
          method,
          headers: { "Content-Type": "application/json", ...(env ? {} : { "X-Forwarded-For": "203.0.113.9" }) },
          body: method === "POST" ? JSON.stringify({ code: "x#y" }) : undefined,
        }, env);
        expect(res.status, `${method} ${path} ${env ? "localhost" : "remote"}`).toBe(401);
      }
    }
    expect(registrySpy.start).not.toHaveBeenCalled();
    expect(registrySpy.current).not.toHaveBeenCalled();
    expect(registrySpy.submitCode).not.toHaveBeenCalled();
    expect(registrySpy.cancel).not.toHaveBeenCalled();

    // With the token (Bearer or the browser's cookie) the same router answers.
    registrySpy.current.mockReturnValue(null);
    for (const headers of [{ Authorization: `Bearer ${TOKEN}` }, { Cookie: `companion_auth=${TOKEN}` }] as Record<string, string>[]) {
      const ok = await root.request("http://localhost:3456/api/llm-auth/login/claude", { headers }, localhostEnv);
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ attempt: null });
    }
    expect(registrySpy.start).not.toHaveBeenCalled();
  });
});

// ─── Unit layer: guard + response shapes over a scripted registry ─────────────

function attempt(over: Partial<LoginAttempt> = {}): LoginAttempt {
  return {
    id: ID, provider: "claude", state: "awaiting_user", version: 2, startedAt: 1_000, expiresAt: 601_000,
    prompt: { provider: "claude", url: SECRET_URL, state: "SYNTH-CANARY-route-state" },
    failure: null, codeError: null, submissions: 0, submitting: false, result: null,
    ...over,
  };
}

function fakeRegistry(over: Partial<LoginRegistry> = {}): LoginRegistry & { [K in keyof LoginRegistry]: ReturnType<typeof vi.fn> } {
  return {
    start: vi.fn(async () => ({ kind: "started" as const, attempt: attempt() })),
    current: vi.fn(() => attempt()),
    submitCode: vi.fn(async () => ({ kind: "submitted" as const, attempt: attempt({ submitting: true, submissions: 1 }) })),
    cancel: vi.fn(async () => attempt({ state: "cancelled", prompt: null })),
    endedAt: vi.fn(() => null),
    ...over,
  } as never;
}

function app(registry: LoginRegistry, over: Partial<LoginRoutesDeps> = {}) {
  const api = new Hono();
  registerLoginRoutes(api, {
    attempts: () => registry,
    hasAuraToken: (c) => c.req.header("Authorization") === `Bearer ${TOKEN}`,
    allowedOrigins: new Set(["https://aura.example"]),
    ...over,
  }, MAX_CODE_SUBMISSIONS);
  const root = new Hono();
  root.route("/api", api);
  return root;
}

const auth = { Authorization: `Bearer ${TOKEN}` };
const json = { ...auth, "Content-Type": "application/json" };

describe("guard: Origin, JSON-only POST, no-store", () => {
  it("refuses a foreign Origin and Origin: null on every route — with a valid token", async () => {
    const reg = fakeRegistry();
    const root = app(reg);
    for (const origin of ["https://evil.example", "null"]) {
      for (const [method, path] of [["POST", "/llm-auth/login/claude"], ["GET", "/llm-auth/login/claude"], ["POST", `/llm-auth/login/claude/${ID}/cancel`]] as const) {
        const res = await root.request(`http://localhost:3456/api${path}`, { method, headers: { ...json, Origin: origin }, body: method === "POST" ? "{}" : undefined });
        expect(res.status, `${origin} ${method} ${path}`).toBe(403);
      }
    }
    expect(reg.start).not.toHaveBeenCalled();
    expect(reg.cancel).not.toHaveBeenCalled();
  });

  it("allows no Origin (CLI), the tab's own origin and COMPANION_ALLOWED_ORIGIN", async () => {
    const root = app(fakeRegistry());
    for (const headers of [json, { ...json, Origin: "http://localhost:3456" }, { ...json, Origin: "https://aura.example" }]) {
      const res = await root.request("http://localhost:3456/api/llm-auth/login/claude", { method: "POST", headers, body: "{}" });
      expect(res.status).toBe(201);
    }
  });

  it("refuses a text/plain (form-able, preflight-free) POST", async () => {
    const reg = fakeRegistry();
    const res = await app(reg).request("http://localhost:3456/api/llm-auth/login/claude", {
      method: "POST", headers: { ...auth, "Content-Type": "text/plain" }, body: "{}",
    });
    expect(res.status).toBe(415);
    expect(reg.start).not.toHaveBeenCalled();
  });

  it("marks every response no-store, including refusals", async () => {
    const root = app(fakeRegistry());
    const ok = await root.request("http://localhost:3456/api/llm-auth/login/claude", { headers: auth });
    expect(ok.headers.get("Cache-Control")).toBe("no-store");
    const refused = await root.request("http://localhost:3456/api/llm-auth/login/claude");
    expect(refused.status).toBe(401);
    expect(refused.headers.get("Cache-Control")).toBe("no-store");
  });

  it("loginOriginAllowed: absent ok, null refused, own origin ok, dev origin ok, foreign refused", () => {
    expect(loginOriginAllowed(undefined, "http://localhost:3456/x", new Set())).toBe(true);
    expect(loginOriginAllowed("null", "http://localhost:3456/x", new Set())).toBe(false);
    expect(loginOriginAllowed("http://localhost:3456", "http://localhost:3456/x", new Set())).toBe(true);
    expect(loginOriginAllowed("http://localhost:5174", "http://localhost:3456/x", new Set())).toBe(true);
    expect(loginOriginAllowed("http://localhost:3999", "http://localhost:3456/x", new Set())).toBe(false);
  });
});

describe("routes", () => {
  it("start: 201 started, 200 existing (S1-AC4), 429 cooldown with Retry-After", async () => {
    const reg = fakeRegistry();
    const root = app(reg);
    const post = () => root.request("http://localhost:3456/api/llm-auth/login/claude", { method: "POST", headers: json, body: "{}" });
    const first = await post();
    expect(first.status).toBe(201);
    expect((await first.json()).existing).toBe(false);

    reg.start.mockResolvedValueOnce({ kind: "existing", attempt: attempt() });
    const second = await post();
    expect(second.status).toBe(200);
    const body = await second.json();
    expect(body.existing).toBe(true);
    expect(body.attempt.id).toBe(ID);

    reg.start.mockResolvedValueOnce({ kind: "cooldown", retryAfterMs: 4_200, attempt: null });
    const cool = await post();
    expect(cool.status).toBe(429);
    expect(cool.headers.get("Retry-After")).toBe("5");
  });

  it("phase 2d: verifying / succeeded carry the live-session counts; other states never do", async () => {
    // The sign-in window says "waiting for N turns" during the Claude barrier
    // and "N sessions move to the new sign-in; M wait for Retry" after it.
    // Counts only — no session ids, nothing secret.
    const counts = { waitingForTurn: 1, reconnecting: 2, busyAtPromotion: 0, awaitingRetry: 1, credentialsReplaced: false };
    const renewalSummary = vi.fn(() => counts);
    const get = async (state: LoginAttempt["state"]) => {
      const reg = fakeRegistry({ current: vi.fn(() => attempt({ state, prompt: null })) });
      const res = await app(reg, { renewalSummary }).request("http://localhost:3456/api/llm-auth/login/claude", { headers: json });
      return (await res.json()).attempt;
    };
    expect((await get("verifying")).renewal).toEqual(counts);
    expect((await get("succeeded")).renewal).toEqual(counts);
    expect((await get("awaiting_user")).renewal).toBeUndefined();
    expect((await get("failed")).renewal).toBeUndefined();
  });

  it("start awaits the startup recovery before touching the registry", async () => {
    const order: string[] = [];
    let release!: () => void;
    const ready = new Promise<void>((r) => { release = r; });
    const reg = fakeRegistry({ start: vi.fn(async () => { order.push("start"); return { kind: "started" as const, attempt: attempt() }; }) });
    const root = app(reg, { ready: () => ready.then(() => { order.push("ready"); }) });
    const pending = root.request("http://localhost:3456/api/llm-auth/login/claude", { method: "POST", headers: json, body: "{}" });
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual([]);
    release();
    expect((await pending).status).toBe(201);
    expect(order).toEqual(["ready", "start"]);
  });

  // dahl #8: a hung startup recovery must not hang every start request.
  it("start answers a typed 503 recovery_pending when the startup recovery does not finish in time", async () => {
    const reg = fakeRegistry();
    const root = app(reg, { ready: () => new Promise<void>(() => {}), readyTimeoutMs: 30 });
    const res = await root.request("http://localhost:3456/api/llm-auth/login/claude", { method: "POST", headers: json, body: "{}" });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "recovery_pending" });
    expect(reg.start).not.toHaveBeenCalled();
  });

  it("a reply-code body far bigger than any code is refused before it is parsed", async () => {
    const reg = fakeRegistry();
    const big = JSON.stringify({ code: "x".repeat(20_000) });
    const res = await app(reg).request(`http://localhost:3456/api/llm-auth/login/claude/${ID}/code`, {
      method: "POST", headers: { ...json, "Content-Length": String(big.length) }, body: big,
    });
    expect(res.status).toBe(413);
    expect(reg.submitCode).not.toHaveBeenCalled();
  });

  it("a preflight refusal is 200 + state failed, never 401/403", async () => {
    const reg = fakeRegistry({ start: vi.fn(async () => ({ kind: "refused" as const, attempt: attempt({ state: "failed", failure: "wrong_service_user", prompt: null }) })) });
    const res = await app(reg).request("http://localhost:3456/api/llm-auth/login/codex", { method: "POST", headers: json, body: "{}" });
    expect(res.status).toBe(200);
    expect((await res.json()).attempt).toMatchObject({ state: "failed", failure: "wrong_service_user" });
  });

  it("unknown provider → 400; malformed attempt id → 400; stale attempt id → 409 attempt_mismatch", async () => {
    const reg = fakeRegistry();
    const root = app(reg);
    expect((await root.request("http://localhost:3456/api/llm-auth/login/gemini", { headers: auth })).status).toBe(400);
    expect((await root.request("http://localhost:3456/api/llm-auth/login/claude/../x/cancel", { method: "POST", headers: json, body: "{}" })).status).not.toBe(200);
    expect((await root.request("http://localhost:3456/api/llm-auth/login/claude/NOT-AN-ID/cancel", { method: "POST", headers: json, body: "{}" })).status).toBe(400);
    const stale = await root.request(`http://localhost:3456/api/llm-auth/login/claude/${"f".repeat(32)}/code`, { method: "POST", headers: json, body: JSON.stringify({ code: "a#b" }) });
    expect(stale.status).toBe(409);
    expect((await stale.json()).error).toBe("attempt_mismatch");
    expect(reg.submitCode).not.toHaveBeenCalled();
  });

  it("Codex has no reply code: 400 no_code_step, the registry is not asked", async () => {
    const reg = fakeRegistry({ current: vi.fn(() => attempt({ provider: "codex", prompt: { provider: "codex", url: "https://auth.openai.com/codex/device", userCode: "ABCD-12345", expiresInMinutes: 15 } })) });
    const res = await app(reg).request(`http://localhost:3456/api/llm-auth/login/codex/${ID}/code`, { method: "POST", headers: json, body: JSON.stringify({ code: "x" }) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("no_code_step");
    expect(reg.submitCode).not.toHaveBeenCalled();
  });

  it("code: refused code keeps the attempt (200 + refused), limit → 429, a missing code → 400", async () => {
    const reg = fakeRegistry();
    const root = app(reg);
    const post = (body: unknown) => root.request(`http://localhost:3456/api/llm-auth/login/claude/${ID}/code`, { method: "POST", headers: json, body: JSON.stringify(body) });
    expect((await post({})).status).toBe(400);
    expect((await post({ code: "x".repeat(600) })).status).toBe(400);
    reg.submitCode.mockResolvedValueOnce({ kind: "refused", reason: "code_format", attempt: attempt({ codeError: "code_format" }) });
    const refused = await post({ code: "nope" });
    expect(refused.status).toBe(200);
    expect(await refused.json()).toMatchObject({ refused: "code_format", attempt: { state: "awaiting_user", codeError: "code_format" } });
    reg.submitCode.mockResolvedValueOnce({ kind: "limit", attempt: attempt({ submissions: MAX_CODE_SUBMISSIONS }) });
    expect((await post({ code: "a#b" })).status).toBe(429);
  });

  it("secrets only while awaiting_user; a finished attempt has none and disappears after the window", async () => {
    let now = 10_000;
    let current = attempt();
    const reg = fakeRegistry({ current: vi.fn(() => current), endedAt: vi.fn(() => (current.state === "succeeded" ? 10_000 : null)) });
    const root = app(reg, { now: () => now });
    const get = async () => (await root.request("http://localhost:3456/api/llm-auth/login/claude", { headers: auth })).json();

    const live = await get();
    expect(live.attempt.prompt).toEqual({ url: SECRET_URL });
    // The Claude state nonce is never echoed as its own field.
    expect(live.attempt.prompt.state).toBeUndefined();

    current = attempt({ state: "succeeded", prompt: null, result: { account: knownField("owner@example.test"), plan: knownField("max") } });
    const done = await get();
    expect(done.attempt.state).toBe("succeeded");
    expect(JSON.stringify(done)).not.toContain("SYNTH-CANARY");

    now = 10_000 + LOGIN_RESULT_VISIBLE_MS + 1;
    expect(await get()).toEqual({ attempt: null });
  });

  it("toRestLoginAttempt drops the prompt outside awaiting_user even if a stale object carries one", () => {
    const view = toRestLoginAttempt(attempt({ state: "verifying" }), MAX_CODE_SUBMISSIONS);
    expect(view.prompt).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain("SYNTH-CANARY");
  });
});

// ─── End to end over the real registry and the FAKE official CLI ──────────────

const FAKE_CLI = join(import.meta.dirname, "..", "llm-login", "fixtures", "fake-login-cli.mjs");

describe("end to end: real registry + fake CLI (never the real one)", () => {
  let dir: string;
  let registry: LoginAttempts;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "login-routes-"));
  });
  afterEach(async () => {
    await registry?.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  function fakeCli(scenario: string): string {
    const path = join(dir, `fake-${scenario}.sh`);
    writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLI}" --scenario=${scenario} "$@"\n`);
    chmodSync(path, 0o755);
    return path;
  }

  function realRegistry(scenario: Partial<Record<ProviderId, string>>): LoginAttempts {
    registry = new LoginAttempts({
      attemptsRoot: join(dir, "attempts"),
      resolveCli: (p) => (scenario[p] ? fakeCli(scenario[p]!) : null),
      platform: "linux",
      callerUser: "svc",
      callerUid: 1000,
      serviceUser: "svc",
      serviceEnv: { PATH: process.env.PATH },
      promote: async (): Promise<PromotionOutcome> => ({ ok: true, account: knownField("synthetic-owner@example.test"), plan: knownField("max") }),
      cooldownMs: 0,
      killGraceMs: 300,
      timeoutBinary: null,
    });
    return registry;
  }

  async function poll(root: Hono, provider: ProviderId, until: (a: { state: string } | null) => boolean) {
    const deadline = Date.now() + 8_000;
    for (;;) {
      const body = await (await root.request(`http://localhost:3456/api/llm-auth/login/${provider}`, { headers: auth })).json();
      if (until(body.attempt)) return body.attempt;
      if (Date.now() > deadline) throw new Error(`timeout; last ${JSON.stringify(body.attempt?.state)}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  it("Claude: start → link → second start is the same attempt → code → succeeded, no link afterwards", async () => {
    const root = app(realRegistry({ claude: "success" }));
    const started = await root.request("http://localhost:3456/api/llm-auth/login/claude", { method: "POST", headers: json, body: "{}" });
    expect(started.status).toBe(201);
    const awaiting = await poll(root, "claude", (a) => a?.state === "awaiting_user");
    expect(awaiting.prompt.url).toMatch(/^https:\/\//);
    expect(awaiting.steps).toEqual({ replyCode: true, deviceCode: false });

    const again = await root.request("http://localhost:3456/api/llm-auth/login/claude", { method: "POST", headers: json, body: "{}" });
    expect(again.status).toBe(200);
    expect((await again.json()).attempt.id).toBe(awaiting.id);

    const state = new URL(awaiting.prompt.url).searchParams.get("state");
    const code = await root.request(`http://localhost:3456/api/llm-auth/login/claude/${awaiting.id}/code`, {
      method: "POST", headers: json, body: JSON.stringify({ code: `SYNTHCODE#${state}` }),
    });
    expect(code.status).toBe(200);
    const done = await poll(root, "claude", (a) => a?.state === "succeeded");
    expect(done.prompt).toBeUndefined();
    expect(JSON.stringify(done)).not.toContain(awaiting.prompt.url);
    expect(done.result.account).toEqual({ known: true, value: "synthetic-owner@example.test" });
  });

  it("Codex: start → device code → cancel → cancelled, no secrets", async () => {
    const root = app(realRegistry({ codex: "wait" }));
    await root.request("http://localhost:3456/api/llm-auth/login/codex", { method: "POST", headers: json, body: "{}" });
    const awaiting = await poll(root, "codex", (a) => a?.state === "awaiting_user");
    expect(awaiting.prompt.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{5}$/);
    expect(awaiting.steps).toEqual({ replyCode: false, deviceCode: true });
    const cancel = await root.request(`http://localhost:3456/api/llm-auth/login/codex/${awaiting.id}/cancel`, { method: "POST", headers: json, body: "{}" });
    expect(cancel.status).toBe(200);
    const body = await cancel.json();
    expect(body.attempt.state).toBe("cancelled");
    expect(JSON.stringify(body)).not.toContain(awaiting.prompt.userCode);
  });
});
