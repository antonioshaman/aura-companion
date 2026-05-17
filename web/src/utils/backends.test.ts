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

  it("uses fallback icon for generic model slugs", () => {
    const options = toModelOptions([
      { value: "gpt-5.2", label: "GPT-5.2", description: "" },
    ]);
    // Should use one of the fallback icons
    expect(options[0].icon).toBeTruthy();
    expect(options[0].icon.length).toBeGreaterThan(0);
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
