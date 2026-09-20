// RC-2 golden regression: back-compat superset (AC1.4) + snowlevel 0-aiogram
// success metric (PLAN Task 11). Hermetic — inline fixture profiles frozen from
// today's catalog + inline canonical fingerprints (dahl #9, no live ~/.claude).
//
// AC1.4: the two current stacks must seat a set that is same-or-superset of
// today's fixed Panel: lists — checked against each stack's STACK-APPROPRIATE
// broad domain set (the domains the stack's surfaces imply; requesting
// database/telegram expertise for a repo with neither is not a back-compat
// scenario). See IMPLEMENTATION-LOG "RESOLVED DESIGN FINDING (variant B)".

import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { composeCouncil } from "./advisor-scorer.js";
import { buildAdvisorBrief } from "./advisor-brief.js";
import { loadCatalog } from "./capability-catalog.js";
import type { AdvisorProfile, Vocabulary } from "./capability-catalog";
import type { Fingerprint } from "./fingerprint";

// --- frozen fixture profiles (mirror of the 14 seated meta.yaml, Task 2) -------
const PROFILES: AdvisorProfile[] = [
  { id: "hunt", signals: ["any"], domains: ["security"] },
  { id: "fowler", signals: ["any"], domains: ["refactoring", "backend-architecture"] },
  { id: "saarinen", signals: ["browser-spa", "react"], domains: ["ui-visual-quality"] },
  { id: "friedman", signals: ["browser-spa", "cli", "telegram-mini-app"], domains: ["ux-flow"] },
  { id: "willison", signals: ["any"], domains: ["llm-pipeline"] },
  { id: "hashimoto", signals: ["docker", "github-actions", "systemd", "vps", "cloud-run", "nginx", "kubernetes"], domains: ["devops-deploy", "ci-supply-chain"] },
  { id: "beck", signals: ["any"], domains: ["test-quality"] },
  { id: "dahl", signals: ["bun", "node", "typescript", "hono", "express", "fastify", "websocket", "ndjson", "json-rpc", "rest", "sse"], domains: ["backend-architecture", "protocol-correctness", "realtime-streaming"] },
  { id: "ritchie", signals: ["stdio-subprocess", "cli"], domains: ["process-lifecycle", "filesystem-persistence"] },
  { id: "abramov", signals: ["react", "vue", "svelte", "nextjs", "browser-spa", "typescript", "javascript"], domains: ["frontend-architecture"] },
  { id: "watson", signals: ["browser-spa", "react"], domains: ["accessibility"] },
  { id: "durov", signals: ["telegram-bot", "telegram-mini-app"], domains: ["chat-platform-ux", "ux-flow"] },
  { id: "vanrossum", signals: ["python", "cpython", "aiogram", "fastapi", "flask", "django", "starlette"], domains: ["backend-architecture"] },
  { id: "brandur", signals: ["postgres", "sqlite", "mysql", "sqlalchemy", "alembic", "prisma", "drizzle"], domains: ["database-persistence", "schema-migrations"] },
];

const AURA_10 = ["hunt", "fowler", "dahl", "ritchie", "abramov", "watson", "saarinen", "friedman", "willison", "hashimoto"];
const PYTHON_9 = ["hunt", "fowler", "durov", "vanrossum", "brandur", "hashimoto", "willison", "saarinen", "friedman"];

function fp(byDim: Partial<Record<keyof Fingerprint["byDimension"], string[]>>): Fingerprint {
  const byDimension = {
    languages: byDim.languages ?? [], runtimes: byDim.runtimes ?? [], frameworks: byDim.frameworks ?? [],
    datastores: byDim.datastores ?? [], "orm-migrations": byDim["orm-migrations"] ?? [], infra: byDim.infra ?? [], surfaces: byDim.surfaces ?? [],
  };
  const signals = [...new Set(Object.values(byDimension).flat())].sort();
  return { kind: signals.length ? "fingerprint" : "needs-confirmation", signals, byDimension, provenance: [], scanTruncated: false, failures: [] };
}

// Canonical aura fingerprint (matches detectFingerprint on the real repo, minus
// the incidental `drizzle` subdir noise which is not part of the canonical stack).
const AURA_FP = fp({
  languages: ["javascript", "typescript"], runtimes: ["bun"], frameworks: ["hono"],
  infra: ["docker", "github-actions"], surfaces: ["websocket", "ndjson", "json-rpc", "stdio-subprocess", "browser-spa"],
});
const AURA_DOMAINS = ["security", "refactoring", "backend-architecture", "frontend-architecture", "llm-pipeline", "ui-visual-quality", "ux-flow", "accessibility", "devops-deploy", "ci-supply-chain", "test-quality", "process-lifecycle", "filesystem-persistence", "protocol-correctness", "realtime-streaming"];

