import { existsSync, readFileSync, statSync } from "node:fs";
import { writeAtomicJson } from "../atomic-write.js";
import { DEFAULT_RADAR_CONFIG, parseRadarConfig, type RadarIdea, type RadarSnapshot } from "./radar-types.js";

export function emptyRadar(): RadarSnapshot {
  return { version: 1, config: structuredClone(DEFAULT_RADAR_CONFIG), ideas: [], decisions: {}, decisionIdeas: {}, lastAttempt: null, lastSuccess: null, outcome: "never", sourceErrors: [] };
}
/** One fixed installation-owned path. Read failures are surfaced, never replaced. */
export class RadarStore {
  constructor(private readonly path: string) {}
  read(): RadarSnapshot {
    if (!existsSync(this.path)) return emptyRadar();
    if (statSync(this.path).size > 512_000) throw new Error("Хранилище Радара превышает лимит");
    const s = JSON.parse(readFileSync(this.path, "utf8")) as RadarSnapshot;
    if (s.version !== 1 || !Array.isArray(s.ideas) || s.ideas.length > 100 || !s.decisions || typeof s.decisions !== "object" || Array.isArray(s.decisions) || !["never", "success", "partial", "error"].includes(s.outcome) || !Array.isArray(s.sourceErrors) || !s.sourceErrors.every(e => typeof e === "string" && e.length <= 500)) throw new Error("Хранилище Радара повреждено");
    parseRadarConfig(s.config);
    if (Object.keys(s.decisions).length > 2000 || !Object.entries(s.decisions).every(([key, value]) => /^[a-f0-9]{24}$/.test(key) && ["dismissed", "implemented"].includes(value))) throw new Error("Решения Радара повреждены");
    if (![s.lastAttempt, s.lastSuccess].every(n => n === null || typeof n === "number" && Number.isFinite(n) && n >= 0)) throw new Error("Даты Радара повреждены");
    if (!s.ideas.every(i => /^[a-f0-9]{24}$/.test(i.id) && typeof i.title === "string" && typeof i.benefit === "string" && typeof i.gap === "string" && typeof i.url === "string" && /^https:\/\/(?:github\.com|developers\.openai\.com|platform\.claude\.com)\//.test(i.url))) throw new Error("Хранилище Радара повреждено");
    s.decisionIdeas ??= {}; // Version-1 snapshots without archived evidence remain readable.
    if (typeof s.decisionIdeas !== "object" || Array.isArray(s.decisionIdeas) || Object.keys(s.decisionIdeas).length > 2000 || !Object.entries(s.decisionIdeas).every(([key, idea]) => Object.hasOwn(s.decisions, key) && idea && idea.id === key && validIdea(idea))) throw new Error("История Радара повреждена");
    return s;
  }
  write(s: RadarSnapshot): void { writeAtomicJson(this.path, s, { maxBytes: 512_000 }); }
  decide(id: string, decision: "dismissed" | "implemented" | "restore"): void {
    if (typeof decision !== "string" || !["dismissed", "implemented", "restore"].includes(decision)) throw new Error("Некорректное решение");
    if (!/^[a-f0-9]{24}$/.test(id)) throw new Error("Некорректная идея");
    const s = this.read();
    if (!s.ideas.some(i => i.id === id) && !Object.hasOwn(s.decisions, id)) throw new Error("Идея не найдена");
    if (decision === "restore") {
      const idea = s.decisionIdeas?.[id];
      if (idea && !s.ideas.some(i => i.id === id)) {
        if (s.ideas.length >= 100) throw new Error("Сначала разберите текущие предложения: достигнут лимит 100");
        s.ideas.push(idea);
      }
      delete s.decisions[id]; delete s.decisionIdeas?.[id];
    }
    else {
      if (Object.keys(s.decisions).length >= 2000 && !Object.hasOwn(s.decisions, id)) throw new Error("Лимит решений Радара достигнут");
      s.decisions[id] = decision;
      const idea = s.ideas.find(i => i.id === id);
      if (idea) (s.decisionIdeas ??= {})[id] = structuredClone(idea);
    }
    this.write(s);
  }
}

function validIdea(i: RadarIdea): boolean {
  return /^[a-f0-9]{24}$/.test(i.id) && typeof i.title === "string" && typeof i.benefit === "string" && typeof i.gap === "string" && typeof i.complexity === "string" && i.confidence === "candidate" && (i.publishedAt === null || typeof i.publishedAt === "string" && Number.isFinite(Date.parse(i.publishedAt))) && typeof i.url === "string" && /^https:\/\/(?:github\.com|developers\.openai\.com|platform\.claude\.com)\//.test(i.url);
}
