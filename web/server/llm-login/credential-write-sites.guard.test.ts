/**
 * Static guard (phase 2 plan task 6; spec 🚫 "never overwrite working or
 * current credentials with a failed attempt", "no independent copies"):
 * `llm-login/credential-promotion.ts` is the ONLY module that may write the
 * live credential files (`~/.claude/.credentials.json`, `~/.claude.json`,
 * `~/.codex/auth.json`).
 *
 * Heuristic, source-only (nothing is executed): a non-test server/bin module
 * that names a credential file AND calls a write primitive is a credential
 * writer. Writers outside the promotion module are an explicit, reasoned
 * allowlist — a new one fails this test until it is reviewed and listed.
 * The other sign-in modules (attempt registry, runner, parser, wiring) must
 * not call any credential-shaped write at all: they own only the attempt
 * dir / sentinel and must never name a credential file next to a write.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const WEB = resolve(__dirname, "..", "..");

const CREDENTIAL_NAMES = /\.credentials\.json|\.claude\.json|["'`]auth\.json["'`]/;
const WRITE_PRIMITIVES = /\b(writeFileSync|writeFile|renameSync|rename|copyFileSync|copyFile|cpSync|symlinkSync|linkSync|appendFileSync|writeAtomicJson|writeAtomicText|utimesSync|truncateSync|unlinkSync|rmSync)\s*\(|Bun\.write\s*\(/;

/** Known writers that do NOT touch the live LLM credentials — each with its reason. */
const ALLOWED_OTHER_WRITERS: Record<string, string> = {
  // Seeds a PER-SESSION CODEX_HOME (symlink/copy of the primary auth.json into the session's own dir); never writes the primary.
  "server/cli-launcher.ts": "per-session Codex home seeding",
  // Writes container build files / env lists; the credential names appear in a shell snippet run inside the container.
  "server/container-manager.ts": "container build context",
  // Aura's own ~/.companion/auth.json (the Aura access token), not an LLM credential.
  "server/auth-manager.ts": "Aura access token file",
  "bin/generate-token.ts": "Aura access token file (deletes it on --force)",
};

const PROMOTION_MODULE = "server/llm-login/credential-promotion.ts";

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "fixtures" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

function code(path: string): string {
  return readFileSync(path, "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

describe("credential write sites", () => {
  const files = [...sources(join(WEB, "server")), ...sources(join(WEB, "bin"))].map((p) => ({ rel: relative(WEB, p), src: code(p) }));

  it("only the promotion module (plus the reasoned allowlist) both names a credential file and writes", () => {
    const writers = files.filter((f) => CREDENTIAL_NAMES.test(f.src) && WRITE_PRIMITIVES.test(f.src)).map((f) => f.rel).sort();
    expect(writers).toEqual([PROMOTION_MODULE, ...Object.keys(ALLOWED_OTHER_WRITERS)].sort());
  });

  it("the promotion module really is a writer (the guard is not vacuous)", () => {
    const promotion = files.find((f) => f.rel === PROMOTION_MODULE)!;
    expect(promotion.src).toMatch(/renameSync\(staged\.credentials, live\.credentials\)/);
    expect(promotion.src).toMatch(CREDENTIAL_NAMES);
  });

  it("no other sign-in module names a credential file", () => {
    const offenders = files
      .filter((f) => f.rel.startsWith("server/llm-login/") && f.rel !== PROMOTION_MODULE)
      .filter((f) => CREDENTIAL_NAMES.test(f.src))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });
});
