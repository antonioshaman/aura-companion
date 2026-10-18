/**
 * Builds the observer system prompt from its two sources and regenerates the
 * bundled fallback:
 *
 *   .council/prompts/OBSERVER-SOUL.md      (identity; edit this)
 *   .council/prompts/observer-system.md    (mechanics; edit outside the soul markers)
 *        │ splice SOUL body between the markers
 *        ▼
 *   .council/prompts/observer-system.md    (REWRITTEN in place — the one artifact the loader reads)
 *   web/server/observer-prompt-bundled.ts  (generated TS constant + sha)
 *
 * The bundled prompt is the FALLBACK observer system-prompt used when a
 * workspace doesn't ship its own `.council/prompts/observer-system.md`.
 * Embedding it as a TS string constant (compile-time, not filesystem)
 * is the right primitive per Council Plan
 * `docs/history/council/handoffs/PLAN-aura-observer-prompt-bundled-fallback.md` D1: works identically
 * under npm package, Docker control-plane, and dev container — the three
 * shipping paths. A `__resources__/observer-system.md` file would be
 * silently dropped by `platform/.dockerignore`'s `*.md` rule.
 *
 * Drift gate: `bun run check-observer-prompt-drift` (CI, pre-commit and
 * `prepublishOnly` all call the same script) re-runs this build and fails if
 * either output differs from what is committed — an edited SOUL that was not
 * spliced, or a spliced prompt that was not re-bundled.
 *
 * Determinism: both outputs are BYTE-FOR-BYTE reproducible from the same
 * inputs — no timestamps, no random hex, no ordering by environment. Files
 * are only written when their bytes would change (so a no-op build is a pure
 * check), and each write goes through a temp file + rename so a concurrent
 * observer spawn never reads a truncated prompt.
 *
 * The build validates the spliced prompt the way the loader will (header
 * sentinel + schema version) and against the 5 KB product budget, and fails
 * before writing anything, so an over-budget SOUL edit is reported here with
 * the file to trim — not later by a test in another directory.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  OBSERVER_PROMPT_BUDGET_BYTES,
  extractSoulBlock,
  spliceObserverSoul,
} from "./observer-soul-splice.js";
import { OBSERVER_PROMPT_SCHEMA_VERSION, parseObserverPromptHeader } from "../server/observer-prompt.js";

const thisFile = fileURLToPath(import.meta.url);
// web/scripts/build-observer-prompt-bundle.ts → web/ → repo root.
const repoRoot = resolve(dirname(thisFile), "..", "..");
const systemPromptPath = join(repoRoot, ".council", "prompts", "observer-system.md");
const soulPath = join(repoRoot, ".council", "prompts", "OBSERVER-SOUL.md");
const outputPath = join(repoRoot, "web", "server", "observer-prompt-bundled.ts");

/** Write only when the bytes differ; temp file + rename so readers never see a partial file. */
function writeIfChanged(path: string, current: string, next: string): boolean {
  if (current === next) return false;
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, next, "utf-8");
  renameSync(tmp, path);
  return true;
}

// Handoff 2026-10-18 §4: the observer's identity lives in OBSERVER-SOUL.md and
// is spliced between the soul markers of the system prompt here, so the
// loader keeps consuming ONE artifact.
const systemOnDisk = readFileSync(systemPromptPath, "utf-8");
const soulOnDisk = readFileSync(soulPath, "utf-8");
const body = spliceObserverSoul(systemOnDisk, soulOnDisk);

// Validate before touching disk — the same checks the loader and the budget
// test apply, surfaced here with the file to fix.
const headerVersion = parseObserverPromptHeader(body);
if (headerVersion !== OBSERVER_PROMPT_SCHEMA_VERSION) {
  throw new Error(
    `${systemPromptPath}: first line must be \`<!-- observer-system-prompt v${OBSERVER_PROMPT_SCHEMA_VERSION} -->\` (got v${headerVersion ?? "none"})`,
  );
}
const bodyBytes = Buffer.byteLength(body, "utf8");
if (bodyBytes > OBSERVER_PROMPT_BUDGET_BYTES) {
  throw new Error(
    `spliced observer prompt is ${bodyBytes} bytes, over the ${OBSERVER_PROMPT_BUDGET_BYTES}-byte budget by ${bodyBytes - OBSERVER_PROMPT_BUDGET_BYTES} — trim ${soulPath} (or the sections outside the markers in ${systemPromptPath})`,
  );
}

