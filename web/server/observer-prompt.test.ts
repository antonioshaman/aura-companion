import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  OBSERVER_PROMPT_MAX_BYTES,
  OBSERVER_PROMPT_SCHEMA_VERSION,
  assertWakeManifestPathAllowed,
  buildObserverContextManifest,
  buildObserverWakePayload,
  loadObserverSystemPrompt,
  parseObserverPromptHeader,
} from "./observer-prompt.js";
import {
  OBSERVER_WAKE_MAX_PATHS_PER_SECTION,
  OBSERVER_WAKE_PAYLOAD_VERSION,
} from "./council-types.js";
import { mkdirSync, symlinkSync } from "node:fs";
import { readFileSync as _readFileSync } from "node:fs";

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

// ── Task 13 test pack ──────────────────────────────────────────────────────
//
// Pure unit tables for the wake payload builder and the EC-7 wrapper.
// The dispatcher integration (Task 3) is exercised through the existing
// `session-orchestrator.test.ts` patterns; here we pin the producer-side
// invariants in isolation so payload-format edits ripple only through
// the builder tests (structure-insensitive per Beck Principle 2).

describe("buildObserverWakePayload", () => {
  let workspaceRoot: string;
  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "observer-wake-test-"));
    // Seed two files inside the workspace so realpath containment has
    // existing paths to resolve. Non-existent paths exercise the
    // climb-to-parent branch.
    writeFileSync(join(workspaceRoot, "a.ts"), "// existing");
    writeFileSync(join(workspaceRoot, "b.ts"), "// existing");
  });
  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("emits the canonical hybrid body with H1 preamble + fenced JSON + directive terminator", () => {
    const result = buildObserverWakePayload({
      checkpoint: {
        session_group_id: "grp_test",
        checkpoint_id: "chk_1",
        phase: "council-implement",
        sequence: 1,
      },
      manifest: { delta: ["a.ts"], carried: ["b.ts"], dropped: [] },
      workspaceRoot,
    });
    expect(result.textBody.startsWith("# Council Checkpoint — council-implement")).toBe(true);
    expect(result.textBody).toContain("```json");
    expect(result.textBody).toContain("```\n\nEmit one review file");
    expect(result.droppedPaths).toEqual([]);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("orders JSON keys with version first, then echo fields, then content arrays", () => {
    const result = buildObserverWakePayload({
      checkpoint: {
        session_group_id: "grp_x",
        checkpoint_id: "chk_2",
        phase: "council-plan",
        sequence: 5,
      },
      manifest: { delta: ["a.ts"], carried: [], dropped: [] },
      workspaceRoot,
    });
    // Extract the fenced JSON block and assert key order via stringified
    // representation — first occurrence of each key in textual order
    // mirrors Object.keys() insertion order.
    const match = /```json\n([\s\S]*?)\n```/.exec(result.textBody);
    expect(match).not.toBeNull();
    const json = match![1];
    const keysInOrder = [...json.matchAll(/"([a-z_]+)":/g)].map((m) => m[1]);
    // Filter out nested keys — the top-level scan picks up "type": "text"
    // only if we accidentally serialised the content blocks here; we
    // didn't, but the regex doesn't distinguish, so we slice the leading
    // five keys that we KNOW are the payload's top-level discriminator.
    expect(keysInOrder.slice(0, 5)).toEqual([
      "observer_wake_payload_version",
      "session_group_id",
      "checkpoint_id",
      "phase",
      "checkpoint_seq",
    ]);
  });

  it("throws on CR/LF/NUL in manifest paths (NDJSON line-discipline defence)", () => {
    expect(() =>
      buildObserverWakePayload({
        checkpoint: {
          session_group_id: "grp_x",
          checkpoint_id: "chk_3",
          phase: "p",
          sequence: 1,
        },
        manifest: { delta: ["a\nb.ts"], carried: [], dropped: [] },
        workspaceRoot,
      })
    ).toThrow(/CR\/LF\/NUL/);
  });

  it("throws on backtick triplet in manifest paths (fence-unframing defence)", () => {
    expect(() =>
      buildObserverWakePayload({
        checkpoint: {
          session_group_id: "grp_x",
          checkpoint_id: "chk_4",
          phase: "p",
          sequence: 1,
        },
        manifest: { delta: ["foo```.ts"], carried: [], dropped: [] },
        workspaceRoot,
      })
    ).toThrow(/triplet/);
  });

  it("throws when a section exceeds OBSERVER_WAKE_MAX_PATHS_PER_SECTION", () => {
    const overflow = Array.from(
      { length: OBSERVER_WAKE_MAX_PATHS_PER_SECTION + 1 },
      (_, i) => `f${i}.ts`,
    );
    expect(() =>
      buildObserverWakePayload({
        checkpoint: {
          session_group_id: "grp_x",
          checkpoint_id: "chk_5",
          phase: "p",
          sequence: 1,
        },
        manifest: { delta: overflow, carried: [], dropped: [] },
        workspaceRoot,
      })
    ).toThrow(/OBSERVER_WAKE_MAX_PATHS_PER_SECTION/);
  });

  it("drops (does not throw) paths that escape the workspace root", () => {
    // Use an absolute path pointing outside the workspace — realpath
    // containment must reject it without crashing the whole wake.
    const result = buildObserverWakePayload({
      checkpoint: {
        session_group_id: "grp_x",
        checkpoint_id: "chk_6",
        phase: "p",
        sequence: 1,
      },
      manifest: {
        delta: ["a.ts", "/etc/passwd"],
        carried: [],
        dropped: [],
      },
      workspaceRoot,
    });
    expect(result.droppedPaths.length).toBeGreaterThan(0);
    // The traversal path is excluded from the serialised body — observer
    // never sees it even though the orchestrator wrote it into the
    // checkpoint.
    expect(result.textBody).not.toContain("/etc/passwd");
    expect(result.textBody).toContain("a.ts");
  });

  it("emits stable sha256 for identical inputs (deterministic for audit)", () => {
    const inputs = {
      checkpoint: {
        session_group_id: "grp_x",
        checkpoint_id: "chk_7",
        phase: "p",
        sequence: 1,
      },
      manifest: { delta: ["a.ts"], carried: ["b.ts"], dropped: [] },
      workspaceRoot,
    };
    const r1 = buildObserverWakePayload(inputs);
    const r2 = buildObserverWakePayload(inputs);
    expect(r1.sha256).toBe(r2.sha256);
    expect(r1.textBody).toBe(r2.textBody);
  });
});

