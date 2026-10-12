import { describe, it, expect } from "vitest";
import {
  REDACTED_PLACEHOLDER,
  SECRET_RULES,
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