// An edit made inside the marker block of observer-system.md is about to be
// replaced by the SOUL. Say so — the file is the one the loader reads and the
// natural place to edit, and the drift gate cannot see an uncommitted edit.
const blockOnDisk = extractSoulBlock(systemOnDisk);
const blockFromSoul = extractSoulBlock(body);
if (blockOnDisk !== blockFromSoul) {
  console.warn(
    `[build-observer-prompt-bundle] soul block in ${systemPromptPath} differs from ${soulPath}; overwriting it from the SOUL (edits inside the markers belong in OBSERVER-SOUL.md)`,
  );
}

const sha256 = createHash("sha256").update(body, "utf8").digest("hex");

// JSON.stringify produces a single-line, fully-escaped string literal —
// reviewable in a diff without quote/newline footguns. The ~5 KiB embedded
// prose lives in a `.ts` source file but does not interfere with
// TypeScript's parsing.
//
// Council Review 2026-05-15-1015 CR-22 (Willison W7): emit first/last
// ~200 chars of the body into a preceding comment so a reviewer scanning
// the generated TS can eyeball the header sentinel + the Failsafe section
// (the prompt's last section) without expanding the one-line escaped
// literal. The drift gate catches drift from the .md; this comment helps
// catch a malicious hand-edit that re-runs the generator to produce
// coherent (body, sha) but with hostile content injected into the middle
// of the body.
const previewHead = body.slice(0, 200).replace(/\*\//g, "*\\/");
const previewTail = body.slice(-200).replace(/\*\//g, "*\\/");

const bundleContent = `/**
 * AUTO-GENERATED — do not hand-edit.
 *
 * Sources of truth (repo root): \`.council/prompts/OBSERVER-SOUL.md\` (identity,
 * spliced between the soul markers) + \`.council/prompts/observer-system.md\`
 * (everything else). Regenerate via \`bun run build-observer-prompt-bundle\` (web/).
 *
 * The bundled observer system-prompt — fallback used by
 * \`resolveObserverSystemPrompt\` in \`observer-prompt.ts\` when the calling
 * workspace lacks its own \`.council/prompts/observer-system.md\`.
 * The bundled body MUST pass the same loader validation as workspace
 * artifacts (\`<!-- observer-system-prompt v1 -->\` header sentinel,
 * \`OBSERVER_PROMPT_MAX_BYTES\` ceiling, \`OBSERVER_PROMPT_MIN_BODY_BYTES\`
 * floor). The build step checks the header sentinel and the 5 KB product
 * budget before emitting this file; the loader re-validates at runtime.
 *
 * Reviewable preview (first/last ~200 chars of the body):
 *
 *   HEAD:
 *   ${previewHead.replace(/\n/g, "\n *   ")}
 *
 *   ...
 *
 *   TAIL:
 *   ${previewTail.replace(/\n/g, "\n *   ")}
 *
 * Drift gate: \`bun run check-observer-prompt-drift\` fails if this file or
 * \`.council/prompts/observer-system.md\` drifts from its sources.
 */

/** Full body of the bundled observer system-prompt, including the
 *  \`<!-- observer-system-prompt v1 -->\` header sentinel as the first line. */
export const BUNDLED_OBSERVER_PROMPT: string = ${JSON.stringify(body)};

/** SHA-256 (hex-encoded) of \`BUNDLED_OBSERVER_PROMPT\`. Pinned at build
 *  time; loader callers MAY re-compute and assert against this constant
 *  for tamper-detection. */
export const BUNDLED_OBSERVER_PROMPT_SHA256: string = ${JSON.stringify(sha256)};
`;

let bundleOnDisk = "";
try {
  bundleOnDisk = readFileSync(outputPath, "utf-8");
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
}

const wrotePrompt = writeIfChanged(systemPromptPath, systemOnDisk, body);
const wroteBundle = writeIfChanged(outputPath, bundleOnDisk, bundleContent);

console.log(
  `[build-observer-prompt-bundle] ${wroteBundle ? "wrote" : "unchanged"} ${outputPath}\n` +
    `  prompt: ${systemPromptPath} (${wrotePrompt ? "rewritten" : "unchanged"}; soul: ${soulPath})\n` +
    `  bytes:  ${bodyBytes} UTF-8 (${OBSERVER_PROMPT_BUDGET_BYTES - bodyBytes} under the ${OBSERVER_PROMPT_BUDGET_BYTES}-byte budget)\n` +
    `  sha256: ${sha256}`,
);
