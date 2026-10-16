import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  REDACTED_PLACEHOLDER,
  SECRET_RULES,
  mayContainSecret,
  redactSecretsInText,
  redactStructured,
} from "./secret-redaction.js";

// All "secrets" below are SYNTHETIC: built from repeated filler so they match
// the real token SHAPE (prefix + length + alphabet) without being a real
// credential. Never paste a real value into this file.
const fill = (n: number, alphabet = "aB3dE5gH7jK9mN1pQ") =>
  Array.from({ length: n }, (_, i) => alphabet[i % alphabet.length]).join("");

const FAKE = {
  npm: `npm_${fill(36)}`,
  gonka: `gnk-${fill(40)}`,
  telegram: `123456789:AA${fill(33)}`,
  anthropicApi: `sk-ant-api03-${fill(80)}`,
  claudeOauth: `sk-ant-oat01-${fill(80)}`,
  openai: `sk-proj-${fill(48)}`,
  openaiLegacy: `sk-${fill(48)}`,
  github: `ghp_${fill(36)}`,
  githubFine: `github_pat_${fill(22)}_${fill(59)}`,
  jwt: `eyJ${fill(20)}.eyJ${fill(30)}.${fill(43)}`,
  hex64: "0123456789abcdef".repeat(4),
  hex64Upper: "0123456789ABCDEF".repeat(4),
  envValue: fill(32),
} as const;

/** Assert no part of the secret's random body survived. */
function expectGone(out: string, secret: string) {
  expect(out).not.toContain(secret);
  // The body (after a short prefix) must not survive either.
  expect(out).not.toContain(secret.slice(-16));
}

describe("redactSecretsInText — true positives per class", () => {
  // Each case: the input, the secret that must disappear, and the
  // recognisable prefix that must remain so forensic readers know WHAT leaked.
  const cases: Array<[name: string, input: string, secret: string, keep: string]> = [
    ["npm token in .npmrc", `//registry.npmjs.org/:_authToken=${FAKE.npm}`, FAKE.npm, "npm_[REDACTED]"],
    ["npm token in prose", `use ${FAKE.npm} to publish`, FAKE.npm, "npm_[REDACTED]"],
    ["gonka key", `GONKA ${FAKE.gonka}`, FAKE.gonka, "gnk-[REDACTED]"],
    ["telegram bot token", `bot ${FAKE.telegram} ok`, FAKE.telegram, "123456789:[REDACTED]"],
    ["anthropic api key", `key ${FAKE.anthropicApi}`, FAKE.anthropicApi, "sk-ant-api03-[REDACTED]"],
    ["claude oauth access token", `tok ${FAKE.claudeOauth}`, FAKE.claudeOauth, "sk-ant-oat01-[REDACTED]"],
    ["openai project key", `k=${FAKE.openai}`, FAKE.openai, "sk-proj-[REDACTED]"],
    ["openai legacy key", `k ${FAKE.openaiLegacy}`, FAKE.openaiLegacy, "sk-[REDACTED]"],
    ["github classic PAT", `${FAKE.github}`, FAKE.github, "ghp_[REDACTED]"],
    ["github fine-grained PAT", `${FAKE.githubFine}`, FAKE.githubFine, "github_pat_[REDACTED]"],
    ["jwt", `cookie ${FAKE.jwt}`, FAKE.jwt, "eyJ[REDACTED]"],
    ["64-hex private key", `private key: ${FAKE.hex64}`, FAKE.hex64, "private key: [REDACTED]"],
    ["0x 64-hex private key", `secret 0x${FAKE.hex64}`, FAKE.hex64, "0x[REDACTED]"],
    ["upper-case 64-hex", `secret ${FAKE.hex64Upper}`, FAKE.hex64Upper, "[REDACTED]"],
    ["provider KEY=value", `OPENROUTER_API_KEY=${FAKE.envValue}`, FAKE.envValue, "OPENROUTER_API_KEY=[REDACTED]"],
    ["export SECRET=\"value\"", `export JWT_SECRET="${FAKE.envValue}"`, FAKE.envValue, 'JWT_SECRET="[REDACTED]"'],
    ["systemd Environment=", `Environment=DB_PASSWORD=${FAKE.envValue}`, FAKE.envValue, "DB_PASSWORD=[REDACTED]"],
    ["yaml password:", `password: ${FAKE.envValue}`, FAKE.envValue, "password: [REDACTED]"],
    ["json text api_key", `{"api_key":"${FAKE.envValue}"}`, FAKE.envValue, '"api_key":"[REDACTED]"'],
    ["escaped json text", `{\\"apiKey\\":\\"${FAKE.envValue}\\"}`, FAKE.envValue, '\\"apiKey\\":\\"[REDACTED]'],
    ["url query api_key", `https://x.test/v1?api_key=${FAKE.envValue}&q=1`, FAKE.envValue, "api_key=[REDACTED]&q=1"],
  ];

  for (const [name, input, secret, keep] of cases) {
    it(`redacts ${name}`, () => {
      const out = redactSecretsInText(input);
      expectGone(out, secret);
      expect(out).toContain(keep);
    });
  }

  it("catches tokens right after a literal JSON escape (double-encoded JSON)", () => {
    // ROOT CAUSE #2 of the leak: inside input_json_delta.partial_json or a
    // Codex payload, a secret on a new line is preceded by the two chars
    // `\` `n` after one JSON.parse. v1 used `\b`, and `n` is a word char,
    // so `\bsk-` / `\bghp_` never matched.
    for (const secret of [FAKE.claudeOauth, FAKE.github, FAKE.npm, FAKE.telegram, FAKE.gonka]) {
      for (const esc of ["\\n", "\\t", "\\r"]) {
        const out = redactSecretsInText(`{"command":"echo hi${esc}${secret}${esc}"}`);
        expectGone(out, secret);
      }
    }
  });

  it("keeps the more specific prefix when a typed token is assigned to a KEY", () => {
    const out = redactSecretsInText(`ANTHROPIC_API_KEY=${FAKE.anthropicApi}`);
    expect(out).toBe("ANTHROPIC_API_KEY=sk-ant-api03-[REDACTED]");
  });

  it("output of text redaction on JSON text stays valid JSON", () => {
    const json = JSON.stringify({
      a: `export TOKEN=${FAKE.envValue}\n${FAKE.npm}`,
      b: JSON.stringify({ inner: `x\n${FAKE.claudeOauth}` }),
    });
    const out = redactSecretsInText(json);
    expect(() => JSON.parse(out)).not.toThrow();
    expectGone(out, FAKE.envValue);
    expectGone(out, FAKE.npm);
    expectGone(out, FAKE.claudeOauth);
  });

  it("every rule has at least one true-positive case above", () => {
    // Guard: a newly added rule must come with a test case.
    const covered = new Set<string>();
    const all = [
      ...Object.values(FAKE),
      `A_TOKEN=${FAKE.envValue}`,
      `Bearer ${FAKE.envValue}`,
      `?token=${FAKE.envValue}`,
    ];
    for (const s of all) for (const r of SECRET_RULES) if (new RegExp(r.re.source, r.re.flags).test(s)) covered.add(r.name);
    expect([...covered].sort()).toEqual(SECRET_RULES.map((r) => r.name).sort());
  });
});

