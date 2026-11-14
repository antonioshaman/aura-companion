/**
 * S3-AC6 — stale session copy vs dead primary vs incomparable (task 11).
 *
 * Uses real files in a temp dir (synthetic content, never real credentials)
 * so dev/ino/mtime come from the kernel, plus the launcher's symlink layout:
 * a fresh Codex session home holds `auth.json → <primary>`; an in-session
 * refresh replaces the symlink with a regular file (rename(2)).
 */
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureCredentialGeneration, compareCredentialGeneration } from "./session-credential-generation.js";
import { classifyClaudeTurnFailure } from "./turn-failure.js";

let dir: string;
let primary: string;
let sessionHome: string;

function setMtime(path: string, epochSec: number) {
  utimesSync(path, epochSec, epochSec);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cred-gen-"));
  primary = join(dir, "primary-auth.json");
  sessionHome = join(dir, "session");
  writeFileSync(primary, '{"synthetic":"v1"}');
  setMtime(primary, 1_700_000_000);
  mkdirSync(sessionHome);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("compareCredentialGeneration", () => {
  it("symlinked session, primary unchanged → same (a dead primary sign-in: re-login)", () => {
    symlinkSync(primary, join(sessionHome, "auth.json"));
    const launch = captureCredentialGeneration(join(sessionHome, "auth.json"));
    expect(compareCredentialGeneration({ launch, sessionAuthPath: join(sessionHome, "auth.json"), primaryAuthPath: primary })).toBe("same");
  });

  it("primary re-written by a re-login after launch (atomic rename, newer) → renewed (restart the session)", () => {
    symlinkSync(primary, join(sessionHome, "auth.json"));
    const launch = captureCredentialGeneration(join(sessionHome, "auth.json"));
    // `codex login` writes tmp + rename → new inode, newer mtime.
    const tmp = join(dir, "tmp-auth.json");
    writeFileSync(tmp, '{"synthetic":"v2-after-relogin"}');
    setMtime(tmp, 1_700_000_500);
    renameSync(tmp, primary);
    expect(compareCredentialGeneration({ launch, sessionAuthPath: join(sessionHome, "auth.json"), primaryAuthPath: primary })).toBe("renewed");
  });

  it("session holds its own regular copy older than the primary → renewed", () => {
    const copy = join(sessionHome, "auth.json");
    writeFileSync(copy, '{"synthetic":"old-copy"}');
    setMtime(copy, 1_600_000_000);
    const launch = captureCredentialGeneration(copy);
    expect(compareCredentialGeneration({ launch, sessionAuthPath: join(sessionHome, "auth.json"), primaryAuthPath: primary })).toBe("renewed");
  });

  it("session rotated its own copy (newer than primary) → same: the primary is not the fix", () => {
    const copy = join(sessionHome, "auth.json");
    writeFileSync(copy, '{"synthetic":"rotated-in-session"}');
    setMtime(copy, 1_800_000_000);
    const launch = captureCredentialGeneration(copy);
    expect(compareCredentialGeneration({ launch, sessionAuthPath: join(sessionHome, "auth.json"), primaryAuthPath: primary })).toBe("same");
  });

  it("observer STOP (cp 199): primary renewed after launch, then the session rotated its own copy → same", () => {
    // t1 launch on the shared symlink, t2 re-login rewrites the primary,
    // t3 the session refreshes and rename(2)s its own newer file over the
    // symlink. The session's copy is the newest — restarting it is not the fix.
    const sessionPath = join(sessionHome, "auth.json");
    symlinkSync(primary, sessionPath);
    const launch = captureCredentialGeneration(sessionPath);
    const tmp = join(dir, "tmp-auth.json");
    writeFileSync(tmp, '{"synthetic":"v2-relogin"}');
    setMtime(tmp, 1_700_000_500);
    renameSync(tmp, primary);
    const rotated = join(sessionHome, "rotated.tmp");
    writeFileSync(rotated, '{"synthetic":"v3-session-rotated"}');
    setMtime(rotated, 1_700_000_900);
    renameSync(rotated, sessionPath);
    expect(compareCredentialGeneration({ launch, sessionAuthPath: sessionPath, primaryAuthPath: primary })).toBe("same");
  });

  it("no launch snapshot or primary gone → incomparable", () => {
    expect(compareCredentialGeneration({ launch: null, sessionAuthPath: join(sessionHome, "auth.json"), primaryAuthPath: primary })).toBe("incomparable");
    const launch = captureCredentialGeneration(primary);
    rmSync(primary);
    expect(compareCredentialGeneration({ launch, sessionAuthPath: join(sessionHome, "auth.json"), primaryAuthPath: primary })).toBe("incomparable");
  });

  it("dangling session symlink at launch → no snapshot", () => {
    symlinkSync(join(dir, "missing.json"), join(sessionHome, "auth.json"));
    expect(captureCredentialGeneration(join(sessionHome, "auth.json"))).toBeNull();
  });
});

describe("Claude has no per-session copy", () => {
  it("a Claude auth failure is never stale_session_credentials", () => {
    // Claude sessions read ~/.claude/.credentials.json directly, so the
    // classifier is never asked about a generation: 401 → auth_rejected.
    const r = classifyClaudeTurnFailure(
      { apiErrorStatus: 401, resultText: "Invalid API key", errors: [], assistantError: "authentication_failed", rateLimit: null, lastRetry: null },
      Date.now(),
    );
    expect(r.kind === "classified" && r.failure.kind).toBe("auth_rejected");
  });
});
