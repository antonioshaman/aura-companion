import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getOrCreateInstanceId } from "./instance-id.js";

let tempDir: string;
let idPath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "instance-id-test-"));
  idPath = join(tempDir, "instance-id.json");
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("getOrCreateInstanceId", () => {
  it("generates a Worker-shaped id and persists it on first call", () => {
    const id = getOrCreateInstanceId(idPath);
    expect(id).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
    const onDisk = JSON.parse(readFileSync(idPath, "utf-8")) as { instanceId: string };
    expect(onDisk.instanceId).toBe(id);
  });

  it("returns the same id across calls (stable identity)", () => {
    const first = getOrCreateInstanceId(idPath);
    const second = getOrCreateInstanceId(idPath);
    expect(second).toBe(first);
  });

  it("regenerates when the persisted id is malformed", () => {
    writeFileSync(idPath, JSON.stringify({ instanceId: "bad id!" }), "utf-8");
    const id = getOrCreateInstanceId(idPath);
    expect(id).not.toBe("bad id!");
    expect(id).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
  });

  it("regenerates when the file is corrupt JSON", () => {
    writeFileSync(idPath, "{not json", "utf-8");
    const id = getOrCreateInstanceId(idPath);
    expect(id).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
  });
});
