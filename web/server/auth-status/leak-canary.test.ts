/**
 * Leak canary (LLM auth phase 1, task 15; spec Boundaries "Токены, ключи и
 * содержимое учётных данных никогда не попадают в UI, логи, вывод CLI и
 * записи протокола"; S2-AC3/AC4).
 *
 * A temp HOME is filled with GENERATED credentials (Claude `.credentials.json`,
 * Codex `auth.json`, independent copies in root's and another user's home,
 * settings API keys) that all carry one random marker. Then the real code
 * runs end to end — status probes spawning fake `claude` / `codex` scripts
 * (which also print the marker as adversarial noise), the status core
 * persisting its last check, the doctor scanning the fake homes, the REST
 * routes, the `aura-companion auth status` / `doctor` CLI (`--json` and
 * text, server and offline), and turn failures whose provider text echoes a
 * token — and the marker must appear in none of: REST bodies, CLI stdout,
 * any console/log line, the persisted status file, the doctor's file reads,
 * the browser `error` frames, and the recorder's JSONL.
 *
 * No real credential is read or copied; the network is mocked.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

if (typeof globalThis.Bun === "undefined") {
  (globalThis as any).Bun = {
    hash(input: string | Uint8Array): number {
      const s = typeof input === "string" ? input : new TextDecoder().decode(input);
      let h = 0;
      for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
      return h >>> 0;
    },
  };
}

const MARK = `LEAKCANARY${randomBytes(8).toString("hex")}`;
const ROOT = mkdtempSync(join(tmpdir(), "aura-leak-canary-"));
const BIN = join(ROOT, "bin");

// Settings carry marker keys too (a key in settings must never be echoed).
vi.mock("../settings-manager.js", () => ({
  getSettings: () => ({
    claudeCodeOAuthToken: "",
    // Empty so Claude takes the subscription path and really probes with the file token.
    anthropicApiKey: "",
    openaiApiKey: `sk-proj-${MARK}settingskey`,
    aiValidationEnabled: false,
    aiValidationAutoApprove: false,
    aiValidationAutoDeny: false,
  }),
  DEFAULT_ANTHROPIC_MODEL: "claude-sonnet-4-6",
}));
// Service-mode binary resolution → the fake scripts only, never a real CLI.
vi.mock("../path-resolver.js", async (orig) => ({
  ...(await orig<typeof import("../path-resolver.js")>()),
  resolveBinary: (name: string) => join(BIN, name),
}));
// The token-free usage request is the only network call; it receives the
// synthetic token and answers "rejected" without touching the network.
const usageCalls: string[] = [];
vi.mock("./claude-usage-request.js", async (orig) => ({
  ...(await orig<typeof import("./claude-usage-request.js")>()),
  requestClaudeUsage: async (token: string) => {
    usageCalls.push(token);
    return { kind: "rejected" as const, status: 401 };
  },
}));

import { createAuthStatusCore } from "./service-status.js";
import { createDoctorDeps, DoctorRunner } from "./doctor-service.js";
import { runDoctorChecks } from "./doctor-checks.js";
import { _resetRotationGuardForTests } from "./provider-probes.js";
import { registerAuthStatusRoutes } from "../routes/auth-status-routes.js";
import { runAuthStatusCommand, runDoctorCommand, type CliAuthDeps } from "../../bin/cli-auth.js";
import { ClaudeAdapter } from "../claude-adapter.js";
import { CodexAdapter, StdioTransport } from "../codex-adapter.js";
import { SessionRecorder } from "../recorder.js";
import { log } from "../logger.js";
import type { BrowserIncomingMessage } from "../session-types.js";
import { LAST_CHECK_FILE, type StatusCore } from "./status-core.js";

const SVC_HOME = join(ROOT, "home", "svc");
const COMPANION = join(SVC_HOME, ".companion");
const NOW = Date.now();

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}
function jwt(claims: Record<string, unknown>): string {
  return `${b64url({ alg: "none" })}.${b64url(claims)}.${MARK}sig`;
}
function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
}

const claudeCreds = () => ({
  claudeAiOauth: {
    accessToken: `sk-ant-oat01-${MARK}access`,
    refreshToken: `sk-ant-ort01-${MARK}refresh`,
    expiresAt: NOW + 3_600_000,
    scopes: ["user:inference"],
    subscriptionType: "max",
  },
});
const codexAuth = () => ({
  OPENAI_API_KEY: null,
  tokens: {
    id_token: jwt({ email: "svc@example.invalid", "https://api.openai.com/auth": { chatgpt_plan_type: "plus" } }),
    access_token: jwt({ exp: Math.floor((NOW + 3_600_000) / 1000), leak: MARK }),
    refresh_token: `${MARK}refresh`,
    account_id: `${MARK}account`,
  },
  last_refresh: new Date(NOW - 60_000).toISOString(),
});

function script(name: string, body: string): void {
  const path = join(BIN, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

/** Every line printed through console.* (where `log.*` ends up). */
const printed: string[] = [];
function captureConsole(): void {
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      printed.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a) ?? String(a))).join(" "));
    });
  }
}

