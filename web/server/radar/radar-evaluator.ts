import { createHash } from "node:crypto";
import type { RadarFinding, RadarIdea } from "./radar-types.js";

/** Match known public themes, not claims in arbitrary release prose. */
export function evaluateFindings(findings: RadarFinding[]): RadarIdea[] {
  const ideas = new Map<string, RadarIdea>();
  for (const f of findings.slice(0, 100)) {
    const repo = f.repo.toLowerCase();
    // Aura's own upstream is already the product, not a new integration.
    if (repo === "the-vibe-company/companion" || repo === "aurashaman/aura-companion" || repo === "antonioshaman/aura-companion") continue;
    const topic = f.topics.join(" ").toLowerCase();
    const official = f.topics.includes("official-models");
    const cli = repo === "openai/codex" || repo === "anthropics/claude-code";
    const mcp = /\bmcp(?:-server)?\b/.test(topic);
    const agent = /\b(ai-agents|agent-framework|coding-agent)\b/.test(topic);
    if (!official && !cli && !mcp && !agent) continue;
    const id = createHash("sha256").update(repo).digest("hex").slice(0, 24);
    if (ideas.has(id)) continue; // Release APIs return newest first; keep its evidence.
    ideas.set(id, {
      id, title: `${official ? "Сверить официальный каталог" : cli ? "Проверить обновления" : "Оценить интеграцию"} ${f.repo}`,
      benefit: official ? `В официальной документации упомянуты ${f.title}. Доступность для аккаунта требует проверки.` : cli ? "Новые модели и изменения CLI могут улучшить совместимость Aura." : mcp ? "Дополнительные MCP-инструменты могут расширить возможности сессий." : "Подходы к агентам могут улучшить координацию и восстановление задач.",
      gap: "Применимость и отсутствие аналогов в Aura требуют проверки.",
      url: f.url, publishedAt: f.publishedAt, confidence: "candidate", complexity: "Не оценена",
    });
  }
  return [...ideas.values()].slice(0, 100);
}
