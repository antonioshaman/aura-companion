/**
 * Codex home isolation for the AuraBench harness (P6/FIX-D2-1).
 *
 * Pilot 1 ran naked Codex (B) against the REAL `~/.codex`: it appended
 * `trust_level` entries to `config.toml` and rewrote the memories / state /
 * logs sqlite files and `shell_snapshots` — files prod's Codex observers share,
 * and through which B cells saw each other's memory. Requirement: no variant
 * writes the real `~/.codex` except the unavoidable auth refresh, and that is
 * PROVEN per cell, not asserted.
 *
 *  - {@link prepareIsolatedCodexHome}: a fresh per-cell `CODEX_HOME` whose only
 *    link to the real one is an `auth.json` symlink (no config, memories,
 *    skills, AGENTS.md, history, sqlite). Same sharing model prod uses for
 *    per-session Codex homes (cli-launcher `prepareCodexHome`).
 *  - {@link propagateRotatedCodexAuth}: Codex refreshes the OAuth token with
 *    tmp-file + rename(2), which REPLACES the symlink with a regular file. The
 *    old refresh token in the real `auth.json` is then spent, and prod would
 *    need a re-login. So after the cell the rotated token is written back, but
 *    only if the real file is byte-identical to what the cell started from
 *    (nobody else rotated it meanwhile); otherwise it is left alone. The cell
 *    copy is always deleted (no credential left in the artifacts).
 *  - {@link snapshotDir} / {@link diffSnapshots}: mtime + size + sha256 of every
 *    file of the real `~/.codex` before and after the cell. Any change other
 *    than `auth.json` is an isolation violation.
 *  - {@link guardRealCodexHome}: wraps ANY agent runner (naked or Aura) with
 *    that snapshot, so the evidence lands in every cell record.
 *
 * Firewall-clean (node:fs only).
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import type { AgentRun, AgentRunner } from "./run-cell.js";

export const CODEX_AUTH_FILE = "auth.json";

/** Files above this size are compared by mtime + size only (no hash). */
const HASH_LIMIT_BYTES = 8 * 1024 * 1024;

export interface FileFingerprint {
  size: number;
  mtimeMs: number;
  /** sha256; null above {@link HASH_LIMIT_BYTES}, "symlink:<target>" for links. */
  sha256: string | null;
}

export type DirSnapshot = Map<string, FileFingerprint>;

/**
 * Fingerprint every file under `dir` (relative paths; symlinks are recorded,
 * never followed). A missing dir is an empty snapshot. Unreadable entries are
 * recorded with a null hash rather than aborting the snapshot.
 */
export function snapshotDir(dir: string): DirSnapshot {
  const out: DirSnapshot = new Map();
  if (!existsSync(dir)) return out;
  const walk = (d: string) => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const name of names) {
      const p = join(d, name);
      let st;
      try {
        st = lstatSync(p);
      } catch {
        continue;
      }
      const rel = relative(dir, p);
      if (st.isSymbolicLink()) {
        let target = "";
        try {
          target = readlinkSync(p);
        } catch {
          // dangling or unreadable
        }
        out.set(rel, { size: st.size, mtimeMs: st.mtimeMs, sha256: `symlink:${target}` });
      } else if (st.isDirectory()) {
        walk(p);
      } else if (st.isFile()) {
        let sha256: string | null = null;
        if (st.size <= HASH_LIMIT_BYTES) {
          try {
            sha256 = createHash("sha256").update(readFileSync(p)).digest("hex");
          } catch {
            sha256 = null;
          }
        }
        out.set(rel, { size: st.size, mtimeMs: st.mtimeMs, sha256 });
      }
    }
  };
  walk(dir);
  return out;
}

export interface SnapshotDiff {
  added: string[];
  removed: string[];
  modified: string[];
}

/** Paths that differ between two snapshots, minus `allow` (relative paths). */
export function diffSnapshots(before: DirSnapshot, after: DirSnapshot, allow: readonly string[] = []): SnapshotDiff {
  const allowed = new Set(allow);
  const diff: SnapshotDiff = { added: [], removed: [], modified: [] };
  for (const [p, a] of after) {
    if (allowed.has(p)) continue;
    const b = before.get(p);
    if (!b) diff.added.push(p);
    else if (a.size !== b.size || a.mtimeMs !== b.mtimeMs || a.sha256 !== b.sha256) diff.modified.push(p);
  }
  for (const p of before.keys()) {
    if (!allowed.has(p) && !after.has(p)) diff.removed.push(p);
  }
  diff.added.sort();
  diff.removed.sort();
  diff.modified.sort();
  return diff;
}

export const diffIsEmpty = (d: SnapshotDiff) => !d.added.length && !d.removed.length && !d.modified.length;

/**
 * A fresh Codex home for one cell: wiped, mode 0700, holding ONLY an
 * `auth.json` symlink to the real one (if it exists). Returns the evidence
 * stored in the cell record.
 */
