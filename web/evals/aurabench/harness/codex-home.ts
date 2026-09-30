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
 *  - {@link syncRotatedCodexAuth} / {@link finishCellCodexAuth}: Codex
 *    refreshes the OAuth token with tmp-file + rename(2), which REPLACES the
 *    symlink with a regular file. The old refresh token in the real
 *    `auth.json` is then spent, and prod would need a re-login. So the rotated
 *    token is written back, but only if the real file is byte-identical to
 *    what the cell's token derives from (nobody else rotated it meanwhile).
 *    Copies in sync are deleted at the end (no credential left in the
 *    artifacts); a copy that could not be written back is stashed, never
 *    deleted (FIX-D2-1b).
 *  - {@link CodexAuthKeeper}: writes rotations back while the cell RUNS (poll),
 *    on a signal and after an exception, and recovers after a hard kill. A
 *    copy that already existed when the watch started is never written back
 *    (FIX-D2-1c): its origin is unknown, so it only goes to the stash.
 *  - {@link snapshotDir} / {@link diffSnapshots}: mtime + size + sha256 of every
 *    file of the real `~/.codex` before and after the cell. Any change other
 *    than `auth.json` is an isolation violation, except the ambient per-process
 *    scratch under `tmp/arg0/` ({@link splitAmbientCodexDiff}, P6/ISO-ARG0).
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
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import type { AgentContext, AgentRun, AgentRunner } from "./run-cell.js";

export const CODEX_AUTH_FILE = "auth.json";

/** Files above this size are compared by mtime + size only (no hash). */
const HASH_LIMIT_BYTES = 8 * 1024 * 1024;

export interface FileFingerprint {
  size: number;
  mtimeMs: number;
  /** sha256; null above {@link HASH_LIMIT_BYTES}, "symlink:<target>" for links, "dir" for directories. */
  sha256: string | null;
}

export type DirSnapshot = Map<string, FileFingerprint>;

/**
 * Fingerprint every entry under `dir` (relative paths; symlinks are recorded,
 * never followed). Directories are entries too (size 0, their mtime), so an
 * EMPTY dir created or removed in the real `~/.codex` (`shell_snapshots`,
 * `logs`, `memories`) is a diff, and so is a file created and deleted again
 * inside one. A missing dir is an empty snapshot. Unreadable entries are
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
        out.set(rel, { size: 0, mtimeMs: st.mtimeMs, sha256: "dir" });
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

/**
 * Per-process scratch of EVERY codex process on the box (P6/ISO-ARG0): each
 * `codex` start creates `tmp/arg0/codex-arg0<random>/` (apply_patch and
 * sandbox helper links + `.lock`) in the real `~/.codex` and removes it on
 * exit. Prod Companion's own Codex app-servers churn it while a cell runs, so
 * the D2-PROBE G/stdio cell recorded a violation no bench agent caused.
 * Changes here are recorded as `ambient`, not as a violation. Only this
 * subtree: `tmp` itself, `auth.json` siblings, config, sessions, memories and
 * state stay strict.
 */
export const AMBIENT_CODEX_PREFIXES: readonly string[] = ["tmp/arg0"];

export const isAmbientCodexPath = (rel: string, prefixes: readonly string[] = AMBIENT_CODEX_PREFIXES) =>
  prefixes.some((p) => rel === p || rel.startsWith(`${p}/`));

/** Split a diff into the part that counts (`strict`) and ambient churn. */
export function splitAmbientCodexDiff(
  diff: SnapshotDiff,
  prefixes: readonly string[] = AMBIENT_CODEX_PREFIXES,
): { strict: SnapshotDiff; ambient: SnapshotDiff } {
  const part = (keep: boolean): SnapshotDiff => ({
    added: diff.added.filter((p) => isAmbientCodexPath(p, prefixes) !== keep),
    removed: diff.removed.filter((p) => isAmbientCodexPath(p, prefixes) !== keep),
    modified: diff.modified.filter((p) => isAmbientCodexPath(p, prefixes) !== keep),
  });
  return { strict: part(true), ambient: part(false) };
}

const countFiles = (s: DirSnapshot) => [...s.values()].filter((f) => f.sha256 !== "dir").length;

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
  | "skipped_real_missing"
  /** A copy older than the watch: never written back, only stashed. */
  | "skipped_foreign"
  | "no_auth";

