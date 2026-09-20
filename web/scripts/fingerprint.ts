#!/usr/bin/env bun
// RC-2 universal, monorepo-aware project fingerprinter (PLAN Task 3).
//
// Replaces the binary two-stack verdict-router with a structural describe-what-
// exists pass: it EMITS a set of vocabulary `signals` (grouped by dimension,
// tagged with per-surface provenance) instead of routing to aura|python|refuse.
// Multi-stack coexistence is normal DATA, never an "ambiguous" fault (dahl #2).
// The only terminal non-fingerprint state is `needs-confirmation`, when the scan
// finds no recognised signal at all — the caller then ASKS the developer
// (spec AC1.3) rather than refusing or guessing.
//
// Discipline (all reused from marker-fs.ts, the single EC-7 wrapper):
//   - every file read is size-capped + realpath-bounded + symlink-rejected;
//   - the depth-1 scan is sorted-before-cap deterministic (ritchie B-4);
//   - every failure is a structured, surfaced `FingerprintFailure` — never a
//     silent absence (the detect-stack.ts "no silent fallback" ethos, ritchie B-3);
//   - extractors match literal tokens only (no user-controlled regex → no ReDoS,
//     hunt #2); each probe has its own byte cap before the read.
//
// Pure + synchronous end to end (dahl: identical tree ⇒ byte-identical output).

import { existsSync } from "node:fs";
import {
  enumerateCandidatePrefixes,
  isDirectory,
  type MarkerReason,
  readText,
  resolveMarker,
  resolveRoot,
} from "./marker-fs";

export type SignalDimension =
  | "languages"
  | "runtimes"
  | "frameworks"
  | "datastores"
  | "orm-migrations"
  | "infra"
  | "surfaces";

export interface MatchedSignal {
  token: string;
  dimension: SignalDimension;
  /** "" for a workspace-root match, else the depth-1 subdir name (provenance, dahl #4). */
  prefix: string;
  /** workspace-relative file that produced the signal. */
  evidenceFile: string;
}

export interface FingerprintFailure {
  /** workspace-relative path or a synthetic scan label. */
  path: string;
  reason: MarkerReason;
}

export type FingerprintKind = "fingerprint" | "needs-confirmation";

export interface Fingerprint {
  kind: FingerprintKind;
  /** Deduped, lexicographically-sorted union of all matched signal tokens. */
  signals: string[];
  /** Tokens grouped by dimension (each list deduped + sorted). */
  byDimension: Record<SignalDimension, string[]>;
  /** Per-(prefix,file) attribution, sorted for determinism. */
  provenance: MatchedSignal[];
  /** True if the depth-1 scan hit MAX_CANDIDATE_SUBDIRS before finishing. */
  scanTruncated: boolean;
  /** Structured, surfaced failures — never a silent drop. */
  failures: FingerprintFailure[];
}

// ---------------------------------------------------------------------------
// Signal table — declarative data rows (dahl #3). Adding a stack signal is a
// new map entry, not a new bespoke probe; every row funnels through the same
// marker-fs read/bounds discipline.
// ---------------------------------------------------------------------------

const CAP = {
  PACKAGE_JSON: 16 * 1024,
  TSCONFIG: 16 * 1024,
  PYPROJECT: 64 * 1024,
  REQUIREMENTS: 64 * 1024,
  DOCKERFILE: 64 * 1024,
  GOMOD: 16 * 1024,
} as const;

interface Emit {
  token: string;
  dimension: SignalDimension;
}

