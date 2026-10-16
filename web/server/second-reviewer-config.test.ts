import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTO_CLAUDE_SECOND_REVIEW_MODEL,
  effectiveSecondReviewerConfig,
  isPhaseInSecondReviewScope,
  parseSecondReviewerSetting,
  parseSecondReviewScope,
  readGroupSecondReviewer,
  resolveSecondReviewer,
  writeGroupSecondReviewer,
} from "./second-reviewer-config.js";

// W15 multi-model review — the configuration surface of the Council
// "second opinion": wire/disk parsing (strict, EC-5), `auto` resolution to the
// opposite backend, the phase scope that keeps plan checkpoints cheap, and the
// per-group state file that outranks the global default.

const GROUP = "grp_0123456789abcdef0123456789abcdef";
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function workspace(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "second-reviewer-config-")));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("parseSecondReviewerSetting", () => {
  it("accepts off, auto and {backend, model}", () => {
    expect(parseSecondReviewerSetting("off")).toEqual({ ok: true, value: "off" });
    expect(parseSecondReviewerSetting("auto")).toEqual({ ok: true, value: "auto" });
    expect(parseSecondReviewerSetting({ backend: "claude", model: "claude-sonnet-5" })).toEqual({
      ok: true,
      value: { backend: "claude", model: "claude-sonnet-5" },
    });
    // An empty model means "the CLI's default model", not an invalid value.
    expect(parseSecondReviewerSetting({ backend: "codex", model: "" })).toEqual({ ok: true, value: { backend: "codex" } });
  });

  // EC-5: unknown shapes are rejected, never coerced to "off" silently.
  it("rejects unknown backends, unknown keys and argv-hostile model ids", () => {
    expect(parseSecondReviewerSetting("on").ok).toBe(false);
    expect(parseSecondReviewerSetting({ backend: "gemini" }).ok).toBe(false);
    expect(parseSecondReviewerSetting({ backend: "claude", extra: 1 }).ok).toBe(false);
    // A leading dash would be read as a CLI flag (`--model -p`).
    expect(parseSecondReviewerSetting({ backend: "claude", model: "--dangerously-skip-permissions" }).ok).toBe(false);
    expect(parseSecondReviewerSetting({ backend: "claude", model: "a b" }).ok).toBe(false);
  });

  it("parses the scope strictly", () => {
    expect(parseSecondReviewScope("review-implement")).toEqual({ ok: true, value: "review-implement" });
    expect(parseSecondReviewScope("all")).toEqual({ ok: true, value: "all" });
    expect(parseSecondReviewScope("plan").ok).toBe(false);
  });
});

describe("resolveSecondReviewer", () => {
  // `auto` = the backend opposite the observer: the whole point is a
  // different model family looking at the same checkpoint.
  it("auto picks the opposite backend (codex observer → claude sonnet, claude observer → codex default)", () => {
    expect(resolveSecondReviewer("auto", "codex")).toEqual({ backend: "claude", model: AUTO_CLAUDE_SECOND_REVIEW_MODEL });
    expect(resolveSecondReviewer("auto", "claude")).toEqual({ backend: "codex" });
  });

  it("off resolves to null and an explicit choice is used as-is", () => {
    expect(resolveSecondReviewer("off", "claude")).toBeNull();
    expect(resolveSecondReviewer({ backend: "claude", model: "opus" }, "claude")).toEqual({ backend: "claude", model: "opus" });
  });
});

describe("isPhaseInSecondReviewScope", () => {
  // Cost guard: by default only review/implement checkpoints get a second
  // opinion; plan checkpoints do not; the synthetic spawn ack never does.
  it("review-implement covers review/implement phases only", () => {
    expect(isPhaseInSecondReviewScope("council-review", "review-implement")).toBe(true);
    expect(isPhaseInSecondReviewScope("council-implement-aura", "review-implement")).toBe(true);
    expect(isPhaseInSecondReviewScope("council-plan", "review-implement")).toBe(false);
    expect(isPhaseInSecondReviewScope("spawn", "all")).toBe(false);
    expect(isPhaseInSecondReviewScope("council-plan", "all")).toBe(true);
  });
});

describe("group second-reviewer file", () => {
  it("round-trips through .council/state and outranks the global default", () => {
    const cwd = workspace();
    const global = { reviewer: "off" as const, scope: "review-implement" as const };
    expect(readGroupSecondReviewer(cwd, GROUP)).toEqual({ ok: true, config: null });
    expect(effectiveSecondReviewerConfig(cwd, GROUP, global)).toEqual({ config: global, source: "global" });

    expect(writeGroupSecondReviewer(cwd, GROUP, { reviewer: "auto", scope: "all" })).toEqual({ ok: true });
    expect(effectiveSecondReviewerConfig(cwd, GROUP, global)).toEqual({
      config: { reviewer: "auto", scope: "all" },
      source: "group",
    });
  });

  // A corrupt file must be visible (readError → logged by the caller) and
  // fall back to the global default rather than throwing into the pipeline.
  it("reports a corrupt group file and falls back to the global default", () => {
    const cwd = workspace();
    mkdirSync(join(cwd, ".council", "state"), { recursive: true });
    writeFileSync(join(cwd, ".council", "state", `${GROUP}-second-reviewer.json`), "{not json");
    const global = { reviewer: "auto" as const, scope: "review-implement" as const };
    expect(effectiveSecondReviewerConfig(cwd, GROUP, global)).toEqual({ config: global, source: "global", readError: "invalid" });
  });
});
