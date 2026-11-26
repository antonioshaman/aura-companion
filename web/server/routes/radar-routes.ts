import type { Hono } from "hono";
import { RadarRunner } from "../radar/radar-runner.js";
import { RadarStore } from "../radar/radar-store.js";
import { parseRadarConfig } from "../radar/radar-types.js";

/** Registered only after the API auth + mutation Origin middleware. */
export function registerRadarRoutes(api: Hono, runner: RadarRunner, store: RadarStore): void {
  api.get("/radar", c => { try { return c.json(runner.view()); } catch { return c.json({ error: "Не удалось прочитать Радар" }, 503); } });
  api.post("/radar/run", async c => {
    try { return c.json(await runner.run()); }
    catch { return c.json({ error: "Проверка недоступна: уже идёт, действует пауза или хранилище недоступно" }, 409); }
  });
  api.put("/radar/config", async c => {
    try { const config = parseRadarConfig(await c.req.json()); const s = store.read(); store.write({ ...s, config }); return c.json(runner.view()); }
    catch { return c.json({ error: "Настройки не сохранены: проверьте источники и доступность хранилища" }, 400); }
  });
  api.post("/radar/decisions", async c => {
    try {
      const body: unknown = await c.req.json();
      if (!body || typeof body !== "object") throw new Error();
      const { id, decision } = body as Record<string, unknown>;
      if (typeof id !== "string" || typeof decision !== "string" || !["dismissed", "implemented", "restore"].includes(decision)) throw new Error();
      store.decide(id, decision as "dismissed" | "implemented" | "restore"); return c.json(runner.view());
    } catch { return c.json({ error: "Решение не сохранено" }, 400); }
  });
}
