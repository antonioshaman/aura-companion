import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readServiceUnit, serviceUnitUser } from "./service-status.js";

/**
 * fowler #2 (council review 2026-11-15): the sign-in's "who is the service
 * user" read only /etc/systemd/system. A unit installed by
 * `aura-companion install` lives in ~/.config/systemd/user and has no `User=`
 * — it was invisible, the service user fell back to unknown, and the
 * wrong-user refusal was silently off. Temp dirs only.
 */
let dir: string;
let paths: { system: string; user: string };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "svc-unit-"));
  paths = { system: join(dir, "system", "aura-companion.service"), user: join(dir, "user", "aura-companion.service") };
  mkdirSync(join(dir, "system"));
  mkdirSync(join(dir, "user"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("service unit discovery", () => {
  it("no unit installed → no service user (dev)", () => {
    expect(readServiceUnit(paths).kind).toBeNull();
    expect(serviceUnitUser(paths, () => "me")).toBeNull();
  });

  it("a user unit (aura-companion install) runs as the owner of that home", () => {
    writeFileSync(paths.user, "[Unit]\nDescription=Aura\n[Service]\nExecStart=/usr/bin/bun x\nKillMode=process\n");
    expect(readServiceUnit(paths).kind).toBe("user");
    expect(serviceUnitUser(paths, () => "auracomp")).toBe("auracomp");
  });

  it("a system unit wins over a user unit and its User= is used", () => {
    writeFileSync(paths.user, "[Service]\nExecStart=/x\n");
    writeFileSync(paths.system, "[Service]\nUser=svc\nExecStart=/x\n");
    expect(readServiceUnit(paths).kind).toBe("system");
    expect(serviceUnitUser(paths, () => "someone-else")).toBe("svc");
  });

  it("drop-ins of the user unit are read too (env overrides live there)", () => {
    writeFileSync(paths.user, "[Service]\nExecStart=/x\n");
    mkdirSync(`${paths.user}.d`);
    writeFileSync(join(`${paths.user}.d`, "override.conf"), "[Service]\nEnvironment=COMPANION_ALLOWED_ORIGIN=https://a.example.test\n");
    expect(readServiceUnit(paths).texts).toHaveLength(2);
  });
});
