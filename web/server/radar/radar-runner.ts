import { log } from "../logger.js";
import { evaluateFindings } from "./radar-evaluator.js";
import { fetchRadarSource, RadarSourceError } from "./radar-sources.js";
import { RadarStore } from "./radar-store.js";
import { RADAR_CAPABILITIES, type RadarFinding, type RadarSource, type RadarView } from "./radar-types.js";

const DAY = 86_400_000;
export class RadarRunner {
  private active: AbortController | null = null;
  private lastStart = -Infinity;
  private timer?: ReturnType<typeof setInterval>;
  private disposed = false;
  constructor(private readonly store: RadarStore, private readonly acquire: (source: RadarSource, signal: AbortSignal) => Promise<RadarFinding[]> = fetchRadarSource, private readonly now = Date.now) {}
  view(): RadarView {
    const s = this.store.read();
    const interrupted = !this.active && s.lastAttempt !== null && s.lastAttempt > (s.lastSuccess ?? 0) && ["never", "success"].includes(s.outcome);
    return { ...s, ...(interrupted ? { outcome: "error" as const, sourceErrors: ["Предыдущая проверка не завершилась; результаты сохранены."] } : {}), running: this.active !== null, capabilities: RADAR_CAPABILITIES,
      counts: { proposals: s.ideas.filter(i => !s.decisions[i.id]).length, implemented: RADAR_CAPABILITIES.length + Object.values(s.decisions).filter(x => x === "implemented").length } };
  }
  start(): void {
    if (this.timer || this.disposed) return;
    this.timer = setInterval(() => {
      try {
        const s = this.store.read();
        if (s.config.enabled && this.now() - (s.lastAttempt ?? 0) >= DAY) void this.run().catch(() => { log.warn("radar", "scheduled-run-failed", { event: "radar.run_failed" }); });
      } catch { log.warn("radar", "store-unavailable", { event: "radar.store_unavailable" }); }
    }, 60_000);
    this.timer.unref?.();
  }
  dispose(): void { this.disposed = true; clearInterval(this.timer); this.active?.abort(); }
  async run(): Promise<RadarView> {
    if (this.disposed) throw new Error("Радар остановлен");
    if (this.active) throw new Error("Проверка уже идёт");
    if (this.now() - this.lastStart < 60_000) throw new Error("Повторите проверку через минуту");
    const initial = this.store.read();
    const controller = new AbortController();
    this.active = controller;
    this.lastStart = this.now();
    const deadline = setTimeout(() => controller.abort(), 60_000);
    try {
      this.store.write({ ...initial, lastAttempt: this.now() });
      const findings: RadarFinding[] = [];
      const errors: string[] = [];
      let succeeded = 0;
      for (const source of initial.config.sources) {
        if (controller.signal.aborted) { errors.push("Проверка прервана или истекло время"); break; }
        try {
          // Race enforces the deadline even if an adapter fails to honor abort.
          const values = await new Promise<RadarFinding[]>((resolve, reject) => {
            const abort = () => reject(new Error("Истекло время проверки"));
            controller.signal.addEventListener("abort", abort, { once: true });
            this.acquire(source, controller.signal).then(resolve, reject).finally(() => controller.signal.removeEventListener("abort", abort)).catch(() => {});
          });
          findings.push(...values.slice(0, Math.max(0, 100 - findings.length)));
          succeeded++;
        } catch (error) { errors.push(`${source.value}: ${controller.signal.aborted ? "Истекло время проверки" : error instanceof RadarSourceError ? error.message : "Источник недоступен или ограничен"}`); }
      }
      if (this.disposed) return this.view();
      // Re-read decisions/config: concurrent dismissal/settings must survive.
      const current = this.store.read();
      const next = evaluateFindings(findings);
      const merged = new Map(current.ideas.map(i => [i.id, i]));
      for (const idea of next) merged.set(idea.id, idea);
      const ideas = succeeded === initial.config.sources.length ? next : [...merged.values()].slice(0, 100);
      this.store.write({ ...current, ideas, sourceErrors: errors.slice(0, 20), outcome: errors.length ? succeeded ? "partial" : "error" : "success",
        lastSuccess: !errors.length ? this.now() : current.lastSuccess });
    } finally { clearTimeout(deadline); this.active = null; }
    return this.view();
  }
}