/** One non-destructive write-back pass over a cell home. */
export interface AuthSync {
  outcome: AuthPropagation;
  /** Real `auth.json` sha this home's token is now known to derive from. */
  base: string | null;
}

/**
 * Write a rotated token in `cellHome` back into the real `auth.json` NOW,
 * without touching the cell copy (Codex may still be using it; replacing it
 * under a running Codex could clobber a newer rotation). Written — atomically
 * — only when the real file still has `base`, i.e. the cell's token derives
 * from the live one and nobody rotated the real file meanwhile.
 *
 *  - symlink → `unchanged`; base moves to the real sha only when that sha is
 *    in `trusted` (the cell-start sha and what the keeper itself wrote). A
 *    real file changed by someone else (a prod re-login) leaves base pinned,
 *    so a later rotation of the OLD family is not written over it (FIX-D2-1c);
 *  - regular file equal to the real one → `skipped_not_newer` (in sync);
 *  - real file absent or empty → `skipped_real_missing`: never written (a
 *    `codex logout` is not undone by a cell);
 *  - real still at `base` → `propagated`, base = the new real sha;
 *  - otherwise → `skipped_real_changed`, base kept (the copy is NOT dropped).
 */
export function syncRotatedCodexAuth(
  cellHome: string,
  realCodexDir: string,
  base: string | null,
  trusted: ReadonlySet<string> = new Set(),
): AuthSync {
  const cellAuth = join(cellHome, CODEX_AUTH_FILE);
  const realAuth = join(realCodexDir, CODEX_AUTH_FILE);
  const st = lstatSync(cellAuth, { throwIfNoEntry: false });
  if (!st) return { outcome: "no_auth", base };
  const realNow = readRealAuth(realCodexDir);
  const realSha = realNow ? sha256(realNow) : null;
  if (st.isSymbolicLink()) return { outcome: "unchanged", base: realSha !== null && trusted.has(realSha) ? realSha : base };
  const rotated = readFileSync(cellAuth);
  if (realNow && sha256(rotated) === realSha) return { outcome: "skipped_not_newer", base: realSha };
  if (realSha === null) return { outcome: "skipped_real_missing", base };
  if (realSha !== base) return { outcome: "skipped_real_changed", base };
  const tmp = `${realAuth}.aurabench-${process.pid}.tmp`;
  writeFileSync(tmp, rotated, { mode: 0o600 });
  renameSync(tmp, realAuth);
  return { outcome: "propagated", base: sha256(rotated) };
}

/**
 * End of a cell home: one last {@link syncRotatedCodexAuth}, then clean up.
 * A symlink or a copy equal to the real file is removed (no credential left
 * in the artifacts). A token that could NOT be written back is never deleted:
 * with `stashDir` it is moved there (0600, retried by
 * {@link retryStashedCodexAuth} on the next start), without it it stays put.
 */
export function finishCellCodexAuth(
  cellHome: string,
  realCodexDir: string,
  base: string | null,
  stashDir?: string,
  trusted?: ReadonlySet<string>,
): AuthPropagation {
  const { outcome } = syncRotatedCodexAuth(cellHome, realCodexDir, base, trusted);
  const cellAuth = join(cellHome, CODEX_AUTH_FILE);
  if (outcome === "skipped_real_changed" || outcome === "skipped_real_missing") {
    if (stashDir) stashCodexAuth(cellAuth, base, stashDir);
  } else if (outcome !== "no_auth") {
    rmSync(cellAuth, { force: true });
  }
  return outcome;
}

/**
 * End of a copy whose origin is unknown (it existed before the watch started,
 * FIX-D2-1c): it is NEVER written into the real file. Equal to the real one →
 * removed; otherwise stashed as `foreign` (never auto-restored, left for a
 * human) — or left in place without a stash dir. A symlink is removed.
 */
export function finishForeignCodexAuth(cellHome: string, realCodexDir: string, stashDir?: string): AuthPropagation {
  const cellAuth = join(cellHome, CODEX_AUTH_FILE);
  const st = lstatSync(cellAuth, { throwIfNoEntry: false });
  if (!st) return "no_auth";
  if (st.isSymbolicLink()) {
    rmSync(cellAuth, { force: true });
    return "unchanged";
  }
  const real = readRealAuth(realCodexDir);
  if (real && sha256(readFileSync(cellAuth)) === sha256(real)) {
    rmSync(cellAuth, { force: true });
    return "skipped_not_newer";
  }
  if (stashDir) stashCodexAuth(cellAuth, null, stashDir, true);
  return "skipped_foreign";
}

