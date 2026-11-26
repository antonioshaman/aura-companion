import type { RadarFinding, RadarSource } from "./radar-types.js";

export class RadarSourceError extends Error {}
/** Fixed public origins only: no user credentials or link-following. */
export async function fetchRadarSource(source: RadarSource, signal: AbortSignal, fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch): Promise<RadarFinding[]> {
  const useAtom = source.kind === "repo" && source.value.toLowerCase() === "openai/codex";
  const official = source.kind === "official" ? source.value === "openai-models" ? "https://developers.openai.com/api/docs/models.md" : "https://platform.claude.com/docs/en/models/overview.md" : null;
  const url = official ?? (source.kind === "repo"
    ? useAtom ? `https://github.com/${source.value}/releases.atom` : `https://api.github.com/repos/${source.value}/releases?per_page=1`
    : `https://api.github.com/search/repositories?q=${encodeURIComponent(source.value + " archived:false fork:false")}&sort=updated&order=desc&per_page=20`);
  const res = await fetcher(url, { signal, redirect: "error", headers: { Accept: "application/vnd.github+json", "User-Agent": "Aura-Improvement-Radar" } });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new RadarSourceError(res.status === 429 || res.status === 403 ? "Лимит GitHub или доступ ограничен" : res.status === 401 ? "GitHub отклонил запрос" : "Источник недоступен");
  }
  const reader = res.body?.getReader();
  if (!reader) throw new RadarSourceError("Пустой ответ источника");
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 256_000) throw new RadarSourceError("Ответ источника превышает лимит");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const text = Buffer.concat(chunks).toString("utf8");
  if (useAtom) {
    // Atom excludes binary asset inventories, which can exceed the response cap.
    const entry = text.match(/<entry>([\s\S]*?)<\/entry>/)?.[1];
    if (!entry) { if (text.includes("<feed")) return []; throw new RadarSourceError("Формат источника изменился"); }
    const tag = entry.match(/<id>[^<]*Repository\/\d+\/([^<]+)<\/id>/)?.[1];
    if (!tag || tag.length > 200) throw new RadarSourceError("Тег релиза не распознан");
    const updated = entry.match(/<updated>([^<]+)<\/updated>/)?.[1];
    return [{ repo: source.value, title: tag, url: `https://github.com/${source.value}/releases/tag/${encodeURIComponent(tag)}`, publishedAt: updated && Number.isFinite(Date.parse(updated)) ? updated : null, topics: [] }];
  }
  if (official) {
    const matches = text.match(source.value === "openai-models" ? /gpt-[a-z0-9]+(?:[.-][a-z0-9]+){0,4}/g : /claude-[a-z]+-\d+(?:[.-]\d+){0,2}/g) ?? [];
    const ids = [...new Set(matches.map(x => x.replace(/\.md$/, "")))].slice(0, 10);
    if (!ids.length) throw new RadarSourceError("Каталог изменил формат или модели не распознаны");
    return [{ repo: source.value === "openai-models" ? "OpenAI/models" : "Anthropic/models", title: ids.join(", "), url: official, publishedAt: null, topics: ["official-models"] }];
  }
  const raw: unknown = JSON.parse(text);
  const items = source.kind === "repo" ? raw : raw && typeof raw === "object" ? (raw as { items?: unknown }).items : null;
  if (!Array.isArray(items)) throw new RadarSourceError("Формат источника изменился");
  const findings: RadarFinding[] = [];
  for (const item of items.slice(0, 20)) {
    if (!item || typeof item !== "object") continue;
    const repo = source.kind === "repo" ? source.value : item.full_name;
    if (typeof repo !== "string" || !/^[a-zA-Z0-9_-]{1,39}\/[a-zA-Z0-9_.-]{1,60}$/.test(repo) || repo.includes("..")) continue;
    const date = source.kind === "repo" ? item.published_at : item.updated_at;
    findings.push({ repo, title: typeof item.name === "string" ? item.name.slice(0, 200) : repo,
      // Construct provenance rather than trust html_url from external JSON.
      url: `https://github.com/${repo}${source.kind === "repo" && typeof item.tag_name === "string" ? `/releases/tag/${encodeURIComponent(item.tag_name.slice(0, 100))}` : ""}`,
      publishedAt: typeof date === "string" && Number.isFinite(Date.parse(date)) ? date : null,
      topics: Array.isArray(item.topics) ? item.topics.filter((x: unknown): x is string => typeof x === "string").slice(0, 20).map((x: string) => x.slice(0, 80)) : [],
    });
  }
  return findings;
}
