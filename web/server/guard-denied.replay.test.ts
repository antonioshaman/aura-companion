import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// EC-6 replay test for the guards-pack denial path. Feeds the recorded frame
// shape of a guards PreToolUse "ask" under permissionMode bypassPermissions
// (Claude CLI auto-denies → `system/permission_denied` → tool_result) through
// the real WsBridge + ClaudeAdapter and asserts:
//   * the browser receives ONE `guard_denied` with the rule, the reason and the
//     exact Bash command taken from the preceding assistant tool_use,
//   * it is persisted in messageHistory (survives reload) and is history-backed,
//   * a non-guards permission_denied (other hook, other decision source) is
//     tolerated — no drift error, no card (EC-5),
//   * the REST "Allow once" path end to end: signed allow entry written for the
//     server-recorded command, retry prompt injected into the CLI, denial marked
//     resolved and broadcast, a second press rejected (409).

// vitest runs under Node; ws-bridge uses Bun.hash for CLI frame dedup.
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

const mockExecSync = vi.hoisted(() => vi.fn(() => { throw new Error("not a git repo"); }));
vi.mock("node:child_process", () => ({ execSync: mockExecSync }));
vi.mock("./settings-manager.js", () => ({
  getSettings: () => ({
    aiValidationEnabled: false,
    aiValidationAutoApprove: false,
    aiValidationAutoDeny: false,
    anthropicApiKey: "",
  }),
  DEFAULT_ANTHROPIC_MODEL: "claude-sonnet-4-6",
}));

import { readFileSync, readdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { WsBridge } from "./ws-bridge.js";
import { SessionStore } from "./session-store.js";
import { companionBus } from "./event-bus.js";
import { deliveryMetrics } from "./delivery-metrics.js";
import { isHistoryBackedEvent } from "./ws-bridge-replay.js";
import { registerGuardRoutes } from "./routes/guard-routes.js";
import { commandSha256 } from "./guard-denial.js";

interface Fixture {
  command: string;
  toolUseId: string;
  frames: { dir: "in"; raw: Record<string, unknown> }[];
}

const fixture: Fixture = JSON.parse(
  readFileSync(join(__dirname, "__fixtures__/guard-denied/service-restart-bypass.json"), "utf-8"),
);

function mockSocket(data: Record<string, unknown>) {
  return { data, send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
}

function parseSent(sock: { send: { mock: { calls: unknown[][] } } }): Record<string, any>[] {
  const out: Record<string, any>[] = [];
  for (const [arg] of sock.send.mock.calls) {
    for (const line of String(arg).split("\n")) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* not JSON */ }
    }
  }
  return out;
}

let bridge: WsBridge;
let store: SessionStore;
let tempDir: string;
let allowDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "guard-replay-"));
  allowDir = join(tempDir, "home", ".companion", "guards-allow");
  store = new SessionStore(join(tempDir, "sessions"));
  bridge = new WsBridge();
  bridge.setStore(store);
  companionBus.clear();
  deliveryMetrics.reset({ stallThresholdMs: 60_000 });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  deliveryMetrics.reset();
  store.dispose();
  rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function replay(sessionId: string, frames = fixture.frames) {
  const browser = mockSocket({ kind: "browser", sessionId });
  bridge.handleBrowserOpen(browser, sessionId);
  const cli = mockSocket({ kind: "cli", sessionId });
  bridge.handleCLIOpen(cli, sessionId);
  for (const f of frames) bridge.handleCLIMessage(cli, JSON.stringify(f.raw) + "\n");
  return { cli, browser };
}

