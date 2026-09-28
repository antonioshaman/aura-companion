import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_STOP_RESOLUTIONS_PER_GROUP,
  addStopResolution,
  readStopResolutions,
} from "./auto-proceed-stop-resolutions.js";

// FIX-AP-1: a human "Dismiss for now" must keep releasing the STOP's hold on
// auto-proceed after a server restart, so the server persists the finding id
// per group. These tests pin the file contract: missing = empty, idempotent
// add, bounded size, and every read failure reported (the caller then holds
// on every STOP — failing toward not firing).

const GROUP = "grp_0123456789abcdef0123456789abcdef";
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function ws(): string {
  const d = mkdtempSync(join(tmpdir(), "ap-res-"));
  dirs.push(d);
  return d;
}
const file = (cwd: string) => join(cwd, ".council", "state", `${GROUP}-resolved-stops.json`);

describe("auto-proceed STOP resolutions", () => {
  it("reads a missing file as an empty list", () => {
    expect(readStopResolutions(ws(), GROUP)).toEqual({ ok: true, findingIds: [] });
  });

  it("adds ids idempotently and round-trips them", () => {
    const cwd = ws();
    expect(addStopResolution(cwd, GROUP, "f1")).toEqual({ ok: true, added: true });
    expect(addStopResolution(cwd, GROUP, "f1")).toEqual({ ok: true, added: false });
    expect(addStopResolution(cwd, GROUP, "f2")).toEqual({ ok: true, added: true });
    expect(readStopResolutions(cwd, GROUP)).toEqual({ ok: true, findingIds: ["f1", "f2"] });
    expect(JSON.parse(readFileSync(file(cwd), "utf8"))).toMatchObject({ schemaVersion: 1, sessionGroupId: GROUP });
  });

  it("keeps only the newest ids past the bound", () => {
    const cwd = ws();
    for (let i = 0; i < MAX_STOP_RESOLUTIONS_PER_GROUP + 3; i++) addStopResolution(cwd, GROUP, `f${i}`);
    const read = readStopResolutions(cwd, GROUP);
    expect(read.ok && read.findingIds.length).toBe(MAX_STOP_RESOLUTIONS_PER_GROUP);
    expect(read.ok && read.findingIds[0]).toBe("f3");
  });

  it("rejects bad input and a malformed group id", () => {
    const cwd = ws();
    expect(addStopResolution(cwd, GROUP, "")).toEqual({ ok: false, reason: "invalid-input" });
    expect(addStopResolution(cwd, GROUP, "x".repeat(257))).toEqual({ ok: false, reason: "invalid-input" });
    expect(addStopResolution(cwd, "../escape", "f1")).toEqual({ ok: false, reason: "path-error" });
    expect(readStopResolutions(cwd, "../escape")).toEqual({ ok: false, reason: "path-error" });
  });

  it("reports corrupt files instead of treating them as empty", () => {
    const cwd = ws();
    mkdirSync(join(cwd, ".council", "state"), { recursive: true });
    writeFileSync(file(cwd), "{nope");
    expect(readStopResolutions(cwd, GROUP)).toEqual({ ok: false, reason: "invalid-json" });
    writeFileSync(file(cwd), JSON.stringify({ schemaVersion: 2, findingIds: [] }));
    expect(readStopResolutions(cwd, GROUP)).toEqual({ ok: false, reason: "invalid-shape" });
    // One bad row does not discard the rest.
    writeFileSync(file(cwd), JSON.stringify({ schemaVersion: 1, findingIds: ["ok", 5, ""] }));
    expect(readStopResolutions(cwd, GROUP)).toEqual({ ok: true, findingIds: ["ok"] });
  });
});
