import { describe, it, expect } from "vitest";
import {
  toModelOptions,
  getModelsForBackend,
  getModesForBackend,
  getAgentModesForBackend,
  getDefaultModel,
  getDefaultMode,
  getDefaultAgentMode,
  CLAUDE_MODELS,
  CODEX_MODELS,
  CLAUDE_MODES,
  CODEX_MODES,
  CLAUDE_AGENT_MODES,
  CODEX_AGENT_MODES,
  INTERACTIVE_DISCOVERY_SKILLS,
  detectInteractiveDiscoverySkill,
  pickRestoreMode,
} from "./backends.js";

describe("toModelOptions", () => {
  it("converts server model info to frontend ModelOption with icons", () => {
    const models = [
      { value: "gpt-5.2-codex", label: "gpt-5.2-codex", description: "Frontier" },
      { value: "gpt-5.1-codex-mini", label: "gpt-5.1-codex-mini", description: "Fast" },
    ];

    const options = toModelOptions(models);

    expect(options).toHaveLength(2);
    expect(options[0].value).toBe("gpt-5.2-codex");
    expect(options[0].label).toBe("gpt-5.2-codex");
    expect(options[0].icon).toBeTruthy();
    expect(options[1].value).toBe("gpt-5.1-codex-mini");
  });

  it("assigns codex icon to codex-containing slugs", () => {
    const options = toModelOptions([
      { value: "gpt-5.2-codex", label: "GPT-5.2 Codex", description: "" },
    ]);
    expect(options[0].icon).toBe("\u2733"); // ✳
  });

  it("assigns max icon to max-containing slugs", () => {
    const options = toModelOptions([
      { value: "gpt-5.1-codex-max", label: "GPT-5.1 Max", description: "" },
    ]);
    // "codex" appears before "max" in the slug, so codex icon wins
    expect(options[0].icon).toBe("\u2733");
  });

  it("assigns mini icon to mini-only slugs", () => {
    const options = toModelOptions([
      { value: "gpt-5.1-mini", label: "GPT-5.1 Mini", description: "" },
    ]);
    expect(options[0].icon).toBe("\u26A1"); // ⚡
  });

  it("returns empty icon for generic non-tier slugs (Council Review 2026-06-04-0823 P1 #7)", () => {
    // Prior shape returned a position-dependent geometric fallback rotated
    // by `index % 4` which silently flipped icons for the same slug across
    // response reorders. New shape: empty icon for unrecognised slugs —
    // honest about the lack of tier semantics, stable identity invariant.
    const options = toModelOptions([
      { value: "gpt-5.2", label: "GPT-5.2", description: "" },
    ]);
    expect(options[0].icon).toBe("");
  });

  it("icon assignment is stable across response reorder (Council P1 #7 regression pin)", () => {
    // Same slug at different array positions MUST produce identical icon.
    const a = toModelOptions([
      { value: "gpt-5.2", label: "GPT-5.2", description: "" },
      { value: "gpt-5.2-codex", label: "Codex", description: "" },
    ]);
    const b = toModelOptions([
      { value: "gpt-5.2-codex", label: "Codex", description: "" },
      { value: "gpt-5.2", label: "GPT-5.2", description: "" },
    ]);
    const aGeneric = a.find((m) => m.value === "gpt-5.2")!;
    const bGeneric = b.find((m) => m.value === "gpt-5.2")!;
    expect(aGeneric.icon).toBe(bGeneric.icon);
    const aCodex = a.find((m) => m.value === "gpt-5.2-codex")!;
    const bCodex = b.find((m) => m.value === "gpt-5.2-codex")!;
    expect(aCodex.icon).toBe(bCodex.icon);
  });

  it("uses value as label when label is empty", () => {
    const options = toModelOptions([
      { value: "some-model", label: "", description: "" },
    ]);
    expect(options[0].label).toBe("some-model");
  });

  it("handles empty array", () => {
    expect(toModelOptions([])).toEqual([]);
  });
});

describe("getModelsForBackend", () => {
  it("returns claude models for claude backend", () => {
    expect(getModelsForBackend("claude")).toBe(CLAUDE_MODELS);
  });

  it("returns codex models for codex backend", () => {
    expect(getModelsForBackend("codex")).toBe(CODEX_MODELS);
  });
});

