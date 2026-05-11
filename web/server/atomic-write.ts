import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { COUNCIL_ARTIFACT_MAX_BYTES } from "./council-types.js";

/**
 * Write a JSON-serialisable payload to `target` atomically — observers
 * watching this path never see a partial file.
 *
 * Steps: stringify → write to a sibling `.<rand>.tmp` file → `fsync` the
 * fd → `rename` over the target → `fsync` the parent directory so the
 * rename itself is durable across power loss. Rename within one filesystem
 * is atomic on POSIX; the watcher sees either the previous version or the
 * new one, never a mixture.
 *
 * Throws on filesystem error or oversize. The caller chooses retry policy.
 */
export function writeAtomicJson(target: string, payload: unknown): void {
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true });

  const json = JSON.stringify(payload);
  if (json.length > COUNCIL_ARTIFACT_MAX_BYTES) {
    throw new Error(
      `atomic-write: payload (${json.length} bytes) exceeds COUNCIL_ARTIFACT_MAX_BYTES (${COUNCIL_ARTIFACT_MAX_BYTES})`,
    );
  }

  const tmp = join(dir, `.${randomBytes(8).toString("hex")}.tmp`);
  let fd = -1;
  try {
    fd = openSync(tmp, "w");
    writeSync(fd, json);
    fsyncSync(fd);
  } finally {
    if (fd >= 0) closeSync(fd);
  }

  renameSync(tmp, target);

  // fsync the parent directory so the rename itself survives a power cut.
  // Not all filesystems support this (e.g. some tmpfs configs); best-effort.
  let dirFd = -1;
  try {
    dirFd = openSync(dir, "r");
    fsyncSync(dirFd);
  } catch {
    /* best-effort */
  } finally {
    if (dirFd >= 0) closeSync(dirFd);
  }
}
