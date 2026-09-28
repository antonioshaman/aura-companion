import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_LAYER_FLAGS,
  LAYER_ENV_KEYS,
  LAYER_NAMES,
  _resetServerLayerFlagsForTest,
  applyLayerFlagsToCreateBody,
  buildLayerSpawnConfig,
  composeSystemPrompt,
  getServerLayerFlags,
  initServerLayerFlags,
  isDefaultLayerFlags,
  parseLayerValue,
  resolveLayerFlagsFromEnv,
  resolveSessionLayerFlags,
} from "./layer-flags.js";

// aura-meta-diet P4/C3 — layer flags. Covers the three spec ACs:
//  1. default flags → prod behaviour (all on, empty spawn config);
//  2. knowledge=off → no KB content / instructions reach the agent;
//  3. unknown value → fail-closed to the default + a warning.

describe("parseLayerValue", () => {
  it("accepts the closed on/off vocabulary, case- and whitespace-insensitive", () => {
    for (const v of ["on", "ON", " 1 ", "true", true]) expect(parseLayerValue(v)).toEqual({ kind: "value", on: true });
    for (const v of ["off", "Off", "0", "false", false]) expect(parseLayerValue(v)).toEqual({ kind: "value", on: false });
  });

  it("treats undefined/null/empty as absent", () => {
    for (const v of [undefined, null, "", "  "]) expect(parseLayerValue(v)).toEqual({ kind: "absent" });
  });

  it("rejects everything else as invalid (no truthy coercion)", () => {
    // "yes"/"enabled"/2 look truthy but are NOT in the closed set — a typo
    // must never silently flip a layer.
    for (const v of ["yes", "enabled", "of", 2, 0, {}, []]) expect(parseLayerValue(v)).toEqual({ kind: "invalid" });
  });
});

describe("resolveLayerFlagsFromEnv (server default)", () => {
  it("empty env → every layer on (current prod), no warnings", () => {
    const res = resolveLayerFlagsFromEnv({});
    expect(res.flags).toEqual(DEFAULT_LAYER_FLAGS);
    expect(LAYER_NAMES.every((n) => res.flags[n])).toBe(true);
    expect(res.warnings).toEqual([]);
  });

  it("each env key switches exactly its own layer", () => {
    for (const name of LAYER_NAMES) {
      const res = resolveLayerFlagsFromEnv({ [LAYER_ENV_KEYS[name]]: "off" });
      expect(res.flags[name]).toBe(false);
      for (const other of LAYER_NAMES.filter((n) => n !== name)) expect(res.flags[other]).toBe(true);
    }
  });

  it("unknown value fails closed to the default and names the key in a warning", () => {
    const res = resolveLayerFlagsFromEnv({ COMPANION_LAYER_KNOWLEDGE: "nope", COMPANION_LAYER_COUNCIL: "off" });
    expect(res.flags.knowledge).toBe(true);
    expect(res.flags.council).toBe(false);
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toContain("COMPANION_LAYER_KNOWLEDGE");
    expect(res.warnings[0]).toContain("default (on)");
  });
});