// package.json dependency name → emitted signal(s). Exported so an emit-side
// vocabulary-closure test can assert every token this table can emit is in the
// closed vocabulary (hashimoto #3 — a typo like `postgress` otherwise silently
// never-matches and scores zero, passing every gate).
export const JS_DEP_SIGNALS: Record<string, Emit[]> = {
  hono: [{ token: "hono", dimension: "frameworks" }],
  express: [{ token: "express", dimension: "frameworks" }],
  fastify: [{ token: "fastify", dimension: "frameworks" }],
  react: [{ token: "react", dimension: "frameworks" }, { token: "browser-spa", dimension: "surfaces" }],
  vue: [{ token: "vue", dimension: "frameworks" }, { token: "browser-spa", dimension: "surfaces" }],
  svelte: [{ token: "svelte", dimension: "frameworks" }, { token: "browser-spa", dimension: "surfaces" }],
  next: [{ token: "nextjs", dimension: "frameworks" }, { token: "browser-spa", dimension: "surfaces" }],
  ws: [{ token: "websocket", dimension: "surfaces" }],
  pg: [{ token: "postgres", dimension: "datastores" }],
  ioredis: [{ token: "redis", dimension: "datastores" }],
  redis: [{ token: "redis", dimension: "datastores" }],
  "@prisma/client": [{ token: "prisma", dimension: "orm-migrations" }],
  prisma: [{ token: "prisma", dimension: "orm-migrations" }],
  "drizzle-orm": [{ token: "drizzle", dimension: "orm-migrations" }],
};

// Python package token (matched as a whole word in pyproject/requirements text)
// → emitted signal(s). Exported for the emit-side vocabulary-closure test (see JS_DEP_SIGNALS).
export const PY_PKG_SIGNALS: Record<string, Emit[]> = {
  aiogram: [{ token: "aiogram", dimension: "frameworks" }, { token: "telegram-bot", dimension: "surfaces" }],
  "python-telegram-bot": [{ token: "python-telegram-bot", dimension: "frameworks" }, { token: "telegram-bot", dimension: "surfaces" }],
  fastapi: [{ token: "fastapi", dimension: "frameworks" }, { token: "rest", dimension: "surfaces" }],
  flask: [{ token: "flask", dimension: "frameworks" }, { token: "rest", dimension: "surfaces" }],
  django: [{ token: "django", dimension: "frameworks" }],
  starlette: [{ token: "starlette", dimension: "frameworks" }],
  sqlalchemy: [{ token: "sqlalchemy", dimension: "orm-migrations" }],
  alembic: [{ token: "alembic", dimension: "orm-migrations" }],
  psycopg: [{ token: "postgres", dimension: "datastores" }],
  psycopg2: [{ token: "postgres", dimension: "datastores" }],
  "psycopg2-binary": [{ token: "postgres", dimension: "datastores" }],
  asyncpg: [{ token: "postgres", dimension: "datastores" }],
  redis: [{ token: "redis", dimension: "datastores" }],
};

// ---------------------------------------------------------------------------

interface Acc {
  matches: MatchedSignal[];
  failures: FingerprintFailure[];
}

function push(acc: Acc, emits: Emit[], prefix: string, evidenceFile: string) {
  for (const e of emits) {
    acc.matches.push({ token: e.token, dimension: e.dimension, prefix, evidenceFile });
  }
}

// Whole-word literal match — no user-controlled regex (hunt #2, ReDoS-proof).
function wordPresent(haystack: string, needle: string): boolean {
  const lower = haystack.toLowerCase();
  let from = 0;
  const n = needle.toLowerCase();
  for (;;) {
    const i = lower.indexOf(n, from);
    if (i < 0) return false;
    const before = i === 0 ? "" : lower[i - 1];
    const after = lower[i + n.length] ?? "";
    const boundary = (c: string) => c === "" || !/[a-z0-9_-]/.test(c);
    // Allow trailing chars that are part of the same token name we already list
    // separately (e.g. psycopg2) — but a bare boundary is the common case.
    if (boundary(before) && boundary(after)) return true;
    from = i + n.length;
  }
}

