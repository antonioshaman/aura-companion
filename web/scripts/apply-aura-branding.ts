#!/usr/bin/env bun
// Apply Aura branding replacements to a working tree.
//
// Idempotent: running twice produces byte-identical output.
// Refuses to run with staged changes by default (prevents picking up
// uncommitted secrets and rewriting them into commits).
//
// Usage:
//   bun web/scripts/apply-aura-branding.ts                # apply at repo root
//   bun web/scripts/apply-aura-branding.ts --dry-run      # report only
//   bun web/scripts/apply-aura-branding.ts --root <dir>   # target a fixture dir
//   bun web/scripts/apply-aura-branding.ts --no-staged-check  # skip git guard (tests)
//
// Config: branding.config.json at the repo root drives all replacements,
// protected paths, and the keep-upstream marker. Edit there, not here.

import { readFileSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { minimatch } from "minimatch";

interface Replacement {
  from: string;
  to: string;
  /** Optional file-glob list — if present, replacement only applies to matching paths. */
  contexts?: string[];
}

interface BrandingConfig {
  replacements: Replacement[];
  protectedPaths: string[];
  keepUpstreamMarker: string;
  visualAssetChecklist?: string[];
}

interface CliOptions {
  root: string;
  dryRun: boolean;
  noStagedCheck: boolean;
  configPath: string;
}

interface FileChange {
  path: string;
  before: string;
  after: string;
}

function parseArgs(argv: string[]): CliOptions {
  const args = argv.slice(2);
  let root = process.cwd();
  let dryRun = false;
  let noStagedCheck = false;
  let configPath = "";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--no-staged-check") noStagedCheck = true;
    else if (a === "--root") root = resolve(args[++i] ?? "");
    else if (a === "--config") configPath = resolve(args[++i] ?? "");
    else if (a === "--help" || a === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      console.error(usage());
      process.exit(2);
    }
  }
  if (!configPath) configPath = resolve(root, "branding.config.json");
  return { root, dryRun, noStagedCheck, configPath };
}

function usage(): string {
  return `Usage: bun web/scripts/apply-aura-branding.ts [options]
  --root <dir>          Target directory (default: cwd)
  --config <path>       Config file path (default: <root>/branding.config.json)
  --dry-run             Report changes without writing
  --no-staged-check     Skip the "no staged changes" git guard (used by tests)
  -h, --help            Show this help`;
}

function loadConfig(path: string): BrandingConfig {
  const raw = readFileSync(path, "utf-8");
  const data = JSON.parse(raw) as BrandingConfig;
  if (!Array.isArray(data.replacements) || !Array.isArray(data.protectedPaths)) {
    throw new Error(`Malformed branding config at ${path}: missing replacements/protectedPaths`);
  }
  if (typeof data.keepUpstreamMarker !== "string" || !data.keepUpstreamMarker) {
    throw new Error(`Malformed branding config at ${path}: keepUpstreamMarker missing`);
  }
  return data;
}

function assertNoStagedChanges(root: string): void {
  // Refuse to run with staged changes — prevents the script from sweeping
  // up uncommitted secrets/edits into a "branding refresh" commit.
  // The check is git-aware; if root isn't a git repo, skip.
  const isRepo = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: root,
    encoding: "utf-8",
  });
  if (isRepo.status !== 0) return;

  const result = spawnSync("git", ["diff", "--cached", "--name-only"], {
    cwd: root,
    encoding: "utf-8",
  });
  const staged = (result.stdout || "").trim();
  if (staged.length > 0) {
    console.error("Refusing to run: staged changes present.");
    console.error("Commit or unstage first, then re-run. Files staged:");
    console.error(staged);
    process.exit(3);
  }
}

function isProtected(relPath: string, protectedPaths: string[]): boolean {
  // Normalise to forward-slash for glob matching (minimatch is POSIX-style).
  const p = relPath.split(sep).join("/");
  for (const pattern of protectedPaths) {
    if (minimatch(p, pattern, { dot: true })) return true;
  }
  return false;
}

function matchesContexts(relPath: string, contexts?: string[]): boolean {
  if (!contexts || contexts.length === 0) return true;
  const p = relPath.split(sep).join("/");
  for (const pattern of contexts) {
    if (minimatch(p, pattern, { dot: true })) return true;
  }
  return false;
}

