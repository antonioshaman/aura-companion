import { describe, expect, it, vi, beforeEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import {
  readLaunchableCodexModels,
  selectLaunchableCodexModel,
} from "./codex-models.js";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

describe("codex-models", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads only launchable codex models from cache order", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      models: [
        { slug: "gpt-5.1-codex-mini", display_name: "Mini", visibility: "list", priority: 5 },
        { slug: "gpt-5.2-codex", display_name: "Codex", visibility: "list", priority: 1 },
        { slug: "gpt-5-old", display_name: "Hidden", visibility: "hide", priority: 0 },
      ],
    }) as never);

    const out = readLaunchableCodexModels();
    expect(out).toEqual({
      kind: "list",
      models: [
        { slug: "gpt-5.2-codex", displayName: "Codex", description: "", priority: 1 },
        { slug: "gpt-5.1-codex-mini", displayName: "Mini", description: "", priority: 5 },
      ],
    });
  });

  it("falls back to the closest launchable model when the requested one is missing", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      models: [
        { slug: "gpt-5.2-codex", visibility: "list", priority: 1 },
        { slug: "gpt-5.2", visibility: "list", priority: 2 },
        { slug: "gpt-5.1-codex-mini", visibility: "list", priority: 3 },
      ],
    }) as never);

    const out = selectLaunchableCodexModel("gpt-5.3-codex");
    expect(out).toEqual({
      kind: "selected",
      model: {
        slug: "gpt-5.2-codex",
        displayName: "gpt-5.2-codex",
        description: "",
        priority: 1,
      },
      fallbackFrom: "gpt-5.3-codex",
    });
  });

  it("excludes runtime-rejected models from later fallback attempts", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      models: [
        { slug: "gpt-5.3-codex", visibility: "list", priority: 0 },
        { slug: "gpt-5.2-codex", visibility: "list", priority: 1 },
      ],
    }) as never);

    const out = selectLaunchableCodexModel("gpt-5.3-codex", {
      rejectModels: ["gpt-5.3-codex"],
    });
    expect(out).toEqual({
      kind: "selected",
      model: {
        slug: "gpt-5.2-codex",
        displayName: "gpt-5.2-codex",
        description: "",
        priority: 1,
      },
      fallbackFrom: "gpt-5.3-codex",
    });
  });
});
