import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  describeCliSignInTokenMissing,
  describeEffectiveMethod,
  describeLoginAttempt,
  describeLoginFailure,
  describeLoginInProgressElsewhere,
  describeManualSignIn,
  describePlanCheck,
  formatAction,
  formatKnown,
  providerLabel,
} from "../server/auth-status/auth-catalog.js";
import {
  PROVIDER_IDS,
  isTerminalLoginState,
  unknownField,
  type CatalogEntry,
  type ProviderAuthStatus,
  type ProviderId,
} from "../server/auth-status/auth-types.js";
import type { RestLoginAttempt } from "../server/routes/login-routes.js";

/**
 * `aura-companion auth login <claude|codex>` (phase 2 plan task 9, D3/D9).
 *
 * A thin client of the server's sign-in REST — one registry, one promotion:
 * the CLI never runs a sign-in itself. Every text comes from `auth-catalog.ts`,
 * the catalog the UI uses (S1-AC6). The link and the device code are printed
 * while the attempt waits for the owner; nothing secret is printed after the
 * outcome, and a typed reply code is never echoed.
 *
 *  - Server unreachable (or too old) → the manual instruction (D3), exit 1.
 *  - No Aura token (the service user's `~/.companion/auth.json`) or 401 →
 *    "run as the service user", exit 1 (the routes require it even on localhost).
 *  - An attempt started elsewhere → "continue / cancel".
 *  - Ctrl-C → cancel the attempt, exit 130. Success → 0; failure/cancel/expiry → 1.
 *  - `--json` → one JSON line per state change.
 */

export interface CliLoginDeps {
  /** Localhost API call with the Aura token; throws when the server is unreachable. */
  request: (path: string, init: { method?: "GET" | "POST"; body?: unknown; token: string }) => Promise<{ status: number; body: unknown }>;
  readToken: () => string | null;
  /** One line from stdin; null on EOF. */
  readLine: (prompt: string) => Promise<string | null>;
  /** Registers the Ctrl-C handler; returns the unregister function. */
  onInterrupt: (handler: () => void) => () => void;
  sleep: (ms: number) => Promise<void>;
  out: (line: string) => void;
  /** Releases stdin so the process can exit. */
  closeInput?: () => void;
  pollMs?: number;
}

export const LOGIN_EXIT = { ok: 0, failed: 1, interrupted: 130 } as const;

export function loginUsage(): string {
  return `Usage: aura-companion auth login <${PROVIDER_IDS.join("|")}> [--json] [--port <n>]`;
}

function entryLines(entry: CatalogEntry): string[] {
  const lines = [entry.title, `  ${entry.detail}`];
  const action = formatAction(entry.action, "cli");
  if (action) lines.push(`  Action: ${action}`);
  return lines;
}

type Interrupt = { fired: boolean; wake: Promise<void> };

function interruptWatch(deps: CliLoginDeps): { state: Interrupt; dispose: () => void } {
  let wake!: () => void;
  const state: Interrupt = { fired: false, wake: new Promise<void>((r) => { wake = r; }) };
  const dispose = deps.onInterrupt(() => {
    state.fired = true;
    wake();
  });
  return { state, dispose };
}

/** A promise plus its settled value, so the poll loop can race it without losing a line. */
function track<T>(p: Promise<T>): { promise: Promise<void>; done: boolean; value: T | undefined } {
  const t = { promise: Promise.resolve(), done: false, value: undefined as T | undefined };
  t.promise = p.then((v) => { t.value = v; t.done = true; }, () => { t.done = true; });
  return t;
}

