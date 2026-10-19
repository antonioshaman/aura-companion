import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  MAX_IGNORED_RESTORE_GAPS_PER_GROUP,
  UNREADABLE_FINGERPRINT,
  addIgnoredRestoreGap,
  claimedGroupIdOf,
  describeRestoreGap,
  fingerprintReview,
  isRestoreGapIgnored,
  readIgnoredRestoreGaps,
} from "./auto-proceed-restore-gaps.js";

// FIX-AP-4: an incomplete auto-proceed hold restore (a review file the server
// cannot read/parse) used to hold forever with nothing in the UI. These tests
// pin (a) how a gap is described to the ObserverPanel — only review-file gaps
// carry a fingerprint, i.e. are ignorable; (b) the persisted "ignore this
// file" contract — keyed by file AND content, missing = empty, idempotent,
// bounded, every read failure reported (callers then keep every gap blocking);
// (c) the foreign/legacy probe used by the lifecycle's foreign rule.

const GROUP = "grp_0123456789abcdef0123456789abcdef";
const FILE = "phase-1-claude-observer.md";
const FP = "c".repeat(64);
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function ws(): string {
  const d = mkdtempSync(join(tmpdir(), "ap-gaps-"));
  dirs.push(d);
  return d;
}
const file = (cwd: string) => join(cwd, ".council", "state", `${GROUP}-ignored-restore-gaps.json`);

describe("describeRestoreGap", () => {
  it("makes review-file gaps ignorable only when their fingerprint is known", () => {
    const fps = new Map([[FILE, FP]]);
    expect(describeRestoreGap(`review_unparseable:${FILE}`, fps)).toEqual({
      gap: `review_unparseable:${FILE}`,
      reason: expect.stringContaining("unparseable"),
      file: FILE,
      fingerprint: FP,
    });
    expect(describeRestoreGap(`review_unreadable:${FILE}`, fps)).toMatchObject({ reason: "review file could not be read", fingerprint: FP });
    // Unknown fingerprint → shown, not ignorable.
    expect(describeRestoreGap("review_unparseable:other-codex-observer.md", fps).fingerprint).toBeUndefined();
  });

  it("describes workspace-level gaps without an ignore action", () => {
    const none = new Map<string, string>();
    expect(describeRestoreGap("verdicts_invalid-json", none)).toEqual({ gap: "verdicts_invalid-json", reason: "the review verdicts file is not valid JSON" });
    expect(describeRestoreGap("verdicts_weird", none).reason).toBe("the review verdicts file is unusable");
    expect(describeRestoreGap("reviews_readdir_failed", none)).toEqual({ gap: "reviews_readdir_failed", reason: "the reviews folder could not be listed" });
    expect(describeRestoreGap("group_unknown", none)).toEqual({ gap: "group_unknown", reason: "restore incomplete" });
  });
});

describe("fingerprintReview", () => {
  it("is the sha256 of the content, or the unreadable marker", () => {
    expect(fingerprintReview("x")).toBe(createHash("sha256").update("x").digest("hex"));
    expect(fingerprintReview(null)).toBe(UNREADABLE_FINGERPRINT);
  });
});

