// Shared licence + slug vocabulary for the UI/UX source catalog (uiux-sources.ts)
// and the vendored-skills lock (vendored-skills.ts). One module so the two lists
// cannot drift apart silently (review 2026-10-27-2139 finding #21).
//
// The two sets differ on purpose:
//   - PARAPHRASE_OK_LICENCES: we may read, paraphrase and attribute the source.
//     Includes CC-BY-4.0 (attribution-only prose licence).
//   - SHIPPABLE_CODE_LICENCES: we may redistribute the bytes verbatim inside the
//     package. Prose-only CC licences are excluded — a vendored skill is code and
//     instructions, and CC licences are not meant for software.

export const PARAPHRASE_OK_LICENCES: ReadonlySet<string> = new Set([
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "0BSD",
  "Unlicense",
  "CC0-1.0",
  "CC-BY-4.0",
]);

export const SHIPPABLE_CODE_LICENCES: ReadonlySet<string> = new Set(
  [...PARAPHRASE_OK_LICENCES].filter((l) => l !== "CC-BY-4.0"),
);

/** Copyleft (strong or weak): the spec's "ask first" boundary. Prefix match on SPDX ids. */
export const COPYLEFT_PREFIXES: readonly string[] = ["GPL-", "LGPL-", "AGPL-", "MPL-", "EPL-", "CC-BY-SA-", "EUPL-", "OSL-"];

/** Ids, skill names and corpus file stems: lowercase slug, safe as a single path segment. */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
