import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { registerGuardRoutes } from "./guard-routes.js";
import type { GuardDenial } from "../guard-denial.js";

/**
 * REST "Allow once" / "Dismiss" for guards-pack denials. Validates: unknown
 * session → 404, missing toolUseId → 400, unknown denial → 404, deny-level /
 * expired / already-resolved / no-command → 409 with NO allow entry written,
 * and the happy path writes exactly one entry for the SERVER-recorded command
 * (a command in the request body is ignored), resolves, and injects a retry.
 * The allow store is a temp dir — never the real ~/.companion.
 */

const NOW = 1_800_000_000_000;

function denial(over: Partial<GuardDenial> = {}): GuardDenial {
  return {
    sessionId: "s1", toolUseId: "t1", toolName: "Bash", rule: "service-restart", rules: ["service-restart"],
    level: "ask", reason: "[guards:service-restart] x", command: "systemctl restart api",
    deniedAt: NOW - 1000, status: "pending", ...over,
  };
}

let dir: string;
let current: GuardDenial | undefined;
let bridge: {
  getSession: ReturnType<typeof vi.fn>;
  getGuardDenial: ReturnType<typeof vi.fn>;
  resolveGuardDenial: ReturnType<typeof vi.fn>;
  injectUserMessage: ReturnType<typeof vi.fn>;
};
let app: Hono;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "guard-routes-"));
  current = denial();
  bridge = {
    getSession: vi.fn((id: string) => (id === "s1" ? { state: { cwd: "/proj" } } : undefined)),
    getGuardDenial: vi.fn(() => current),
    resolveGuardDenial: vi.fn((_s: string, _t: string, status: "allowed" | "dismissed") => {
      if (!current || current.status !== "pending") return false;
      current.status = status;
      return true;
    }),
    injectUserMessage: vi.fn(),
  };
  app = new Hono();
  registerGuardRoutes(app, { wsBridge: bridge as any, allowDir: join(dir, "guards-allow"), now: () => NOW });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const post = (path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const entries = () => (existsSync(join(dir, "guards-allow")) ? readdirSync(join(dir, "guards-allow")).filter((n) => n.endsWith(".json")) : []);

describe("POST /sessions/:id/guard-allow-once", () => {
  it("writes one entry for the recorded command, resolves, injects the retry prompt", async () => {
    const res = await post("/sessions/s1/guard-allow-once", { toolUseId: "t1", command: "rm -rf /" });
    expect(res.status).toBe(200);
    expect(entries()).toHaveLength(1);
    expect(bridge.resolveGuardDenial).toHaveBeenCalledWith("s1", "t1", "allowed", NOW);
    expect(bridge.injectUserMessage).toHaveBeenCalledTimes(1);
    const [sid, text, origin] = bridge.injectUserMessage.mock.calls[0];
    expect([sid, origin]).toEqual(["s1", "server:rest"]);
    expect(text).toContain("systemctl restart api");
    expect(text).not.toContain("rm -rf /");
  });

  it("404 for an unknown session, 400 without toolUseId, 404 for an unknown denial", async () => {
    expect((await post("/sessions/nope/guard-allow-once", { toolUseId: "t1" })).status).toBe(404);
    expect((await post("/sessions/s1/guard-allow-once", {})).status).toBe(400);
    current = undefined;
    expect((await post("/sessions/s1/guard-allow-once", { toolUseId: "t1" })).status).toBe(404);
    expect(entries()).toHaveLength(0);
  });

  it.each([
    ["deny-level", { level: "deny" as const }],
    ["expired", { deniedAt: NOW - 11 * 60_000 }],
    ["already resolved", { status: "dismissed" as const }],
    ["no recorded command", { command: null }],
  ])("409 and no entry when %s", async (_name, over) => {
    current = denial(over);
    const res = await post("/sessions/s1/guard-allow-once", { toolUseId: "t1" });
    expect(res.status).toBe(409);
    expect(entries()).toHaveLength(0);
    expect(bridge.injectUserMessage).not.toHaveBeenCalled();
  });

  it("a second press is rejected (single use)", async () => {
    expect((await post("/sessions/s1/guard-allow-once", { toolUseId: "t1" })).status).toBe(200);
    expect((await post("/sessions/s1/guard-allow-once", { toolUseId: "t1" })).status).toBe(409);
    expect(entries()).toHaveLength(1);
    expect(bridge.injectUserMessage).toHaveBeenCalledTimes(1);
  });
});

describe("POST /sessions/:id/guard-dismiss", () => {
  it("marks the denial dismissed without writing an entry; a repeat is 409", async () => {
    expect((await post("/sessions/s1/guard-dismiss", { toolUseId: "t1" })).status).toBe(200);
    expect(bridge.resolveGuardDenial).toHaveBeenCalledWith("s1", "t1", "dismissed", NOW);
    expect(entries()).toHaveLength(0);
    expect((await post("/sessions/s1/guard-dismiss", { toolUseId: "t1" })).status).toBe(409);
  });
});