describe("ignored restore gaps file", () => {
  it("reads a missing file as an empty list", () => {
    expect(readIgnoredRestoreGaps(ws(), GROUP)).toEqual({ ok: true, entries: [] });
  });

  it("adds entries idempotently, keyed by file AND fingerprint", () => {
    const cwd = ws();
    expect(addIgnoredRestoreGap(cwd, GROUP, { file: FILE, fingerprint: FP })).toEqual({ ok: true, added: true });
    expect(addIgnoredRestoreGap(cwd, GROUP, { file: FILE, fingerprint: FP })).toEqual({ ok: true, added: false });
    expect(addIgnoredRestoreGap(cwd, GROUP, { file: FILE, fingerprint: UNREADABLE_FINGERPRINT })).toEqual({ ok: true, added: true });
    const read = readIgnoredRestoreGaps(cwd, GROUP);
    expect(read).toEqual({ ok: true, entries: [{ file: FILE, fingerprint: FP }, { file: FILE, fingerprint: UNREADABLE_FINGERPRINT }] });
    expect(JSON.parse(readFileSync(file(cwd), "utf8"))).toMatchObject({ schemaVersion: 1, sessionGroupId: GROUP });
    const entries = read.ok ? read.entries : [];
    expect(isRestoreGapIgnored(entries, FILE, FP)).toBe(true);
    // Same name, different content: the human never saw it.
    expect(isRestoreGapIgnored(entries, FILE, "d".repeat(64))).toBe(false);
  });

  it("rejects anything but a review file name and a well-formed fingerprint", () => {
    const cwd = ws();
    expect(addIgnoredRestoreGap(cwd, GROUP, { file: "../x-claude-observer.md", fingerprint: FP })).toMatchObject({ ok: false, reason: "invalid-input" });
    expect(addIgnoredRestoreGap(cwd, GROUP, { file: "notes.md", fingerprint: FP })).toMatchObject({ ok: false, reason: "invalid-input" });
    expect(addIgnoredRestoreGap(cwd, GROUP, { file: FILE, fingerprint: "ABC" })).toMatchObject({ ok: false, reason: "invalid-input" });
    expect(addIgnoredRestoreGap(cwd, "not-a-group", { file: FILE, fingerprint: FP })).toMatchObject({ ok: false, reason: "path-error" });
  });

  it("keeps the file bounded (oldest evicted)", () => {
    const cwd = ws();
    for (let i = 0; i <= MAX_IGNORED_RESTORE_GAPS_PER_GROUP; i++) {
      addIgnoredRestoreGap(cwd, GROUP, { file: `p${i}-claude-observer.md`, fingerprint: FP });
    }
    const read = readIgnoredRestoreGaps(cwd, GROUP);
    expect(read.ok && read.entries.length).toBe(MAX_IGNORED_RESTORE_GAPS_PER_GROUP);
    expect(read.ok && read.entries[0]!.file).toBe("p1-claude-observer.md");
  });

  it("reports corrupt files (callers keep every gap blocking) and drops bad rows only", () => {
    const cwd = ws();
    mkdirSync(join(cwd, ".council", "state"), { recursive: true });
    writeFileSync(file(cwd), "{nope");
    expect(readIgnoredRestoreGaps(cwd, GROUP)).toEqual({ ok: false, reason: "invalid-json" });
    writeFileSync(file(cwd), JSON.stringify({ schemaVersion: 2, entries: [] }));
    expect(readIgnoredRestoreGaps(cwd, GROUP)).toEqual({ ok: false, reason: "invalid-shape" });
    writeFileSync(file(cwd), JSON.stringify([]));
    expect(readIgnoredRestoreGaps(cwd, GROUP)).toEqual({ ok: false, reason: "invalid-shape" });
    writeFileSync(file(cwd), JSON.stringify({
      schemaVersion: 1,
      entries: [{ file: FILE, fingerprint: FP }, { file: "../etc", fingerprint: FP }, { file: FILE }, null],
    }));
    expect(readIgnoredRestoreGaps(cwd, GROUP)).toEqual({ ok: true, entries: [{ file: FILE, fingerprint: FP }] });
  });
});

describe("claimedGroupIdOf (foreign / legacy probe)", () => {
  it("returns the named group, or null for legacy / non-JSON content", () => {
    expect(claimedGroupIdOf(JSON.stringify({ session_group_id: "grp_other", findings: 1 }))).toBe("grp_other");
    expect(claimedGroupIdOf(JSON.stringify({ findings: [] }))).toBeNull();
    expect(claimedGroupIdOf(JSON.stringify({ session_group_id: "" }))).toBeNull();
    expect(claimedGroupIdOf(JSON.stringify([{ session_group_id: "grp_other" }]))).toBeNull();
    expect(claimedGroupIdOf("# markdown review")).toBeNull();
  });
});
