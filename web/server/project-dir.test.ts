import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureProjectDir, isValidRepoUrl, type CommandRunner } from "./project-dir.js";

// ensureProjectDir runs before a new session's CLI spawns: a folder that does
// not exist on the server is created (or a repo cloned into it) instead of the
// spawn failing as "ENOENT posix_spawn '<claude binary>'". These tests use real
// temp folders; git/sudo go through an injected runner so nothing is cloned.

let base: string;
let run: ReturnType<typeof vi.fn<CommandRunner>>;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "project-dir-"));
  run = vi.fn<CommandRunner>(async () => ({ ok: true, output: "" }));
});

afterEach(() => {
  chmodSync(base, 0o755);
  rmSync(base, { recursive: true, force: true });
});

describe("ensureProjectDir", () => {
  it("leaves an existing folder untouched, even when a repo URL is given", async () => {
    // Cloning into a folder that already has the user's work would be destructive.
    const res = await ensureProjectDir({ cwd: base, repoUrl: "https://github.com/o/r", allowedBases: [base], run });
    expect(res).toEqual({ ok: true, created: false, cloned: false });
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects a path that exists but is a file", async () => {
    const file = join(base, "f.txt");
    writeFileSync(file, "x");
    const res = await ensureProjectDir({ cwd: file, allowedBases: [base], run });
    expect(res).toMatchObject({ ok: false, status: 400 });
  });

  it("rejects a relative path", async () => {
    const res = await ensureProjectDir({ cwd: "proj", allowedBases: [base], run });
    expect(res).toMatchObject({ ok: false, status: 400 });
  });

  it("refuses to create a folder outside the allowed directories", async () => {
    // Same allowlist as the folder picker: a typed path must not let a
    // session create folders anywhere on the host.
    const outside = join(base, "outside", "proj");
    const res = await ensureProjectDir({ cwd: outside, allowedBases: [join(base, "allowed")], run });
    expect(res).toMatchObject({ ok: false, status: 403 });
    expect(existsSync(outside)).toBe(false);
  });

  it("does not treat a sibling with a shared prefix as inside the base", async () => {
    // ".../allowed-evil" must not pass for base ".../allowed".
    const res = await ensureProjectDir({ cwd: join(base, "allowed-evil"), allowedBases: [join(base, "allowed")], run });
    expect(res).toMatchObject({ ok: false, status: 403 });
  });

  it("creates a missing (nested) folder", async () => {
    const cwd = join(base, "a", "b", "proj");
    const res = await ensureProjectDir({ cwd, allowedBases: [base], run });
    expect(res).toEqual({ ok: true, created: true, cloned: false });
    expect(statSync(cwd).isDirectory()).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it("clones the repo into the new folder with an argv (no shell) and no credential prompt", async () => {
    const cwd = join(base, "li-voice-agent");
    const res = await ensureProjectDir({ cwd, repoUrl: " https://github.com/o/li-voice-agent ", allowedBases: [base], run });
    expect(res).toEqual({ ok: true, created: true, cloned: true });
    expect(run).toHaveBeenCalledTimes(1);
    const [file, args, opts] = run.mock.calls[0]!;
    expect(file).toBe("git");
    // "--" stops git from reading the URL as an option.
    expect(args).toEqual(["clone", "--", "https://github.com/o/li-voice-agent", cwd]);
    // A private repo without credentials must fail fast, not wait on a TTY.
    expect(opts.env?.GIT_TERMINAL_PROMPT).toBe("0");
  });

  it("removes the empty folder again when the clone fails, so a retry starts clean", async () => {
    const cwd = join(base, "proj");
    run.mockResolvedValueOnce({ ok: false, output: "fatal: repository not found" });
    const res = await ensureProjectDir({ cwd, repoUrl: "git@github.com:o/proj.git", allowedBases: [base], run });
    expect(res).toMatchObject({ ok: false, status: 500 });
    expect((res as { error: string }).error).toContain("repository not found");
    expect(existsSync(cwd)).toBe(false);
  });

  it("rejects an unsafe repo URL before creating anything", async () => {
    const cwd = join(base, "proj");
    const res = await ensureProjectDir({ cwd, repoUrl: "--upload-pack=touch /tmp/pwn", allowedBases: [base], run });
    expect(res).toMatchObject({ ok: false, status: 400 });
    expect(existsSync(cwd)).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects a non-string repoUrl (request bodies are forwarded untyped)", async () => {
    const res = await ensureProjectDir({ cwd: join(base, "p"), repoUrl: 42 as unknown as string, allowedBases: [base], run });
    expect(res).toMatchObject({ ok: false, status: 400 });
  });

  // chmod does not stop root, so the permission cases only run as a normal user.
  const asRoot = process.getuid?.() === 0;

  it.skipIf(asRoot)("without COMPANION_PROJECT_DIR_SUDO, a permission error names the command to run", async () => {
    // Mirrors prod: projects live in a root-owned /root the service user can't write.
    const parent = join(base, "locked");
    mkdirSync(parent);
    chmodSync(parent, 0o555);
    const cwd = join(parent, "proj");
    const res = await ensureProjectDir({ cwd, allowedBases: [base], env: {}, run });
    chmodSync(parent, 0o755);
    expect(res).toMatchObject({ ok: false, status: 403 });
    expect((res as { error: string }).error).toContain(`sudo install -d -o ${process.getuid!()}`);
    expect(run).not.toHaveBeenCalled();
  });

  it.skipIf(asRoot)("with COMPANION_PROJECT_DIR_SUDO=1, creates it via sudo install owned by the service user", async () => {
    const parent = join(base, "locked");
    mkdirSync(parent);
    chmodSync(parent, 0o555);
    const cwd = join(parent, "proj");
    const res = await ensureProjectDir({ cwd, allowedBases: [base], env: { COMPANION_PROJECT_DIR_SUDO: "1" }, run });
    chmodSync(parent, 0o755);
    expect(res).toEqual({ ok: true, created: true, cloned: false });
    expect(run).toHaveBeenCalledWith(
      "sudo",
      ["-n", "install", "-d", "-o", String(process.getuid!()), "-g", String(process.getgid!()), "--", cwd],
      expect.any(Object),
    );
  });
});

describe("isValidRepoUrl", () => {
  it.each([
    "https://github.com/antonioshaman/li-voice-agent",
    "https://github.com/antonioshaman/li-voice-agent.git",
    "git@github.com:antonioshaman/li-voice-agent.git",
    "https://gitlab.example.com:8443/group/sub/repo",
  ])("accepts %s", (url) => {
    expect(isValidRepoUrl(url)).toBe(true);
  });

  it.each([
    "--upload-pack=x",
    "http://github.com/o/r", // plain http: no
    "file:///etc",
    "https://github.com/o/r; rm -rf /",
    "https://github.com/o/../../r",
    "ext::sh -c touch% /tmp/pwn",
    "",
  ])("rejects %s", (url) => {
    expect(isValidRepoUrl(url)).toBe(false);
  });
});
