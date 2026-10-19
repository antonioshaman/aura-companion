import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  detectClaimLanguage,
  parseClaimLanguageOverride,
  readProseArtifactSamples,
  recentUserTexts,
  resolveClaimLanguage,
} from "./observer-language.js";

// Observer rigor (2026-10-16): prod grp_879b81b6 — the user writes Russian,
// the artifacts are Russian, yet every observer claim was English. The wake
// now names the claim language; these tests pin how it is resolved.
describe("detectClaimLanguage", () => {
  it("Russian technical prose full of Latin identifiers is Russian", () => {
    // Real-shaped message: identifiers, paths and code would outvote the
    // Cyrillic letters under a naive majority rule.
    const msg = "Проверь, что `persistModelChoice` в web/server/session-orchestrator.ts вызывается после relaunch, и что SessionStore.save не теряет поле model.";
    expect(detectClaimLanguage([msg])).toBe("ru");
  });

  it("plain English is English", () => {
    expect(detectClaimLanguage(["Please make sure the relaunch path persists the chosen model across restarts."])).toBe("en");
  });

  it("too little evidence (only code / paths / ids) gives no verdict", () => {
    expect(detectClaimLanguage(["`a.ts:12`", "web/server/x.ts", "```ts\nconst x = 1;\n```"])).toBeNull();
    expect(detectClaimLanguage([])).toBeNull();
  });
});

describe("resolveClaimLanguage", () => {
  it("operator override wins; auto/junk fall through to detection", () => {
    expect(parseClaimLanguageOverride("RU")).toBe("ru");
    expect(parseClaimLanguageOverride("auto")).toBeNull();
    expect(parseClaimLanguageOverride("de")).toBeNull();
    expect(resolveClaimLanguage({ override: "en", conversation: ["Сделай ревью плана, пожалуйста, очень внимательно"], artifactTexts: () => [] })).toBe("en");
  });

  it("the user's conversation outranks the artifact; artifacts are read only when needed", () => {
    let read = 0;
    const artifactTexts = () => { read++; return ["This plan describes the model persistence changes in detail."]; };
    expect(resolveClaimLanguage({ conversation: ["Сделай ревью плана, пожалуйста, очень внимательно"], artifactTexts })).toBe("ru");
    expect(read).toBe(0);
    expect(resolveClaimLanguage({ conversation: [], artifactTexts })).toBe("en");
    expect(read).toBe(1);
  });
});

describe("recentUserTexts", () => {
  it("keeps the user's own messages, newest last, and drops peer findings and probes", () => {
    const history = [
      { type: "user_message", content: "первое сообщение" },
      { type: "assistant", message: {} },
      { type: "user_message", content: "[from-observer: STOP] x is null on the retry path" },
      { type: "user_message", content: "[liveness probe] кто ты?" },
      { type: "user_message", content: "второе сообщение" },
    ];
    expect(recentUserTexts(history)).toEqual(["первое сообщение", "второе сообщение"]);
    expect(recentUserTexts(history, 1)).toEqual(["второе сообщение"]);
  });
});

describe("readProseArtifactSamples (EC-7 containment)", () => {
  let root: string;
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("reads prose artifacts inside the workspace and skips code, absolute and escaping paths", () => {
    root = mkdtempSync(join(tmpdir(), "obs-lang-"));
    const outside = mkdtempSync(join(tmpdir(), "obs-lang-out-"));
    try {
      mkdirSync(join(root, "docs"));
      writeFileSync(join(root, "docs", "plan.md"), "План работ");
      writeFileSync(join(root, "a.ts"), "const x = 1;");
      writeFileSync(join(outside, "secret.md"), "secret");
      symlinkSync(join(outside, "secret.md"), join(root, "docs", "link.md"));
      expect(readProseArtifactSamples(root, ["docs/plan.md", "a.ts", "docs/link.md", "../x.md", join(outside, "secret.md")]))
        .toEqual(["План работ"]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