function expectNoMarker(where: string, text: string): void {
  // Report the surface, not the text (which would print the marker).
  expect(text.includes(MARK), `credential marker leaked into ${where}`).toBe(false);
}

let core: StatusCore;
let doctor: DoctorRunner;
const doctorReads: string[] = [];
let app: Hono;

beforeAll(async () => {
  writeJson(join(SVC_HOME, ".claude", ".credentials.json"), claudeCreds());
  writeJson(join(SVC_HOME, ".codex", "auth.json"), codexAuth());
  // Independent copies the doctor must report by path only.
  writeJson(join(ROOT, "root", ".claude", ".credentials.json"), claudeCreds());
  writeJson(join(ROOT, "home", "bob", ".codex", "auth.json"), codexAuth());
  writeJson(join(COMPANION, "codex-home", "sess-1", "auth.json"), codexAuth());

  mkdirSync(BIN, { recursive: true });
  // Fake CLIs: proven versions, normal status output — plus the marker as
  // adversarial noise (stderr / an "API key" line) the parsers must not echo.
  const claudeStatus = JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "svc@example.invalid", orgId: "org", subscriptionType: "max", configDirectory: join(SVC_HOME, ".claude") });
  script("claude", `if [ "$1" = "--version" ]; then echo "2.1.283 (Claude Code)"; exit 0; fi\necho '${claudeStatus}'\necho "debug: Authorization: Bearer ${MARK}" >&2`);
  script("codex", `if [ "$1" = "--version" ]; then echo "codex-cli 0.162.1"; exit 0; fi\necho "Logged in using ChatGPT" >&2\necho "token ${MARK}" >&2`);
  for (const name of ["claude", "codex"]) {
    // A package.json next to the binary is the doctor's only text read.
    writeJson(join(BIN, "..", "lib", name, "package.json"), { version: "0.0.0" });
  }

  vi.stubEnv("HOME", SVC_HOME);
  vi.stubEnv("CODEX_HOME", join(SVC_HOME, ".codex"));
  vi.stubEnv("PATH", `${BIN}:/usr/bin:/bin`);
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.stubEnv("OPENAI_API_KEY", `sk-proj-${MARK}envkey`);
  captureConsole();
  _resetRotationGuardForTests();

  core = createAuthStatusCore({ mode: "service", companionHome: COMPANION });
  const deps = createDoctorDeps({ mode: "service", companionHome: COMPANION });
  doctor = new DoctorRunner(() =>
    runDoctorChecks({
      ...deps,
      homesRoot: join(ROOT, "home"),
      rootHome: join(ROOT, "root"),
      readTextFile: (p) => {
        doctorReads.push(p);
        return deps.readTextFile(p);
      },
    }),
  );
  app = new Hono();
  registerAuthStatusRoutes(app, { statusCore: () => core, doctor: () => doctor, serviceHome: SVC_HOME });
});

afterAll(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(ROOT, { recursive: true, force: true });
});

// macOS reads the Claude token from the login Keychain, not from the file
// (credential-locator.ts), so the synthetic file would not be used — and the
// probe would touch the developer's real Keychain. The file-based canary is
// Linux-only (the server target); the turn-failure part below is portable.
describe.skipIf(process.platform === "darwin")("leak canary: synthetic credentials never leave as content", () => {
  it("REST /api/llm-auth/* (status, per-provider, recheck, doctor) carries no credential content", async () => {
    const bodies: string[] = [];
    for (const [method, path] of [
      ["POST", "/llm-auth/recheck"],
      ["GET", "/llm-auth/status"],
      ["GET", "/llm-auth/status/claude"],
      ["GET", "/llm-auth/status/codex"],
      ["POST", "/llm-auth/recheck"], // 429 path carries the cached status too
      ["POST", "/llm-auth/doctor/recheck"],
      ["GET", "/llm-auth/doctor"],
    ] as const) {
      const res = await app.request(path, { method });
      bodies.push(await res.text());
    }
    // The probes really ran on the synthetic files (otherwise the canary proves nothing).
    expect(usageCalls.some((t) => t.includes(MARK))).toBe(true);
    const status = JSON.parse(bodies[1]).status;
    expect(status.providers.claude.state).toBe("invalid");
    expect(status.providers.codex.account).toEqual({ known: true, value: "svc@example.invalid" });
    const report = JSON.parse(bodies[6]).report;
    expect(report.providers.claude.findings.some((f: { kind: string }) => f.kind === "credential_copy")).toBe(true);
    bodies.forEach((b, i) => expectNoMarker(`REST response #${i}`, b));
  });

  it("the doctor never reads a credential file (its only text read is a CLI package.json)", () => {
    for (const p of doctorReads) expect(p.endsWith("package.json")).toBe(true);
  });

  it("the persisted last check holds no credential content", () => {
    expectNoMarker("persisted last check", readFileSync(join(COMPANION, LAST_CHECK_FILE), "utf-8"));
  });

  it("`aura-companion auth status` / `doctor` stdout (--json and text, server and offline) carries none", async () => {
    const out: string[] = [];
    const deps: CliAuthDeps = {
      fetchJson: async (path, init) => {
        const res = await app.request(path.replace(/^\/api/, ""), { method: init?.method ?? "GET" });
        return { status: res.status, body: await res.json() };
      },
      localStatus: () => core.get(),
      localDoctor: () => doctor.get(),
      homeOf: (user) => (user === "root" ? join(ROOT, "root") : join(ROOT, "home", user)),
      out: (line) => out.push(line),
    };
    for (const argv of [["--json"], [], ["--json", "--offline"], ["--offline"]]) {
      await runAuthStatusCommand(argv, deps);
      await runDoctorCommand(argv, deps);
    }
    expect(out.join("\n")).toMatch(/Claude/);
    expectNoMarker("CLI stdout", out.join("\n"));
  });

  it("no console / log line printed during any of the above carries it", () => {
    // Sanity: the console capture is live (a log line lands in `printed`).
    log.info("leak-canary", "capture check");
    expect(printed.some((l) => l.includes("capture check"))).toBe(true);
    expectNoMarker("console/log output", printed.join("\n"));
  });
});