describe("getModesForBackend", () => {
  it("returns claude modes for claude backend", () => {
    expect(getModesForBackend("claude")).toBe(CLAUDE_MODES);
  });

  it("returns codex modes for codex backend", () => {
    expect(getModesForBackend("codex")).toBe(CODEX_MODES);
  });
});

describe("getDefaultModel", () => {
  it("returns first claude model for claude backend", () => {
    expect(getDefaultModel("claude")).toBe(CLAUDE_MODELS[0].value);
  });

  it("returns first codex model for codex backend", () => {
    expect(getDefaultModel("codex")).toBe(CODEX_MODELS[0].value);
  });
});

describe("getDefaultMode", () => {
  it("returns first claude mode for claude backend", () => {
    expect(getDefaultMode("claude")).toBe(CLAUDE_MODES[0].value);
  });

  it("returns first codex mode for codex backend", () => {
    expect(getDefaultMode("codex")).toBe(CODEX_MODES[0].value);
  });
});

describe("getAgentModesForBackend", () => {
  it("returns claude agent modes for claude backend", () => {
    expect(getAgentModesForBackend("claude")).toBe(CLAUDE_AGENT_MODES);
  });

  it("returns codex agent modes for codex backend", () => {
    expect(getAgentModesForBackend("codex")).toBe(CODEX_AGENT_MODES);
  });
});

describe("getDefaultAgentMode", () => {
  it("returns first claude agent mode for claude backend", () => {
    expect(getDefaultAgentMode("claude")).toBe(CLAUDE_AGENT_MODES[0].value);
  });

  it("returns first codex agent mode for codex backend", () => {
    expect(getDefaultAgentMode("codex")).toBe(CODEX_AGENT_MODES[0].value);
  });
});

describe("static model/mode lists", () => {
  it("has codex models with GPT-5.x slugs", () => {
    for (const m of CODEX_MODELS) {
      expect(m.value).toMatch(/^gpt-5/);
    }
  });

  it("has claude models with claude- prefix", () => {
    for (const m of CLAUDE_MODELS) {
      expect(m.value).toMatch(/^claude-/);
    }
  });

  it("has at least 2 modes for each backend", () => {
    expect(CLAUDE_MODES.length).toBeGreaterThanOrEqual(2);
    expect(CODEX_MODES.length).toBeGreaterThanOrEqual(2);
  });

  // Agent modes must never include "plan" — agents are autonomous and
  // cannot wait for human plan approval.
  it("agent modes do not include 'plan' for any backend", () => {
    for (const m of CLAUDE_AGENT_MODES) {
      expect(m.value).not.toBe("plan");
    }
    for (const m of CODEX_AGENT_MODES) {
      expect(m.value).not.toBe("plan");
    }
  });

  it("agent modes default to bypassPermissions", () => {
    expect(CLAUDE_AGENT_MODES[0].value).toBe("bypassPermissions");
    expect(CODEX_AGENT_MODES[0].value).toBe("bypassPermissions");
  });

  it("claude agent modes include acceptEdits for middle ground", () => {
    expect(CLAUDE_AGENT_MODES.some((m) => m.value === "acceptEdits")).toBe(true);
  });
});

describe("pickRestoreMode", () => {
  // THE Codex fix anchor. The original Composer.tsx:302 logic fell back to
  // "bypassPermissions" for a Codex session with no previously-saved mode,
  // silently granting unrestricted tool execution. This assertion is the
  // regression canary — if it ever flips back, the silent-privilege-upgrade
  // defect has returned. Cross-ref: feedback_no_sentinel_user_id_fallback.
  it("Codex empty-previous restores to 'default', NEVER 'bypassPermissions'", () => {
    expect(pickRestoreMode("", true)).toBe("default");
    expect(pickRestoreMode("", true)).not.toBe("bypassPermissions");
  });

  // Negative-control: Claude branch is unchanged from the original code
  // path. If this flips it means the helper accidentally widened the
  // fix to a backend it shouldn't have touched.
  it("Claude empty-previous restores to 'acceptEdits' (unchanged from prior behaviour)", () => {
    expect(pickRestoreMode("", false)).toBe("acceptEdits");
  });

  // Passthrough: any non-empty saved prior mode wins regardless of backend.
  // Guards against future regressions where the helper accidentally
  // overrides a user's saved preference.
  it("passes through non-empty previous mode for Codex", () => {
    expect(pickRestoreMode("default", true)).toBe("default");
    expect(pickRestoreMode("bypassPermissions", true)).toBe("bypassPermissions");
  });
  it("passes through non-empty previous mode for Claude", () => {
    expect(pickRestoreMode("acceptEdits", false)).toBe("acceptEdits");
    expect(pickRestoreMode("bypassPermissions", false)).toBe("bypassPermissions");
    expect(pickRestoreMode("plan", false)).toBe("plan");
  });
});