describe("initServerLayerFlags / getServerLayerFlags", () => {
  afterEach(() => _resetServerLayerFlagsForTest());

  it("boot init logs each warning and caches the resolved flags", () => {
    const warn = vi.fn();
    initServerLayerFlags({ COMPANION_LAYER_AUTO_PROCEED: "maybe", COMPANION_LAYER_OBSERVER: "0" }, warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("COMPANION_LAYER_AUTO_PROCEED");
    expect(getServerLayerFlags()).toEqual({ ...DEFAULT_LAYER_FLAGS, observer: false });
  });
});

describe("resolveSessionLayerFlags (per-session override)", () => {
  const base = { ...DEFAULT_LAYER_FLAGS, council: false };

  it("absent → server default unchanged", () => {
    expect(resolveSessionLayerFlags(undefined, base)).toEqual({ flags: base, warnings: [] });
  });

  it("session values override the server default in both directions", () => {
    const { flags, warnings } = resolveSessionLayerFlags({ knowledge: "off", council: "on" }, base);
    expect(flags).toEqual({ ...DEFAULT_LAYER_FLAGS, knowledge: false, council: true });
    expect(warnings).toEqual([]);
  });

  it("unknown layer names and invalid values fall back to the server default with warnings", () => {
    const { flags, warnings } = resolveSessionLayerFlags({ knowlege: "off", observer: "sometimes" }, base);
    expect(flags).toEqual(base);
    expect(warnings).toHaveLength(2);
    expect(warnings.join("\n")).toContain("layers.knowlege is not a known layer");
    expect(warnings.join("\n")).toContain("layers.observer");
  });

  it("non-object layers is ignored with a warning", () => {
    const { flags, warnings } = resolveSessionLayerFlags("off", base);
    expect(flags).toEqual(base);
    expect(warnings).toHaveLength(1);
  });
});

describe("buildLayerSpawnConfig", () => {
  it("default / absent flags → empty config (spawn argv unchanged)", () => {
    expect(buildLayerSpawnConfig(undefined)).toEqual({ disallowedTools: [] });
    expect(buildLayerSpawnConfig(DEFAULT_LAYER_FLAGS)).toEqual({ disallowedTools: [] });
  });

  it("knowledge=off denies KB paths, the kb:* scripts and every KB skill, with a directive", () => {
    const cfg = buildLayerSpawnConfig({ ...DEFAULT_LAYER_FLAGS, knowledge: false });
    expect(cfg.disallowedTools).toEqual([
      "Read(./.agents/knowledge/**)",
      "Edit(./.agents/knowledge/**)",
      "Write(./.agents/knowledge/**)",
      "Bash(bun run --cwd web kb:*)",
      "Skill(prime)",
      "Skill(learn)",
      "Skill(self-reflect)",
      "Skill(review-with-kb)",
      "Skill(evolve)",
    ]);
    expect(cfg.systemPrompt).toContain("knowledge layer is disabled");
    expect(cfg.systemPrompt).not.toContain("council layer");
  });

  it("observer/autoProceed off are host-side only — no spawn restrictions", () => {
    expect(buildLayerSpawnConfig({ ...DEFAULT_LAYER_FLAGS, observer: false, autoProceed: false }))
      .toEqual({ disallowedTools: [] });
  });

  it("knowledge+council off compose into one directive", () => {
    const cfg = buildLayerSpawnConfig({ ...DEFAULT_LAYER_FLAGS, knowledge: false, council: false });
    expect(cfg.disallowedTools).toContain("Skill(council-review-aura)");
    expect(cfg.disallowedTools).toContain("Skill(prime)");
    expect(cfg.systemPrompt!.match(/# Aura layer flags/g)).toHaveLength(1);
  });
});

describe("isDefaultLayerFlags / composeSystemPrompt", () => {
  it("detects any deviation from the defaults", () => {
    expect(isDefaultLayerFlags(DEFAULT_LAYER_FLAGS)).toBe(true);
    expect(isDefaultLayerFlags({ ...DEFAULT_LAYER_FLAGS, autoProceed: false })).toBe(false);
  });

  it("joins non-empty parts with a blank line; all-empty → undefined", () => {
    expect(composeSystemPrompt("a", undefined, "b")).toBe("a\n\nb");
    expect(composeSystemPrompt(undefined, "")).toBeUndefined();
  });
});

describe("applyLayerFlagsToCreateBody (create-session boundary)", () => {
  it("default flags: body passes through untouched (no layers key — prod parity)", () => {
    const auto = { idleMs: 60_000, maxIterations: 3 };
    const res = applyLayerFlagsToCreateBody({ cwd: "/w", autoProceedOnIdle: auto }, DEFAULT_LAYER_FLAGS);
    expect(res).toEqual({
      ok: true,
      body: { cwd: "/w", autoProceedOnIdle: auto },
      flags: DEFAULT_LAYER_FLAGS,
      warnings: [],
    });
  });

  it("explicit all-on under a non-default server attaches the flags so they persist", () => {
    // Without the attach, the session would later fall back to the server
    // default (autoProceed off) at the enactor gate and lose its override.
    const res = applyLayerFlagsToCreateBody(
      { cwd: "/w", layers: { autoProceed: "on" } },
      { ...DEFAULT_LAYER_FLAGS, autoProceed: false },
    );
    expect(res.ok && res.body.layers).toEqual(DEFAULT_LAYER_FLAGS);
  });

  it("non-default session flags are attached", () => {
    const res = applyLayerFlagsToCreateBody({ cwd: "/w", layers: { knowledge: "off" } }, DEFAULT_LAYER_FLAGS);
    expect(res.ok && res.body.layers).toEqual({ ...DEFAULT_LAYER_FLAGS, knowledge: false });
  });

  it("autoProceed=off strips autoProceedOnIdle (with a warning)", () => {
    const res = applyLayerFlagsToCreateBody(
      { cwd: "/w", autoProceedOnIdle: { idleMs: 1, maxIterations: 1 }, layers: { autoProceed: "off" } },
      DEFAULT_LAYER_FLAGS,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.body).not.toHaveProperty("autoProceedOnIdle");
    expect(res.warnings.join()).toContain("autoProceed layer is disabled");
  });

  it("observer=off refuses a Council Mode pair with 409 instead of degrading to solo", () => {
    const res = applyLayerFlagsToCreateBody(
      { cwd: "/w", councilMode: "council", councilPairing: "claude+claude", layers: { observer: "off" } },
      DEFAULT_LAYER_FLAGS,
    );
    expect(res).toMatchObject({ ok: false, status: 409 });
  });

  it("observer=off still allows a solo session", () => {
    const res = applyLayerFlagsToCreateBody({ cwd: "/w" }, { ...DEFAULT_LAYER_FLAGS, observer: false });
    expect(res.ok).toBe(true);
  });

  it("does not mutate the caller's body", () => {
    const body = { cwd: "/w", autoProceedOnIdle: { idleMs: 1, maxIterations: 1 } };
    applyLayerFlagsToCreateBody(body, { ...DEFAULT_LAYER_FLAGS, autoProceed: false });
    expect(body).toHaveProperty("autoProceedOnIdle");
  });
});
