// Observer SOUL splice (handoff 2026-10-18 §4, from specs/lifeos-and-soul-md-takeaways.md).
//
// The observer's identity — who it is, what it never does, how it sounds —
// lives in `.council/prompts/OBSERVER-SOUL.md`: a compact, CLI-agnostic
// document that travels between the claude and codex observer halves and can
// be read (or replaced) on its own. The loader still consumes ONE artifact,
// `.council/prompts/observer-system.md`, with its `v1` header sentinel: the
// build step splices the SOUL body between two markers in the system prompt,
// so the loader, its header contract, the bundled fallback and the recorder's
// prompt hash all stay exactly as they were. The CI canary (`bun run
// build-observer-prompt-bundle && git diff --exit-code`) now covers both files.
//
// Pure and deterministic: same inputs → same output, byte for byte.

export const OBSERVER_SOUL_HEADER = /^<!-- observer-soul v(\d+) -->\s*$/;
export const SOUL_BEGIN_MARKER = "<!-- soul:begin (from OBSERVER-SOUL.md) -->";
export const SOUL_END_MARKER = "<!-- soul:end -->";

/** Parsed SOUL schema version (first line), or null when the header is missing/malformed. */
export function parseObserverSoulHeader(raw: string): number | null {
  const first = raw.split("\n", 1)[0] ?? "";
  const m = OBSERVER_SOUL_HEADER.exec(first);
  if (!m) return null;
  const v = Number.parseInt(m[1]!, 10);
  return Number.isInteger(v) && v > 0 ? v : null;
}

/**
 * Replace everything between the soul markers of `systemMd` with the body of
 * `soulMd` (its header sentinel dropped). Throws on a missing/malformed SOUL
 * header, a missing or duplicated marker pair, or markers out of order — a
 * silent no-op here would let the identity text drift from its source.
 */
export function spliceObserverSoul(systemMd: string, soulMd: string): string {
  if (parseObserverSoulHeader(soulMd) === null) {
    throw new Error("OBSERVER-SOUL.md: first line must be `<!-- observer-soul vN -->`");
  }
  const soulBody = soulMd.split("\n").slice(1).join("\n").replace(/^\n+/, "").replace(/\s+$/, "");
  if (soulBody.length === 0) throw new Error("OBSERVER-SOUL.md: body is empty");
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
