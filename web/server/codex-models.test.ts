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

  // Regression for the live cache on the prod box (2026-09-07): codex's own
  // config auto-migration pinned `gpt-5.4`, which the ChatGPT account rejects
  // with a 400. The fallback must UPGRADE to the newer full-size model rather
  // than keep the dead version and drop a tier to `gpt-5.4-mini` — the latter
  // silently gives the user a smaller model than they asked for.
  it("upgrades a stale full-size pin to the newer full-size model instead of dropping to a same-version mini", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      models: [
        { slug: "gpt-5.5", visibility: "list", priority: 12 },
        { slug: "gpt-5.4-mini", visibility: "list", priority: 23 },
      ],
    }) as never);

    const out = selectLaunchableCodexModel("gpt-5.4");
    expect(out).toMatchObject({ kind: "selected", fallbackFrom: "gpt-5.4" });
    expect((out as { model: { slug: string } }).model.slug).toBe("gpt-5.5");
  });

  // The mirror of the above: tier affinity is what survives the fallback, so
  // an explicitly-chosen mini must NOT be silently upgraded to a full-size
  // model (which costs more and is not what the caller asked for).
  it("preserves the mini tier when the requested mini version is unavailable", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      models: [
        { slug: "gpt-5.5", visibility: "list", priority: 12 },
        { slug: "gpt-5.5-mini", visibility: "list", priority: 20 },
      ],
    }) as never);

    const out = selectLaunchableCodexModel("gpt-5.4-mini");
    expect((out as { model: { slug: string } }).model.slug).toBe("gpt-5.5-mini");
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
