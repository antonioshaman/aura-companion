import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CodexModelInfo {
  slug: string;
  displayName: string;
  description: string;
  priority: number;
}

export type CodexModelSelection =
  | { kind: "selected"; model: CodexModelInfo; fallbackFrom?: string }
  | { kind: "unavailable"; reason: "cache_missing" | "cache_malformed" | "no_launchable_models"; message: string };

type RawCodexCache = {
  models?: Array<{
    slug?: unknown;
    display_name?: unknown;
    description?: unknown;
    visibility?: unknown;
    priority?: unknown;
  }>;
};

export function getCodexModelsCachePath(): string {
  return join(homedir(), ".codex", "models_cache.json");
}

export function readLaunchableCodexModels(): CodexModelSelection | { kind: "list"; models: CodexModelInfo[] } {
  const cachePath = getCodexModelsCachePath();
  if (!existsSync(cachePath)) {
    return {
      kind: "unavailable",
      reason: "cache_missing",
      message: "Codex models cache not found. Run codex once to populate it.",
    };
  }

  try {
    const raw = JSON.parse(readFileSync(cachePath, "utf-8")) as RawCodexCache;
    const models = Array.isArray(raw.models) ? raw.models : [];
    const launchable = models
      .filter((m) => m.visibility === "list" && typeof m.slug === "string" && m.slug.length > 0)
      .map((m) => ({
        slug: m.slug as string,
        displayName: typeof m.display_name === "string" && m.display_name.length > 0 ? m.display_name : m.slug as string,
        description: typeof m.description === "string" ? m.description : "",
        priority: typeof m.priority === "number" ? m.priority : 99,
      }))
      .sort((a, b) => a.priority - b.priority);

    if (launchable.length === 0) {
      return {
        kind: "unavailable",
        reason: "no_launchable_models",
        message: "No launchable Codex models are available for this account.",
      };
    }

    return { kind: "list", models: launchable };
  } catch {
    return {
      kind: "unavailable",
      reason: "cache_malformed",
      message: "Failed to parse Codex models cache",
    };
  }
}

function modelScore(requested: string, candidate: CodexModelInfo): number {
  let score = 0;
  if (candidate.slug === requested) score += 10_000;

  const requestedMajor = requested.match(/^gpt-\d+(?:\.\d+)?/)?.[0];
  const candidateMajor = candidate.slug.match(/^gpt-\d+(?:\.\d+)?/)?.[0];
  if (requestedMajor && requestedMajor === candidateMajor) score += 500;

  const requestedCodex = requested.includes("codex");
  const candidateCodex = candidate.slug.includes("codex");
  if (requestedCodex === candidateCodex) score += 200;

  const requestedMini = requested.includes("mini");
  const candidateMini = candidate.slug.includes("mini");
  if (requestedMini === candidateMini) score += 100;

  const requestedMax = requested.includes("max");
  const candidateMax = candidate.slug.includes("max");
  if (requestedMax === candidateMax) score += 100;

  return score - candidate.priority;
}

export function selectLaunchableCodexModel(
  requestedModel: string | undefined,
  opts: { rejectModels?: readonly string[] } = {},
): CodexModelSelection {
  const loaded = readLaunchableCodexModels();
  if (loaded.kind !== "list") return loaded;

  const rejected = new Set(opts.rejectModels ?? []);
  const available = loaded.models.filter((m) => !rejected.has(m.slug));
  if (available.length === 0) {
    return {
      kind: "unavailable",
      reason: "no_launchable_models",
      message: "No launchable Codex models are available for this account.",
    };
  }

  if (!requestedModel || requestedModel.length === 0) {
    return { kind: "selected", model: available[0]! };
  }

  const exact = available.find((m) => m.slug === requestedModel);
  if (exact) return { kind: "selected", model: exact };

  const fallback = [...available].sort((a, b) => modelScore(requestedModel, b) - modelScore(requestedModel, a))[0]!;
  return { kind: "selected", model: fallback, fallbackFrom: requestedModel };
}
