#!/usr/bin/env node
// Fake official sign-in CLI for the phase 2 login tests (claude + codex).
//
// Reproduces the facts in PLAN-aura-llm-auth-phase2.md "Verified CLI behaviour
// (2026-11-14)" — including the DESTRUCTIVE start of both real CLIs (Claude
// rewrites an expired credential file with empty tokens; Codex deletes
// auth.json before anything else) — so tests prove the live paths are out of
// its reach. Every credential it writes is synthetic and carries SYNTH-CANARY.
//
// Argv: [--scenario=<name>] [--grandchild] then the real CLI argv:
//   claude: `auth login`          codex: `login --device-auth`
// Scenarios — claude: success | reject | garbage | ignore_term | env | silent
//             codex:  success | no_network | wait | garbage | ignore_term | env | silent
// The scenario is an argv flag (not env) because the runner passes an env
// allowlist; tests wrap this file in a per-scenario shell script.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const scenario = flag("scenario") ?? "success";
const rest = args.filter((a) => !a.startsWith("--scenario=") && a !== "--grandchild");
const provider = rest[0] === "auth" && rest[1] === "login" ? "claude"
  : rest[0] === "login" && rest[1] === "--device-auth" ? "codex"
  : null;
if (!provider) {
  process.stderr.write(`fake-login-cli: unexpected argv ${JSON.stringify(rest)}\n`);
  process.exit(2);
}
if (args.includes("--grandchild")) {
  // A long-lived descendant in the same process group: the runner must reap it too.
  spawn("sleep", ["300"], { stdio: "ignore" });
}
if (scenario === "ignore_term") process.on("SIGTERM", () => {});
if (scenario === "silent") {
  // Prints nothing and waits: the attempt's 10-second readiness budget must end it.
  setInterval(() => {}, 1 << 30);
} else if (scenario === "env") {
  // Prints the environment it received (names + the config-dir values), then waits.
  const keys = Object.keys(process.env).sort();
  process.stdout.write(`FAKE-ENV ${JSON.stringify({ keys, HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME, TERM: process.env.TERM })}\n`);
  setInterval(() => {}, 1 << 30);
} else {
  run();
}

function run() {

const home = process.env.HOME ?? "";
const synth = (label) => `SYNTH-CANARY-${label}-${randomBytes(6).toString("hex")}`;
const b64url = (n) => randomBytes(n).toString("base64url");

function writeJsonReplacing(path, value) {
  // New inode like the real CLIs (write tmp + rename).
  const tmp = `${path}.fake-tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

if (provider === "claude") {
  const dir = process.env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  const credPath = join(dir, ".credentials.json");
  const configPath = process.env.CLAUDE_CONFIG_DIR ? join(dir, ".claude.json") : join(home, ".claude.json");
  // Destructive start: an expired token is "refreshed", the provider refuses,
  // and the CLI rewrites the file with empty tokens — whatever happens next.
  if (existsSync(credPath)) {
    try {
      const parsed = JSON.parse(readFileSync(credPath, "utf-8"));
      const oauth = parsed?.claudeAiOauth;
      if (oauth && typeof oauth.expiresAt === "number" && oauth.expiresAt < Date.now()) {
        writeJsonReplacing(credPath, { ...parsed, claudeAiOauth: { ...oauth, accessToken: "", refreshToken: "", expiresAt: 0 } });
      }
    } catch { /* unparsable: leave it */ }
  }
  const state = b64url(32);
  const challenge = b64url(32);
  if (scenario === "garbage") {
    process.stdout.write("Something new happened in this CLI version\n");
  } else {
    process.stdout.write(
      "Opening browser to sign in…\n" +
      "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e" +
      "&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback" +
      "&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference+user%3Asessions%3Aclaude_code+user%3Amcp_servers+user%3Afile_upload+user%3Aplugins" +
      `&code_challenge=${challenge}&code_challenge_method=S256&state=${state}\n` +
      "Paste code here if prompted > ",
    );
  }
  // Reads one line at a time; EOF does NOT exit (the real CLI keeps waiting).
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const code = line.trim();
    if (!code.includes("#")) {
      process.stdout.write("Invalid code. Please make sure the full code was copied.\n");
      return;
    }
    if (scenario !== "success" || code.split("#")[1] !== state) {
      process.stderr.write("Login failed: Request failed with status code 400\n");
      process.exit(1);
    }
    mkdirSync(dir, { recursive: true });
    writeJsonReplacing(credPath, {
      claudeAiOauth: {
        accessToken: synth("claude-access"),
        refreshToken: synth("claude-refresh"),
        expiresAt: Date.now() + 8 * 3_600_000,
        scopes: ["user:inference", "user:profile"],
        subscriptionType: "max",
      },
    });
    let config = {};
    try { config = JSON.parse(readFileSync(configPath, "utf-8")); } catch { /* fresh */ }
    writeJsonReplacing(configPath, {
      ...config,
      oauthAccount: { emailAddress: "synthetic-owner@example.test", organizationUuid: "00000000-0000-4000-8000-000000000001" },
    });
    process.stdout.write("Login successful.\n");
    process.exit(0);
  });
  rl.on("close", () => { setInterval(() => {}, 1 << 30); });
} else {
  const dir = process.env.CODEX_HOME || join(home, ".codex");
  const authPath = join(dir, "auth.json");
  // Destructive start: auth.json is gone in the first second, whatever the outcome.
  try { unlinkSync(authPath); } catch { /* absent */ }
  if (scenario === "no_network") {
    process.stderr.write(
      "Error logging in with device code: error sending request for url (https://auth.openai.com/api/accounts/deviceauth/usercode)\n",
    );
    process.exit(1);
  }
  if (scenario === "garbage") {
    process.stdout.write("Unexpected banner from a future Codex\n");
  } else {
    const alnum = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789";
    const pick = (n) => Array.from(randomBytes(n), (b) => alnum[b % alnum.length]).join("");
    process.stdout.write(
      "\nWelcome to Codex [v\x1b[90m0.162.1\x1b[0m]\n\x1b[90mOpenAI's command-line coding agent\x1b[0m\n\n" +
      "Follow these steps to sign in with ChatGPT using device code authorization:\n\n" +
      "1. Open this link in your browser and sign in to your account\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n\n" +
      `2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\n   \x1b[94m${pick(4)}-${pick(5)}\x1b[0m\n\n` +
      "\x1b[90mContinue only if you started this login in Codex. If a website or another person gave you this code, cancel.\x1b[0m\n\n",
    );
  }
  if (scenario === "success") {
    const delay = Number(flag("success-after-ms") ?? 200);
    setTimeout(() => {
      mkdirSync(dir, { recursive: true });
      const jwt = (claims) => `${b64url(8)}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${b64url(8)}`;
      writeJsonReplacing(authPath, {
        auth_mode: "chatgpt",
        OPENAI_API_KEY: null,
        tokens: {
          id_token: jwt({ email: "synthetic-owner@example.test", "https://api.openai.com/auth": { chatgpt_plan_type: "pro" } }),
          access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600, marker: synth("codex-access") }),
          refresh_token: synth("codex-refresh"),
          account_id: "synthetic-account",
        },
        last_refresh: new Date().toISOString(),
      });
      process.stdout.write("Successfully logged in\n");
      process.exit(0);
    }, delay);
  } else {
    setInterval(() => {}, 1 << 30);
  }
}
}
