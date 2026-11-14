import { describe, expect, it, vi } from "vitest";
import { userInfo } from "node:os";
import type { DoctorReport } from "./auth-types.js";
import { DoctorRunner, createDoctorDeps, parsePasswd } from "./doctor-service.js";
import { RECHECK_MIN_INTERVAL_MS } from "./status-core.js";

/**
 * Doctor production wiring: passwd parsing, service identity for the offline
 * CLI (from the unit, not the caller), and the cache / recheck pause that the
 * REST POST relies on.
 */

const report = (n: number): DoctorReport => ({
  checkedAt: n,
  computedBy: "service",
  serviceUser: "svc",
  providers: {
    claude: { provider: "claude", launched: null, requiredVersion: { known: false }, findings: [], unchecked: [] },
    codex: { provider: "codex", launched: null, requiredVersion: { known: false }, findings: [], unchecked: [] },
  },
});

describe("parsePasswd", () => {
  it("parses entries and skips malformed lines", () => {
    const text = "root:x:0:0:root:/root:/bin/bash\n# comment\nbroken-line\nsvc:x:1001:1001::/home/svc:/bin/bash\n";
    expect(parsePasswd(text)).toEqual([
      { name: "root", uid: 0, gid: 0, home: "/root" },
      { name: "svc", uid: 1001, gid: 1001, home: "/home/svc" },
    ]);
  });
});

describe("createDoctorDeps (offline CLI)", () => {
  it("takes the service user's HOME and PATH from the systemd unit, not from the caller", () => {
    // S2 offline mode: with the server stopped, identity comes from the unit file.
    const me = userInfo();
    const unit = `[Service]\nUser=${me.username}\nEnvironment="HOME=/srv/svc-home" "PATH=/opt/svc/bin:/usr/bin"\n`;
    const deps = createDoctorDeps({ mode: "local_cli", unitTexts: [unit] });
    expect(deps.computedBy).toBe("local_cli");
    expect(deps.service.name).toBe(me.username);
    expect(deps.service.home).toBe("/srv/svc-home");
    expect(deps.service.env.PATH).toBe("/opt/svc/bin:/usr/bin");
    expect(deps.companionHome).toBe("/srv/svc-home/.companion");
  });

  it("without a unit, the caller is the service", () => {
    const deps = createDoctorDeps({ mode: "local_cli", unitTexts: [] });
    expect(deps.service.uid).toBe(deps.callerUid);
  });
});

describe("DoctorRunner", () => {
  it("peek is cache-only; get runs once for concurrent callers", async () => {
    let resolve!: (r: DoctorReport) => void;
    const run = vi.fn(() => new Promise<DoctorReport>((r) => { resolve = r; }));
    const runner = new DoctorRunner(run, () => 0);
    expect(runner.peek()).toBeNull();
    expect(run).not.toHaveBeenCalled();
    const a = runner.get();
    const b = runner.get();
    resolve(report(1));
    expect(await a).toBe(await b);
    expect(run).toHaveBeenCalledTimes(1);
    expect(runner.peek()?.checkedAt).toBe(1);
  });

  it("recheck is limited to one per 30 s and a limited call still gets the in-flight result", async () => {
    let now = 1_000;
    let n = 0;
    let release!: () => void;
    const run = vi.fn(async () => {
      await new Promise<void>((r) => { release = r; });
      return report(++n);
    });
    const onCompleted = vi.fn();
    const runner = new DoctorRunner(run, () => now, onCompleted);
    const first = runner.recheck();
    const second = runner.recheck(); // while the first is still running
    release();
    expect(await first).toEqual({ kind: "ok", report: report(1) });
    expect(await second).toEqual({ kind: "too_soon", retryAfterMs: RECHECK_MIN_INTERVAL_MS, report: report(1) });
    expect(onCompleted).toHaveBeenCalledTimes(1);

    now += RECHECK_MIN_INTERVAL_MS;
    const third = runner.recheck();
    release();
    expect((await third).kind).toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
  });
});
