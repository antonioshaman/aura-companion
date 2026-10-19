// Observer SOUL splice (handoff 2026-10-18 §4, from specs/lifeos-and-soul-md-takeaways.md).
//
// The observer's identity — who it is, what it never does, how it sounds —
// lives in `.council/prompts/OBSERVER-SOUL.md`: a compact, CLI-agnostic
// document that travels between the claude and codex observer halves and can
// be read (or replaced) on its own. The loader still consumes ONE artifact,
// `.council/prompts/observer-system.md`, with its `v1` header sentinel: the
// build step splices the SOUL body between two markers in the system prompt,
// so the loader, its header contract, the bundled fallback and the recorder's
// prompt hash all stay exactly as they were. The drift gate (`bun run
// check-observer-prompt-drift`) covers both files.
//
// Pure and deterministic: same inputs → same output, byte for byte.

export const OBSERVER_SOUL_HEADER = /^<!-- observer-soul v(\d+) -->\s*$/;

/** The SOUL schema this splice understands. A SOUL with another version is
 *  rejected (mirrors `OBSERVER_PROMPT_SCHEMA_VERSION` in the loader) — the
 *  header is a contract, not decoration. */
export const OBSERVER_SOUL_SUPPORTED_VERSION = 1;

// The begin marker doubles as the in-file notice: the block between the
// markers is regenerated from OBSERVER-SOUL.md, so an edit made here is lost.
export const SOUL_BEGIN_MARKER = "<!-- soul:begin (generated from OBSERVER-SOUL.md; edit there) -->";
export const SOUL_END_MARKER = "<!-- soul:end -->";

/** Product budget for the whole spliced prompt, in UTF-8 bytes
 *  (specs/aura-meta-diet.md B1; also pinned in observer-prompt.test.ts). */
export const OBSERVER_PROMPT_BUDGET_BYTES = 5 * 1024;

/** Parsed SOUL schema version (first line), or null when the header is missing/malformed. */
export function parseObserverSoulHeader(raw: string): number | null {
  const first = raw.split("\n", 1)[0] ?? "";
  const m = OBSERVER_SOUL_HEADER.exec(first);
  if (!m) return null;
  const v = Number.parseInt(m[1]!, 10);
  return Number.isInteger(v) && v > 0 ? v : null;
}

/** Locate the single ordered marker pair; throws when it is missing, duplicated or reversed. */
function locateSoulMarkers(systemMd: string): { begin: number; end: number } {
  const begins = indexesOf(systemMd, SOUL_BEGIN_MARKER);
  const ends = indexesOf(systemMd, SOUL_END_MARKER);
  if (begins.length !== 1 || ends.length !== 1) {
    throw new Error(
      `observer-system.md: expected exactly one soul marker pair, found ${begins.length} begin / ${ends.length} end`,
    );
  }
  const begin = begins[0]! + SOUL_BEGIN_MARKER.length;
  const end = ends[0]!;
  if (end < begin) throw new Error("observer-system.md: soul:end marker precedes soul:begin");
  return { begin, end };
}

/** The text currently between the markers of `systemMd`, trimmed. Throws on a bad marker pair. */
export function extractSoulBlock(systemMd: string): string {
  const { begin, end } = locateSoulMarkers(systemMd);
  return systemMd.slice(begin, end).trim();
}

/**
 * Replace everything between the soul markers of `systemMd` with the body of
 * `soulMd` (its header sentinel dropped, CRLF normalised). Throws on a
 * missing/malformed/unsupported SOUL header, an empty body, a body that
 * itself contains a marker (it would poison the next splice), a missing or
 * duplicated marker pair, or markers out of order — a silent no-op here
 * would let the identity text drift from its source.
 */
export function spliceObserverSoul(systemMd: string, soulMd: string): string {
  const version = parseObserverSoulHeader(soulMd);
  if (version === null) {
    throw new Error("OBSERVER-SOUL.md: first line must be `<!-- observer-soul vN -->`");
  }
  if (version !== OBSERVER_SOUL_SUPPORTED_VERSION) {
    throw new Error(
      `OBSERVER-SOUL.md: schema v${version} is not supported by this splice (expected v${OBSERVER_SOUL_SUPPORTED_VERSION})`,
    );
  }
  const soulBody = soulMd
    .replace(/\r\n/g, "\n")
    .split("\n")
    .slice(1)
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\s+$/, "");
  if (soulBody.length === 0) throw new Error("OBSERVER-SOUL.md: body is empty");
  if (soulBody.includes(SOUL_BEGIN_MARKER) || soulBody.includes(SOUL_END_MARKER)) {
    throw new Error("OBSERVER-SOUL.md: body must not contain a soul marker");
  }
  const { begin, end } = locateSoulMarkers(systemMd);
  return systemMd.slice(0, begin) + "\n" + soulBody + "\n" + systemMd.slice(end);
}

function indexesOf(haystack: string, needle: string): number[] {
  const out: number[] = [];
  let i = haystack.indexOf(needle);
  while (i >= 0) {
    out.push(i);
    i = haystack.indexOf(needle, i + needle.length);
  }
  return out;
}