describe("detectInteractiveDiscoverySkill", () => {
  // Happy path: the canonical discovery skill returns its slug.
  it("matches /council-plan-aura exactly", () => {
    expect(detectInteractiveDiscoverySkill("/council-plan-aura")).toBe("council-plan-aura");
  });

  // Case-insensitivity is important because slash commands tab-completion
  // may produce inconsistent casing; matching must be lenient on case.
  it("matches case-insensitively", () => {
    expect(detectInteractiveDiscoverySkill("/Council-Plan-Aura")).toBe("council-plan-aura");
    expect(detectInteractiveDiscoverySkill("/COUNCIL-PLAN-AURA")).toBe("council-plan-aura");
  });

  // First-token match: arguments after the skill name must not break the
  // detector. Hunt trust-boundary rule — exact equality on the FIRST token.
  it("matches the first whitespace-delimited token only", () => {
    expect(detectInteractiveDiscoverySkill("/council-plan-aura some args")).toBe("council-plan-aura");
    expect(detectInteractiveDiscoverySkill("/spec-writer feature X")).toBe("spec-writer");
  });

  // Trust-boundary canary — partial matches and crafted prefixes must NOT
  // slip past the gate. `startsWith`/`includes`/regex would fail this.
  it("rejects partial matches and crafted prefixes", () => {
    expect(detectInteractiveDiscoverySkill("/council-plan-aura-x")).toBe(null);
    expect(detectInteractiveDiscoverySkill("/council")).toBe(null);
    expect(detectInteractiveDiscoverySkill("/x-council-plan-aura")).toBe(null);
  });

  // No leading slash → not a skill invocation.
  it("returns null when text does not start with /", () => {
    expect(detectInteractiveDiscoverySkill("council-plan-aura")).toBe(null);
    expect(detectInteractiveDiscoverySkill("hello /council-plan-aura")).toBe(null);
  });

  // Empty and slash-only edge cases.
  it("returns null for empty and slash-only input", () => {
    expect(detectInteractiveDiscoverySkill("")).toBe(null);
    expect(detectInteractiveDiscoverySkill("/")).toBe(null);
    expect(detectInteractiveDiscoverySkill("   ")).toBe(null);
  });

  // Non-discovery skills must not falsely match — guards the trust list
  // against accidental inclusion of unrelated slash commands.
  it("returns null for non-discovery skills", () => {
    expect(detectInteractiveDiscoverySkill("/help")).toBe(null);
    expect(detectInteractiveDiscoverySkill("/clear")).toBe(null);
    expect(detectInteractiveDiscoverySkill("/init")).toBe(null);
  });
});

describe("INTERACTIVE_DISCOVERY_SKILLS", () => {
  // Frozen constant guard — runtime mutation MUST not be possible.
  // Object.freeze on a readonly tuple is the EC-20 single-source-of-truth
  // discipline; this assertion catches accidental Array.push at runtime.
  it("is frozen at runtime", () => {
    expect(Object.isFrozen(INTERACTIVE_DISCOVERY_SKILLS)).toBe(true);
  });

  // Contains the canonical discovery skills from the spec.
  it("contains the canonical discovery skill slugs", () => {
    expect(INTERACTIVE_DISCOVERY_SKILLS).toContain("council-plan-aura");
    expect(INTERACTIVE_DISCOVERY_SKILLS).toContain("spec-writer");
    expect(INTERACTIVE_DISCOVERY_SKILLS).toContain("plan-feature");
  });
});

// ── PLAN-aura-dynamic-model-list Task 15 — pickSessionDefaultModel ─────────

import { pickSessionDefaultModel } from "./backends.js";