describe("redactSecretsInText — false-positive guards (code, prose, ids)", () => {
  // These must pass through byte-identical: ordinary code and protocol text
  // that merely mentions token/key/secret names.
  const inert = [
    "token = settings.bot_token",
    "api_key = get_key(1)",
    "self.secret_key = os.environ['SECRET_KEY']",
    "const token = await getToken(userId2)",
    "MAX_TOKENS=4096",
    '{"input_tokens":12345,"output_tokens":678,"cache_read_input_tokens":0}',
    "password: ${DB_PASSWORD}",
    "SECRET_KEY=$SECRET_KEY",
    "SSH_KEY_PATH=/home/user2/.ssh/id_ed25519",
    "tokenHash=0123456789abcdef0123",
    "api_key_id=key_0123456789abcdef",
    "sk-learn is a library", // too short to be a key
    "npm_config_cache=/tmp/npm1", // npm_ prefix but not a token shape
    "git sha 0123456789abcdef0123456789abcdef01234567", // 40-hex git SHA
    "toolu_01ABCdefGHIjklMNOpqrSTU",
    "The secret is to keep going.",
    "keyboard layout v2 updated",
  ];
  for (const text of inert) {
    it(`leaves untouched: ${text}`, () => {
      expect(redactSecretsInText(text)).toBe(text);
    });
  }
});

