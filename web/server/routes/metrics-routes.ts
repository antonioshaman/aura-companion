import type { Hono } from "hono";
import type { GaugeDataProvider } from "../metrics-collector.js";
import { metricsCollector } from "../metrics-collector.js";
import { deliveryMetrics } from "../delivery-metrics.js";

export function registerMetricsRoutes(
  api: Hono,
  deps: { gaugeProvider: GaugeDataProvider },
): void {
  api.get("/metrics", (c) => {
    const snapshot = metricsCollector.getSnapshot(deps.gaugeProvider);
    return c.json(snapshot);
  });

  // Reply-delivery reliability only (cheap; polled by the Settings panel).
  api.get("/metrics/delivery", (c) => c.json(deliveryMetrics.getSnapshot()));
}
