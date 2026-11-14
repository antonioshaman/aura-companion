import { describe, expect, it, vi } from "vitest";
import { posix } from "node:path";
import type { DoctorReport } from "./auth-types.js";
import {
  compareVersions,
  doctorExitCode,
  runDoctorChecks,
  toRestDoctorReport,
  type DoctorDeps,
  type DoctorStat,
} from "./doctor-checks.js";

/**
 * Doctor checks (spec story 2, plan task 7) against an in-memory filesystem.
 *
 * The fake FS models exactly what the doctor may touch — lstat / stat /
 * realpath / readdir and `readTextFile` for package.json — so a test fails
 * if the doctor ever tries to read a credential file (the fake throws and
 * records it). Credential "contents" carry a canary that must never appear
 * in the report (spec 🚫 "never read / print copy contents").
 */

const SVC_UID = 1001;
const SVC_GID = 1001;
const CANARY = "sk-ant-oat01-CANARY-must-never-leak";

type Node =
  | { type: "file"; uid: number; gid: number; mode: number; ino: number; content?: string }
  | { type: "dir"; uid: number; gid: number; mode: number; ino: number; denied?: boolean }
  | { type: "symlink"; target: string; ino: number };

class FakeFs {
  nodes = new Map<string, Node>();
  credentialReads: string[] = [];
  private nextIno = 10;

  dir(path: string, opts: { uid?: number; denied?: boolean } = {}): this {
    this.nodes.set(path, { type: "dir", uid: opts.uid ?? 0, gid: opts.uid ?? 0, mode: 0o755, ino: this.nextIno++, denied: opts.denied });
    return this;
  }
  file(path: string, opts: { uid?: number; gid?: number; mode?: number; content?: string; ino?: number } = {}): this {
    this.ensureParents(path);
    this.nodes.set(path, {
      type: "file",
      uid: opts.uid ?? SVC_UID,
      gid: opts.gid ?? opts.uid ?? SVC_GID,
      mode: opts.mode ?? 0o600,
      ino: opts.ino ?? this.nextIno++,
      content: opts.content,
    });
    return this;
  }
  link(path: string, target: string): this {
    this.ensureParents(path);
    this.nodes.set(path, { type: "symlink", target, ino: this.nextIno++ });
    return this;
  }
  private ensureParents(path: string): void {
    let dir = posix.dirname(path);
    while (dir !== "/" && !this.nodes.has(dir)) {
      this.nodes.set(dir, { type: "dir", uid: 0, gid: 0, mode: 0o755, ino: this.nextIno++ });
      dir = posix.dirname(dir);
    }
  }
  private err(code: string): Error {
    return Object.assign(new Error(code), { code });
  }
  /** Walk ancestors: a denied dir blocks everything below it (EACCES). */
  private checkTraversal(path: string): void {
    let dir = posix.dirname(path);
    const chain: string[] = [];
    while (dir !== "/") {
      chain.unshift(dir);
      dir = posix.dirname(dir);
    }
    for (const d of chain) {
      const n = this.nodes.get(d);
      if (n?.type === "dir" && n.denied) throw this.err("EACCES");
    }
  }
  private toStat(n: Node): DoctorStat {
    if (n.type === "symlink") return { uid: 0, gid: 0, mode: 0o120777, dev: 1, ino: n.ino, isFile: false, isDirectory: false, isSymbolicLink: true };
    const typeBits = n.type === "file" ? 0o100000 : 0o040000;
    return { uid: n.uid, gid: n.gid, mode: typeBits | n.mode, dev: 1, ino: n.ino, isFile: n.type === "file", isDirectory: n.type === "dir", isSymbolicLink: false };
  }
  lstat = (path: string): DoctorStat => {
    this.checkTraversal(path);
    const n = this.nodes.get(path);
    if (!n) throw this.err("ENOENT");
    return this.toStat(n);
  };
  realpath = (path: string): string => {
    let p = path;
    for (let i = 0; i < 10; i++) {
      this.checkTraversal(p);
      const n = this.nodes.get(p);
      if (!n) throw this.err("ENOENT");
      if (n.type !== "symlink") return p;
      p = n.target.startsWith("/") ? n.target : posix.join(posix.dirname(p), n.target);
    }
    throw this.err("ELOOP");
  };
  stat = (path: string): DoctorStat => {
    const real = this.realpath(path);
    return this.toStat(this.nodes.get(real)!);
  };
  readdir = (path: string): string[] => {
    const n = this.nodes.get(path);
    if (!n) throw this.err("ENOENT");
    if (n.type === "dir" && n.denied) throw this.err("EACCES");
    const prefix = path.endsWith("/") ? path : `${path}/`;
    return [...this.nodes.keys()].filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/")).map((k) => k.slice(prefix.length));
  };
  readTextFile = (path: string): string => {
    if (/auth\.json$|credentials\.json$/.test(path)) {
      this.credentialReads.push(path);
      throw new Error("doctor must not read credential files");
    }
    const real = this.realpath(path);
    const n = this.nodes.get(real);
    if (n?.type !== "file" || n.content === undefined) throw this.err("ENOENT");
    return n.content;
  };
}

