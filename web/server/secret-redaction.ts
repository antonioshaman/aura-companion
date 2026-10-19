/**
 * Shared secret redactor for everything Aura persists that can carry user or
 * CLI text: protocol recordings (`~/.companion/recordings/*.jsonl`), the
 * session store (`~/.companion/sessions/<id>.json` message history), and the
 * server log (`logger.ts`).
 *
 * Why this module exists (2026-10 incident): recordings whose header said
 * `redactionApplied: true` still contained npm tokens, a Gonka key, Telegram
 * bot tokens, `PROVIDER_API_KEY=value` assignments, a `0x`-prefixed 64-hex
 * private key, and even OpenAI/Anthropic/GitHub tokens that the v1 policy
 * had patterns for. Root causes, all in the v1 recorder policy:
 *
 *  1. Missing classes — no npm_, gnk-, Telegram, generic KEY=value or JWT
 *     patterns, and the cheap pre-screen short-circuited those frames before
 *     any pattern ran.
 *  2. `\b` boundaries vs. double-encoded JSON. Claude's `input_json_delta`
 *     `partial_json`, tool_use inputs echoed inside tool results, and Codex
 *     JSON-RPC payloads carry JSON *text* inside a JSON string. After one
 *     `JSON.parse` the value still contains literal escape sequences, so a
 *     secret that followed a newline appears as `...\nsk-ant-...`. `n` is a
 *     word character, so `\bsk-` never matched — the token leaked even
 *     though its pattern existed. Same for `\t`, `\r`.
 *  3. The bare 64-hex rule was lowercase-only and `\b`-anchored, so
 *     `0x<64 hex>` (x and the first hex digit are both word chars) and
 *     upper-case hex were never redacted.
 *
 * Every rule below uses {@link LB} instead of `\b` — "not preceded by an
 * identifier character, OR preceded by a JSON escape like `\n`" — and the
 * structured walker in `redactStructured` reaches every string value at any
 * depth.
 *
 * Masks keep a short recognisable prefix (`npm_[REDACTED]`,
 * `sk-ant-oat01-[REDACTED]`, `OPENAI_API_KEY=[REDACTED]`) so forensic readers
 * can tell WHAT leaked without the value. No hashes of the value are kept.
 *
 * Bump {@link REDACTION_POLICY_VERSION} whenever a rule is added or widened;
 * the recorder stamps it into each file header so a reader can tell which
 * policy a file was written under.
 */

/** Placeholder substituted for any value that matched the redaction policy. */
export const REDACTED_PLACEHOLDER = "[REDACTED]" as const;

/**
 * Version of the redaction policy implemented here.
 *
 * - 1 (implicit — v3 recording headers with no `redactionVersion`): Task 11
 *   set — sk-, sk-ant-, Bearer, gh*_/github_pat_, `?token=`, lowercase bare
 *   64-hex, fixed key-name list. Leaked the classes listed in the module doc.
 * - 2: escape-aware boundaries, npm_, gnk-, Telegram bot tokens, JWTs,
 *   0x/upper-case 64-hex, generic `*KEY|TOKEN|SECRET|PASSWORD*=value`
 *   assignments, generic sensitive object keys.
 */
export const REDACTION_POLICY_VERSION = 2 as const;

const R = REDACTED_PLACEHOLDER;

/**
 * Escape-aware left boundary. Matches at start of input, after any
 * non-identifier character, or right after a JSON escape sequence
 * (`\n`, `\r`, `\t`, `\b`, `\f`) left behind by double-encoded JSON.
 */
const LB = String.raw`(?<=^|[^A-Za-z0-9_]|\\[nrtbf])`;
/** Right boundary: next char is not part of an identifier/token alphabet. */
const RB_ALNUM = String.raw`(?![A-Za-z0-9])`;
const RB_TOKEN = String.raw`(?![A-Za-z0-9_-])`;

export interface RedactionRule {
  /** Stable name used in tests and diagnostics. */
  readonly name: string;
  readonly re: RegExp;
  /**
   * Cheap NECESSARY condition for `re`: a case-insensitive, non-global,
   * lookbehind-free regex that matches every string `re` can match (it tests
   * for a literal fragment every match must contain). `re` only runs when the
   * gate passes, so the output is identical to always running `re`.
   *
   * Why (2026-10 event-loop stalls): every rule starts with the {@link LB}
   * lookbehind, and JavaScriptCore does not JIT regexes with lookbehind — they
   * run in the bytecode interpreter at ~100x the cost. The old combined
   * `ANY_RULE` pre-screen (all rules OR-ed, flag `i`) cost ~7 s per save of a
   * 2.6 MB session history on prod (thinking-block `signature` base64 blobs
   * were the worst: ~100 ms per 7 KB string), blocking the event loop.
   * The gates are JIT-compiled and scan the same history in a few ms.
   */
  readonly gate: RegExp;
  readonly replacement: string | ((match: string, ...groups: string[]) => string);
}

