/**
 * Generates `web/server/observer-prompt-bundled.ts` from the canonical
 * `.council/prompts/observer-system.md` artifact.
 *
 * The bundled prompt is the FALLBACK observer system-prompt used when a
 * workspace doesn't ship its own `.council/prompts/observer-system.md`.
 * Embedding it as a TS string constant (compile-time, not filesystem)
 * is the right primitive per Council Plan
 * `PLAN-aura-observer-prompt-bundled-fallback.md` D1: works identically
 * under npm package, Docker control-plane, and dev container — the three
 * shipping paths. A `__resources__/observer-system.md` file would be
 * silently dropped by `platform/.dockerignore`'s `*.md` rule.
 *
 * CI canary: `bun run build-observer-prompt-bundle && git diff --exit-code`
 * detects drift between the canonical artifact and the bundled output.
 *
 * Determinism: the generated module is BYTE-FOR-BYTE reproducible from
 * the same canonical artifact — no timestamps, no random hex, no ordering
 * by environment. Re-running the script with no changes to the canonical
 * source produces zero `git diff`.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const thisFile = fileURLToPath(import.meta.url);
// web/scripts/build-observer-prompt-bundle.ts → web/ → repo root.
const repoRoot = resolve(dirname(thisFile), "..", "..");
const canonicalPath = join(repoRoot, ".council", "prompts", "observer-system.md");
const outputPath = join(repoRoot, "web", "server", "observer-prompt-bundled.ts");

const body = readFileSync(canonicalPath, "utf-8");
const sha256 = createHash("sha256").update(body, "utf8").digest("hex");

// JSON.stringify produces a single-line, fully-escaped string literal —
// reviewable in a diff without quote/newline footguns. The 9 KiB embedded
// prose lives in a `.ts` source file but does not interfere with
// TypeScript's parsing.
const bundleContent = `/**
 * AUTO-GENERATED — do not hand-edit.
 *
 * Source of truth: \`.council/prompts/observer-system.md\` at the repo root.
 * Regenerate via \`bun run build-observer-prompt-bundle\` (web/).
 *
 * The bundled observer system-prompt — fallback used by
 * \`resolveObserverSystemPrompt\` in \`observer-prompt.ts\` when the calling
 * workspace lacks its own \`.council/prompts/observer-system.md\`.
 * The bundled body MUST pass the same loader validation as workspace
 * artifacts (\`<!-- observer-system-prompt v1 -->\` header sentinel,
 * \`OBSERVER_PROMPT_MAX_BYTES\` ceiling, \`OBSERVER_PROMPT_MIN_BODY_BYTES\`
 * floor). The build step verifies the artifact parses before emitting
 * this file; downstream callers may trust the constants are loader-valid.
 *
 * CI canary: \`bun run build-observer-prompt-bundle && git diff --exit-code\`
 * fails if this file drifts from the canonical artifact.
 */

/** Full body of the bundled observer system-prompt, including the
 *  \`<!-- observer-system-prompt v1 -->\` header sentinel as the first line. */
export const BUNDLED_OBSERVER_PROMPT: string = ${JSON.stringify(body)};

/** SHA-256 (hex-encoded) of \`BUNDLED_OBSERVER_PROMPT\`. Pinned at build
 *  time; loader callers MAY re-compute and assert against this constant
 *  for tamper-detection. */
export const BUNDLED_OBSERVER_PROMPT_SHA256: string = ${JSON.stringify(sha256)};
`;

writeFileSync(outputPath, bundleContent, "utf-8");

console.log(
  `[build-observer-prompt-bundle] wrote ${outputPath}\n` +
    `  source: ${canonicalPath}\n` +
    `  bytes:  ${body.length}\n` +
    `  sha256: ${sha256}`,
);
