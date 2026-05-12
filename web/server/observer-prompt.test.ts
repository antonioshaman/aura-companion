import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  OBSERVER_PROMPT_MAX_BYTES,
  OBSERVER_PROMPT_SCHEMA_VERSION,
  buildObserverContextManifest,
  formatCheckpointManifestPrompt,
  loadObserverSystemPrompt,
  parseObserverPromptHeader,
} from "./observer-prompt.js";

// The minimum bytes guard is in the source; padding lets us write tiny
// fixtures and still pass the floor without copy-pasting the constant.
const MIN_BODY = "x".repeat(512);

function fixtureBody(version: number = OBSERVER_PROMPT_SCHEMA_VERSION, tail: string = MIN_BODY): string {
  return `<!-- observer-system-prompt v${version} -->\n\n${tail}`;
}

// ── parseObserverPromptHeader ───────────────────────────────────────────────

describe("parseObserverPromptHeader", () => {
  // Beck F4 happy path — well-formed header returns the parsed version.
  it("returns the version integer when the header is well-formed", () => {
    expect(parseObserverPromptHeader("<!-- observer-system-prompt v1 -->\n\nbody")).toBe(1);
    expect(parseObserverPromptHeader("<!-- observer-system-prompt v42 -->\n")).toBe(42);
  });

  // Beck F4 sad path — every malformed shape returns null. The whole
  // reason the helper exists is so this branch is independently testable.
  it.each([
    ["no header", "just body text\n"],
    ["wrong tag", "<!-- observer-prompt v1 -->\nbody"],
    ["missing 'v'", "<!-- observer-system-prompt 1 -->\nbody"],
    ["non-numeric version", "<!-- observer-system-prompt vX -->\nbody"],
    ["zero version", "<!-- observer-system-prompt v0 -->\nbody"],
    ["negative version", "<!-- observer-system-prompt v-1 -->\nbody"],
    ["header not on first line", "preamble\n<!-- observer-system-prompt v1 -->\nbody"],
    ["empty input", ""],
  ])("returns null for: %s", (_label, raw) => {
    expect(parseObserverPromptHeader(raw)).toBeNull();
  });

  // The header must be the FIRST line, not "somewhere in the file".
  // A markdown editor that inserts a BOM or leading blank line would
  // otherwise silently pass a malformed prompt.
  it("rejects a header preceded by whitespace lines", () => {
    expect(parseObserverPromptHeader("\n<!-- observer-system-prompt v1 -->\nbody")).toBeNull();
  });
});

// ── loadObserverSystemPrompt ────────────────────────────────────────────────

