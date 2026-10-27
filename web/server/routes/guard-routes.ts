import type { Hono } from "hono";
import type { WsBridge } from "../ws-bridge.js";
import {
  allowOnceRetryPrompt,
  guardAllowOnceBlocker,
  writeGuardAllowEntry,
} from "../guard-denial.js";

/**
 * "Allow once" / "Dismiss" for guards-pack hook denials (Claude-only — see
 * guard-denial.ts). Registered on the authenticated `/api` router.
 *
 * Security: the command that gets approved is the one the SERVER recorded
 * from the agent's tool_use; the browser only sends the toolUseId. Each denial
 * can be resolved once; the allow entry is single-use and expires in 5 min.
 */
export function registerGuardRoutes(
  api: Hono,
  deps: {
    wsBridge: Pick<WsBridge, "getSession" | "getGuardDenial" | "resolveGuardDenial" | "injectUserMessage">;
    /** Test seam: allow-store directory (default ~/.companion/guards-allow). */
    allowDir?: string;
    now?: () => number;
  },
): void {
  const now = deps.now ?? (() => Date.now());

  const readToolUseId = async (c: { req: { json: <T>() => Promise<T> } }): Promise<string | null> => {
    const body = await c.req.json<{ toolUseId?: unknown }>().catch(() => ({} as { toolUseId?: unknown }));
    const id = typeof body?.toolUseId === "string" ? body.toolUseId.trim() : "";
    return id && id.length <= 200 ? id : null;
  };

  api.post("/sessions/:id/guard-allow-once", async (c) => {
    const sessionId = c.req.param("id");
    const session = deps.wsBridge.getSession(sessionId);
    if (!session) return c.json({ error: "Session not found" }, 404);
    const toolUseId = await readToolUseId(c);
    if (!toolUseId) return c.json({ error: "toolUseId is required" }, 400);

    // Everything below is synchronous: check → write → resolve cannot interleave
    // with a second request, so a double click can never write two entries.
    const t = now();
    const denial = deps.wsBridge.getGuardDenial(sessionId, toolUseId);
    const blocker = guardAllowOnceBlocker(denial, t);
    if (blocker || !denial || !denial.command) {
      const status = blocker === "not_found" ? 404 : 409;
      return c.json({ error: `Cannot allow once: ${blocker ?? "no_command"}`, reason: blocker }, status);
    }
    try {
      writeGuardAllowEntry({
        rules: denial.rules,
        command: denial.command,
        cwd: session.state.cwd || "",
        now: t,
        dir: deps.allowDir,
      });
    } catch (err) {
      console.error(`[guard-routes] failed to write allow entry for ${sessionId}:`, err);
      return c.json({ error: "Failed to record the approval" }, 500);
    }
    deps.wsBridge.resolveGuardDenial(sessionId, toolUseId, "allowed", t);
    deps.wsBridge.injectUserMessage(sessionId, allowOnceRetryPrompt(denial.command), "server:rest");
    return c.json({ ok: true, status: "allowed" });
  });

  api.post("/sessions/:id/guard-dismiss", async (c) => {
    const sessionId = c.req.param("id");
    if (!deps.wsBridge.getSession(sessionId)) return c.json({ error: "Session not found" }, 404);
    const toolUseId = await readToolUseId(c);
    if (!toolUseId) return c.json({ error: "toolUseId is required" }, 400);
    const denial = deps.wsBridge.getGuardDenial(sessionId, toolUseId);
    if (!denial) return c.json({ error: "Denial not found" }, 404);
    if (!deps.wsBridge.resolveGuardDenial(sessionId, toolUseId, "dismissed", now())) {
      return c.json({ error: "Already resolved", reason: "already_resolved" }, 409);
    }
    return c.json({ ok: true, status: "dismissed" });
  });
}