const users: Record<number, string> = { 0: "root", [SVC_UID]: "svc", 1002: "other" };

function deps(fs: FakeFs, overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    computedBy: "local_cli",
    service: { name: "svc", uid: SVC_UID, gid: SVC_GID, home: "/home/svc", env: { HOME: "/home/svc", PATH: "/home/svc/.local/bin:/usr/bin" } },
    callerUid: SVC_UID,
    companionHome: "/home/svc/.companion",
    resolveLaunchBinary: (name) => {
      for (const dir of ["/home/svc/.local/bin", "/usr/bin"]) {
        if (fs.nodes.has(`${dir}/${name}`)) return `${dir}/${name}`;
      }
      return null;
    },
    lstat: fs.lstat,
    stat: fs.stat,
    realpath: fs.realpath,
    readdir: fs.readdir,
    readTextFile: fs.readTextFile,
    runProbe: vi.fn(async () => ({ kind: "spawn_error" as const, code: "ENOENT" })),
    userName: (uid) => users[uid] ?? null,
    now: () => 1_700_000_000_000,
    ...overrides,
  };
}

/** A box with no problems: own Claude + Codex installs and primary credentials. */
function cleanBox(): FakeFs {
  const fs = new FakeFs();
  fs.dir("/home").dir("/root");
  fs.file("/home/svc/.local/share/claude/versions/2.1.283", { mode: 0o755 });
  fs.link("/home/svc/.local/bin/claude", "/home/svc/.local/share/claude/versions/2.1.283");
  fs.file("/usr/lib/node_modules/@openai/codex/bin/codex.js", { uid: 0, mode: 0o755 });
  fs.file("/usr/lib/node_modules/@openai/codex/package.json", { uid: 0, mode: 0o644, content: JSON.stringify({ name: "@openai/codex", version: "0.162.1" }) });
  fs.link("/home/svc/.bun/bin/codex", "/usr/lib/node_modules/@openai/codex/bin/codex.js");
  fs.link("/usr/bin/codex", "../lib/node_modules/@openai/codex/bin/codex.js");
  fs.file("/home/svc/.claude/.credentials.json", { content: CANARY });
  fs.file("/home/svc/.codex/auth.json", { content: CANARY });
  return fs;
}

describe("runDoctorChecks — clean box", () => {
  it("reports no findings, versions read from install paths without exec, exit 0", async () => {
    // S2-AC5: no problems → per-provider "all clear" and a success exit code.
    const fs = cleanBox();
    const d = deps(fs);
    const report = await runDoctorChecks(d);
    expect(report.providers.claude.findings).toEqual([]);
    expect(report.providers.codex.findings).toEqual([]);
    expect(report.providers.claude.unchecked).toEqual([]);
    expect(report.providers.codex.unchecked).toEqual([]);
    expect(report.providers.claude.launched?.version).toEqual({ known: true, value: "2.1.283" });
    expect(report.providers.claude.launched?.versionSource).toBe("path");
    // Codex version comes from the npm package.json of the resolved target.
    expect(report.providers.codex.launched?.version).toEqual({ known: true, value: "0.162.1" });
    expect(d.runProbe).not.toHaveBeenCalled();
    expect(doctorExitCode(report)).toBe(0);
  });
});