/** Back-compat name: {@link finishCellCodexAuth}. */
export const propagateRotatedCodexAuth = finishCellCodexAuth;

interface StashMeta {
  from: string;
  base: string | null;
  stashedAt: string;
  /** base64 of the token file. */
  auth: string;
  /** Origin unknown (pre-existing copy): never written back automatically. */
  foreign?: boolean;
}

function stashCodexAuth(cellAuth: string, base: string | null, stashDir: string, foreign = false): string {
  mkdirSync(stashDir, { recursive: true, mode: 0o700 });
  const body: StashMeta = {
    from: cellAuth,
    base,
    stashedAt: new Date().toISOString(),
    auth: readFileSync(cellAuth).toString("base64"),
    ...(foreign ? { foreign: true } : {}),
  };
  const file = join(stashDir, `auth-${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2, 10)}.json`);
  writeFileSync(`${file}.tmp`, JSON.stringify(body), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
  // Only after the stash is durable does the cell copy go.
  rmSync(cellAuth, { force: true });
  return file;
}

export interface StashRetry {
  propagated: string[];
  dropped_in_sync: string[];
  /** Still not writable (the real file moved on) — left for a human. */
  kept: string[];
}

/**
 * Retry every stashed token: written back when the real file is still at the
 * stash's base, dropped when the real file already holds it, kept otherwise.
 * Never written when the real file is absent or empty (a `codex logout` is a
 * decision, not a gap to fill — FIX-D2-1c), when the stash has no base, or
 * when it is `foreign` (a copy of unknown origin).
 */
export function retryStashedCodexAuth(stashDir: string, realCodexDir: string): StashRetry {
  const out: StashRetry = { propagated: [], dropped_in_sync: [], kept: [] };
  let names: string[];
  try {
    names = readdirSync(stashDir).filter((n) => n.startsWith("auth-") && n.endsWith(".json"));
  } catch {
    return out;
  }
  for (const name of names.sort()) {
    const file = join(stashDir, name);
    let meta: StashMeta;
    try {
      meta = JSON.parse(readFileSync(file, "utf8")) as StashMeta;
    } catch {
      out.kept.push(name);
      continue;
    }
    const token = Buffer.from(meta.auth, "base64");
    const realSha = realAuthSha(realCodexDir);
    if (realSha !== null && sha256(token) === realSha) {
      rmSync(file, { force: true });
      out.dropped_in_sync.push(name);
    } else if (realSha !== null && !meta.foreign && meta.base != null && realSha === meta.base) {
      const realAuth = join(realCodexDir, CODEX_AUTH_FILE);
      const tmp = `${realAuth}.aurabench-${process.pid}.tmp`;
      writeFileSync(tmp, token, { mode: 0o600 });
      renameSync(tmp, realAuth);
      rmSync(file, { force: true });
      out.propagated.push(name);
    } else {
      out.kept.push(name);
    }
  }
  return out;
}

/** Cell homes under a watched path: the path itself, or every subdir of it. */
function homesOf(path: string, kind: "home" | "homes"): string[] {
  if (kind === "home") return [path];
  let names: string[];
  try {
    names = readdirSync(path);
  } catch {
    return [];
  }
  return names
    .sort()
    .map((n) => join(path, n))
    .filter((h) => lstatSync(h, { throwIfNoEntry: false })?.isDirectory());
}

/**
 * {@link finishCellCodexAuth} over every per-session Codex home under `root`
 * (the bench Companion's `~/.companion/codex-home/<sessionId>`), for the Aura
 * Codex variants. Returns the outcome per session dir.
 */
export function propagateFromSessionHomes(
  root: string,
  realCodexDir: string,
  realAuthShaAtStart: string | null,
  stashDir?: string,
): Record<string, AuthPropagation> {
  const out: Record<string, AuthPropagation> = {};
  for (const home of homesOf(root, "homes")) {
    // After one write-back the real file no longer matches the start hash, so
    // any other rotated copy is skipped: two rotations can't both be live.
    const r = finishCellCodexAuth(home, realCodexDir, realAuthShaAtStart, stashDir);
    if (r !== "no_auth") out[relative(root, home)] = r;
  }
  return out;
}

/** Ledger schema version; a watch without it (pre-FIX-D2-1c) is recovered fail-closed. */
const WATCH_VERSION = 2;

interface Watch {
  v?: number;
  kind: "home" | "homes";
  /** Real sha at watch start, PINNED: the base of copies that appear during the watch. */
  startSha: string | null;
  /** Per cell home: real sha its token derives from (see {@link syncRotatedCodexAuth}). */
  bases: Record<string, string | null>;
  /**
   * Homes that already held a regular `auth.json` when the watch started
   * (FIX-D2-1c): their token's origin is unknown — a stale copy from an
   * earlier run would log prod out — so they are never written back.
   */
  foreign: string[];
  /** Real shas the base may follow: `startSha` plus every sha the keeper itself wrote. */
  trusted: string[];
}

export interface CodexAuthKeeperOptions {
  realCodexDir: string;
  /** Durable dir OUTSIDE cell artifacts: ledger + stashed tokens (0700). */
  stateDir: string;
  log?: (line: string) => void;
}

/**
 * Keeps prod's Codex login alive while cells rotate the shared OAuth token
 * (P6/FIX-D2-1b). Pilot fix #248 wrote a rotated token back only at the END of
 * a cell, and a SIGINT/SIGTERM (`process.exit`) or an exception skipped it: the
 * real `auth.json` kept a spent refresh token (prod logged out) and B's copy
 * was then wiped with its artifact dir. Now:
 *
 *  - {@link watch} registers a cell home (or a dir of session homes) in a
 *    ledger on disk; {@link start} polls, and every rotation is written back
 *    within one tick — prod never holds a spent token for a whole cell;
 *  - {@link syncAll} is synchronous, so a signal handler can run it before
 *    `process.exit`; {@link releaseAll} finishes every watch the same way;
 *  - a token that cannot be written back is stashed in `stateDir`, never
 *    deleted; {@link recover} (at startup) finishes watches a killed process
 *    left in the ledger and retries the stash.
 */
export class CodexAuthKeeper {
  private readonly watches = new Map<string, Watch>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly ledger: string;
  private readonly stashDir: string;

  constructor(private readonly o: CodexAuthKeeperOptions) {
    this.ledger = join(o.stateDir, "ledger.json");
    this.stashDir = join(o.stateDir, "stash");
  }

  get stash(): string {
    return this.stashDir;
  }

  /**
   * Start watching a cell home (or a dir of session homes). The start sha is
   * pinned; an existing watch of the same path is kept as is. Every home that
   * already holds a REGULAR `auth.json` now is foreign (never written back).
   */
  watch(path: string, kind: "home" | "homes", startSha: string | null): void {
    if (this.watches.has(path)) return;
    const w: Watch = { v: WATCH_VERSION, kind, startSha, bases: {}, foreign: [], trusted: startSha ? [startSha] : [] };
    for (const home of homesOf(path, kind)) {
      const st = lstatSync(join(home, CODEX_AUTH_FILE), { throwIfNoEntry: false });
      if (st && !st.isSymbolicLink()) w.foreign.push(home);
      else if (st) w.bases[home] = startSha;
    }
    if (w.foreign.length) this.o.log?.(`[aurabench] codex auth: ${w.foreign.length} pre-existing auth copy(ies) under ${path} will never be written back`);
    this.watches.set(path, w);
    this.persist();
  }

  /** Write back every pending rotation now. Never throws (logs instead). */
  syncAll(): void {
    let changed = false;
    for (const [path, w] of this.watches) {
      for (const home of homesOf(path, w.kind)) {
        if (w.foreign.includes(home)) continue;
        try {
          const prev = home in w.bases ? w.bases[home] : w.startSha;
          const r = syncRotatedCodexAuth(home, this.o.realCodexDir, prev, new Set(w.trusted));
          if (r.outcome === "propagated") {
            this.o.log?.(`[aurabench] codex auth: rotated token written back from ${home}`);
            this.trustWritten(r.base);
            changed = true;
          }
          if (r.outcome !== "no_auth" && (!(home in w.bases) || w.bases[home] !== r.base)) {
            w.bases[home] = r.base;
            changed = true;
          }
        } catch (e) {
          this.o.log?.(`[aurabench] codex auth: sync of ${home} failed: ${(e as Error).message}`);
        }
      }
    }
    if (changed) this.persistSafe();
  }

  /** A sha the keeper wrote into the real file is a legitimate base for every watch. */
  private trustWritten(sha: string | null): void {
    if (!sha) return;
    for (const w of this.watches.values()) if (!w.trusted.includes(sha)) w.trusted.push(sha);
  }

  /** Finish one watch: final write-back, clean copies, stash what can't be written. */
  release(path: string): Record<string, AuthPropagation> {
    const w = this.watches.get(path);
    if (!w) return {};
    const out: Record<string, AuthPropagation> = {};
    for (const home of homesOf(path, w.kind)) {
      try {
        const r = w.foreign.includes(home)
          ? finishForeignCodexAuth(home, this.o.realCodexDir, this.stashDir)
          : finishCellCodexAuth(home, this.o.realCodexDir, home in w.bases ? w.bases[home] : w.startSha, this.stashDir, new Set(w.trusted));
        if (r === "propagated") this.trustWritten(realAuthSha(this.o.realCodexDir));
        if (r !== "no_auth") out[w.kind === "home" ? CODEX_AUTH_FILE : relative(path, home)] = r;
        if (r.startsWith("skipped_") && r !== "skipped_not_newer") this.o.log?.(`[aurabench] codex auth: token from ${home} not written back (${r}) — stashed in ${this.stashDir}`);
      } catch (e) {
        this.o.log?.(`[aurabench] codex auth: release of ${home} failed: ${(e as Error).message}`);
        // Left in the ledger: the next start retries it.
        return out;
      }
    }
    this.watches.delete(path);
    this.persistSafe();
    return out;
  }

  releaseAll(): void {
    for (const path of [...this.watches.keys()]) this.release(path);
  }

  /** At startup: finish watches a previous (killed) process left, then retry the stash. */
  recover(): { released: string[]; stash: StashRetry } {
    let left: Record<string, Watch> = {};
    try {
      left = JSON.parse(readFileSync(this.ledger, "utf8")) as Record<string, Watch>;
    } catch {
      // no ledger (clean previous exit) or unreadable
    }
    for (const [path, w] of Object.entries(left)) {
      if (this.watches.has(path)) continue;
      // A pre-FIX-D2-1c ledger may hold a base the old keeper gave a stale
      // copy (its first-seen rule): nothing from it is trusted — every copy
      // is foreign (stash only).
      const legacy = w.v !== WATCH_VERSION;
      this.watches.set(path, {
        v: WATCH_VERSION,
        kind: w.kind,
        startSha: legacy ? null : w.startSha,
        bases: legacy ? {} : (w.bases ?? {}),
        foreign: legacy ? homesOf(path, w.kind) : (w.foreign ?? []),
        trusted: legacy ? [] : (w.trusted ?? []),
      });
    }
    const released = Object.keys(left);
    for (const path of released) this.release(path);
    return { released, stash: retryStashedCodexAuth(this.stashDir, this.o.realCodexDir) };
  }

  start(intervalMs = 2000): void {
    if (this.timer) return;
    // syncAll never throws; the guard keeps a bug from killing the runner.
    this.timer = setInterval(() => {
      try {
        this.syncAll();
      } catch (e) {
        this.o.log?.(`[aurabench] codex auth: poll failed: ${(e as Error).message}`);
      }
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private persist(): void {
    mkdirSync(this.o.stateDir, { recursive: true, mode: 0o700 });
    const tmp = `${this.ledger}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.watches)), { mode: 0o600 });
    renameSync(tmp, this.ledger);
  }

  /** {@link persist} for the poll / release paths: a full disk is logged, not thrown. */
  private persistSafe(): void {
    try {
      this.persist();
    } catch (e) {
      this.o.log?.(`[aurabench] codex auth: ledger write failed: ${(e as Error).message}`);
    }
  }
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** The real `auth.json`, or null when absent or empty (logged out). */
function readRealAuth(realCodexDir: string): Buffer | null {
  const p = join(realCodexDir, CODEX_AUTH_FILE);
  if (!existsSync(p)) return null;
  const b = readFileSync(p);
  return b.length ? b : null;
}

/** sha256 of the real `auth.json`, or null when absent or empty. */
export function realAuthSha(realCodexDir: string): string | null {
  const b = readRealAuth(realCodexDir);
  return b ? sha256(b) : null;
}

export interface CodexGuardDeps {
  realCodexDir: string;
  snapshot?: (dir: string) => DirSnapshot;
  /**
   * A limit outcome writes no record, so a dirty diff on one would vanish:
   * it is reported here instead (the runner logs it to
   * `results/isolation-violations.jsonl`).
   */
  onLimitViolation?: (diff: SnapshotDiff, ctx: AgentContext) => void;
}

/**
 * Wrap a runner with a before/after fingerprint of the real `~/.codex`. The
 * result's `isolation.real_codex_home` carries the diff; any change except
 * `auth.json` and ambient `tmp/arg0/**` churn (kept in `ambient`) sets
 * `isolated` to false and adds a violation. Limit outcomes
 * are compared too; they pass through unchanged (no record is written for
 * them) and a dirty diff goes to `onLimitViolation`.
 */
export function guardRealCodexHome(runner: AgentRunner, d: CodexGuardDeps): AgentRunner {
  const snap = d.snapshot ?? snapshotDir;
  return async (ctx): Promise<AgentRun> => {
    const before = snap(d.realCodexDir);
    const run = await runner(ctx);
    const { strict: diff, ambient } = splitAmbientCodexDiff(diffSnapshots(before, snap(d.realCodexDir), [CODEX_AUTH_FILE]));
    const clean = diffIsEmpty(diff);
    if (run.kind !== "done") {
      if (!clean) d.onLimitViolation?.(diff, ctx);
      return run;
    }
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
        real_codex_home: { files: countFiles(before), dirs: before.size - countFiles(before), unchanged: clean, ...diff, ambient },
      },
    };
  };
}

/**
 * Wrap the Aura runner: watch the bench instance's per-session Codex homes
 * for the whole cell and finish them in `finally` — an exception in the
 * runner (FIX-D2-1b item 4) still writes a rotated token back. The outcome
 * lands in `isolation.codex_auth`.
 */
export function withCodexAuthWatch(
  runner: AgentRunner,
  keeper: Pick<CodexAuthKeeper, "watch" | "release">,
  sessionHomesRoot: string,
  authSha: () => string | null,
): AgentRunner {
  return async (ctx) => {
    keeper.watch(sessionHomesRoot, "homes", authSha());
    let run: AgentRun | undefined;
    try {
      run = await runner(ctx);
    } finally {
      const auth = keeper.release(sessionHomesRoot);
      if (run?.kind === "done") run = { ...run, isolation: { ...run.isolation, codex_auth: auth } };
    }
    return run as AgentRun;
  };
}

/** The agent processes a signal must stop before the cell homes are released. */
export interface ChildControl {
  /** SIGTERM every live agent group, wait (bounded), SIGKILL what is left. */
  stop(): Promise<void>;
  /** SIGKILL every live agent group now (second signal). */
  killNow(): void;
}

/**
 * SIGINT/SIGTERM handler for the runner. `process.exit` skips every pending
 * `finally`, so pilot fix #248 lost a rotated token on Ctrl-C (FIX-D2-1b item
 * 1). Order: write back NOW (synchronous — nothing can pre-empt it), then stop
 * the agent processes and the instance, write back again (a Codex may rotate
 * while shutting down), then finish every watch (clean or stash copies), then
 * exit. Agents run in their own process group, so the terminal's SIGINT does
 * not reach them: releasing first would pull `auth.json` from under a live
 * Codex B (FIX-D2-1c). A second signal while stopping SIGKILLs the agents and
 * skips the wait, but not the write-back.
 */
export function authSafeSignalHandler(
  keeper: Pick<CodexAuthKeeper, "syncAll" | "releaseAll" | "stop">,
  stopInstance: () => Promise<void>,
  exit: (code: number) => void,
  children?: ChildControl,
): () => void {
  let stopping = false;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    keeper.stop();
    keeper.releaseAll();
    exit(130);
  };
  return () => {
    keeper.syncAll();
    if (stopping) {
      children?.killNow();
      return finish();
    }
    stopping = true;
    void Promise.allSettled([children?.stop() ?? Promise.resolve(), stopInstance()]).then(() => {
      if (finished) return;
      keeper.syncAll();
      finish();
    });
  };
}