function probeJs(root: string, prefix: string, acc: Acc) {
  const rel = prefix ? `${prefix}/package.json` : "package.json";
  const r = resolveMarker(root, rel);
  if (!r.ok) {
    acc.failures.push({ path: rel, reason: r.reason });
    return;
  }
  if (!existsSync(r.absolute)) return;
  const read = readText(r.absolute, CAP.PACKAGE_JSON);
  if (!read.ok) {
    acc.failures.push({ path: rel, reason: read.reason });
    return;
  }
  let pkg: unknown;
  try {
    pkg = JSON.parse(read.text);
  } catch {
    acc.failures.push({ path: rel, reason: "json_parse" });
    return;
  }
  const obj = pkg && typeof pkg === "object" ? (pkg as Record<string, unknown>) : {};
  push(acc, [{ token: "javascript", dimension: "languages" }], prefix, rel);
  const deps: Record<string, unknown> = {};
  for (const key of ["dependencies", "devDependencies", "peerDependencies"]) {
    const d = obj[key];
    if (d && typeof d === "object") Object.assign(deps, d as Record<string, unknown>);
  }
  if ("typescript" in deps) {
    push(acc, [{ token: "typescript", dimension: "languages" }], prefix, rel);
  }
  for (const [dep, emits] of Object.entries(JS_DEP_SIGNALS)) {
    if (dep in deps) push(acc, emits, prefix, rel);
  }
  // Runtime: lockfile presence (existence-only, not read).
  const tsconfig = resolveMarker(root, prefix ? `${prefix}/tsconfig.json` : "tsconfig.json");
  if (tsconfig.ok && existsSync(tsconfig.absolute)) {
    push(acc, [{ token: "typescript", dimension: "languages" }], prefix, prefix ? `${prefix}/tsconfig.json` : "tsconfig.json");
  }
  const bunLock = resolveMarker(root, prefix ? `${prefix}/bun.lockb` : "bun.lockb");
  if (bunLock.ok && existsSync(bunLock.absolute)) {
    push(acc, [{ token: "bun", dimension: "runtimes" }], prefix, prefix ? `${prefix}/bun.lockb` : "bun.lockb");
  } else {
    for (const lf of ["package-lock.json", "yarn.lock", "pnpm-lock.yaml"]) {
      const l = resolveMarker(root, prefix ? `${prefix}/${lf}` : lf);
      if (l.ok && existsSync(l.absolute)) {
        push(acc, [{ token: "node", dimension: "runtimes" }], prefix, prefix ? `${prefix}/${lf}` : lf);
        break;
      }
    }
  }
}

function probePy(root: string, prefix: string, acc: Acc) {
  let sawPython = false;
  for (const [file, cap] of [
    ["pyproject.toml", CAP.PYPROJECT] as const,
    ["requirements.txt", CAP.REQUIREMENTS] as const,
  ]) {
    const rel = prefix ? `${prefix}/${file}` : file;
    const r = resolveMarker(root, rel);
    if (!r.ok) {
      acc.failures.push({ path: rel, reason: r.reason });
      continue;
    }
    if (!existsSync(r.absolute)) continue;
    const read = readText(r.absolute, cap);
    if (!read.ok) {
      acc.failures.push({ path: rel, reason: read.reason });
      continue;
    }
    sawPython = true;
    for (const [pkg, emits] of Object.entries(PY_PKG_SIGNALS)) {
      if (wordPresent(read.text, pkg)) push(acc, emits, prefix, rel);
    }
  }
  if (sawPython) {
    push(
      acc,
      [{ token: "python", dimension: "languages" }, { token: "cpython", dimension: "runtimes" }],
      prefix,
      prefix ? `${prefix}/pyproject.toml` : "pyproject.toml",
    );
  }
}

function probeInfra(root: string, prefix: string, acc: Acc) {
  const dockerfile = resolveMarker(root, prefix ? `${prefix}/Dockerfile` : "Dockerfile");
  if (dockerfile.ok && existsSync(dockerfile.absolute)) {
    push(acc, [{ token: "docker", dimension: "infra" }], prefix, prefix ? `${prefix}/Dockerfile` : "Dockerfile");
  }
  // .github/workflows only meaningful at workspace root.
  if (prefix === "") {
    const wf = resolveMarker(root, ".github/workflows");
    if (wf.ok && existsSync(wf.absolute) && isDirectory(wf.absolute)) {
      push(acc, [{ token: "github-actions", dimension: "infra" }], "", ".github/workflows");
    }
  }
  const gomod = resolveMarker(root, prefix ? `${prefix}/go.mod` : "go.mod");
  if (gomod.ok && existsSync(gomod.absolute)) {
    push(acc, [{ token: "go", dimension: "languages" }], prefix, prefix ? `${prefix}/go.mod` : "go.mod");
  }
}