describe("runDoctorChecks — binaries (S2-AC1, S2-AC2)", () => {
  it("flags a stale root install launched instead of the service user's own install, with both paths and versions", async () => {
    // The incident: /usr/bin/claude → root's 2.1.120 while ~/.local/bin/claude is 2.1.283.
    const fs = cleanBox();
    fs.file("/root/.local/share/claude/versions/2.1.120", { uid: 0, mode: 0o755 });
    fs.link("/usr/bin/claude", "/root/.local/share/claude/versions/2.1.120");
    const report = await runDoctorChecks(deps(fs, { resolveLaunchBinary: (n) => (n === "claude" ? "/usr/bin/claude" : "/usr/bin/codex") }));
    const div = report.providers.claude.findings.find((f) => f.kind === "binary_divergence");
    expect(div).toBeDefined();
    if (div?.kind !== "binary_divergence") throw new Error("unreachable");
    expect(div.launched.location.absPath).toBe("/usr/bin/claude");
    expect(div.launched.target).toMatchObject({ place: "root_home", homeUser: "root", relPath: ".local/share/claude/versions/2.1.120", owner: "root" });
    expect(div.launched.version).toEqual({ known: true, value: "2.1.120" });
    expect(div.reference?.location.absPath).toBe("/home/svc/.local/bin/claude");
    expect(div.reference?.version).toEqual({ known: true, value: "2.1.283" });
  });

  it("names an old launched CLI 'outdated' with the required version (not a model access problem)", async () => {
    const fs = cleanBox();
    fs.file("/home/svc/.local/share/claude/versions/2.1.278", { mode: 0o755 });
    fs.link("/home/svc/.local/bin/claude", "/home/svc/.local/share/claude/versions/2.1.278");
    const report = await runDoctorChecks(deps(fs));
    expect(report.providers.claude.findings).toEqual([
      expect.objectContaining({ kind: "cli_outdated", provider: "claude", required: "2.1.280" }),
    ]);
    expect(report.providers.claude.requiredVersion).toEqual({ known: true, value: "2.1.280" });
  });

  it("Codex parity: divergence is detected the same way; outdated is not applicable (no published floor)", async () => {
    const fs = cleanBox();
    // Service user's own Codex is 0.170.0, but sessions launch the system 0.162.1.
    fs.file("/home/svc/.npm/lib/node_modules/@openai/codex/bin/codex.js", { mode: 0o755 });
    fs.file("/home/svc/.npm/lib/node_modules/@openai/codex/package.json", { content: JSON.stringify({ name: "@openai/codex", version: "0.170.0" }) });
    fs.link("/home/svc/.bun/bin/codex", "/home/svc/.npm/lib/node_modules/@openai/codex/bin/codex.js");
    const report = await runDoctorChecks(deps(fs, { resolveLaunchBinary: (n) => (n === "codex" ? "/usr/bin/codex" : "/home/svc/.local/bin/claude") }));
    const kinds = report.providers.codex.findings.map((f) => f.kind);
    expect(kinds).toEqual(["binary_divergence"]);
    expect(report.providers.codex.requiredVersion).toEqual({ known: false });
  });

  it("flags another user's install when the service user has none of its own", async () => {
    const fs = cleanBox();
    fs.nodes.delete("/home/svc/.local/bin/claude");
    fs.file("/root/.local/share/claude/versions/2.1.300", { uid: 0, mode: 0o755 });
    fs.link("/usr/bin/claude", "/root/.local/share/claude/versions/2.1.300");
    const report = await runDoctorChecks(deps(fs));
    expect(report.providers.claude.findings).toEqual([
      expect.objectContaining({ kind: "binary_divergence", reference: null }),
    ]);
  });

  it("a root-run doctor never executes a binary: version unknown is 'not checked', not a pass", async () => {
    // hunt #2: root must not run another user's binary nor create root-owned files in the service HOME.
    const fs = cleanBox();
    fs.file("/home/svc/.local/share/claude/current", { mode: 0o755 });
    fs.link("/home/svc/.local/bin/claude", "/home/svc/.local/share/claude/current");
    const d = deps(fs, { callerUid: 0 });
    const report = await runDoctorChecks(d);
    expect(d.runProbe).not.toHaveBeenCalled();
    expect(report.providers.claude.launched?.version).toEqual({ known: false });
    expect(report.providers.claude.unchecked).toEqual([
      expect.objectContaining({ check: "cli_version", reason: "version_unknown" }),
    ]);
    expect(doctorExitCode(report)).toBe(2);
  });

  it("as the service user, executes --version only for a binary it (or root) owns and others cannot write", async () => {
    const fs = cleanBox();
    fs.file("/home/svc/.local/share/claude/current", { mode: 0o755 });
    fs.link("/home/svc/.local/bin/claude", "/home/svc/.local/share/claude/current");
    const runProbe = vi.fn(async () => ({ kind: "exited" as const, exitCode: 0, stdout: "2.1.283 (Claude Code)", stderr: "", truncated: false }));
    const ok = await runDoctorChecks(deps(fs, { runProbe }));
    expect(runProbe).toHaveBeenCalledWith("/home/svc/.local/share/claude/current", ["--version"], expect.anything());
    expect(ok.providers.claude.launched?.versionSource).toBe("exec");

    // Same binary but world-writable → never executed.
    fs.file("/home/svc/.local/share/claude/current", { mode: 0o777 });
    runProbe.mockClear();
    await runDoctorChecks(deps(fs, { runProbe }));
    expect(runProbe).not.toHaveBeenCalled();

    // Owned by another (non-root) user → never executed.
    fs.file("/home/svc/.local/share/claude/current", { uid: 1002, mode: 0o755 });
    await runDoctorChecks(deps(fs, { runProbe }));
    expect(runProbe).not.toHaveBeenCalled();
  });
});