describe("assertWakeManifestPathAllowed (EC-7 wrapper)", () => {
  let workspaceRoot: string;
  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "wake-path-test-"));
    writeFileSync(join(workspaceRoot, "inside.ts"), "");
  });
  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("allows an existing file inside the workspace", () => {
    const r = assertWakeManifestPathAllowed("inside.ts", workspaceRoot);
    expect(r.ok).toBe(true);
  });

  it("allows a non-existent file inside the workspace (climbs to parent)", () => {
    const r = assertWakeManifestPathAllowed("not-yet.ts", workspaceRoot);
    expect(r.ok).toBe(true);
  });

  it("rejects absolute paths outside the workspace", () => {
    const r = assertWakeManifestPathAllowed("/etc/passwd", workspaceRoot);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("resolves_outside_workspace");
  });

  it("rejects a symlink that escapes the workspace", () => {
    const outside = mkdtempSync(join(tmpdir(), "wake-path-outside-"));
    writeFileSync(join(outside, "secret.ts"), "");
    symlinkSync(join(outside, "secret.ts"), join(workspaceRoot, "evil-link.ts"));
    try {
      const r = assertWakeManifestPathAllowed("evil-link.ts", workspaceRoot);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("resolves_outside_workspace");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

// ── Static-grep canary ─────────────────────────────────────────────────────
//
// Beck Council Rec 4: the wake dispatcher call site lives INSIDE
// `handleCouncilCheckpoint`'s body. A future refactor that extracts the
// wake into a wrapper and forgets to invoke it would ship green on
// behavioural tests if those tests only exercise the wrapper. This
// canary asserts the call site is mechanically reachable from the
// handler body, regardless of the wrapper's name.

describe("dispatchObserverWake call-site canary (Beck Council Rec 4)", () => {
  it("session-orchestrator.handleCouncilCheckpoint invokes dispatchObserverWake in its body", () => {
    const filePath = fileURLToPath(new URL("./session-orchestrator.ts", import.meta.url));
    const source = _readFileSync(filePath, "utf-8");
    // Find the body of handleCouncilCheckpoint — anchored on the private
    // method declaration, terminated by the next method declaration's
    // signature OR the class brace. Using regex with `\w+` placeholders
    // per `feedback_static_grep_canary_regex_over_substring`.
    const handlerStart = source.indexOf("private handleCouncilCheckpoint(");
    expect(handlerStart).toBeGreaterThan(0);
    // Search the next 4000 characters of source — generous bound for the
    // handler body; if it grows beyond that, the canary is the canary.
    const handlerBody = source.slice(handlerStart, handlerStart + 4000);
    expect(handlerBody).toMatch(/this\.dispatchObserverWake\s*\(/);
  });
});
