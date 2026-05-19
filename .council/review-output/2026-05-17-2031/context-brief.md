# Context Brief for Aura Council Review — docs rebrand + Council Mode coverage

## What this code does

A docs-only PR (commit `50a9018`) that rebrands leftover "Vibe-Companion" / "the-companion" surface copy to "Aura Companion" (MIT attribution preserved), documents Council Mode end-to-end (orchestrator + observer pairing), and aligns landing-site `rel` hygiene with the rebrand. No backend, no protocol, no persistence, no subprocess changes.

## Architecture

Three reader entry points:

- `README.md` — GitHub-facing.
- `docs/` — Mintlify site with `index.mdx`, `guides/*.mdx`, `reference/*.mdx`, `get-started/installation.mdx`, `deploy/cloud-vm.mdx`. `docs.json` is the SSOT for nav.
- `landing/src/components/` — Vite React landing site. Nav.tsx and Footer.tsx are the only TSX surfaces touched.

## Stack in use within scope

This PR is **documentation only**. Touched surfaces: Markdown / MDX / two TSX `<a>` `rel` attribute edits. Absent from scope (deliberately): `web/server/`, `web/src/`, `web/scripts/`, `aura/`, `conventions.md`, `WEBSOCKET_PROTOCOL_REVERSED.md`, `specs/council-mode-paired-sessions.md`, all test files, all CI workflows, all subprocess / persistence / protocol code.

## Key observations

- The Council Mode guide and architecture reference were rewritten from existing 134-line / 188-line drafts: guide now includes a fallible-observer framing block at the top, what-it-can / cannot-do enumeration, worked grounding example, finding lifecycle, restart-replay determinism section, expanded pairing tradeoffs, and 7 troubleshooting rows including bundled-fallback + failsafe-wake + recordings-debug.
- The reference doc dropped the in-page 12-row AP-/EC- table in favour of a link to canonical `conventions.md` (which is at AP-1..4 + EC-1..32), dropped the file-path Source-map table to prevent rot, and locked the security-property prose against convention IDs (EC-1, EC-2, EC-7, EC-8, EC-13).
- README compressed from 309 → ~210 lines: badges 4 → 2, dropped duplicate Council Mode ASCII data-flow diagram, removed "29 skills" claims (disk truth is 30; replaced with "growing skill chain"), `bunx the-companion` → `bunx aura-companion` (matches `web/package.json` bin), MIT attribution preserved verbatim.
- Across `installation.mdx`, `cli-and-api.mdx`, `cloud-vm.mdx`, `troubleshooting.mdx`: every `the-companion` CLI command/install reference flipped to `aura-companion`. The Docker image references (`the-companion:latest`) deliberately preserved — separate published artifact name.
- `landing/src/components/Nav.tsx` + `Footer.tsx`: 6 `rel="noopener"` → `rel="noopener noreferrer"`. Footer's MIT-attribution Vibe-Company URL preserved (spec mandates).
- Plan file `.council/abtest/v1-docs-plan.md` co-committed for traceability.

## Automated check results

All green:

- `cd web && bun run typecheck` — exit 0, no errors.
- `cd web && bun run test` — exit 0; 247 test files, 6384 passed, 4 skipped.
- a11y: vitest-axe runs are folded into the regular test command; all passing.

No pre-existing failures encountered.

## Domain File Assignments

**Hunt (Security):** `landing/src/components/Footer.tsx`, `landing/src/components/Nav.tsx`, `README.md` (MIT attribution + outbound links), `docs/reference/council-mode-architecture.mdx` (observer-write-boundary / grounding-gate / group-authorization prose — factual accuracy), `docs/guides/council-mode.mdx` (no marketing-grade security claims).

**Fowler (Refactoring):** `README.md` (signal-density, ASCII blocks, skill-count drift, DRY across surfaces), `docs/guides/council-mode.mdx` ↔ `docs/reference/council-mode-architecture.mdx` (canonical-home discipline; link-not-restate), `docs/index.mdx` (CardGroup hierarchy).

**Frontend (React/Web UI):** `landing/src/components/Nav.tsx`, `landing/src/components/Footer.tsx` (rel hardening, minimal-diff discipline, JSX shape stability).

**a11y Auditor:** `landing/src/components/Nav.tsx`, `landing/src/components/Footer.tsx` (rel correctness, mobile GitHub link, logo accessible name), `README.md` + `docs/index.mdx` + `docs/guides/council-mode.mdx` (alt text quality on screenshots, heading hierarchy, double-H1 risk).

**Saarinen (UI Quality):** `README.md` (badge compression, ASCII removal, typography rhythm), `docs/index.mdx` (Card hierarchy), `docs/guides/council-mode.mdx` (table density → ordered list for state pills).

**Friedman (UX Quality):** `README.md` (triad-above-skills-inventory), `docs/guides/council-mode.mdx` (reading order = spec acceptance order, troubleshooting discoverability, lifecycle), `docs/index.mdx` (Card disambiguation).

**Willison (LLM Pipeline):** `docs/guides/council-mode.mdx` (fallible-observer framing, can/cannot enumeration, grounding worked example, lifecycle, restart-replay determinism, pairing tradeoffs, troubleshooting with bundled-fallback / failsafe-wake / recordings debug), `docs/reference/council-mode-architecture.mdx` (prompt versioning audit affordance + EC-locked claim prose).

**Deploy (Docker + GHA):** `docs/get-started/installation.mdx` (`bunx aura-companion` against `web/package.json` bin truth), `docs/reference/cli-and-api.mdx`, `docs/deploy/cloud-vm.mdx`, `docs/reference/troubleshooting.mdx`, `README.md` Quick Start, `docs/docs.json` (schema/nav-pages-exist canary), screenshot binary size + supply-chain hygiene on external links.

(Backend, Persistence, Realtime, Subprocess, Beck — zero files in scope; skipped per Phase 3 rules.)
