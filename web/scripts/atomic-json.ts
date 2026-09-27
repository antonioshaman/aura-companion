#!/usr/bin/env bun
// Shared atomic JSON writer for the web/scripts engine modules (run-stats,
// result-cache, …). tmp(O_EXCL) → fsync → rename: a concurrent reader sees either
// the previous file or the new one, never a partial write, and concurrent writers
// on this multi-agent box don't interleave. Extracted so callers share one audited
// implementation instead of duplicating the pattern (dry:check).

import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

export function writeJsonAtomic(
  target: string,
  payload: unknown,
  opts?: { maxBytes?: number; label?: string },
): void {
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* best-effort: a shared COMPANION_HOME may be owned by another writer */
  }
  const json = JSON.stringify(payload);
  const byteLen = Buffer.byteLength(json, "utf8");
  if (opts?.maxBytes !== undefined && byteLen > opts.maxBytes) {
    throw new Error(`${opts.label ?? "atomic-json"}: payload (${byteLen} bytes) exceeds ${opts.maxBytes}`);
  }
  const tmp = join(dir, `.${randomBytes(8).toString("hex")}.tmp`);
  let fd = -1;
  let renamed = false;
  try {
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
        /* ignore */
      }
    }
    if (!renamed) {
      try {
        unlinkSync(tmp);
      } catch {
        /* tmp may not exist if open failed */
      }
    }
  }
}