/** Names that label a fingerprint, not a secret (`tokenHash`, `argvSha256`, `key_id`). */
const NON_SECRET_NAME_SUFFIX = /(?:sha\d*|hash|digest|checksum|fingerprint|[_-]?id)$/i;

/**
 * Value-shape rules, applied in order to every string. Order matters:
 * specific prefixed tokens first (so `OPENAI_API_KEY=sk-proj-…` becomes
 * `OPENAI_API_KEY=sk-proj-[REDACTED]`, keeping the more informative prefix),
 * the generic assignment rule after them, bare hex last.
 *
 * Masks never contain `"` or `\`, and no rule consumes those characters, so
 * applying the rules to JSON text keeps it valid JSON.
 */
export const SECRET_RULES: readonly RedactionRule[] = [
  // Anthropic: API keys (sk-ant-api03-…), Claude OAuth access/refresh tokens
  // (sk-ant-oat01-… / sk-ant-ort01-…), admin keys. Keep the typed prefix.
  {
    name: "anthropic",
    gate: /sk-ant-/i,
    re: new RegExp(`${LB}(sk-ant-(?:[a-z]+\\d{2}-)?)[A-Za-z0-9_-]{16,}${RB_TOKEN}`, "g"),
    replacement: `$1${R}`,
  },
  // OpenAI and other `sk-` keys (project / user / service-account / admin).
  {
    name: "openai",
    gate: /sk-/i,
    re: new RegExp(`${LB}(sk-(?:proj-|user-|svcacct-|admin-)?)[A-Za-z0-9_-]{20,}${RB_TOKEN}`, "g"),
    replacement: `$1${R}`,
  },
  // GitHub classic PAT / OAuth / app / refresh tokens.
  {
    name: "github",
    gate: /gh[pousr]_/i,
    re: new RegExp(`${LB}(gh[pousr]_)[A-Za-z0-9]{20,}${RB_ALNUM}`, "g"),
    replacement: `$1${R}`,
  },
  // GitHub fine-grained PAT.
  {
    name: "github-fine-grained",
    gate: /github_pat_/i,
    re: new RegExp(`${LB}(github_pat_)[A-Za-z0-9_]{20,}${RB_ALNUM}`, "g"),
    replacement: `$1${R}`,
  },
  // npm automation/publish tokens: npm_ + 36 alphanumerics.
  {
    name: "npm",
    gate: /npm_/i,
    re: new RegExp(`${LB}(npm_)[A-Za-z0-9]{36}${RB_ALNUM}`, "g"),
    replacement: `$1${R}`,
  },
  // Gonka inference keys: gnk-…
  {
    name: "gonka",
    gate: /gnk-/i,
    re: new RegExp(`${LB}(gnk-)[A-Za-z0-9_-]{16,}${RB_TOKEN}`, "g"),
    replacement: `$1${R}`,
  },
  // Telegram bot tokens: <bot id>:AA<33 chars>. The bot id is a public user
  // id, kept so the reader knows which bot's token leaked.
  {
    name: "telegram-bot",
    gate: /\d:AA/i,
    re: new RegExp(`${LB}(\\d{8,10}:)AA[A-Za-z0-9_-]{33}${RB_TOKEN}`, "g"),
    replacement: `$1${R}`,
  },
  // JWTs (three base64url segments, header starts with eyJ).
  {
    name: "jwt",
    gate: /eyJ/i,
    re: new RegExp(
      `${LB}eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}${RB_TOKEN}`,
      "g",
    ),
    replacement: `eyJ${R}`,
  },
  // HTTP Authorization header values.
  {
    name: "bearer",
    gate: /Bearer\s/i,
    re: /(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/g,
    replacement: `$1${R}`,
  },
  // Companion auth token (or any token) in a URL query string.
  {
    name: "query-token",
    gate: /[?&](?:token|access_token|api_key|apikey|key)=/i,
    re: /([?&](?:token|access_token|api_key|apikey|key)=)[A-Za-z0-9._~+/=-]{16,}/gi,
    replacement: `$1${R}`,
  },
  // Generic assignment: a name containing KEY / TOKEN / SECRET / PASSWORD /
  // PASSWD / CREDENTIAL, then `=` or `:`, then a high-entropy value. Covers
  // `.env` lines, `export X=…`, systemd `Environment=X=…`, YAML, and JSON
  // text (`"api_key":"…"`, `\"api_key\":\"…\"`).
  //
  // False-positive guards (code like `token = settings.bot_token`,
  // `api_key = get_key(1)`, `MAX_TOKENS=4096`):
  //  - the value must be ≥ 12 chars from [A-Za-z0-9_+/=-] and contain at
  //    least one digit AND one letter;
  //  - the value must not be followed by `.`, `(`, `[` or more value chars
  //    (rejects attribute access / calls rather than truncating them);
  //  - names ending in hash/sha/digest/id (`tokenHash`, `key_id`) are kept.
  {
    name: "assignment",
    gate: /(?:key|token|secret|password|passwd|credential)[A-Za-z0-9_]*\\?["']?\s*[:=]/i,
    re: new RegExp(
      String.raw`([A-Za-z0-9_-]*(?:key|token|secret|password|passwd|credential)[A-Za-z0-9_]*)` +
        String.raw`(\\?["']?\s*[:=]\s*\\?["']?)` +
        String.raw`(?=[A-Za-z0-9_+/=-]*\d)(?=[A-Za-z0-9_+/=-]*[A-Za-z])` +
        String.raw`[A-Za-z0-9_+/=-]{12,}` +
        String.raw`(?![A-Za-z0-9_+/=.(\[-])`,
      "gi",
    ),
    replacement: (match: string, name: string, sep: string) =>
      NON_SECRET_NAME_SUFFIX.test(name) ? match : `${name}${sep}${R}`,
  },
  // Bare 64-hex: Companion auth token (randomBytes(32).hex), raw private keys
  // (EVM `0x…`, ed25519 seeds). Case-insensitive and 0x-aware. Over-redacts
  // incidental sha256 digests — accepted trade (see Hunt finding #7).
  {
    name: "hex64",
    gate: /[0-9a-f]{64}/i,
    re: new RegExp(`${LB}(0x)?[0-9a-fA-F]{64}${RB_ALNUM}`, "g"),
    replacement: `$1${R}`,
  },
];

/**
 * Cheap test: does the string possibly contain a value-shape secret? True
 * whenever any rule could match (each gate is a necessary condition of its
 * rule, case-insensitively). Replaces the former OR-of-all-rules regex, which
 * carried the non-JIT lookbehinds and dominated save/record CPU time.
 */
function anyGateMatches(text: string): boolean {
  for (const rule of SECRET_RULES) if (rule.gate.test(text)) return true;
  return false;
}

/**
 * Apply every value-shape rule to a string. Pure. Works on plain text and on
 * JSON text alike (masks and matches never touch `"` or `\`).
 *
 * @param opts.skip rule names to leave out (the logger keeps its own,
 *   context-aware 64-hex rule so diagnostic sha256 values stay readable).
 */
export function redactSecretsInText(
  text: string,
  opts?: { skip?: readonly string[] },
): string {
  if (!text) return text;
  let out = text;
  for (const rule of SECRET_RULES) {
    if (opts?.skip?.includes(rule.name)) continue;
    // Gate on the CURRENT text (earlier rules may have rewritten it): the
    // gate is a necessary condition for `re` matching, so skipping is exact.
    if (!rule.gate.test(out)) continue;
    const { re, replacement } = rule;
    out = typeof replacement === "string" ? out.replace(re, replacement) : out.replace(re, replacement);
  }
  return out;
}

/**
 * Object keys whose string VALUE is a secret regardless of its shape.
 * Matched against the literal key.
 */
const ALWAYS_SECRET_KEYS: readonly RegExp[] = [
  /^openai_api_key$/i,
  /^anthropic_api_key$/i,
  /^claude_code_oauth_token$/i,
  /^claudeCodeOauthToken$/i,
  /^claude_code_token$/i,
  /^companion_auth_token$/i,
  /^companionAuthToken$/i,
  /^oauth[_-]?token$/i,
  /^access[_-]?token$/i,
  /^refresh[_-]?token$/i,
  /^authorization$/i,
  /^x-api-key$/i,
];

/** Key names that are secret-ish; the value is redacted only if it looks like one. */
const SECRET_KEY_WORD = /key|token|secret|password|passwd|credential/i;
/** Opaque high-entropy value: no spaces/dots/parens, ≥ 12 chars, digit + letter. */
const OPAQUE_VALUE = /^(?=.*\d)(?=.*[A-Za-z])[A-Za-z0-9_+/=-]{12,}$/;

function redactKeyedValue(key: string, value: string): string | null {
  if (value.length === 0) return null;
  if (ALWAYS_SECRET_KEYS.some((re) => re.test(key))) return R;
  if (SECRET_KEY_WORD.test(key) && OPAQUE_VALUE.test(value)) return R;
  return null;
}

/**
 * Deep-walk a JSON-compatible value and redact secrets. Returns a NEW value
 * (input is never mutated) — callers persist the copy while keeping the
 * in-memory original intact.
 */
export function redactStructured<T>(value: T): T {
  return walk(value) as T;
}

function walk(value: unknown): unknown {
  if (typeof value === "string") return redactSecretsInText(value);
  if (Array.isArray(value)) return value.map(walk);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === "string") {
        out[k] = redactKeyedValue(k, v) ?? redactSecretsInText(v);
      } else {
        out[k] = walk(v);
      }
    }
    return out;
  }
  return value;
}

/** Cheap check used by callers that want byte-identical passthrough. */
export function mayContainSecret(text: string): boolean {
  if (!text) return false;
  return anyGateMatches(text) || SECRET_KEY_WORD.test(text);
}