function applyReplacementsToFile(
  content: string,
  relPath: string,
  config: BrandingConfig,
): string {
  // Per-line application so the keepUpstreamMarker can protect specific
  // lines without protecting the whole file.
  const lines = content.split("\n");
  const marker = config.keepUpstreamMarker;
  const out: string[] = new Array(lines.length);

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const prevLine = i > 0 ? lines[i - 1] : "";
    // Two protection modes:
    //   1. Marker on the line itself — protects that exact line.
    //   2. Marker on a preceding comment-only line — protects the line below.
    // We only honour mode 2 when the preceding line is comment-only so a
    // trailing-comment marker on a code line doesn't accidentally cascade
    // protection onto the next, semantically unrelated, code line.
    const prevIsCommentOnly = /^\s*(\/\/|#|\*|;|--)/.test(prevLine);
    const lineProtected =
      line.includes(marker) || (prevIsCommentOnly && prevLine.includes(marker));

    if (!lineProtected) {
      for (const r of config.replacements) {
        if (!matchesContexts(relPath, r.contexts)) continue;
        if (r.from === r.to) continue;
        // Plain string replacement — idempotent because replacing "from"
        // with "to" yields a string that no longer contains "from"
        // (assuming "from" is not a substring of "to", which is the case
        // for our config: "Aura Companion" doesn't contain "Vibe Companion").
        if (line.includes(r.from)) {
          line = line.split(r.from).join(r.to);
        }
      }
    }
    out[i] = line;
  }

  return out.join("\n");
}

function* walkFiles(root: string, protectedPaths: string[]): Generator<string> {
  // Recursive walk via node:fs. We scan everything and filter against the
  // protected-paths list so the config remains the single source of truth.
  // Directory entries are short-circuit-skipped if their relative path
  // matches a protected pattern — saves descent into node_modules etc.
  function* walk(dir: string, relDir: string): Generator<string> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        // Test directory itself (some patterns target dirs, e.g. ".git/**"
        // — minimatching ".git" against ".git/**" is false, so we also test
        // the trailing-slash form to allow short-circuiting).
        const trailing = `${rel}/x`;
        if (isProtected(trailing, protectedPaths)) continue;
        yield* walk(`${dir}/${entry.name}`, rel);
      } else if (entry.isFile()) {
        if (isProtected(rel, protectedPaths)) continue;
        yield rel;
      }
    }
  }
  yield* walk(root, "");
}

function main(): void {
  const opts = parseArgs(process.argv);

  if (!opts.noStagedCheck) {
    assertNoStagedChanges(opts.root);
  }

  const config = loadConfig(opts.configPath);
  const changes: FileChange[] = [];
  let scanned = 0;

  for (const relPath of walkFiles(opts.root, config.protectedPaths)) {
    const abs = resolve(opts.root, relPath);
    let buf: Buffer;
    try {
      buf = readFileSync(abs);
    } catch {
      continue;
    }
    // Skip binary files — heuristic: any null byte in first 8KB.
    const sample = buf.subarray(0, Math.min(8192, buf.length));
    if (sample.includes(0)) continue;
    const before = buf.toString("utf-8");
    scanned++;

    const after = applyReplacementsToFile(before, relPath, config);
    if (after !== before) {
      changes.push({ path: relPath, before, after });
    }
  }

  if (opts.dryRun) {
    console.log(`[branding] dry-run: ${changes.length} file(s) would change (scanned ${scanned}).`);
    for (const c of changes) console.log(`  - ${c.path}`);
    process.exit(0);
  }

  for (const c of changes) {
    writeFileSync(resolve(opts.root, c.path), c.after);
  }

  console.log(`[branding] rewrote ${changes.length} file(s) (scanned ${scanned}).`);
  for (const c of changes) console.log(`  - ${c.path}`);

  // Visual-asset reminder — doesn't fail the run, just prints a checklist.
  if (config.visualAssetChecklist && config.visualAssetChecklist.length > 0) {
    console.log("");
    console.log("[branding] Visual-asset checklist (not auto-rewritten — verify manually):");
    for (const path of config.visualAssetChecklist) {
      try {
        statSync(resolve(opts.root, path));
        console.log(`  - ${path}`);
      } catch {
        // Asset doesn't exist — skip silently.
      }
    }
  }
}

if (import.meta.main) {
  main();
}

// Exports for testing.
export { applyReplacementsToFile, isProtected, matchesContexts, loadConfig };
export type { BrandingConfig, Replacement };
