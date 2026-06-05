import { chmodSync, closeSync, constants as fsConstants, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { COUNCIL_ARTIFACT_MAX_BYTES } from "./council-types.js";
import { log } from "./logger.js";

/**
 * SYNC by design: the caller needs the rename to be visible AND fsynced
 * before continuing. Async would gain a context switch and a chance to
 * interleave another writer. Per-call cost ≈ one fsync of file + one
 * fsync of parent dir — do NOT invoke from inside tight loops in request
 * handlers; batch writes belong elsewhere.
 *
 * Steps: stringify → byte-size-check → write to `.<rand>.tmp` (O_EXCL,
 * mode 0o600) → `fsync` the fd → `rename` over the target → `fsync` the
 * parent directory. Rename within one filesystem is atomic on POSIX;
 * the watcher sees either the previous version or the new one, never a
 * mixture. On any failure between open and rename, the tmp file is
 * unlinked so no `.<rand>.tmp` leaks accumulate across retries.
 *
 * Throws on filesystem error, oversize, or tmp-name collision (extremely
 * unlikely with 64-bit random suffix + O_EXCL).
 */
export function writeAtomicJson(target: string, payload: unknown): void {
  const dir = dirname(target);
  // Council Review 2026-06-04-0823 P2 #8 (Persistence × Hunt — closes
  // PLAN-aura-dynamic-model-list Task 4's explicit "parent dir 0o700"
  // requirement that the implementation log claimed but dropped):
  // mkdirSync's mode is umask-masked, so even passing `mode: 0o700` here
  // typically lands at `0o700 & ~umask` ≈ `0o700` on most systems but
  // 0o755 if umask is restrictive. Chmod after creation is the deterministic
  // path. Same side-channel (filename + mtime metadata leakage on
  // multi-UID hosts) applies to every writer using this helper —
  // council artifacts, env profiles, settings.json — so closing it at
  // the wrapper is the AP-14 single-assembly-site fix.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    // chmod-after-mkdir is necessary because mkdir's mode is umask-masked.
    // Best-effort: a recursive parent (e.g., COMPANION_HOME) may already
    // exist with broader perms set by a different writer; tightening it
    // here is correct. If chmod fails (e.g., not owner of an existing
    // parent), the atomic write itself still proceeds — file mode 0o600
    // remains enforced by the O_CREAT below.
    chmodSync(dir, 0o700);
  } catch (e) {
    // PR #91 burndown Task 15 (Council Review 2026-06-04-1826 P3 #12):
    // narrow the swallow with a forensic warn so operators can trace
    // bypasses. The catch absorbs four distinct error modes — legitimate
    // cross-UID parent (intended), EACCES on immediate dir from umask
    // (regression — defence silently NOT taken), EPERM on macOS SIP,
    // ENOENT race. The log entry surfaces which one fired so the
    // operator has a triage handle without breaking the best-effort
    // contract that keeps the write succeeding.
    const err = e as NodeJS.ErrnoException;
    log.warn("atomic-write", "chmod-failed", {
      event: "atomic-write.chmod-failed",
      dir,
      error_code: err.code ?? "unknown",
      error_name: err.name ?? "Error",
    });
  }

  const json = JSON.stringify(payload);
  // Byte-count via Buffer — JS string `.length` is UTF-16 code units and
  // undercounts multibyte content by up to 3×. Hunt #6.
  const byteLen = Buffer.byteLength(json, "utf8");
  if (byteLen > COUNCIL_ARTIFACT_MAX_BYTES) {
    throw new Error(
      `atomic-write: payload (${byteLen} bytes) exceeds COUNCIL_ARTIFACT_MAX_BYTES (${COUNCIL_ARTIFACT_MAX_BYTES})`,
    );
  }

  const tmp = join(dir, `.${randomBytes(8).toString("hex")}.tmp`);
  let fd = -1;
  let renamed = false;
  try {
    // O_EXCL fails loudly on collision (rather than silently truncating);
    // mode 0o600 keeps council artifacts unreadable by other UIDs on shared hosts.
    fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    writeSync(fd, json);
    fsyncSync(fd);
    closeSync(fd);
    fd = -1;
    renameSync(tmp, target);
    renamed = true;
  } finally {
    if (fd >= 0) {
      try {
        closeSync(fd);
      } catch {
        /* ignore close-after-failure */
      }
    }
    if (!renamed) {
      // Persistence F4 — unlink the tmp on every failure path so retries
      // don't accumulate `.deadbeef.tmp` files.
      try {
        unlinkSync(tmp);
      } catch {
        /* tmp may not exist if open failed first */
      }
    }
  }

  // fsync the parent directory so the rename itself survives a power cut.
  // Best-effort: some filesystems don't support fsync on directories.
  let dirFd = -1;
  try {
    dirFd = openSync(dir, "r");
    fsyncSync(dirFd);
  } catch {
    /* best-effort */
  } finally {
    if (dirFd >= 0) {
      try {
        closeSync(dirFd);
      } catch {
        /* ignore */
      }
    }
  }
}