const AIOGRAM_FP = fp({ languages: ["python"], runtimes: ["cpython"], frameworks: ["aiogram"], datastores: ["redis"], surfaces: ["telegram-bot"] });
const PYTHON_DOMAINS = ["security", "refactoring", "backend-architecture", "chat-platform-ux", "ux-flow", "ui-visual-quality", "database-persistence", "schema-migrations", "llm-pipeline", "test-quality", "devops-deploy", "ci-supply-chain"];

describe("AC1.4 back-compat superset — Aura", () => {
  it("seats a superset of the Aura-10 panel", () => {
    const seated = new Set(composeCouncil(AURA_FP, AURA_DOMAINS, PROFILES).seated.map((c) => c.advisorId));
    const missing = AURA_10.filter((a) => !seated.has(a));
    expect(missing, `Aura-10 members not seated: ${missing.join(", ")}`).toEqual([]);
  });
});

describe("AC1.4 back-compat superset — Python/aiogram", () => {
  it("seats a superset of the Python-9 panel", () => {
    const seated = new Set(composeCouncil(AIOGRAM_FP, PYTHON_DOMAINS, PROFILES).seated.map((c) => c.advisorId));
    const missing = PYTHON_9.filter((a) => !seated.has(a));
    expect(missing, `Python-9 members not seated: ${missing.join(", ")}`).toEqual([]);
  });
});

// Freshness canary (beck #3): the hermetic superset tests above score the FROZEN
// inline PROFILES, so a live meta.yaml that loses a capability would leave them green
// against a stale copy. When the live catalog is present (operator machine + the
// pre-commit hook), assert the inline PROFILES still MATCH what the catalog loads —
// so drift between this frozen baseline and reality fails loudly. Skipped in bare CI
// (no ~/.claude); the authoritative live gate remains the catalog verifier/CI.
describe("frozen PROFILES stay in sync with the live catalog (beck #3)", () => {
  const catalogRoot =
    process.env.COUNCIL_CATALOG ?? join(homedir(), ".claude", "skills", "_council-experts");
  const havePresent = existsSync(catalogRoot);
  const norm = (p: AdvisorProfile) => ({ id: p.id, signals: [...p.signals].sort(), domains: [...p.domains].sort() });

  it.skipIf(!havePresent)("inline PROFILES equal the loaded catalog profiles (ids + signals + domains)", () => {
    const live = loadCatalog(catalogRoot);
    expect(live.errors, `catalog load errors: ${JSON.stringify(live.errors)}`).toEqual([]);
    const liveNorm = live.profiles.map(norm).sort((a, b) => (a.id < b.id ? -1 : 1));
    const frozenNorm = PROFILES.map(norm).sort((a, b) => (a.id < b.id ? -1 : 1));
    expect(
      frozenNorm,
      "back-compat.golden PROFILES drifted from the live catalog meta.yaml — re-freeze them",
    ).toEqual(liveNorm);
  });
});

describe("snowlevel success metric — zero aiogram advice", () => {
  const VOCAB: Vocabulary = {
    signals: new Set(PROFILES.flatMap((p) => p.signals).concat(["fastapi", "python", "cpython", "react", "browser-spa", "postgres", "alembic", "sqlalchemy", "python-telegram-bot", "telegram-bot", "rest", "typescript", "javascript"])),
    domains: new Set(PROFILES.flatMap((p) => p.domains)),
    frameworks: new Set(["hono", "express", "fastify", "react", "vue", "svelte", "nextjs", "aiogram", "python-telegram-bot", "fastapi", "flask", "django", "starlette"]),
  };
  // FastAPI + Alembic/Postgres + React + python-telegram-bot — no aiogram anywhere.
  const SNOW_FP = fp({
    languages: ["python", "javascript", "typescript"], runtimes: ["cpython"],
    frameworks: ["fastapi", "react", "python-telegram-bot"], datastores: ["postgres"], "orm-migrations": ["sqlalchemy", "alembic"],
    surfaces: ["rest", "browser-spa", "telegram-bot"], infra: ["docker"],
  });

  it("no seated advisor's brief mentions aiogram", () => {
    const comp = composeCouncil(SNOW_FP, [...VOCAB.domains], PROFILES);
    for (const seat of comp.seated) {
      const profile = PROFILES.find((p) => p.id === seat.advisorId)!;
      const brief = buildAdvisorBrief(profile, seat.matchedSignals, SNOW_FP, VOCAB);
      expect(brief.adviseOn, `${seat.advisorId} adviseOn`).not.toContain("aiogram");
      expect(brief.detectedStack, `${seat.advisorId} detectedStack`).not.toContain("aiogram");
      if (brief.mismatchFlag) expect(brief.mismatchFlag).not.toContain("aiogram");
    }
    // vanrossum IS seated (via fastapi) and briefed for fastapi, not aiogram
    const van = comp.seated.find((c) => c.advisorId === "vanrossum");
    expect(van?.matchedSignals).toContain("fastapi");
    expect(van?.matchedSignals ?? []).not.toContain("aiogram");
  });
});
