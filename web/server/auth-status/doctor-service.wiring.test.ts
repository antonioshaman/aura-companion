import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { DoctorReport } from "./auth-types.js";

/**
 * Service-mode wiring of the doctor (LLM auth phase 1b, CI coverage gate):
 * - `createDoctorDeps({ mode: "service" })` describes the running process as
 *   the service and its fs adapters return metadata-only `DoctorStat`s;
 * - `createDoctorRunner({ mode: "service" })` logs `doctor.completed` with
 *   counts only — never a path (EC-9 / leak boundary);
 * - `getServiceDoctorRunner()` is a process singleton.
 * `runDoctorChecks` is replaced so nothing scans this host's real homes.
 */

const fakeReport: DoctorReport = {
  checkedAt: 1,
  computedBy: "service",
  serviceUser: "svc",
  providers: {
    claude: {
      provider: "claude",
      launched: null,
      requiredVersion: { known: false },
      findings: [{ kind: "credential_copy", provider: "claude", copy: { place: "root_home", homeUser: "root", relPath: ".claude/.credentials.json", absPath: "/root/.claude/.credentials.json", owner: "root", mode: 0o600 } }],
      unchecked: [],
    },
    codex: { provider: "codex", launched: null, requiredVersion: { known: false }, findings: [], unchecked: [{ provider: "codex", check: "credential_copies", reason: "permission_denied" }] },
  },
};

vi.mock("./doctor-checks.js", async (orig) => ({
  ...(await orig<typeof import("./doctor-checks.js")>()),
  runDoctorChecks: vi.fn(async () => fakeReport),
}));

import { log } from "../logger.js";
import { createDoctorDeps, createDoctorRunner, getServiceDoctorRunner } from "./doctor-service.js";

const dir = mkdtempSync(join(tmpdir(), "doctor-wiring-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("createDoctorDeps (service)", () => {
  it("is the running process, with the given companion home", () => {
    const deps = createDoctorDeps({ mode: "service", companionHome: "/srv/companion" });
    expect(deps.computedBy).toBe("service");
    expect(deps.service.uid).toBe(deps.callerUid);
    expect(deps.service.env).toBe(process.env);
    expect(deps.companionHome).toBe("/srv/companion");
    expect(typeof deps.resolveLaunchBinary).toBe("function");
  });

  it("fs adapters return metadata-only stats and plain listings", () => {
    const deps = createDoctorDeps({ mode: "service", companionHome: dir });
    const file = join(dir, "package.json");
    writeFileSync(file, '{"version":"1.2.3"}');
    mkdirSync(join(dir, "sub"));
    symlinkSync(file, join(dir, "link"));

    const st = deps.stat(file);
    expect(st).toEqual({ uid: expect.any(Number), gid: expect.any(Number), mode: expect.any(Number), dev: expect.any(Number), ino: expect.any(Number), isFile: true, isDirectory: false, isSymbolicLink: false });
    expect(deps.lstat(join(dir, "link")).isSymbolicLink).toBe(true);
    expect(deps.stat(join(dir, "sub")).isDirectory).toBe(true);
    expect(deps.realpath(join(dir, "link"))).toBe(deps.realpath(file));
    expect(deps.readdir(dir).sort()).toEqual(["link", "package.json", "sub"]);
    expect(deps.readTextFile(file)).toContain("1.2.3");
    expect(deps.now()).toBeGreaterThan(0);
  });
});

describe("createDoctorRunner (service)", () => {
  it("logs doctor.completed with counts only, never a path", async () => {
    const info = vi.spyOn(log, "info").mockImplementation(() => {});
    const runner = createDoctorRunner({ mode: "service", companionHome: dir });
    await expect(runner.get()).resolves.toBe(fakeReport);
    const call = info.mock.calls.find((c) => c[1] === "doctor.completed");
    expect(call?.[2]).toMatchObject({ event: "doctor.completed", computedBy: "service", findings: 1, unchecked: 1 });
    expect(JSON.stringify(call)).not.toMatch(/credentials|\/root/);
    info.mockRestore();
  });

  it("the offline CLI runner does not log", async () => {
    const info = vi.spyOn(log, "info").mockImplementation(() => {});
    await createDoctorRunner({ mode: "local_cli", unitTexts: [] }).get();
    expect(info.mock.calls.some((c) => c[1] === "doctor.completed")).toBe(false);
    info.mockRestore();
  });
});

describe("getServiceDoctorRunner", () => {
  it("returns one instance per process", () => {
    expect(getServiceDoctorRunner()).toBe(getServiceDoctorRunner());
  });
});