describe("guards permission_denied replay (recorded bypassPermissions shape)", () => {
  it("emits one guard_denied with the rule, reason and the exact command from the tool_use", () => {
    const { browser } = replay("s-guard");
    const sent = parseSent(browser);
    const denied = sent.filter((m) => m.type === "guard_denied");
    expect(denied).toHaveLength(1);
    const d = denied[0].denial;
    expect(d).toMatchObject({
      sessionId: "s-guard",
      toolUseId: fixture.toolUseId,
      toolName: "Bash",
      rule: "service-restart",
      rules: ["service-restart"],
      // Legacy guards.py text has no "(guards decision:" marker → inferred ask.
      level: "ask",
      command: fixture.command,
      status: "pending",
    });
    expect(d.reason.startsWith("[guards:service-restart] ")).toBe(true);
    // The subtype is mapped — it must not surface as protocol drift.
    expect(sent.filter((m) => m.type === "error" && /drift/i.test(String(m.message)))).toHaveLength(0);
  });

  it("persists the denial in messageHistory and treats it as history-backed", () => {
    replay("s-hist");
    const session = bridge.getSession("s-hist")!;
    const hist = session.messageHistory.filter((m) => m.type === "guard_denied");
    expect(hist).toHaveLength(1);
    expect(isHistoryBackedEvent(hist[0] as any)).toBe(true);
    expect(bridge.getGuardDenial("s-hist", fixture.toolUseId)?.command).toBe(fixture.command);
  });

  it("reads the level from the new guards.py decision marker (deny is never actionable)", () => {
    const frames = fixture.frames.map((f) => {
      if (f.raw.subtype !== "permission_denied") return f;
      return {
        ...f,
        raw: {
          ...f.raw,
          message: "[guards:pkill] `pkill` matches processes by name.\n(guards decision: deny. This cannot be approved once.)",
        },
      };
    });
    const { browser } = replay("s-deny", frames);
    const d = parseSent(browser).find((m) => m.type === "guard_denied")!.denial;
    expect(d.level).toBe("deny");
    expect(d.rule).toBe("pkill");
  });

  it("ignores permission_denied frames that are not guards-pack hook denials (EC-5)", () => {
    const frames = fixture.frames.flatMap((f) => {
      if (f.raw.subtype !== "permission_denied") return [f];
      return [
        { ...f, raw: { ...f.raw, message: "Blocked by my-other-hook" } },
        { ...f, raw: { ...f.raw, decision_reason_type: "rule", message: "[guards:x] looks like guards but not a hook" } },
        { ...f, raw: { type: "system", subtype: "permission_denied" } },
      ];
    });
    const { browser } = replay("s-other", frames);
    const sent = parseSent(browser);
    expect(sent.filter((m) => m.type === "guard_denied")).toHaveLength(0);
    expect(sent.filter((m) => m.type === "error")).toHaveLength(0);
  });

  it("Allow once: writes a signed entry for the recorded command, injects the retry, resolves once", async () => {
    const { cli, browser } = replay("s-allow");
    const api = new Hono();
    registerGuardRoutes(api, { wsBridge: bridge, allowDir });
    const post = (body: unknown) =>
      api.request("/sessions/s-allow/guard-allow-once", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    const res = await post({ toolUseId: fixture.toolUseId, command: "rm -rf /" /* ignored: never trusted */ });
    expect(res.status).toBe(200);

    // Entry: exact recorded command hash, session cwd from the init frame, 0600 in a 0700 dir.
    const files = readdirSync(allowDir).filter((n) => n.endsWith(".json"));
    expect(files).toHaveLength(1);
    const entry = JSON.parse(readFileSync(join(allowDir, files[0]), "utf-8"));
    expect(entry).toMatchObject({
      v: 1,
      rule: "service-restart",
      rules: ["service-restart"],
      commandSha256: commandSha256(fixture.command),
      cwd: "/root/auraengine",
    });
    expect(statSync(join(allowDir, files[0])).mode & 0o777).toBe(0o600);
    expect(statSync(allowDir).mode & 0o777).toBe(0o700);

    // Retry prompt with the exact command reached the CLI.
    const userFrames = parseSent(cli).filter(
      (j) => j.type === "user" && typeof j.message?.content === "string" && j.message.content.includes("approved once"),
    );
    expect(userFrames).toHaveLength(1);
    expect(userFrames[0].message.content).toContain(fixture.command);

    // Resolved in history + broadcast.
    expect(bridge.getGuardDenial("s-allow", fixture.toolUseId)?.status).toBe("allowed");
    expect(parseSent(browser).filter((m) => m.type === "guard_denial_resolved")).toEqual([
      expect.objectContaining({ toolUseId: fixture.toolUseId, status: "allowed" }),
    ]);

    // Second press: rejected, no second entry.
    const again = await post({ toolUseId: fixture.toolUseId });
    expect(again.status).toBe(409);
    expect(readdirSync(allowDir).filter((n) => n.endsWith(".json"))).toHaveLength(1);
  });
});
