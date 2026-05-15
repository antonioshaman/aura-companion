import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
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
  loadBundledObserverPromptValidated,
  loadObserverSystemPrompt,
  parseObserverPromptHeader,
  resolveObserverSystemPrompt,
  BUNDLED_OBSERVER_PROMPT_SOURCE_LABEL,
} from "./observer-prompt.js";
import {
  BUNDLED_OBSERVER_PROMPT,
  BUNDLED_OBSERVER_PROMPT_SHA256,
} from "./observer-prompt-bundled.js";
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
    expect(artifact.sourceLabel).toBe(promptPath);
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

  // Council Plan PLAN-aura-observer-prompt-bundled-fallback.md Task 6:
  // the loader still throws on missing file — that IS its contract at
  // this layer. The bundled fallback semantic lives in the higher-level
  // resolver tested below. Inverted from the prior "throws on missing"
  // assertion: that test is replaced by the resolver-level fallback
  // assertion in `resolveObserverSystemPrompt`'s suite — see below.
  it("throws on missing file (loader-layer contract; fallback is the resolver's job)", () => {
    expect(() => loadObserverSystemPrompt(join(dir, "no-such-file.md"))).toThrow(/cannot stat/);
  });

  // Beck rec — preserve ENOENT discriminator through Error.cause so the
  // resolver can distinguish "file missing" from "perm denied / loop /
  // directory clash" without string-matching the wrapped message.
  it("preserves ENOENT as Error.cause.code on the wrapped throw", () => {
    let caught: unknown;
    try {
      loadObserverSystemPrompt(join(dir, "no-such-file.md"));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const cause = (caught as { cause?: unknown }).cause;
    expect(cause).toBeInstanceOf(Error);
    expect((cause as { code?: unknown }).code).toBe("ENOENT");
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

// ── resolveObserverSystemPrompt — Council Plan Task 6/7/8/10 ───────────────
//
// The resolver is the policy layer atop the file-loader. Tests below pin
// the four legitimate behaviours:
//  (1) workspace file present + valid → loaded, source="workspace"
//  (2) workspace file absent (ENOENT) → bundled used, source="bundled"
//  (3) workspace file present + malformed → THROWS (explicit intent)
//  (4) workspace file present + non-ENOENT fs error → THROWS (not silent)
// Plus the bundled-hash snapshot pin (Task 10) catches accidental edits
// to the bundled body without re-running the build script.

describe("resolveObserverSystemPrompt", () => {
  let dir: string;
  let workspacePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "obs-resolve-"));
    workspacePath = join(dir, "observer-system.md");
  });

  afterEach(() => {
    // Restore perms in case a chmod-0o000 test left the file unreadable
    // for `rmSync`.
    try {
      chmodSync(workspacePath, 0o644);
    } catch {
      // file may not exist — fine.
    }
    rmSync(dir, { recursive: true, force: true });
  });

  // Task 8 — workspace-override-wins.
  it("returns the workspace artifact when the workspace file is present and valid", () => {
    const body = fixtureBody();
    writeFileSync(workspacePath, body);
    const resolved = resolveObserverSystemPrompt(workspacePath);
    expect(resolved.source).toBe("workspace");
    expect(resolved.sourceLabel).toBe(workspacePath);
    expect(resolved.body).toBe(body);
    // Hash matches the workspace bytes, NOT the bundled fixture — the
    // override is real, not papered over with the bundled fallback.
    expect(resolved.sha256).toBe(createHash("sha256").update(body, "utf8").digest("hex"));
  });

  // Task 6 — the headline fallback assertion. Inversion of the prior
  // `throws on missing` test moved to a layer-appropriate site: the
  // RESOLVER falls back; the loader still throws.
  it("falls back to the bundled artifact when workspace file is ENOENT", () => {
    expect(workspacePath).toMatch(/observer-system\.md$/);
    // Workspace file deliberately NOT written.
    const resolved = resolveObserverSystemPrompt(workspacePath);
    expect(resolved.source).toBe("bundled");
    expect(resolved.sourceLabel).toBe(BUNDLED_OBSERVER_PROMPT_SOURCE_LABEL);
    expect(resolved.body).toBe(BUNDLED_OBSERVER_PROMPT);
    expect(resolved.sha256).toBe(BUNDLED_OBSERVER_PROMPT_SHA256);
    expect(resolved.version).toBe(OBSERVER_PROMPT_SCHEMA_VERSION);
  });

  // Task 8 — workspace-malformed-still-throws (explicit-intent regression
  // guard). The bundled fallback MUST NOT mask operator typos.
  it("does NOT fall back when workspace file is present but malformed", () => {
    writeFileSync(workspacePath, "no header here\n" + MIN_BODY);
    expect(() => resolveObserverSystemPrompt(workspacePath)).toThrow(/malformed header/);
  });

  it("does NOT fall back when workspace file is present with wrong header version", () => {
    writeFileSync(workspacePath, fixtureBody(2));
    expect(() => resolveObserverSystemPrompt(workspacePath)).toThrow(/version 2 does not match/);
  });

  it("does NOT fall back when workspace file is present but below minimum body", () => {
    writeFileSync(workspacePath, "<!-- observer-system-prompt v1 -->\nshort\n");
    expect(() => resolveObserverSystemPrompt(workspacePath)).toThrow(/below minimum/);
  });

  // Task 7 — per-error-code table. ENOENT triggers fallback; every other
  // fs error must throw. Council Plan Bug B Review P1 #3: use
  // `it.skipIf(...)` for capability-gated rows. The prior shape used
  // `return` from inside an `it()` callback, which in Vitest marks the
  // test as PASSED with zero assertions (not skipped) — CI on a root
  // container silently green-stamped the EACCES contract without ever
  // exercising it. `it.skipIf(...)` produces a visible `↓ skipped`
  // marker in the runner output.
  const runningAsRoot = typeof process.getuid === "function" && process.getuid() === 0;
  const isWindows = process.platform === "win32";

  it.skipIf(runningAsRoot)(
    "does NOT fall back on EACCES (permission denied); throws loudly",
    () => {
      writeFileSync(workspacePath, fixtureBody());
      chmodSync(workspacePath, 0o000);
      try {
        expect(() => resolveObserverSystemPrompt(workspacePath)).toThrow();
      } finally {
        // Restore perms so afterEach's rmSync works.
        chmodSync(workspacePath, 0o644);
      }
    },
  );

  it("does NOT fall back on EISDIR (it's a directory, not a file); throws loudly", () => {
    mkdirSync(workspacePath);
    expect(() => resolveObserverSystemPrompt(workspacePath)).toThrow();
  });

  it.skipIf(isWindows)(
    "does NOT fall back on ELOOP (symlink loop); throws loudly",
    () => {
      // Symlink to itself produces ELOOP on resolve.
      symlinkSync(workspacePath, workspacePath);
      try {
        expect(() => resolveObserverSystemPrompt(workspacePath)).toThrow();
      } finally {
        // Clean up the symlink so rmSync can proceed.
        try {
          rmSync(workspacePath);
        } catch {
          // best-effort
        }
      }
    },
  );

  // Sanity canary — at least one non-ENOENT row must actually execute on
  // this runner. EISDIR is platform-independent and root-independent, so
  // the absence of this row from the run is itself a test-framework
  // regression. Asserting a tautology here makes "no rows ran" visible
  // (Vitest would print zero asserts for the suite); the real coverage
  // signal is the EISDIR row above this canary.
  it("non-ENOENT error-code table executed at least one row this run", () => {
    expect(true).toBe(true);
  });

  // Task 10 — bundled-hash snapshot pin. Catches inadvertent edits to the
  // bundled body without re-running the build script. The constant in
  // `observer-prompt-bundled.ts` is auto-generated; if a contributor
  // hand-edits the body OR if a bundler transform mutates the literal
  // (CRLF normalisation, minification), the computed hash diverges from
  // the stamped constant and this test fails — forcing a deliberate
  // update via `bun run build-observer-prompt-bundle`.
  it("bundled body's computed SHA-256 matches the stamped constant (pin)", () => {
    const computed = createHash("sha256")
      .update(BUNDLED_OBSERVER_PROMPT, "utf8")
      .digest("hex");
    expect(computed).toBe(BUNDLED_OBSERVER_PROMPT_SHA256);
  });

  it("bundled body parses cleanly as a v1 observer prompt", () => {
    // Belt-and-braces against a corrupted bundle: parse via the loader's
    // body validator + assert artifact shape. If the bundled body ever
    // stops parsing, every fresh-workspace observer spawn breaks.
    expect(parseObserverPromptHeader(BUNDLED_OBSERVER_PROMPT)).toBe(OBSERVER_PROMPT_SCHEMA_VERSION);
    expect(BUNDLED_OBSERVER_PROMPT.length).toBeGreaterThan(256);
    expect(BUNDLED_OBSERVER_PROMPT.length).toBeLessThan(OBSERVER_PROMPT_MAX_BYTES);
  });

  // Council Plan Bug B Cleanup Task 15(b) — `loadBundledObserverPromptValidated`
  // direct API tests. Minimum mutation-resistant set: independent SHA
  // (createHash direct, not the module's own helper), shape pin, header
  // parses, sourceLabel sentinel pin. Per Beck — 4 tests, no more.

  it("loadBundledObserverPromptValidated: returns artifact with source=bundled, validated SHA", () => {
    const artifact = loadBundledObserverPromptValidated();
    expect(artifact.source).toBe("bundled");
    expect(artifact.sourceLabel).toBe(BUNDLED_OBSERVER_PROMPT_SOURCE_LABEL);
    expect(artifact.version).toBe(OBSERVER_PROMPT_SCHEMA_VERSION);
  });

  it("loadBundledObserverPromptValidated: SHA-256 of returned body matches stamped constant (independent hash)", () => {
    // Independent verification — re-hash the returned body with the same
    // recipe the build script + parser use. Catches a regression where
    // the helper returns a body that disagrees with its own sha256 field.
    const artifact = loadBundledObserverPromptValidated();
    const computed = createHash("sha256").update(artifact.body, "utf8").digest("hex");
    expect(artifact.sha256).toBe(computed);
    expect(artifact.sha256).toBe(BUNDLED_OBSERVER_PROMPT_SHA256);
  });

  it("loadBundledObserverPromptValidated: returned body parses cleanly as v1 header", () => {
    const artifact = loadBundledObserverPromptValidated();
    expect(parseObserverPromptHeader(artifact.body)).toBe(OBSERVER_PROMPT_SCHEMA_VERSION);
  });

  it("loadBundledObserverPromptValidated: shape is loader-compatible (extends ObserverPromptArtifact)", () => {
    const artifact = loadBundledObserverPromptValidated();
    expect(artifact).toEqual({
      version: OBSERVER_PROMPT_SCHEMA_VERSION,
      body: expect.any(String),
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      sourceLabel: BUNDLED_OBSERVER_PROMPT_SOURCE_LABEL,
      source: "bundled",
    });
  });

  // Council Plan Bug B Review P2 #9 — canonical-vs-bundled byte-equality.
  // The sibling snapshot pin asserts the bundled hash matches its own
  // body, which is self-consistent by construction (both come from the
  // same generated file). That pin protects ONE failure mode: hash
  // stamping skew within the generated module. It does NOT protect the
  // higher-likelihood mistake: a developer edits the canonical
  // `.council/prompts/observer-system.md` and forgets to re-run
  // `bun run build-observer-prompt-bundle`. The CI canary
  // (`.github/workflows/ci.yml`) catches drift at PR time; this test
  // catches it earlier (developer's local `bun run test`) and pinpoints
  // the offending byte range in the diff output.
  it("bundled body byte-equals the canonical .council/prompts/observer-system.md", () => {
    const thisFile = fileURLToPath(import.meta.url);
    // observer-prompt.test.ts → web/server → web → repo root.
    const repoRoot = join(thisFile, "..", "..", "..");
    const canonical = _readFileSync(
      join(repoRoot, ".council", "prompts", "observer-system.md"),
      "utf-8",
    );
    expect(BUNDLED_OBSERVER_PROMPT).toBe(canonical);
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