describe("runDoctorChecks — credential copies (S2-AC3)", () => {
  it("finds independent copies in other homes and Codex session homes; links to the primary are not copies", async () => {
    const fs = cleanBox();
    fs.file("/root/.codex/auth.json", { uid: 0, content: CANARY });
    fs.file("/root/.claude/.credentials.json", { uid: 0, content: CANARY });
    fs.file("/home/svc/.claude/auth.json", { content: CANARY }); // second candidate next to the primary
    fs.link("/home/svc/.companion/codex-home/s-linked/auth.json", "/home/svc/.codex/auth.json");
    fs.file("/home/svc/.companion/codex-home/s-copied/auth.json", { content: CANARY });
    const primaryIno = (fs.nodes.get("/home/svc/.codex/auth.json") as { ino: number }).ino;
    fs.file("/home/svc/.companion/codex-home/s-hardlink/auth.json", { ino: primaryIno });
    fs.link("/home/svc/.companion/codex-home/s-dangling/auth.json", "/nowhere/auth.json");

    const report = await runDoctorChecks(deps(fs));
    const copies = (id: "claude" | "codex") =>
      report.providers[id].findings.filter((f) => f.kind === "credential_copy").map((f) => (f.kind === "credential_copy" ? f.copy : null));
    expect(copies("codex")).toEqual([
      expect.objectContaining({ place: "root_home", homeUser: "root", relPath: ".codex/auth.json", owner: "root" }),
      expect.objectContaining({ place: "codex_session_home", homeUser: "svc", relPath: ".companion/codex-home/s-copied/auth.json" }),
    ]);
    expect(copies("claude")).toEqual([
      expect.objectContaining({ place: "service_home", relPath: ".claude/auth.json" }),
      expect.objectContaining({ place: "root_home", relPath: ".claude/.credentials.json" }),
    ]);
    // Metadata only: no credential file was ever read, and no content leaked into the report.
    expect(fs.credentialReads).toEqual([]);
    expect(JSON.stringify(report)).not.toContain(CANARY);
    expect(doctorExitCode(report)).toBe(1);
  });

  it("an unreadable home is 'not checked' (permission denied), never 'no copies'", async () => {
    const fs = cleanBox();
    fs.dir("/home/other", { uid: 1002, denied: true });
    const report = await runDoctorChecks(deps(fs));
    expect(report.providers.claude.findings).toEqual([]);
    expect(report.providers.claude.unchecked).toEqual([
      expect.objectContaining({ check: "credential_copies", reason: "permission_denied", place: expect.objectContaining({ place: "other_user_home", homeUser: "other" }) }),
    ]);
    expect(report.providers.codex.unchecked).toEqual([
      expect.objectContaining({ check: "credential_copies", reason: "permission_denied" }),
    ]);
    expect(doctorExitCode(report)).toBe(2);
  });

  it("an unlistable /home is 'not checked' for the whole place", async () => {
    const fs = cleanBox();
    fs.dir("/home", { denied: true });
    fs.nodes.set("/home", { type: "dir", uid: 0, gid: 0, mode: 0o711, ino: 99, denied: false });
    const d = deps(fs, { readdir: (p) => (p === "/home" ? (() => { throw Object.assign(new Error("x"), { code: "EACCES" }); })() : fs.readdir(p)) });
    const report = await runDoctorChecks(d);
    expect(report.providers.claude.unchecked).toEqual([
      expect.objectContaining({ check: "credential_copies", reason: "permission_denied", place: expect.objectContaining({ place: "system", relPath: "/home" }) }),
    ]);
  });
});

