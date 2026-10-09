/**
 * Publish filter for bench cells (P6/D3-REFRESH): turns the bench
 * `results/cells.jsonl` into the copy committed under `docs/aurabench/data/`.
 *
 * - `isolation` keeps only what the report reads: `violations`,
 *   `layer_evidence`, `council_halves`. The rest (worktree, instance home,
 *   credential copies, skills/plugins lists) is bench-box detail.
 * - Every absolute path under /home, /root, /tmp, /var or /Users becomes
 *   `<path>` — in any string field, keys included.
 * - {@link assertPublishable} refuses output that still carries a home path
 *   or anything shaped like a credential, so a new cell field cannot leak
 *   silently. A bare file name such as `.credentials.json` is allowed: cells
 *   cite it in prose ("no .credentials.json; access token only"); its real
 *   location is a home path and is caught by the path rule.
 *
 * Pure. Firewall-clean.
 */

const KEEP_ISOLATION = ["violations", "layer_evidence", "council_halves"] as const;

const ABS_PATH_RE = /\/(?:home|root|tmp|var|Users)(?:\/[^\s"'`,;:)\]}]*)?/g;

/** Credential shapes and private paths that must never reach the committed data. */
const FORBIDDEN_RES: readonly RegExp[] = [
  /\/(?:home|root|Users)\//,
  /sk-ant-[A-Za-z0-9_-]{8,}/,
  /\bsk-[A-Za-z0-9]{20,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /"(?:access|refresh|id)_?[Tt]oken"\s*:/,
];

function scrub(x: unknown): unknown {
  if (typeof x === "string") return x.replace(ABS_PATH_RE, "<path>");
  if (Array.isArray(x)) return x.map(scrub);
  if (x && typeof x === "object")
    return Object.fromEntries(Object.entries(x).map(([k, v]) => [scrub(k) as string, scrub(v)]));
  return x;
}

export function sanitizeCellForPublish(rec: Record<string, unknown>): Record<string, unknown> {
  const iso = (rec.isolation ?? {}) as Record<string, unknown>;
  const isolation: Record<string, unknown> = {};
  for (const k of KEEP_ISOLATION) if (k in iso) isolation[k] = iso[k];
  return scrub({ ...rec, isolation }) as Record<string, unknown>;
}

/** Throws with the first offending pattern; returns the text unchanged otherwise. */
export function assertPublishable(text: string): string {
  for (const re of FORBIDDEN_RES) {
    const m = re.exec(text);
    if (m) throw new Error(`refusing to publish: matches ${re} near "${text.slice(Math.max(0, m.index - 40), m.index + 40)}"`);
  }
  return text;
}

/**
 * Sanitizes a cells JSONL. Optional `keep` filters records (e.g. stage-1/2
 * cells only); blank lines are dropped.
 */
export function publishCellsJsonl(jsonl: string, keep: (rec: Record<string, unknown>) => boolean = () => true): string {
  const out: string[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line) as Record<string, unknown>;
    if (keep(rec)) out.push(JSON.stringify(sanitizeCellForPublish(rec)));
  }
  return assertPublishable(out.length ? out.join("\n") + "\n" : "");
}
