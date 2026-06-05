import type { Hono } from "hono";
import type { CliLauncher } from "../cli-launcher.js";
import type { WsBridge } from "../ws-bridge.js";
import type { TerminalManager } from "../terminal-manager.js";
import { getUsageLimits } from "../usage-limits.js";

export function registerSystemRoutes(
  api: Hono,
  deps: {
    launcher: CliLauncher;
    wsBridge: WsBridge;
    terminalManager: TerminalManager;
  },
): void {
  api.get("/usage-limits", async (c) => {
    const limits = await getUsageLimits();
    return c.json(limits);
  });

  api.get("/sessions/:id/usage-limits", async (c) => {
    const sessionId = c.req.param("id");
    const session = deps.wsBridge.getSession(sessionId);
    const empty = { five_hour: null, seven_day: null, extra_usage: null };

    if (session?.backendType === "codex") {
      const rl = deps.wsBridge.getCodexRateLimits(sessionId);
      if (!rl) return c.json(empty);
      const toEpochMs = (value: number): number => (
        value > 0 && value < 1_000_000_000_000 ? value * 1000 : value
      );
      const mapLimit = (l: { usedPercent: number; windowDurationMins: number; resetsAt: number } | null) => {
        if (!l) return null;
        const resetsAtMs = toEpochMs(l.resetsAt);
        return {
          utilization: l.usedPercent,
          resets_at: resetsAtMs ? new Date(resetsAtMs).toISOString() : null,
        };
      };
      return c.json({
        five_hour: mapLimit(rl.primary),
        seven_day: mapLimit(rl.secondary),
        extra_usage: null,
      });
    }

    const limits = await getUsageLimits();
    return c.json(limits);
  });

  api.get("/terminal", (c) => {
    const terminalId = c.req.query("terminalId");
    const info = deps.terminalManager.getInfo(terminalId || undefined);
    if (!info) return c.json({ active: false });
    return c.json({ active: true, terminalId: info.id, cwd: info.cwd });
  });

  api.post("/terminal/spawn", async (c) => {
    const body = await c.req.json<{ cwd: string; cols?: number; rows?: number; containerId?: string }>();
    if (!body.cwd) return c.json({ error: "cwd is required" }, 400);
    const terminalId = deps.terminalManager.spawn(body.cwd, body.cols, body.rows, {
      containerId: body.containerId,
    });
    return c.json({ terminalId });
  });

  api.post("/terminal/kill", async (c) => {
    const body = await c.req.json<{ terminalId?: string }>().catch(() => undefined);
    const terminalId = body?.terminalId?.trim();
    if (!terminalId) return c.json({ error: "terminalId is required" }, 400);
    deps.terminalManager.kill(terminalId);
    return c.json({ ok: true });
  });

  api.post("/sessions/:id/message", async (c) => {
    const id = c.req.param("id");
    const session = deps.launcher.getSession(id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    if (!deps.launcher.isAlive(id)) return c.json({ error: "Session is not running" }, 400);
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.content !== "string" || !body.content.trim()) {
      return c.json({ error: "content is required" }, 400);
    }
    // Council Review #12 (EC-16) — explicit "server:rest" origin so the
    // bridge's userFrameObservers skip this frame (REST-driven turns
    // aren't user activity at the frontend; downstream auto-proceed
    // token must not advance on programmatic injection).
    deps.wsBridge.injectUserMessage(id, body.content, "server:rest");
    return c.json({ ok: true, sessionId: id });
  });
}