export async function runAuthLoginCommand(argv: readonly string[], deps: CliLoginDeps): Promise<number> {
  const json = argv.includes("--json");
  const provider = argv.find((a) => !a.startsWith("--") && (PROVIDER_IDS as readonly string[]).includes(a)) as ProviderId | undefined;
  if (!provider) {
    deps.out(loginUsage());
    return LOGIN_EXIT.failed;
  }
  const print = (entry: CatalogEntry) => (json ? deps.out(JSON.stringify({ provider, message: entry.title, detail: entry.detail })) : entryLines(entry).forEach((l) => deps.out(l)));
  const manual = () => {
    print(describeManualSignIn(provider));
    return LOGIN_EXIT.failed;
  };

  const token = deps.readToken();
  if (!token) {
    print(describeCliSignInTokenMissing(provider));
    return LOGIN_EXIT.failed;
  }

  const base = `/api/llm-auth/login/${provider}`;
  const call = async (path: string, method: "GET" | "POST", body?: unknown) => deps.request(path, { method, body: method === "POST" ? body ?? {} : undefined, token });

  // ─── Find or start the attempt ──────────────────────────────────────────────
  let attempt: RestLoginAttempt | null;
  try {
    const res = await call(base, "GET");
    if (res.status === 401 || res.status === 403) {
      print(describeCliSignInTokenMissing(provider));
      return LOGIN_EXIT.failed;
    }
    if (res.status !== 200) return manual();
    attempt = (res.body as { attempt?: RestLoginAttempt | null } | null)?.attempt ?? null;
  } catch {
    return manual();
  }

  const watch = interruptWatch(deps);
  try {
    if (attempt && !isTerminalLoginState(attempt.state)) {
      print(describeLoginInProgressElsewhere(provider));
      const answer = json ? "" : await deps.readLine("Continue it here [c] or cancel it [x]? ");
      if (answer !== null && /^\s*(x|cancel)\s*$/i.test(answer)) {
        await call(`${base}/${attempt.id}/cancel`, "POST").catch(() => null);
        print(describeLoginAttempt("cancelled", provider));
        return LOGIN_EXIT.failed;
      }
    } else {
      const res = await call(base, "POST");
      const body = res.body as { attempt?: RestLoginAttempt | null; retryAfterMs?: number } | null;
      if (res.status === 401 || res.status === 403) {
        print(describeCliSignInTokenMissing(provider));
        return LOGIN_EXIT.failed;
      }
      if (res.status === 429) {
        const seconds = Math.ceil((body?.retryAfterMs ?? 0) / 1000);
        print({ title: `${providerLabel(provider)}: wait ${seconds} s before signing in again`, detail: "A sign-in just ended.", action: { kind: "none" } });
        return LOGIN_EXIT.failed;
      }
      if ((res.status !== 200 && res.status !== 201) || !body?.attempt) return manual();
      attempt = body.attempt;
    }
    return await follow(provider, attempt, { deps, json, call, base, interrupt: watch.state });
  } catch {
    // The server went away mid-sign-in: the attempt is the server's to end.
    return manual();
  } finally {
    watch.dispose();
    deps.closeInput?.();
  }
}

interface FollowCtx {
  deps: CliLoginDeps;
  json: boolean;
  call: (path: string, method: "GET" | "POST", body?: unknown) => Promise<{ status: number; body: unknown }>;
  base: string;
  interrupt: Interrupt;
}