describe("runDoctorChecks — owner and permissions (S2-AC4)", () => {
  it("names the file owner and the service user when credentials belong to another user", async () => {
    const fs = cleanBox();
    fs.file("/home/svc/.claude/.credentials.json", { uid: 0, mode: 0o600 });
    const report = await runDoctorChecks(deps(fs));
    expect(report.providers.claude.findings).toEqual([
      expect.objectContaining({ kind: "credential_foreign_owner", serviceUser: "svc", file: expect.objectContaining({ owner: "root" }) }),
      expect.objectContaining({ kind: "credential_unreadable", serviceUser: "svc" }),
    ]);
  });

  it("group-readable foreign file is foreign-owned but readable; an owner file with no read bit is unreadable", async () => {
    const fs = cleanBox();
    fs.file("/home/svc/.codex/auth.json", { uid: 0, gid: SVC_GID, mode: 0o640 });
    fs.file("/home/svc/.claude/.credentials.json", { mode: 0o200 });
    const report = await runDoctorChecks(deps(fs));
    expect(report.providers.codex.findings.map((f) => f.kind)).toEqual(["credential_foreign_owner"]);
    expect(report.providers.claude.findings.map((f) => f.kind)).toEqual(["credential_unreadable"]);
  });
});

describe("report helpers", () => {
  it("REST projection strips every absolute path", async () => {
    const fs = cleanBox();
    fs.file("/root/.codex/auth.json", { uid: 0 });
    const report = await runDoctorChecks(deps(fs));
    expect(JSON.stringify(report)).toContain("/root/.codex/auth.json");
    const rest: DoctorReport = toRestDoctorReport(report);
    expect(JSON.stringify(rest)).not.toContain("absPath");
    expect(JSON.stringify(rest)).not.toContain("/home/svc");
    expect(rest.providers.codex.findings[0]).toMatchObject({ copy: { place: "root_home", relPath: ".codex/auth.json" } });
  });

  it("compareVersions orders numerically", () => {
    expect(compareVersions("2.1.278", "2.1.280")).toBe(-1);
    expect(compareVersions("2.1.300", "2.1.280")).toBe(1);
    expect(compareVersions("2.10.0", "2.9.9")).toBe(1);
    expect(compareVersions("0.162.1", "0.162.1")).toBe(0);
  });
});