describe("leak canary: turn failures whose provider text echoes a token", () => {
  const recordings = join(ROOT, "recordings");

  function recorderFor(sessionId: string, backend: "claude" | "codex"): SessionRecorder {
    mkdirSync(recordings, { recursive: true });
    return new SessionRecorder(sessionId, backend, "/tmp", recordings);
  }

  function errorFrames(messages: BrowserIncomingMessage[]) {
    return messages.filter((m): m is Extract<BrowserIncomingMessage, { type: "error" }> => m.type === "error" && !!m.turnFailure);
  }

  it("Claude 401: the browser error frame and its recording carry no token", () => {
    const echoed = `Invalid bearer token sk-ant-oat01-${MARK}access (Authorization: Bearer ${MARK}x)`;
    const adapter = new ClaudeAdapter("sess-leak-claude");
    adapter.attachWebSocket({ data: { kind: "cli", sessionId: "sess-leak-claude" }, send: vi.fn(), close: vi.fn(), readyState: 1, getBufferedAmount: vi.fn(() => 0) } as any);
    const messages: BrowserIncomingMessage[] = [];
    const rec = recorderFor("sess-leak-claude", "claude");
    adapter.onBrowserMessage((m) => {
      messages.push(m);
      rec.record("out", JSON.stringify(m), "browser");
    });
    adapter.handleRawMessage(
      [
        JSON.stringify({ type: "assistant", message: { id: "m1", type: "message", role: "assistant", model: "<synthetic>", content: [{ type: "text", text: echoed }], stop_reason: "stop_sequence", usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }, parent_tool_use_id: null, error: "authentication_failed", uuid: "u1", session_id: "c1" }),
        JSON.stringify({ type: "result", subtype: "success", is_error: true, api_error_status: 401, terminal_reason: "api_error", result: echoed, duration_ms: 10, uuid: "u2", session_id: "c1" }),
      ].join("\n"),
    );
    const frames = errorFrames(messages);
    expect(frames.map((f) => f.turnFailure!.kind)).toEqual(["auth_rejected"]);
    // Every browser-bound frame, not only the classified error: the
    // synthetic assistant frame and the result echo the same text.
    expectNoMarker("Claude browser frames", JSON.stringify(messages));
    expectNoMarker("Claude recording", readFileSync(rec.filePath, "utf-8"));
  });

  it("Codex unauthorized: the browser error frame and its recording carry no token", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stdin = new WritableStream<Uint8Array>({ write() {} });
    const stdout = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
    const transport = new StdioTransport(stdin, stdout, "sess-leak-codex");
    const adapter = new CodexAdapter(transport, "sess-leak-codex", { model: "gpt-6.1-sol", cwd: "/tmp", credentialGeneration: () => "same" });
    const messages: BrowserIncomingMessage[] = [];
    const rec = recorderFor("sess-leak-codex", "codex");
    adapter.onBrowserMessage((m) => {
      messages.push(m);
      rec.record("out", JSON.stringify(m), "browser");
    });
    const frame = { method: "error", params: { error: { message: `401 Unauthorized: refresh_token=${MARK}r access_token: "${MARK}a"`, codexErrorInfo: "unauthorized", additionalDetails: null }, willRetry: false, threadId: "t", turnId: "u" } };
    controller.enqueue(new TextEncoder().encode(`${JSON.stringify(frame)}\n`));
    await new Promise((r) => setTimeout(r, 30));
    const frames = errorFrames(messages);
    expect(frames.map((f) => f.turnFailure!.kind)).toEqual(["auth_rejected"]);
    expectNoMarker("Codex browser frames", JSON.stringify(messages));
    expectNoMarker("Codex recording", readFileSync(rec.filePath, "utf-8"));
  });

  it("no console / log line printed while classifying carries it", () => {
    expectNoMarker("console/log output (turn failures)", printed.join("\n"));
  });
});