async function follow(provider: ProviderId, first: RestLoginAttempt, ctx: FollowCtx): Promise<number> {
  const { deps, json, call, base, interrupt } = ctx;
  let attempt = first;
  let shownVersion = -1;
  let shownPrompt = false;
  let shownCodeError: string | null = null;
  let pendingLine: ReturnType<typeof track<string | null>> | null = null;

  for (;;) {
    if (interrupt.fired) {
      const res = await call(`${base}/${attempt.id}/cancel`, "POST").catch(() => null);
      const ended = (res?.body as { attempt?: RestLoginAttempt | null } | null)?.attempt;
      renderState(ended && isTerminalLoginState(ended.state) ? ended : { ...attempt, state: "cancelled" }, ctx, false);
      return LOGIN_EXIT.interrupted;
    }

    if (attempt.version !== shownVersion) {
      shownVersion = attempt.version;
      if (attempt.state === "awaiting_user" && !shownPrompt && attempt.prompt) {
        renderState(attempt, ctx, true);
        shownPrompt = true;
      } else if (attempt.state !== "awaiting_user") {
        renderState(attempt, ctx, false);
      }
      if (attempt.codeError && attempt.codeError !== shownCodeError) {
        renderEntry(describeLoginFailure(attempt.codeError, provider), ctx);
      }
      shownCodeError = attempt.codeError;
    }

    if (isTerminalLoginState(attempt.state)) {
      if (attempt.state === "succeeded") await renderOutcome(provider, ctx);
      return attempt.state === "succeeded" ? LOGIN_EXIT.ok : LOGIN_EXIT.failed;
    }

    // Claude: ask for the reply code while the attempt waits for it.
    if (attempt.state === "awaiting_user" && attempt.steps.replyCode && !attempt.submitting && !pendingLine) {
      pendingLine = track(deps.readLine("Paste the code from the page: "));
    }
    if (pendingLine?.done) {
      const line = pendingLine.value;
      pendingLine = null;
      if (line === null || line === undefined) {
        // stdin closed: nothing more can be typed — end the attempt instead of leaving it waiting.
        interrupt.fired = true;
        continue;
      }
      if (line.trim()) {
        const res = await call(`${base}/${attempt.id}/code`, "POST", { code: line.trim() });
        const next = (res.body as { attempt?: RestLoginAttempt | null } | null)?.attempt;
        if (next) attempt = next;
        if (res.status === 409 && (res.body as { error?: string } | null)?.error === "attempt_mismatch") {
          renderEntry(describeLoginFailure("attempt_mismatch", provider), ctx);
          return LOGIN_EXIT.failed;
        }
        continue;
      }
    }

    await Promise.race([deps.sleep(deps.pollMs ?? 1_500), interrupt.wake, ...(pendingLine ? [pendingLine.promise] : [])]);
    if (interrupt.fired) continue;
    const res = await call(base, "GET");
    const next = (res.body as { attempt?: RestLoginAttempt | null } | null)?.attempt;
    if (!next || next.id !== attempt.id) {
      // The attempt vanished (server restarted) or was replaced elsewhere.
      renderEntry(describeLoginFailure("attempt_mismatch", provider), ctx);
      return LOGIN_EXIT.failed;
    }
    attempt = next;
  }
}

function renderEntry(entry: CatalogEntry, ctx: FollowCtx): void {
  if (ctx.json) ctx.deps.out(JSON.stringify({ message: entry.title, detail: entry.detail }));
  else entryLines(entry).forEach((l) => ctx.deps.out(l));
}

/** One state change. `withPrompt` only for the first awaiting_user render — the one place secrets are printed. */
function renderState(a: RestLoginAttempt, ctx: FollowCtx, withPrompt: boolean): void {
  const entry = a.state === "failed" && a.failure ? describeLoginFailure(a.failure, a.provider) : describeLoginAttempt(a.state, a.provider);
  if (ctx.json) {
    ctx.deps.out(JSON.stringify({
      provider: a.provider, attemptId: a.id, state: a.state, failure: a.failure, codeError: a.codeError,
      expiresAt: a.expiresAt, message: entry.title,
      ...(withPrompt && a.prompt ? { prompt: a.prompt } : {}),
    }));
    return;
  }
  entryLines(entry).forEach((l) => ctx.deps.out(l));
  if (withPrompt && a.prompt) {
    ctx.deps.out(`  Link: ${a.prompt.url}`);
    if (a.prompt.userCode) ctx.deps.out(`  Code: ${a.prompt.userCode}`);
    ctx.deps.out(`  Valid until: ${new Date(a.expiresAt).toISOString()}`);
  }
}