describe("loadObserverSystemPrompt", () => {
  let dir: string;
  let promptPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "obs-prompt-"));
    promptPath = join(dir, "observer-system.md");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // Happy path — produces a typed artifact with a stable hash.
  it("loads a valid prompt and returns version + body + sha256", () => {
    const body = fixtureBody();
    writeFileSync(promptPath, body);
    const artifact = loadObserverSystemPrompt(promptPath);
    expect(artifact.version).toBe(OBSERVER_PROMPT_SCHEMA_VERSION);
    expect(artifact.body).toBe(body);
    expect(artifact.sourcePath).toBe(promptPath);
    // The sha256 is deterministic — match what an independent hash gives us.
    const expected = createHash("sha256").update(body, "utf8").digest("hex");
    expect(artifact.sha256).toBe(expected);
  });

  // Schema-version drift: a v2 file must fail loudly so the consumer
  // doesn't accidentally serve a future-format prompt to a v1-only consumer.
  it("throws on unsupported schema version", () => {
    writeFileSync(promptPath, fixtureBody(2));
    expect(() => loadObserverSystemPrompt(promptPath)).toThrow(/version 2 does not match/);
  });

  it("throws when the header is missing or malformed", () => {
    writeFileSync(promptPath, `no header here\n${MIN_BODY}`);
    expect(() => loadObserverSystemPrompt(promptPath)).toThrow(/malformed header/);
  });

  // A truncated write produces a tiny file; we want a noisy failure rather
  // than the observer loading half a sentence as its full role definition.
  it("throws when the body is shorter than the minimum", () => {
    writeFileSync(promptPath, "<!-- observer-system-prompt v1 -->\nshort\n");
    expect(() => loadObserverSystemPrompt(promptPath)).toThrow(/below minimum/);
  });

  // Hunt P2: oversize defence at the stat level — we never read a huge file
  // into memory just to reject it.
  it("throws on oversize prompt artifact", () => {
    const huge = `<!-- observer-system-prompt v1 -->\n` + "a".repeat(OBSERVER_PROMPT_MAX_BYTES + 1);
    writeFileSync(promptPath, huge);
    expect(() => loadObserverSystemPrompt(promptPath)).toThrow(/exceeds OBSERVER_PROMPT_MAX_BYTES/);
  });

  it("throws on missing file", () => {
    expect(() => loadObserverSystemPrompt(join(dir, "no-such-file.md"))).toThrow(/cannot stat/);
  });

  // Validation of the caller's sourcePath argument — defensive guards before
  // touching the filesystem.
  it("throws on relative sourcePath", () => {
    expect(() => loadObserverSystemPrompt("relative/path.md")).toThrow(/must be absolute/);
  });

  it("throws on NUL byte in sourcePath", () => {
    expect(() => loadObserverSystemPrompt("/foo\0bad")).toThrow(/invalid sourcePath/);
  });

  it("throws on empty sourcePath", () => {
    expect(() => loadObserverSystemPrompt("")).toThrow(/invalid sourcePath/);
  });

  // The actual artifact shipped in the repo must load cleanly. This is the
  // canary that the prompt file checked into git matches the loader's
  // current schema — a refactor that bumps the loader's expectation but
  // forgets to bump the artifact's header will fail right here.
  it("loads the in-repo prompt artifact (`.council/prompts/observer-system.md`)", () => {
    const thisFile = fileURLToPath(import.meta.url);
    // observer-prompt.test.ts → web/server → web → repo root.
    const repoRoot = join(thisFile, "..", "..", "..");
    const repoArtifact = join(repoRoot, ".council", "prompts", "observer-system.md");
    const artifact = loadObserverSystemPrompt(repoArtifact);
    expect(artifact.version).toBe(OBSERVER_PROMPT_SCHEMA_VERSION);
    expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ── buildObserverContextManifest ────────────────────────────────────────────

describe("buildObserverContextManifest", () => {
  // No previous checkpoint — every current path is `delta`.
  it("treats the first checkpoint as fully-delta", () => {
    const m = buildObserverContextManifest({
      current: { artifact_paths: ["a.md", "b.md", "c.md"] },
    });
    expect(m).toEqual({ delta: ["a.md", "b.md", "c.md"], carried: [], dropped: [] });
  });

  // Set partition: current = previous → everything carried, nothing delta or dropped.
  it("emits empty delta when current equals previous (identical paths)", () => {
    const paths = ["a.md", "b.md"];
    const m = buildObserverContextManifest({
      current: { artifact_paths: paths },
      previous: { artifact_paths: paths },
    });
    expect(m).toEqual({ delta: [], carried: ["a.md", "b.md"], dropped: [] });
  });

  // The interesting case: net addition + net removal + carried.
  // This is the "context curation" guarantee from T13 — observer reads
  // only the delta, not the growing cumulative tree.
  it("partitions delta / carried / dropped correctly", () => {
    const m = buildObserverContextManifest({
      current: { artifact_paths: ["plan.md", "specs/new.md", "carried.md"] },
      previous: { artifact_paths: ["plan.md", "carried.md", "specs/old.md"] },
    });
    expect(m.delta).toEqual(["specs/new.md"]);
    expect(m.carried.sort()).toEqual(["carried.md", "plan.md"]);
    expect(m.dropped).toEqual(["specs/old.md"]);
  });

  // Order preservation — downstream hashing and snapshot tests depend on
  // deterministic ordering. Sets would have lost source order; we keep it.
  it("preserves source order in delta and carried (current's order)", () => {
    const m = buildObserverContextManifest({
      current: { artifact_paths: ["z.md", "a.md", "m.md"] },
      previous: { artifact_paths: ["a.md"] },
    });
    expect(m.delta).toEqual(["z.md", "m.md"]);
    expect(m.carried).toEqual(["a.md"]);
  });

  it("preserves source order in dropped (previous's order)", () => {
    const m = buildObserverContextManifest({
      current: { artifact_paths: [] },
      previous: { artifact_paths: ["z.md", "a.md", "m.md"] },
    });
    expect(m.dropped).toEqual(["z.md", "a.md", "m.md"]);
  });

  // Empty current with non-empty previous — everything dropped, nothing else.
  it("emits all-dropped when current is empty", () => {
    const m = buildObserverContextManifest({
      current: { artifact_paths: [] },
      previous: { artifact_paths: ["a.md", "b.md"] },
    });
    expect(m).toEqual({ delta: [], carried: [], dropped: ["a.md", "b.md"] });
  });

  // Both empty — degenerate but legal (e.g. a checkpoint that says "nothing
  // changed in this phase"). Returns the empty partition.
  it("emits empty partition when both current and previous are empty", () => {
    const m = buildObserverContextManifest({
      current: { artifact_paths: [] },
      previous: { artifact_paths: [] },
    });
    expect(m).toEqual({ delta: [], carried: [], dropped: [] });
  });
});

// ── formatCheckpointManifestPrompt ──────────────────────────────────────────
//
// The wake-message string the bridge injects into the observer CLI's stream
// to unblock its pre-init stdin wait. The observer's system prompt is
// human-readable, so the wake message follows the same shape — plain text
// with the identity triple, a delta section, and an optional carried
// section. These tests pin the surface the prompt author depends on.

describe("formatCheckpointManifestPrompt", () => {
  // The identity triple (session_group_id, checkpoint_id, phase) must round-trip
  // through the message verbatim so the observer can echo them into the review
  // file — review-watcher uses (checkpoint_id, observer_provider) to dedup.
  it("renders the identity triple and delta-only paths on a first checkpoint", () => {
    const body = formatCheckpointManifestPrompt({
      sessionGroupId: "grp_abc",
      checkpointId: "chk_1",
      phase: "council-plan",
      manifest: { delta: ["src/a.ts", "src/b.ts"], carried: [], dropped: [] },
    });
    expect(body).toContain("session_group_id: grp_abc");
    expect(body).toContain("checkpoint_id: chk_1");
    expect(body).toContain("phase: council-plan");
    expect(body).toContain("- src/a.ts");
    expect(body).toContain("- src/b.ts");
    // No carried section on a first checkpoint.
    expect(body).not.toContain("Carried from previous checkpoint");
  });

  // Carried paths must appear under a SEPARATE header so the observer can
  // distinguish "must read this cycle" from "optional cross-cut reference".
  // Conflating them defeats the delta-grounding semantic.
  it("emits a separate carried section when carried paths exist", () => {
    const body = formatCheckpointManifestPrompt({
      sessionGroupId: "grp",
      checkpointId: "c",
      phase: "p",
      manifest: { delta: ["new.ts"], carried: ["old.ts"], dropped: [] },
    });
    const modifiedAt = body.indexOf("Modified files this cycle");
    const carriedAt = body.indexOf("Carried from previous checkpoint");
    expect(modifiedAt).toBeGreaterThanOrEqual(0);
    expect(carriedAt).toBeGreaterThan(modifiedAt);
    expect(body.slice(modifiedAt, carriedAt)).toContain("- new.ts");
    expect(body.slice(carriedAt)).toContain("- old.ts");
  });

  // Dropped paths must NOT appear in the message. The system prompt's
  // contract is "do not re-read dropped"; even mentioning the names risks
  // the model fetching them.
  it("omits dropped paths entirely", () => {
    const body = formatCheckpointManifestPrompt({
      sessionGroupId: "grp",
      checkpointId: "c",
      phase: "p",
      manifest: { delta: ["keep.ts"], carried: [], dropped: ["gone.ts"] },
    });
    expect(body).toContain("keep.ts");
    expect(body).not.toContain("gone.ts");
  });

  // Empty delta is a legal edge case (a checkpoint that signals phase
  // completion with no new artifacts). The observer must still wake to
  // emit a zero-findings review, so the message must still ship — with
  // an explicit "none" sentinel rather than a bare empty list which
  // would look like a parser bug.
  it("renders an explicit 'none' note when delta is empty", () => {
    const body = formatCheckpointManifestPrompt({
      sessionGroupId: "grp",
      checkpointId: "c",
      phase: "p",
      manifest: { delta: [], carried: [], dropped: [] },
    });
    expect(body).toMatch(/Modified files this cycle:\s*\(none/);
  });

  // The reminder of the review output path must include the phase token —
  // observer-system.md says the filename pattern is `<phase>-<provider>-observer.md`
  // and a typo in this reminder (e.g. dropping the phase) would silently
  // produce collisions across phases.
  it("includes the phase-bearing review filename pattern in the closing reminder", () => {
    const body = formatCheckpointManifestPrompt({
      sessionGroupId: "grp",
      checkpointId: "c",
      phase: "phaseX",
      manifest: { delta: ["a.ts"], carried: [], dropped: [] },
    });
    expect(body).toContain(".council/reviews/phaseX-");
    expect(body).toContain("-observer.md");
  });
});