describe("redactStructured", () => {
  it("redacts by key name and by value shape at any depth, without mutating input", () => {
    const input = {
      type: "user",
      message: {
        content: [
          { type: "text", text: `my npm token is ${FAKE.npm}` },
          { type: "tool_result", content: JSON.stringify({ stdout: `BOT=${FAKE.telegram}` }) },
        ],
      },
      env: { OPENAI_API_KEY: "short-opaque", HOME: "/root", session_token: FAKE.envValue },
      usage: { output_tokens: 42 },
    };
    const snapshot = JSON.stringify(input);
    const out = redactStructured(input);
    const s = JSON.stringify(out);
    expectGone(s, FAKE.npm);
    expectGone(s, FAKE.telegram);
    expectGone(s, FAKE.envValue);
    expect(out.env.OPENAI_API_KEY).toBe(REDACTED_PLACEHOLDER); // always-secret key
    expect(out.env.HOME).toBe("/root");
    expect(out.usage.output_tokens).toBe(42);
    // Input untouched — the in-memory session must keep the original.
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("leaves secret-named keys with non-secret values alone", () => {
    const input = { apiKeySource: "none", max_tokens: "4096", token_type: "bearer" };
    expect(redactStructured(input)).toEqual(input);
  });
});

// ─── Gates: performance fix without behaviour change (2026-10 lag stalls) ────
//
// Prod evidence: the event-loop lag monitor logged ~10k stalls in 48h (median
// 2.4 s, max 70 s) whose time was "untracked". Root cause: every rule starts
// with a lookbehind, JavaScriptCore runs lookbehind regexes in its interpreter
// (no JIT), and the old OR-of-all-rules pre-screen cost ~4–8 s per save of a
// 2–4 MB session history. Each rule now carries a cheap JIT-able `gate` that
// is a NECESSARY condition for the rule to match; the rule only runs when the
// gate passes. These tests pin both halves: the output is byte-identical to
// the pre-gate implementation, and the pathological input is fast.

/** The pre-gate implementation, kept verbatim as the equivalence oracle. */
const LEGACY_ANY_RULE = new RegExp(SECRET_RULES.map((r) => `(?:${r.re.source})`).join("|"), "i");
function legacyRedactSecretsInText(text: string, opts?: { skip?: readonly string[] }): string {
  if (!text || !LEGACY_ANY_RULE.test(text)) return text;
  let out = text;
  for (const rule of SECRET_RULES) {
    if (opts?.skip?.includes(rule.name)) continue;
    const { re, replacement } = rule;
    out = typeof replacement === "string" ? out.replace(re, replacement) : out.replace(re, replacement);
  }
  return out;
}
function legacyMayContainSecret(text: string): boolean {
  if (!text) return false;
  return LEGACY_ANY_RULE.test(text) || /key|token|secret|password|passwd|credential/i.test(text);
}

/** Deterministic PRNG (mulberry32) so a failure is reproducible. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Random strings stitched from fragments that sit on every rule's edges:
 * token prefixes in both cases, JSON escapes before them, key words next to
 * separators, hex runs, base64 noise. Case-flipped variants exercise the
 * case-insensitive gates against the case-sensitive rules.
 */
function fuzzCorpus(count: number, seed: number): string[] {
  const r = rng(seed);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const fragments = [
    "sk-ant-", "sk-ant-api03-", "SK-ANT-", "sk-", "sk-proj-", "Sk-", "ghp_", "GHO_", "github_pat_", "npm_",
    "NPM_", "gnk-", "123456789:AA", "12345678:aa", "eyJ", "EYJ", ".", "Bearer ", "bearer\t", "?token=",
    "&api_key=", "?KEY=", "API_KEY=", "apiKey\":\"", "password: ", "secret=", "Token :", "key_id=",
    "tokenHash=", "0x", "\\n", "\\t", "\\r", "\n", " ", "\"", "'", "=", ":", "-", "_", "/", "+", "(", "[",
    "0123456789abcdef", "0123456789ABCDEF", fill(12), fill(20), fill(36), fill(40), fill(64),
    fill(33, "AbC9_-"), "deadbeef".repeat(8), "CAISiioKmwIIEhgCKkAe+F1RC/Dh",
  ];
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    let s = "";
    const n = 1 + Math.floor(r() * 10);
    for (let j = 0; j < n; j++) {
      let f = pick(fragments);
      if (r() < 0.15) f = f.toUpperCase();
      s += f;
    }
    out.push(s);
  }
  return out;
}

describe("redaction gates — identical output to the pre-gate implementation", () => {
  const corpus = [
    ...Object.values(FAKE),
    `A_TOKEN=${FAKE.envValue}`,
    `Bearer ${FAKE.envValue}`,
    `?token=${FAKE.envValue}`,
    `ANTHROPIC_API_KEY=${FAKE.anthropicApi}`,
    `{"command":"echo hi\\n${FAKE.claudeOauth}\\n"}`,
    ...fuzzCorpus(20_000, 0xa11ce),
  ];

  it("each gate matches every string its rule matches (gate is a necessary condition)", () => {
    // If a gate ever rejects a string the rule would have matched, that
    // secret would silently stop being redacted — the one failure mode the
    // gates must never introduce.
    const hits = new Map<string, number>();
    for (const s of corpus) {
      for (const rule of SECRET_RULES) {
        const re = new RegExp(rule.re.source, rule.re.flags.replace("g", ""));
        if (!re.test(s)) continue;
        hits.set(rule.name, (hits.get(rule.name) ?? 0) + 1);
        expect({ rule: rule.name, s, gate: rule.gate.test(s) }).toEqual({ rule: rule.name, s, gate: true });
      }
    }
    // The corpus must actually exercise every rule, or this test proves nothing.
    for (const rule of SECRET_RULES) expect(hits.get(rule.name) ?? 0, rule.name).toBeGreaterThan(0);
  });

  it("gates are stateless (no g/y flag) and lookbehind-free (JIT-able)", () => {
    for (const rule of SECRET_RULES) {
      expect(rule.gate.global || rule.gate.sticky).toBe(false);
      expect(rule.gate.source).not.toContain("(?<");
    }
  });

  it("redactSecretsInText output is byte-identical to the legacy implementation", () => {
    for (const s of corpus) {
      expect(redactSecretsInText(s)).toBe(legacyRedactSecretsInText(s));
      // The logger path skips hex64 — keep that identical too.
      expect(redactSecretsInText(s, { skip: ["hex64"] })).toBe(legacyRedactSecretsInText(s, { skip: ["hex64"] }));
    }
  });

  it("mayContainSecret stays a superset of the legacy pre-screen", () => {
    // The recorder returns raw bytes untouched when this is false, so it may
    // only ever say "maybe" MORE often than before, never less.
    for (const s of corpus) {
      if (legacyMayContainSecret(s)) expect(mayContainSecret(s)).toBe(true);
    }
  });
});

describe("redaction gates — performance on the prod pathological input", () => {
  // Prod runs on Bun (JavaScriptCore); vitest runs on Node (V8), whose
  // irregexp DOES compile lookbehinds — the legacy pre-screen is only slow
  // under JSC. So the meaningful check runs the same input under `bun`, when
  // a bun binary is available, comparing legacy vs gated in one process.
  const bunBin = (() => {
    const r = spawnSync("bun", ["--version"], { encoding: "utf-8" });
    return r.status === 0 ? "bun" : null;
  })();
  it.skipIf(!bunBin)("under Bun/JSC the gated redactor is >10x faster than the legacy pre-screen", () => {
    const modulePath = fileURLToPath(new URL("./secret-redaction.ts", import.meta.url));
    const script = `
      const { SECRET_RULES, redactSecretsInText } = await import(${JSON.stringify(modulePath)});
      const ANY = new RegExp(SECRET_RULES.map((r) => "(?:" + r.re.source + ")").join("|"), "i");
      const b64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
      let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
      const sigs = Array.from({ length: 50 }, () => Array.from({ length: 7000 }, () => b64[Math.floor(rnd() * 64)]).join(""));
      let t = performance.now(); for (const s of sigs) ANY.test(s); const legacy = performance.now() - t;
      t = performance.now(); for (const s of sigs) redactSecretsInText(s); const gated = performance.now() - t;
      console.log(JSON.stringify({ legacy, gated }));
    `;
    const r = spawnSync(bunBin!, ["-e", script], { encoding: "utf-8", timeout: 60_000 });
    expect(r.status, r.stderr).toBe(0);
    const { legacy, gated } = JSON.parse(r.stdout.trim().split("\n").pop()!);
    // Measured on the prod box: legacy ≈ 100 ms per 7 KB signature, gated
    // ≈ 0.05 ms. A 10x floor leaves ample headroom for noisy CI runners.
    expect(gated * 10).toBeLessThan(legacy);
  });

  it("redacts 1.4 MB of thinking-signature-like base64 well under a second", () => {
    // Thinking blocks carry a base64 `signature` (several KB each). With the
    // lookbehind pre-screen, one 7 KB signature took ~100 ms on prod — 200 of
    // them (one large session history) ≈ 20 s of blocked event loop. With
    // gates the same input takes a few ms. The bound is deliberately loose
    // (CI noise) but still ~20x below the legacy cost.
    const r = rng(7);
    const b64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const sig = () => Array.from({ length: 7_000 }, () => b64[Math.floor(r() * 64)]).join("");
    const history = Array.from({ length: 200 }, (_, i) => ({
      type: "assistant",
      message: { content: [{ type: "thinking", thinking: `step ${i}`, signature: sig() }] },
    }));
    const started = performance.now();
    const out = redactStructured(history);
    const elapsed = performance.now() - started;
    expect(out).toEqual(history); // nothing secret-shaped — passthrough
    expect(elapsed).toBeLessThan(1_000);
  });
});
