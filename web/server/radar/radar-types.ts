/** Public, bounded recommendation data; never contains project/session content. */
export interface RadarSource { kind: "search" | "repo" | "official"; value: string }
export interface RadarConfig { enabled: boolean; sources: RadarSource[] }
export interface RadarFinding { repo: string; title: string; url: string; publishedAt: string | null; topics: string[] }
export interface RadarIdea {
  id: string; title: string; benefit: string; gap: string; url: string;
  publishedAt: string | null; confidence: "candidate"; complexity: string;
}
export interface RadarCapability { id: string; title: string; evidence: string }
export interface RadarSnapshot {
  version: 1; config: RadarConfig; ideas: RadarIdea[];
  decisions: Record<string, "dismissed" | "implemented">;
  decisionIdeas?: Record<string, RadarIdea>;
  lastAttempt: number | null; lastSuccess: number | null;
  outcome: "never" | "success" | "partial" | "error";
  sourceErrors: string[];
}
export interface RadarView extends RadarSnapshot {
  running: boolean; capabilities: RadarCapability[]; counts: { proposals: number; implemented: number };
}
export const DEFAULT_RADAR_CONFIG: RadarConfig = {
  enabled: false,
  sources: [
    { kind: "search", value: "topic:mcp-server" },
    { kind: "search", value: "topic:ai-agents" },
    { kind: "repo", value: "openai/codex" },
    { kind: "repo", value: "anthropics/claude-code" },
    { kind: "official", value: "openai-models" },
    { kind: "official", value: "anthropic-models" },
  ],
};
export const RADAR_CAPABILITIES: RadarCapability[] = [
  { id: "dynamic-models", title: "Динамический каталог моделей", evidence: "web/server/codex-models.ts" },
  { id: "council", title: "Council Mode", evidence: "web/server/session-group-coordinator.ts" },
  { id: "knowledge", title: "База знаний и self-learning", evidence: "web/server/knowledge/kb-store.ts" },
  { id: "worktrees", title: "Изоляция рабочих деревьев", evidence: "web/server/worktree-isolation.ts" },
];
export function parseRadarConfig(raw: unknown): RadarConfig {
  if (!raw || typeof raw !== "object") throw new Error("Некорректные настройки Радара");
  const c = raw as Record<string, unknown>;
  if (typeof c.enabled !== "boolean" || !Array.isArray(c.sources) || c.sources.length > 20 || c.sources.length < 1) throw new Error("Нужны 1–20 источников и переключатель расписания");
  const sources = c.sources.map((s: unknown): RadarSource => {
    if (!s || typeof s !== "object") throw new Error("Некорректный источник");
    const { kind, value } = s as Record<string, unknown>;
    if (typeof value !== "string" || value.length > 100) throw new Error("Некорректный источник");
    if (kind === "repo" && /^[a-zA-Z0-9_-]{1,39}\/[a-zA-Z0-9_.-]{1,60}$/.test(value) && !value.includes("..")) return { kind, value };
    // Search is structured GitHub query text, never a URL or executable.
    if (kind === "official" && ["openai-models", "anthropic-models"].includes(value)) return { kind, value };
    if (kind === "search" && /^[a-zA-Z0-9: _.-]{1,100}$/.test(value)) return { kind, value };
    throw new Error("Используйте owner/repo или тему GitHub, не URL");
  });
  return { enabled: c.enabled, sources };
}
