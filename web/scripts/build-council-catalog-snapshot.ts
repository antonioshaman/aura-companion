#!/usr/bin/env bun
// Freezes a snapshot of the live council-experts catalog (the closed vocabulary +
// the seated capability profiles) into web/scripts/__fixtures__/council-catalog/,
// so the emit-side vocabulary closure (P2-7) and the back-compat superset / freshness
// canary (P2-12) can run HERMETICALLY in the aura repo's CI — which has no ~/.claude
// (observer WARN 1 + 2 on the RC-2 review: those tests were `skipIf(!havePresent)` and
// so skipped entirely in CI, never gating a fingerprint emit typo or a meta.yaml drift).
//
// The snapshot is the checked-in, reviewable anchor: CI asserts the aura engine against
// it hermetically, and a skip-if-present freshness test asserts snapshot == live where
// the catalog exists (operator machine + pre-commit). Regenerate after a deliberate
// catalog change:  bun run scripts/build-council-catalog-snapshot.ts

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { loadCatalog } from "./capability-catalog.js";

const CATALOG =
  process.env.COUNCIL_CATALOG ?? join(homedir(), ".claude", "skills", "_council-experts");
const OUT = join(dirname(new URL(import.meta.url).pathname), "__fixtures__", "council-catalog");

if (!existsSync(CATALOG)) {
  throw new Error(`live catalog not found at ${CATALOG} — cannot snapshot (set COUNCIL_CATALOG)`);
}

// Vocabulary: keep the live grouped shape (so the frameworks group survives + the
// freshness diff is byte-comparable to the live file's signals/domains).
const liveVocab = JSON.parse(
  readFileSync(join(CATALOG, ".verify", "capability-vocabulary.json"), "utf8"),
) as { schema_version: number; signals: Record<string, string[]>; domains: string[] };

const vocabSnapshot = {
  _doc:
    "FROZEN SNAPSHOT of _council-experts/.verify/capability-vocabulary.json for hermetic aura CI " +
    "(observer WARN, P2-7). Regenerate via scripts/build-council-catalog-snapshot.ts; the freshness " +
    "canary asserts this == live where the catalog is present.",
  schema_version: liveVocab.schema_version,
  signals: liveVocab.signals,
  domains: liveVocab.domains,
};

// Profiles: the seated set, exactly as loadCatalog produces them (lowercased; sort for
// a stable, diff-friendly snapshot).
const loaded = loadCatalog(CATALOG);
if (loaded.errors.length > 0) {
  throw new Error(`catalog load errors, refusing to snapshot: ${JSON.stringify(loaded.errors)}`);
}
const profiles = loaded.profiles
  .map((p) => ({ id: p.id, signals: [...p.signals].sort(), domains: [...p.domains].sort() }))
  .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

const profilesSnapshot = {
  _doc:
    "FROZEN SNAPSHOT of the seated _council-experts/*/meta.yaml capability profiles for hermetic " +
    "aura CI (observer WARN, P2-12). Regenerate via scripts/build-council-catalog-snapshot.ts; the " +
    "freshness canary asserts this == live where present.",
  profiles,
};

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "vocabulary.json"), JSON.stringify(vocabSnapshot, null, 2) + "\n");
writeFileSync(join(OUT, "profiles.json"), JSON.stringify(profilesSnapshot, null, 2) + "\n");
console.log(`council catalog snapshot: vocabulary (${Object.keys(liveVocab.signals).length} groups) + ${profiles.length} profiles`);