export function prepareIsolatedCodexHome(home: string, realCodexDir: string): Record<string, unknown> {
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const realAuth = join(realCodexDir, CODEX_AUTH_FILE);
  const linked = existsSync(realAuth);
  if (linked) symlinkSync(realAuth, join(home, CODEX_AUTH_FILE));
  return { codex_home: home, seeded: linked ? [`${CODEX_AUTH_FILE} -> ${realAuth}`] : [] };
}

export type AuthPropagation =
  | "unchanged"
  | "propagated"
  | "skipped_real_changed"
  | "skipped_not_newer"
  | "no_auth";

/**
 * After a cell: if Codex replaced the `auth.json` symlink in `cellHome` with a
 * rotated token, write it back into the real file — atomically, and ONLY when
 * the real file still has `realAuthShaAtStart` (nobody rotated it meanwhile,
 * so the cell's token is the only live one). The cell copy is always removed.
 */
export function propagateRotatedCodexAuth(
  cellHome: string,
  realCodexDir: string,
  realAuthShaAtStart: string | null,
): AuthPropagation {
  const cellAuth = join(cellHome, CODEX_AUTH_FILE);
  const realAuth = join(realCodexDir, CODEX_AUTH_FILE);
  const st = lstatSync(cellAuth, { throwIfNoEntry: false });
  if (!st) return "no_auth";
  if (st.isSymbolicLink()) {
    unlinkSync(cellAuth);
    return "unchanged";
  }
  try {
    const rotated = readFileSync(cellAuth);
    const realNow = existsSync(realAuth) ? readFileSync(realAuth) : null;
    const realSha = realNow ? sha256(realNow) : null;
    if (realSha !== realAuthShaAtStart) return "skipped_real_changed";
    if (realNow && sha256(rotated) === realSha) return "skipped_not_newer";
    const tmp = `${realAuth}.aurabench-${process.pid}.tmp`;
    writeFileSync(tmp, rotated, { mode: 0o600 });
    renameSync(tmp, realAuth);
    return "propagated";
  } finally {
    rmSync(cellAuth, { force: true });
  }
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** sha256 of the real `auth.json`, or null when absent. */
export function realAuthSha(realCodexDir: string): string | null {
  const p = join(realCodexDir, CODEX_AUTH_FILE);
  return existsSync(p) ? sha256(readFileSync(p)) : null;
}

export interface CodexGuardDeps {
  realCodexDir: string;
  snapshot?: (dir: string) => DirSnapshot;
}

/**
 * Wrap a runner with a before/after fingerprint of the real `~/.codex`. The
 * result's `isolation.real_codex_home` carries the diff; any change except
 * `auth.json` sets `isolated` to false and adds a violation. Limit outcomes
 * pass through untouched (no record is written for them).
 */
export function guardRealCodexHome(runner: AgentRunner, d: CodexGuardDeps): AgentRunner {
  const snap = d.snapshot ?? snapshotDir;
  return async (ctx): Promise<AgentRun> => {
    const before = snap(d.realCodexDir);
    const run = await runner(ctx);
    if (run.kind !== "done") return run;
    const diff = diffSnapshots(before, snap(d.realCodexDir), [CODEX_AUTH_FILE]);
    const clean = diffIsEmpty(diff);
    const violations = Array.isArray(run.isolation.violations) ? [...(run.isolation.violations as string[])] : [];
    if (!clean) {
      const paths = [...diff.added, ...diff.modified, ...diff.removed];
      violations.push(`real ~/.codex changed during the cell: ${paths.slice(0, 10).join(", ")}${paths.length > 10 ? ", …" : ""}`);
    }
    return {
      ...run,
      isolation: {
        ...run.isolation,
        // A runner without its own verdict (Aura) gets none added on a clean
        // diff; a dirty diff is a violation for every runner.
        ...(clean ? {} : { isolated: false }),
        violations,
        real_codex_home: { files: before.size, unchanged: clean, ...diff },
      },
    };
  };
}

/**
 * {@link propagateRotatedCodexAuth} over every per-session Codex home under
 * `root` (the bench Companion's `~/.companion/codex-home/<sessionId>`), for
 * the Aura Codex variants. Returns the outcome per session dir.
 */
export function propagateFromSessionHomes(
  root: string,
  realCodexDir: string,
  realAuthShaAtStart: string | null,
): Record<string, AuthPropagation> {
  const out: Record<string, AuthPropagation> = {};
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return out;
  }
  for (const name of names.sort()) {
    const home = join(root, name);
    if (!lstatSync(home, { throwIfNoEntry: false })?.isDirectory()) continue;
    const r = propagateRotatedCodexAuth(home, realCodexDir, realAuthShaAtStart);
    // After one write-back the real file no longer matches the start hash, so
    // any other rotated copy is skipped: two rotations can't both be live.
    if (r !== "no_auth") out[name] = r;
  }
  return out;
}