describe("pickSessionDefaultModel", () => {
  const dynamicClaude = [
    { value: "claude-opus-4-8", label: "Opus 4.8", icon: "" },
    { value: "claude-opus-4-7", label: "Opus 4.7", icon: "" },
    { value: "claude-sonnet-4-6", label: "Sonnet 4.6", icon: "" },
  ];

  it("returns the static default when neither dynamic nor sticky is provided", () => {
    expect(pickSessionDefaultModel("claude")).toBe(CLAUDE_MODELS[0].value);
    expect(pickSessionDefaultModel("codex")).toBe(CODEX_MODELS[0].value);
  });

  it("returns the newest known-good dynamic model when sticky is empty (here = dynamic[0])", () => {
    // dynamicClaude[0] (opus-4-8) is in the static allow-list, so the
    // known-good anchor resolves to it — same result as the old dynamic[0].
    expect(pickSessionDefaultModel("claude", dynamicClaude)).toBe(
      "claude-opus-4-8",
    );
  });

  // fable-5 regression: the dynamic list (sourced from the API-key /v1/models
  // surface) can LEAD with a model the OAuth subscription can't actually run.
  // The Claude default must skip it and land on the newest entry that IS in the
  // hand-verified static list — otherwise a fresh session 404s on its first turn.
  it("Claude skips a bleeding-edge dynamic[0] that is absent from the static list", () => {
    const withFable = [
      { value: "claude-fable-5", label: "Fable 5", icon: "" },
      { value: "claude-opus-4-8", label: "Opus 4.8", icon: "" },
      { value: "claude-sonnet-4-6", label: "Sonnet 4.6", icon: "" },
    ];
    expect(pickSessionDefaultModel("claude", withFable)).toBe("claude-opus-4-8");
  });

  it("Claude falls back to the static default when NO dynamic entry is known-good", () => {
    const allUnknown = [
      { value: "claude-fable-5", label: "Fable 5", icon: "" },
      { value: "claude-myth-9", label: "Myth 9", icon: "" },
    ];
    expect(pickSessionDefaultModel("claude", allUnknown)).toBe(CLAUDE_MODELS[0].value);
  });

  it("Codex keeps dynamic[0] even when absent from the static list (no key/subscription split)", () => {
    const codexDynamic = [
      { value: "gpt-6-codex-preview", label: "GPT-6 Codex", icon: "" },
      { value: "gpt-5.3-codex", label: "GPT-5.3 Codex", icon: "" },
    ];
    expect(pickSessionDefaultModel("codex", codexDynamic)).toBe("gpt-6-codex-preview");
  });

  it("returns the sticky preference even when it IS in the dynamic list (Frontend R1)", () => {
    // User's saved preference wins — never silent-flip to dynamic[0] just
    // because Anthropic publishes a newer model.
    expect(
      pickSessionDefaultModel("claude", dynamicClaude, "claude-opus-4-7"),
    ).toBe("claude-opus-4-7");
  });

  it("returns the sticky preference EVEN WHEN it's not in the dynamic list (Friedman R2)", () => {
    // User's saved choice was deprecated upstream — preserve it. The
    // ModelSwitcher's existing fallback path renders it as a custom entry.
    expect(
      pickSessionDefaultModel("claude", dynamicClaude, "claude-opus-4-5"),
    ).toBe("claude-opus-4-5");
  });

  it("treats empty-string sticky as absent (falls through to dynamic[0])", () => {
    expect(pickSessionDefaultModel("claude", dynamicClaude, "")).toBe(
      "claude-opus-4-8",
    );
  });

  it("treats null/undefined sticky as absent", () => {
    expect(pickSessionDefaultModel("claude", dynamicClaude, null)).toBe(
      "claude-opus-4-8",
    );
    expect(pickSessionDefaultModel("claude", dynamicClaude, undefined)).toBe(
      "claude-opus-4-8",
    );
  });

  it("returns static default when dynamic is empty array and sticky absent", () => {
    expect(pickSessionDefaultModel("claude", [])).toBe(CLAUDE_MODELS[0].value);
  });
});

// ── PLAN Task 13 — pickIcon claude-* returns empty (Saarinen R1) ──────────

describe("toModelOptions — Claude entries are icon-less (Task 13)", () => {
  it("assigns empty icon to claude-* slugs (Saarinen R1)", () => {
    const options = toModelOptions([
      { value: "claude-opus-4-8", label: "Opus 4.8", description: "" },
      { value: "claude-sonnet-4-6", label: "Sonnet 4.6", description: "" },
    ]);
    expect(options[0].icon).toBe("");
    expect(options[1].icon).toBe("");
  });

  it("still assigns geometric icons to non-claude- slugs (preserves Codex behaviour)", () => {
    const options = toModelOptions([
      { value: "gpt-5.2-codex", label: "GPT-5.2", description: "" },
    ]);
    expect(options[0].icon).not.toBe("");
  });
});