/** Account, plan and warnings after success — the same status fields the UI reads. */
async function renderOutcome(provider: ProviderId, ctx: FollowCtx): Promise<void> {
  const res = await ctx.call(`/api/llm-auth/status/${provider}`, "GET").catch(() => null);
  const status = (res?.body as { status?: ProviderAuthStatus | null } | null)?.status ?? null;
  const account = status?.account ?? unknownField;
  const plan = status?.plan ?? unknownField;
  if (ctx.json) {
    ctx.deps.out(JSON.stringify({
      provider, account, plan,
      planCheck: status?.planCheck ?? null, expectedPlan: status?.expectedPlan ?? null, effectiveMethod: status?.effectiveMethod ?? null,
    }));
    return;
  }
  ctx.deps.out(`  Account: ${formatKnown(account)} · Plan: ${formatKnown(plan)}`);
  if (status?.planCheck && status.planCheck !== "unset") {
    entryLines(describePlanCheck(status.planCheck, provider, status.expectedPlan ?? null, plan)).forEach((l) => ctx.deps.out(l));
  }
  const effective = status?.effectiveMethod;
  if (effective && (effective.source !== "sign_in" || effective.alsoSet)) {
    entryLines(describeEffectiveMethod(effective, provider)).forEach((l) => ctx.deps.out(l));
  }
}

// ─── Production deps ─────────────────────────────────────────────────────────

/**
 * The Aura token the server checks: `COMPANION_AUTH_TOKEN`, else the service
 * user's `~/.companion/auth.json` (HOME from the systemd unit), else the
 * caller's own. Read only — never creates a token (that is `generate-token`).
 */
export function readServiceAuraToken(opts: { env: NodeJS.ProcessEnv; homes: readonly string[] }): string | null {
  const fromEnv = opts.env.COMPANION_AUTH_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  for (const home of opts.homes) {
    const file = join(home, ".companion", "auth.json");
    try {
      if (!existsSync(file)) continue;
      const token = (JSON.parse(readFileSync(file, "utf-8")) as { token?: unknown }).token;
      if (typeof token === "string" && token.trim()) return token.trim();
    } catch {
      // Unreadable (another user's 0600 file) → try the next home; none → "run as the service user".
    }
  }
  return null;
}

export async function defaultCliLoginDeps(port: number): Promise<CliLoginDeps> {
  const { parseSystemdUnit } = await import("../server/auth-status/status-core.js");
  const { readUnitTexts } = await import("../server/auth-status/service-status.js");
  const { createInterface } = await import("node:readline");
  const unit = parseSystemdUnit(readUnitTexts());
  const homes = [unit.env.HOME, process.env.HOME ?? homedir()].filter((h): h is string => Boolean(h));
  let rl: import("node:readline").Interface | null = null;
  const lines: string[] = [];
  let waiter: ((line: string | null) => void) | null = null;
  let closed = false;
  const input = () => {
    if (rl) return rl;
    rl = createInterface({ input: process.stdin, terminal: false });
    rl.on("line", (line) => {
      if (waiter) { const w = waiter; waiter = null; w(line); } else lines.push(line);
    });
    rl.on("close", () => {
      closed = true;
      if (waiter) { const w = waiter; waiter = null; w(null); }
    });
    return rl;
  };
  return {
    request: async (path, init) => {
      const res = await fetch(`http://localhost:${port}${path}`, {
        method: init.method ?? "GET",
        headers: { Authorization: `Bearer ${init.token}`, ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}) },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    readToken: () => readServiceAuraToken({ env: process.env, homes }),
    readLine: (prompt) => {
      process.stdout.write(prompt);
      input();
      if (lines.length) return Promise.resolve(lines.shift()!);
      if (closed) return Promise.resolve(null);
      return new Promise((resolve) => { waiter = resolve; });
    },
    onInterrupt: (handler) => {
      process.on("SIGINT", handler);
      return () => process.off("SIGINT", handler);
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    out: (line) => console.log(line),
    closeInput: () => rl?.close(),
  };
}