// Aura's NDJSON/WS bridge surface — mirrors the retired AURA_WS_BRIDGE marker so
// the aura-companion fingerprint still seats dahl (back-compat, AC1.4).
function probeWsBridge(root: string, prefix: string, acc: Acc) {
  const rel = prefix ? `${prefix}/server/ws-bridge.ts` : "server/ws-bridge.ts";
  const r = resolveMarker(root, rel);
  if (!r.ok) {
    acc.failures.push({ path: rel, reason: r.reason });
    return;
  }
  if (existsSync(r.absolute)) {
    push(
      acc,
      [
        { token: "websocket", dimension: "surfaces" },
        { token: "ndjson", dimension: "surfaces" },
        { token: "json-rpc", dimension: "surfaces" },
        { token: "stdio-subprocess", dimension: "surfaces" },
      ],
      prefix,
      rel,
    );
  }
}

const EMPTY_BY_DIMENSION = (): Record<SignalDimension, string[]> => ({
  languages: [],
  runtimes: [],
  frameworks: [],
  datastores: [],
  "orm-migrations": [],
  infra: [],
  surfaces: [],
});

/**
 * Fingerprint a workspace. Pure + synchronous. Returns `needs-confirmation`
 * (empty signal set) when nothing recognised is found — the caller ASKS the
 * developer rather than refusing (AC1.3).
 */
export function detectFingerprint(workspaceRoot: string): Fingerprint {
  const root = resolveRoot(workspaceRoot);
  if (root === null) {
    return {
      kind: "needs-confirmation",
      signals: [],
      byDimension: EMPTY_BY_DIMENSION(),
      provenance: [],
      scanTruncated: false,
      failures: [{ path: workspaceRoot, reason: "read_error" }],
    };
  }

  const acc: Acc = { matches: [], failures: [] };
  const { prefixes, failures, truncated } = enumerateCandidatePrefixes(root);
  for (const f of failures) acc.failures.push({ path: f.name, reason: f.reason });

  // Probe workspace root ("") plus each depth-1 subdir prefix.
  const scanPrefixes = ["", ...prefixes];
  for (const prefix of scanPrefixes) {
    probeJs(root, prefix, acc);
    probePy(root, prefix, acc);
    probeInfra(root, prefix, acc);
    probeWsBridge(root, prefix, acc);
  }

  // Deterministic merge: dedup + sort union; dedup + sort per dimension.
  const byDimension = EMPTY_BY_DIMENSION();
  const seen = new Set<string>();
  const perDim: Record<SignalDimension, Set<string>> = {
    languages: new Set(), runtimes: new Set(), frameworks: new Set(),
    datastores: new Set(), "orm-migrations": new Set(), infra: new Set(), surfaces: new Set(),
  };
  for (const m of acc.matches) {
    seen.add(m.token);
    perDim[m.dimension].add(m.token);
  }
  for (const dim of Object.keys(perDim) as SignalDimension[]) {
    byDimension[dim] = [...perDim[dim]].sort();
  }
  const signals = [...seen].sort();

  // Provenance sorted by (prefix, token, dimension, evidenceFile) for reproducible
  // output. Code-point comparison (NOT localeCompare, whose ICU collation is
  // runtime-dependent — dahl #4) and the sort key is TOTAL over every field the
  // dedup below distinguishes: `evidenceFile` is included so two rows differing
  // only in evidence file get a fixed order instead of relying on sort-stability +
  // probe call order (dahl #14).
  const cp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const provenance = [...acc.matches].sort(
    (a, b) =>
      cp(a.prefix, b.prefix) ||
      cp(a.token, b.token) ||
      cp(a.dimension, b.dimension) ||
      cp(a.evidenceFile, b.evidenceFile),
  );
  const uniqProvenance = provenance.filter(
    (m, i) =>
      i === 0 ||
      m.prefix !== provenance[i - 1].prefix ||
      m.token !== provenance[i - 1].token ||
      m.dimension !== provenance[i - 1].dimension ||
      m.evidenceFile !== provenance[i - 1].evidenceFile,
  );

  return {
    kind: signals.length === 0 ? "needs-confirmation" : "fingerprint",
    signals,
    byDimension,
    provenance: uniqProvenance,
    scanTruncated: truncated,
    failures: acc.failures,
  };
}
