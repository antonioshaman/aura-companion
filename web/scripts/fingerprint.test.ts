// Tests for the RC-2 universal fingerprinter (PLAN Task 3).
//
// Strategy mirrors detect-stack.test.ts: each test mints an isolated tmp
// workspace, writes real stack-marker files, calls detectFingerprint, and
// asserts the emitted signal set + provenance + kind. We assert the DATA the
// fingerprint emits (spec AC1.1/AC1.2/AC1.3/AC1.4), not just a tag.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { detectFingerprint, JS_DEP_SIGNALS, PY_PKG_SIGNALS } from "./fingerprint.js";

const workspaces: string[] = [];
function newWorkspace(): string {
  const w = mkdtempSync(join(tmpdir(), "fingerprint-"));
  workspaces.push(w);
  return w;
}
function write(root: string, rel: string, content: string) {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}
beforeEach(() => {
  workspaces.length = 0;
});
afterEach(() => {
  for (const w of workspaces) {
    try {
      rmSync(w, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

describe("detectFingerprint — Aura companion (AC1.4 back-compat)", () => {
  it("emits hono + ws/ndjson/json-rpc surfaces + typescript so dahl is seatable", () => {
    const w = newWorkspace();
    write(w, "web/package.json", JSON.stringify({ name: "aura-companion", dependencies: { hono: "^4.7" }, devDependencies: { typescript: "^5" } }));
    write(w, "web/server/ws-bridge.ts", "export {};\n");
    write(w, "web/bun.lockb", "");
    const fp = detectFingerprint(w);
    expect(fp.kind).toBe("fingerprint");
    expect(fp.signals).toContain("hono");
    expect(fp.signals).toContain("websocket");
    expect(fp.signals).toContain("ndjson");
    expect(fp.signals).toContain("json-rpc");
    expect(fp.signals).toContain("typescript");
    expect(fp.signals).toContain("bun");
    // provenance attributes signals to the `web` subdir (dahl #4)
    expect(fp.provenance.some((m) => m.token === "hono" && m.prefix === "web")).toBe(true);
    expect(fp.failures).toEqual([]);
  });
});

describe("detectFingerprint — aiogram bot (AC1.4 back-compat)", () => {
  it("emits python + aiogram + telegram-bot from requirements.txt", () => {
    const w = newWorkspace();
    write(w, "requirements.txt", "aiogram==3.7\nredis==5.0\n");
    write(w, "bot/__init__.py", "");
    const fp = detectFingerprint(w);
    expect(fp.kind).toBe("fingerprint");
    expect(fp.signals).toContain("python");
    expect(fp.signals).toContain("cpython");
    expect(fp.signals).toContain("aiogram");
    expect(fp.signals).toContain("telegram-bot");
    expect(fp.signals).toContain("redis");
  });
});

describe("detectFingerprint — snowlevel monorepo (AC1.1 / AC1.2)", () => {
  // FastAPI + Alembic/Postgres backend, React webapp, python-telegram-bot bot.
  // Deliberately NO aiogram — this fingerprint feeds the 0-aiogram success metric.
  function snowlevel(): string {
    const w = newWorkspace();
    write(w, "api/pyproject.toml", '[project]\nname="api"\ndependencies=["fastapi>=0.110","sqlalchemy>=2","alembic>=1.13","asyncpg>=0.29"]\n');
    write(w, "webapp/package.json", JSON.stringify({ name: "webapp", dependencies: { react: "^19" }, devDependencies: { typescript: "^5" } }));
    write(w, "webapp/package-lock.json", "{}");
    write(w, "bot/requirements.txt", "python-telegram-bot==21.0\n");
    return w;
  }

  it("merges each subsurface's stack into one fingerprint, no aiogram", () => {
    const fp = detectFingerprint(snowlevel());
    expect(fp.kind).toBe("fingerprint");
    // backend
    expect(fp.signals).toContain("fastapi");
    expect(fp.signals).toContain("sqlalchemy");
    expect(fp.signals).toContain("alembic");
    expect(fp.signals).toContain("postgres");
    // frontend
    expect(fp.signals).toContain("react");
    expect(fp.signals).toContain("browser-spa");
    // bot
    expect(fp.signals).toContain("python-telegram-bot");
    expect(fp.signals).toContain("telegram-bot");
    // THE success-metric guard: zero aiogram anywhere in the fingerprint
    expect(fp.signals).not.toContain("aiogram");
    // provenance keeps per-surface attribution
    expect(fp.provenance.some((m) => m.token === "fastapi" && m.prefix === "api")).toBe(true);
    expect(fp.provenance.some((m) => m.token === "react" && m.prefix === "webapp")).toBe(true);
    expect(fp.provenance.some((m) => m.token === "python-telegram-bot" && m.prefix === "bot")).toBe(true);
  });

  it("is deterministic — two runs on the same tree are byte-identical", () => {
    const w = snowlevel();
    const a = detectFingerprint(w);
    const b = detectFingerprint(w);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("detectFingerprint — needs-confirmation (AC1.3)", () => {
  it("empty workspace → needs-confirmation, not a refusal/guess", () => {
    const w = newWorkspace();
    const fp = detectFingerprint(w);
    expect(fp.kind).toBe("needs-confirmation");
    expect(fp.signals).toEqual([]);
  });

  it("a repo with only unrecognised files → needs-confirmation", () => {
    const w = newWorkspace();
    write(w, "README.md", "# hello\n");
    write(w, "notes.txt", "nothing here");
    const fp = detectFingerprint(w);
    expect(fp.kind).toBe("needs-confirmation");
  });
});

// Emit-side vocabulary closure (hashimoto #3). C15 checks the DECLARE side (each
// meta.yaml token ∈ vocab); nothing checked the EMIT side, so a typo in a
// fingerprint emit table (`postgress`) silently never-matches and scores zero. This
// asserts every token the fingerprinter can emit is in the closed vocabulary.
//
// It runs HERMETICALLY against a checked-in FROZEN snapshot of the vocab, so it gates
// in the aura repo's CI (which has no ~/.claude — the earlier skipIf-only version
// silently skipped there, observer WARN 1). A separate skip-if-present freshness test
// asserts the snapshot still matches the live vocab where the catalog exists.
const VOCAB_SNAPSHOT = join(
  dirname(new URL(import.meta.url).pathname), "__fixtures__", "council-catalog", "vocabulary.json",
);

function signalSet(raw: { signals: Record<string, string[]> }): Set<string> {
  const s = new Set<string>();
  for (const group of Object.values(raw.signals)) for (const t of group) s.add(t.toLowerCase());
  return s;
}
function emittedTokens(frameworksOnly = false): Set<string> {
  const out = new Set<string>();
  for (const table of [JS_DEP_SIGNALS, PY_PKG_SIGNALS]) {
    for (const emits of Object.values(table)) {
      for (const e of emits) if (!frameworksOnly || e.dimension === "frameworks") out.add(e.token.toLowerCase());
    }
  }
  return out;
}

describe("emit-side vocabulary closure (hashimoto #3 / observer WARN 1) — hermetic", () => {
  const snap = JSON.parse(readFileSync(VOCAB_SNAPSHOT, "utf8")) as { signals: Record<string, string[]> };

  it("every fingerprint emit token is in the closed vocabulary (frozen snapshot)", () => {
    const vocab = signalSet(snap);
    const orphans = [...emittedTokens()].filter((t) => !vocab.has(t)).sort();
    expect(orphans, `emit tokens absent from the vocab snapshot: ${orphans.join(", ")}`).toEqual([]);
  });

  // willison #2: the MISMATCH ("0-aiogram") guard in advisor-brief filters against the
  // vocab's `frameworks` GROUP; a framework-dimension emit token missing from it makes
  // the guard silently no-op. Hermetic against the snapshot.
  it("every framework-dimension emit token is in the vocab frameworks group (frozen snapshot)", () => {
    const frameworks = new Set((snap.signals.frameworks ?? []).map((t) => t.toLowerCase()));
    const orphans = [...emittedTokens(true)].filter((t) => !frameworks.has(t)).sort();
    expect(
      orphans,
      `framework-dim emit tokens absent from vocab.frameworks (MISMATCH guard would miss them): ${orphans.join(", ")}`,
    ).toEqual([]);
  });
});

// Freshness: the frozen snapshot must still match the live vocab. Skip-if-absent in
// bare CI (the hermetic tests above are the CI gate); this catches snapshot staleness
// on an operator machine + the pre-commit hook — regenerate via
// `bun run scripts/build-council-catalog-snapshot.ts`.
describe("vocab snapshot freshness (observer WARN 1)", () => {
  const livePath =
    process.env.COUNCIL_VOCAB ??
    join(homedir(), ".claude", "skills", "_council-experts", ".verify", "capability-vocabulary.json");
  it.skipIf(!existsSync(livePath))("frozen vocab snapshot equals the live vocab (signals + domains)", () => {
    const live = JSON.parse(readFileSync(livePath, "utf8")) as { signals: Record<string, string[]>; domains: string[] };
    const snap = JSON.parse(readFileSync(VOCAB_SNAPSHOT, "utf8")) as { signals: Record<string, string[]>; domains: string[] };
    expect(snap.signals, "vocab snapshot signals drifted from live — regenerate build-council-catalog-snapshot.ts").toEqual(live.signals);
    expect([...snap.domains].sort(), "vocab snapshot domains drifted from live").toEqual([...live.domains].sort());
  });
});
